// Newline convention for tn/tq row text. D1 stores the source-TSV form: a
// line break is a backslash followed by "n", never a real newline character.
// The translator screens edit real newlines and convert at the boundary. Kept
// free of React / IndexedDB imports so the strip-types test runner loads it.

// Row text comes across with literal "\n" escape sequences (the source TSV
// format), not real newlines — same treatment ReviewQueue/NoteCard give it.
export function unescapeNewlines(text: string | null | undefined): string {
  return (text ?? "").replace(/\\n/g, "\n");
}

// The inverse, applied to every value these screens send to the server or the
// drafts store. The editors work on real newlines, but the stored convention is
// the escaped form (NoteCard's flushPending sends it the same way). Sending
// real newlines split D1 into two conventions and broke the outbox's 409
// auto-heal for any multi-line note: classifyRowPatchConflict compared an
// escaped server value against a real-newline baseline, never matched, and
// turned a healable version bump into "another editor changed this note".
export function escapeNewlines(text: string): string {
  return text.replace(/\r\n|\r|\n/g, "\\n");
}
