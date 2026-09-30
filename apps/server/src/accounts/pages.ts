// HTML for the login and account pages, in the start page's look (the colour
// tokens below are shared with preview.ts). Every value that came from a
// person is escaped.
import { LINK_MS, MIN_PASSWORD, type Session, type User } from './store.ts';

export const esc = (s: string): string =>
  s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

/** The start page's colour tokens, light and dark. */
export const TOKENS_CSS = `:root {
    --bg: #F2F4F6; --surface: #FFFFFF; --ink: #1B1F24; --muted: #5B6470; --line: #D9DEE4;
    --accent: #2C6AA0; --accent-ink: #FFFFFF; --code: #EAEEF2; --bad: #B3261E; --ok: #2E7D4F;
    color-scheme: light;
  }
  @media (prefers-color-scheme: dark) {
    :root { --bg: #101317; --surface: #191E24; --ink: #E5E9ED; --muted: #97A1AC; --line: #29303A;
            --accent: #6FA6D8; --accent-ink: #0C1520; --code: #131820; --bad: #F2B8B5; --ok: #8FD1A8; color-scheme: dark; }
  }`;

const CSS = `
  @font-face { font-family: "IM FELL English"; src: url("/fonts/im-fell-english.ttf") format("truetype"); font-display: swap; }
  ${TOKENS_CSS}
  * { box-sizing: border-box; }
  body { margin: 0; min-height: 100vh; background: var(--bg); color: var(--ink); font: 15px/1.55 system-ui, "Segoe UI", sans-serif; }
  .page { max-width: 980px; margin: 0 auto; padding: 28px 20px 64px; display: grid; gap: 22px; }
  .page.narrow { max-width: 480px; padding-top: 8vh; }
  .top { display: flex; flex-wrap: wrap; align-items: baseline; gap: 8px 16px; }
  .top .spacer { flex: 1; }
  h1 { font: 400 2.3rem/1.05 "IM FELL English", Georgia, serif; margin: 0; }
  h1 a { color: inherit; text-decoration: none; }
  h2 { font: 400 1.5rem/1.2 "IM FELL English", Georgia, serif; margin: 0; }
  p { margin: 0; }
  .card { background: var(--surface); border: 1px solid var(--line); border-radius: 12px; padding: 22px; display: grid; grid-template-columns: minmax(0, 1fr); gap: 14px; min-width: 0; }
  .muted, .hint { color: var(--muted); }
  .hint { font-size: .88rem; }
  form { display: grid; gap: 12px; margin: 0; }
  form.inline { display: inline; }
  label { display: grid; gap: 5px; font-weight: 500; }
  label.check { display: flex; align-items: center; gap: 8px; font-weight: 400; }
  input[type="text"], input[type="password"], select { font: inherit; padding: 8px 10px; border: 1px solid var(--line); border-radius: 8px; background: transparent; color: var(--ink); width: 100%; }
  input.code { font-family: ui-monospace, "Cascadia Mono", Consolas, monospace; letter-spacing: .08em; }
  .button, button { display: inline-block; font: inherit; font-weight: 600; font-size: .92rem; padding: 7px 13px; border-radius: 8px; border: 1px solid var(--line); background: transparent; color: var(--ink); cursor: pointer; text-decoration: none; white-space: nowrap; }
  .button.primary, button.primary { background: var(--accent); border-color: var(--accent); color: var(--accent-ink); }
  button.danger { color: var(--bad); border-color: color-mix(in srgb, var(--bad) 45%, var(--line)); }
  .button.small, button.small { padding: 3px 9px; font-size: .84rem; font-weight: 500; }
  .page:not(.narrow) form > button { justify-self: start; }
  input:focus-visible, select:focus-visible, button:focus-visible, .button:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
  .error { color: var(--bad); font-weight: 500; }
  .notice { border-left: 4px solid var(--ok); padding: 10px 14px; background: color-mix(in srgb, var(--ok) 9%, var(--surface)); border-radius: 8px; }
  .notice.bad { border-left-color: var(--bad); background: color-mix(in srgb, var(--bad) 8%, var(--surface)); }
  code, pre { font-family: ui-monospace, "Cascadia Mono", Consolas, monospace; }
  code { background: var(--code); padding: 1px 6px; border-radius: 4px; font-size: .9em; overflow-wrap: anywhere; }
  pre.codes { margin: 0; padding: 12px 14px; background: var(--code); border-radius: 10px; font-size: .95rem; line-height: 1.8; columns: 2; column-gap: 20px; overflow-x: auto; }
  @media (max-width: 440px) { pre.codes { columns: 1; } }
  .qr { justify-self: center; background: #fff; padding: 6px; border-radius: 8px; line-height: 0; }
  .qr svg { width: min(240px, 70vw); height: auto; }
  code.secret { display: block; padding: 8px 10px; font-size: 1rem; letter-spacing: .05em; }
  ol { margin: 0; padding-left: 1.3em; display: grid; gap: 4px; }
  .row { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; }
  .table { overflow-x: auto; }
  table { border-collapse: collapse; width: 100%; font-size: .9rem; }
  th, td { text-align: left; padding: 9px 10px; border-bottom: 1px solid var(--line); vertical-align: middle; }
  tr:last-child td { border-bottom: 0; }
  th { font-weight: 600; color: var(--muted); font-size: .78rem; text-transform: uppercase; letter-spacing: .04em; }
  td.actions { display: flex; flex-wrap: wrap; gap: 6px; }
  .tag { display: inline-block; padding: 1px 8px; border-radius: 999px; border: 1px solid var(--line); color: var(--muted); font-size: .78rem; font-weight: 500; }
  .tag.ok { color: var(--ok); border-color: color-mix(in srgb, var(--ok) 45%, var(--line)); }
  .grid2 { display: grid; gap: 18px; grid-template-columns: repeat(auto-fit, minmax(280px, 1fr)); align-items: start; }
  .link-box { display: grid; gap: 8px; }
  .link-box input { font-family: ui-monospace, Consolas, monospace; font-size: .85rem; }
`;

export function shell(title: string, body: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)} · Delve</title>
<link rel="icon" href="/favicon.svg" type="image/svg+xml">
<style>${CSS}</style></head><body>${body}</body></html>`;
}

const errorLine = (error?: string): string => (error ? `<p class="error" role="alert">${esc(error)}</p>` : '');
const noticeLine = (notice?: string, bad = false): string => (notice ? `<p class="notice${bad ? ' bad' : ''}" role="status">${esc(notice)}</p>` : '');

export function when(ms: number | null): string {
  if (ms === null) return 'never';
  return new Date(ms).toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short' });
}

/** "Firefox on Windows" from a User-Agent header, roughly. */
export function device(ua: string): string {
  const browser = /Edg\//.test(ua) ? 'Edge' : /OPR\//.test(ua) ? 'Opera' : /Firefox\//.test(ua) ? 'Firefox' : /Chrome\//.test(ua) ? 'Chrome' : /Safari\//.test(ua) ? 'Safari' : '';
  const os = /Android/.test(ua) ? 'Android' : /iPhone|iPad/.test(ua) ? 'iOS' : /Windows/.test(ua) ? 'Windows' : /Mac OS X/.test(ua) ? 'macOS' : /Linux/.test(ua) ? 'Linux' : '';
  if (browser && os) return `${browser} on ${os}`;
  return browser || os || (ua ? ua.slice(0, 40) : 'Unknown device');
}

// ---------- login ----------

export function loginPage(o: { next: string; error?: string; name?: string }): string {
  return shell(
    'Log in',
    `<main class="page narrow"><div class="card">
<h1>Delve</h1><p class="muted">Log in to edit maps.</p>${errorLine(o.error)}
<form method="post" action="/login"><input type="hidden" name="next" value="${esc(o.next)}">
<label>Name <input type="text" name="name" value="${esc(o.name ?? '')}" autocomplete="username" autocapitalize="none" spellcheck="false" required${o.name ? '' : ' autofocus'}></label>
<label>Password <input type="password" name="password" autocomplete="current-password" required${o.name ? ' autofocus' : ''}></label>
<label>Code from your authenticator app <input type="text" class="code" name="code" inputmode="numeric" autocomplete="one-time-code" autocapitalize="characters" spellcheck="false" maxlength="24"></label>
<p class="hint">Lost your phone? Enter one of your recovery codes instead. Leave it empty if your account has no authenticator.</p>
<label class="check"><input type="checkbox" name="remember" value="1"> Keep me logged in on this device</label>
<button class="primary" type="submit">Log in</button></form></div></main>`,
  );
}

export function legacyLoginPage(o: { next: string; error?: string }): string {
  return shell(
    'Log in',
    `<main class="page narrow"><div class="card">
<h1>Delve</h1><p class="muted">Log in to edit maps.</p>${errorLine(o.error)}
<form method="post" action="/login"><input type="hidden" name="next" value="${esc(o.next)}">
<label>Editor password <input type="password" name="password" autocomplete="current-password" required autofocus></label>
<button class="primary" type="submit">Log in</button></form></div></main>`,
  );
}

export function messagePage(title: string, lines: string[], links: { href: string; text: string }[] = [{ href: '/', text: 'Back to Delve' }]): string {
  return shell(
    title,
    `<main class="page narrow"><div class="card"><h1>${esc(title)}</h1>${lines.map((l) => `<p>${esc(l)}</p>`).join('')}
<p class="row">${links.map((l, i) => `<a class="button${i === 0 ? ' primary' : ''}" href="${esc(l.href)}">${esc(l.text)}</a>`).join('')}</p></div></main>`,
  );
}

// ---------- setup ----------

const passwordFields = (autofocus: boolean): string => `
<label>Password <input type="password" name="password" autocomplete="new-password" minlength="${MIN_PASSWORD}" required${autofocus ? ' autofocus' : ''}></label>
<label>Same password again <input type="password" name="password2" autocomplete="new-password" minlength="${MIN_PASSWORD}" required></label>
<p class="hint">At least ${MIN_PASSWORD} characters. A few unrelated words work well.</p>`;

export function bootstrapPage(o: { error?: string; name?: string }): string {
  return shell(
    'Create your admin account',
    `<main class="page narrow"><div class="card">
<h1>Create your admin account</h1>
<p>Right now anyone with the shared editor password can edit. An admin account has its own name and password plus a code from an authenticator app on your phone.</p>
<p class="muted">Once it is set up, the shared password stops working and everyone logged in with it is logged out. From your admin page you can then invite GMs.</p>
${errorLine(o.error)}
<form method="post" action="/account/setup">
<label>Your name <input type="text" name="name" value="${esc(o.name ?? '')}" autocomplete="username" maxlength="32" required${o.name ? '' : ' autofocus'}></label>
${passwordFields(Boolean(o.name))}
<button class="primary" type="submit">Next: authenticator app</button></form></div></main>`,
  );
}

export function setupPasswordPage(o: { token: string; name: string; reset: boolean; passwordOnly?: boolean; error?: string }): string {
  const next = o.passwordOnly
    ? `${o.reset ? 'Choose a new password.' : 'Choose a password.'} Your account logs in with name and password only, so make it long: anyone who knows it can log in as you.`
    : o.reset
      ? 'Choose a new password, then set up your authenticator app again.'
      : 'Choose a password, then set up an authenticator app on your phone.';
  return shell(
    'Set up your account',
    `<main class="page narrow"><div class="card">
<h1>${o.reset ? 'Set up your login again' : 'Welcome to Delve'}</h1>
<p>Your account name is <strong>${esc(o.name)}</strong>. ${next}</p>
${errorLine(o.error)}
<form method="post" action="/account/setup"><input type="hidden" name="token" value="${esc(o.token)}"><input type="hidden" name="step" value="password">
<input type="text" name="username" value="${esc(o.name)}" autocomplete="username" hidden>
${passwordFields(true)}
${o.passwordOnly ? '<label class="check"><input type="checkbox" name="remember" value="1"> Keep me logged in on this device</label>\n<button class="primary" type="submit">Save password and log in</button>' : '<button class="primary" type="submit">Next: authenticator app</button>'}</form></div></main>`,
  );
}

export function setupCodePage(o: { token: string; name: string; qr: string; secret: string; error?: string; authenticatorOnly: boolean; turningOn?: boolean }): string {
  const about = o.turningOn
    ? '. Once it is confirmed, you log in with your password and a code from the app.'
    : o.authenticatorOnly
      ? '. Your old authenticator keeps working until this one is confirmed.'
      : '.';
  return shell(
    'Set up your authenticator',
    `<main class="page narrow"><div class="card">
<h1>Set up your authenticator</h1>
<p>Account <strong>${esc(o.name)}</strong>${about}</p>
<ol>
<li>Open an authenticator app on your phone, for example Google Authenticator, Microsoft Authenticator, Aegis or 2FAS.</li>
<li>Add an account and scan this code.</li>
<li>Type the 6-digit code the app shows.</li>
</ol>
<div class="qr">${o.qr}</div>
<p class="hint">Can't scan it? Add the account by hand with this key (time-based):</p>
<p><code class="secret">${esc(o.secret)}</code></p>
${errorLine(o.error)}
<form method="post" action="/account/setup"><input type="hidden" name="token" value="${esc(o.token)}"><input type="hidden" name="step" value="code">
<label>6-digit code <input type="text" class="code" name="code" inputmode="numeric" autocomplete="one-time-code" pattern="[0-9 ]{6,7}" maxlength="7" required autofocus></label>
${o.authenticatorOnly ? '' : '<label class="check"><input type="checkbox" name="remember" value="1"> Keep me logged in on this device</label>'}
<button class="primary" type="submit">Confirm</button></form></div></main>`,
  );
}

/** `replaced`: there were codes before, which stop working (default: when it isn't the first setup). */
export function recoveryCodesPage(o: { codes: string[]; next: string; first: boolean; replaced?: boolean }): string {
  const replaced = o.replaced ?? !o.first;
  const text = o.codes.join('\n');
  const file = `data:text/plain;charset=utf-8,${encodeURIComponent(`Delve recovery codes. Each one works once.\n\n${text}\n`)}`;
  return shell(
    'Your recovery codes',
    `<main class="page narrow"><div class="card">
<h1>Your recovery codes</h1>
${o.first ? '<p class="notice" role="status">Your account is ready and you are logged in.</p>' : ''}
<p>If you lose your phone, each of these codes lets you log in once in place of a code from the app. Save them somewhere safe now, for example in a password manager or on paper.</p>
<p><strong>Delve shows them only this once.</strong>${replaced ? ' Your old recovery codes no longer work.' : ''}</p>
<pre class="codes" id="codes">${esc(text)}</pre>
<p class="row"><button type="button" id="copy">Copy</button><a class="button" href="${esc(file)}" download="delve-recovery-codes.txt">Download as a text file</a></p>
<p><a class="button primary" href="${esc(o.next)}">I saved them, continue</a></p></div></main>
<script>
  document.getElementById('copy').addEventListener('click', async (e) => {
    try { await navigator.clipboard.writeText(document.getElementById('codes').textContent); e.target.textContent = 'Copied'; }
    catch { e.target.textContent = 'Copy failed: select the codes by hand'; }
  });
</script>`,
  );
}

// ---------- the account page ----------

function sessionRows(sessions: Session[], currentId: string, action: string, showUser: boolean): string {
  if (!sessions.length) return `<p class="muted">No sessions.</p>`;
  const rows = sessions
    .map(
      (s) => `<tr><td>${showUser ? `<strong>${esc(s.userName)}</strong><br>` : ''}<span title="${esc(s.userAgent)}">${esc(device(s.userAgent))}</span>${s.id === currentId ? ' <span class="tag ok">this device</span>' : ''}</td>
<td>${esc(when(s.created))}</td><td>${esc(when(s.lastSeen))}</td><td>${s.remember ? 'yes' : 'no'}</td>
<td>${s.id === currentId ? '' : `<form class="inline" method="post" action="${action}"><input type="hidden" name="action" value="end-session"><input type="hidden" name="session" value="${esc(s.id)}"><button class="small" type="submit">End</button></form>`}</td></tr>`,
    )
    .join('');
  return `<div class="table"><table><thead><tr><th>Device</th><th>Logged in</th><th>Last active</th><th>Kept logged in</th><th></th></tr></thead><tbody>${rows}</tbody></table></div>`;
}

const topBar = (links: string): string =>
  `<div class="top"><h1><a href="/">Delve</a></h1><span class="spacer"></span>${links}<form class="inline" method="post" action="/logout"><button type="submit">Log out</button></form></div>`;

export function accountPage(o: { user: User; session: Session; sessions: Session[]; notice?: string; error?: string }): string {
  const u = o.user;
  const admin = u.role === 'admin' ? '<a class="button" href="/admin">Admin</a>' : '';
  const facts = u.passwordOnly ? 'password only, no authenticator' : `${u.recoveryLeft} recovery code${u.recoveryLeft === 1 ? '' : 's'} left`;
  const turnOn = `<div class="card"><h2>Authenticator app</h2>
<p>Your account logs in with name and password only. With an authenticator app on your phone, a stolen password alone is no longer enough.</p>
<form method="post" action="/account"><input type="hidden" name="action" value="authenticator">
<input type="text" name="username" value="${esc(u.name)}" autocomplete="username" hidden>
<label>Current password <input type="password" name="current" autocomplete="current-password" required></label>
<button type="submit">Set up an authenticator</button></form></div>`;
  return shell(
    'Your account',
    `<main class="page">
${topBar(`<a class="button" href="/">Maps</a>${admin}`)}
<div class="card"><h2>${esc(u.name)}</h2>
<p class="muted">${u.role === 'admin' ? 'Admin' : 'GM'} · last login ${esc(when(u.lastLogin))} · ${facts}</p>
${noticeLine(o.notice)}${o.error ? noticeLine(o.error, true) : ''}</div>
<div class="grid2">
<div class="card"><h2>Change password</h2>
<form method="post" action="/account"><input type="hidden" name="action" value="password">
<input type="text" name="username" value="${esc(u.name)}" autocomplete="username" hidden>
<label>Current password <input type="password" name="current" autocomplete="current-password" required></label>
<label>New password <input type="password" name="password" autocomplete="new-password" minlength="${MIN_PASSWORD}" required></label>
<label>New password again <input type="password" name="password2" autocomplete="new-password" minlength="${MIN_PASSWORD}" required></label>
${u.passwordOnly ? '' : '<label>Code from your authenticator app <input type="text" class="code" name="code" inputmode="numeric" autocomplete="one-time-code" required maxlength="24"></label>\n'}<p class="hint">Your other devices are logged out afterwards.</p>
<button class="primary" type="submit">Change password</button></form></div>
${
  u.passwordOnly
    ? turnOn
    : `<div class="card"><h2>Recovery codes</h2>
<p>Make 10 new codes. The old ones stop working.</p>
<form method="post" action="/account"><input type="hidden" name="action" value="recovery">
<label>Code from your authenticator app <input type="text" class="code" name="code" inputmode="numeric" autocomplete="one-time-code" required maxlength="24"></label>
<button type="submit">Make new recovery codes</button></form></div>
<div class="card"><h2>New phone?</h2>
<p>Set up a new authenticator app. The old one keeps working until the new one is confirmed.</p>
<form method="post" action="/account"><input type="hidden" name="action" value="authenticator">
<input type="text" name="username" value="${esc(u.name)}" autocomplete="username" hidden>
<label>Current password <input type="password" name="current" autocomplete="current-password" required></label>
<label>Code from your authenticator app, or a recovery code <input type="text" class="code" name="code" autocomplete="one-time-code" required maxlength="24"></label>
<button type="submit">Set up a new authenticator</button></form></div>`
}
</div>
<div class="card"><h2>Where you are logged in</h2>
${sessionRows(o.sessions, o.session.id, '/account', false)}
${o.sessions.length > 1 ? `<form method="post" action="/account"><input type="hidden" name="action" value="end-others"><p><button type="submit">Log out all other devices</button></p></form>` : ''}
</div>
</main>`,
  );
}

// ---------- the admin page ----------

function status(u: User, now: number): string {
  if (u.active) return '<span class="tag ok">active</span>';
  if (u.linkExpires !== null && u.linkExpires > now) return `<span class="tag">waiting for setup</span><br><span class="hint">link valid until ${esc(when(u.linkExpires))}</span>`;
  return '<span class="tag">no valid setup link</span>';
}

function accountRows(users: User[], me: User, now: number): string {
  return users
    .map((u) => {
      const self = u.id === me.id;
      const hidden = `<input type="hidden" name="user" value="${u.id}">`;
      const other = u.role === 'admin' ? 'gm' : 'admin';
      const actions = self
        ? '<a class="button small" href="/account">Your account</a>'
        : [
            u.passwordOnly
              ? `<form class="inline" method="post" action="/admin" data-confirm="Require an authenticator app for ${esc(u.name)}? Their login is reset: they are logged out and set up a new password and the app with the new setup link.">${hidden}<input type="hidden" name="action" value="require-authenticator"><button class="small" type="submit">Require authenticator</button></form>`
              : `<form class="inline" method="post" action="/admin">${hidden}<input type="hidden" name="action" value="role"><input type="hidden" name="role" value="${other}"><button class="small" type="submit">Make ${other === 'admin' ? 'admin' : 'GM'}</button></form>`,
            `<form class="inline" method="post" action="/admin"${u.active ? ` data-confirm="Reset the login of ${esc(u.name)}? They are logged out and can only log in again with the new setup link."` : ''}>${hidden}<input type="hidden" name="action" value="link"><button class="small" type="submit">${u.active ? 'Reset login' : 'New setup link'}</button></form>`,
            `<form class="inline" method="post" action="/admin">${hidden}<input type="hidden" name="action" value="end-user-sessions"><button class="small" type="submit">Log out everywhere</button></form>`,
            `<form class="inline" method="post" action="/admin" data-confirm="Remove the account ${esc(u.name)}?">${hidden}<input type="hidden" name="action" value="remove"><button class="small danger" type="submit">Remove</button></form>`,
          ].join('');
      return `<tr><td><strong>${esc(u.name)}</strong>${self ? ' <span class="tag ok">you</span>' : ''}</td><td>${u.role === 'admin' ? 'Admin' : 'GM'}${u.passwordOnly ? ' <span class="tag">password only</span>' : ''}</td><td>${status(u, now)}</td><td>${esc(when(u.lastLogin))}</td><td class="actions">${actions}</td></tr>`;
    })
    .join('');
}

export interface NewLink {
  name: string;
  url: string;
  expires: number;
  reset: boolean;
  passwordOnly?: boolean;
}

export function adminPage(o: { me: User; session: Session; users: User[]; sessions: Session[]; now: number; newLink?: NewLink; notice?: string; error?: string }): string {
  const link = o.newLink
    ? `<div class="card link-box"><h2>Setup link for ${esc(o.newLink.name)}</h2>
<p>Send this link to ${esc(o.newLink.name)}, for example in a private message. It works once, until ${esc(when(o.newLink.expires))}. With it they choose their own password${o.newLink.passwordOnly ? '' : ' and set up their authenticator app'}.${o.newLink.reset ? ' Their old login no longer works.' : ''}</p>
<input type="text" readonly value="${esc(o.newLink.url)}" onfocus="this.select()" aria-label="Setup link">
<p class="row"><button type="button" class="primary" id="copy-link">Copy link</button><span class="hint">Delve shows this link only now. If it gets lost, make a new one.</span></p>
<script>document.getElementById('copy-link').addEventListener('click', async (e) => { try { await navigator.clipboard.writeText(${JSON.stringify(o.newLink.url).replace(/</g, '\\u003c')}); e.target.textContent = 'Copied'; } catch { e.target.textContent = 'Select the link and copy it'; } });</script></div>`
    : '';
  return shell(
    'Admin',
    `<main class="page">
${topBar('<a class="button" href="/">Maps</a><a class="button" href="/account">Your account</a>')}
<div class="card"><h2>Admin</h2>
<p class="muted">Admins and GMs can edit maps and run games. Only admins can open this page. The shared editor password is switched off.</p>
${noticeLine(o.notice)}${o.error ? noticeLine(o.error, true) : ''}</div>
${link}
<div class="card"><h2>Accounts</h2>
<div class="table"><table><thead><tr><th>Name</th><th>Role</th><th>Status</th><th>Last login</th><th></th></tr></thead><tbody>${accountRows(o.users, o.me, o.now)}</tbody></table></div>
<form method="post" action="/admin" class="row"><input type="hidden" name="action" value="create">
<label>Name <input type="text" name="name" maxlength="32" required autocomplete="off"></label>
<label>Role <select name="role"><option value="gm" selected>GM</option><option value="admin">Admin</option></select></label>
<label class="check" style="align-self:end"><input type="checkbox" name="password_only" value="1"> Password only (GMs, no authenticator app)</label>
<button class="primary" type="submit" style="align-self:end">Add account</button></form>
<p class="hint">Adding an account makes a setup link that is valid for ${LINK_MS / 3_600_000} hours. A password-only account is less safe: anyone who learns its password can log in, from anywhere. Admin accounts always need the app.</p></div>
<div class="card"><h2>Sessions</h2>
${sessionRows(o.sessions, o.session.id, '/admin', true)}
${o.sessions.length > 1 ? `<form method="post" action="/admin" data-confirm="Log out everyone except you?"><input type="hidden" name="action" value="end-all"><p><button type="submit">Log out everyone except me</button></p></form>` : ''}
</div>
</main>
<script>
  document.querySelectorAll('form[data-confirm]').forEach((f) => f.addEventListener('submit', (e) => { if (!confirm(f.dataset.confirm)) e.preventDefault(); }));
</script>`,
  );
}
