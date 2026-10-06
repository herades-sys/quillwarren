// HTML for /feedback ("Request a feature"): the form, the note for people who
// aren't logged in, and the "Feature requests" section of /admin. Built on
// @delve/ui; every value that came from a person is escaped.
import { esc, htmlDocument, icon, themeSwitch, topBar } from '@delve/ui';
import { KINDS, MAX, type Entry, type Kind, type Summary } from './log.ts';

// Class names start with req- (request), never fb-: ad blockers hide .fb-page and friends as
// Facebook widgets (Opera GX hid the whole form).
const CSS = `<style>
  .req-page { max-width: 720px; gap: var(--space-6); }
  .req-head { display: flex; flex-direction: column; gap: 6px; }
  .req-head .lead { margin: 2px 0 0; font-size: 14.5px; }
  .req-form { gap: var(--space-5); }
  .req-kind { border: 0; margin: 0; padding: 0; min-width: 0; }
  .req-kind legend { padding: 0; margin-bottom: 5px; font-size: var(--text-sm); color: color-mix(in srgb, var(--color-text) 70%, transparent); }
  .req-kind .seg { display: flex; max-width: 420px; }
  .req-kind .seg-opt { flex: 1; justify-content: center; white-space: nowrap; }
  .req-form textarea.input { min-height: 180px; }
  .req-count { float: right; font-variant-numeric: tabular-nums; }
  .req-two { display: grid; grid-template-columns: 1fr 1fr; gap: var(--space-4); }
  .req-hp { position: absolute; left: -10000px; top: auto; width: 1px; height: 1px; overflow: hidden; }
  .req-send { display: flex; flex-wrap: wrap; align-items: center; gap: var(--space-3) var(--space-4); }
  .req-send .field-hint { margin: 0; }
  .req-note p { margin: 0; }
  .req-who { display: inline-flex; align-items: center; gap: 8px; margin-left: 6px; font-size: var(--text-md); }
  @media (max-width: 640px) {
    .req-two { grid-template-columns: 1fr; }
    .req-kind .seg { max-width: none; }
    .req-kind .seg-opt { padding: 0 8px; min-height: var(--touch); }
    .req-who .req-who-name, .topbar .crumb-title, .topbar-brand + .vsep { display: none; }
    .req-send .btn { width: 100%; }
  }
</style>`;

/** "AN" for Ana, "MV" for Mara Venn. */
const initials = (name: string): string => {
  const w = name.trim().split(/\s+/).filter(Boolean);
  return (w.length > 1 ? w[0]![0]! + w[1]![0]! : (w[0] ?? '?').slice(0, 2)).toUpperCase();
};

export interface FormValues {
  kind: Kind;
  title: string;
  description: string;
  about: string;
  name: string;
}

/** Who is sending, as the page shows it. */
export interface Who {
  /** For the avatar ('' for the shared editor login). */
  name: string;
  /** "Robin · GM", "Bob · player in Crypt night", "Shared editor login". */
  label: string;
  /** Players come from the table, everyone else from the library. */
  player: boolean;
}

function page(body: string, who: Who | null, player: boolean): string {
  const avatar = who?.name ? `<span class="req-who" title="${esc(who.label)}"><span class="avatar">${esc(initials(who.name))}</span><span class="req-who-name">${esc(who.name)}</span></span>` : '';
  const crumbs = player ? [{ href: '/play', text: 'Delve Table' }] : [{ href: '/', text: 'Library' }];
  return htmlDocument({ title: 'Request a feature', body: `${topBar({ crumbs, title: 'Request a feature', end: `${themeSwitch()}${avatar}` })}${body}`, extra: CSS });
}

const head = `<div class="req-head"><span class="kicker">Delve · ideas and problems</span><h1 class="display-lg">Request a feature</h1>
<p class="lead">Missing something, or did something not work? Tell the admin here. Every request is kept, and they read them all.</p></div>`;

export function feedbackPage(o: { who: Who; values: FormValues; from: string; sent?: boolean; error?: string }): string {
  const v = o.values;
  const kinds = (Object.entries(KINDS) as [Kind, string][])
    .map(([k, label]) => `<label class="seg-opt"><input type="radio" name="kind" value="${k}"${k === v.kind ? ' checked' : ''}>${esc(label)}</label>`)
    .join('');
  const sent = o.sent ? `<p class="notice notice-ok" role="status">${icon('check', { size: 16 })}<span>Thank you! Your request is in. Send another one whenever you like.</span></p>` : '';
  const error = o.error ? `<p class="notice notice-danger" role="alert">${icon('alert', { size: 16 })}<span>${esc(o.error)}</span></p>` : '';
  return page(
    `<main class="page req-page">
${head}
${sent}${error}
<form class="panel req-form" method="post" action="/feedback"><input type="hidden" name="from" value="${esc(o.from)}">
<fieldset class="req-kind"><legend>What is it?</legend><div class="seg" role="radiogroup">${kinds}</div></fieldset>
<div class="field"><label for="req-title">Title</label><input id="req-title" class="input input-lg" type="text" name="title" value="${esc(v.title)}" maxlength="${MAX.title}" required placeholder="e.g. A legend on the 3D view"${o.error ? '' : ' autofocus'}></div>
<div class="field"><label for="req-desc">What should Delve do?</label><textarea id="req-desc" class="input input-lg" name="description" maxlength="${MAX.description}" required rows="8" aria-describedby="req-desc-hint" placeholder="What you want to do, what happens now, and what would help.">${esc(v.description)}</textarea>
<span class="field-hint" id="req-desc-hint">For a problem: what you did, what you expected, and what happened instead. <span class="req-count" data-count>${v.description.length} / ${MAX.description}</span></span></div>
<div class="req-two">
<div class="field"><label for="req-about">About which map or page <span class="text-faint">(optional)</span></label><input id="req-about" class="input input-lg" type="text" name="about" value="${esc(v.about)}" maxlength="${MAX.about}" placeholder="e.g. /maps/… or the table"></div>
<div class="field"><label for="req-name">Your name</label><input id="req-name" class="input input-lg" type="text" name="name" value="${esc(v.name)}" maxlength="${MAX.name}" autocomplete="nickname"></div>
</div>
<div class="req-hp" aria-hidden="true"><label for="req-website">Leave this empty</label><input id="req-website" type="text" name="website" tabindex="-1" autocomplete="off"></div>
<div class="req-send"><button class="btn btn-primary btn-lg" type="submit">${icon('send', { size: 15 })}Send request</button><span class="field-hint">Sent as <strong>${esc(o.who.label)}</strong>. Only admins can read requests.</span></div>
</form>
</main>
<script>
  (() => {
    const t = document.getElementById('req-desc'), c = document.querySelector('[data-count]');
    t.addEventListener('input', () => { c.textContent = t.value.length + ' / ${MAX.description}'; });
  })();
</script>`,
    o.who,
    o.who.player,
  );
}

/** For anyone who may not send: what to log in with. */
export function loginNotePage(o: { loginHref: string | null; discordHref: string | null; discordName: string | null }): string {
  const links = [
    o.loginHref ? `<a class="btn btn-primary" href="${esc(o.loginHref)}">${icon('lock', { size: 15 })}Log in</a>` : '',
    o.discordHref ? `<a class="btn btn-secondary" href="${esc(o.discordHref)}">Log in with Discord</a>` : '',
  ].join('');
  const discord = o.discordName
    ? `<p class="text-muted">You're logged in with Discord as <strong>${esc(o.discordName)}</strong>, but you have no seat at a Delve Table yet. Join a game from your GM's invite link first.</p>`
    : `<p class="text-muted">Players: open your game from your GM's invite link${o.discordHref ? ' or log in with Discord' : ''}, then come back here.</p>`;
  return page(
    `<main class="page req-page">
${head}
<section class="panel req-note"><h2 class="panel-title">Log in to send a request</h2>
<p>Only people with a Delve login can send requests: GMs and admins, and players at a Delve Table.</p>
${discord}
${links ? `<p class="row">${links}</p>` : ''}</section>
</main>`,
    null,
    false,
  );
}

// ---------- the /admin section ----------

const excerpt = (s: string, max = 280): string => (s.length > max ? `${s.slice(0, max).trimEnd()}…` : s);

function entry(e: Entry): string {
  const tag = e.kind === KINDS.bug ? 'tag-warning' : e.kind === KINDS.idea ? 'tag-accent' : 'tag-outline';
  // the header after its time and kind: "from …", "about …"
  const rest = e.head.split(' · ').slice(e.kind ? 2 : 1).join(' · ');
  const time = e.head.split(' · ')[0] ?? '';
  return `<li class="req-entry"><div class="req-entry-head"><span class="tag tag-outline tag-sm req-num">#${e.n}</span>${e.kind ? `<span class="tag ${tag} tag-sm">${esc(e.kind)}</span>` : ''}<strong>${esc(e.title || '(no title)')}</strong></div>
<p class="req-entry-meta">${esc(time)} · ${esc(rest)}</p>${e.description ? `<p class="req-entry-text">${esc(excerpt(e.description))}</p>` : ''}</li>`;
}

/** "Feature requests" on /admin: how many, the newest few, and the whole file. */
export function requestsSection(s: Summary): string {
  const list = s.count
    ? `<ol class="req-entries">${s.latest.map(entry).join('')}</ol>`
    : `<p class="text-muted">No requests yet. Logged-in GMs and admins, and Delve Table players, send them from <a href="/feedback">Request a feature</a>.</p>`;
  return `<section class="panel" id="feature-requests"><style>
  .req-entries { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 2px; }
  .req-entry { padding: 10px 0; box-shadow: inset 0 -1px 0 var(--color-border); display: flex; flex-direction: column; gap: 4px; min-width: 0; }
  .req-entry:last-child { box-shadow: none; }
  .req-entry-head { display: flex; flex-wrap: wrap; align-items: center; gap: 6px 8px; }
  .req-num { font-variant-numeric: tabular-nums; }
  .req-entry-meta { color: var(--color-text-muted); font-size: var(--text-sm); overflow-wrap: anywhere; }
  .req-entry-text { white-space: pre-line; overflow-wrap: anywhere; }
</style><h2 class="panel-title">Feature requests</h2>
<p class="text-muted">${s.count} request${s.count === 1 ? '' : 's'} in <code>feature-requests.txt</code>${s.count > s.latest.length ? `, the newest ${s.latest.length} below` : ''}. Only admins can read them; GMs and players can only send.</p>
${list}
${s.count ? `<p class="row"><a class="btn btn-secondary" href="/admin/feature-requests.txt" target="_blank" rel="noopener">${icon('notes', { size: 15 })}View the whole file</a><a class="btn btn-secondary" href="/admin/feature-requests.txt?download=1" download="feature-requests.txt">${icon('download', { size: 15 })}Download</a></p>` : ''}
</section>`;
}
