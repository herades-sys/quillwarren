// The players tab. Everyone sees who is in the game, in their colours. The GM
// also makes invite links (players join without an account) and removes
// members, which ends their access at once.
import type { TableCtx } from './ctx.ts';
import { $, api, button, copyText, h, postJson, toast } from './dom.ts';
import { isGm } from './logic.ts';

interface InviteRow {
  id: string;
  name?: string;
  expires: number;
  url: string;
  expired: boolean;
}

const absolute = (url: string): string => new URL(url, location.origin).toString();

export function initPlayers(ctx: TableCtx): void {
  const panel = $('panel-players');
  const gm = isGm(ctx.me());
  const inviteName = h('input', { type: 'text', placeholder: 'Who is it for? (optional)', maxLength: 40, 'aria-label': 'Invite for' });
  let link: { url: string; expires: number } | null = null;
  let invites: InviteRow[] = [];
  const base = `/api/v1/games/${encodeURIComponent(ctx.gameId)}/invites`;

  // the list comes from its own endpoint (with the links); a fresh hello says it changed
  async function loadInvites(): Promise<void> {
    try {
      invites = (await api<{ invites: InviteRow[] }>(base)).invites;
    } catch {
      invites = [];
    }
    draw();
  }

  async function revoke(i: InviteRow): Promise<void> {
    try {
      await api(`${base}/${encodeURIComponent(i.id)}`, { method: 'DELETE' });
      if (link?.url === absolute(i.url)) link = null;
      invites = invites.filter((x) => x.id !== i.id);
      draw();
    } catch (e) {
      toast((e as Error).message);
    }
  }

  async function createInvite(): Promise<void> {
    try {
      const name = inviteName.value.trim();
      const res = await postJson<{ url: string; expires: number }>(base, name ? { name } : {});
      link = { url: absolute(res.url), expires: res.expires };
      inviteName.value = '';
      draw();
    } catch (e) {
      toast((e as Error).message);
    }
  }

  function draw(): void {
    const view = ctx.state()?.view;
    if (!view) return;
    const kids: (HTMLElement | null)[] = [];
    if (gm) {
      const box = h('div', { class: 'invite' }, h('div', { class: 'row' }, inviteName, button('Create invite link', () => void createInvite(), { class: 'btn primary' })));
      if (link) {
        const field = h('input', { type: 'text', readOnly: true, value: link.url, 'aria-label': 'Invite link', onfocus: (e: Event) => (e.target as HTMLInputElement).select() });
        const l = link;
        box.append(
          h('div', { class: 'row' }, field, button('Copy', () => void copyText(l.url, field).then((ok) => toast(ok ? 'Link copied' : 'Select the link and copy it', ok ? 'info' : 'error')))),
          h('p', { class: 'hint' }, `Anyone with this link can join until ${new Date(l.expires).toLocaleString()}. Send it to one player; they pick a name when they open it.`),
        );
      } else box.append(h('p', { class: 'hint' }, 'Players join through a link, without an account. Each link works for 3 days.'));
      kids.push(h('h3', {}, 'Invite'), box);
      const open = invites.filter((i) => !i.expired);
      if (open.length) {
        const rows = h('ul', { class: 'list' });
        for (const i of open) {
          rows.append(
            h(
              'li',
              {},
              h('span', { class: 'grow', title: i.url }, i.name ?? 'Unnamed invite', h('span', { class: 'muted small-text' }, ` until ${new Date(i.expires).toLocaleString([], { dateStyle: 'short', timeStyle: 'short' })}`)),
              button('Copy', () => void copyText(absolute(i.url)).then((ok) => toast(ok ? 'Link copied' : 'Copying needs https; open the link field instead', ok ? 'info' : 'error')), { class: 'btn small' }),
              button('Revoke', () => void revoke(i), { class: 'btn small danger', title: 'The link stops working (players who joined stay)' }),
            ),
          );
        }
        kids.push(h('h3', {}, 'Open invites'), rows);
      }
    }
    const list = h('ul', { class: 'list' });
    for (const m of view.members) {
      const sw = h('span', { class: 'swatch' });
      sw.style.setProperty('--c', m.color);
      list.append(
        h(
          'li',
          {},
          sw,
          h('span', { class: 'grow' }, m.name, m.id === view.you.id ? h('span', { class: 'muted' }, ' (you)') : null),
          h('span', { class: 'tag' }, m.role === 'gm' ? 'GM' : 'Player'),
          gm && m.role !== 'gm'
            ? button('Remove', () => {
                if (confirm(`Remove ${m.name} from the game? Their link stops working.`)) void ctx.act({ type: 'member.remove', id: m.id });
              }, { class: 'btn small danger' })
            : null,
        ),
      );
    }
    kids.push(h('h3', {}, 'At the table'), list);
    if (!gm) kids.push(h('p', { class: 'hint' }, h('a', { href: `/play/${encodeURIComponent(ctx.gameId)}/leave` }, 'Leave this game on this device')));
    const focused = document.activeElement;
    panel.replaceChildren(...kids.filter((k): k is HTMLElement => k !== null));
    if (focused === inviteName) inviteName.focus();
  }

  inviteName.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') void createInvite();
  });
  ctx.on((c) => {
    if (c === 'all' || c === 'members') draw();
    if (c === 'all' && gm) void loadInvites();
  });
}
