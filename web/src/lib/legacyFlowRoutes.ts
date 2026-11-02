// Redirects for the hashes of the old flows screens retired in #173, and of
// the desk More-tools screens moved under #/admin/* in #537.
//
// The old flows mode (HomeScreen, ScriptureScreen, AlignScreen, ArticlesScreen,
// WordsScreen, SetupScreen, TeamScreen and their pill-bar nav) was replaced by
// the #165 redesign. Its hashes may still sit in bookmarks, history, or old
// links, so each one is rewritten to the screen that does that job now instead
// of falling through to the classic catch-all (which would read "home" or
// "align" as a book code) or to a blank page.
//
// Tolerant of the near-misses a hand-typed or old link carries: any case in
// the route word (#/Home), a trailing slash (#/home/), and any query tail
// (#/home?x=1). Only the old word-links screen's ?row= is carried over.
//
// The four admin desk More-tools screens (AI studio, Style, Templates, Observe)
// kept their own hashes through #173, then moved under the desk in #537:
// #/ai, #/style, #/curate[/{templateId}] and #/observe now redirect to
// #/admin/ai, #/admin/style, #/admin/curate[/{templateId}] and #/admin/observe.
//
// parseHash matches the #/admin/{section} hashes themselves exactly, so their
// near-misses (#/admin/AI, #/admin/ai/, #/admin/observe?x=1,
// #/admin/curate/{id}/) are canonicalized here too (#544) instead of falling
// to the book-code catch-all as book "ADMIN".
//
// Pure (string in, string out) so the table is unit-tested in
// legacyFlowRoutes.test.mjs; App.tsx's parseHash applies the result with
// history.replaceState. Returns null when the hash is not a retired route,
// including every form a kept screen still owns (#/scripture/{book}/…,
// #/verse/…, #/articles/{tw|ta}/…), an #/admin/… hash that is already exact,
// and an unknown #/admin/{section}.
const ADMIN_SECTIONS = new Set([
  "team", "setup", "workflow", "progress", "review", "ai", "style", "observe", "curate",
]);

export function legacyFlowRedirect(hash: string): string | null {
  // #/admin/{section}[/{templateId}]: lowercase the section, drop a trailing
  // slash and any query tail. Only curate takes a tail, and its template id is
  // kept exactly as encoded, the same as the #/curate/{id} branch below.
  const ad = hash.match(/^#\/admin\/([A-Za-z]+)(?:\/([^?/][^?]*?))?\/?(?:\?.*)?$/i);
  if (ad) {
    const section = ad[1].toLowerCase();
    if (!ADMIN_SECTIONS.has(section) || (ad[2] !== undefined && section !== "curate")) return null;
    const canonical = `#/admin/${section}${ad[2] ? `/${ad[2]}` : ""}`;
    return hash === canonical ? null : canonical;
  }

  // #/curate/{templateId}: a template id is free text (percent-encoded in the
  // hash), so it can't go through the [A-Za-z0-9] segment matcher below. Carry
  // it over exactly as encoded; drop a trailing slash and any raw query tail
  // (the in-app link encodes "?" and "/", so neither is part of a real id).
  const cu = hash.match(/^#\/curate\/([^?/][^?]*?)\/?(?:\?.*)?$/i);
  if (cu) return `#/admin/curate/${cu[1]}`;

  const m = hash.match(/^#\/([A-Za-z]+)((?:\/[A-Za-z0-9]+)*)\/?(?:\?(.*))?$/);
  if (!m) return null;
  const route = m[1].toLowerCase();
  const segs = m[2].split("/").filter(Boolean);
  const query = new URLSearchParams(m[3] ?? "");
  const isNum = (s: string | undefined) => s === undefined || /^\d+$/.test(s);

  if (segs.length === 0) {
    switch (route) {
      case "home":
        return "#/books";
      case "setup":
        return "#/admin/setup";
      case "team":
        return "#/admin/team";
      // The desk More-tools screens (#537).
      case "ai":
      case "style":
      case "curate":
      case "observe":
        return `#/admin/${route}`;
      // The flows tW/tA article browser → the article workspace, which keeps
      // the populate / add-by-id / search tools that screen had.
      case "articles":
        return "#/articles/tw";
      // A bare #/scripture, #/align or #/words carried no book (the old screens
      // fell back to OBA, which may not be imported here), so send the user to
      // the Books screen to pick one.
      case "scripture":
      case "align":
      case "words":
        return "#/books";
      default:
        return null;
    }
  }

  const [book, chapter, verse, ...rest] = segs;
  if (rest.length > 0 || !isNum(chapter) || !isNum(verse)) return null;
  const BOOK = book.toUpperCase();

  // #/align/{book}[/{ch}[/{vs}]] → the redesign aligner, #/alignment/{book}/{ch}[/{vs}].
  if (route === "align") {
    return `#/alignment/${BOOK}/${chapter ?? "1"}${verse ? `/${verse}` : ""}`;
  }

  if (route === "words") {
    // #/words/{book} is the kept Words & Articles screen: only normalize a
    // near-miss (case, trailing slash, query tail) onto its exact hash.
    if (chapter === undefined) {
      const kept = `#/words/${BOOK}`;
      return hash === kept ? null : kept;
    }
    // #/words/{book}/{ch}[/{vs}][?row={id}] was the old word-links (twl)
    // editor. The new UI has none, so open the classic editor at that verse;
    // ?twl= tells it to open the word-links tab with that row selected.
    const row = query.get("row");
    const tail = row ? `?twl=${encodeURIComponent(row)}` : "";
    return `#/${BOOK}/${chapter}/${verse ?? "1"}${tail}`;
  }

  return null;
}
