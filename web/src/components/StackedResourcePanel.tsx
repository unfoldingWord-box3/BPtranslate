// StackedResourcePanel — a standalone Notes / Words / Questions panel for a
// flexible-layout region that stacks multiple panels (Shell.renderRegion's
// multi-panel branch). Unlike the classic tabbed ResourceColumn (one shared
// body, one tab strip), a stacked panel renders exactly ONE resource kind and
// owns no tab UI — the layout region itself holds one PanelInstance per kind.
//
// Reuses the same *PanelBody content components ResourceColumn renders
// (WordsPanelBody / QuestionsPanelBody / NotesPanelBody) and mirrors
// ResourceColumn's row-derivation + translation-mode hooks verbatim so the
// content is identical to what the classic column shows for that tab. Pin
// state here is a separate, per-panel toggle — NOT the shared `be:pinned`
// store ResourceColumn uses — since multiple stacked panels can coexist
// on-screen independently.
//
// Notes cards disable drag/reorder here (no `onMoveUp`/`onMoveDown` /
// `onReorderHover` / `flashArrow`, and the drag callbacks are no-ops) — a
// stacked layout has no reorder affordance yet; this is a deliberate scope cut
// for the initial pass, not an oversight.

import { useEffect, useMemo, useState } from "react";
import { Box } from "@mui/material";
import { isReadOnly, api, type TnRow } from "../sync/api";
import { NoteCard } from "./NoteCard";
import { WordsPanelBody } from "./WordsPanel";
import { QuestionsPanelBody } from "./QuestionsPanel";
import { NotesPanelBody } from "./NotesPanel";
import { noteOverlapsRange } from "../lib/verseRange";
import { canonicalTwlOrder } from "../lib/twlCanonicalOrder";
import { liveRowCount, reviewStats } from "../lib/reviewApproval";
import { useProjectConfig, isTranslationProject } from "../hooks/useProjectConfig";
import { useSourceNotes } from "../hooks/useSourceNotes";
import { useSourceQuestions } from "../hooks/useSourceQuestions";
import { resolveSourceRef } from "../lib/sourceRef";
import { sortBySortOrder, groupByVerse } from "./resourcePanelShared";
import type { ResourceColumnProps } from "./ResourceColumn";

export type StackedResourcePanelProps = Omit<
  ResourceColumnProps,
  "visibleTabs" | "initialTab"
> & {
  panelType: "notes" | "words" | "questions";
};

export function StackedResourcePanel({
  panelType,
  book,
  chapter,
  activeVerse,
  displayVerseRange,
  tn,
  bookIntroTn,
  tq,
  twl,
  activeNoteId,
  activeWordId,
  findNoteQuery,
  activeNoteMatch,
  onNoteChange,
  onNoteSave,
  onNoteDelete,
  onNoteRestore,
  onNoteInsertAfter,
  verseOptions,
  onNoteChangeVerse,
  onNoteFocus,
  onNoteCreate,
  onNoteStartAi,
  isNoteAiPending,
  noteAiRecentlyCompletedAt,
  onNoteVisibilityChange,
  onWordSave,
  onWordDelete,
  onWordCreate,
  onWordFocus,
  onWordReorder,
  onQuestionSave,
  onQuestionDelete,
  onQuestionCreate,
  locked = false,
  onSetNotePreserve,
  onSetNoteHint,
  onNoteApprove,
  onApproveAllNotes,
  onNoteTranslate,
  translatingNoteIds,
  onQuestionApprove,
  onApproveAllQuestions,
  onQuestionTranslate,
  translatingQuestionIds,
  onNoteTranslateQuote,
  onWordTranslateQuote,
  onWordGloss,
  onAddTwlSuggestion,
  isTwlSuggestionExcluded,
  ultVerseObjectsFor,
  onWordHoverPreview,
  onTwlSuggestions,
  twlRowAlternatives,
  twlBlockedArticleIds,
  twlFiltersReady,
  quoteBuildActiveWordId,
  quoteBuildSelectionCount = 0,
  onStartWordQuoteBuild,
  checkoff,
}: StackedResourcePanelProps) {
  // ── Translation-mode state, re-derived exactly as ResourceColumn does ──
  const projectConfig = useProjectConfig();
  const translationMode = isTranslationProject(projectConfig);
  const sourceProjection = useMemo(
    () => resolveSourceRef(projectConfig?.translationSource, "tn"),
    [projectConfig],
  );
  const sourceNotes = useSourceNotes(translationMode ? book : null, sourceProjection);
  // Shared with ResourceColumn — the two used to carry byte-identical copies of
  // this loop, and the counting rule now lives once in reviewStats (#238).
  const tnStats = useMemo(
    () => reviewStats(translationMode ? tn : []),
    [tn, translationMode],
  );
  const [termsCount, setTermsCount] = useState(0);
  useEffect(() => {
    if (!translationMode || isReadOnly()) return;
    let cancelled = false;
    api
      .getTermsCount()
      .then((res) => {
        if (!cancelled) setTermsCount(res.count);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [translationMode, book]);
  const sourceQuestionProjection = useMemo(
    () => resolveSourceRef(projectConfig?.translationSource, "tq"),
    [projectConfig],
  );
  const sourceQuestions = useSourceQuestions(translationMode ? book : null, sourceQuestionProjection);
  // tQ has no trashed_at column, so the shared helper's trashed arm is inert.
  const tqStats = useMemo(
    () => reviewStats(translationMode ? tq : []),
    [tq, translationMode],
  );

  // Per-panel pin — independent of ResourceColumn's shared `be:pinned` store,
  // since several stacked panels of the same kind could coexist.
  const [pinned, setPinned] = useState(false);
  const onTogglePin = () => setPinned((p) => !p);

  const [rangeStart, rangeEnd] = displayVerseRange;

  const tnForVerse = useMemo(
    () =>
      groupByVerse(tn.filter((r) => noteOverlapsRange(r, rangeStart, rangeEnd))).flatMap(
        ([, rows]) => sortBySortOrder(rows),
      ),
    [tn, rangeStart, rangeEnd],
  );
  const tqForVerse = useMemo(
    () =>
      groupByVerse(tq.filter((r) => noteOverlapsRange(r, rangeStart, rangeEnd))).flatMap(
        ([, rows]) => sortBySortOrder(rows),
      ),
    [tq, rangeStart, rangeEnd],
  );
  const twlForVerse = useMemo(
    () =>
      groupByVerse(twl.filter((r) => r.verse >= rangeStart && r.verse <= rangeEnd)).flatMap(
        ([v, rows]) => canonicalTwlOrder(rows, ultVerseObjectsFor?.(v) ?? null),
      ),
    [twl, rangeStart, rangeEnd, ultVerseObjectsFor],
  );

  const tnGroups = useMemo(
    () =>
      pinned
        ? groupByVerse(tn).map(([v, rows]) => [v, sortBySortOrder(rows)] as [number, TnRow[]])
        : null,
    [pinned, tn],
  );
  const tqGroups = useMemo(
    () =>
      pinned
        ? groupByVerse(tq).map(([v, rows]) => [v, sortBySortOrder(rows)] as [number, typeof tq])
        : null,
    [pinned, tq],
  );
  const twlGroups = useMemo(
    () =>
      pinned
        ? groupByVerse(twl).map(
            ([v, rows]) =>
              [v, canonicalTwlOrder(rows, ultVerseObjectsFor?.(v) ?? null)] as [number, typeof twl],
          )
        : null,
    [pinned, twl, ultVerseObjectsFor],
  );

  // Live-row denominators, same rule as ResourceColumn / the book summary
  // (#238). Trashed notes stay listed below, labelled rather than counted.
  const tnCount = useMemo(
    () => liveRowCount(pinned ? tn : tnForVerse),
    [pinned, tn, tnForVerse],
  );
  const tqCount = useMemo(
    () => liveRowCount(pinned ? tq : tqForVerse),
    [pinned, tq, tqForVerse],
  );
  const totalTn = tnCount.live;
  const totalTwl = pinned ? twl.length : twlForVerse.length;
  const totalTq = tqCount.live;

  // Book-introduction rows (chapter 0) have no verse here; see ResourceColumn.
  const isForeign = (r: TnRow) => bookIntroTn?.some((b) => b.id === r.id) ?? false;
  const renderNoteCard = (r: TnRow) => (
    <NoteCard
      key={r.id}
      row={r}
      active={r.id === activeNoteId}
      findQuery={activeNoteMatch && activeNoteMatch.noteId === r.id ? (findNoteQuery ?? null) : null}
      activeMatchOccurrence={
        activeNoteMatch && activeNoteMatch.noteId === r.id ? activeNoteMatch.occurrence : null
      }
      dragging={false}
      isDropTarget={false}
      onChange={(p) => onNoteChange(r.id, p)}
      onSave={(p, opts) => onNoteSave(r.id, p, opts)}
      onDelete={() => onNoteDelete(r.id)}
      onRestore={() => onNoteRestore(r.id)}
      onInsertAfter={() => onNoteInsertAfter(r.id)}
      verseOptions={isForeign(r) ? undefined : verseOptions}
      onChangeVerse={isForeign(r) ? undefined : (v, vEnd) => onNoteChangeVerse(r.id, v, vEnd)}
      onFocus={() => onNoteFocus(r)}
      onGripDragStart={() => {}}
      onDragEnd={() => {}}
      onCardDragOver={() => {}}
      onCardDragLeave={() => {}}
      onCardDrop={() => {}}
      onStartAi={onNoteStartAi && !isForeign(r) ? (live) => onNoteStartAi(r, live) : undefined}
      isAiPending={isNoteAiPending?.(r.id) ?? false}
      aiRecentlyCompletedAt={noteAiRecentlyCompletedAt?.(r.id) ?? null}
      onVisibilityChange={onNoteVisibilityChange}
      locked={locked}
      onSetPreserve={onSetNotePreserve ? (value) => onSetNotePreserve(r.id, value) : undefined}
      onSetHint={onSetNoteHint ? (value) => onSetNoteHint(r.id, value) : undefined}
      onTranslateQuote={onNoteTranslateQuote && !isForeign(r) ? (english) => onNoteTranslateQuote(r, english) : undefined}
      translationMode={translationMode}
      sourceNote={translationMode ? (sourceNotes.get(r.id) ?? null) : null}
      onApprove={onNoteApprove ? () => onNoteApprove(r.id, true) : undefined}
      onUnapprove={onNoteApprove ? () => onNoteApprove(r.id, false) : undefined}
      onTranslate={onNoteTranslate ? () => onNoteTranslate(r.id) : undefined}
      isTranslating={translatingNoteIds?.has(r.id) ?? false}
    />
  );

  return (
    <Box sx={{ flex: 1, overflowY: "auto", scrollbarGutter: "stable", px: 2, py: 1 }}>
      {panelType === "notes" && (
        <NotesPanelBody
          activeVerse={activeVerse}
          tnForVerse={tnForVerse}
          tnGroups={tnGroups}
          totalTn={totalTn}
          trashedTn={tnCount.trashed}
          pinned={pinned}
          onTogglePin={onTogglePin}
          onNoteCreate={onNoteCreate}
          locked={locked}
          checkoff={checkoff}
          translationMode={translationMode}
          tnStats={tnStats}
          termsCount={termsCount}
          onNoteApprove={onNoteApprove}
          onApproveAllNotes={onApproveAllNotes}
          renderNoteCard={(r) => renderNoteCard(r)}
          bookIntroRows={bookIntroTn}
        />
      )}
      {panelType === "words" && (
        <WordsPanelBody
          book={book}
          chapter={chapter}
          activeVerse={activeVerse}
          twlForVerse={twlForVerse}
          twlGroups={twlGroups}
          totalTwl={totalTwl}
          pinned={pinned}
          onTogglePin={onTogglePin}
          onWordCreate={onWordCreate}
          locked={locked}
          checkoff={checkoff}
          activeWordId={activeWordId}
          onWordSave={onWordSave}
          onWordDelete={onWordDelete}
          onWordFocus={onWordFocus}
          onWordReorder={onWordReorder}
          onWordHoverPreview={onWordHoverPreview}
          onWordTranslateQuote={onWordTranslateQuote}
          onWordGloss={onWordGloss}
          twlRowAlternatives={twlRowAlternatives}
          quoteBuildActiveWordId={quoteBuildActiveWordId}
          quoteBuildSelectionCount={quoteBuildSelectionCount}
          onStartWordQuoteBuild={onStartWordQuoteBuild}
          onAddTwlSuggestion={onAddTwlSuggestion}
          isTwlSuggestionExcluded={isTwlSuggestionExcluded}
          onTwlSuggestions={onTwlSuggestions}
          twlBlockedArticleIds={twlBlockedArticleIds}
          twlFiltersReady={twlFiltersReady}
        />
      )}
      {panelType === "questions" && (
        <QuestionsPanelBody
          activeVerse={activeVerse}
          tqForVerse={tqForVerse}
          tqGroups={tqGroups}
          totalTq={totalTq}
          pinned={pinned}
          onTogglePin={onTogglePin}
          onQuestionCreate={onQuestionCreate}
          locked={locked}
          checkoff={checkoff}
          translationMode={translationMode}
          tqStats={tqStats}
          sourceQuestions={sourceQuestions}
          onQuestionSave={onQuestionSave}
          onQuestionDelete={onQuestionDelete}
          onQuestionApprove={onQuestionApprove}
          onApproveAllQuestions={onApproveAllQuestions}
          onQuestionTranslate={onQuestionTranslate}
          translatingQuestionIds={translatingQuestionIds}
        />
      )}
    </Box>
  );
}
