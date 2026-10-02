// This Delve's own props in the browser: GET /api/v1/props, registered with
// core (registerAssets) so the renderer, propBounds and the pickers know their
// footprints. The editor, the viewer and segment thumbnails load it through
// art.ts; it reloads when something says the library changed (the editor's
// prop menu, or Claude's create_prop / update_prop / delete_prop in the chat,
// both send a "delve:props-changed" event).
import { assetInfo, isCustomAsset, registerAssets, type AssetInfo, type Blocks } from '@delve/core';

export interface CustomPropRow {
  id: string;
  name: string;
  category: string;
  w: number;
  h: number;
  tags: string[];
  blocks: Blocks;
  ink: boolean;
  created: string;
  updated: string;
  by: string;
  url: string;
  preview: string;
}

export const PROPS_CHANGED = 'delve:props-changed';

let loaded: Promise<void> | null = null;
let inflight: Promise<void> | null = null;
let loadedAt = 0;
let rows: CustomPropRow[] = [];
const listeners = new Set<() => void>();

const toInfo = (p: CustomPropRow): AssetInfo => ({
  id: p.id,
  name: p.name,
  category: p.category,
  kind: 'prop',
  w: p.w,
  h: p.h,
  tags: p.tags,
  blocks: p.blocks,
  file: `props/${p.id}.svg`,
  custom: true,
  by: p.by,
  created: p.created,
  updated: p.updated,
});

async function fetchList(): Promise<void> {
  try {
    const res = await fetch('/api/v1/props', { headers: { accept: 'application/json' } });
    if (!res.ok) return; // e.g. public mode without a login: no custom props, maps draw the dashed outline
    rows = ((await res.json()) as { props?: CustomPropRow[] }).props ?? [];
    loadedAt = Date.now();
    registerAssets(rows.map(toInfo));
    for (const f of listeners) f();
  } catch {
    // offline: try again on the next change
  }
}

/** Load the list once (or again with force). Resolves when it's registered. */
export function loadCustomProps(force = false): Promise<void> {
  if (inflight) return inflight;
  if (loaded && !force) return loaded;
  inflight = fetchList().finally(() => (inflight = null));
  loaded = inflight;
  return inflight;
}

/** Load the list again if it is older than maxAgeMs: other GMs (or Claude Code) add props too. */
export function refreshCustomProps(maxAgeMs = 20_000): void {
  if (Date.now() - loadedAt > maxAgeMs) void loadCustomProps(true);
}

/** Runs after each (re)load. Returns the undo. */
export function onCustomProps(cb: () => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

export const customPropRows = (): CustomPropRow[] => rows;
export const customPropRow = (id: string): CustomPropRow | undefined => rows.find((r) => r.id === id);

/** The art URL; custom props carry their version, so a redrawn prop is fetched again. */
export function artUrl(id: string): string {
  const v = isCustomAsset(id) ? assetInfo(id)?.updated : undefined;
  return `/assets/props/${encodeURIComponent(id)}.svg${v ? `?v=${encodeURIComponent(v)}` : ''}`;
}

/** Tell every part of this page that the library changed. */
export function propsChanged(): void {
  window.dispatchEvent(new CustomEvent(PROPS_CHANGED));
}

if (typeof window !== 'undefined') window.addEventListener(PROPS_CHANGED, () => void loadCustomProps(true));
