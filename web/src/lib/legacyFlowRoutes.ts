// Redirects for the hashes of the old flows screens retired in #173.
//
// The old flows mode (HomeScreen, ScriptureScreen, AlignScreen, ArticlesScreen,
// WordsScreen, SetupScreen, TeamScreen and their pill-bar nav) was replaced by
// the #165 redesign. Its hashes may still sit in bookmarks, history, or old
// links, so each one is rewritten to the screen that does that job now instead
// of falling through to the classic catch-all (which would read "home" or
// "align" as a book code) or to a blank page.
//
// Pure (string in, string out) so the table is unit-tested in
// legacyFlowRoutes.test.mjs; App.tsx's parseHash applies the result with
// history.replaceState. Returns null when the hash is not a retired route,
// including every form a kept screen still owns (#/words/{book},
// #/scripture/{book}[/{ch}[/{vs}]], #/verse/…, #/ai, #/style, #/curate,
// #/observe).
export function legacyFlowRedirect(hash: string): string | null {
  // Parameterless destinations.
  if (hash === "#/home") return "#/books";
  if (hash === "#/setup") return "#/admin/setup";
  if (hash === "#/team") return "#/admin/team";
  // The flows tW/tA article browser → the article workspace, which keeps the
  // populate / add-by-id / search tools that screen had.
  if (hash === "#/articles") return "#/articles/tw";

  // A bare #/scripture, #/align or #/words carried no book (the old screens
  // fell back to OBA, which may not be imported here), so send the user to the
  // Books screen to pick one.
  if (/^#\/(scripture|align|words)$/.test(hash)) return "#/books";

  // #/align/{book}[/{ch}[/{vs}]] → the redesign aligner, #/alignment/{book}/{ch}[/{vs}].
  const al = hash.match(/^#\/align\/([A-Za-z0-9]+)(?:\/(\d+))?(?:\/(\d+))?$/);
  if (al) {
    const tail = al[3] ? `/${al[3]}` : "";
    return `#/alignment/${al[1].toUpperCase()}/${al[2] ?? "1"}${tail}`;
  }

  // #/words/{book}/{ch}[/{vs}][?row={id}] was the old word-links (twl) screen.
  // The verse view shows that verse's word links; the ?row= tail has no
  // meaning there and is dropped. (#/words/{book} alone is the kept Words &
  // Articles screen and is not matched here.)
  const wl = hash.match(/^#\/words\/([A-Za-z0-9]+)\/(\d+)(?:\/(\d+))?(?:\?row=[^&]*)?$/);
  if (wl) {
    return `#/verse/${wl[1].toUpperCase()}/${wl[2]}/${wl[3] ?? "1"}`;
  }

  return null;
}
