// The small HTML pages around the table: the GM's lobby, the invite name form,
// and friendly errors, in the shared look (@delve/ui). Their markup keeps the
// short class names (.button, .card, .note) that the routes here and in
// discord.ts use; the CSS below draws them as the design's buttons and panels.
import { htmlDocument, themeSwitch, topBar } from '@delve/ui';
import type { GameSummary } from './store.ts';

export const esc = (s: string): string =>
  s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

const CSS = `<style>
  .page { max-width: 960px; gap: var(--space-6); }
  .page.narrow { max-width: 460px; padding-top: max(var(--space-10), 6vh); }
  .top { display: flex; flex-wrap: wrap; align-items: flex-end; gap: 8px 18px; }
  .page h1 { font-family: var(--font-display); font-weight: 400; font-size: var(--display-lg); line-height: 1.1; margin: 0; letter-spacing: 0; }
  .page h2 { font-family: var(--font-display); font-weight: 400; font-size: var(--display-sm); margin: 0; }
  .page p { margin: 0; }
  .note { color: var(--color-text-muted); font-size: var(--text-md); }
  .error { padding: 9px 12px; border-radius: 10px; background: var(--tint-danger-bg); color: var(--tint-danger-fg); }
  code { background: var(--color-surface-2); padding: 1px 6px; border-radius: 4px; font-size: .85em; }
  .page .card { background: var(--color-surface); border-radius: var(--radius-lg); padding: 22px; display: flex; flex-direction: column; gap: 14px; box-shadow: var(--shadow-sm); }
  .button { display: inline-flex; align-items: center; justify-content: center; gap: 6px; height: var(--control-md); padding: 0 12px; border-radius: var(--radius-md); border: 1px solid var(--color-divider); color: var(--color-text); background: transparent; font: inherit; font-weight: var(--font-heading-weight); font-size: var(--text-md); white-space: nowrap; cursor: pointer; text-decoration: none; }
  .button:hover { background: var(--color-hover); color: var(--color-text); }
  .button.primary { color: var(--color-accent); border-color: var(--color-accent); }
  .button.primary:hover { background: color-mix(in srgb, var(--color-accent) 12%, transparent); color: var(--color-accent); }
  .button.danger { color: var(--color-danger); border-color: color-mix(in srgb, var(--color-danger) 70%, transparent); }
  .button.danger:hover { background: color-mix(in srgb, var(--color-danger) 12%, transparent); }
  .button.discord { height: var(--control-lg); padding: 0 16px; background: #5865F2; border-color: #5865F2; color: #FFFFFF; }
  .button.discord:hover { background: #4752C4; color: #FFFFFF; }
  form.row, .page form.row.card { display: flex; flex-direction: row; flex-wrap: wrap; align-items: flex-end; gap: 10px 14px; }
  .page label { display: flex; flex-direction: column; gap: 5px; font-size: var(--text-sm); color: color-mix(in srgb, var(--color-text) 70%, transparent); }
  .page input:not([type="hidden"]) { font: inherit; font-size: 14px; color: var(--color-text); background: var(--color-surface-2); border: 1px solid var(--color-control-border); border-radius: var(--radius-md); padding: 6px 10px; min-height: var(--control-lg); min-width: 14rem; }
  .page input:hover { border-color: var(--color-text-muted); }
  .page input:focus-visible { border-color: var(--color-accent); outline: 2px solid var(--color-accent); outline-offset: 0; }
  .table { overflow-x: auto; background: var(--color-surface); border-radius: var(--radius-lg); box-shadow: var(--shadow-sm); padding: 4px 8px; }
  .table td, .table th { padding: 10px 8px; }
  .num { text-align: right; font-variant-numeric: tabular-nums; }
  .links { display: flex; flex-wrap: wrap; gap: 6px; }
  .spacer { flex: 1; }
  form.inline { display: inline; }
  form.card-part { display: flex; flex-direction: column; gap: 12px; }
  .linkish { border: 0; background: none; padding: 0; font: inherit; color: var(--color-accent-text); text-decoration: underline; cursor: pointer; }
  .or { color: var(--color-text-muted); font-size: var(--text-md); }
  @media (max-width: 640px) { .page input:not([type="hidden"]) { min-width: 0; width: 100%; font-size: var(--text-touch); min-height: var(--touch); } .button { min-height: var(--touch); } }
</style>`;

export function shell(title: string, body: string): string {
  return htmlDocument({ title, body: `${topBar({ title: 'Delve Table', end: themeSwitch() })}${body}`, extra: CSS });
}

/** An inline "Log out" button (a POST, so another site can't log anyone out). */
export const logoutButton = (next: string, label = 'Log out'): string =>
  `<form class="inline" method="post" action="/auth/logout"><input type="hidden" name="next" value="${esc(next)}"><button class="linkish" type="submit">${esc(label)}</button></form>`;

/** "Logged in as <name> · Log out" for someone logged in with Discord. */
export const accountLine = (name: string, next: string): string =>
  `<p class="note">Logged in with Discord as <strong>${esc(name)}</strong> · ${logoutButton(next)}</p>`;

const discordButton = (href: string): string => `<a class="button discord" href="${esc(href)}">Log in with Discord</a>`;

/** A short page with a heading, some text and a way on. */
export function messagePage(title: string, lines: string[], links: { href: string; text: string }[] = []): string {
  const ps = lines.map((l) => `<p>${esc(l)}</p>`).join('\n');
  const as = links.map((l) => `<a class="button" href="${esc(l.href)}">${esc(l.text)}</a>`).join(' ');
  return shell(`${title} · Delve Table`, `<main class="page narrow"><h1>${esc(title)}</h1><div class="card">${ps}${as ? `<p class="links">${as}</p>` : ''}</div></main>`);
}

export function lobbyPage(games: GameSummary[], account?: { name: string }): string {
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
  ${account ? accountLine(account.name, '/play') : ''}
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

/** Discord login on a page: the link that starts it, and who is logged in already. */
export interface DiscordLogin {
  loginUrl: string;
  account?: { name: string };
}

/** What a player (or anyone not logged in) sees at /play. */
export function notGmPage(yours: { id: string; name: string }[], canLogIn: boolean, discord?: DiscordLogin): string {
  const list = yours.length
    ? `<p>Your games:</p><p class="links">${yours.map((g) => `<a class="button primary" href="/play/${encodeURIComponent(g.id)}">${esc(g.name)}</a>`).join(' ')}</p>`
    : '';
  const login = canLogIn ? `<p class="note">Are you the GM? <a href="/login?next=/play">Log in</a>.</p>` : '';
  const who = discord?.account
    ? accountLine(discord.account.name, '/play')
    : discord
      ? `<p class="links">${discordButton(discord.loginUrl)}</p><p class="note">Log in to see your games on any device.</p>`
      : '';
  return shell(
    'Delve Table',
    `<main class="page narrow"><h1>Delve Table</h1><div class="card">${who}${list}<p>To join a game, ask your GM for an invite link.</p>${login}</div></main>`,
  );
}

export interface JoinOptions {
  token: string;
  gameName: string;
  inviteName?: string;
  error?: string;
  name?: string;
  /** Discord login is set up; `required` when the game only takes Discord logins. */
  discord?: DiscordLogin & { required: boolean };
}

export function joinPage(o: JoinOptions): string {
  const action = `/play/join/${o.token}`;
  const intro = `<p>You're invited to <strong>${esc(o.gameName)}</strong>${o.inviteName ? ` (${esc(o.inviteName)})` : ''}.</p>
  ${o.error ? `<p class="error">${esc(o.error)}</p>` : ''}`;
  const nameForm = (value: string, cls: string) => `<form class="${cls}" method="post" action="${esc(action)}">
  <label>Your name at the table <input name="name" required maxlength="40" autocomplete="nickname" autofocus value="${esc(value)}"></label>
  <p><button class="button primary" type="submit">Join</button></p>
</form>`;
  const d = o.discord;
  let body: string;
  if (!d) {
    body = `<form class="card" method="post" action="${esc(action)}">
  ${intro}
  <label>Your name at the table <input name="name" required maxlength="40" autocomplete="nickname" autofocus value="${esc(o.name ?? '')}"></label>
  <p><button class="button primary" type="submit">Join</button></p>
</form>`;
  } else if (d.account) {
    body = `<div class="card">${intro}
  <p class="note">Logged in with Discord as <strong>${esc(d.account.name)}</strong>. Your seat follows this login to your other devices.</p>
  ${nameForm(o.name ?? d.account.name, 'card-part')}
  <p class="note">Not you? ${logoutButton(action)}</p>
</div>`;
  } else if (d.required) {
    body = `<div class="card">${intro}
  <p>This game asks players to log in with Discord.</p>
  <p class="links">${discordButton(d.loginUrl)}</p>
</div>`;
  } else {
    body = `<div class="card">${intro}
  <p class="links">${discordButton(d.loginUrl)}</p>
  <p class="note">With a Discord login your seat follows you to your other devices.</p>
  <p class="or">or just type a name:</p>
  ${nameForm(o.name ?? '', 'card-part')}
</div>`;
  }
  return shell(`Join ${o.gameName} · Delve Table`, `<main class="page narrow"><h1>Join the table</h1>\n${body}</main>`);
}
