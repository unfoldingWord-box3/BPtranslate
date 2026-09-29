// Verse fidelity overview — "is this verse coherent?" — ported from
// docs/mockups/book-package/verse.html onto the app's real chapter data.
//
// THE ONE DESIGN IDEA (docs/mockups/book-package/README.md): the literal and
// simplified texts are each already aligned to the SAME original words, so they
// can be JOINED on that alignment instead of merely shown side by side. Click a
// word anywhere and the same place lights up in all three texts; an original
// word that no target words render is a hole the join can simply report.
//
// Two modes, exactly as the mockup: Read (three texts as prose) and Audit (one
// row per original word, with what each lane made of it).
//
// WHAT CHANGES FROM THE MOCKUP:
//   - The mockup declared itself desktop-only below 1100px. That is a defect to
//     inherit, not a decision: here the detail area moves below the text on the
//     narrow bands (system bands only — tablet=560, md=900) and every part
//     stays reachable.
//   - Article prose (tA / tW) is not inlined. The mockup carried a build-time
//     snapshot of en_ta / en_tw; the app has its own Door43-backed viewer, so
//     the detail pane links there instead of shipping a second copy.
//   - Nothing here writes. This is a reading and checking surface; the flags
//     are observations computed from the alignment, never stored statuses and
//     never verdicts — a word the simplified text does not render is often
//     correct.
//
// `role` / `me` / `onNavigate` arrive with the shared flow-screen contract;
// verse movement stays on this screen's own hash route, so none is read here.

import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import Alert from "@mui/material/Alert";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import IconButton from "@mui/material/IconButton";
import MenuItem from "@mui/material/MenuItem";
import Select from "@mui/material/Select";
import Skeleton from "@mui/material/Skeleton";
import Stack from "@mui/material/Stack";
import ToggleButton from "@mui/material/ToggleButton";
import ToggleButtonGroup from "@mui/material/ToggleButtonGroup";
import Tooltip from "@mui/material/Tooltip";
import Typography from "@mui/material/Typography";
import useMediaQuery from "@mui/material/useMediaQuery";
import { alpha, useTheme } from "@mui/material/styles";
import ChevronLeftIcon from "@mui/icons-material/ChevronLeft";
import ChevronRightIcon from "@mui/icons-material/ChevronRight";

import { FlowHeader } from "./FlowHeader";
import { ORIGINAL_FONT_STACK, VerseDetailPane, type VerseSelection } from "./VerseDetailPane";
import {
  buildLane,
  buildResources,
  coherence,
  collectOriginalWords,
  laneTextFor,
  type CoherenceFlag,
  type LaneModel,
  type OriginalWord,
  type ResourceItem,
} from "./VerseSpineModel";
import type { FlowScreenContext } from "./types";

import { useChapter } from "../../hooks/useChapter";
import { useLexicon } from "../../hooks/useLexicon";
import { isTranslationProject, useProjectConfig } from "../../hooks/useProjectConfig";
import { SCRIPTURE_FONT_STACK } from "../../theme";
import type { VerseDto } from "../../sync/api";
import { isHebrewBook } from "../../lib/sourceSearch";
import { versionIsRtl, versionLabel } from "../../lib/versionLabels";
import { buildVerseIndex, noteOverlapsRange, verseObjectsOf } from "../../lib/verseRange";

export interface VerseScreenProps extends FlowScreenContext {
  book: string;
  chapter: number;
  verse: number;
}

type Mode = "read" | "audit";

// The distinct rows of one lane's expanded index that overlap [start, end], in
// verse order. `buildVerseIndex` maps every verse a row covers to the SAME DTO
// reference, so identity de-duplication is exact — a `\v 15-16` row appears
// once, not twice.
function rowsOverlapping(
  index: Record<number, VerseDto>,
  start: number,
  end: number,
): VerseDto[] {
  const out: VerseDto[] = [];
  for (let v = start; v <= end; v++) {
    const dto = index[v];
    if (dto && !out.includes(dto)) out.push(dto);
  }
  return out;
}

// One lane's verseObjects for a whole verse span, concatenated in verse order —
// the same join `concatSourceRange` performs for the aligner (see
// web/src/lib/verseRange.ts), done here over the EXPANDED index so a lane whose
// row starts before the span edge still resolves. Returns null when the lane
// has no content at all over the span, which is what makes `buildLane` report
// the lane as absent rather than empty.
function spanVerseObjects(
  index: Record<number, VerseDto>,
  start: number,
  end: number,
): unknown[] | null {
  const rows = rowsOverlapping(index, start, end);
  if (rows.length === 0) return null;
  if (rows.length === 1) return verseObjectsOf(rows[0]);
  const combined: unknown[] = [];
  for (const row of rows) {
    const vo = verseObjectsOf(row);
    if (!vo) continue;
    // Same light separator concatSourceRange uses, so consecutive verses do
    // not run together visually.
    if (combined.length > 0) combined.push({ type: "text", text: " " });
    combined.push(...vo);
  }
  return combined.length > 0 ? combined : null;
}

function activeGroupIds(lane: LaneModel, positions: Set<number>): Set<string> {
  const out = new Set<string>();
  for (const p of positions) {
    for (const r of lane.byPosition.get(p) ?? []) out.add(r.groupId);
  }
  return out;
}

export default function VerseScreen({ book, chapter, verse }: VerseScreenProps) {
  const theme = useTheme();
  const { t } = useTranslation();
  // System bands only (web/src/lib/layoutBands.ts): tablet=560, md=900.
  const isDesktop = useMediaQuery(theme.breakpoints.up("md"));
  const isTablet = useMediaQuery(theme.breakpoints.up("tablet"));

  const { status, data, error, refetch } = useChapter(book, chapter);
  const projectConfig = useProjectConfig();

  const [mode, setMode] = useState<Mode>("read");
  const [selection, setSelection] = useState<VerseSelection | null>(null);

  // A selection names words of THIS verse; stepping verses invalidates it.
  useEffect(() => {
    setSelection(null);
  }, [book, chapter, verse]);

  const sourceLane = isHebrewBook(book) ? "UHB" : "UGNT";
  const rtl = sourceLane === "UHB";
  const originalLabel = versionLabel(projectConfig, sourceLane);
  const litLabel = versionLabel(projectConfig, "ULT");
  const simLabel = versionLabel(projectConfig, "UST");
  // Target-lane direction follows the PROJECT's language (versionIsRtl), never
  // the UI chrome: an English lane must read LTR even under an Arabic UI (whose
  // document dir is rtl), and an Arabic lane must read RTL. Without an explicit
  // dir the ULT/UST word rows inherit the page direction and lay out backwards
  // (issue #449). ULT and UST share the project direction, but keep them
  // separate for parity with ScriptureColumn.
  const litRtl = versionIsRtl(projectConfig, "ULT");
  const simRtl = versionIsRtl(projectConfig, "UST");

  const sourceIndex = useMemo(
    () => buildVerseIndex(data?.verses?.[sourceLane]),
    [data, sourceLane],
  );
  const litIndex = useMemo(() => buildVerseIndex(data?.verses?.ULT), [data]);
  const simIndex = useMemo(() => buildVerseIndex(data?.verses?.UST), [data]);

  // A bridged row (`\v 15-16`) covers MORE than the routed verse, and the join
  // this whole screen rests on only holds when both sides describe the SAME
  // stretch of text: matching a two-verse English row against one verse of
  // Hebrew mis-counts every `x-occurrence` and invents "not rendered" holes.
  // So the screen widens to the span the rows actually cover — start at the
  // routed verse and grow until no lane's row crosses an edge. AlignScreen
  // does the same thing for its one target lane (buildSlice +
  // concatSourceRange); here three lanes can each bridge differently, so the
  // span is their union. The guard bounds the loop; two passes suffice in
  // practice.
  const span = useMemo(() => {
    let start = verse;
    let end = verse;
    for (let guard = 0; guard < 8; guard++) {
      let s = start;
      let e = end;
      for (const index of [sourceIndex, litIndex, simIndex]) {
        for (const dto of rowsOverlapping(index, start, end)) {
          s = Math.min(s, dto.verse);
          e = Math.max(e, dto.verse_end ?? dto.verse);
        }
      }
      if (s === start && e === end) break;
      start = s;
      end = e;
    }
    return { start, end };
  }, [sourceIndex, litIndex, simIndex, verse]);
  const bridged = span.end > span.start;

  const sourceVO = useMemo(
    () => spanVerseObjects(sourceIndex, span.start, span.end),
    [sourceIndex, span],
  );
  // `t` is a dep because collectOriginalWords bakes translated morphology
  // glosses into each word; without it a language switch leaves them stale in
  // the previous language until the verse data changes. Safe here — this memo
  // is pure derivation, no fetch (contrast the loader effects, which must NOT
  // depend on `t` or they refire on every language change).
  const words = useMemo(() => collectOriginalWords(sourceVO), [sourceVO, t]);

  const lit = useMemo(
    () => buildLane("ULT", spanVerseObjects(litIndex, span.start, span.end), sourceVO, words),
    [litIndex, span, sourceVO, words],
  );
  const sim = useMemo(
    () => buildLane("UST", spanVerseObjects(simIndex, span.start, span.end), sourceVO, words),
    [simIndex, span, sourceVO, words],
  );

  const resources = useMemo(() => {
    if (!data) return [] as ResourceItem[];
    // The words on screen are the whole span's, so the helps that belong with
    // them are every note/link/question touching any verse in the span.
    const here = (row: { verse: number; ref_raw?: string | null }) =>
      noteOverlapsRange(row, span.start, span.end);
    return buildResources(
      data.tn.filter((r) => here(r) && !r.trashed_at),
      data.twl.filter(here),
      data.tq.filter(here),
      sourceVO,
      words,
    );
  }, [data, span, sourceVO, words]);

  // Display-only derivation, so `t` belongs in the deps: the flag chips must
  // re-render in the new language. Nothing here fetches or mutates.
  const flags = useMemo(
    () => coherence(words, lit, sim, resources, t),
    [words, lit, sim, resources, t],
  );

  const strongs = useMemo(
    () => [...new Set(words.map((w) => w.strong).filter(Boolean))],
    [words],
  );
  const lexicon = useLexicon(strongs);

  // Verse list for the stepper + picker. The source lane anchors "which verses
  // exist" (it is present even when a target lane is mid-replacement); ULT is
  // the fallback.
  const verseNums = useMemo(() => {
    const ref = data?.verses?.[sourceLane] ?? data?.verses?.ULT ?? {};
    return Object.keys(ref)
      .map(Number)
      .filter((n) => n > 0)
      .sort((a, b) => a - b);
  }, [data, sourceLane]);

  // Step off the SPAN, not the routed verse: on a bridged 15-16 row, "next"
  // from 15 must reach 17, not 16 — 16 renders the identical span.
  const go = useCallback(
    (delta: number) => {
      if (verseNums.length === 0) return;
      const next =
        delta < 0
          ? [...verseNums].reverse().find((n) => n < span.start)
          : verseNums.find((n) => n > span.end);
      if (next == null) return;
      location.hash = `#/verse/${book}/${chapter}/${next}`;
    },
    [verseNums, span, book, chapter],
  );

  // ← / → step verses, r / a switch mode, Esc clears — the mockup's keys.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement | null;
      const tag = el?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || el?.isContentEditable) return;
      // MUI Select renders its trigger as a div[role="combobox"] (not a real
      // <select>) and its open popper as role="listbox"/"option" — neither is
      // caught by the tag check above.
      if (el?.closest('[role="combobox"], [role="listbox"], [role="option"]')) return;
      if (e.metaKey || e.ctrlKey || e.altKey || e.shiftKey) return;
      if (e.key === "ArrowLeft") {
        e.preventDefault();
        go(-1);
      } else if (e.key === "ArrowRight") {
        e.preventDefault();
        go(1);
      } else if (e.key === "Escape") {
        setSelection(null);
      } else if (e.key === "r" || e.key === "a") {
        setMode(e.key === "a" ? "audit" : "read");
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [go]);

  // --- selection → highlight sets ------------------------------------------
  const selectedPositions = useMemo(() => {
    if (!selection) return new Set<number>();
    if (selection.kind === "word") return new Set(selection.positions);
    const item = resources.find((r) => r.key === selection.key);
    return new Set(item?.positions ?? []);
  }, [selection, resources]);

  const litOn = useMemo(() => activeGroupIds(lit, selectedPositions), [lit, selectedPositions]);
  const simOn = useMemo(() => activeGroupIds(sim, selectedPositions), [sim, selectedPositions]);

  // Words carrying a note or a term link get a quiet underline, so the reader
  // can see where the helps attach before clicking anything.
  const markedPositions = useMemo(() => {
    const s = new Set<number>();
    for (const r of resources) {
      if (r.kind === "tq") continue;
      for (const p of r.positions) s.add(p);
    }
    return s;
  }, [resources]);

  const selectWord = useCallback((positions: number[]) => {
    setSelection(positions.length ? { kind: "word", positions } : null);
  }, []);

  const selectGroup = useCallback(
    (lane: LaneModel, groupId: string | null) => {
      if (!groupId) {
        // A supplied word — no original behind it, so nothing to anchor to.
        setSelection(null);
        return;
      }
      selectWord(lane.positionsByGroup.get(groupId) ?? []);
    },
    [selectWord],
  );

  // --- states ---------------------------------------------------------------
  // "ZEC 1:15-16" when a row bridges — the label must name what is on screen.
  const refLabel = `${book} ${chapter}:${bridged ? `${span.start}-${span.end}` : verse}`;

  const { skip } = theme.palette.flows;
  // Chevrons point along the reading direction, so they flip under an RTL UI
  // (the scripture screen's scaleX pattern).
  const chevronFlip = theme.direction === "rtl" ? { transform: "scaleX(-1)" } : undefined;
  // "ZEC 1:3 · EN to العربية" — the shared flow-screen subtitle, with the verse
  // (or the bridged span) in the chapter slot so the title row names what is
  // on screen.
  const chapterVerse = `${chapter}:${bridged ? `${span.start}-${span.end}` : verse}`;
  const targetLabel = projectConfig?.languageName || t("flowTranslate.targetFallback");
  const sub = isTranslationProject(projectConfig)
    ? t("flowTranslate.subtitleTranslation", {
        book,
        chapter: chapterVerse,
        source: (projectConfig?.translationSource?.languageCode ?? "en").toUpperCase(),
        target: targetLabel,
      })
    : t("flowTranslate.subtitle", { book, chapter: chapterVerse, target: targetLabel });
  const verseIndex = verseNums.indexOf(span.start);

  const verseSelect = (
    <Select
      size="small"
      value={verseNums.includes(verse) ? String(verse) : ""}
      onChange={(e) => {
        const v = Number(e.target.value);
        if (v) location.hash = `#/verse/${book}/${chapter}/${v}`;
      }}
      displayEmpty
      inputProps={{ "aria-label": t("flowVerse.verse.goToVerse") }}
      sx={{ flex: "none", fontSize: "0.82rem", "& .MuiSelect-select": { paddingBlock: 0.5 } }}
    >
      {verseNums.length === 0 && (
        <MenuItem value="">
          <em>{t("flowVerse.verse.noVersesLoaded")}</em>
        </MenuItem>
      )}
      {verseNums.map((v) => (
        <MenuItem key={v} value={String(v)}>
          {book} {chapter}:{v}
        </MenuItem>
      ))}
    </Select>
  );

  const modeToggle = (
    <ToggleButtonGroup
      size="small"
      exclusive
      value={mode}
      onChange={(_e, v) => v && setMode(v as Mode)}
      aria-label={t("flowVerse.verse.viewAria")}
      sx={{ flex: "none" }}
    >
      <ToggleButton value="read" sx={{ minBlockSize: 32, paddingInline: 1.5, fontSize: "0.78rem" }}>
        {t("flowVerse.verse.modeRead")}
      </ToggleButton>
      <ToggleButton value="audit" sx={{ minBlockSize: 32, paddingInline: 1.5, fontSize: "0.78rem" }}>
        {t("flowVerse.verse.modeAudit")}
      </ToggleButton>
    </ToggleButtonGroup>
  );

  // One title row, rendered into the global flow bar via FlowHeader (#299) —
  // the same idiom as TranslateNotesScreen / PackageHubScreen, replacing the
  // retired pill-bar nav and the old bespoke toolbar. The verse stepper stays in
  // the row at every width; the verse picker and the Read/Audit switch join it
  // on the desk (md+) and move to the top of the text column below that, where
  // the shared row has no room to spare.
  const header = (
    <FlowHeader>
      <Box sx={{ maxWidth: 1440, mx: "auto", paddingInline: 2, paddingBlock: 1.5 }}>
        <Stack direction="row" alignItems="center" spacing={1.25}>
          <IconButton
            aria-label={t("flowTranslate.backToPackage", { book })}
            onClick={() => {
              location.hash = `#/package/${book}`;
            }}
            sx={{ bgcolor: skip.soft, width: 34, height: 34, flex: "none" }}
          >
            <ChevronLeftIcon fontSize="small" sx={chevronFlip} />
          </IconButton>
          <Box sx={{ minWidth: 0 }}>
            <Typography component="h1" sx={{ fontSize: "1.0625rem", fontWeight: 700, m: 0 }}>
              {t("flowVerse.hub.verseView")}
            </Typography>
            <Typography variant="caption" color="text.secondary" component="p" sx={{ m: 0 }}>
              {sub}
            </Typography>
          </Box>
          <Box sx={{ flex: 1 }} />
          {isTablet && verseIndex >= 0 && (
            <Typography
              variant="body2"
              sx={{
                fontWeight: 600,
                color: "text.secondary",
                fontVariantNumeric: "tabular-nums",
                whiteSpace: "nowrap",
              }}
            >
              {t("flowScripture.verseOfTotal", { n: verseIndex + 1, total: verseNums.length })}
            </Typography>
          )}
          <Stack direction="row" spacing={0.75} alignItems="center" sx={{ flex: "none" }}>
            <IconButton
              aria-label={t("flowScripture.prevVerse")}
              title={t("flowVerse.verse.prevTitle")}
              size="small"
              onClick={() => go(-1)}
              disabled={verseNums.length === 0 || span.start <= verseNums[0]}
              sx={{ bgcolor: skip.soft, width: 30, height: 30, flex: "none" }}
            >
              <ChevronLeftIcon fontSize="small" sx={chevronFlip} />
            </IconButton>
            {isDesktop && verseSelect}
            <IconButton
              aria-label={t("flowScripture.nextVerse")}
              title={t("flowVerse.verse.nextTitle")}
              size="small"
              onClick={() => go(1)}
              disabled={verseNums.length === 0 || span.end >= verseNums[verseNums.length - 1]}
              sx={{ bgcolor: skip.soft, width: 30, height: 30, flex: "none" }}
            >
              <ChevronRightIcon fontSize="small" sx={chevronFlip} />
            </IconButton>
          </Stack>
          {isDesktop && modeToggle}
        </Stack>
      </Box>
    </FlowHeader>
  );

  // The mode hint and the observation chips open the text column, instead of
  // stacking a second bordered band under the title row.
  const modeLine = (
    <Box sx={{ display: "flex", alignItems: "center", gap: 1.25, flexWrap: "wrap", marginBlockEnd: 2 }}>
      {!isDesktop && (
        <Box sx={{ display: "flex", alignItems: "center", gap: 1, inlineSize: "100%" }}>
          {verseSelect}
          <Box sx={{ flex: 1 }} />
          {modeToggle}
        </Box>
      )}
      <Typography variant="body2" color="text.secondary" sx={{ fontSize: "0.78rem" }}>
        {mode === "read" ? t("flowVerse.verse.readHint") : t("flowVerse.verse.auditHint")}
      </Typography>
      <Box sx={{ flex: 1 }} />
      <FlagRow flags={flags} onPick={(f) => {
        if (!f.positions.length) return;
        setMode("audit");
        selectWord(f.positions);
      }} />
    </Box>
  );

  let body: ReactNode;
  if (status === "loading" || status === "retrying" || (status === "idle" && !data)) {
    body = (
      <Box sx={{ padding: 2.5 }}>
        <Skeleton variant="text" width={180} height={22} />
        <Skeleton variant="rectangular" height={72} sx={{ my: 1.5, borderRadius: 1 }} />
        <Skeleton variant="text" width={140} height={22} />
        <Skeleton variant="rectangular" height={56} sx={{ my: 1.5, borderRadius: 1 }} />
        <Skeleton variant="text" width={140} height={22} />
        <Skeleton variant="rectangular" height={56} sx={{ my: 1.5, borderRadius: 1 }} />
      </Box>
    );
  } else if (status === "error") {
    body = (
      <Box sx={{ padding: 2.5 }}>
        <Alert
          severity="error"
          action={
            <Button color="inherit" size="small" onClick={() => void refetch()}>
              {t("common.retry")}
            </Button>
          }
        >
          {t("flowVerse.verse.loadError", {
            book,
            chapter,
            details: error ? ` (${error})` : "",
          })}
        </Alert>
      </Box>
    );
  } else {
    const textColumn = (
      <Box
        sx={{
          minInlineSize: 0,
          overflowY: "auto",
          paddingBlock: 2,
          paddingInline: { xs: 1.5, tablet: 2.5 },
          paddingBlockEnd: 5,
        }}
      >
        {modeLine}
        {bridged && (
          <Alert severity="info" sx={{ mb: 2 }}>
            {t("flowVerse.verse.bridgedNotice", { start: span.start, end: span.end })}
          </Alert>
        )}
        {words.length === 0 && (
          <Alert severity="info" sx={{ mb: 2 }}>
            {t("flowVerse.verse.noOriginalText", { label: originalLabel, ref: refLabel })}
          </Alert>
        )}
        {mode === "read" ? (
          <ReadMode
            words={words}
            lit={lit}
            sim={sim}
            litLabel={litLabel}
            simLabel={simLabel}
            originalLabel={originalLabel}
            rtl={rtl}
            litRtl={litRtl}
            simRtl={simRtl}
            selectedPositions={selectedPositions}
            markedPositions={markedPositions}
            litOn={litOn}
            simOn={simOn}
            onSelectWord={selectWord}
            onSelectGroup={selectGroup}
          />
        ) : (
          <AuditMode
            words={words}
            lit={lit}
            sim={sim}
            litLabel={litLabel}
            simLabel={simLabel}
            resources={resources}
            rtl={rtl}
            litRtl={litRtl}
            simRtl={simRtl}
            compact={!isTablet}
            selectedPositions={selectedPositions}
            onSelectWord={selectWord}
          />
        )}
        <ResourceList
          resources={resources}
          selection={selection}
          rtl={rtl}
          compact={!isTablet}
          onSelect={setSelection}
        />
      </Box>
    );

    const detailColumn = (
      <Box
        component="aside"
        aria-label={t("flowVerse.verse.detailAria")}
        sx={{
          minInlineSize: 0,
          overflowY: "auto",
          bgcolor: "background.paper",
          borderInlineStart: isDesktop ? "1px solid" : "none",
          borderBlockStart: isDesktop ? "none" : "1px solid",
          borderColor: "divider",
          paddingBlock: 2,
          paddingInline: { xs: 1.5, tablet: 2.25 },
          paddingBlockEnd: 5,
        }}
      >
        <VerseDetailPane
          refLabel={refLabel}
          selection={selection}
          words={words}
          lit={lit}
          sim={sim}
          litLabel={litLabel}
          simLabel={simLabel}
          originalLabel={originalLabel}
          resources={resources}
          lexicon={lexicon}
          rtl={rtl}
          onSelect={setSelection}
        />
      </Box>
    );

    body = isDesktop ? (
      <Box
        component="main"
        sx={{
          display: "grid",
          gridTemplateColumns: "minmax(0, 1fr) 440px",
          minBlockSize: 520,
          // The shared title bar (~70px) and the footer note sit outside this
          // grid; the two bands that used to stack above it are gone (#477).
          blockSize: "calc(100dvh - 150px)",
        }}
      >
        {textColumn}
        {detailColumn}
      </Box>
    ) : (
      <Box component="main">
        {textColumn}
        {detailColumn}
      </Box>
    );
  }

  return (
    <Box sx={{ display: "flex", flexDirection: "column", minBlockSize: "100%" }}>
      {header}
      {body}
      <Typography
        variant="caption"
        component="p"
        color="text.secondary"
        sx={{ paddingBlock: 2, paddingInline: { xs: 1.5, tablet: 2.5 }, maxInlineSize: 900 }}
      >
        {t("flowVerse.verse.footerNote")}
      </Typography>
    </Box>
  );
}

// ─── flags ──────────────────────────────────────────────────────────────────

function FlagRow({
  flags,
  onPick,
}: {
  flags: CoherenceFlag[];
  onPick: (f: CoherenceFlag) => void;
}) {
  const theme = useTheme();
  if (flags.length === 0) return null;
  const paint = (level: CoherenceFlag["level"]) => {
    if (level === "ok") return { bg: theme.palette.flows.ok.soft, fg: theme.palette.flows.ok.ink };
    if (level === "attention")
      return { bg: theme.palette.flows.warn.soft, fg: theme.palette.flows.warn.ink };
    return {
      bg: alpha(theme.palette.primary.main, theme.palette.mode === "dark" ? 0.26 : 0.18),
      fg: theme.palette.mode === "dark" ? theme.palette.primary.light : theme.palette.primary.dark,
    };
  };
  return (
    <Box sx={{ display: "flex", gap: 0.75, flexWrap: "wrap" }}>
      {flags.map((f) => {
        const { bg, fg } = paint(f.level);
        const clickable = f.positions.length > 0;
        return (
          <Tooltip key={f.id} title={f.detail}>
            <Box
              component="button"
              type="button"
              onClick={() => onPick(f)}
              aria-disabled={!clickable}
              sx={{
                appearance: "none",
                border: 0,
                font: "inherit",
                fontSize: "0.72rem",
                fontWeight: 600,
                display: "inline-flex",
                alignItems: "center",
                gap: 0.625,
                minBlockSize: 24,
                paddingBlock: 0.375,
                paddingInline: 1.125,
                borderRadius: 999,
                bgcolor: bg,
                color: fg,
                cursor: clickable ? "pointer" : "default",
                textAlign: "start",
              }}
            >
              {f.level === "ok" ? `✓ ${f.label}` : f.label}
              {clickable ? ` · ${f.positions.length}` : ""}
            </Box>
          </Tooltip>
        );
      })}
    </Box>
  );
}

// ─── read mode ──────────────────────────────────────────────────────────────

function LaneLabel({ children }: { children: ReactNode }) {
  return (
    <Typography
      variant="caption"
      component="p"
      sx={{
        fontWeight: 700,
        letterSpacing: "0.08em",
        textTransform: "uppercase",
        color: "text.secondary",
        marginBlockEnd: 0.75,
      }}
    >
      {children}
    </Typography>
  );
}

function ReadMode({
  words,
  lit,
  sim,
  litLabel,
  simLabel,
  originalLabel,
  rtl,
  litRtl,
  simRtl,
  selectedPositions,
  markedPositions,
  litOn,
  simOn,
  onSelectWord,
  onSelectGroup,
}: {
  words: OriginalWord[];
  lit: LaneModel;
  sim: LaneModel;
  litLabel: string;
  simLabel: string;
  originalLabel: string;
  rtl: boolean;
  litRtl: boolean;
  simRtl: boolean;
  selectedPositions: Set<number>;
  markedPositions: Set<number>;
  litOn: Set<string>;
  simOn: Set<string>;
  onSelectWord: (positions: number[]) => void;
  onSelectGroup: (lane: LaneModel, groupId: string | null) => void;
}) {
  const theme = useTheme();
  const { t } = useTranslation();
  const hl = alpha(theme.palette.primary.main, theme.palette.mode === "dark" ? 0.26 : 0.18);

  return (
    <Box sx={{ marginBlockEnd: 3 }}>
      {/* The original is the SOURCE the two lanes below translate, not a third
          translation: a tinted panel with a rule under it and a wider gap
          (32px against the 20px between the lanes) keeps it from reading as
          just another lane (#477). */}
      <Box
        sx={{
          bgcolor: "action.hover",
          borderRadius: 1.5,
          borderBlockEnd: "2px solid",
          borderColor: "divider",
          paddingBlock: 1.5,
          paddingInline: 1.5,
          marginBlockEnd: 4,
        }}
      >
        <LaneLabel>{t("flowVerse.section.original", { label: originalLabel })}</LaneLabel>
        {words.length === 0 ? (
          <Typography variant="body2" color="text.secondary" sx={{ fontStyle: "italic" }}>
            {t("flowVerse.verse.noOriginalWords")}
          </Typography>
        ) : (
          <Box
            dir={rtl ? "rtl" : "ltr"}
            sx={{
              fontFamily: ORIGINAL_FONT_STACK,
              fontSize: "1.55rem",
              lineHeight: 2.05,
              textAlign: "start",
            }}
          >
            {words.map((w) => (
              <Box
                key={w.position}
                component="button"
                type="button"
                onClick={() => onSelectWord([w.position])}
                title={[w.lemma, w.glosses.join(" · ")].filter(Boolean).join("  ·  ")}
                sx={{
                  appearance: "none",
                  border: 0,
                  background: selectedPositions.has(w.position) ? hl : "transparent",
                  boxShadow: selectedPositions.has(w.position)
                    ? `inset 0 -2px 0 ${theme.palette.primary.main}`
                    : markedPositions.has(w.position)
                      ? `inset 0 -2px 0 ${theme.palette.flows.ok.main}`
                      : "none",
                  font: "inherit",
                  color: "text.primary",
                  cursor: "pointer",
                  borderRadius: 1,
                  paddingInline: 0.375,
                  marginInlineEnd: 0.5,
                  "&:hover, &:focus-visible": { bgcolor: "action.hover" },
                }}
              >
                {w.text}
              </Box>
            ))}
          </Box>
        )}
      </Box>

      <LaneLabel>{t("flowVerse.section.literal", { label: litLabel })}</LaneLabel>
      <Prose lane={lit} on={litOn} onSelectGroup={onSelectGroup} laneName={litLabel} rtl={litRtl} />

      <LaneLabel>{t("flowVerse.section.simplified", { label: simLabel })}</LaneLabel>
      <Prose lane={sim} on={simOn} onSelectGroup={onSelectGroup} laneName={simLabel} rtl={simRtl} />
    </Box>
  );
}

function Prose({
  lane,
  on,
  laneName,
  rtl,
  onSelectGroup,
}: {
  lane: LaneModel;
  on: Set<string>;
  laneName: string;
  rtl: boolean;
  onSelectGroup: (lane: LaneModel, groupId: string | null) => void;
}) {
  const theme = useTheme();
  const { t } = useTranslation();
  const hl = alpha(theme.palette.primary.main, theme.palette.mode === "dark" ? 0.26 : 0.18);

  if (!lane.present) {
    return (
      <Typography variant="body2" color="text.secondary" sx={{ fontStyle: "italic", mb: 2.5 }}>
        {t("flowScripture.laneNoText", { lane: laneName })}
      </Typography>
    );
  }
  if (lane.prose.length === 0) {
    return (
      <Typography variant="body2" color="text.secondary" sx={{ fontStyle: "italic", mb: 2.5 }}>
        {t("flowVerse.verse.laneRowNoText", { lane: laneName })}
      </Typography>
    );
  }

  return (
    <Box
      dir={rtl ? "rtl" : "ltr"}
      sx={{
        fontFamily: SCRIPTURE_FONT_STACK,
        fontSize: "1.06rem",
        lineHeight: 1.62,
        textAlign: "start",
        marginBlockEnd: 2.5,
      }}
    >
      {lane.prose.map((tok, i) =>
        tok.kind === "text" ? (
          <span key={`t${i}`}>{tok.text}</span>
        ) : (
          <Box
            key={tok.id}
            component="button"
            type="button"
            onClick={() => onSelectGroup(lane, tok.groupId)}
            sx={{
              appearance: "none",
              border: 0,
              font: "inherit",
              // A word with no original behind it — supplied by the
              // translator. Marked quietly, because it is information, not a
              // fault.
              color: tok.groupId ? "text.primary" : "text.secondary",
              background: tok.groupId && on.has(tok.groupId) ? hl : "transparent",
              boxShadow:
                tok.groupId && on.has(tok.groupId)
                  ? `inset 0 -2px 0 ${theme.palette.primary.main}`
                  : "none",
              borderRadius: 0.5,
              padding: 0,
              cursor: "pointer",
              "&:hover, &:focus-visible": { bgcolor: "action.hover" },
            }}
          >
            {tok.text}
          </Box>
        ),
      )}
    </Box>
  );
}

// ─── audit mode ─────────────────────────────────────────────────────────────

function AuditMode({
  words,
  lit,
  sim,
  litLabel,
  simLabel,
  resources,
  rtl,
  litRtl,
  simRtl,
  compact,
  selectedPositions,
  onSelectWord,
}: {
  words: OriginalWord[];
  lit: LaneModel;
  sim: LaneModel;
  litLabel: string;
  simLabel: string;
  resources: ResourceItem[];
  rtl: boolean;
  litRtl: boolean;
  simRtl: boolean;
  compact: boolean;
  selectedPositions: Set<number>;
  onSelectWord: (positions: number[]) => void;
}) {
  const theme = useTheme();
  const { t } = useTranslation();
  const hl = alpha(theme.palette.primary.main, theme.palette.mode === "dark" ? 0.26 : 0.18);

  const notesAt = useMemo(() => {
    const m = new Map<number, ResourceItem[]>();
    for (const r of resources) {
      if (r.kind === "tq") continue;
      for (const p of r.positions) {
        const list = m.get(p);
        if (list) list.push(r);
        else m.set(p, [r]);
      }
    }
    return m;
  }, [resources]);

  if (words.length === 0) {
    return (
      <Typography variant="body2" color="text.secondary" sx={{ fontStyle: "italic", mb: 2.5 }}>
        {t("flowVerse.verse.noSpineRows")}
      </Typography>
    );
  }

  const th = {
    textAlign: "start" as const,
    fontSize: "0.66rem",
    fontWeight: 700,
    letterSpacing: "0.08em",
    textTransform: "uppercase" as const,
    color: theme.palette.text.secondary,
    paddingBlock: 0.75,
    paddingInline: 1.25,
    borderBlockEnd: `1px solid ${theme.palette.divider}`,
    position: "sticky" as const,
    insetBlockStart: 0,
    background: theme.palette.background.default,
  };
  const td = {
    paddingBlock: 0.875,
    paddingInline: 1.25,
    borderBlockEnd: `1px solid ${theme.palette.divider}`,
    verticalAlign: "baseline" as const,
  };
  // The original column is the source the other two translate: a rule and
  // extra room on the side facing the literal column set it apart (#477).
  // That side is the TABLE's inline-end, but a cell carrying its own `dir`
  // (the original column does) resolves logical sides against that dir — so
  // when the cell's direction differs from the page's, the side flips.
  const sourceCol = (cellRtl: boolean) =>
    cellRtl === (theme.direction === "rtl")
      ? { borderInlineEnd: `1px solid ${theme.palette.divider}`, paddingInlineEnd: 2 }
      : { borderInlineStart: `1px solid ${theme.palette.divider}`, paddingInlineStart: 2 };

  let prevLit: string | null = null;
  let prevSim: string | null = null;

  const cell = (text: string, prev: string | null) => {
    if (!text) {
      return (
        <Box
          component="span"
          sx={{
            fontSize: "0.72rem",
            fontWeight: 600,
            color: theme.palette.flows.warn.ink,
            bgcolor: theme.palette.flows.warn.soft,
            borderRadius: 999,
            paddingBlock: "1px",
            paddingInline: 1,
          }}
        >
          {t("flowVerse.notRendered")}
        </Box>
      );
    }
    // A rendering repeated from the row above is a restructure, not a second
    // translation — say so instead of printing the same phrase twice.
    if (text === prev) {
      return (
        <Box component="span" sx={{ fontSize: "0.7rem", fontStyle: "italic", color: "text.secondary" }}>
          {t("flowVerse.verse.samePhrase")}
        </Box>
      );
    }
    return text;
  };

  return (
    <Box sx={{ marginBlockEnd: 3, overflowX: "auto" }}>
      <Box component="table" sx={{ inlineSize: "100%", borderCollapse: "collapse", fontSize: "0.85rem" }}>
        <thead>
          <tr>
            <Box component="th" sx={{ ...th, ...sourceCol(theme.direction === "rtl"), inlineSize: "24%" }}>
              {t("flowVerse.verse.colOriginal")}
            </Box>
            <Box component="th" sx={{ ...th, inlineSize: "30%" }}>
              {t("flowVerse.section.literal", { label: litLabel })}
            </Box>
            <Box component="th" sx={{ ...th, inlineSize: "34%" }}>
              {t("flowVerse.section.simplified", { label: simLabel })}
            </Box>
            <Box
              component="th"
              sx={{ ...th, inlineSize: "12%", textAlign: "end", whiteSpace: "nowrap" }}
            >
              {t("flowVerse.verse.notesAndTermsAria")}
            </Box>
          </tr>
        </thead>
        <tbody>
          {words.map((w) => {
            const litText = lit.present ? laneTextFor(lit, w.position) : "";
            const simText = sim.present ? laneTextFor(sim, w.position) : "";
            const litCell = lit.present ? cell(litText, prevLit) : "—";
            const simCell = sim.present ? cell(simText, prevSim) : "—";
            prevLit = litText;
            prevSim = simText;
            const marks = notesAt.get(w.position) ?? [];
            const selected = selectedPositions.has(w.position);
            return (
              <Box
                component="tr"
                key={w.position}
                onClick={() => onSelectWord([w.position])}
                aria-selected={selected}
                sx={{
                  cursor: "pointer",
                  "& > td": { background: selected ? hl : "transparent" },
                  "&:hover > td": { background: selected ? hl : theme.palette.action.hover },
                }}
              >
                <Box
                  component="td"
                  dir={rtl ? "rtl" : "ltr"}
                  sx={{
                    ...td,
                    ...sourceCol(rtl),
                    fontFamily: ORIGINAL_FONT_STACK,
                    fontSize: "1.18rem",
                    lineHeight: 1.7,
                    textAlign: "start",
                  }}
                >
                  {w.text}
                </Box>
                <Box
                  component="td"
                  dir={litRtl ? "rtl" : "ltr"}
                  sx={{ ...td, fontFamily: SCRIPTURE_FONT_STACK, textAlign: "start" }}
                >
                  {litCell}
                </Box>
                <Box
                  component="td"
                  dir={simRtl ? "rtl" : "ltr"}
                  sx={{ ...td, fontFamily: SCRIPTURE_FONT_STACK, textAlign: "start", color: "text.secondary" }}
                >
                  {simCell}
                </Box>
                <Box component="td" sx={{ ...td, textAlign: "end", whiteSpace: "nowrap" }}>
                  {compact
                    ? marks.length > 0 && (
                        <Box component="span" sx={{ fontSize: "0.66rem", color: "text.secondary" }}>
                          {marks.length}
                        </Box>
                      )
                    : marks.map((r) => (
                        <Box
                          key={r.key}
                          component="span"
                          title={r.tag}
                          sx={{
                            display: "inline-block",
                            fontSize: "0.66rem",
                            fontWeight: 700,
                            paddingBlock: "1px",
                            paddingInline: 0.75,
                            borderRadius: 999,
                            marginInlineStart: 0.5,
                            bgcolor:
                              r.kind === "twl"
                                ? theme.palette.flows.ok.soft
                                : alpha(
                                    theme.palette.primary.main,
                                    theme.palette.mode === "dark" ? 0.26 : 0.18,
                                  ),
                            color:
                              r.kind === "twl"
                                ? theme.palette.flows.ok.ink
                                : theme.palette.mode === "dark"
                                  ? theme.palette.primary.light
                                  : theme.palette.primary.dark,
                          }}
                        >
                          {r.kind === "twl" ? "W" : "N"}
                        </Box>
                      ))}
                </Box>
              </Box>
            );
          })}
        </tbody>
      </Box>

      {(lit.supplied.length > 0 || sim.supplied.length > 0) && (
        <Typography variant="body2" color="text.secondary" sx={{ fontSize: "0.78rem", mt: 1.25 }}>
          {t("flowVerse.verse.suppliedPrefix")}{" "}
          {lit.supplied.length > 0 &&
            t("flowVerse.verse.suppliedLiteral", { words: lit.supplied.join(" · ") })}
          {lit.supplied.length > 0 && sim.supplied.length > 0 && " · "}
          {sim.supplied.length > 0 &&
            t("flowVerse.verse.suppliedSimplified", { words: sim.supplied.join(" · ") })}
        </Typography>
      )}
    </Box>
  );
}

// ─── resource list ──────────────────────────────────────────────────────────

function ResourceList({
  resources,
  selection,
  rtl,
  compact,
  onSelect,
}: {
  resources: ResourceItem[];
  selection: VerseSelection | null;
  rtl: boolean;
  compact: boolean;
  onSelect: (sel: VerseSelection) => void;
}) {
  const theme = useTheme();
  const { t } = useTranslation();
  const hl = alpha(theme.palette.primary.main, theme.palette.mode === "dark" ? 0.26 : 0.18);
  const currentKey = selection?.kind === "resource" ? selection.key : null;

  // `kind` is the identity (it filters the rows and keys the React list);
  // `labelKey` is display only, translated at render.
  const groups: Array<{ kind: ResourceItem["kind"]; labelKey: string }> = [
    { kind: "tn", labelKey: "shell.notes" },
    { kind: "twl", labelKey: "flowVerse.verse.groupWordLinks" },
    { kind: "tq", labelKey: "shell.questions" },
  ];

  if (resources.length === 0) {
    return (
      <Typography variant="body2" color="text.secondary" sx={{ fontSize: "0.82rem", mt: 3 }}>
        {t("flowVerse.verse.noResources")}
      </Typography>
    );
  }

  return (
    // ONE grid for the whole list, not one per row (#477): the tag, text and
    // warning tracks are defined once here and every row lays its cells into
    // them through `subgrid`, so the tag, the note text and the trailing
    // warning start at the same x on every row of every group, whatever the
    // width of one row's tag. Group labels span all three tracks. On a phone
    // the warning track is capped so its text wraps instead of taking the
    // note text's width from every row.
    <Box
      sx={{
        mt: 3,
        display: "grid",
        gridTemplateColumns: `max-content minmax(0, 1fr) ${compact ? "fit-content(72px)" : "auto"}`,
        columnGap: 1.25,
      }}
    >
      {groups.map(({ kind, labelKey }) => {
        const list = resources.filter((r) => r.kind === kind);
        if (list.length === 0) return null;
        return (
          <Box
            key={kind}
            sx={{
              gridColumn: "1 / -1",
              display: "grid",
              gridTemplateColumns: "subgrid",
              marginBlockEnd: 2.5,
            }}
          >
            <Box sx={{ gridColumn: "1 / -1" }}>
              <LaneLabel>
                {t("flowVerse.verse.groupHeading", { label: t(labelKey), n: list.length })}
              </LaneLabel>
            </Box>
            {list.map((r) => (
              <Box
                key={r.key}
                component="button"
                type="button"
                data-resource-row=""
                onClick={() => onSelect({ kind: "resource", key: r.key })}
                aria-current={currentKey === r.key}
                sx={{
                  gridColumn: "1 / -1",
                  display: "grid",
                  gridTemplateColumns: "subgrid",
                  alignItems: "baseline",
                  textAlign: "start",
                  appearance: "none",
                  border: 0,
                  borderBlockEnd: "1px solid",
                  borderColor: "divider",
                  background: currentKey === r.key ? hl : "transparent",
                  color: "inherit",
                  font: "inherit",
                  fontSize: "0.85rem",
                  minBlockSize: 34,
                  paddingBlock: 0.875,
                  paddingInline: 1,
                  cursor: "pointer",
                  "&:hover, &:focus-visible": {
                    bgcolor: currentKey === r.key ? undefined : "action.hover",
                  },
                }}
              >
                <Box
                  component="span"
                  data-resource-col="tag"
                  sx={{
                    fontSize: "0.66rem",
                    fontWeight: 700,
                    letterSpacing: "0.05em",
                    textTransform: "uppercase",
                    color: "text.secondary",
                  }}
                >
                  {r.tag}
                </Box>
                {/* The original-language quote sits on its own line above the
                    English summary: different script, font and direction, so
                    running them together on one line left no visible seam. */}
                <Box component="span" data-resource-col="text" sx={{ minInlineSize: 0 }}>
                  {r.quote && (
                    // The block line follows the page direction, so the quote
                    // starts where the summary starts; the inner span isolates
                    // the original's own direction.
                    <Box component="span" sx={{ display: "block", marginBlockEnd: 0.25 }}>
                      <Box
                        component="span"
                        dir={rtl ? "rtl" : "ltr"}
                        sx={{ fontFamily: ORIGINAL_FONT_STACK, fontSize: "1rem" }}
                      >
                        {r.quote.replace(/&/g, " … ")}
                      </Box>
                    </Box>
                  )}
                  <Box component="span" dir="auto" sx={{ display: "block", color: "text.secondary" }}>
                    {r.summary}
                  </Box>
                </Box>
                <Box
                  component="span"
                  data-resource-col="warn"
                  sx={{ fontSize: "0.72rem", color: theme.palette.flows.warn.ink }}
                >
                  {r.kind !== "tq" && r.quote && r.positions.length === 0
                    ? t("flowVerse.verse.quoteNotAnchored")
                    : ""}
                </Box>
              </Box>
            ))}
          </Box>
        );
      })}
    </Box>
  );
}
