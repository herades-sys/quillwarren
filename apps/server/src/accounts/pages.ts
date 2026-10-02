// HTML for the login and account pages, built on the shared look (@delve/ui:
// tokens, components, theme). Every value that came from a person is escaped.
import { esc, htmlDocument, icon, themeSwitch } from '@delve/ui';
import { LINK_MS, MIN_PASSWORD, type Session, type User } from './store.ts';

export { esc };

// Only what the account pages need beyond the shared components.
const CSS = `<style>
  .auth-corner { position: absolute; top: var(--space-4); right: var(--space-4); }
  .auth-card { background: var(--color-surface); border-radius: var(--radius-lg); box-shadow: var(--shadow-sm); padding: 28px 28px 24px; display: flex; flex-direction: column; gap: var(--space-5); min-width: 0; }
  .auth-brand { font-family: var(--font-display); font-weight: 400; font-size: var(--display-lg); line-height: 1; margin: 0; }
  .auth-title { font-family: var(--font-display); font-weight: 400; font-size: var(--display-md); line-height: var(--leading-tight); margin: 0; }
  .auth-card p, .panel p { margin: 0; }
  .form { display: flex; flex-direction: column; gap: 14px; margin: 0; }
  .form.inline, form.inline { display: inline; }
  .form > .btn { align-self: flex-start; }
  .auth-card .form > .btn { align-self: stretch; }
  .input.code { font-family: var(--font-mono); letter-spacing: .08em; }
  p.error { padding: 9px 12px; border-radius: 10px; background: var(--tint-danger-bg); color: var(--tint-danger-fg); }
  ol.steps { margin: 0; padding-left: 1.3em; display: flex; flex-direction: column; gap: 4px; }
  .qr { align-self: center; background: #fff; padding: 8px; border-radius: var(--radius-md); line-height: 0; box-shadow: var(--shadow-sm); }
  .qr svg { width: min(240px, 70vw); height: auto; }
  code.secret { display: block; padding: 8px 10px; font-size: 15px; letter-spacing: .05em; border-radius: var(--radius-md); background: var(--color-surface-2); box-shadow: inset 0 0 0 1px var(--color-border-strong); overflow-wrap: anywhere; }
  pre.codes { margin: 0; padding: 12px 14px; border-radius: 10px; background: var(--color-surface-2); box-shadow: inset 0 0 0 1px var(--color-border-strong); font-size: 15px; line-height: 1.8; columns: 2; column-gap: 20px; overflow-x: auto; }
  @media (max-width: 440px) { pre.codes { columns: 1; } }
  .acct-head { display: flex; align-items: center; gap: var(--space-5); flex-wrap: wrap; }
  .acct-head > div { display: flex; flex-direction: column; gap: 4px; min-width: 0; }
  .cards { display: grid; gap: var(--space-6); grid-template-columns: repeat(auto-fit, minmax(300px, 1fr)); align-items: start; }
  td.actions { display: flex; flex-wrap: wrap; gap: 6px; justify-content: flex-end; }
  .add-row { display: flex; flex-wrap: wrap; gap: var(--space-4); align-items: flex-end; }
  .add-row .field { min-width: 160px; }
  .add-row .check { min-height: 30px; }
  .link-input { font-family: var(--font-mono); font-size: 13px; }
  @media (max-width: 640px) {
    .auth-card { padding: 22px 18px 20px; }
    .auth-corner { position: static; display: flex; justify-content: flex-end; padding: var(--space-4) var(--space-4) 0; }
    .topbar .crumb, .topbar .crumb-sep, .topbar .crumb-title, .topbar-brand + .vsep { display: none; }
    .topbar .btn-plain { width: var(--control-md); padding: 0; }
    .topbar .btn-label { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; }
  }
</style>`;

export function shell(title: string, body: string): string {
  return htmlDocument({ title, body, extra: CSS });
}

const errorLine = (error?: string): string => (error ? `<p class="error" role="alert">${esc(error)}</p>` : '');
const noticeLine = (notice?: string, bad = false): string =>
  notice ? `<p class="notice ${bad ? 'notice-danger' : 'notice-ok'}" role="status">${icon(bad ? 'alert' : 'check', { size: 16 })}<span>${esc(notice)}</span></p>` : '';

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

/** "AN" for Ana, "MV" for Mara Venn. */
export function initials(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  const s = words.length > 1 ? words[0]![0]! + words[1]![0]! : (words[0] ?? '?').slice(0, 2);
  return s.toUpperCase();
}

// ---------- form parts ----------

/** Fields with ids unique within one page. */
function formKit() {
  let n = 0;
  return {
    /** `attrs`: the input's attributes after id and class (type, name, autocomplete…). */
    field(label: string, attrs: string, o: { hint?: string; code?: boolean } = {}): string {
      const id = `f${++n}`;
      const hint = o.hint ? ` aria-describedby="${id}-hint"` : '';
      return `<div class="field"><label for="${id}">${label}</label><input id="${id}" class="input input-lg${o.code ? ' code' : ''}" ${attrs}${hint}>${o.hint ? `<span class="field-hint" id="${id}-hint">${o.hint}</span>` : ''}</div>`;
    },
  };
}

const check = (label: string, name: string): string =>
  `<label class="check"><input type="checkbox" name="${name}" value="1"><span class="box">${icon('check', { size: 12, stroke: 2.8 })}</span>${label}</label>`;
const remember = check('Keep me logged in on this device', 'remember');

/** The narrow card the login and setup pages share. */
const authPage = (inner: string): string => `<div class="auth-corner">${themeSwitch()}</div><main class="page page-narrow"><div class="auth-card">${inner}</div></main>`;

// ---------- login ----------

export function loginPage(o: { next: string; error?: string; name?: string }): string {
  const f = formKit();
  return shell(
    'Log in',
    authPage(`<div class="stack" style="gap:6px"><h1 class="auth-brand">Delve</h1><p class="text-muted">Log in to edit maps.</p></div>${errorLine(o.error)}
<form class="form" method="post" action="/login"><input type="hidden" name="next" value="${esc(o.next)}">
${f.field('Name', `type="text" name="name" value="${esc(o.name ?? '')}" autocomplete="username" autocapitalize="none" spellcheck="false" required${o.name ? '' : ' autofocus'}`)}
${f.field('Password', `type="password" name="password" autocomplete="current-password" required${o.name ? ' autofocus' : ''}`)}
${f.field('Code from your authenticator app', 'type="text" name="code" inputmode="numeric" autocomplete="one-time-code" autocapitalize="characters" spellcheck="false" maxlength="24"', { code: true, hint: 'Lost your phone? Enter one of your recovery codes instead. Leave it empty if your account has no authenticator.' })}
${remember}
<button class="btn btn-primary btn-lg" type="submit">Log in</button></form>`),
  );
}

export function legacyLoginPage(o: { next: string; error?: string }): string {
  const f = formKit();
  return shell(
    'Log in',
    authPage(`<div class="stack" style="gap:6px"><h1 class="auth-brand">Delve</h1><p class="text-muted">Log in to edit maps.</p></div>${errorLine(o.error)}
<form class="form" method="post" action="/login"><input type="hidden" name="next" value="${esc(o.next)}">
${f.field('Editor password', 'type="password" name="password" autocomplete="current-password" required autofocus')}
<button class="btn btn-primary btn-lg" type="submit">Log in</button></form>`),
  );
}

export function messagePage(title: string, lines: string[], links: { href: string; text: string }[] = [{ href: '/', text: 'Back to Delve' }]): string {
  return shell(
    title,
    authPage(`<h1 class="auth-title">${esc(title)}</h1>${lines.map((l) => `<p>${esc(l)}</p>`).join('')}
<p class="row">${links.map((l, i) => `<a class="btn ${i === 0 ? 'btn-primary' : 'btn-secondary'}" href="${esc(l.href)}">${esc(l.text)}</a>`).join('')}</p>`),
  );
}

// ---------- setup ----------

const passwordFields = (f: ReturnType<typeof formKit>, autofocus: boolean): string => `
${f.field('Password', `type="password" name="password" autocomplete="new-password" minlength="${MIN_PASSWORD}" required${autofocus ? ' autofocus' : ''}`)}
${f.field('Same password again', `type="password" name="password2" autocomplete="new-password" minlength="${MIN_PASSWORD}" required`, { hint: `At least ${MIN_PASSWORD} characters. A few unrelated words work well.` })}`;

export function bootstrapPage(o: { error?: string; name?: string }): string {
  const f = formKit();
  return shell(
    'Create your admin account',
    authPage(`<h1 class="auth-title">Create your admin account</h1>
<p>Right now anyone with the shared editor password can edit. An admin account has its own name and password plus a code from an authenticator app on your phone.</p>
<p class="text-muted">Once it is set up, the shared password stops working and everyone logged in with it is logged out. From your admin page you can then invite GMs.</p>
${errorLine(o.error)}
<form class="form" method="post" action="/account/setup">
${f.field('Your name', `type="text" name="name" value="${esc(o.name ?? '')}" autocomplete="username" maxlength="32" required${o.name ? '' : ' autofocus'}`)}
${passwordFields(f, Boolean(o.name))}
<button class="btn btn-primary btn-lg" type="submit">Next: authenticator app</button></form>`),
  );
}

export function setupPasswordPage(o: { token: string; name: string; reset: boolean; passwordOnly?: boolean; error?: string }): string {
  const f = formKit();
  const next = o.passwordOnly
    ? `${o.reset ? 'Choose a new password.' : 'Choose a password.'} Your account logs in with name and password only, so make it long: anyone who knows it can log in as you.`
    : o.reset
      ? 'Choose a new password, then set up your authenticator app again.'
      : 'Choose a password, then set up an authenticator app on your phone.';
  return shell(
    'Set up your account',
    authPage(`<h1 class="auth-title">${o.reset ? 'Set up your login again' : 'Welcome to Delve'}</h1>
<p>Your account name is <strong>${esc(o.name)}</strong>. ${next}</p>
${errorLine(o.error)}
<form class="form" method="post" action="/account/setup"><input type="hidden" name="token" value="${esc(o.token)}"><input type="hidden" name="step" value="password">
<input type="text" name="username" value="${esc(o.name)}" autocomplete="username" hidden>
${passwordFields(f, true)}
${o.passwordOnly ? `${remember}\n<button class="btn btn-primary btn-lg" type="submit">Save password and log in</button>` : '<button class="btn btn-primary btn-lg" type="submit">Next: authenticator app</button>'}</form>`),
  );
}

export function setupCodePage(o: { token: string; name: string; qr: string; secret: string; error?: string; authenticatorOnly: boolean; turningOn?: boolean }): string {
  const f = formKit();
  const about = o.turningOn
    ? '. Once it is confirmed, you log in with your password and a code from the app.'
    : o.authenticatorOnly
      ? '. Your old authenticator keeps working until this one is confirmed.'
      : '.';
  return shell(
    'Set up your authenticator',
    authPage(`<h1 class="auth-title">Set up your authenticator</h1>
<p>Account <strong>${esc(o.name)}</strong>${about}</p>
<ol class="steps">
<li>Open an authenticator app on your phone, for example Google Authenticator, Microsoft Authenticator, Aegis or 2FAS.</li>
<li>Add an account and scan this code.</li>
<li>Type the 6-digit code the app shows.</li>
</ol>
<div class="qr">${o.qr}</div>
<p class="text-muted">Can't scan it? Add the account by hand with this key (time-based):</p>
<p><code class="secret">${esc(o.secret)}</code></p>
${errorLine(o.error)}
<form class="form" method="post" action="/account/setup"><input type="hidden" name="token" value="${esc(o.token)}"><input type="hidden" name="step" value="code">
${f.field('6-digit code', 'type="text" name="code" inputmode="numeric" autocomplete="one-time-code" pattern="[0-9 ]{6,7}" maxlength="7" required autofocus', { code: true })}
${o.authenticatorOnly ? '' : remember}
<button class="btn btn-primary btn-lg" type="submit">Confirm</button></form>`),
  );
}

/** `replaced`: there were codes before, which stop working (default: when it isn't the first setup). */
export function recoveryCodesPage(o: { codes: string[]; next: string; first: boolean; replaced?: boolean }): string {
  const replaced = o.replaced ?? !o.first;
  const text = o.codes.join('\n');
  const file = `data:text/plain;charset=utf-8,${encodeURIComponent(`Delve recovery codes. Each one works once.\n\n${text}\n`)}`;
  return shell(
    'Your recovery codes',
    authPage(`<h1 class="auth-title">Your recovery codes</h1>
${o.first ? noticeLine('Your account is ready and you are logged in.') : ''}
<p>If you lose your phone, each of these codes lets you log in once in place of a code from the app. Save them somewhere safe now, for example in a password manager or on paper.</p>
<p><strong>Delve shows them only this once.</strong>${replaced ? ' Your old recovery codes no longer work.' : ''}</p>
<pre class="codes" id="codes">${esc(text)}</pre>
<p class="row"><button class="btn btn-secondary" type="button" id="copy">${icon('copy', { size: 15 })}Copy</button><a class="btn btn-secondary" href="${esc(file)}" download="delve-recovery-codes.txt">${icon('download', { size: 15 })}Download as a text file</a></p>
<a class="btn btn-primary btn-lg btn-block" href="${esc(o.next)}">I saved them, continue</a>`) +
      `<script>
  document.getElementById('copy').addEventListener('click', async (e) => {
    const b = e.currentTarget;
    try { await navigator.clipboard.writeText(document.getElementById('codes').textContent); b.textContent = 'Copied'; }
    catch { b.textContent = 'Copy failed: select the codes by hand'; }
  });
</script>`,
  );
}

// ---------- the account and admin pages ----------

/** The app's top bar: Delve › Library › this page, then the theme, links, who you are and Log out. */
function topBar(page: string, user: User, links: { href: string; text: string; icon: 'admin' | 'users' }[]): string {
  // On phones only the icons show; the text stays for screen readers.
  const nav = links
    .map((l) => `<a class="btn btn-plain" href="${esc(l.href)}" title="${esc(l.text)}">${icon(l.icon, { size: 16 })}<span class="btn-label">${esc(l.text)}</span></a>`)
    .join('');
  return `<header class="topbar"><a class="topbar-brand" href="/">Delve</a><span class="vsep"></span><a class="crumb" href="/">Library</a>${icon('chevron-right', { size: 14, className: 'crumb-sep' })}<span class="crumb-title">${esc(page)}</span>
<div class="topbar-end">${themeSwitch()}<span class="vsep" style="margin:0 4px"></span>${nav}<span class="avatar" title="${esc(user.name)} · ${user.role === 'admin' ? 'Admin' : 'GM'}" style="margin:0 4px">${esc(initials(user.name))}</span><form class="inline" method="post" action="/logout"><button class="btn btn-ghost" type="submit">Log out</button></form></div></header>`;
}

function sessionRows(sessions: Session[], currentId: string, action: string, showUser: boolean): string {
  if (!sessions.length) return `<p class="text-muted">No sessions.</p>`;
  const rows = sessions
    .map(
      (s) => `<tr><td>${showUser ? `<strong>${esc(s.userName)}</strong><br>` : ''}<span title="${esc(s.userAgent)}">${esc(device(s.userAgent))}</span>${s.id === currentId ? ' <span class="tag tag-accent tag-sm">this device</span>' : ''}</td>
<td class="text-muted">${esc(when(s.created))}</td><td class="text-muted">${esc(when(s.lastSeen))}</td><td class="text-muted">${s.remember ? 'yes' : 'no'}</td>
<td class="end">${s.id === currentId ? '' : `<form class="inline" method="post" action="${action}"><input type="hidden" name="action" value="end-session"><input type="hidden" name="session" value="${esc(s.id)}"><button class="btn btn-secondary btn-sm" type="submit">End</button></form>`}</td></tr>`,
    )
    .join('');
  return `<div class="table-wrap"><table class="table"><thead><tr><th>Device</th><th>Logged in</th><th>Last active</th><th>Kept logged in</th><th></th></tr></thead><tbody>${rows}</tbody></table></div>`;
}

export function accountPage(o: { user: User; session: Session; sessions: Session[]; notice?: string; error?: string }): string {
  const u = o.user;
  const f = formKit();
  const links = u.role === 'admin' ? [{ href: '/admin', text: 'Admin', icon: 'admin' as const }] : [];
  const facts = u.passwordOnly ? 'password only, no authenticator' : `${u.recoveryLeft} recovery code${u.recoveryLeft === 1 ? '' : 's'} left`;
  const username = `<input type="text" name="username" value="${esc(u.name)}" autocomplete="username" hidden>`;
  const codeField = (label: string): string => f.field(label, 'type="text" name="code" inputmode="numeric" autocomplete="one-time-code" required maxlength="24"', { code: true });
  const currentField = (): string => f.field('Current password', 'type="password" name="current" autocomplete="current-password" required');
  const turnOn = `<section class="panel"><h2 class="panel-title">Authenticator app</h2>
<p>Your account logs in with name and password only. With an authenticator app on your phone, a stolen password alone is no longer enough.</p>
<form class="form" method="post" action="/account"><input type="hidden" name="action" value="authenticator">${username}
${currentField()}
<button class="btn btn-primary" type="submit">Set up an authenticator</button></form></section>`;
  return shell(
    'Your account',
    `${topBar('Your account', u, links)}
<main class="page">
<div class="acct-head"><span class="avatar avatar-lg">${esc(initials(u.name))}</span><div><h1 class="display-lg">${esc(u.name)}</h1>
<p class="text-muted">${u.role === 'admin' ? 'Admin' : 'GM'} · last login ${esc(when(u.lastLogin))} · ${facts}</p></div></div>
${noticeLine(o.notice)}${o.error ? noticeLine(o.error, true) : ''}
<div class="cards">
<section class="panel"><h2 class="panel-title">Change password</h2>
<form class="form" method="post" action="/account"><input type="hidden" name="action" value="password">${username}
${currentField()}
${f.field('New password', `type="password" name="password" autocomplete="new-password" minlength="${MIN_PASSWORD}" required`)}
${f.field('New password again', `type="password" name="password2" autocomplete="new-password" minlength="${MIN_PASSWORD}" required`, { hint: 'Your other devices are logged out afterwards.' })}
${u.passwordOnly ? '' : codeField('Code from your authenticator app')}
<button class="btn btn-primary" type="submit">Change password</button></form></section>
${
  u.passwordOnly
    ? turnOn
    : `<section class="panel"><h2 class="panel-title">Recovery codes</h2>
<p class="text-muted">Make 10 new codes. The old ones stop working.</p>
<form class="form" method="post" action="/account"><input type="hidden" name="action" value="recovery">
${codeField('Code from your authenticator app')}
<button class="btn btn-secondary" type="submit">Make new recovery codes</button></form></section>
<section class="panel"><h2 class="panel-title">New phone?</h2>
<p class="text-muted">Set up a new authenticator app. The old one keeps working until the new one is confirmed.</p>
<form class="form" method="post" action="/account"><input type="hidden" name="action" value="authenticator">${username}
${currentField()}
${f.field('Code from your authenticator app, or a recovery code', 'type="text" name="code" autocomplete="one-time-code" required maxlength="24"', { code: true })}
<button class="btn btn-secondary" type="submit">Set up a new authenticator</button></form></section>`
}
</div>
<section class="panel"><h2 class="panel-title">Where you are logged in</h2>
${sessionRows(o.sessions, o.session.id, '/account', false)}
${o.sessions.length > 1 ? `<form class="form" method="post" action="/account"><input type="hidden" name="action" value="end-others"><button class="btn btn-secondary" type="submit">Log out all other devices</button></form>` : ''}
</section>
</main>`,
  );
}

function status(u: User, now: number): string {
  if (u.active) return '<span class="tag tag-neutral"><span class="dot"></span>Active</span>';
  if (u.linkExpires !== null && u.linkExpires > now) return `<span class="tag tag-warning">Waiting for setup</span><br><span class="field-hint">link valid until ${esc(when(u.linkExpires))}</span>`;
  return '<span class="tag tag-outline">No valid setup link</span>';
}

function accountRows(users: User[], me: User, now: number): string {
  return users
    .map((u) => {
      const self = u.id === me.id;
      const hidden = `<input type="hidden" name="user" value="${u.id}">`;
      const other = u.role === 'admin' ? 'gm' : 'admin';
      const actions = self
        ? '<a class="btn btn-secondary btn-sm" href="/account">Your account</a>'
        : [
            u.passwordOnly
              ? `<form class="inline" method="post" action="/admin" data-confirm="Require an authenticator app for ${esc(u.name)}? Their login is reset: they are logged out and set up a new password and the app with the new setup link.">${hidden}<input type="hidden" name="action" value="require-authenticator"><button class="btn btn-secondary btn-sm" type="submit">Require authenticator</button></form>`
              : `<form class="inline" method="post" action="/admin">${hidden}<input type="hidden" name="action" value="role"><input type="hidden" name="role" value="${other}"><button class="btn btn-secondary btn-sm" type="submit">Make ${other === 'admin' ? 'admin' : 'GM'}</button></form>`,
            u.role === 'gm' && !u.passwordOnly
              ? `<form class="inline" method="post" action="/admin" data-confirm="Make ${esc(u.name)} password only? From then on name and password are enough to log in, from anywhere. Their password and sessions stay; their authenticator app and recovery codes stop working.">${hidden}<input type="hidden" name="action" value="make-password-only"><button class="btn btn-secondary btn-sm" type="submit">${icon('lock', { size: 12 })}Password only</button></form>`
              : '',
            `<form class="inline" method="post" action="/admin"${u.active ? ` data-confirm="Reset the login of ${esc(u.name)}? They are logged out and can only log in again with the new setup link."` : ''}>${hidden}<input type="hidden" name="action" value="link"><button class="btn btn-secondary btn-sm" type="submit">${u.active ? 'Reset login' : 'New setup link'}</button></form>`,
            `<form class="inline" method="post" action="/admin">${hidden}<input type="hidden" name="action" value="end-user-sessions"><button class="btn btn-secondary btn-sm" type="submit">Log out everywhere</button></form>`,
            `<form class="inline" method="post" action="/admin" data-confirm="Remove the account ${esc(u.name)}?">${hidden}<input type="hidden" name="action" value="remove"><button class="btn btn-danger btn-sm" type="submit">Remove</button></form>`,
          ].join('');
      const role = u.role === 'admin' ? '<span class="tag tag-accent">Admin</span>' : '<span class="tag tag-outline">GM</span>';
      const passwordOnly = u.passwordOnly ? ` <span class="tag tag-neutral">${icon('lock', { size: 12 })}Password only</span>` : '';
      return `<tr><td><strong>${esc(u.name)}</strong>${self ? ' <span class="tag tag-accent tag-sm">you</span>' : ''}</td><td>${role}${passwordOnly}</td><td>${status(u, now)}</td><td class="text-muted">${esc(when(u.lastLogin))}</td><td class="actions">${actions}</td></tr>`;
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
    ? `<section class="panel"><h2 class="panel-title">Setup link for ${esc(o.newLink.name)}</h2>
<p>Send this link to ${esc(o.newLink.name)}, for example in a private message. It works once, until ${esc(when(o.newLink.expires))}. With it they choose their own password${o.newLink.passwordOnly ? '' : ' and set up their authenticator app'}.${o.newLink.reset ? ' Their old login no longer works.' : ''}</p>
<input class="input input-lg link-input" type="text" readonly value="${esc(o.newLink.url)}" onfocus="this.select()" aria-label="Setup link">
<p class="row"><button type="button" class="btn btn-primary" id="copy-link">${icon('copy', { size: 15 })}Copy link</button><span class="text-muted">Delve shows this link only now. If it gets lost, make a new one.</span></p>
<script>document.getElementById('copy-link').addEventListener('click', async (e) => { const b = e.currentTarget; try { await navigator.clipboard.writeText(${JSON.stringify(o.newLink.url).replace(/</g, '\\u003c')}); b.textContent = 'Copied'; } catch { b.textContent = 'Select the link and copy it'; } });</script></section>`
    : '';
  return shell(
    'Admin',
    `${topBar('Admin', o.me, [{ href: '/account', text: 'Your account', icon: 'users' }])}
<main class="page">
<div class="acct-head"><div><h1 class="display-lg">Admin</h1>
<p class="text-muted">Admins and GMs can edit maps and run games. Only admins can open this page. The shared editor password is switched off.</p></div></div>
${noticeLine(o.notice)}${o.error ? noticeLine(o.error, true) : ''}
${link}
<section class="panel"><h2 class="panel-title">Accounts</h2>
<div class="table-wrap"><table class="table"><thead><tr><th>Name</th><th>Role</th><th>Status</th><th>Last login</th><th></th></tr></thead><tbody>${accountRows(o.users, o.me, o.now)}</tbody></table></div>
<form method="post" action="/admin" class="add-row"><input type="hidden" name="action" value="create">
<div class="field"><label for="new-name">Name</label><input id="new-name" class="input" type="text" name="name" maxlength="32" required autocomplete="off"></div>
<div class="field"><label for="new-role">Role</label><div class="select"><select id="new-role" class="input" name="role"><option value="gm" selected>GM</option><option value="admin">Admin</option></select>${icon('chevron-down', { size: 14 })}</div></div>
${check('Password only (GMs, no authenticator app)', 'password_only')}
<button class="btn btn-primary" type="submit">${icon('plus', { size: 15 })}Add account</button></form>
<p class="field-hint" style="margin:0">Adding an account makes a setup link that is valid for ${LINK_MS / 3_600_000} hours. A password-only account is less safe: anyone who learns its password can log in, from anywhere. Admin accounts always need the app.</p></section>
<section class="panel"><h2 class="panel-title">Sessions</h2>
${sessionRows(o.sessions, o.session.id, '/admin', true)}
${o.sessions.length > 1 ? `<form class="form" method="post" action="/admin" data-confirm="Log out everyone except you?"><input type="hidden" name="action" value="end-all"><button class="btn btn-secondary" type="submit">Log out everyone except me</button></form>` : ''}
</section>
</main>
<script>
  document.querySelectorAll('form[data-confirm]').forEach((f) => f.addEventListener('submit', (e) => { if (!confirm(f.dataset.confirm)) e.preventDefault(); }));
</script>`,
  );
}
