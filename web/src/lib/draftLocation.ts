import type { DraftMeta } from "../sync/drafts";
import type { PrefsDraftSection } from "../sync/prefsDraft";

const PREFS_SECTION_NAMES: Record<PrefsDraftSection, string> = {
  brief: "Brief",
  instructions_md: "Instructions",
  common_issues_md: "Common issues",
};

// The classic Preferences section that holds a translation-preferences draft.
export const PREFS_CLASSIC_SECTION: Record<PrefsDraftSection, string> = {
  brief: "brief",
  instructions_md: "instructions",
  common_issues_md: "commonIssues",
};

// Where an unsaved draft lives on the flows screens. Shared by the flows "N
// unsaved" jump menu (SyncStatusBar) and the flows unsaved-drafts toast
// (UnsavedToasts, #372), so the two always land in the same place. Whether a
// draft's editor is showing right now is sync/draftEditors.ts, not the route.

// One-line name for a draft, e.g. "ULT ZEC 6:1" or "TN ZEC 6:11".
export function formatDraftMeta(m: DraftMeta): string {
  if (m.kind === "verse") return `${m.bibleVersion} ${m.book} ${m.chapter}:${m.verse}`;
  if (m.kind === "article") {
    // tA parts split into title / sub-title / body; name the part so two drafts
    // on the same article are tellable apart.
    return `${m.resource.toUpperCase()} ${m.articleId}${m.part === "body" ? "" : ` · ${m.part}`}`;
  }
  // Note templates have no reference either; the support_ref is what a
  // translator recognises them by, so lead with it and keep the id for
  // disambiguation (several templates can share a support_ref).
  if (m.kind === "template") return `${m.supportRef} · ${m.templateId}`;
  // Translation preferences (#909) have no reference: name the editor.
  if (m.kind === "prefs") return `Style · ${PREFS_SECTION_NAMES[m.section]}`;
  return `${m.rowKind.toUpperCase()} ${m.book} ${m.chapter}:${m.verse}`;
}

// The hash of the flows screen whose editor holds this draft. tW/tA articles
// and note templates carry no book/chapter/verse, so they route by id: a
// template to the flows Curate screen, an article to the article workspace
// (the flows Translate Words screen is per book, which an article draft does
// not record).
export function draftFlowHash(m: DraftMeta): string {
  if (m.kind === "article") return `#/articles/${m.resource}/${encodeURIComponent(m.articleId)}`;
  if (m.kind === "template") return `#/admin/curate/${encodeURIComponent(m.templateId)}`;
  if (m.kind === "prefs") return "#/admin/style";
  // 3-segment #/scripture/B/C/V: App.tsx's `ts` route accepts the optional
  // verse segment and TranslateScriptureScreen seeds its cursor from it on
  // mount, so this lands the translator on the exact drafted verse, not just
  // the top of the chapter (#229, #389).
  if (m.kind === "verse") return `#/scripture/${m.book}/${m.chapter}/${m.verse}`;
  // Row drafts carry the exact row id so the notes / questions screen lands on
  // the card that holds the draft: several can share a verse (#335).
  const row = encodeURIComponent(m.id);
  if (m.rowKind === "tn") return `#/notes/${m.book}/${m.chapter}/${m.verse}?row=${row}`;
  if (m.rowKind === "tq") return `#/questions/${m.book}/${m.chapter}/${m.verse}?row=${row}`;
  // twl row: the new UI has no word-links editor since the old flows words
  // screen retired (#173), so open the classic editor at that verse. ?twl=
  // starts its resource column on the Words tab with this row active; the
  // row's WordsTable entry restores the draft from the drafts store.
  return `#/${m.book}/${m.chapter}/${m.verse}?twl=${row}`;
}
