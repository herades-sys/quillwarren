// The small HTML pages around the table: the GM's lobby, the invite name form,
// and friendly errors. Same look as Delve's start page.
import type { GameSummary } from './store.ts';

export const esc = (s: string): string =>
  s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

export function shell(title: string, body: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<link rel="icon" href="/favicon.svg" type="image/svg+xml">
<style>
  @font-face { font-family: "IM FELL English"; src: url("/fonts/im-fell-english.ttf") format("truetype"); font-display: swap; }
  :root {
    --bg: #F2F4F6; --surface: #FFFFFF; --ink: #1B1F24; --muted: #5B6470; --line: #D9DEE4;
    --accent: #2C6AA0; --accent-ink: #FFFFFF; --code: #EAEEF2; --bad: #B3261E;
    color-scheme: light;
  }
  @media (prefers-color-scheme: dark) {
    :root { --bg: #101317; --surface: #191E24; --ink: #E5E9ED; --muted: #97A1AC; --line: #29303A;
            --accent: #6FA6D8; --accent-ink: #0C1520; --code: #131820; --bad: #F2B8B5; color-scheme: dark; }
  }
  * { box-sizing: border-box; }
  body { margin: 0; background: var(--bg); color: var(--ink); font: 15px/1.55 system-ui, "Segoe UI", sans-serif; }
  .page { max-width: 960px; margin: 0 auto; padding: 28px 16px 64px; display: grid; gap: 24px; }
  .narrow { max-width: 420px; }
  .top { display: flex; flex-wrap: wrap; align-items: baseline; gap: 8px 18px; }
  h1 { font: 400 2.6rem/1 "IM FELL English", Georgia, serif; margin: 0; }
  h2 { font: 400 1.6rem/1.2 "IM FELL English", Georgia, serif; margin: 0; }
  p { margin: 0; }
  .note { color: var(--muted); font-size: .9rem; }
  .error { color: var(--bad); }
  code { font-family: ui-monospace, "Cascadia Mono", Consolas, monospace; background: var(--code); padding: 1px 6px; border-radius: 4px; font-size: .85em; }
  .card { background: var(--surface); border: 1px solid var(--line); border-radius: 10px; padding: 18px; display: grid; gap: 12px; }
  .button { display: inline-block; padding: 5px 11px; border-radius: 6px; border: 1px solid var(--line); color: var(--ink); text-decoration: none; font: inherit; font-weight: 500; font-size: .88rem; white-space: nowrap; background: transparent; cursor: pointer; }
  .button.primary { background: var(--accent); border-color: var(--accent); color: var(--accent-ink); }
  .button.danger { color: #B03A2E; border-color: color-mix(in srgb, #B03A2E 45%, var(--line)); }
  .button:focus-visible, input:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
  form.row { display: flex; flex-wrap: wrap; align-items: end; gap: 10px 14px; }
  label { display: grid; gap: 4px; font-size: .82rem; color: var(--muted); }
  input { font: inherit; color: var(--ink); background: transparent; border: 1px solid var(--line); border-radius: 6px; padding: 6px 9px; min-width: 14rem; }
  .table { overflow-x: auto; background: var(--surface); border: 1px solid var(--line); border-radius: 10px; }
  table { border-collapse: collapse; width: 100%; font-size: .9rem; }
  th, td { text-align: left; padding: 10px 14px; border-bottom: 1px solid var(--line); vertical-align: middle; }
  tr:last-child td { border-bottom: 0; }
  th { font-weight: 600; color: var(--muted); font-size: .8rem; text-transform: uppercase; letter-spacing: .04em; }
  .num { text-align: right; font-variant-numeric: tabular-nums; }
  .links { display: flex; flex-wrap: wrap; gap: 6px; }
  .spacer { flex: 1; }
</style>
</head>
<body>
${body}
</body>
</html>`;
}

/** A short page with a heading, some text and a way on. */
export function messagePage(title: string, lines: string[], links: { href: string; text: string }[] = []): string {
  const ps = lines.map((l) => `<p>${esc(l)}</p>`).join('\n');
  const as = links.map((l) => `<a class="button" href="${esc(l.href)}">${esc(l.text)}</a>`).join(' ');
  return shell(`${title} · Delve Table`, `<main class="page narrow"><h1>${esc(title)}</h1><div class="card">${ps}${as ? `<p class="links">${as}</p>` : ''}</div></main>`);
}

export function lobbyPage(games: GameSummary[]): string {
  const rows = games
    .map(
      (g) => `<tr>
  <td><strong>${esc(g.name)}</strong><br><code>${esc(g.id)}</code></td>
  <td class="num">${g.players}</td>
  <td class="note">${esc(g.created.replace('T', ' ').slice(0, 16))}</td>
  <td class="links"><a class="button primary" href="/play/${encodeURIComponent(g.id)}">Open table</a>
    <button class="button danger" type="button" data-delete="${esc(g.id)}" data-name="${esc(g.name)}">Delete</button></td>
</tr>`,
    )
    .join('\n');
  const list = games.length
    ? `<div class="table"><table>
<thead><tr><th>Game</th><th class="num">Players</th><th>Created (UTC)</th><th></th></tr></thead>
<tbody>${rows}</tbody></table></div>`
    : `<p class="note">No games yet.</p>`;
  return shell(
    'Delve Table',
    `<main class="page">
  <div class="top"><h1>Delve Table</h1><span class="spacer"></span><a class="button" href="/">Delve maps</a></div>
  <form method="post" action="/play/new" class="row card">
    <label>Name <input name="name" required maxlength="80" placeholder="e.g. Curse of the Crypt"></label>
    <button class="button primary" type="submit">New game</button>
  </form>
  <p class="note">Invite players from the table's Players tab: they get a link, pick a name, and need no account.</p>
  ${list}
</main>
<script>
  document.querySelectorAll('[data-delete]').forEach((b) => b.addEventListener('click', async () => {
    if (!confirm('Delete "' + b.dataset.name + '"? Its pages, tokens and chat are gone for good.')) return;
    const res = await fetch('/api/v1/games/' + encodeURIComponent(b.dataset.delete), { method: 'DELETE' });
    if (!res.ok) { const body = await res.json().catch(() => ({})); alert('Deleting failed: ' + (body.error || res.status)); return; }
    b.closest('tr').remove();
  }));
</script>`,
  );
}

/** What a player (or anyone not logged in) sees at /play. */
export function notGmPage(yours: { id: string; name: string }[], canLogIn: boolean): string {
  const list = yours.length
    ? `<p>Your games:</p><p class="links">${yours.map((g) => `<a class="button primary" href="/play/${encodeURIComponent(g.id)}">${esc(g.name)}</a>`).join(' ')}</p>`
    : '';
  const login = canLogIn ? `<p class="note">Are you the GM? <a href="/login?next=/play">Log in</a>.</p>` : '';
  return shell(
    'Delve Table',
    `<main class="page narrow"><h1>Delve Table</h1><div class="card">${list}<p>To join a game, ask your GM for an invite link.</p>${login}</div></main>`,
  );
}

export function joinPage(o: { token: string; gameName: string; inviteName?: string; error?: string; name?: string }): string {
  return shell(
    `Join ${o.gameName} · Delve Table`,
    `<main class="page narrow"><h1>Join the table</h1>
<form class="card" method="post" action="/play/join/${esc(o.token)}">
  <p>You're invited to <strong>${esc(o.gameName)}</strong>${o.inviteName ? ` (${esc(o.inviteName)})` : ''}.</p>
  ${o.error ? `<p class="error">${esc(o.error)}</p>` : ''}
  <label>Your name at the table <input name="name" required maxlength="40" autocomplete="nickname" autofocus value="${esc(o.name ?? '')}"></label>
  <p><button class="button primary" type="submit">Join</button></p>
</form></main>`,
  );
}
