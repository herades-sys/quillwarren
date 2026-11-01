// The GM's session notebook over REST (docs/TABLE.md, "GM notes"): entries
// {id, title, text, created, updated} per game, in table.db apart from the game
// state. Only the GM reads or writes them: a player gets 403 (so does the GM
// testing the game with a player cookie), anyone else 401. After every write the
// GM's live connections hear of it (TableHub.toGms), so another tab (the 3D view)
// stays in step; players' connections never do.
//
// REST rather than intents: the notebook isn't game state (it would ride along in
// every save of it and in the GM's hello), has nothing to filter per member, and
// a long session log is better fetched once than pushed on every reconnect.
import { randomBytes } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { NOTEBOOK_ID, NOTEBOOK_MAX_ENTRIES, notebookPatch, TableError, UNTITLED, type GameState, type NotebookEntry } from '@delve/table';
import { GAME_ID, memberOf, type AccessDeps } from './access.ts';
import type { TableHub } from './live.ts';
import type { TableStore } from './store.ts';

export interface NotebookDeps {
  store: TableStore;
  hub: TableHub;
  access: AccessDeps;
}

export const newEntryId = (): string => `nb_${randomBytes(6).toString('hex')}`;

export function registerNotebook(app: FastifyInstance, { store, hub, access }: NotebookDeps): void {
  /** The game, when the request is its GM; otherwise the refusal is already sent. Writes with a cookie need the page's own origin. */
  const asGm = (req: FastifyRequest, reply: FastifyReply, write: boolean): GameState | null => {
    const { id } = req.params as { id: string };
    const state = GAME_ID.test(id) ? store.get(id) : undefined;
    if (!state) {
      void reply.code(404).send({ error: `no game "${id}"` });
      return null;
    }
    const member = memberOf(access, req, state, { write });
    if (!member) {
      void reply.code(401).send({ error: 'only the GM can use the notebook: log in to Quillwarren' });
      return null;
    }
    if (member.role !== 'gm') {
      void reply.code(403).send({ error: 'only the GM can use the notebook' });
      return null;
    }
    return state;
  };
  const bad = (reply: FastifyReply, e: unknown) => {
    if (e instanceof TableError) return reply.code(400).send({ error: e.message });
    throw e;
  };
  const noStore = (reply: FastifyReply) => reply.header('cache-control', 'no-store');

  app.get('/api/v1/games/:id/notebook', async (req, reply) => {
    const state = asGm(req, reply, false);
    if (!state) return reply;
    return noStore(reply).send({ entries: store.notebook(state.id) });
  });

  app.post('/api/v1/games/:id/notebook', async (req, reply) => {
    const state = asGm(req, reply, true);
    if (!state) return reply;
    try {
      const patch = notebookPatch(req.body ?? {});
      if (store.notebookCount(state.id) >= NOTEBOOK_MAX_ENTRIES) return reply.code(409).send({ error: `at most ${NOTEBOOK_MAX_ENTRIES} notebook entries; delete some first` });
      const now = Date.now();
      const entry: NotebookEntry = { id: newEntryId(), title: patch.title ?? UNTITLED, text: patch.text ?? '', created: now, updated: now };
      store.putNotebookEntry(state.id, entry);
      hub.toGms(state.id, { type: 'notebook', entry });
      return noStore(reply).code(201).send({ entry });
    } catch (e) {
      return bad(reply, e);
    }
  });

  app.patch('/api/v1/games/:id/notebook/:entryId', async (req, reply) => {
    const state = asGm(req, reply, true);
    if (!state) return reply;
    const { entryId } = req.params as { entryId: string };
    const cur = NOTEBOOK_ID.test(entryId) ? store.notebookEntry(state.id, entryId) : undefined;
    if (!cur) return reply.code(404).send({ error: `no notebook entry "${entryId}"` });
    try {
      const patch = notebookPatch(req.body ?? {});
      // updated never goes backwards, even with the clock: tabs order versions by it
      const entry: NotebookEntry = { ...cur, ...patch, updated: Math.max(Date.now(), cur.updated + 1) };
      store.putNotebookEntry(state.id, entry);
      hub.toGms(state.id, { type: 'notebook', entry });
      return noStore(reply).send({ entry });
    } catch (e) {
      return bad(reply, e);
    }
  });

  app.delete('/api/v1/games/:id/notebook/:entryId', async (req, reply) => {
    const state = asGm(req, reply, true);
    if (!state) return reply;
    const { entryId } = req.params as { entryId: string };
    if (!NOTEBOOK_ID.test(entryId) || !store.deleteNotebookEntry(state.id, entryId)) return reply.code(404).send({ error: `no notebook entry "${entryId}"` });
    hub.toGms(state.id, { type: 'notebook', removed: entryId });
    return reply.code(204).send();
  });
}
