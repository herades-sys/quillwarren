// The Claude panel: talk to Claude about the open map. A message goes to
// POST /api/v1/maps/:id/chat and the reply streams back as JSON lines. Map
// changes arrive over the live socket like any other edit, so they draw and
// highlight on their own. The conversation is kept per map in this browser.
// Laid out as in the design: avatars and times, Claude's changes as a list,
// "working" with a Stop button while a reply runs.
import type { Bounds } from '@delve/core';
import type { IconName } from '@delve/ui';
import { h, iconEl } from './dom.ts';
import type { Shell } from './shell.ts';

export interface ChatHost {
  mapId: string;
  shell: Shell;
  /** Who is logged in, for the avatar on your messages. */
  account: { name: string } | null;
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
  /** When it was sent (ms); older saved messages have none. */
  at?: number;
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
  add_opening: 'Opening an area',
  add_door: 'Adding a door',
  add_stairs: 'Adding stairs',
  add_label: 'Adding a label',
  add_marker: 'Adding a GM marker',
  add_inscription: 'Writing on the handout',
  list_assets: 'Looking through the props',
  add_prop: 'Placing a prop',
  add_props_along: 'Placing props',
  add_terrain: 'Adding terrain',
  list_images: 'Looking through the pictures',
  add_image: 'Placing a picture',
  fog: 'Changing the fog',
  add_level: 'Adding a storey',
  label_stairs: 'Numbering the stairs',
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
  prop_rules: 'Reading how props are drawn',
  create_prop: 'Drawing a new prop',
  update_prop: 'Redrawing the prop',
  get_prop: 'Looking at the prop',
  delete_prop: 'Deleting a prop',
};
/** Tools that change the custom prop library: when one succeeds, the Prop picker reloads it. */
const PROP_TOOLS = new Set(['create_prop', 'update_prop', 'delete_prop']);
const TOOL_ICON: Record<string, IconName> = {
  add_room: 'room',
  connect: 'corridor',
  add_cutout: 'pillar',
  add_opening: 'eraser',
  add_door: 'door',
  add_stairs: 'stairs',
  label_stairs: 'stairs',
  add_label: 'label',
  add_marker: 'marker',
  add_inscription: 'notes',
  add_prop: 'prop',
  add_props_along: 'brush',
  list_assets: 'prop',
  add_terrain: 'terrain',
  add_image: 'image',
  list_images: 'image',
  fog: 'fog',
  add_level: 'layers',
  move: 'pan',
  resize: 'fit',
  update: 'settings',
  set_map: 'settings',
  delete: 'trash',
  undo: 'undo',
  redo: 'redo',
  render: 'eye',
  focus: 'eye',
  export: 'download',
  apply_ops: 'layers',
  get_map: 'search',
  describe_map: 'search',
  list_maps: 'search',
  create_map: 'plus',
  prop_rules: 'prop',
  create_prop: 'brush',
  update_prop: 'brush',
  get_prop: 'prop',
  delete_prop: 'trash',
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
  if (typeof a.name === 'string' && a.name) return ` “${a.name}”`;
  if (typeof a.text === 'string' && a.text) return ` “${a.text}”`;
  if (Array.isArray(a.ids)) return ` ${a.ids.slice(0, 4).join(', ')}${a.ids.length > 4 ? '…' : ''}`;
  if (typeof a.id === 'string') return ` ${a.id}`;
  if (typeof a.from === 'string' && typeof a.to === 'string') return ` ${a.from} → ${a.to}`;
  if (Array.isArray(a.ops)) return ` (${a.ops.length})`;
  return '';
}

const clock = (ms?: number) => (ms ? new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '');
const initialsOf = (name: string) => {
  const w = name.trim().split(/\s+/).filter(Boolean);
  return (w.length > 1 ? w[0]![0]! + w[1]![0]! : (w[0] ?? 'Y').slice(0, 2)).toUpperCase();
};

export function initChat(host: ChatHost, opts: { model: string }): void {
  const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
  const panel = $('chat');
  const toggle = $<HTMLButtonElement>('chat-toggle');
  const phone = document.getElementById('chat-phone') as HTMLButtonElement | null;
  const log = $('chat-log');
  const status = $('chat-status');
  const usage = $('chat-usage');
  const live = $('chat-live');
  const form = $<HTMLFormElement>('chat-form');
  const input = $<HTMLTextAreaElement>('chat-input');
  const sendBtn = $<HTMLButtonElement>('chat-send');
  const modelSel = $<HTMLSelectElement>('chat-model');
  if (!panel || !toggle) return;
  const hint = usage.innerHTML;
  const me = host.account?.name ?? 'You';

  const key = `delve-chat:${host.mapId}`;
  const saved = store.get<Saved>(key) ?? { messages: [] };
  let session = saved.session;
  const messages: Msg[] = saved.messages ?? [];
  let busy: AbortController | null = null;
  let checked = false;
  let open = false;

  modelSel.replaceChildren(...MODELS.map(([v, label]) => h('option', { value: v }, label)));
  modelSel.value = store.get<string>('delve-chat-model') ?? opts.model;
  if (!modelSel.value) modelSel.value = 'sonnet';
  modelSel.addEventListener('change', () => store.set('delve-chat-model', modelSel.value));

  const save = () => store.set(key, { session, messages: messages.slice(-100) });

  function setOpen(on: boolean, focus = on): void {
    open = on;
    const phoneLayout = host.shell.layout() === 'phone';
    panel.hidden = !on && !phoneLayout;
    if (phoneLayout) host.shell.setSheet(on ? 'claude' : null);
    else if (document.body.classList.contains('sheet-claude')) host.shell.setSheet(null);
    toggle.setAttribute('aria-pressed', String(on));
    phone?.setAttribute('aria-pressed', String(on));
    store.set('delve-chat-open', on);
    host.layout();
    if (on) {
      draw();
      if (focus) input.focus();
      if (!checked) void checkBridge();
    }
  }

  async function checkBridge(): Promise<void> {
    checked = true;
    try {
      const res = await fetch('/api/v1/chat');
      const body = (await res.json()) as { enabled?: boolean; ok?: boolean; error?: string; claude?: string };
      if (!body.enabled) setStatus('The chat isn’t set up on this server.', 'bad');
      else if (!body.ok) setStatus(`Claude isn’t reachable: ${body.error ?? 'unknown problem'}`, 'bad');
      else if (!busy) setStatus('');
    } catch {
      setStatus('Couldn’t reach Delve to check the chat.', 'bad');
    }
  }

  function setStatus(text: string, kind: 'info' | 'bad' = 'info'): void {
    status.textContent = text;
    status.dataset.kind = kind;
    status.hidden = !text || (kind === 'info' && Boolean(busy)); // while working, the reply itself shows it
  }

  // ---------- drawing ----------

  const meta = (name: string, rest: string) => h('span', { class: 'ed-msg-meta' }, h('b', {}, name), rest ? ` · ${rest}` : '');

  function changes(tools: ToolPart[]): HTMLElement {
    return h(
      'div',
      { class: 'ed-changes' },
      ...tools.map((p) => {
        const row = h('div', { class: 'ed-change', 'data-state': p.state, title: p.result ?? '' }, iconEl(p.state === 'failed' ? 'alert' : p.state === 'running' ? (TOOL_ICON[p.name] ?? 'check') : (TOOL_ICON[p.name] ?? 'check'), 15), h('span', { class: 'spacer' }, `${TOOL_LABEL[p.name] ?? p.name}${toolDetail(p)}`));
        return row;
      }),
    );
  }

  function claudeBody(m: Msg, working: boolean): HTMLElement {
    const body = h('div', { class: 'ed-msg-body' }, meta('Claude', working ? 'working' : clock(m.at)));
    let tools: ToolPart[] = [];
    const flushTools = () => {
      if (tools.length) body.append(changes(tools));
      tools = [];
    };
    for (const p of m.parts ?? []) {
      if (p.kind === 'tool') tools.push(p);
      else {
        flushTools();
        const div = h('div', { class: 'ed-msg-text' });
        div.innerHTML = markdown(p.text); // escaped by markdown()
        body.append(div);
      }
    }
    flushTools();
    if (working) {
      const running = (m.parts ?? []).filter((p): p is ToolPart => p.kind === 'tool' && p.state === 'running').at(-1);
      body.append(
        h('span', { class: 'ed-typing' }, h('span', { class: 'ed-dots', 'aria-hidden': 'true' }, h('span'), h('span'), h('span')), running ? `${TOOL_LABEL[running.name] ?? running.name}…` : status.textContent || 'Thinking…'),
        h('button', { type: 'button', class: 'btn btn-secondary btn-sm', style: 'align-self:flex-start', onclick: () => busy?.abort() }, iconEl('stop', 14), 'Stop', h('span', { class: 'key' }, 'Esc')),
      );
    }
    return h('div', { class: 'ed-msg' }, h('span', { class: 'ed-claude-mark', 'aria-hidden': 'true' }, 'C'), body);
  }

  function draw(): void {
    if (!open) return;
    const atBottom = log.scrollHeight - log.scrollTop - log.clientHeight < 40;
    const kids: HTMLElement[] = [];
    if (!messages.length) {
      kids.push(
        h(
          'div',
          { class: 'ed-suggest' },
          h('p', {}, 'Ask Claude to build or change this map. It sees the whole map, what you have selected and where you are looking, and you watch every change happen. Each reply is one undo step.'),
          ...(host.hasObjects() ? SUGGESTIONS_FILLED : SUGGESTIONS_EMPTY).map((s) => h('button', { type: 'button', onclick: () => ((input.value = s), input.focus()) }, s)),
        ),
      );
    }
    messages.forEach((m, i) => {
      if (m.role === 'user') kids.push(h('div', { class: 'ed-msg ed-msg-user' }, h('span', { class: 'avatar avatar-sm' }, initialsOf(me)), h('div', { class: 'ed-msg-body' }, meta(me === 'You' ? 'You' : (me.split(/\s+/)[0] ?? me), clock(m.at)), h('span', { class: 'ed-msg-text' }, m.text ?? ''))));
      else if (m.role === 'error') kids.push(h('div', { class: 'ed-msg ed-msg-error' }, h('span', { class: 'ed-claude-mark', style: 'box-shadow:inset 0 0 0 1.5px var(--color-danger);color:var(--color-danger)' }, iconEl('alert', 13)), h('div', { class: 'ed-msg-body' }, h('span', { class: 'ed-msg-text' }, m.text ?? ''))));
      else kids.push(claudeBody(m, Boolean(busy) && i === messages.length - 1));
    });
    log.replaceChildren(...kids);
    if (atBottom || busy) log.scrollTop = log.scrollHeight;
    sendBtn.replaceChildren(iconEl(busy ? 'stop' : 'send', 15), h('span', {}, busy ? 'Stop' : 'Send'));
    sendBtn.title = busy ? 'Stop · Esc' : 'Send · Enter';
    live.hidden = !busy;
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
    if (parts.length) usage.textContent = `Subscription used: ${parts.join(' · ')}`;
    else usage.innerHTML = hint;
    usage.dataset.kind = (ev.fiveHour ?? 0) > 0.85 || ev.status === 'rejected' ? 'bad' : '';
  }

  async function run(text: string, retried = false): Promise<void> {
    const reply: Msg = { role: 'claude', parts: [], at: Date.now() };
    messages.push(reply);
    const parts = reply.parts!;
    const abort = new AbortController();
    busy = abort;
    setStatus('Thinking…');
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
              setStatus('Writing…');
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
                // a new or redrawn custom prop: the picker and the map pick it up (custom-props.ts)
                if (ev.ok && PROP_TOOLS.has(p.name)) window.dispatchEvent(new CustomEvent('delve:props-changed'));
              }
              setStatus('Thinking…');
              break;
            }
            case 'usage':
              showUsage(ev);
              break;
            case 'done':
              session = ev.session || session;
              if (!ev.ok) {
                if (!retried && /no conversation found/i.test(ev.error ?? '')) restart = true;
                else messages.push({ role: 'error', text: ev.error ?? 'Claude stopped with an error.', at: Date.now() });
              }
              break;
            case 'error':
              if (ev.code === 'no_session' && !retried) restart = true;
              else messages.push({ role: 'error', text: ev.error, at: Date.now() });
              break;
          }
          drawSoon();
        }
      }
    } catch (e) {
      if (abort.signal.aborted) messages.push({ role: 'error', text: 'Stopped. Changes Claude already made are kept (undo removes them).', at: Date.now() });
      else messages.push({ role: 'error', text: `The chat failed: ${(e as Error).message}`, at: Date.now() });
    } finally {
      busy = null;
      if (!parts.length) messages.splice(messages.indexOf(reply), 1); // no empty reply left behind
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
    messages.push({ role: 'user', text, at: Date.now() });
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
    } else if (e.key === 'Escape') {
      if (busy) busy.abort();
      else input.blur();
    }
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
  toggle.addEventListener('click', () => setOpen(!open));
  phone?.addEventListener('click', () => setOpen(!open));
  window.addEventListener('keydown', (e) => {
    const t = e.target as HTMLElement;
    if ((e.ctrlKey || e.metaKey) && e.key === '.') {
      e.preventDefault();
      setOpen(!open);
    } else if (e.key === '/' && !t.closest('input, select, textarea') && !e.ctrlKey && !e.metaKey && !e.altKey) {
      e.preventDefault();
      setOpen(true);
    } else if (e.key === 'Escape' && busy && !t.closest('input, select, textarea')) busy.abort();
  });
  // "New prop…" and "Ask Claude to change it" (prop-maker.ts): open the panel with a message to finish
  window.addEventListener('delve:chat-prefill', (e) => {
    const { text, pick } = (e as CustomEvent<{ text: string; pick?: string }>).detail;
    setOpen(true);
    input.value = text;
    input.focus();
    const at = pick ? text.indexOf(pick) : -1;
    if (at >= 0) input.setSelectionRange(at, at + pick!.length);
    else input.setSelectionRange(text.length, text.length);
  });
  // phones show Claude as a sheet that only opens on request
  host.shell.onLayout((l) => setOpen(l === 'phone' ? false : open, false));
  setOpen(host.shell.layout() !== 'phone' && store.get<boolean>('delve-chat-open') === true, false);
}
