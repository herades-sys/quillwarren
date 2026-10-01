// The GM's session notebook (docs/TABLE.md, "GM notes"): the limits and the one
// check for what a write may contain. The server stores entries in table.db and
// only the GM reads or writes them; the browser uses the same limits.
import { TableError } from './errors.ts';

export const NOTEBOOK_TITLE_MAX = 120;
export const NOTEBOOK_TEXT_MAX = 100_000;
export const NOTEBOOK_MAX_ENTRIES = 500;
/** Entry ids the server makes: "nb_" and 12 hex digits. */
export const NOTEBOOK_ID = /^nb_[0-9a-f]{12}$/;
export const UNTITLED = 'Untitled';

export interface NotebookPatch {
  title?: string;
  text?: string;
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** A title on one line: trimmed, single spaces, no control characters; blank becomes "Untitled". */
export function notebookTitle(v: unknown): string {
  if (typeof v !== 'string') throw new TableError('title must be text');
  const s = v.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim();
  if (s.length > NOTEBOOK_TITLE_MAX) throw new TableError(`title is too long (max ${NOTEBOOK_TITLE_MAX} characters)`);
  return s || UNTITLED;
}

/** Plain text with line breaks (\r\n becomes \n), without NUL. */
export function notebookText(v: unknown): string {
  if (typeof v !== 'string') throw new TableError('text must be text');
  const s = v.replace(/\r\n?/g, '\n').replace(/\u0000/g, '');
  if (s.length > NOTEBOOK_TEXT_MAX) throw new TableError(`text is too long (max ${NOTEBOOK_TEXT_MAX} characters)`);
  return s;
}

/** The fields of a notebook write ({title?, text?} and nothing else), checked. */
export function notebookPatch(body: unknown): NotebookPatch {
  if (!isObj(body)) throw new TableError('send {title?, text?} as JSON');
  for (const k of Object.keys(body)) if (k !== 'title' && k !== 'text') throw new TableError(`notebook entries have no field "${k}"`);
  const out: NotebookPatch = {};
  if (body.title !== undefined) out.title = notebookTitle(body.title);
  if (body.text !== undefined) out.text = notebookText(body.text);
  return out;
}
