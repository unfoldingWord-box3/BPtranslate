// Find/replace overlay used by ScriptureColumn's book mode. Scope is the
// loaded chapter cache from useBook — chapters that haven't been pulled in
// by IntersectionObserver yet are invisible to the search until they load,
// which we surface in the result count.
//
// The regex builder escapes special characters when not in regex mode so
// "1:1" finds "1:1" literally; in regex mode we trust the user. Invalid
// patterns produce no matches and a red border on the input.

import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  Alert,
  Box,
  Checkbox,
  Dialog,
  DialogActions,
  DialogContent,
  DialogContentText,
  DialogTitle,
  FormControlLabel,
  Stack,
  TextField,
  IconButton,
  Tooltip,
  Typography,
  ToggleButton,
  Button,
} from "@mui/material";
import CloseIcon from "@mui/icons-material/Close";
import ArrowUpwardIcon from "@mui/icons-material/ArrowUpward";
import ArrowDownwardIcon from "@mui/icons-material/ArrowDownward";
import InfoOutlinedIcon from "@mui/icons-material/InfoOutlined";
import type { ChapterState } from "../hooks/useBook";
import type { TnRow, VerseDto } from "../sync/api";
import { smartReplaceVerse } from "../lib/replace";
import {
  classifySourceQuery,
  describeSourceMode,
  isBareNumberQuery,
  matchSourceVerse,
  type SourceQueryKind,
} from "../lib/sourceSearch";

// UHB / UGNT are upstream source texts — the worker returns 403 on PATCH.
// Additional versions may be text-locked via lane config (textReadOnly).
const HARDCODED_READ_ONLY_VERSIONS = new Set(["UHB", "UGNT"]);

export interface FindMatch {
  chapter: number;
  verse: number;
  bibleVersion: string;
  startIndex: number;
  endIndex: number;
  matchText: string;
}

// A translation-note hit. The TN checkbox folds the note body, support
// reference, and note id into one searchable corpus — each is distinct
// enough that a single query against all three rarely collides.
//
// Body (`field === "note"`) hits are emitted ONE PER OCCURRENCE — `start`/`end`
// index into the body string so replace can target a single instance, exactly
// like scripture matches. Structured fields (support_reference / id) are
// search-only fallbacks, emitted at most once per note, with start/end unused.
export interface NoteMatch {
  chapter: number;
  verse: number;
  noteId: string;
  field: "note" | "support_reference" | "id";
  start: number;
  end: number;
  // 0-based index of this body occurrence among the note's body matches. The
  // note card highlights its own matches in the same order, so this picks out
  // which one to emphasize ("here I am") without sharing string positions
  // (the card works on display text, the overlay on the raw body). 0 for
  // structured-field fallbacks (not highlighted).
  occurrence: number;
  matchText: string;
}

// Unified nav result: scripture (bible) hit or translation-note hit. The
// "X / Y" counter and prev/next walk this combined, chapter/verse-ordered
// list so the two scopes interleave naturally.
type SearchResult =
  | { kind: "bible"; chapter: number; verse: number; match: FindMatch }
  | { kind: "note"; chapter: number; verse: number; match: NoteMatch };

// Which corpora the find box searches. Persisted so the choice sticks across
// sessions. At least one scope is always on (toggling the last one off is a
// no-op) so the box never silently searches nothing.
const SCOPE_KEY = "be:find-scope";
type FindScope = { bible: boolean; tn: boolean };

function loadScope(): FindScope {
  try {
    const raw = localStorage.getItem(SCOPE_KEY);
    if (raw) {
      const p = JSON.parse(raw) as Partial<FindScope>;
      const bible = p.bible !== false;
      const tn = !!p.tn;
      return bible || tn ? { bible, tn } : { bible: true, tn: false };
    }
  } catch {
    /* ignore */
  }
  return { bible: true, tn: false };
}

function saveScope(s: FindScope) {
  try {
    localStorage.setItem(SCOPE_KEY, JSON.stringify(s));
  } catch {
    /* ignore */
  }
}

interface Props {
  open: boolean;
  onClose: () => void;
  // Active book code (e.g. "ZEC" / "MAT"). Used to disambiguate bare
  // Strong's queries — "559" in an OT book → H559, in an NT book → G559.
  book: string;
  // The currently-active chapter (the one the URL points at). The auto-jump
  // path uses it to avoid yanking the user across chapters on a keystroke —
  // see the clamp effect below.
  activeChapter: number;
  chapters: Map<number, ChapterState>;
  chapterList: number[];
  onLoadChapter: (ch: number) => void;
  enabledVersions: string[];
  // Replace target: caller persists the rewritten content. The overlay
  // builds the new verseObjects + plain text via smartReplaceVerse so
  // alignment is preserved whenever the find/replace word counts line up.
  onReplaceVerse: (
    chapter: number,
    verse: number,
    bibleVersion: string,
    newContent: unknown,
    newPlainText: string,
    base: VerseDto,
  ) => void;
  // Replace target for translation notes — only the note BODY is rewritten
  // (id is the primary key, support_reference is a structured rc:// link, so
  // both are off-limits). Shell carries the live row's version into the
  // outbox If-Match and dual-applies to the current chapter + book caches.
  onReplaceNote: (row: TnRow, newNote: string) => void;
  // Fires only on user-initiated navigation (find/regex/case change, prev,
  // next, replace-this). Typing in a verse cell while the overlay is open
  // reshapes the match list but should NOT pull the user away — those
  // reshapes only update the internal "X of Y" label.
  onScrollToMatch: (match: FindMatch | null) => void;
  // Lift the query state up so VerseCell can paint inline marks alongside the
  // existing note-quote highlights.
  onQueryChange: (
    query: { find: string; regex: boolean; caseSensitive: boolean; strongs: boolean } | null,
  ) => void;
  // Live accessor for the translation notes in scope — the current chapter in
  // stacked/columns mode, every loaded chapter in book mode. A getter (not a
  // prop array) so the overlay reads fresh notes on each search without
  // forcing the memoized ScriptureColumn to re-render on every note keystroke.
  searchNotes: () => TnRow[];
  // Navigate to + activate a TN match: focus its verse and note so the
  // resource column scrolls it into view.
  onScrollToNoteMatch: (chapter: number, verse: number, noteId: string) => void;
  // Lift the TN query so note cards can paint every match in their body
  // (mirrors onQueryChange for scripture). Null when TN scope is off / no query.
  onNoteQueryChange: (
    query: { find: string; regex: boolean; caseSensitive: boolean } | null,
  ) => void;
  // The active TN body match, so the matching note can emphasize that one
  // occurrence ("here I am") and scroll it into view. Null when the active
  // result isn't a replaceable note body hit.
  onActiveNoteMatchChange: (match: { noteId: string; occurrence: number } | null) => void;
  // Additional versions where text replacement is blocked (lane textReadOnly).
  // Combined with HARDCODED_READ_ONLY_VERSIONS for replace filtering.
  textLockedVersions?: Set<string>;
}

export function FindReplaceOverlay({
  open,
  onClose,
  book,
  activeChapter,
  chapters,
  chapterList,
  onLoadChapter,
  enabledVersions,
  onReplaceVerse,
  onReplaceNote,
  onScrollToMatch,
  onQueryChange,
  searchNotes,
  onScrollToNoteMatch,
  onNoteQueryChange,
  onActiveNoteMatchChange,
  textLockedVersions,
}: Props) {
  const { t } = useTranslation();
  // Combined read-only version set: hardcoded OL sources + lane-locked versions.
  const readOnlyVersions = useMemo(() => {
    if (!textLockedVersions || textLockedVersions.size === 0) return HARDCODED_READ_ONLY_VERSIONS;
    return new Set([...HARDCODED_READ_ONLY_VERSIONS, ...textLockedVersions]);
  }, [textLockedVersions]);

  const [find, setFind] = useState("");
  const [replace, setReplace] = useState("");
  const [regex, setRegex] = useState(false);
  const [caseSensitive, setCaseSensitive] = useState(false);
  const [scope, setScope] = useState<FindScope>(() => loadScope());
  // Opt-in: interpret bare-digit queries as Strong's numbers. Off by default
  // because bible text has lots of numbers ("eighth month", "1:1") and the
  // user would expect those to hit. Toggle only appears when relevant.
  const [strongs, setStrongs] = useState(false);
  const [activeIdx, setActiveIdx] = useState(0);
  const showStrongsToggle = isBareNumberQuery(find) && !regex;
  const findInputRef = useRef<HTMLInputElement | null>(null);
  const replaceInputRef = useRef<HTMLInputElement | null>(null);
  // Set right before any user action that should pull the active match
  // into view (prev/next, replace-this, find query change). The next
  // matches-reshape effect consumes the flag and fires onScrollToMatch.
  // External content edits never set this, so the user isn't yanked away
  // while they're typing.
  const wantsScrollRef = useRef(false);

  // Flip a scope checkbox. Refuse to turn the last one off (the box would
  // search nothing). Treat a scope change as user navigation so results settle
  // and we scroll to the first hit.
  const updateScope = (next: FindScope) => {
    if (!next.bible && !next.tn) return;
    setScope(next);
    saveScope(next);
    wantsScrollRef.current = true;
  };

  // Focus the find input when the overlay opens (Ctrl/Cmd+F flow).
  useEffect(() => {
    if (open) {
      findInputRef.current?.focus();
      findInputRef.current?.select();
    }
  }, [open]);

  // Clear note-highlight state when the overlay unmounts (find closed) — the
  // conditional render means the `null` branches of the lift effects won't fire
  // on the way out, so notes would keep their marks. setState fns are stable.
  useEffect(
    () => () => {
      onNoteQueryChange(null);
      onActiveNoteMatchChange(null);
    },
    [onNoteQueryChange, onActiveNoteMatchChange],
  );

  // Push query down to the caller so verse cells can paint match marks.
  // Any change to the search inputs counts as user navigation — once the
  // new matches settle, scroll to the first hit.
  useEffect(() => {
    // A new query is user navigation regardless of scope — flag the scroll
    // BEFORE the Bible-scope early return so a TN-only search (Bible unchecked,
    // TN checked) still auto-jumps to its first note hit. Only suppress when
    // there's nothing to search.
    if (open && find && (scope.bible || scope.tn)) {
      wantsScrollRef.current = true;
    }
    // Only paint scripture cells when the Bible scope is on — TN-only searches
    // shouldn't light up verse text.
    if (!open || !find || !scope.bible) {
      onQueryChange(null);
      return;
    }
    onQueryChange({ find, regex, caseSensitive, strongs });
  }, [open, find, regex, caseSensitive, strongs, scope.bible, scope.tn, onQueryChange]);

  const compiled = useMemo(() => buildSearchRegex(find, regex, caseSensitive), [find, regex, caseSensitive]);
  const regexInvalid = !!find && compiled.error;
  // In regex mode the user wants a literal JS regex against plain_text — skip
  // source-language classification so a Hebrew query in regex mode goes through
  // the existing path unmodified.
  const sourceQuery = useMemo<SourceQueryKind>(
    () => (regex ? { kind: "english" } : classifySourceQuery(find, book, strongs)),
    [find, regex, book, strongs],
  );

  // Mirror onQueryChange for notes: lift the query so note cards mark every
  // match in their body. Only when the TN scope is on (a Bible-only search
  // shouldn't light up notes), and not in source/Strong's mode (those query
  // Hebrew/Greek; English note text would never match anyway).
  useEffect(() => {
    if (!open || !find || !scope.tn || sourceQuery.kind !== "english") {
      onNoteQueryChange(null);
      return;
    }
    onNoteQueryChange({ find, regex, caseSensitive });
  }, [open, find, regex, caseSensitive, scope.tn, sourceQuery.kind, onNoteQueryChange]);

  const bibleMatches = useMemo<FindMatch[]>(() => {
    if (!open || !scope.bible) return [];
    if (sourceQuery.kind === "english" && !compiled.re) return [];
    return collectMatches(chapters, enabledVersions, compiled.re, sourceQuery);
  }, [open, scope.bible, compiled.re, sourceQuery, chapters, enabledVersions]);

  // Note matches re-read live notes via searchNotes() whenever the query
  // changes — `find`/`compiled.re` in the deps are the recompute signal.
  // `chapters` is also a dep: searchNotes() is a stable getter, so without it
  // a note mutation (delete / trash / AI-patch) wouldn't recompute and the
  // result list + "X / Y" count would go stale. Every note edit produces a new
  // ChapterPayload reference (see useChapter applyLocalRow*), so the `chapters`
  // map identity changes and this memo re-reads the fresh notes.
  // Just-replaced note bodies, keyed by note id. The scripture column is
  // memoized and ignores note edits, so in stacked/columns mode a note replace
  // doesn't re-render this overlay, and searchNotes() reads an effect-lagged
  // ref — the result list would go stale and single-replace wouldn't advance.
  // Overriding the body locally makes noteMatches recompute off this state
  // immediately (the replaced note drops out, count updates, clamp auto-jumps
  // to the next hit), independent of when the server / book cache catch up.
  // Short-lived: cleared on any query / scope change, where live data rules.
  const [noteOverrides, setNoteOverrides] = useState<Map<string, string>>(() => new Map());

  const noteMatches = useMemo<NoteMatch[]>(() => {
    if (!open || !scope.tn || !find) return [];
    return collectNoteMatches(searchNotes(), compiled.re, noteOverrides);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `chapters` is a deliberate recompute signal: searchNotes() is a stable getter, so a note edit only re-reads the notes through the new `chapters` identity (see the comment above noteOverrides).
  }, [open, scope.tn, find, compiled.re, searchNotes, chapters, noteOverrides]);

  // Merge + order both scopes by chapter then verse, bible before note within
  // the same verse, so prev/next walks the document top-to-bottom.
  const results = useMemo<SearchResult[]>(() => {
    const out: SearchResult[] = [];
    for (const m of bibleMatches)
      out.push({ kind: "bible", chapter: m.chapter, verse: m.verse, match: m });
    for (const m of noteMatches)
      out.push({ kind: "note", chapter: m.chapter, verse: m.verse, match: m });
    out.sort(
      (a, b) =>
        a.chapter - b.chapter ||
        a.verse - b.verse ||
        (a.kind === b.kind ? 0 : a.kind === "bible" ? -1 : 1) ||
        // Same verse + kind: order occurrences left-to-right by position so
        // prev/next walks instances in reading order within a verse / note.
        (a.kind === "bible" ? a.match.startIndex - (b.match as FindMatch).startIndex : a.match.start - (b.match as NoteMatch).start),
    );
    return out;
  }, [bibleMatches, noteMatches]);

  // Active scripture match (when the current result is a bible hit) — replace
  // acts on this; null while sitting on a note result.
  const activeBibleMatch =
    results[activeIdx]?.kind === "bible"
      ? (results[activeIdx] as Extract<SearchResult, { kind: "bible" }>).match
      : null;

  // Replace must target exactly ONE corpus — find may span both, but mixing
  // scripture (alignment-bearing USFM) and notes (plain TSV text) in a single
  // replace pass is confusing and error-prone. With both scopes on, replace is
  // gated off and the user is told to pick one. null === "both selected".
  const replaceScope: "bible" | "tn" | null =
    scope.bible && scope.tn ? null : scope.bible ? "bible" : "tn";

  // Notes live in tab-separated, newline-delimited TSV; line breaks are stored
  // as the literal two-char `\n` escape, never a raw control char. A tab or raw
  // newline in the replacement would shift columns / split rows on export and
  // silently corrupt the file, so block it for note replaces. (Scripture goes
  // through smartReplaceVerse → normalize(), which collapses such chars, so the
  // guard only matters for the TN scope.)
  const replaceHasControlChars = /[\t\r\n]/.test(replace);
  const replaceBlockedByChars = replaceScope === "tn" && replaceHasControlChars;

  // The active result is a replaceable note iff its body (not id / SR) matched.
  // collectNoteMatches checks fields in [note, support_reference, id] order and
  // records the first hit, so field === "note" means the note body contains the
  // match; anything else means only a structured field did (off-limits).
  const activeNoteReplaceable =
    replaceScope === "tn" &&
    results[activeIdx]?.kind === "note" &&
    (results[activeIdx] as Extract<SearchResult, { kind: "note" }>).match.field === "note";

  // Lift the active note body match so its card can emphasize that one
  // occurrence ("here I am"). Tracks the active result continuously (nav,
  // reshape, scope change) so the orange mark follows prev/next.
  useEffect(() => {
    const r = results[activeIdx];
    if (open && scope.tn && r?.kind === "note" && r.match.field === "note") {
      onActiveNoteMatchChange({ noteId: r.match.noteId, occurrence: r.match.occurrence });
    } else {
      onActiveNoteMatchChange(null);
    }
  }, [open, scope.tn, results, activeIdx, onActiveNoteMatchChange]);

  // Route the active result to the right surface: scripture cells scroll +
  // highlight via onScrollToMatch; notes navigate + activate via
  // onScrollToNoteMatch (and clear any scripture active-mark).
  function navTo(idx: number) {
    const r = results[idx];
    if (!r) {
      onScrollToMatch(null);
      return;
    }
    if (r.kind === "bible") {
      onScrollToMatch(r.match);
    } else {
      onScrollToMatch(null);
      onScrollToNoteMatch(r.match.chapter, r.match.verse, r.match.noteId);
    }
  }

  // Clamp activeIdx whenever the result list reshapes. Only navigate if a user
  // action flagged that they want the scroll — ambient reshapes (external
  // typing) clamp silently.
  useEffect(() => {
    if (results.length === 0) {
      setActiveIdx(0);
      if (wantsScrollRef.current) {
        wantsScrollRef.current = false;
        onScrollToMatch(null);
      }
      return;
    }
    const idx = Math.min(activeIdx, results.length - 1);
    if (idx !== activeIdx) setActiveIdx(idx);
    if (wantsScrollRef.current) {
      wantsScrollRef.current = false;
      // Auto-jump (typing / scope toggle) must NOT trigger a disruptive
      // cross-chapter navigation. The book-intro note (chapter 0) sorts first
      // and matches common words, so the very first keystroke would otherwise
      // yank the user from the chapter they're reading over to ZEC/0. Bible
      // matches scroll in-view harmlessly and same-chapter notes just re-focus,
      // so only the cross-chapter note case is suppressed here — explicit
      // prev/next (goPrev/goNext call navTo directly) may still cross chapters
      // deliberately.
      const r = results[idx];
      const crossChapterNote = r?.kind === "note" && r.chapter !== activeChapter;
      if (!crossChapterNote) navTo(idx);
    }
    // navTo closes over the current results; onScrollToMatch is the stable
    // dep that matters here (mirrors the original effect's dep list).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [results, activeIdx, onScrollToMatch]);

  const goPrev = () => {
    if (results.length === 0) return;
    const next = (activeIdx - 1 + results.length) % results.length;
    setActiveIdx(next);
    navTo(next);
  };
  const goNext = () => {
    if (results.length === 0) return;
    const next = (activeIdx + 1) % results.length;
    setActiveIdx(next);
    navTo(next);
  };

  // Status surfaced after a replace so the user sees what happened.
  //  - bible: how many verses changed + where alignment milestones were
  //    destroyed (no inline indicator otherwise) + read-only matches skipped.
  //  - tn: how many note bodies changed, plus matches we deliberately did NOT
  //    touch — structured (id/SR-only) and any replace that would blank a note.
  // Cleared on the next find-query / scope change.
  type ReplaceSummary =
    | { scope: "bible"; versesReplaced: number; alignmentLost: number; readOnlySkipped: number }
    | {
        scope: "tn";
        matchesReplaced: number;
        notesReplaced: number;
        structuralSkipped: number;
        emptySkipped: number;
      };
  const [replaceSummary, setReplaceSummary] = useState<ReplaceSummary | null>(null);
  useEffect(() => {
    setReplaceSummary(null);
    setNoteOverrides(new Map());
  }, [find, regex, caseSensitive, scope.bible, scope.tn]);

  // Confirm gate for the bulk replace-all action (see requestReplaceAll). Holds
  // the chosen scope + a pre-counted preview so the dialog can say exactly how
  // many verses / notes are about to change.
  // `count` is the unit the dialog leads with (verses for bible, matches for
  // tn); `notes` is the number of note rows tn replace-all will write.
  const [confirmAll, setConfirmAll] = useState<
    null | { scope: "bible"; count: number } | { scope: "tn"; count: number; notes: number }
  >(null);

  const doReplaceMatch = (m: FindMatch) => {
    if (readOnlyVersions.has(m.bibleVersion)) return;
    const state = chapters.get(m.chapter);
    if (!state || state.kind !== "ready") return;
    const verse = state.data.verses[m.bibleVersion]?.[m.verse];
    if (!verse) return;
    if (!compiled.re) return;
    const text = verse.plain_text ?? "";
    const result = smartReplaceVerse(
      verse.content,
      text,
      compiled.re,
      m.startIndex,
      m.endIndex - m.startIndex,
      replace,
    );
    if (result.plainText === text) return;
    setReplaceSummary({
      scope: "bible",
      versesReplaced: 1,
      alignmentLost: result.preservedAlignment ? 0 : 1,
      readOnlySkipped: 0,
    });
    // The replace will trigger a matches reshape (the current match is
    // gone); flag the upcoming reshape so we scroll to whatever's next.
    wantsScrollRef.current = true;
    onReplaceVerse(m.chapter, m.verse, m.bibleVersion, result.content, result.plainText, verse);
  };

  const doReplaceAllBible = () => {
    if (!compiled.re || bibleMatches.length === 0) return;
    // Scripture replace-all. Group matches by verse. Re-derive matches in
    // the *current* plain text for each iteration instead of trusting
    // `startIndex` from the original collection — normalize() inside
    // smartReplaceVerse can collapse whitespace and shift the indices of every
    // later match. The original reverse-sort approach was correct only when
    // normalize was a no-op.
    const byVerse = new Map<string, FindMatch[]>();
    let readOnlySkipped = 0;
    for (const m of bibleMatches) {
      if (readOnlyVersions.has(m.bibleVersion)) {
        readOnlySkipped += 1;
        continue;
      }
      const key = `${m.chapter}|${m.verse}|${m.bibleVersion}`;
      const list = byVerse.get(key) ?? [];
      list.push(m);
      byVerse.set(key, list);
    }
    let versesReplaced = 0;
    let alignmentLost = 0;
    for (const [key, list] of byVerse) {
      const [chStr, vStr, bv] = key.split("|");
      const ch = parseInt(chStr, 10);
      const v = parseInt(vStr, 10);
      const state = chapters.get(ch);
      if (!state || state.kind !== "ready") continue;
      const verse = state.data.verses[bv]?.[v];
      if (!verse) continue;
      let content: unknown = verse.content;
      let plainText = verse.plain_text ?? "";
      // Replace one occurrence at a time, re-scanning the current plain
      // text. Cap iterations at the original match count so a runaway
      // replace pattern (where the result keeps matching the regex) can't
      // loop forever — same safety the per-verse counter gives us.
      const maxIters = list.length;
      let preservedThisVerse = true;
      for (let i = 0; i < maxIters; i++) {
        const localRe = new RegExp(compiled.re.source, compiled.re.flags);
        const next = localRe.exec(plainText);
        if (!next) break;
        const result = smartReplaceVerse(
          content,
          plainText,
          compiled.re,
          next.index,
          next[0].length,
          replace,
        );
        if (result.plainText === plainText) break;
        if (!result.preservedAlignment) preservedThisVerse = false;
        content = result.content;
        plainText = result.plainText;
      }
      if (plainText === verse.plain_text) continue;
      versesReplaced += 1;
      if (!preservedThisVerse) alignmentLost += 1;
      onReplaceVerse(ch, v, bv, content, plainText, verse);
    }
    setReplaceSummary({ scope: "bible", versesReplaced, alignmentLost, readOnlySkipped });
  };

  // ---- Translation-note replace ----------------------------------------
  // Replace acts on the note BODY only, ONE OCCURRENCE at a time: the active
  // result is a single body instance (start/end), so "replace" rewrites just
  // that instance and the clamp effect advances to the next one. The override
  // map makes the list recompute immediately so positions stay correct.
  const doReplaceNoteMatch = (m: NoteMatch) => {
    if (!compiled.re || replaceBlockedByChars || m.field !== "note") return;
    const row = searchNotes().find(
      (r) => r.id === m.noteId && r.trashed_at == null && r.deleted_at == null,
    );
    if (!row) return;
    const body = noteOverrides.get(row.id) ?? row.note;
    // m.start/m.end index into this exact body (computed in the same render),
    // but guard against any drift before slicing.
    if (!body || m.start < 0 || m.end > body.length || m.start >= m.end) return;
    const newNote = body.slice(0, m.start) + replace + body.slice(m.end);
    if (newNote === body) return;
    // Never let a replace blank a note — an empty note body exports as an
    // empty TN cell and is almost never intended; skip + report instead.
    if (newNote.trim() === "") {
      setReplaceSummary({
        scope: "tn",
        matchesReplaced: 0,
        notesReplaced: 0,
        structuralSkipped: 0,
        emptySkipped: 1,
      });
      return;
    }
    wantsScrollRef.current = true;
    onReplaceNote(row, newNote);
    setNoteOverrides((prev) => new Map(prev).set(row.id, newNote));
    setReplaceSummary({
      scope: "tn",
      matchesReplaced: 1,
      notesReplaced: 1,
      structuralSkipped: 0,
      emptySkipped: 0,
    });
  };

  const doReplaceAllNotes = () => {
    if (!compiled.re || replaceBlockedByChars) return;
    let matchesReplaced = 0;
    let notesReplaced = 0;
    let emptySkipped = 0;
    const nextOverrides = new Map(noteOverrides);
    for (const n of searchNotes()) {
      if (n.trashed_at != null || n.deleted_at != null) continue;
      const body = nextOverrides.get(n.id) ?? n.note ?? "";
      if (!body) continue;
      const { text: newNote, count } = replaceAllLiteral(body, compiled.re, replace);
      if (count === 0 || newNote === body) continue;
      if (newNote.trim() === "") {
        emptySkipped += 1;
        continue;
      }
      onReplaceNote(n, newNote);
      nextOverrides.set(n.id, newNote);
      notesReplaced += 1;
      matchesReplaced += count;
    }
    // Matches that landed only in a structured field (support_reference / id)
    // are reported as deliberately untouched, mirroring read-only scripture.
    const structuralSkipped = noteMatches.filter((m) => m.field !== "note").length;
    setNoteOverrides(nextOverrides);
    setReplaceSummary({ scope: "tn", matchesReplaced, notesReplaced, structuralSkipped, emptySkipped });
  };

  // Replace-all is gated behind a confirm dialog (it can rewrite many rows at
  // once and is intentionally the quietest button). Pre-count the affected
  // verses / notes so the dialog states the blast radius; bail without a dialog
  // when nothing would actually change.
  const requestReplaceAll = () => {
    if (replaceScope === "bible") {
      const verses = new Set<string>();
      for (const m of bibleMatches) {
        if (readOnlyVersions.has(m.bibleVersion)) continue;
        verses.add(`${m.chapter}|${m.verse}|${m.bibleVersion}`);
      }
      if (verses.size === 0) return;
      setConfirmAll({ scope: "bible", count: verses.size });
    } else if (replaceScope === "tn") {
      if (!compiled.re || replaceBlockedByChars) return;
      let matches = 0;
      let notes = 0;
      for (const n of searchNotes()) {
        if (n.trashed_at != null || n.deleted_at != null) continue;
        const body = noteOverrides.get(n.id) ?? n.note ?? "";
        if (!body) continue;
        const flags = compiled.re.flags.includes("g") ? compiled.re.flags : compiled.re.flags + "g";
        const found = body.match(new RegExp(compiled.re.source, flags));
        if (found && found.length > 0) {
          matches += found.length;
          notes += 1;
        }
      }
      if (matches === 0) return;
      setConfirmAll({ scope: "tn", count: matches, notes });
    }
  };

  const runReplaceAll = () => {
    if (confirmAll?.scope === "bible") doReplaceAllBible();
    else if (confirmAll?.scope === "tn") doReplaceAllNotes();
    setConfirmAll(null);
  };

  // Single-replace and replace-all enablement, factoring in the single-scope
  // rule and the note control-char block.
  const replaceOneEnabled = replaceBlockedByChars
    ? false
    : replaceScope === "bible"
      ? !!activeBibleMatch
      : activeNoteReplaceable;
  const replaceAllEnabled = replaceBlockedByChars
    ? false
    : replaceScope === "bible"
      ? bibleMatches.length > 0
      : replaceScope === "tn"
        ? noteMatches.length > 0
        : false;

  if (!open) return null;

  const counts = countChapterStates(chapters);

  return (
    <Box
      sx={{
        position: "sticky",
        top: 0,
        zIndex: 10,
        bgcolor: "background.paper",
        borderBottom: "1px solid",
        borderColor: "divider",
        boxShadow: "0 2px 6px rgba(0,0,0,0.06)",
        px: 1.5,
        py: 1,
      }}
    >
      <Stack direction="row" alignItems="center" spacing={1} useFlexGap flexWrap="wrap">
        <TextField
          inputRef={findInputRef}
          value={find}
          onChange={(e) => setFind(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              if (e.shiftKey) goPrev();
              else goNext();
            } else if (e.key === "Escape") {
              e.preventDefault();
              onClose();
            } else if (e.key === "Tab" && !e.shiftKey) {
              // Skip the toggles/buttons in between so Tab lands directly
              // on the replace input, matching VS Code's behaviour.
              e.preventDefault();
              replaceInputRef.current?.focus();
              replaceInputRef.current?.select();
            }
          }}
          size="small"
          placeholder={t("dialogs.findReplace.findPlaceholder")}
          error={regexInvalid}
          helperText={
            regexInvalid
              ? t("dialogs.findReplace.invalidRegex")
              : sourceQuery.kind !== "english"
                ? describeSourceMode(sourceQuery)
                : undefined
          }
          sx={{ minWidth: 240, "& .MuiFormHelperText-root": { m: 0, lineHeight: 1.2, fontFamily: "monospace", fontSize: 11 } }}
          inputProps={{ style: { fontFamily: "monospace", fontSize: 13 } }}
        />
        <Tooltip title={t("dialogs.findReplace.regexTooltip")}>
          <ToggleButton
            value="regex"
            size="small"
            selected={regex}
            onChange={() => setRegex((r) => !r)}
            sx={{ px: 1, fontFamily: "monospace", fontSize: 12, textTransform: "none" }}
          >
            .*
          </ToggleButton>
        </Tooltip>
        <Tooltip title={t("dialogs.findReplace.caseTooltip")}>
          <ToggleButton
            value="case"
            size="small"
            selected={caseSensitive}
            onChange={() => setCaseSensitive((c) => !c)}
            sx={{ px: 1, fontFamily: "monospace", fontSize: 12, textTransform: "none" }}
          >
            Aa
          </ToggleButton>
        </Tooltip>
        {showStrongsToggle && (
          <Tooltip title={t("dialogs.findReplace.strongsTooltip")}>
            <ToggleButton
              value="strongs"
              size="small"
              selected={strongs}
              onChange={() => setStrongs((s) => !s)}
              sx={{ px: 1, fontFamily: "monospace", fontSize: 12, textTransform: "none" }}
            >
              H#
            </ToggleButton>
          </Tooltip>
        )}
        <Tooltip title={t("dialogs.findReplace.bibleScopeTooltip")}>
          <FormControlLabel
            control={
              <Checkbox
                size="small"
                checked={scope.bible}
                onChange={(e) => updateScope({ ...scope, bible: e.target.checked })}
                sx={{ p: 0.25 }}
              />
            }
            label={t("dialogs.findReplace.bibleScope")}
            sx={{ m: 0, "& .MuiFormControlLabel-label": { fontSize: 12 } }}
          />
        </Tooltip>
        <Tooltip title={t("dialogs.findReplace.tnScopeTooltip")}>
          <FormControlLabel
            control={
              <Checkbox
                size="small"
                checked={scope.tn}
                onChange={(e) => updateScope({ ...scope, tn: e.target.checked })}
                sx={{ p: 0.25 }}
              />
            }
            label={t("dialogs.findReplace.tnScope")}
            sx={{ m: 0, "& .MuiFormControlLabel-label": { fontSize: 12 } }}
          />
        </Tooltip>
        <Typography
          variant="caption"
          sx={{ fontFamily: "monospace", minWidth: 72, textAlign: "center", color: "text.secondary" }}
        >
          {results.length === 0
            ? t("dialogs.findReplace.noResults")
            : `${activeIdx + 1} / ${results.length}`}
        </Typography>
        {/* Find/next is the primary control — filled + colored so it draws the
            eye and the Enter/Shift+Enter habit, above replace and replace-all. */}
        <Box
          sx={{
            display: "inline-flex",
            borderRadius: 1,
            overflow: "hidden",
            border: "1px solid",
            borderColor: "primary.main",
            opacity: results.length === 0 ? 0.45 : 1,
          }}
        >
          <Tooltip title={t("dialogs.findReplace.prevMatch")}>
            <span>
              <IconButton
                size="small"
                onClick={goPrev}
                disabled={results.length === 0}
                sx={{
                  borderRadius: 0,
                  px: 0.75,
                  color: "primary.contrastText",
                  bgcolor: "primary.main",
                  borderRight: "1px solid",
                  borderColor: "primary.dark",
                  "&:hover": { bgcolor: "primary.dark" },
                  "&.Mui-disabled": { color: "primary.contrastText", bgcolor: "primary.main" },
                }}
              >
                <ArrowUpwardIcon fontSize="small" />
              </IconButton>
            </span>
          </Tooltip>
          <Tooltip title={t("dialogs.findReplace.nextMatch")}>
            <span>
              <IconButton
                size="small"
                onClick={goNext}
                disabled={results.length === 0}
                sx={{
                  borderRadius: 0,
                  px: 0.75,
                  color: "primary.contrastText",
                  bgcolor: "primary.main",
                  "&:hover": { bgcolor: "primary.dark" },
                  "&.Mui-disabled": { color: "primary.contrastText", bgcolor: "primary.main" },
                }}
              >
                <ArrowDownwardIcon fontSize="small" />
              </IconButton>
            </span>
          </Tooltip>
        </Box>
        <Box sx={{ flex: 1 }} />
        {chapterList.length === 1 && (
          <Tooltip title={t("dialogs.findReplace.chapterOnlyTooltip")}>
            <Typography variant="caption" sx={{ color: "text.disabled", fontFamily: "monospace", cursor: "help" }}>
              {t("dialogs.findReplace.chapterOnly")}
            </Typography>
          </Tooltip>
        )}
        {chapterList.length > 1 && (
          <Typography variant="caption" sx={{ color: "text.disabled", fontFamily: "monospace" }}>
            {t("dialogs.findReplace.scopeLoaded", {
              ready: counts.ready,
              total: chapterList.length,
            })}
          </Typography>
        )}
        {chapterList.length > 1 && counts.ready < chapterList.length && (
          <Tooltip title={t("dialogs.findReplace.loadFullBookTooltip")}>
            <Button
              size="small"
              variant="outlined"
              onClick={() => {
                for (const ch of chapterList) {
                  const cur = chapters.get(ch);
                  if (!cur || cur.kind === "unloaded") onLoadChapter(ch);
                }
              }}
              sx={{ textTransform: "none", fontSize: 11 }}
            >
              {t("dialogs.findReplace.loadFullBook")}
            </Button>
          </Tooltip>
        )}
        <Tooltip title={t("dialogs.findReplace.closeTooltip")}>
          <IconButton size="small" onClick={onClose}>
            <CloseIcon fontSize="small" />
          </IconButton>
        </Tooltip>
      </Stack>
      <Stack direction="row" alignItems="center" spacing={1} sx={{ mt: 0.75 }}>
        <TextField
          inputRef={replaceInputRef}
          value={replace}
          onChange={(e) => setReplace(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Escape") {
              e.preventDefault();
              onClose();
            } else if (e.key === "Tab" && e.shiftKey) {
              e.preventDefault();
              findInputRef.current?.focus();
              findInputRef.current?.select();
            }
          }}
          size="small"
          placeholder={t("dialogs.findReplace.replacePlaceholder")}
          disabled={replaceScope === null}
          error={replaceBlockedByChars}
          helperText={
            replaceBlockedByChars ? t("dialogs.findReplace.noControlChars") : undefined
          }
          sx={{
            minWidth: 240,
            "& .MuiFormHelperText-root": { m: 0, lineHeight: 1.2, fontFamily: "monospace", fontSize: 11 },
          }}
          inputProps={{ style: { fontFamily: "monospace", fontSize: 13 } }}
        />
        <Tooltip
          title={
            replaceScope === "tn"
              ? t("dialogs.findReplace.replaceOneTnTooltip")
              : t("dialogs.findReplace.replaceOneBibleTooltip")
          }
        >
          <span>
            <Button
              size="small"
              variant="outlined"
              onClick={() => {
                if (replaceScope === "bible") {
                  if (activeBibleMatch) doReplaceMatch(activeBibleMatch);
                } else if (replaceScope === "tn") {
                  const r = results[activeIdx];
                  if (r?.kind === "note") doReplaceNoteMatch(r.match);
                }
              }}
              disabled={!replaceOneEnabled}
              sx={{ textTransform: "none" }}
            >
              {t("dialogs.findReplace.replace")}
            </Button>
          </span>
        </Tooltip>
        <Tooltip
          title={
            replaceScope === "tn"
              ? t("dialogs.findReplace.replaceAllTnTooltip")
              : t("dialogs.findReplace.replaceAllBibleTooltip")
          }
        >
          <span>
            <Button
              size="small"
              variant="text"
              color="warning"
              onClick={requestReplaceAll}
              disabled={!replaceAllEnabled}
              sx={{ textTransform: "none", textDecoration: "underline", textUnderlineOffset: "3px" }}
            >
              {t("dialogs.findReplace.replaceAll")}
            </Button>
          </span>
        </Tooltip>
        {replaceScope === null && (
          <Typography
            variant="caption"
            sx={{ display: "flex", alignItems: "center", gap: 0.5, color: "warning.dark", fontSize: 12 }}
          >
            <InfoOutlinedIcon sx={{ fontSize: 15 }} />
            {t("dialogs.findReplace.selectSingleScope")}
          </Typography>
        )}
        {replaceScope === "tn" && !replaceBlockedByChars && (
          <Typography variant="caption" sx={{ color: "text.secondary", fontSize: 12 }}>
            {t("dialogs.findReplace.noteScopeHint")}
          </Typography>
        )}
      </Stack>
      {replaceSummary &&
        ((replaceSummary.scope === "bible" &&
          (replaceSummary.versesReplaced > 0 || replaceSummary.readOnlySkipped > 0)) ||
          (replaceSummary.scope === "tn" &&
            (replaceSummary.matchesReplaced > 0 ||
              replaceSummary.structuralSkipped > 0 ||
              replaceSummary.emptySkipped > 0))) && (
          <Alert
            severity={
              replaceSummary.scope === "bible"
                ? replaceSummary.alignmentLost > 0
                  ? "warning"
                  : "success"
                : replaceSummary.emptySkipped > 0
                  ? "warning"
                  : "success"
            }
            sx={{ mt: 0.75, py: 0.25, "& .MuiAlert-message": { py: 0.5, fontSize: 12 } }}
            onClose={() => setReplaceSummary(null)}
          >
            {replaceSummary.scope === "bible" ? (
              <>
                {t("dialogs.findReplace.summaryVerses", {
                  count: replaceSummary.versesReplaced,
                })}
                {replaceSummary.alignmentLost > 0 &&
                  t("dialogs.findReplace.summaryAlignmentLost", {
                    count: replaceSummary.alignmentLost,
                  })}
                {replaceSummary.readOnlySkipped > 0 &&
                  t("dialogs.findReplace.summaryReadOnlySkipped", {
                    count: replaceSummary.readOnlySkipped,
                  })}
              </>
            ) : (
              <>
                {t("dialogs.findReplace.summaryMatches", {
                  count: replaceSummary.matchesReplaced,
                })}
                {replaceSummary.notesReplaced > 1 &&
                  t("dialogs.findReplace.summaryInNotes", {
                    count: replaceSummary.notesReplaced,
                  })}
                {replaceSummary.structuralSkipped > 0 &&
                  t("dialogs.findReplace.summaryStructuralSkipped", {
                    count: replaceSummary.structuralSkipped,
                  })}
                {replaceSummary.emptySkipped > 0 &&
                  t("dialogs.findReplace.summaryEmptySkipped", {
                    count: replaceSummary.emptySkipped,
                  })}
              </>
            )}
          </Alert>
        )}
      <Dialog open={confirmAll !== null} onClose={() => setConfirmAll(null)} maxWidth="xs">
        <DialogTitle sx={{ fontSize: 16 }}>{t("dialogs.findReplace.confirmTitle")}</DialogTitle>
        <DialogContent>
          <DialogContentText sx={{ fontSize: 14 }}>
            {confirmAll?.scope === "bible"
              ? t("dialogs.findReplace.confirmBible", { count: confirmAll.count })
              : t("dialogs.findReplace.confirmTn", {
                  count: confirmAll?.count ?? 0,
                  notes: t("dialogs.findReplace.confirmTnNotes", {
                    count: confirmAll?.notes ?? 0,
                  }),
                })}
          </DialogContentText>
        </DialogContent>
        <DialogActions>
          <Button size="small" onClick={() => setConfirmAll(null)} sx={{ textTransform: "none" }}>
            {t("common.cancel")}
          </Button>
          <Button
            size="small"
            variant="contained"
            color="warning"
            onClick={runReplaceAll}
            sx={{ textTransform: "none" }}
          >
            {confirmAll?.scope === "bible"
              ? t("dialogs.findReplace.confirmButtonVerses", { count: confirmAll.count })
              : t("dialogs.findReplace.confirmButtonMatches", {
                  count: confirmAll?.count ?? 0,
                })}
          </Button>
        </DialogActions>
      </Dialog>
    </Box>
  );
}

// ---------- helpers ----------

// Replace every regex match in a plain string with the replacement inserted
// LITERALLY (no `$1` / `$&` substitution), matching smartReplaceVerse's
// scripture semantics so notes and verses behave identically. Returns the new
// text and the number of occurrences replaced. Guards the zero-width-match case
// so an empty-matching pattern can't loop forever.
function replaceAllLiteral(
  text: string,
  re: RegExp,
  replacement: string,
): { text: string; count: number } {
  const flags = re.flags.includes("g") ? re.flags : re.flags + "g";
  const g = new RegExp(re.source, flags);
  let out = "";
  let last = 0;
  let count = 0;
  let m: RegExpExecArray | null;
  while ((m = g.exec(text)) !== null) {
    out += text.slice(last, m.index) + replacement;
    last = m.index + m[0].length;
    count += 1;
    if (m[0].length === 0) g.lastIndex++;
  }
  return { text: out + text.slice(last), count };
}

function buildSearchRegex(
  query: string,
  regex: boolean,
  caseSensitive: boolean,
): { re: RegExp | null; error: boolean } {
  if (!query) return { re: null, error: false };
  try {
    const pattern = regex ? query : query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const flags = caseSensitive ? "g" : "gi";
    return { re: new RegExp(pattern, flags), error: false };
  } catch {
    return { re: null, error: true };
  }
}

function collectMatches(
  chapters: Map<number, ChapterState>,
  enabledVersions: string[],
  re: RegExp | null,
  sourceQuery: SourceQueryKind,
): FindMatch[] {
  const out: FindMatch[] = [];
  const sourceMode = sourceQuery.kind !== "english";
  // In source mode we want to search UHB/UGNT even if the user hasn't
  // ticked them in the version toggles (in stacked mode they aren't toggle-
  // able at all, but the active verse's source row is still shown).
  const versionsToScan = sourceMode
    ? Array.from(new Set([...enabledVersions, "UHB", "UGNT"]))
    : enabledVersions;
  const chList = [...chapters.keys()].sort((a, b) => a - b);
  for (const ch of chList) {
    const state = chapters.get(ch);
    if (!state || state.kind !== "ready") continue;
    for (const bv of versionsToScan) {
      const byVerse = state.data.verses[bv];
      if (!byVerse) continue;
      const isSource = bv === "UHB" || bv === "UGNT";
      // Source-language query: only run on UHB/UGNT, skip ULT/UST entirely.
      // English query: run regex on every version's plain_text as before.
      if (sourceMode && !isSource) continue;
      const verseNums = Object.keys(byVerse).map(Number).sort((a, b) => a - b);
      for (const v of verseNums) {
        const dto = byVerse[v];
        if (sourceMode && isSource) {
          const vo = (dto.content as { verseObjects?: unknown[] } | null)?.verseObjects;
          if (!Array.isArray(vo)) continue;
          for (const m of matchSourceVerse(vo, sourceQuery as Exclude<SourceQueryKind, { kind: "english" }>)) {
            out.push({
              chapter: ch,
              verse: v,
              bibleVersion: bv,
              startIndex: m.start,
              endIndex: m.end,
              matchText: m.text,
            });
          }
          continue;
        }
        if (!re) continue;
        const text = dto.plain_text ?? "";
        if (!text) continue;
        // Use a fresh regex per verse so lastIndex doesn't bleed.
        const localRe = new RegExp(re.source, re.flags);
        let m: RegExpExecArray | null;
        while ((m = localRe.exec(text)) !== null) {
          out.push({
            chapter: ch,
            verse: v,
            bibleVersion: bv,
            startIndex: m.index,
            endIndex: m.index + m[0].length,
            matchText: m[0],
          });
          if (m[0].length === 0) localRe.lastIndex++;
        }
      }
    }
  }
  return out;
}

// Match a query against translation notes. The TN checkbox searches three
// fields per note — body, support reference, id. Body matches are emitted ONE
// PER OCCURRENCE (so prev/next + replace step instance-by-instance, like
// scripture); the body's just-replaced text is read from `noteOverrides` so the
// list refreshes immediately. support_reference / id are search-only fallbacks,
// emitted once per note and only when the body has no match — they're never
// replaced, so a per-occurrence breakdown would be noise. Trashed / deleted
// notes are skipped: they aren't shown in the resource column, so there'd be
// nothing to scroll to.
function collectNoteMatches(
  notes: TnRow[],
  re: RegExp | null,
  noteOverrides?: Map<string, string>,
): NoteMatch[] {
  if (!re) return [];
  const out: NoteMatch[] = [];
  for (const n of notes) {
    if (n.trashed_at != null || n.deleted_at != null) continue;
    const body = noteOverrides?.get(n.id) ?? n.note;
    let bodyHit = false;
    if (body) {
      // Fresh /g regex per note so lastIndex doesn't bleed across notes.
      const flags = re.flags.includes("g") ? re.flags : re.flags + "g";
      const local = new RegExp(re.source, flags);
      let m: RegExpExecArray | null;
      let occ = 0;
      while ((m = local.exec(body)) !== null) {
        out.push({
          chapter: n.chapter,
          verse: n.verse,
          noteId: n.id,
          field: "note",
          start: m.index,
          end: m.index + m[0].length,
          occurrence: occ,
          matchText: m[0],
        });
        bodyHit = true;
        occ += 1;
        if (m[0].length === 0) local.lastIndex++;
      }
    }
    if (bodyHit) continue;
    // Body didn't match — fall back to the structured fields (search-only).
    for (const field of ["support_reference", "id"] as const) {
      const value = n[field];
      if (!value) continue;
      const local = new RegExp(re.source, re.flags);
      if (local.test(value)) {
        out.push({
          chapter: n.chapter,
          verse: n.verse,
          noteId: n.id,
          field,
          start: 0,
          end: 0,
          occurrence: 0,
          matchText: value,
        });
        break;
      }
    }
  }
  return out;
}

function countChapterStates(chapters: Map<number, ChapterState>): {
  ready: number;
  total: number;
} {
  let ready = 0;
  for (const s of chapters.values()) if (s.kind === "ready") ready++;
  return { ready, total: chapters.size };
}
