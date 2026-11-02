// Corner stack of "save Num 20:1 ULT?" reminders for verse drafts whose
// editor is currently off-screen (different chapter, scrolled away, or
// never mounted in this mode). Subscribes to the drafts store and uses
// IntersectionObserver against the editor's `data-find-cell` attribute
// to decide what's visible.
//
// Lives bottom-left to leave bottom-right free for SyncStatusBar /
// AiCompletionToasts. Aggregates above 3 entries.

import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Alert, IconButton, Stack, Button, Box, Typography } from "@mui/material";
import CloseIcon from "@mui/icons-material/Close";
import { drafts, type DraftRecord } from "../sync/drafts";
import { outbox, type OutboxOp } from "../sync/outbox";
import { verseDraftHasActiveSave } from "../sync/draftSaveState";

const AGGREGATE_THRESHOLD = 3;

interface Props {
  // Current book. Cross-book drafts (rare) are filtered out so the toast
  // never asks the user to save a verse from a book that isn't loaded —
  // the resolution path would need the book's verse cache, which we
  // don't carry around.
  book: string;
  // Persist/save a verse draft. Shell wires this to saveVerseDraft.
  onSaveVerseDraft: (
    book: string,
    chapter: number,
    verse: number,
    bibleVersion: string,
  ) => void;
  // Optional: scroll/navigate the user to a specific draft. Stub-friendly.
  onJumpTo?: (book: string, chapter: number, verse: number, bibleVersion: string) => void;
}

export function UnsavedToasts({ book, onSaveVerseDraft, onJumpTo }: Props) {
  const { t } = useTranslation();
  const [draftList, setDraftList] = useState<DraftRecord[]>([]);
  const [ops, setOps] = useState<OutboxOp[]>([]);
  const [visibleKeys, setVisibleKeys] = useState<Set<string>>(new Set());
  const [dismissed, setDismissed] = useState<Set<string>>(new Set());
  const [expanded, setExpanded] = useState(false);

  useEffect(() => drafts.subscribe(setDraftList), []);
  useEffect(() => outbox.subscribe(setOps), []);

  // Re-arm IntersectionObservers whenever the draft set changes. Drafts
  // whose corresponding cell isn't in the DOM are treated as off-screen
  // (their editor isn't mounted in the current view).
  useEffect(() => {
    const observers: IntersectionObserver[] = [];
    const initialVisible = new Set<string>();
    for (const d of draftList) {
      if (d.quarantined) continue;
      if (d.meta.kind !== "verse") continue;
      const sel = `[data-find-cell="${d.meta.chapter}-${d.meta.verse}-${d.meta.bibleVersion}"]`;
      const el = document.querySelector<HTMLElement>(sel);
      if (!el) continue;
      // Optimistically count the cell as visible until the observer says
      // otherwise — avoids a one-frame flash of the toast on mount.
      initialVisible.add(d.key);
      const obs = new IntersectionObserver(
        (entries) => {
          for (const entry of entries) {
            setVisibleKeys((prev) => {
              const next = new Set(prev);
              if (entry.isIntersecting) next.add(d.key);
              else next.delete(d.key);
              return next;
            });
          }
        },
        { threshold: 0.05 },
      );
      obs.observe(el);
      observers.push(obs);
    }
    // eslint-disable-next-line react-hooks/set-state-in-effect -- seeds visibility from a DOM query for each draft's cell, which only exists after commit; it re-arms the IntersectionObservers on every draft-list change.
    setVisibleKeys(initialVisible);
    return () => observers.forEach((o) => o.disconnect());
  }, [draftList]);

  const offscreenDrafts = useMemo(() => {
    return draftList.filter(
      (d) =>
        !d.quarantined &&
        d.meta.kind === "verse" &&
        d.meta.book === book &&
        // A draft whose exact generation is pending/in-flight in the outbox is
        // being saved right now — nagging "Save X?" would re-enqueue the same
        // payload. Conflicted/failed saves still surface (they need action).
        !verseDraftHasActiveSave(d, ops) &&
        !visibleKeys.has(d.key) &&
        !dismissed.has(d.key),
    );
  }, [draftList, ops, visibleKeys, dismissed, book]);

  if (offscreenDrafts.length === 0) return null;

  // Aggregated chip — single toast that expands the list on click.
  if (offscreenDrafts.length > AGGREGATE_THRESHOLD && !expanded) {
    return (
      <Box
        sx={{
          position: "fixed",
          left: 12,
          bottom: 12,
          zIndex: (t) => t.zIndex.snackbar,
          maxWidth: 360,
        }}
      >
        <Alert
          severity="warning"
          variant="filled"
          sx={{ boxShadow: 3, alignItems: "center" }}
          action={
            <Button color="inherit" size="small" onClick={() => setExpanded(true)}>
              {t("widgets.toasts.review")}
            </Button>
          }
        >
          {t("widgets.toasts.unsavedOffscreen", { count: offscreenDrafts.length })}
        </Alert>
      </Box>
    );
  }

  return (
    <Box
      sx={{
        position: "fixed",
        left: 12,
        bottom: 12,
        zIndex: (t) => t.zIndex.snackbar,
        maxWidth: 360,
        pointerEvents: "none",
      }}
    >
      <Stack spacing={1} sx={{ pointerEvents: "auto" }}>
        {expanded && offscreenDrafts.length > AGGREGATE_THRESHOLD && (
          <Button
            size="small"
            variant="outlined"
            color="inherit"
            onClick={() => setExpanded(false)}
            sx={{ alignSelf: "flex-start", bgcolor: "background.paper" }}
          >
            {t("widgets.toasts.collapse")}
          </Button>
        )}
        {offscreenDrafts.map((d) => {
          if (d.meta.kind !== "verse") return null;
          const { book, chapter, verse, bibleVersion } = d.meta;
          return (
            <Alert
              key={d.key}
              severity="warning"
              variant="filled"
              sx={{ boxShadow: 3, alignItems: "center" }}
              action={
                <>
                  <Button
                    color="inherit"
                    size="small"
                    onClick={() => onSaveVerseDraft(book, chapter, verse, bibleVersion)}
                    sx={{ fontWeight: 600 }}
                  >
                    {t("common.save")}
                  </Button>
                  <IconButton
                    size="small"
                    color="inherit"
                    onClick={() =>
                      setDismissed((prev) => {
                        const next = new Set(prev);
                        next.add(d.key);
                        return next;
                      })
                    }
                    aria-label={t("widgets.toasts.dismiss")}
                  >
                    <CloseIcon fontSize="small" />
                  </IconButton>
                </>
              }
            >
              <Typography
                component="span"
                onClick={() => onJumpTo?.(book, chapter, verse, bibleVersion)}
                sx={{
                  cursor: onJumpTo ? "pointer" : "default",
                  fontFamily: "monospace",
                  fontSize: 13,
                }}
              >
                {t("widgets.toasts.saveVerseRef", {
                  book,
                  chapter,
                  verse,
                  version: bibleVersion,
                })}
              </Typography>
            </Alert>
          );
        })}
      </Stack>
    </Box>
  );
}
