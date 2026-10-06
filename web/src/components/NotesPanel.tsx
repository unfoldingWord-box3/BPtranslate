// NotesPanel — the translationNotes (TN) resource panel.
//
// `NotesPanelBody` is the content-only render of the Notes view: a SectionHead,
// the translation-mode stats strip, and the per-verse/whole-chapter note list.
//
// Unlike WordsPanelBody/QuestionsPanelBody, the note CARD is supplied by the
// caller via the `renderNoteCard` render-prop rather than built here. That is
// deliberate: a note card is wired to a large, delicate machinery — live
// drag-reorder state, arrow-move focus/flash, the reorder-preview effect — that
// is alignment-adjacent and must not be perturbed. Keeping that machinery (and
// `renderNoteCard`) in its existing owner and passing the renderer in leaves the
// classic Notes tab byte-identical; this component only owns the surrounding
// layout (section head, stats strip, verse grouping, empty states), lifted
// verbatim from ResourceColumn's `activeResourceTab === "notes"` block.

import { Fragment, useEffect, useRef, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import {
  Box,
  Stack,
  Typography,
  Chip,
  Button,
  Tooltip,
  LinearProgress,
  ToggleButton,
  ToggleButtonGroup,
} from "@mui/material";
import AutoAwesomeIcon from "@mui/icons-material/AutoAwesome";
import CheckIcon from "@mui/icons-material/Check";
import VerticalSplitIcon from "@mui/icons-material/VerticalSplit";
import HorizontalSplitIcon from "@mui/icons-material/HorizontalSplit";
import type { TnRow } from "../sync/api";
import { SectionHead, VerseGroupHead, type ResourceCheckoff } from "./resourcePanelShared";
import { useNotePairAxis, type NotePairAxis } from "../lib/editorPrefs";
import { NotePairAxisContext, PAIR_NARROW_PX } from "./notePairAxis";

export interface NotesPanelBodyProps {
  activeVerse: number;
  // Derived, ordered rows. `tnGroups` non-null ⇒ pinned whole-chapter view
  // (grouped by verse); null ⇒ active-verse-only view using `tnForVerse`.
  tnForVerse: TnRow[];
  tnGroups: Array<[number, TnRow[]]> | null;
  // LIVE (non-trashed) note count — the one denominator (#238). Trashed notes
  // are still listed, so `trashedTn` labels them rather than letting the badge
  // silently disagree with the number of cards on screen.
  totalTn: number;
  trashedTn?: number;
  pinned: boolean;
  onTogglePin: () => void;
  onNoteCreate: () => void;
  locked?: boolean;
  checkoff?: ResourceCheckoff;
  // Translation-mode stats strip (hidden in the English root project).
  translationMode: boolean;
  tnStats: { total: number; validated: number; draftIds: string[] };
  termsCount: number;
  onNoteApprove?: (id: string, value: boolean) => void;
  // Sequential batch approve — see Shell.tsx's handleApproveAllNotes.
  onApproveAllNotes?: () => Promise<void> | void;
  // The caller builds each note card (it owns the drag/reorder/flash state the
  // card closes over). `peers` is the row's sibling list for arrow-move bounds.
  renderNoteCard: (r: TnRow, peers: TnRow[]) => ReactNode;
  // Book-introduction notes (chapter 0), supplied by Shell only in book mode on
  // the first real chapter. Listed first: always in the pinned whole-chapter
  // view, and on the intro ("i") tile otherwise.
  bookIntroRows?: TnRow[];
}

export function NotesPanelBody({
  activeVerse,
  tnForVerse,
  tnGroups,
  totalTn,
  trashedTn = 0,
  pinned,
  onTogglePin,
  onNoteCreate,
  locked,
  checkoff,
  translationMode,
  tnStats,
  termsCount,
  onNoteApprove,
  onApproveAllNotes,
  renderNoteCard,
  bookIntroRows = [],
}: NotesPanelBodyProps) {
  const { t } = useTranslation();
  const showBookIntro = bookIntroRows.length > 0 && (tnGroups !== null || activeVerse === 0);
  // Guards against a double-click firing a second overlapping batch while
  // the first is still sequentially awaiting each row (#412).
  const [approvingAll, setApprovingAll] = useState(false);

  // The source→draft pair axis is a GLOBAL preference (see editorPrefs), so
  // this pane both hosts the control and publishes the result to its cards.
  const [pairAxis, setPairAxis] = useNotePairAxis();

  // …but side-by-side is unusable in a narrow column, so measure THIS pane and
  // collapse to stacked below the breakpoint. Presentation only: `pairAxis` is
  // never rewritten, so widening restores the translator's actual choice.
  const paneRef = useRef<HTMLDivElement | null>(null);
  const [narrow, setNarrow] = useState(false);
  useEffect(() => {
    const el = paneRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver((entries) => {
      const width = entries[0]?.contentRect.width ?? el.clientWidth;
      setNarrow(width < PAIR_NARROW_PX);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const effectivePairAxis: NotePairAxis =
    pairAxis === "horizontal" && narrow ? "vertical" : pairAxis;

  return (
    <Box ref={paneRef}>
      <SectionHead
        title={t("shell.notes")}
        count={totalTn}
        countNote={trashedTn ? t("shell.trashedCount", { count: trashedTn }) : undefined}
        pinned={pinned}
        onTogglePin={onTogglePin}
        onAdd={onNoteCreate}
        sticky
        hideAdd={locked}
        lane="tn"
        checkoff={checkoff}
      />
      {translationMode && (
        <Stack
          direction="row"
          spacing={1}
          alignItems="center"
          sx={{
            px: 0.5,
            py: 0.75,
            mb: 0.5,
            flexWrap: "wrap",
            rowGap: 0.75,
            borderBottom: "1px solid",
            borderColor: "divider",
          }}
        >
          <Chip
            size="small"
            color="secondary"
            variant="outlined"
            icon={<AutoAwesomeIcon sx={{ fontSize: "13px !important" }} />}
            label={t("translation.translationMode")}
            sx={{ height: 22, fontSize: 11, fontWeight: 600 }}
          />
          <Box sx={{ display: "flex", alignItems: "center", gap: 0.75, minWidth: 120, flex: 1 }}>
            <LinearProgress
              variant="determinate"
              color="success"
              value={tnStats.total ? (tnStats.validated / tnStats.total) * 100 : 0}
              sx={{ flex: 1, height: 6, borderRadius: 99, minWidth: 60 }}
            />
            <Typography variant="caption" sx={{ color: "text.secondary", fontVariantNumeric: "tabular-nums" }}>
              {tnStats.validated} / {tnStats.total}
            </Typography>
          </Box>
          <Tooltip title={t("translation.languageMemoryTip")}>
            <Typography variant="caption" sx={{ color: "text.disabled", whiteSpace: "nowrap" }}>
              🧠 {t("translation.languageMemory")}: {tnStats.validated} {t("translation.examples")} ·{" "}
              {termsCount} {t("translation.terms")}
            </Typography>
          </Tooltip>
          <Box sx={{ flex: 1 }} />
          {/* Where the English source sits relative to the draft, inside each
              note card. Global + persisted, so the choice made here follows the
              notes pane into every layout. */}
          <ToggleButtonGroup
            size="small"
            exclusive
            value={pairAxis}
            onChange={(_e, next: NotePairAxis | null) => {
              if (next) setPairAxis(next);
            }}
            aria-label={t("translation.sourceAxisLabel")}
            sx={{ "& .MuiToggleButton-root": { px: 0.75, py: 0.25, border: "1px solid" } }}
          >
            <ToggleButton value="vertical" aria-label={t("translation.sourceAxisStacked")}>
              <Tooltip title={t("translation.sourceAxisStacked")}>
                <HorizontalSplitIcon sx={{ fontSize: 15 }} />
              </Tooltip>
            </ToggleButton>
            <ToggleButton value="horizontal" aria-label={t("translation.sourceAxisSideBySide")}>
              <Tooltip
                title={
                  narrow
                    ? t("translation.sourceAxisSideBySideNarrow")
                    : t("translation.sourceAxisSideBySide")
                }
              >
                <VerticalSplitIcon sx={{ fontSize: 15, opacity: narrow ? 0.5 : 1 }} />
              </Tooltip>
            </ToggleButton>
          </ToggleButtonGroup>
          {onNoteApprove && (
            <Button
              size="small"
              variant="outlined"
              color="success"
              startIcon={<CheckIcon sx={{ fontSize: "15px !important" }} />}
              disabled={tnStats.draftIds.length === 0 || approvingAll}
              onClick={async () => {
                if (!onApproveAllNotes || approvingAll) return;
                setApprovingAll(true);
                try {
                  await onApproveAllNotes();
                } finally {
                  setApprovingAll(false);
                }
              }}
              sx={{ minWidth: 0, fontSize: 11 }}
            >
              {t("common.approveAll")} ({tnStats.draftIds.length})
            </Button>
          )}
        </Stack>
      )}
      <NotePairAxisContext.Provider value={effectivePairAxis}>
        {showBookIntro && (
          <>
            <VerseGroupHead verse={0} active={activeVerse === 0} section="notes" label={t("shell.bookIntro")} />
            {bookIntroRows.map((r) => renderNoteCard(r, bookIntroRows))}
            {/* Unpinned has no per-verse heads, so label the chapter's own intro too. */}
            {!tnGroups && tnForVerse.length > 0 && (
              <VerseGroupHead verse={0} active section="notes" />
            )}
          </>
        )}
        {tnGroups ? (
          tnGroups.length === 0 ? (
            <Typography variant="body2" color="text.disabled" sx={{ py: 1, pl: 1 }}>
              {t("shell.noNotesInChapter")}
            </Typography>
          ) : (
            tnGroups.map(([verse, rows]) => (
              <Fragment key={`tn-${verse}`}>
                <VerseGroupHead verse={verse} active={verse === activeVerse} section="notes" />
                {rows.map((r) => renderNoteCard(r, rows))}
              </Fragment>
            ))
          )
        ) : tnForVerse.length === 0 ? (
          <Typography variant="body2" color="text.disabled" sx={{ py: 1, pl: 1 }}>
            {t("shell.noNotesForVerse")}
          </Typography>
        ) : (
          tnForVerse.map((r) => renderNoteCard(r, tnForVerse))
        )}
      </NotePairAxisContext.Provider>
    </Box>
  );
}
