// The chat panel: talk to Claude about the open map. A message goes to
// POST /api/v1/maps/:id/chat and the reply streams back as JSON lines. Map
// changes arrive over the live socket like any other edit, so they draw and
// highlight on their own. The conversation is kept per map in this browser.
import type { Bounds } from '@delve/core';

export interface ChatHost {
  mapId: string;
  /** Ids selected in the editor (empty when not editing). */
  selection(): string[];
  /** The part of the map on screen, in squares. */
  view(): Bounds | null;
  /** Called after the panel opens or closes, so the map can refit. */
  layout(): void;
  hasObjects(): boolean;
}

type ToolPart = { kind: 'tool'; id: string; name: string; input: Record<string, unknown>; state: 'running' | 'ok' | 'failed'; result?: string };
type Part = { kind: 'text'; text: string } | ToolPart;
interface Msg {
  role: 'user' | 'claude' | 'error';
  text?: string;
  parts?: Part[];
}
interface Saved {
  session?: string;
  messages: Msg[];
}
type ChatEv =
  | { type: 'start'; session: string; model?: string }
  | { type: 'text'; text: string }
  | { type: 'tool'; id: string; name: string; input: unknown }
  | { type: 'tool_done'; id: string; ok: boolean; text: string }
  | { type: 'usage'; fiveHour?: number; sevenDay?: number; status?: string; resetsAt?: number }
  | { type: 'done'; session: string; ok: boolean; turns: number; ms: number; error?: string }
  | { type: 'error'; error: string; code?: string };

const TOOL_LABEL: Record<string, string> = {
  list_maps: 'Listing maps',
  create_map: 'Creating a map',
  get_map: 'Reading the map',
  describe_map: 'Reading the map',
  add_room: 'Adding a room',
  connect: 'Connecting rooms',
  add_cutout: 'Adding a cutout',
  add_door: 'Adding a door',
  add_stairs: 'Adding stairs',
  add_label: 'Adding a label',
  move: 'Moving',
  resize: 'Reshaping',
  update: 'Updating',
  delete: 'Deleting',
  set_map: 'Changing map settings',
  undo: 'Undoing',
  redo: 'Redoing',
  render: 'Looking at the map',
  export: 'Making a download link',
  focus: 'Showing you',
  apply_ops: 'Applying changes',
};

const SUGGESTIONS_FILLED = [
  'Add a 6×6 guard room east of room 1 and connect it with a locked door',
  'Put four pillars in the biggest room',
  'Write short GM notes for every room: what is there, monsters, treasure',
  'What would make this dungeon more interesting? Then do the best idea.',
  'Give me the Roll20 PNG',
];
const SUGGESTIONS_EMPTY = [
  'Build a small goblin cave: 6 rooms, a secret exit and a boss lair with pillars',
  'Make a two-level wizard tower entrance: round rooms, stairs up in the last one',
  'Draw a 3-room crypt with a long entry corridor and a portcullis',
];

const MODELS: [string, string][] = [
  ['sonnet', 'Sonnet · fast'],
  ['opus', 'Opus · best'],
  ['haiku', 'Haiku · quickest'],
];

// ---------- tiny, safe markdown ----------

const esc = (s: string): string => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

function inline(s: string): string {
  return s
    .split(/(`[^`\n]+`)/)
    .map((part) => {
      if (/^`[^`\n]+`$/.test(part)) return `<code>${esc(part.slice(1, -1))}</code>`;
      return esc(part)
        .replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>')
        .replace(/\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>')
        .replace(/(^|[\s(])(https?:\/\/[^\s<)]+)/g, '$1<a href="$2" target="_blank" rel="noopener">$2</a>');
    })
    .join('');
}

/** Paragraphs, bullet and numbered lists, headings as bold lines. Everything is escaped first. */
export function markdown(src: string): string {
  const out: string[] = [];
  let list: { tag: 'ul' | 'ol'; items: string[] } | null = null;
  let para: string[] = [];
  const flushPara = () => {
    if (para.length) out.push(`<p>${para.map(inline).join('<br>')}</p>`);
    para = [];
  };
  const flushList = () => {
    if (list) out.push(`<${list.tag}>${list.items.map((i) => `<li>${inline(i)}</li>`).join('')}</${list.tag}>`);
    list = null;
  };
  for (const raw of src.replace(/\r/g, '').split('\n')) {
    const line = raw.trimEnd();
    const bullet = /^\s*[-*•]\s+(.*)$/.exec(line);
    const numbered = /^\s*\d+[.)]\s+(.*)$/.exec(line);
    const heading = /^#{1,6}\s+(.*)$/.exec(line);
    if (!line.trim()) {
      flushPara();
      flushList();
    } else if (bullet || numbered) {
      flushPara();
      const tag = bullet ? 'ul' : 'ol';
      if (list && list.tag !== tag) flushList();
      list ??= { tag, items: [] };
      list.items.push((bullet ?? numbered)![1]!);
    } else if (heading) {
      flushPara();
      flushList();
      out.push(`<p><strong>${inline(heading[1]!)}</strong></p>`);
    } else {
      flushList();
      para.push(line);
    }
  }
  flushPara();
  flushList();
  return out.join('');
}

// ---------- panel ----------

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

const store = {
  get<T>(key: string): T | null {
    try {
      const v = localStorage.getItem(key);
      return v ? (JSON.parse(v) as T) : null;
    } catch {
      return null;
    }
  },
  set(key: string, value: unknown): void {
    try {
      localStorage.setItem(key, JSON.stringify(value));
    } catch {
      /* private window or full storage: the chat still works, it just isn't kept */
    }
  },
};

function toolDetail(p: ToolPart): string {
  const a = p.input;
  if (typeof a.name === 'string' && a.name) return ` "${a.name}"`;
  if (typeof a.text === 'string' && a.text) return ` "${a.text}"`;
  if (Array.isArray(a.ids)) return ` ${a.ids.slice(0, 4).join(', ')}${a.ids.length > 4 ? '…' : ''}`;
  if (typeof a.id === 'string') return ` ${a.id}`;
  if (typeof a.from === 'string' && typeof a.to === 'string') return ` ${a.from} → ${a.to}`;
  if (Array.isArray(a.ops)) return ` (${a.ops.length})`;
  return '';
}

export function initChat(host: ChatHost, opts: { model: string }): void {
  const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
  const panel = $('chat');
  const toggle = $<HTMLButtonElement>('chat-toggle');
  const log = $('chat-log');
  const status = $('chat-status');
  const usage = $('chat-usage');
  const form = $<HTMLFormElement>('chat-form');
  const input = $<HTMLTextAreaElement>('chat-input');
  const sendBtn = $<HTMLButtonElement>('chat-send');
  const modelSel = $<HTMLSelectElement>('chat-model');
  if (!panel || !toggle) return;

  const key = `delve-chat:${host.mapId}`;
  const saved = store.get<Saved>(key) ?? { messages: [] };
  let session = saved.session;
  const messages: Msg[] = saved.messages ?? [];
  let busy: AbortController | null = null;
  let checked = false;

  modelSel.replaceChildren(...MODELS.map(([v, label]) => Object.assign(el('option', undefined, label), { value: v })));
  modelSel.value = store.get<string>('delve-chat-model') ?? opts.model;
  if (!modelSel.value) modelSel.value = 'sonnet';
  modelSel.addEventListener('change', () => store.set('delve-chat-model', modelSel.value));

  const save = () => store.set(key, { session, messages: messages.slice(-100) });

  function setOpen(on: boolean): void {
    panel.hidden = !on;
    toggle.setAttribute('aria-pressed', String(on));
    document.body.classList.toggle('chatting', on);
    store.set('delve-chat-open', on);
    host.layout();
    if (on) {
      draw();
      input.focus();
      if (!checked) void checkBridge();
    }
  }

  async function checkBridge(): Promise<void> {
    checked = true;
    try {
      const res = await fetch('/api/v1/chat');
      const body = (await res.json()) as { enabled?: boolean; ok?: boolean; error?: string; claude?: string };
      if (!body.enabled) setStatus('The chat isn\'t set up on this server.', 'bad');
      else if (!body.ok) setStatus(`Claude isn't reachable: ${body.error ?? 'unknown problem'}`, 'bad');
      else if (!busy) setStatus('');
    } catch {
      setStatus('Couldn\'t reach Delve to check the chat.', 'bad');
    }
  }

  function setStatus(text: string, kind: 'info' | 'bad' = 'info'): void {
    status.textContent = text;
    status.dataset.kind = kind;
    status.hidden = !text;
  }

  // ---------- drawing ----------

  function claudeBody(m: Msg): HTMLElement {
    const box = el('div', 'msg claude');
    let chips: HTMLElement | null = null;
    for (const p of m.parts ?? []) {
      if (p.kind === 'tool') {
        if (!chips) {
          chips = el('div', 'tools');
          box.append(chips);
        }
        const chip = el('span', 'tool', `${TOOL_LABEL[p.name] ?? p.name}${toolDetail(p)}`);
        chip.dataset.state = p.state;
        if (p.result) chip.title = p.result;
        chips.append(chip);
      } else {
        chips = null;
        const div = el('div', 'md');
        div.innerHTML = markdown(p.text); // escaped by markdown()
        box.append(div);
      }
    }
    if (!(m.parts ?? []).length) box.append(el('span', 'typing', 'Thinking'));
    return box;
  }

  function draw(): void {
    if (panel.hidden) return;
    const atBottom = log.scrollHeight - log.scrollTop - log.clientHeight < 40;
    const kids: HTMLElement[] = [];
    if (!messages.length) {
      const empty = el('div', 'chat-empty');
      empty.append(el('p', undefined, 'Ask Claude to build or change this map. It sees the whole map, what you have selected and where you are looking, and you watch every change happen. Everything can be undone.'));
      for (const s of host.hasObjects() ? SUGGESTIONS_FILLED : SUGGESTIONS_EMPTY) {
        const b = el('button', undefined, s);
        b.type = 'button';
        b.addEventListener('click', () => {
          input.value = s;
          input.focus();
        });
        empty.append(b);
      }
      kids.push(empty);
    }
    messages.forEach((m, i) => {
      if (m.role === 'user') kids.push(el('div', 'msg user', m.text ?? ''));
      else if (m.role === 'error') kids.push(el('div', 'msg error', m.text ?? ''));
      else {
        const body = claudeBody(m);
        if (busy && i === messages.length - 1) body.classList.add('live');
        kids.push(body);
      }
    });
    log.replaceChildren(...kids);
    if (atBottom || busy) log.scrollTop = log.scrollHeight;
    sendBtn.textContent = busy ? 'Stop' : 'Send';
    sendBtn.classList.toggle('primary', !busy);
  }

  let drawQueued = false;
  const drawSoon = () => {
    if (drawQueued) return;
    drawQueued = true;
    requestAnimationFrame(() => {
      drawQueued = false;
      draw();
    });
  };

  // ---------- sending ----------

  function showUsage(ev: Extract<ChatEv, { type: 'usage' }>): void {
    const parts: string[] = [];
    if (ev.fiveHour !== undefined) parts.push(`${Math.round(ev.fiveHour * 100)}% of 5 h`);
    if (ev.sevenDay !== undefined) parts.push(`${Math.round(ev.sevenDay * 100)}% of week`);
    usage.textContent = parts.length ? `Subscription used: ${parts.join(' · ')}` : '';
    usage.dataset.kind = (ev.fiveHour ?? 0) > 0.85 || ev.status === 'rejected' ? 'bad' : '';
  }

  async function run(text: string, retried = false): Promise<void> {
    const reply: Msg = { role: 'claude', parts: [] };
    messages.push(reply);
    const parts = reply.parts!;
    const abort = new AbortController();
    busy = abort;
    setStatus('Claude is thinking…');
    drawSoon();
    let restart = false;
    try {
      const res = await fetch(`/api/v1/maps/${encodeURIComponent(host.mapId)}/chat`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ message: text, session, selection: host.selection(), view: host.view(), model: modelSel.value }),
        signal: abort.signal,
      });
      if (!res.ok || !res.body) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(body.error ?? `the server answered ${res.status}`);
      }
      const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
      let buf = '';
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += value;
        let nl: number;
        while ((nl = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, nl).trim();
          buf = buf.slice(nl + 1);
          if (!line) continue;
          let ev: ChatEv;
          try {
            ev = JSON.parse(line) as ChatEv;
          } catch {
            continue;
          }
          switch (ev.type) {
            case 'start':
              session = ev.session;
              break;
            case 'text': {
              const last = parts.at(-1);
              if (last?.kind === 'text') last.text += ev.text;
              else parts.push({ kind: 'text', text: ev.text.replace(/^\n+/, '') });
              setStatus('Claude is writing…');
              break;
            }
            case 'tool':
              parts.push({ kind: 'tool', id: ev.id, name: ev.name, input: (ev.input ?? {}) as Record<string, unknown>, state: 'running' });
              setStatus(`${TOOL_LABEL[ev.name] ?? ev.name}…`);
              break;
            case 'tool_done': {
              const p = parts.find((x): x is ToolPart => x.kind === 'tool' && x.id === ev.id);
              if (p) {
                p.state = ev.ok ? 'ok' : 'failed';
                p.result = ev.text;
              }
              setStatus('Claude is thinking…');
              break;
            }
            case 'usage':
              showUsage(ev);
              break;
            case 'done':
              session = ev.session || session;
              if (!ev.ok) {
                if (!retried && /no conversation found/i.test(ev.error ?? '')) restart = true;
                else messages.push({ role: 'error', text: ev.error ?? 'Claude stopped with an error.' });
              }
              break;
            case 'error':
              if (ev.code === 'no_session' && !retried) restart = true;
              else messages.push({ role: 'error', text: ev.error });
              break;
          }
          drawSoon();
        }
      }
    } catch (e) {
      if (abort.signal.aborted) messages.push({ role: 'error', text: 'Stopped. Changes Claude already made are kept (undo removes them).' });
      else messages.push({ role: 'error', text: `The chat failed: ${(e as Error).message}` });
    } finally {
      busy = null;
      if (!parts.length) messages.splice(messages.indexOf(reply), 1); // no empty "Thinking" bubble left behind
      setStatus('');
      save();
      draw();
    }
    if (restart) {
      // The saved conversation is gone on the Claude side: start fresh with the same message.
      session = undefined;
      await run(text, true);
    }
  }

  function submit(): void {
    if (busy) {
      busy.abort();
      return;
    }
    const text = input.value.trim();
    if (!text) return;
    input.value = '';
    messages.push({ role: 'user', text });
    save();
    void run(text);
  }

  form.addEventListener('submit', (e) => {
    e.preventDefault();
    submit();
  });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      if (!busy) submit();
    } else if (e.key === 'Escape') input.blur();
  });
  $('chat-new').addEventListener('click', () => {
    if (busy) busy.abort();
    session = undefined;
    messages.length = 0;
    save();
    draw();
    input.focus();
  });
  $('chat-close').addEventListener('click', () => setOpen(false));
  toggle.addEventListener('click', () => setOpen(panel.hidden !== false));
  setOpen(store.get<boolean>('delve-chat-open') === true);
}
