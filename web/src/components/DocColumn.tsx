import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Box, Stack, Typography, IconButton, Tooltip } from "@mui/material";
import SaveIcon from "@mui/icons-material/Save";
import UndoIcon from "@mui/icons-material/Undo";
import CheckIcon from "@mui/icons-material/Check";
import type { TwlRow, VerseDto } from "../sync/api";
import { CopyChapterButton } from "./CopyChapterButton";
import { LANE_FILL, type TextLaneCheck } from "../lib/laneChecks";
import { highlightsFor, overlayFindMarks, paragraphClass, renderEditableHTML, renderHighlightedHTML, type HighlightKey, type ReorderHighlight } from "../lib/highlight";
import { markHighlightSx } from "../lib/highlightStyles";
import { extractTrailingMarkers, stripTrailingMarkers, splitSectionHeaders, type SectionHeader } from "../lib/usfm";
import { SectionHeaderBand } from "./SectionHeaderBand";
import { AlignLinkButton } from "./AlignLinkButton";
import { drafts, verseKey, draftDirtyBorderSx } from "../sync/drafts";
import { HebrewLine } from "./HebrewLine";
import { useProjectConfig } from "../hooks/useProjectConfig";
import { versionLabel } from "../lib/versionLabels";
import type { LexiconEntry } from "../hooks/useLexicon";
import type { FindMatch } from "./FindReplaceOverlay";
import { formatVerseLabel, isFirstOfRange, isRangeRow } from "../lib/verseRange";
import {
  matchSourceVerse,
  renderFindMatchesByOffsets,
  type SourceQueryKind,
  type SourceTokenMatch,
} from "../lib/sourceSearch";

interface SearchState {
  re: RegExp | null;
  sourceQuery: SourceQueryKind;
}

interface Props {
  book: string;
  bibleVersion: string;
  // Pre-expanded per-version index: verses[7] returns the 6-9 range row when
  // verse 7 is inside a UST multi-verse block. ScriptureColumn builds this
  // via buildVerseIndex; the wire shape (keyed by verse_start) stays in
  // versesByVersion at the Shell level.
  versesByVerseNum: Record<number, VerseDto>;
  // The UHB/UGNT per-verse index (verse_start keyed), so each verse's align
  // button can flag a broken link when a source word has no target. Same shape
  // as versesByVerseNum; absent for source columns (which show no align button).
  sourceByVerseNum?: Record<number, VerseDto>;
  verseNumbers: number[];
  chapter: number;
  activeVerse: number;
  readOnly?: boolean;
  rtl?: boolean;
  activeNoteQuote?: string | null;
  activeNoteOccurrence?: number | null;
  // Transient reorder stoplight for the active verse (drag held / ~3s after an
  // arrow move): the moved note's candidate prev (green underline) + next (red
  // overline), on channels separate from the yellow active fill.
  reorderHighlight?: ReorderHighlight | null;
  // Active verse's UHB/UGNT verse content — lets ULT/UST columns OL-anchor the
  // note highlight (resolve the OL quote against the source, then map via
  // alignment) instead of guessing from milestone order. Ignored for UHB/UGNT.
  activeSourceContent?: unknown;
  // Increment to request a scroll-to-active even when activeVerse hasn't
  // changed — used by ScriptureColumn's "go to active" button in columns mode.
  scrollNonce?: number;
  // Present only when this column is UHB — caller pre-loads the lexicon
  // and we render each \w with a hover tooltip.
  lexiconMap?: Map<string, LexiconEntry | null>;
  // This chapter's TWL rows (UHB column only) so the \w hover tooltips can
  // show the tW link, matching the aligner.
  twl?: TwlRow[];
  // Compiled find state from the overlay: English regex + classified source-
  // language query. Paints <mark.be-find> on plain_text for English mode,
  // and on token offsets / HebrewLine highlights for source-language mode.
  // Note highlights step aside while a query is active.
  search?: SearchState | null;
  // The single active find match (the one prev/next navigates to). The cell
  // containing it paints with the stronger be-find-active style.
  findActiveMatch?: FindMatch | null;
  onSelectVerse: (v: number) => void;
  onEditVerse: (verseNum: number, plain: string, base: VerseDto) => void;
  // Save every dirty draft in this column (one PATCH per verse). The
  // header button calls this; per-verse undo handles single-verse rollback.
  onSaveColumn: (drafts: Array<{ verseNum: number; plain: string; base: VerseDto }>) => void;
  onOpenAligner: (verseNum: number) => void;
  // Section-band edit/delete for this column's bibleVersion. Shell's
  // saveSectionEdit splices verseObjects and enqueues. Omitted on read-
  // only columns (UHB/UGNT) and locked chapters → band stays read-only.
  onEditSection?: (
    verseNum: number,
    change: { index: number; tag: string | null; text: string },
    base: VerseDto,
  ) => void;
  // Optional per-verse Text-lane check. When present and canCheck, each verse
  // gets a small check control + a tinted verse-number underline. The
  // integrator wires this from Shell; absent in standalone/source columns.
  textCheck?: TextLaneCheck;
}

// Continuous Word-style editor for one bible_version. Each verse is its
// own contenteditable block so debounced changes can flow to the outbox
// at verse granularity. Active verse gets a halo; clicking a non-active
// verse promotes it to active. Editing happens in plain text — the full
// content_json tree is replaced server-side with a single-text-token
// representation, which DOES invalidate the existing alignment for that
// verse. Phase 3 (alignment editor) restores it.

export function DocColumn({
  book,
  bibleVersion,
  versesByVerseNum,
  sourceByVerseNum,
  verseNumbers,
  chapter,
  activeVerse,
  readOnly,
  rtl,
  activeNoteQuote,
  activeNoteOccurrence,
  reorderHighlight,
  activeSourceContent,
  scrollNonce,
  lexiconMap,
  twl,
  search,
  findActiveMatch,
  onSelectVerse,
  onEditVerse,
  onSaveColumn,
  onOpenAligner,
  onEditSection,
  textCheck,
}: Props) {
  const { t } = useTranslation();
  const projectConfig = useProjectConfig();
  // Hebrew original gets the enlarged SBL-Hebrew treatment; RTL direction alone
  // (e.g. an Arabic pane) keeps the normal reading font.
  const hebrewSource = bibleVersion === "UHB";
  const containerRef = useRef<HTMLDivElement | null>(null);
  const activeRef = useRef<HTMLSpanElement | null>(null);

  useEffect(() => {
    activeRef.current?.scrollIntoView({ behavior: "smooth", block: "center" });
  }, [activeVerse, scrollNonce]);

  return (
    <Box
      ref={containerRef}
      sx={{
        flex: 1,
        minWidth: 0,
        display: "flex",
        flexDirection: "column",
        border: "1px solid",
        borderColor: "divider",
        borderRadius: 1,
        bgcolor: readOnly ? "grey.100" : "background.paper",
        overflow: "hidden",
      }}
    >
      <Stack
        direction="row"
        spacing={1}
        alignItems="center"
        sx={{
          px: 1,
          py: 0.5,
          bgcolor: readOnly ? "grey.100" : "primary.50",
          borderBottom: "1px dashed",
          borderColor: "divider",
        }}
      >
        <Typography
          variant="caption"
          sx={{
            fontFamily: "monospace",
            color: readOnly ? "text.secondary" : "primary.main",
            fontWeight: 700,
            textTransform: "uppercase",
            letterSpacing: 0.5,
            flex: 1,
          }}
        >
          {versionLabel(projectConfig, bibleVersion)} ·{" "}
          {readOnly ? t("widgets.docColumn.readOnly") : t("widgets.docColumn.editing")}
        </Typography>
        <CopyChapterButton
          book={book}
          chapter={chapter}
          // versesByVerseNum maps every verse in a range to the same DTO; chapterCopy
          // dedupes by leading verse, so pass the raw values.
          blocks={() => [
            { version: bibleVersion, verses: Object.values(versesByVerseNum).filter(Boolean) },
          ]}
        />
      </Stack>
      <Box
        dir={rtl ? "rtl" : "ltr"}
        sx={(theme) => ({
          flex: 1,
          overflowY: "auto",
          px: 1.5,
          py: 1,
          lineHeight: 1.7,
          fontSize: `calc(${hebrewSource ? 21 : 15}px * var(--be-reading-scale, 1))`,
          fontFamily: hebrewSource
            ? '"Times New Roman","SBL Hebrew","Cardo",serif'
            : '"Source Serif Pro","Cambria","Times New Roman",serif',
          textAlign: "start",
          ...markHighlightSx(theme.palette.mode),
          ...draftDirtyBorderSx(),
        })}
      >
        {verseNumbers.map((v) => {
          const dto = versesByVerseNum[v];
          if (!dto) return null;
          // Multi-verse rows are emitted once at the start of their span;
          // verses inside the range (e.g. 7, 8, 9 of a UST 6-9 block) point
          // at the same DTO via the index but skip rendering here.
          if (!isFirstOfRange(dto, v)) return null;
          // "Active" if the user's navigated verse is inside this DTO's
          // range. For singletons this reduces to v === activeVerse.
          const isActive = activeVerse >= dto.verse && activeVerse <= (dto.verse_end ?? dto.verse);
          // During a preview the yellow follows the moved/hovered note; else the
          // active note.
          const aQuote = reorderHighlight?.movedQuote ?? activeNoteQuote;
          const aOcc = reorderHighlight?.movedQuote ? reorderHighlight.movedOccurrence : activeNoteOccurrence;
          const highlights = isActive
            ? highlightsFor(bibleVersion, dto.content, aQuote, aOcc, activeSourceContent)
            : null;
          // Reorder stoplight neighbour sets (active verse only, while live).
          const prevHighlights =
            isActive && reorderHighlight?.prevQuote
              ? highlightsFor(bibleVersion, dto.content, reorderHighlight.prevQuote, reorderHighlight.prevOccurrence, activeSourceContent)
              : null;
          const nextHighlights =
            isActive && reorderHighlight?.nextQuote
              ? highlightsFor(bibleVersion, dto.content, reorderHighlight.nextQuote, reorderHighlight.nextOccurrence, activeSourceContent)
              : null;
          // Lift any \s1/\s2/\s3 section headers in this verse's content
          // into block-level bands rendered AFTER the inline verse span
          // (see below) — they sit in the verse's trailing objects and
          // introduce the next verse. The remaining body still has them
          // filtered by the renderer.
          const verseObjects = (dto.content as { verseObjects?: unknown[] } | null)?.verseObjects;
          const sections: SectionHeader[] = Array.isArray(verseObjects)
            ? splitSectionHeaders(verseObjects).sections
            : [];
          // Drift trailing \q1/\p etc. from the previous verse into the
          // leading position of THIS verse — usfm-js attaches them to
          // the prior verse (per `\q1 \v N+1`) but visually they introduce
          // this verse. Composed into the rendered content here; storage
          // stays untouched.
          const prevDto = findPreviousVerse(versesByVerseNum, dto.verse);
          const drift = prevDto
            ? extractTrailingMarkers(
                (prevDto.content as { verseObjects?: unknown[] } | null)?.verseObjects,
              )
            : [];
          return (
            <Fragment key={dto.verse}>
              <VerseSpan
                book={book}
                chapter={chapter}
                verseNum={dto.verse}
                verseLabel={formatVerseLabel(dto)}
                isRange={isRangeRow(dto)}
                bibleVersion={bibleVersion}
                text={dto.plain_text ?? ""}
                content={dto.content}
                sourceContent={sourceByVerseNum?.[dto.verse]?.content}
                precedingMarkers={drift}
                highlights={highlights}
                prevHighlights={prevHighlights}
                nextHighlights={nextHighlights}
                isActive={isActive}
                readOnly={!!readOnly}
                rtl={!!rtl}
                lexiconMap={lexiconMap}
                twl={twl}
                search={search ?? null}
                findActiveMatch={findActiveMatch ?? null}
                spanRef={isActive ? activeRef : null}
                textCheck={textCheck}
                onClick={() => onSelectVerse(dto.verse)}
                onAlign={() => onOpenAligner(dto.verse)}
                onEdit={(plain) => onEditVerse(dto.verse, plain, dto)}
                onSave={(plain) => onSaveColumn([{ verseNum: dto.verse, plain, base: dto }])}
              />
              {/* `\s*` headings live in this verse's trailing verseObjects
                  but introduce the NEXT verse — render the band AFTER the
                  verse span so it sits at the verse end (like a trailing
                  `\p`/`\q`), not glued above the verse it's attached to. */}
              {sections.map((s, i) => (
                <SectionHeaderBand
                  key={`sec-${dto.verse}-${i}`}
                  tag={s.tag}
                  text={s.text}
                  editable={!readOnly && !!onEditSection}
                  onChange={
                    onEditSection
                      ? (next) =>
                          onEditSection(dto.verse, { index: i, tag: next.tag, text: next.text }, dto)
                      : undefined
                  }
                />
              ))}
            </Fragment>
          );
        })}
      </Box>
    </Box>
  );
}

// Locate the verse row immediately preceding `verse` in this column's
// versesByVerseNum map. We can't just lookup [verse - 1] because the
// prior row might be a multi-verse range (e.g. 6-9) — we look for the
// row whose [verse, verseEnd] window ends at verse - 1. Returns null
// when there is no prior verse in this chapter (verse 1, or front).
function findPreviousVerse(
  versesByVerseNum: Record<number, VerseDto>,
  verse: number,
): VerseDto | null {
  for (let v = verse - 1; v >= 0; v--) {
    const dto = versesByVerseNum[v];
    if (!dto) continue;
    // The first row whose end-of-range is < verse — that's the predecessor.
    if ((dto.verse_end ?? dto.verse) < verse) return dto;
  }
  return null;
}

// The active/editable verse renders its OWN verseObjects (so the
// contentEditable text matches the save diff), which drops the paragraph
// marker drifted from the previous verse — and with it the visual line break
// that introduces the verse. Map that drifted marker to the same wrapper class
// the inactive (display) path uses, so we can put it directly on the editable
// span and get the break/indent back from CSS without touching the text. Use
// the marker closest to the verse (last in document order). `\ts\*` is a flex
// divider block (`be-ts`) that would relayout the content span, so it never
// supplies the class — but if it's the ONLY drifted marker we still fall back
// to a plain block break so the verse keeps its own line.
function leadingBreakClass(markers: unknown[] | null | undefined): string {
  if (!Array.isArray(markers)) return "";
  let sawDivider = false;
  for (let i = markers.length - 1; i >= 0; i--) {
    const tag = (markers[i] as { tag?: unknown } | null)?.tag;
    if (typeof tag !== "string") continue;
    if (tag === "ts") {
      sawDivider = true;
      continue;
    }
    const { wrapper, isBlank } = paragraphClass(tag);
    return isBlank ? "be-line" : wrapper;
  }
  // Only a `\ts\*` chunk divider drifted (no paragraph/poetry marker): the
  // inactive path renders a divider block here, so keep the active verse on
  // its own line with a plain block break rather than letting it run inline.
  return sawDivider ? "be-line" : "";
}

function VerseSpan({
  book,
  chapter,
  verseNum,
  verseLabel,
  isRange,
  bibleVersion,
  text,
  content,
  sourceContent,
  precedingMarkers,
  highlights,
  prevHighlights,
  nextHighlights,
  isActive,
  readOnly,
  rtl,
  lexiconMap,
  twl,
  search,
  findActiveMatch,
  spanRef,
  textCheck,
  onClick,
  onAlign,
  onEdit,
  onSave,
}: {
  book: string;
  chapter: number;
  // Canonical verse_start for this row (used for find-cell keys + alignment).
  verseNum: number;
  // Display label — "6-9" for ranges, "7" for singletons. See formatVerseLabel.
  verseLabel: string;
  // True when verseNum is a range row (verse_end > verse). Used to style the
  // verse marker so users can tell the block spans multiple Bible verses.
  isRange: boolean;
  bibleVersion: string;
  text: string;
  content?: unknown;
  // The matching UHB/UGNT verse content_json (verse_start keyed) so the align
  // button flags a broken link when a source word lacks a target.
  sourceContent?: unknown;
  // Trailing markers drifted from the previous verse — composed at the
  // start of the rendered verseObjects so visual paragraph / poetry
  // breaks introduce this verse correctly.
  precedingMarkers?: unknown[];
  highlights?: Set<string> | null;
  // Reorder stoplight neighbour sets (green underline / red overline). Set only
  // for the active verse while a drag / recent arrow-move is live.
  prevHighlights?: Set<string> | null;
  nextHighlights?: Set<string> | null;
  isActive: boolean;
  readOnly: boolean;
  rtl: boolean;
  lexiconMap?: Map<string, LexiconEntry | null>;
  twl?: TwlRow[];
  search: SearchState | null;
  findActiveMatch: FindMatch | null;
  spanRef: React.MutableRefObject<HTMLSpanElement | null> | null;
  textCheck?: TextLaneCheck;
  onClick: () => void;
  onAlign: () => void;
  onEdit: (plain: string) => void;
  onSave: (plain: string) => void;
}) {
  const { t } = useTranslation();
  const isSource = bibleVersion === "UHB" || bibleVersion === "UGNT";
  const activeRange = useMemo<{ start: number; end: number } | null>(() => {
    if (!findActiveMatch) return null;
    if (findActiveMatch.chapter !== chapter) return null;
    if (findActiveMatch.verse !== verseNum) return null;
    if (findActiveMatch.bibleVersion !== bibleVersion) return null;
    return { start: findActiveMatch.startIndex, end: findActiveMatch.endIndex };
  }, [findActiveMatch, chapter, verseNum, bibleVersion]);
  const elRef = useRef<HTMLSpanElement | null>(null);
  const lastTextRef = useRef(text);
  // Resync tracker for the editable span. lastSetRef.current is the most
  // recent string we wrote to .textContent / .innerHTML; the reset effect
  // skips when its target matches, preserving the caret during typing.
  // Hoisted so the draft-hydration path can mark it in lockstep.
  const lastSetRef = useRef<string | null>(null);
  // Synchronous mirror of "this cell has unsaved typing." `hasDraft` is React
  // state set asynchronously from the draft subscription, so there's a window
  // right after a keystroke where it's still false. The DOM-reset effect below
  // guards on it; a parent re-render in that window (e.g. a WebSocket verse
  // update giving this verse a new prop) would otherwise re-apply the server
  // render and wipe the in-progress edit. Set true synchronously on input.
  const dirtyRef = useRef(false);
  const draftKey = useMemo(
    () => verseKey(book, chapter, verseNum, bibleVersion),
    [book, chapter, verseNum, bibleVersion],
  );
  const [hasDraft, setHasDraft] = useState(false);
  const hydratedFromDraftRef = useRef(false);
  useEffect(() => {
    if (readOnly) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- clears hasDraft when the cell turns read-only and skips the drafts-store subscription; drafts.subscribe has no getSnapshot, and its callback also hydrates the DOM once, so useSyncExternalStore would not be equivalent.
      setHasDraft(false);
      return;
    }
    return drafts.subscribe((all) => {
      const rec = all.find((d) => d.key === draftKey);
      setHasDraft(!!rec);
      // Keep the synchronous dirty mirror in lockstep with draft existence.
      dirtyRef.current = !!rec;
      // Hydrate from a PRE-EXISTING draft exactly once, on the first
      // (mount-snapshot) callback — never from a draft the user is creating
      // by typing right now. Writing to the live element mid-input resets the
      // caret, and in Firefox `textContent` set here would clobber the verse
      // the user is editing. Restore-on-mount (reload / chapter nav) is the
      // only legitimate reason to push draft text into the DOM.
      if (hydratedFromDraftRef.current) return;
      hydratedFromDraftRef.current = true;
      if (
        rec &&
        typeof (rec.payload as { plainText?: unknown }).plainText === "string" &&
        elRef.current
      ) {
        const plain = (rec.payload as { plainText: string }).plainText;
        if (elRef.current.textContent !== plain) {
          elRef.current.textContent = plain;
          lastSetRef.current = plain;
          lastTextRef.current = plain;
        }
      }
    });
  }, [draftKey, readOnly]);

  // Source-language token hits for this verse (only meaningful for UHB/UGNT
  // in non-english find modes). Drives the offset painter for UGNT and the
  // HebrewLine findHighlights set for UHB.
  const sourceHits = useMemo<SourceTokenMatch[] | null>(() => {
    if (!isSource || !search || search.sourceQuery.kind === "english") return null;
    const vo = (content as { verseObjects?: unknown[] } | null)?.verseObjects;
    if (!Array.isArray(vo)) return null;
    return matchSourceVerse(vo, search.sourceQuery);
  }, [isSource, search, content]);

  const findHighlights = useMemo<Set<HighlightKey> | null>(() => {
    if (!sourceHits || sourceHits.length === 0) return null;
    const set = new Set<HighlightKey>();
    for (const h of sourceHits) set.add(`${h.text}|${h.occurrence}`);
    return set;
  }, [sourceHits]);

  const activeFindKey = useMemo<HighlightKey | null>(() => {
    if (!activeRange || !sourceHits) return null;
    const hit = sourceHits.find((h) => h.start === activeRange.start && h.end === activeRange.end);
    return hit ? `${hit.text}|${hit.occurrence}` : null;
  }, [activeRange, sourceHits]);

  // Find marks override note highlights — same precedence as BookView.
  const findHTML = useMemo(() => {
    if (!text) return null;
    // Source-language query: ULT/UST stay clean; UGNT uses offset painter
    // (UHB renders via HebrewLine and ignores findHTML).
    if (search && search.sourceQuery.kind !== "english") {
      if (!isSource || !sourceHits || sourceHits.length === 0) return null;
      return renderFindMatchesByOffsets(text, sourceHits, activeRange);
    }
    if (!search?.re) return null;
    const out = renderFindMatchesHTML(text, search.re, activeRange);
    return out.includes("be-find") ? out : null;
  }, [search, sourceHits, text, isSource, activeRange]);

  // Stoplight role sets → render channels. undefined unless a reorder is live,
  // so the common render path is byte-identical to before the feature.
  const roles = useMemo(() => {
    if (!prevHighlights?.size && !nextHighlights?.size) return undefined;
    return { prev: prevHighlights, next: nextHighlights };
  }, [prevHighlights, nextHighlights]);

  const html = useMemo(() => {
    const verseObjects = (content as { verseObjects?: unknown[] } | null)?.verseObjects;
    // Active editable verse: surface paragraph / poetry markers as literal
    // "\p" / "\q1" chips so they can be seen and adjusted in place — same as
    // the rows view active line. Render the verse's OWN objects (not the
    // drifted-composed set) so the contentEditable's textContent matches
    // extractEditableText and the smartEditVerse save diff lines up. Only the
    // active verse gets chips; the rest of the column stays clean.
    //
    // This must win over `findHTML` even while Find is open: this cell stays
    // contentEditable throughout, and findHTML is built from marker-free
    // plain_text, so letting it win here would delete every `\q`/`\p` chip
    // from the DOM a keystroke's save capture reads (#642). Paint find
    // matches onto the chip render instead of substituting it.
    if (isActive && !readOnly && Array.isArray(verseObjects)) {
      // Find marks take precedence over note highlights while the overlay has
      // a hit here. Not cosmetic: a `<mark class="be-hl">` wrapper splits the
      // chip render into separate text runs, and overlayFindMarks refuses to
      // split a match across a run boundary, so a multi-word query spanning a
      // highlighted word would paint nothing at all.
      const findLive = !!findHTML;
      const chipHtml = renderEditableHTML(
        verseObjects,
        findLive ? new Set() : (highlights ?? new Set()),
        findLive ? undefined : roles,
      );
      if (search?.re && (!isSource || search.sourceQuery.kind === "english")) {
        return overlayFindMarks(chipHtml, search.re, activeRange);
      }
      return chipHtml;
    }
    if (findHTML) return findHTML;
    // A verse with plain_text but no content tree still paints find
    // highlighting above; only past that point is there nothing to render.
    if (!content) return null;
    if (!Array.isArray(verseObjects)) return null;
    // Compose any drifted-down markers (from the previous verse's
    // trailing `\q1`/`\p` etc.) at the front so the visual break
    // introduces this verse, matching USFM intent.
    // Strip THIS verse's own trailing markers — they drift to the next verse,
    // so rendering them here too would double a text-bearing `\qa` acrostic.
    const body = stripTrailingMarkers(verseObjects);
    const drifted = precedingMarkers && precedingMarkers.length > 0
      ? [...precedingMarkers, ...body]
      : body;
    // Render unconditionally so paragraph / poetry markers turn into
    // visual breaks / indents even without an active highlight set.
    return renderHighlightedHTML(drifted, highlights ?? new Set(), roles);
  }, [findHTML, content, highlights, precedingMarkers, isActive, readOnly, roles, search, isSource, activeRange]);

  // Resync the editable span when (a) text changes from outside and the user
  // hasn't been typing since, or (b) highlights change. We let the user type
  // freely between resyncs. On first render `lastSetRef.current` is null —
  // treat that as "always write" so the verse paints at mount time. If a
  // draft exists, leave the user's typing alone — only the save flow ever
  // overwrites the DOM during a draft session.
  useEffect(() => {
    if (!elRef.current) return;
    // dirtyRef is the synchronous guard; hasDraft (async state) can still be
    // false in the window right after a keystroke, so a WebSocket-driven prop
    // change could otherwise slip through and wipe the in-progress edit.
    if (hasDraft || dirtyRef.current) return;
    const dom = elRef.current.textContent;
    if (html !== null) {
      if (html !== lastSetRef.current) {
        // Caret-preserving: activating this verse flips `html` to chip HTML and
        // would otherwise wipe the selection the activating click just placed.
        setInnerHtmlPreservingCaret(elRef.current, html);
        lastSetRef.current = html;
        lastTextRef.current = text;
      }
      return;
    }
    // Plain-text mode.
    if (lastSetRef.current === null || dom === lastTextRef.current) {
      elRef.current.textContent = text;
      lastSetRef.current = text;
    }
    lastTextRef.current = text;
  }, [text, html, hasDraft]);

  const setMarkerRef = (node: HTMLSpanElement | null) => {
    if (spanRef) spanRef.current = node;
  };

  // When this is the active/editable verse, the editable render drops the
  // paragraph marker drifted from the previous verse. Put that marker's wrapper
  // class on the contentEditable span itself so the line break / poetry indent
  // that introduces the verse is restored from CSS — the span's text is
  // untouched, so the save diff stays correct.
  const leadingClass =
    isActive && !readOnly ? leadingBreakClass(precedingMarkers) : "";

  // Text-lane check state for this verse (when wired). The tinted underline on
  // the verse marker keeps the checked state visible even with controls hidden.
  const textShade = textCheck ? textCheck.shade(verseNum) : "open";
  const showTextCheck = !!textCheck?.canCheck && !readOnly;

  return (
    <>
    <span
      data-find-cell={`${chapter}-${verseNum}-${bibleVersion}`}
      onClick={onClick}
      style={{
        display: "inline",
        borderRadius: 4,
        padding: isActive ? "1px 2px" : 0,
        backgroundColor: isActive ? "rgba(49,173,227,0.14)" : "transparent",
        // RTL only: isolate each verse as its own bidi unit. In the continuous
        // columns flow the bare LTR verse marker ("6:3") otherwise reorders
        // against the neighboring verses' Hebrew runs and lands between the
        // start of this verse and the tail of the previous one. Isolating the
        // verse mirrors how book mode (per-verse blocks) already renders right.
        unicodeBidi: rtl ? "isolate" : undefined,
      }}
    >
      <span
        ref={setMarkerRef}
        style={{
          fontFamily: "monospace",
          fontSize: 10,
          fontWeight: isRange ? 700 : 600,
          color: isRange ? "#014263" : "#9aa0a6",
          verticalAlign: "1px",
          marginInlineEnd: 4,
          borderBottom:
            textShade !== "open" ? `2px solid ${LANE_FILL[textShade].bg}` : undefined,
        }}
      >
        {verseNum === 0 ? t("shell.intro") : `${chapter}:${verseLabel}`}
      </span>
      {!readOnly && (
        <AlignLinkButton
          targetContent={content}
          sourceContent={sourceContent}
          tooltip={t("widgets.verse.alignVerse", { verse: verseNum })}
          iconSize={14}
          sx={{ p: 0.25, verticalAlign: "-3px" }}
          onClick={(e) => {
            e.stopPropagation();
            onAlign();
          }}
        />
      )}
      {showTextCheck && (
        <Tooltip
          title={t("widgets.verse.textCheck", { attribution: textCheck!.attribution(verseNum) })}
        >
          <IconButton
            onClick={(e) => {
              e.stopPropagation();
              textCheck!.onToggle(verseNum);
            }}
            size="small"
            sx={{
              p: 0.25,
              verticalAlign: "-3px",
              borderRadius: 0.5,
              border: textShade === "open" ? "1px solid" : "none",
              borderColor: "divider",
              bgcolor: textShade === "open" ? "transparent" : LANE_FILL[textShade].bg,
              color: textShade === "open" ? "text.disabled" : LANE_FILL[textShade].fg,
              "&:hover": {
                bgcolor: textShade === "open" ? "action.hover" : LANE_FILL[textShade].bg,
              },
            }}
          >
            <CheckIcon sx={{ fontSize: 14 }} />
          </IconButton>
        </Tooltip>
      )}
      {!readOnly && hasDraft && (
        <Tooltip title={t("widgets.verse.undoVerse", { verse: verseNum })}>
          <IconButton
            onClick={(e) => {
              e.stopPropagation();
              // Drop the draft and force the DOM back to server text. Leave
              // the hydration guard set — hydration is a mount-only concern
              // (a fresh mount gets a fresh ref); re-arming it here would let
              // the next keystroke's draft stomp the live DOM again.
              void drafts.clear(draftKey);
              dirtyRef.current = false;
              if (elRef.current) {
                // Re-render from `html` when present (active verse) so the
                // USFM-code chips come back, not just marker-free plain text.
                if (html !== null) {
                  elRef.current.innerHTML = html;
                  lastSetRef.current = html;
                } else {
                  elRef.current.textContent = text;
                  lastSetRef.current = text;
                }
                lastTextRef.current = text;
              }
            }}
            size="small"
            sx={{ color: "warning.main", p: 0.25, verticalAlign: "-3px" }}
          >
            <UndoIcon sx={{ fontSize: 14 }} />
          </IconButton>
        </Tooltip>
      )}
      {!readOnly && hasDraft && (
        <Tooltip title={t("widgets.verse.saveVerse", { verse: verseNum })}>
          <IconButton
            onClick={(e) => {
              e.stopPropagation();
              onSave(lastTextRef.current);
            }}
            size="small"
            sx={{ color: "primary.main", p: 0.25, ml: 0.75, verticalAlign: "-3px" }}
          >
            <SaveIcon sx={{ fontSize: 14 }} />
          </IconButton>
        </Tooltip>
      )}{" "}
      {rtl && lexiconMap ? (
        <span
          style={{
            fontFamily: '"Times New Roman","SBL Hebrew","Cardo",serif',
            fontSize: 21,
            direction: "rtl",
            unicodeBidi: "isolate",
          }}
        >
          <HebrewLine
            verseObjects={(content as { verseObjects?: unknown[] } | null)?.verseObjects}
            lexiconMap={lexiconMap}
            twl={twl}
            verseNum={verseNum}
            highlights={highlights ?? undefined}
            prevHighlights={prevHighlights ?? undefined}
            nextHighlights={nextHighlights ?? undefined}
            findHighlights={findHighlights}
            activeFindKey={activeFindKey}
            fallbackText={text}
          />
        </span>
      ) : (
      <span
        ref={(node) => {
          elRef.current = node;
        }}
        data-dirty={hasDraft ? "true" : undefined}
        contentEditable={!readOnly}
        suppressContentEditableWarning
        spellCheck={!rtl}
        dir={rtl ? "rtl" : "ltr"}
        onInput={(e) => {
          if (readOnly) return;
          // textContent, not innerText: in Firefox `innerText` read inside the
          // input handler returns a stale/truncated value (layout not flushed),
          // which then corrupts the stored draft and the verse. textContent is
          // synchronous and reliable in both browsers (matches the rows editor).
          const value = (e.currentTarget as HTMLSpanElement).textContent ?? "";
          onEdit(value);
          lastTextRef.current = value;
          lastSetRef.current = value;
          // Mark dirty synchronously, ahead of the async draft write, so a
          // parent re-render can't reset the DOM and wipe this keystroke.
          dirtyRef.current = true;
        }}
        style={{
          outline: "none",
          background: "transparent",
        }}
        className={leadingClass ? `be-verse-span ${leadingClass}` : "be-verse-span"}
      />
      )}
    </span>
    {" "}
    </>
  );
}

function renderFindMatchesHTML(
  plainText: string,
  re: RegExp,
  activeRange?: { start: number; end: number } | null,
): string {
  let html = "";
  let lastIdx = 0;
  let m: RegExpExecArray | null;
  const local = new RegExp(re.source, re.flags);
  while ((m = local.exec(plainText)) !== null) {
    const isActive = !!activeRange && m.index === activeRange.start && m.index + m[0].length === activeRange.end;
    const cls = isActive ? "be-find be-find-active" : "be-find";
    html += escapeHtml(plainText.slice(lastIdx, m.index));
    html += `<mark class="${cls}">${escapeHtml(m[0])}</mark>`;
    lastIdx = m.index + m[0].length;
    if (m[0].length === 0) local.lastIndex++;
  }
  html += escapeHtml(plainText.slice(lastIdx));
  return html;
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>]/g, (c) => (c === "&" ? "&amp;" : c === "<" ? "&lt;" : "&gt;"));
}

// Caret-preserving innerHTML swap for the editable verse span. Activating a
// verse flips the `html` memo from clean text to chip-rendered HTML, and the
// resync effect rewrites innerHTML — which destroys the caret/selection the
// activating click just placed (the "click twice to type" bug in poetry
// chapters). Capture the caret as a character offset within textContent before
// the swap, then re-walk the new text nodes to restore a collapsed range at the
// same offset. Only acts when the element is focused and the selection lives
// inside it; otherwise it's a plain assignment, leaving IME/composition and the
// Firefox first-keystroke draft hydration untouched.
function setInnerHtmlPreservingCaret(el: HTMLElement, html: string): void {
  const sel = window.getSelection();
  const focused = document.activeElement === el;
  const inEl =
    focused &&
    sel &&
    sel.rangeCount > 0 &&
    sel.anchorNode != null &&
    el.contains(sel.anchorNode);
  if (!inEl) {
    el.innerHTML = html;
    return;
  }
  const offset = caretOffsetWithin(el, sel.getRangeAt(0));
  el.innerHTML = html;
  restoreCaretWithin(el, offset, sel);
}

// Number of textContent characters before the caret (anchor) within `el`.
function caretOffsetWithin(el: HTMLElement, range: Range): number {
  const pre = range.cloneRange();
  pre.selectNodeContents(el);
  pre.setEnd(range.startContainer, range.startOffset);
  return pre.toString().length;
}

// Place a collapsed caret `offset` characters into `el`'s text, clamped to the
// available text length.
function restoreCaretWithin(el: HTMLElement, offset: number, sel: Selection): void {
  const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
  let remaining = offset;
  let node: Node | null = walker.nextNode();
  let last: Text | null = null;
  while (node) {
    const len = node.textContent?.length ?? 0;
    last = node as Text;
    if (remaining <= len) {
      const r = document.createRange();
      r.setStart(node, remaining);
      r.collapse(true);
      sel.removeAllRanges();
      sel.addRange(r);
      return;
    }
    remaining -= len;
    node = walker.nextNode();
  }
  // Offset ran past the end (text shrank) — drop the caret at the end.
  const r = document.createRange();
  if (last) {
    r.setStart(last, last.textContent?.length ?? 0);
  } else {
    r.selectNodeContents(el);
  }
  r.collapse(true);
  sel.removeAllRanges();
  sel.addRange(r);
}
