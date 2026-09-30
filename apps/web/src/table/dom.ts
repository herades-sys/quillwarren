// Small DOM helpers for the table's HTML parts. Text always goes in as text
// nodes or textContent, never as HTML: names, chat and notes come from players.

type Kid = Node | string | number | null | undefined | false;

/** Create an element. Props set properties (class, title, type, value…), `on<event>` adds listeners. */
export function h<K extends keyof HTMLElementTagNameMap>(tag: K, props: Record<string, unknown> = {}, ...kids: Kid[]): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (v === undefined || v === null || v === false) continue;
    if (k === 'innerHTML' || k === 'outerHTML') throw new Error('h(): no HTML strings');
    if (k === 'class') e.className = String(v);
    else if (k === 'dataset') Object.assign(e.dataset, v);
    else if (k.startsWith('on') && typeof v === 'function') e.addEventListener(k.slice(2), v as EventListener);
    else if (k in e) (e as unknown as Record<string, unknown>)[k] = v;
    else e.setAttribute(k, String(v));
  }
  for (const kid of kids) if (kid !== null && kid !== undefined && kid !== false) e.append(typeof kid === 'number' ? String(kid) : kid);
  return e;
}

export function button(label: string, onclick: (e: MouseEvent) => void, props: Record<string, unknown> = {}): HTMLButtonElement {
  return h('button', { type: 'button', class: 'btn', ...props, onclick }, label);
}

export const $ = <T extends HTMLElement = HTMLElement>(id: string): T => {
  const e = document.getElementById(id);
  if (!e) throw new Error(`#${id} is missing from the page`);
  return e as T;
};

let toastTimer: number | undefined;
export function toast(msg: string, kind: 'error' | 'info' = 'error'): void {
  const t = document.getElementById('toast');
  if (!t) return;
  t.textContent = msg;
  t.dataset.kind = kind;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => (t.hidden = true), kind === 'error' ? 6000 : 2500);
}

/** JSON from the API, or an Error with the server's message. */
export async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(path, init);
  const text = await res.text();
  let body: unknown = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = null;
  }
  if (!res.ok) {
    const msg = (body as { error?: string } | null)?.error ?? (text && text.length < 200 ? text : `the server answered ${res.status}`);
    throw new Error(msg);
  }
  return body as T;
}

export const postJson = <T>(path: string, data: unknown): Promise<T> =>
  api<T>(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(data) });

/** Copy text to the clipboard, falling back to a selected field on plain http. */
export async function copyText(text: string, field?: HTMLInputElement): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    if (!field) return false;
    field.focus();
    field.select();
    return document.execCommand('copy');
  }
}

export const store = {
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
      /* private window or full storage: fine, it just isn't remembered */
    }
  },
};
