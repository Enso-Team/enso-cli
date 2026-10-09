export type NoteIdentity = { id?: string; title?: string; displayTitle?: string; ref?: string };

/** The app resolves a Note by title, filename stem, or Vault-relative markdown path. */
export function noteKeys(note: NoteIdentity): Set<string> {
  const keys = [note.title, note.displayTitle];
  if (note.ref) {
    keys.push(note.ref, note.ref.replace(/\.md$/i, ""), note.ref.split("/").pop()?.replace(/\.md$/i, ""));
  }
  return new Set(keys.flatMap(value => value ? [value.toLowerCase()] : []));
}

export function noteMatches(note: NoteIdentity, selector: string): boolean {
  return note.id?.toLowerCase() === selector.toLowerCase() || noteKeys(note).has(selector.toLowerCase());
}

/** Send the app UUID when the selector uses a filename alias outside its live Node resolver. */
export function nodeSelector(note: NoteIdentity, selector: string): string {
  const direct = [note.id, note.title, note.displayTitle, note.ref].some(value => value?.toLowerCase() === selector.toLowerCase());
  return direct ? selector : note.id ?? selector;
}

/** Folder-qualified selectors carry the extension used by the app's placement resolver. */
export function placementSelector(selector: string): string {
  return selector.includes("/") && !/\.md$/i.test(selector) ? `${selector}.md` : selector;
}
