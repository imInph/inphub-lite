/**
 * inphub lite: notes. The client-side api/notes.php.
 *
 * The search here is a plain substring over title, content and tags, which is
 * what notes.php did with a LIKE. It goes through fold() rather than
 * toLowerCase() because the owner's notes are Turkish and JS lower-casing gets
 * İ and ı wrong; MySQL's collation handled that for inphub and cannot here.
 */

import { getAll, DataError } from '../db.ts';
import { create, remove, update } from '../tx.ts';
import { bool, str, text } from '../normalize.ts';
import { fold } from '../fold.ts';
import type { Note } from '../types.ts';

/** ORDER BY pinned DESC, updated_at DESC, with an optional text filter. */
export async function list(q?: string): Promise<Note[]> {
  const rows = await getAll('notes');
  const needle = fold(str(q) ?? '');
  const matched = needle
    ? rows.filter((n) => fold(`${n.title ?? ''} ${n.content} ${n.tags ?? ''}`).includes(needle))
    : rows;
  return matched.sort((a, b) =>
    b.pinned - a.pinned
    || b.updated_at.localeCompare(a.updated_at)
    || b.id - a.id);
}

function fields(input: Record<string, unknown>, base?: Note) {
  const has = (k: string) => Object.prototype.hasOwnProperty.call(input, k);
  return {
    title: has('title') ? str(input['title']) : base?.title ?? null,
    content: text(input['content'], base?.content ?? ''),
    tags: has('tags') ? str(input['tags']) : base?.tags ?? null,
    pinned: has('pinned') ? bool(input['pinned']) : base?.pinned ?? 0,
  };
}

/** A short label for the History line, since a note has no required title. */
function label(n: Note): string {
  return n.title || n.content.replace(/\s+/g, ' ').slice(0, 40) || 'note';
}

export async function createNote(input: Record<string, unknown>): Promise<Note> {
  const f = fields(input);
  if (!f.content) throw new DataError('Content is required.', 422);
  return create('notes', { ...f, updated_at: new Date().toISOString().slice(0, 19) },
    (row) => ({ type: 'note.created', entity_type: 'note', summary: `Added note: ${label(row)}` }));
}

export async function updateNote(id: number, input: Record<string, unknown>): Promise<Note> {
  const existing = (await getAll('notes')).find((n) => n.id === id);
  if (!existing) throw new DataError('That note no longer exists.', 404);
  return update('notes', id, fields(input, existing),
    (_b, after) => ({ type: 'note.updated', entity_type: 'note', summary: `Updated note: ${label(after)}` }));
}

/** Toggles when `pinned` is absent, as notes.php did. */
export async function pinNote(id: number, pinned?: unknown): Promise<Note> {
  const existing = (await getAll('notes')).find((n) => n.id === id);
  if (!existing) throw new DataError('That note no longer exists.', 404);
  const next = pinned === undefined ? (existing.pinned ? 0 : 1) : bool(pinned);
  return update('notes', id, { pinned: next }, (_b, after) => ({
    type: next ? 'note.pinned' : 'note.unpinned',
    entity_type: 'note',
    summary: `${next ? 'Pinned' : 'Unpinned'} note: ${label(after)}`,
  }));
}

export async function deleteNote(id: number): Promise<void> {
  await remove('notes', id,
    (row) => ({ type: 'note.deleted', entity_type: 'note', summary: `Deleted note: ${label(row)}` }));
}
