// The live viewer page (/maps/:id) and its script (/assets/viewer.js, built
// from apps/web by esbuild). The first picture is rendered on the server, so
// it shows before the script loads; the script then takes over and follows
// changes over the WebSocket.
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { FastifyInstance } from 'fastify';
import { floorText, levelSiblings, PRESETS, revealedBounds, sceneToSvg, storeyTitle, type DelveMap, type Level } from '@delve/core';
import type { AppInfo } from './app.ts';
import type { ChatConfig } from './chat/route.ts';
import { canLogIn, isLoggedIn, type EditorAuth } from './login.ts';
import { asView, sceneFor } from './render.ts';
import { NotFoundError, type MapStore } from './store.ts';

const esc = (s: string): string =>
  s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

/** release/web/<name> next to the bundle, or apps/web/dist/<name> in development. */
function findScript(name: string): string | null {
  for (const rel of [`./web/${name}`, `../../web/dist/${name}`]) {
    const p = fileURLToPath(new URL(rel, import.meta.url));
    if (existsSync(p)) return p;
  }
  return null;
}

interface PageOpts {
  view: 'gm' | 'players';
  style: string | undefined;
  loggedIn: boolean;
  passwordSet: boolean;
  /** The chat panel's default model, when the chat bridge is set up (logged-in editors only). */
  chatModel: string | null;
  /** This map's storeys, top first (empty unless it is one of several). */
  levels: { id: string; name: string; level?: Level }[];
}

function page(info: AppInfo, id: string, rev: number, map: DelveMap, o: PageOpts): string {
  const { view, style } = o;
  const scene = sceneFor(map, { view, style, fog: '1' });
  // the page shows the floor number as a badge over the map instead
  scene.layers = scene.layers.filter((l) => l.name !== 'floor-number');
  const floorBadge = `<div id="floor-badge" aria-label="Floor number"${map.level ? '' : ' hidden'}>${map.level ? floorText(map.level.order) : ''}</div>`;
  const bg = scene.layers[0]?.kind === 'rect' ? scene.layers[0].color : '#EFEAE2';
  const chat = o.loggedIn && o.chatModel ? { enabled: true, model: o.chatModel } : undefined;
  const storeyOptions = o.levels.map((l) => `<option value="${esc(l.id)}"${l.id === id ? ' selected' : ''}>${esc(storeyTitle(l))}</option>`).join('');
  const initial = JSON.stringify({ id, rev, map, levels: o.levels, edit: { loggedIn: o.loggedIn, passwordSet: o.passwordSet }, ...(chat ? { chat } : {}) }).replace(/</g, '\\u003c');
  const editControl = o.loggedIn
    ? `<button class="btn" id="edit-toggle" aria-pressed="false" title="Edit this map">Edit</button>`
    : `<a class="btn" href="/login?next=${encodeURIComponent(`/maps/${id}?edit=1`)}">Log in to edit</a>`;
  const chatControl = chat ? `<button class="btn" id="chat-toggle" aria-pressed="false" title="Chat with Claude about this map (uses your Claude subscription)">Claude</button>` : '';
  const chatPanel = chat
    ? `<aside id="chat" hidden aria-label="Chat with Claude">
    <div class="chat-head"><strong>Claude</strong><select id="chat-model" aria-label="Model"></select><span class="spacer"></span><button class="btn small" id="chat-new" type="button" title="Start a new conversation">New chat</button><button class="btn small" id="chat-close" type="button" aria-label="Close the chat">✕</button></div>
    <div id="chat-log" role="log" aria-live="polite"></div>
    <div id="chat-status" role="status" hidden></div>
    <form id="chat-form">
      <textarea id="chat-input" rows="3" placeholder="Ask Claude to build or change the map… (Enter sends, Shift+Enter adds a line)"></textarea>
      <div class="chat-foot"><span id="chat-usage"></span><button class="btn primary" id="chat-send" type="submit">Send</button></div>
    </form>
  </aside>`
    : '';
  const options = [`<option value="">Map style (${esc(map.style?.preset ?? 'classic-hatching')})</option>`]
    .concat(Object.entries(PRESETS).map(([k, s]) => `<option value="${esc(k)}"${k === style ? ' selected' : ''}>${esc(s.name)}</option>`))
    .join('');
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(map.name)} · Delve</title>
<link rel="icon" href="/favicon.svg" type="image/svg+xml">
<style>
  @font-face { font-family: "IM FELL English"; src: url("/fonts/im-fell-english.ttf") format("truetype"); font-display: swap; }
  @font-face { font-family: "Marcellus SC"; src: url("/fonts/marcellus-sc.ttf") format("truetype"); font-display: swap; }
  :root { --bar: #FFFFFF; --ink: #1B1F24; --muted: #5B6470; --line: #D9DEE4; --accent: #2C6AA0; --accent-ink: #FFFFFF; --live: #2E9E5B; --warn: #C98A12; --bad: #C0392B; color-scheme: light; }
  @media (prefers-color-scheme: dark) {
    :root { --bar: #191E24; --ink: #E5E9ED; --muted: #97A1AC; --line: #29303A; --accent: #6FA6D8; --accent-ink: #0C1520; color-scheme: dark; }
  }
  * { box-sizing: border-box; }
  html, body { height: 100%; margin: 0; }
  body { display: grid; grid-template-rows: auto 1fr; font: 14px/1.4 system-ui, "Segoe UI", sans-serif; color: var(--ink); background: var(--bar); }
  #main { display: grid; grid-template-columns: 1fr; min-height: 0; }
  body.editing #main { grid-template-columns: 1fr 300px; }
  #panel { border-left: 1px solid var(--line); background: var(--bar); overflow-y: auto; padding: 12px 14px 20px; display: grid; gap: 14px; align-content: start; }
  #panel[hidden] { display: none; }
  #panel h3 { margin: 0; font-size: .95rem; display: flex; gap: 8px; align-items: baseline; }
  #panel code { font: 12px ui-monospace, Consolas, monospace; color: var(--muted); }
  .toolgrid { display: grid; grid-template-columns: 1fr 1fr; gap: 6px; }
  .toolgrid button, #panel .row button, #panel > div > button, #props button { font: inherit; text-align: left; padding: 6px 9px; border: 1px solid var(--line); border-radius: 7px; background: transparent; color: var(--ink); cursor: pointer; display: flex; justify-content: space-between; align-items: center; gap: 6px; }
  .toolgrid button[aria-pressed="true"] { background: var(--accent); border-color: var(--accent); color: var(--accent-ink); }
  kbd { font: 11px ui-monospace, Consolas, monospace; opacity: .7; }
  .opts { display: grid; gap: 6px; }
  .opts label, .field { display: grid; gap: 3px; font-size: 13px; color: var(--muted); }
  .opts label { grid-template-columns: auto 1fr; align-items: center; gap: 8px; }
  .field > span { font-size: 12px; }
  #panel input[type="text"], #panel input[type="number"], #panel input[type="search"], #panel select, #panel textarea { font: inherit; color: var(--ink); background: transparent; border: 1px solid var(--line); border-radius: 6px; padding: 5px 7px; width: 100%; }
  #panel textarea { resize: vertical; }
  .pair { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; align-items: end; }
  .check { display: flex; align-items: center; gap: 6px; font-size: 13px; }
  .row { display: flex; gap: 6px; }
  #props { display: grid; gap: 10px; }
  #props .danger { color: var(--bad); border-color: color-mix(in srgb, var(--bad) 45%, var(--line)); justify-content: center; }
  .hint { margin: 0; color: var(--muted); font-size: 12.5px; }
  #toast { position: absolute; top: 12px; left: 50%; transform: translateX(-50%); max-width: min(560px, 90%); padding: 8px 12px; border-radius: 8px; background: var(--bad); color: #fff; font-size: 13px; z-index: 3; }
  #toast[data-kind="info"] { background: var(--accent); color: var(--accent-ink); }
  #toast[hidden] { display: none; }
  #floor-badge { position: absolute; top: 12px; left: 12px; z-index: 2; min-width: 1.5em; padding: 6px 16px 2px; border-radius: 12px; background: color-mix(in srgb, var(--bar) 70%, transparent); border: 1px solid color-mix(in srgb, var(--line) 70%, transparent); color: var(--ink); font: 400 48px/1 "Marcellus SC", Georgia, serif; text-align: center; font-variant-numeric: lining-nums; pointer-events: none; }
  #floor-badge[hidden] { display: none; }
  body.chatting #main { grid-template-columns: 1fr 360px; }
  body.editing.chatting #main { grid-template-columns: 1fr 300px 360px; }
  #chat { border-left: 1px solid var(--line); background: var(--bar); display: grid; grid-template-rows: auto 1fr auto auto; min-height: 0; min-width: 0; }
  #chat[hidden] { display: none; }
  .chat-head { display: flex; align-items: center; gap: 8px; padding: 9px 12px; border-bottom: 1px solid var(--line); }
  .chat-head select { padding: 3px 6px; font-size: 13px; }
  .btn.small { padding: 3px 8px; font-size: 13px; }
  #chat-log { overflow-y: auto; padding: 12px; display: flex; flex-direction: column; gap: 10px; min-height: 0; }
  .msg { padding: 8px 11px; border-radius: 10px; line-height: 1.45; overflow-wrap: anywhere; }
  .msg.user { align-self: flex-end; max-width: 88%; background: var(--accent); color: var(--accent-ink); white-space: pre-wrap; }
  .msg.claude { background: color-mix(in srgb, var(--ink) 6%, transparent); }
  .msg.error { background: color-mix(in srgb, var(--bad) 12%, transparent); border: 1px solid color-mix(in srgb, var(--bad) 40%, transparent); font-size: 13px; }
  .msg p { margin: 0 0 6px; }
  .msg ul, .msg ol { margin: 2px 0 6px; padding-left: 20px; }
  .msg .md > :last-child, .msg .md > :last-child > :last-child { margin-bottom: 0; }
  .msg code { font: 12px ui-monospace, Consolas, monospace; background: color-mix(in srgb, var(--ink) 10%, transparent); padding: 1px 4px; border-radius: 4px; }
  .msg a { color: inherit; }
  .tools { display: flex; flex-wrap: wrap; gap: 4px; margin: 2px 0 6px; }
  .tools:last-child { margin-bottom: 0; }
  .tool { font-size: 12px; padding: 1px 8px; border-radius: 999px; border: 1px solid var(--line); color: var(--muted); }
  .tool[data-state="running"] { border-color: var(--accent); color: var(--ink); }
  .tool[data-state="failed"] { border-color: color-mix(in srgb, var(--bad) 50%, var(--line)); color: var(--bad); }
  .typing { color: var(--muted); }
  .typing::after, .msg.live .md:last-child::after { content: "▍"; margin-left: 1px; animation: blink 1s steps(2, start) infinite; color: var(--muted); }
  @keyframes blink { to { visibility: hidden; } }
  .chat-empty { color: var(--muted); font-size: 13px; display: grid; gap: 7px; }
  .chat-empty p { margin: 0 0 4px; }
  .chat-empty button { text-align: left; font: inherit; color: var(--ink); border: 1px solid var(--line); background: transparent; border-radius: 8px; padding: 7px 9px; cursor: pointer; }
  .chat-empty button:hover { border-color: var(--accent); }
  #chat-status { padding: 0 12px 6px; font-size: 12.5px; color: var(--muted); }
  #chat-status[data-kind="bad"] { color: var(--bad); }
  #chat-status[hidden] { display: none; }
  #chat-form { border-top: 1px solid var(--line); padding: 10px 12px 12px; display: grid; gap: 6px; }
  #chat-input { font: inherit; color: var(--ink); background: transparent; border: 1px solid var(--line); border-radius: 8px; padding: 7px 9px; resize: vertical; min-height: 64px; max-height: 40vh; }
  #chat-input:focus-visible { outline: 2px solid var(--accent); outline-offset: 1px; }
  .chat-foot { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
  #chat-usage { font-size: 12px; color: var(--muted); }
  #chat-usage[data-kind="bad"] { color: var(--warn); }
  #overlay { position: absolute; inset: 0; width: 100%; height: 100%; pointer-events: none; overflow: visible; }
  #stage[data-tool]:not([data-tool=""]):not([data-tool="select"]) { cursor: crosshair; }
  .ed .sel { fill: none; stroke: #3B9BFF; stroke-width: 2px; stroke-dasharray: 5 3; vector-effect: non-scaling-stroke; }
  .ed .from { fill: rgba(59, 155, 255, .12); stroke: #3B9BFF; stroke-width: 2px; vector-effect: non-scaling-stroke; }
  .ed .ghost { fill: rgba(59, 155, 255, .14); stroke: #3B9BFF; stroke-width: 2px; vector-effect: non-scaling-stroke; }
  .ed .ghost-door { stroke: #3B9BFF; stroke-width: 6px; stroke-linecap: round; vector-effect: non-scaling-stroke; }
  .ed .ghost-line { fill: rgba(59, 155, 255, .10); stroke: #3B9BFF; stroke-width: 2px; stroke-dasharray: 5 3; vector-effect: non-scaling-stroke; }
  .ed .start { fill: #3B9BFF; }
  .ed .handle { fill: #FFFFFF; stroke: #3B9BFF; stroke-width: 1.5px; vector-effect: non-scaling-stroke; }
  .ed .cross { stroke: #3B9BFF; stroke-width: 1.5px; vector-effect: non-scaling-stroke; }
  .ed .dim { fill: #3B9BFF; font-family: system-ui, sans-serif; paint-order: stroke; stroke: #fff; stroke-width: 3px; vector-effect: non-scaling-stroke; }
  header { display: flex; flex-wrap: wrap; align-items: center; gap: 8px 14px; padding: 8px 14px; border-bottom: 1px solid var(--line); background: var(--bar); }
  .brand { font: 400 1.35rem/1 "IM FELL English", Georgia, serif; color: var(--ink); text-decoration: none; display: inline-flex; align-items: center; gap: 7px; }
  .brand img { display: block; border-radius: 4px; }
  #storey-select[hidden] { display: none; }
  .picker { display: grid; gap: 8px; }
  .brush { display: grid; gap: 6px; padding: 8px 10px; border: 1px solid var(--line); border-radius: 8px; font-size: 13px; }
  .brush strong { font-size: 12px; color: var(--muted); font-weight: 600; }
  .brush input[type="number"] { width: 4.5em; }
  .field.rough .row { align-items: center; }
  .field.rough input[type="range"] { flex: 1; min-width: 0; accent-color: var(--accent); }
  .field.rough output { color: var(--muted); font-variant-numeric: tabular-nums; }
  .ed .brush-path { fill: none; stroke-dasharray: 2 4; }
  .picker .pair { grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); }
  .picker-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(78px, 1fr)); gap: 6px; max-height: 46vh; overflow-y: auto; padding: 2px; }
  .picker-grid button { display: grid; justify-items: center; align-content: start; gap: 3px; padding: 5px 4px 6px; border: 1px solid var(--line); border-radius: 8px; background: #F0ECE0; color: #1B1F24; font: 11px/1.2 system-ui, sans-serif; text-align: center; cursor: pointer; }
  .picker-grid button[aria-pressed="true"] { outline: 2px solid var(--accent); outline-offset: 1px; }
  .picker-grid img { width: 56px; height: 56px; object-fit: contain; }
  .picker-grid .swatch { width: 56px; height: 56px; border-radius: 6px; background-size: 56px 56px; }
  .rotate { display: flex; gap: 6px; align-items: center; font-size: 13px; color: var(--muted); }
  .ed .ghost-prop { opacity: .75; }
  /* the Image tool and a selected picture (apps/web/src/images.ts) */
  .image-picker.drop { outline: 2px dashed var(--accent); outline-offset: 4px; border-radius: 8px; }
  .image-picker .upload { justify-content: center; flex: 1; }
  .image-picker > button.danger { font: inherit; font-size: 13px; padding: 5px 9px; border: 1px solid color-mix(in srgb, var(--bad) 45%, var(--line)); border-radius: 7px; background: transparent; color: var(--bad); cursor: pointer; }
  .image-card { display: grid; grid-template-columns: 64px minmax(0, 1fr); gap: 8px; align-items: center; overflow-wrap: anywhere; }
  .image-card img { width: 64px; height: 64px; object-fit: contain; background: #F0ECE0; border: 1px solid var(--line); border-radius: 6px; }
  #panel .rotate input[type="number"] { width: 5.5em; }
  .field.opacity input[type="range"] { width: 100%; accent-color: var(--accent); }
  .field.opacity output { color: var(--muted); font-variant-numeric: tabular-nums; }
  .ed .guide { fill: rgba(59, 155, 255, .05); stroke: #3B9BFF; stroke-opacity: .6; stroke-width: 1.5px; stroke-dasharray: 6 4; vector-effect: non-scaling-stroke; }
  .title { display: flex; align-items: baseline; gap: 8px; min-width: 0; }
  #map-name { font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 40vw; }
  #map-rev, .muted { color: var(--muted); font-variant-numeric: tabular-nums; }
  .spacer { flex: 1; }
  .seg { display: inline-flex; border: 1px solid var(--line); border-radius: 7px; overflow: hidden; }
  .seg button { border: 0; background: transparent; color: var(--ink); padding: 5px 11px; font: inherit; cursor: pointer; }
  .seg button + button { border-left: 1px solid var(--line); }
  .seg button[aria-pressed="true"] { background: var(--accent); color: var(--accent-ink); }
  select, .btn { font: inherit; color: var(--ink); background: transparent; border: 1px solid var(--line); border-radius: 7px; padding: 5px 10px; text-decoration: none; cursor: pointer; }
  .btn.primary, .btn[aria-pressed="true"] { background: var(--accent); border-color: var(--accent); color: var(--accent-ink); }
  button:focus-visible, select:focus-visible, .btn:focus-visible, a:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
  .conn { display: inline-flex; align-items: center; gap: 6px; color: var(--muted); }
  #conn-dot { width: 9px; height: 9px; border-radius: 50%; background: var(--warn); }
  #conn-dot[data-state="live"] { background: var(--live); box-shadow: 0 0 0 3px color-mix(in srgb, var(--live) 25%, transparent); }
  #conn-dot[data-state="offline"], #conn-dot[data-state="deleted"] { background: var(--bad); }
  #stage { position: relative; overflow: hidden; touch-action: none; cursor: grab; background: ${bg}; }
  #stage.dragging { cursor: grabbing; }
  #canvas { position: absolute; inset: 0; }
  #canvas svg { width: 100%; height: 100%; display: block; }
  #activity { position: absolute; left: 12px; bottom: 12px; padding: 6px 10px; border-radius: 7px; background: color-mix(in srgb, var(--bar) 88%, transparent); border: 1px solid var(--line); color: var(--ink); font-size: 13px; pointer-events: none; }
  .hl-focus { fill: rgba(255, 170, 0, .14); stroke: #FFAA00; stroke-width: 3px; vector-effect: non-scaling-stroke; animation: pulse 1.1s ease-in-out 3; }
  .hl-change { fill: rgba(59, 155, 255, .12); stroke: #3B9BFF; stroke-width: 2px; vector-effect: non-scaling-stroke; animation: fade 1.6s ease-out forwards; }
  @keyframes pulse { 50% { stroke-opacity: .25; fill-opacity: .05; } }
  @keyframes fade { to { stroke-opacity: 0; fill-opacity: 0; } }
  @media (prefers-reduced-motion: reduce) { .hl-focus, .hl-change { animation: none; } }
  /* GM markers: the note box (apps/web/src/markers.ts) and the marker tool's kinds */
  #stage.on-marker:not(.dragging) { cursor: pointer !important; }
  .marker-box { position: fixed; z-index: 20; width: min(300px, calc(100vw - 16px)); display: grid; gap: 8px; padding: 10px 12px 10px; border-radius: 10px; border: 1px solid var(--line); border-top: 4px solid var(--kind, var(--accent)); background: var(--bar); color: var(--ink); box-shadow: 0 8px 28px rgba(0, 0, 0, .28); font: 14px/1.45 system-ui, "Segoe UI", sans-serif; }
  .marker-box[hidden] { display: none; }
  .marker-box[data-kind="discover"] { --kind: #D9961A; }
  .marker-box[data-kind="interact"] { --kind: #2F7FD1; }
  .marker-box[data-kind="trap"] { --kind: #C43A2F; }
  .marker-head { display: flex; align-items: center; gap: 8px; }
  .marker-head strong { flex: 1; font-size: 13px; }
  .marker-icon { width: 26px; height: 26px; flex: none; }
  .marker-close { border: 0; background: transparent; color: var(--muted); font-size: 20px; line-height: 1; cursor: pointer; padding: 0 2px; }
  .marker-text { margin: 0; width: 100%; min-height: 3.2em; font: inherit; color: var(--ink); background: transparent; border: 1px solid var(--line); border-radius: 7px; padding: 6px 8px; resize: vertical; white-space: pre-wrap; }
  p.marker-text { border-color: transparent; padding: 0; }
  .marker-box.done .marker-text { text-decoration: line-through; color: var(--muted); }
  .marker-box.done .marker-head strong { text-decoration: line-through; }
  .marker-foot { display: flex; flex-wrap: wrap; justify-content: space-between; gap: 4px 10px; font-size: 12px; color: var(--muted); }
  .marker-foot label { display: inline-flex; align-items: center; gap: 5px; color: var(--ink); cursor: pointer; }
  .marker-kinds { display: grid; gap: 5px; }
  .marker-kinds button { display: flex; align-items: center; gap: 8px; padding: 5px 8px; border: 1px solid var(--line); border-radius: 7px; background: transparent; color: var(--ink); font: 13px system-ui, sans-serif; cursor: pointer; text-align: left; }
  .marker-kinds button[aria-pressed="true"] { outline: 2px solid var(--accent); outline-offset: 1px; }
  .kind-dot { display: inline-grid; place-items: center; width: 20px; height: 20px; border-radius: 50%; color: #fff; font-weight: 700; font-size: 12px; box-shadow: 0 0 0 2px #fff inset; }
  .marker-kinds [data-kind="discover"] .kind-dot { background: #D9961A; }
  .marker-kinds [data-kind="interact"] .kind-dot { background: #2F7FD1; }
  .marker-kinds [data-kind="trap"] .kind-dot { background: #C43A2F; }
  /* the Segment tool (apps/web/src/segments.ts): modes, the name form, the library */
  .seg-modes { display: grid; grid-template-columns: repeat(3, 1fr); gap: 6px; }
  .seg-modes button, .seg-around, .seg-save button, .seg-acts button { font: inherit; padding: 5px 8px; border: 1px solid var(--line); border-radius: 7px; background: transparent; color: var(--ink); cursor: pointer; }
  .seg-modes button[aria-pressed="true"] { background: var(--accent); border-color: var(--accent); color: var(--accent-ink); }
  .seg-save { display: grid; gap: 6px; padding: 8px 10px; border: 1px solid var(--accent); border-radius: 8px; }
  #props .seg-save button { justify-content: center; flex: 1; }
  .seg-lib { display: grid; gap: 6px; max-height: 46vh; overflow-y: auto; padding: 2px; }
  .seg-item { display: grid; gap: 5px; padding: 6px; border: 1px solid var(--line); border-radius: 8px; }
  .seg-item[aria-selected="true"] { outline: 2px solid var(--accent); outline-offset: 1px; }
  .seg-pick { display: grid; grid-template-columns: 72px minmax(0, 1fr); gap: 8px; align-items: center; padding: 0; border: 0; background: transparent; color: var(--ink); font: inherit; text-align: left; cursor: pointer; }
  div.seg-pick { cursor: default; }
  .seg-thumb { width: 72px; height: 54px; display: grid; place-items: center; overflow: hidden; background: #F0ECE0; border: 1px solid var(--line); border-radius: 6px; }
  .seg-thumb svg { width: 100%; height: 100%; display: block; }
  .seg-text { display: grid; gap: 2px; min-width: 0; overflow-wrap: anywhere; }
  .seg-name { font-weight: 600; font-size: 13px; }
  .seg-meta { font-size: 12px; color: var(--muted); }
  .seg-acts { display: flex; gap: 6px; }
  .seg-acts button { font-size: 12px; padding: 2px 9px; }
  .seg-acts .danger { color: var(--bad); }
  .ed .ghost-seg { opacity: .75; }
</style>
</head>
<body>
<header>
  <a class="brand" href="/"><img src="/assets/brand/mark.svg" alt="" width="22" height="22">Delve</a>
  <div class="title"><span id="map-name">${esc(map.name)}</span><span id="map-rev">rev ${rev}</span></div>
  <select id="storey-select" aria-label="Storey" title="Storeys of this place"${o.levels.length > 1 ? '' : ' hidden'}>${storeyOptions}</select>
  <span class="conn"><span id="conn-dot" data-state="connecting"></span><span id="conn-text">Connecting…</span></span>
  <span class="spacer"></span>
  <div class="seg" role="group" aria-label="View">
    <button data-view="gm" aria-pressed="${view === 'gm'}">GM view</button><button data-view="players" aria-pressed="${view === 'players'}">Players’ view</button>
  </div>
  <label class="muted" for="style-select">Style</label>
  <select id="style-select">${options}</select>
  <button class="btn" id="fit" title="Fit the map (F or double-click)">Fit</button>
  <a class="btn" id="view-3d" href="/maps/${encodeURIComponent(id)}/3d" title="All storeys stacked in 3D, with the stairs that connect them">3D</a>
  <a class="btn" id="view-handout" href="/maps/${encodeURIComponent(id)}/handout" title="The players' map, hand-drawn on old parchment: print it or hand it out">Handout</a>
  <a class="btn primary" id="png-link" href="/api/v1/maps/${encodeURIComponent(id)}/render.png?view=${view}">PNG for Roll20</a>
  ${editControl}
  ${chatControl}
</header>
<div id="main">
  <div id="stage">
    <div id="canvas">${sceneToSvg(scene, { ppg: 20 })}</div>
    <svg id="overlay" xmlns="http://www.w3.org/2000/svg" preserveAspectRatio="xMidYMid meet" viewBox="${scene.bounds.x0} ${scene.bounds.y0} ${scene.bounds.x1 - scene.bounds.x0} ${scene.bounds.y1 - scene.bounds.y0}"></svg>
    ${floorBadge}
    <div id="activity">Waiting for changes</div>
    <div id="toast" role="status" hidden></div>
  </div>
  <aside id="panel" hidden aria-label="Editor">
    <div id="tools"></div>
    <div id="props"></div>
  </aside>
  ${chatPanel}
</div>
<script id="delve-initial" type="application/json">${initial}</script>
<script type="module" src="/assets/viewer.js?v=${encodeURIComponent(info.version)}"></script>
</body>
</html>`;
}

/**
 * The players' screen (/maps/:id/screen): the players' view with fog of war,
 * full screen, following every change live. For a TV at the table or a
 * Discord screen share. The script is /assets/screen.js.
 */
/**
 * What a players' screen gets: the picture (built only from what the players
 * have seen) and where to frame it. Never the map itself.
 */
export function screenPayload(map: DelveMap, rev: number) {
  const scene = sceneFor(map, { view: 'players', fog: '1' });
  const fogged = Boolean(map.fog?.on);
  const seen = fogged ? revealedBounds(map) : null;
  const frame = fogged ? (seen ? { x0: seen.x0 - 2, y0: seen.y0 - 2, x1: seen.x1 + 2, y1: seen.y1 + 2 } : null) : scene.bounds;
  return {
    rev,
    name: map.name,
    background: scene.layers[0]?.kind === 'rect' ? scene.layers[0].color : '#EFEAE2',
    frame,
    hidden: fogged && !seen,
    svg: sceneToSvg(scene, { ppg: 20 }),
  };
}

function screenPage(info: AppInfo, id: string, rev: number, map: DelveMap): string {
  const { svg, ...rest } = screenPayload(map, rev);
  const bg = rest.background;
  const initial = JSON.stringify({ id, ...rest }).replace(/</g, '\\u003c');
  const scene = { svg };
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(map.name)} · Players' screen</title>
<link rel="icon" href="/favicon.svg" type="image/svg+xml">
<style>
  @font-face { font-family: "IM FELL English"; src: url("/fonts/im-fell-english.ttf") format("truetype"); font-display: swap; }
  @font-face { font-family: "Marcellus SC"; src: url("/fonts/marcellus-sc.ttf") format("truetype"); font-display: swap; }
  html, body { height: 100%; margin: 0; overflow: hidden; }
  body { background: ${bg}; font: 15px/1.4 system-ui, sans-serif; }
  #stage, #canvas { position: absolute; inset: 0; }
  #canvas svg { width: 100%; height: 100%; display: block; }
  #full { position: absolute; right: 14px; bottom: 14px; padding: 7px 12px; border: 0; border-radius: 8px; background: rgba(25, 30, 36, .7); color: #fff; font: inherit; cursor: pointer; opacity: 0; transition: opacity .3s; }
  body:hover #full, #full:focus-visible { opacity: 1; }
  #note { position: absolute; left: 50%; top: 45%; transform: translate(-50%, -50%); color: #5B5348; font: 1.6rem "IM FELL English", Georgia, serif; text-align: center; pointer-events: none; }
  #note[hidden] { display: none; }
</style>
</head>
<body>
<div id="stage"><div id="canvas">${scene.svg}</div></div>
<div id="note"${rest.hidden ? '' : ' hidden'}>The map is still hidden.</div>
<button id="full" type="button" title="Full screen (F)">Full screen</button>
<script id="delve-initial" type="application/json">${initial}</script>
<script type="module" src="/assets/screen.js?v=${encodeURIComponent(info.version)}"></script>
</body>
</html>`;
}

export function registerViewer(app: FastifyInstance, info: AppInfo, store: MapStore, auth: EditorAuth, chat?: ChatConfig): void {
  app.get('/maps/:id/screen', async (req, reply) => {
    const { id } = req.params as { id: string };
    try {
      const { rev, map } = store.get(id);
      return reply.type('text/html; charset=utf-8').header('cache-control', 'no-store').send(screenPage(info, id, rev, map));
    } catch (e) {
      if (!(e instanceof NotFoundError)) throw e;
      return reply.code(404).type('text/plain').send('no such map');
    }
  });

  // The players' screen fetches its picture here whenever the map changes.
  app.get('/api/v1/maps/:id/screen', async (req, reply) => {
    const { id } = req.params as { id: string };
    try {
      const { rev, map } = store.get(id);
      return reply.header('cache-control', 'no-store').send(screenPayload(map, rev));
    } catch (e) {
      if (!(e instanceof NotFoundError)) throw e;
      return reply.code(404).send({ error: `no map with id "${id}"` });
    }
  });

  const scripts = new Map<string, string>();

  app.get('/maps/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    const q = req.query as { view?: string; style?: string };
    try {
      const { rev, map } = store.get(id);
      const style = q.style && PRESETS[q.style] ? q.style : undefined;
      const opts = {
        view: asView(q.view),
        style,
        loggedIn: isLoggedIn(auth, req),
        passwordSet: canLogIn(auth) || auth.sessions.open,
        chatModel: chat ? (chat.model ?? 'sonnet') : null,
        levels: levelSiblings(store.list(), id).reverse(),
      };
      return reply.type('text/html; charset=utf-8').header('cache-control', 'no-store').send(page(info, id, rev, map, opts));
    } catch (e) {
      if (!(e instanceof NotFoundError)) throw e;
      return reply
        .code(404)
        .type('text/html; charset=utf-8')
        .send(`<!doctype html><meta charset="utf-8"><title>Not found · Delve</title><p style="font-family:system-ui;margin:3rem">No map with id <code>${esc(id)}</code>. <a href="/">Back to Delve</a></p>`);
    }
  });

  // viewer.js: the viewer and editor; stack.js: the 3D view (with three.js, so only that page loads it);
  // table-dice.js: the table's 3D dice, which table.js imports on the first roll; table3d.js: the 3D table view.
  for (const name of ['viewer.js', 'stack.js', 'screen.js', 'trace.js', 'trace-worker.js', 'table.js', 'table-dice.js', 'table3d.js']) {
    app.get(`/assets/${name}`, async (_req, reply) => {
      let script = scripts.get(name);
      if (script === undefined) {
        const file = findScript(name);
        if (!file) return reply.code(404).type('text/plain').send(`${name} not built: run npm run build:web`);
        scripts.set(name, (script = readFileSync(file, 'utf8')));
      }
      // Releases change ?v= with every version; a dev server is always "dev", so never cache there.
      const cache = info.version === 'dev' ? 'no-store' : 'public, max-age=300';
      return reply.type('text/javascript; charset=utf-8').header('cache-control', cache).send(script);
    });
  }
}
