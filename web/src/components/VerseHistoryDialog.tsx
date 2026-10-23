import { useEffect, useMemo, useState } from "react";
import {
  Dialog,
  DialogTitle,
  DialogContent,
  DialogActions,
  Button,
  Box,
  Typography,
  Stack,
  Chip,
  List,
  ListItemButton,
  ListItemText,
  CircularProgress,
  Alert,
  ToggleButton,
  ToggleButtonGroup,
  Tooltip,
} from "@mui/material";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import { api, type VerseHistoryEntry } from "../sync/api";
import { diffWords } from "../lib/wordDiff";
import { formatEpochSecondsDateTime } from "../lib/formatDate";

interface Props {
  open: boolean;
  book: string;
  chapter: number;
  verseNum: number;
  bibleVersion: string;
  // The live row.version — what the chip shows and what the timeline marks
  // "current".
  currentVersion: number;
  onClose: () => void;
  // Fires the chosen version's stored content + plain text back to the card,
  // which re-saves it through the normal verse pipe (alignment_edit intent) so
  // the exact tree — alignment included — is restored.
  onUseVersion: (content: unknown, plainText: string | null) => void;
}

const fmtTime = (epochSec: number) => formatEpochSecondsDateTime(epochSec);

const userLabel = (e: VerseHistoryEntry, t: TFunction) => {
  if (!e.user) return t("dialogs.history.unknownUser");
  return e.user.full_name || e.user.username || t("dialogs.history.userNumber", { id: e.user.id });
};

// edit_log.source → a short human label. AI sub-sources collapse to "AI".
// Switches on the stored source id (never on the translated label).
const sourceChip = (source: string | null, t: TFunction): string | null => {
  if (source === "ai_pipeline" || source === "hint_expansion") return t("dialogs.verseHistory.sourceAi");
  if (source === "dcs_reimport") return t("dialogs.verseHistory.sourceReimport");
  return null;
};

type ViewMode = "snapshot" | "diff";

export function VerseHistoryDialog({
  open,
  book,
  chapter,
  verseNum,
  bibleVersion,
  currentVersion,
  onClose,
  onUseVersion,
}: Props) {
  const { t } = useTranslation();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [entries, setEntries] = useState<VerseHistoryEntry[]>([]);
  const [selectedVersion, setSelectedVersion] = useState<number | null>(null);
  const [viewMode, setViewMode] = useState<ViewMode>("snapshot");

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- the history fetch starts when the dialog opens, and this clears the previous open's result and error so the dialog shows its loading state instead of another row's history while the request is in flight.
    setLoading(true);
    setError(null);
    api
      .getVerseHistory(book, chapter, verseNum, bibleVersion)
      .then((res) => {
        if (cancelled) return;
        setEntries(res.versions);
        // Open showing the most recent restorable version that ISN'T current —
        // i.e. "what you'd roll back to". Fall back to the newest non-current,
        // else current.
        const desc = [...res.versions].sort((a, b) => b.version - a.version);
        const target =
          desc.find((v) => !v.current && v.restorable) ??
          desc.find((v) => !v.current) ??
          desc[0];
        setSelectedVersion(target?.version ?? null);
        setLoading(false);
      })
      .catch((e) => {
        if (cancelled) return;
        setError(String(e));
        setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [open, book, chapter, verseNum, bibleVersion]);

  // Newest first for display.
  const ordered = useMemo(
    () => [...entries].sort((a, b) => b.version - a.version),
    [entries],
  );

  const selected = useMemo(
    () => entries.find((e) => e.version === selectedVersion) ?? null,
    [entries, selectedVersion],
  );
  const current = useMemo(
    () => entries.find((e) => e.current) ?? null,
    [entries],
  );

  const isCurrent = !!selected?.current;
  const canDiff = !isCurrent && selected !== null && current !== null;
  const canRestore = !!selected && !isCurrent && selected.restorable;

  return (
    <Dialog open={open} onClose={onClose} maxWidth="md" fullWidth>
      <DialogTitle>
        <Stack direction="row" alignItems="center" spacing={1}>
          <Typography variant="h6" component="span">
            {t("dialogs.verseHistory.title")}
          </Typography>
          <Chip
            label={`${bibleVersion} ${chapter}:${verseNum}`}
            size="small"
            variant="outlined"
            sx={{ fontFamily: "monospace", height: 22 }}
          />
          <Box sx={{ flex: 1 }} />
          <Typography variant="caption" color="text.secondary">
            {t("dialogs.history.currentVersion", { version: currentVersion })}
          </Typography>
        </Stack>
      </DialogTitle>
      <DialogContent dividers sx={{ p: 0 }}>
        {loading ? (
          <Box sx={{ p: 4, display: "flex", justifyContent: "center" }}>
            <CircularProgress size={24} />
          </Box>
        ) : error ? (
          <Box sx={{ p: 2 }}>
            <Alert severity="error">{t("dialogs.history.loadFailed", { error })}</Alert>
          </Box>
        ) : (
          <Stack direction="row" sx={{ minHeight: 360 }}>
            <Box
              sx={{
                width: 260,
                borderRight: "1px solid",
                borderColor: "divider",
                overflowY: "auto",
                maxHeight: 480,
              }}
            >
              <List dense disablePadding>
                {ordered.map((e) => {
                  const src = sourceChip(e.source, t);
                  return (
                    <ListItemButton
                      key={e.version}
                      selected={e.version === selectedVersion}
                      onClick={() => setSelectedVersion(e.version)}
                    >
                      <ListItemText
                        primary={
                          <Stack direction="row" spacing={0.5} alignItems="center" flexWrap="wrap">
                            <Typography
                              variant="body2"
                              sx={{ fontFamily: "monospace", fontWeight: 600 }}
                            >
                              {t("aligner.versionChip", { version: e.version })}
                            </Typography>
                            {e.current && (
                              <Chip label={t("dialogs.history.current")} size="small" color="primary" variant="outlined" sx={{ height: 18, fontSize: 10 }} />
                            )}
                            {e.action === "imported" && (
                              <Chip label={t("dialogs.history.imported")} size="small" variant="outlined" sx={{ height: 18, fontSize: 10 }} />
                            )}
                            {e.action === "baseline" && (
                              <Chip label={t("dialogs.verseHistory.preAi")} size="small" variant="outlined" sx={{ height: 18, fontSize: 10 }} />
                            )}
                            {src && (
                              <Chip label={src} size="small" variant="outlined" color="secondary" sx={{ height: 18, fontSize: 10 }} />
                            )}
                            {!e.restorable && (
                              <Tooltip title={t("dialogs.verseHistory.textOnlyTooltip")}>
                                <Chip label={t("dialogs.verseHistory.textOnly")} size="small" variant="outlined" color="warning" sx={{ height: 18, fontSize: 10 }} />
                              </Tooltip>
                            )}
                          </Stack>
                        }
                        secondary={
                          <>
                            <Typography variant="caption" component="div">
                              {fmtTime(e.created_at)}
                            </Typography>
                            <Typography variant="caption" color="text.secondary" component="div">
                              {userLabel(e, t)}
                            </Typography>
                          </>
                        }
                      />
                    </ListItemButton>
                  );
                })}
              </List>
            </Box>
            <Box sx={{ flex: 1, p: 2, overflowY: "auto", maxHeight: 480 }}>
              {selected ? (
                <Stack spacing={1.5}>
                  <Stack direction="row" alignItems="center" spacing={1}>
                    <Typography variant="caption" color="text.secondary">
                      {viewMode === "diff" && canDiff
                        ? t("dialogs.history.diffHeading", {
                            from: selected.version,
                            to: currentVersion,
                          })
                        : t("dialogs.history.previewHeading", { version: selected.version })}
                    </Typography>
                    <Box sx={{ flex: 1 }} />
                    <ToggleButtonGroup
                      size="small"
                      exclusive
                      value={viewMode}
                      onChange={(_, v) => {
                        if (v) setViewMode(v as ViewMode);
                      }}
                      sx={{ "& .MuiToggleButton-root": { py: 0.25, px: 1 } }}
                    >
                      <ToggleButton value="snapshot">
                        {t("dialogs.history.snapshot")}
                      </ToggleButton>
                      <ToggleButton value="diff" disabled={!canDiff}>
                        {t("dialogs.history.diffVsCurrent")}
                      </ToggleButton>
                    </ToggleButtonGroup>
                  </Stack>
                  {viewMode === "diff" && canDiff ? (
                    <TextDiff from={selected.plain_text} to={current!.plain_text} />
                  ) : (
                    <TextPreview value={selected.plain_text} />
                  )}
                  {!selected.restorable && !isCurrent && (
                    <Alert severity="info" sx={{ py: 0 }}>
                      {t("dialogs.verseHistory.textOnlyNotice")}
                    </Alert>
                  )}
                </Stack>
              ) : (
                <Typography variant="body2" color="text.secondary">
                  {t("dialogs.history.pickVersion")}
                </Typography>
              )}
            </Box>
          </Stack>
        )}
      </DialogContent>
      <DialogActions sx={{ justifyContent: "space-between" }}>
        <Typography variant="caption" color="text.secondary" sx={{ pl: 1 }}>
          {t("dialogs.verseHistory.footerNote")}
        </Typography>
        <Box>
          <Button onClick={onClose}>{t("common.close")}</Button>
          <Button
            variant="contained"
            disabled={!canRestore || loading}
            onClick={() => {
              if (!selected || !selected.restorable) return;
              onUseVersion(selected.content, selected.plain_text);
              onClose();
            }}
          >
            {isCurrent
              ? t("dialogs.history.alreadyCurrent")
              : selected
                ? t("dialogs.history.switchTo", { version: selected.version })
                : t("dialogs.history.switch")}
          </Button>
        </Box>
      </DialogActions>
    </Dialog>
  );
}

function TextPreview({ value }: { value: string | null }) {
  const { t } = useTranslation();
  return (
    <Box
      sx={{
        p: 1,
        border: "1px solid",
        borderColor: "divider",
        borderRadius: 1,
        bgcolor: "grey.50",
        minHeight: 32,
        whiteSpace: "pre-wrap",
        fontFamily: '"Source Serif Pro","Cambria","Times New Roman",serif',
        fontSize: 15,
        color: value ? "text.primary" : "text.disabled",
      }}
    >
      {value || t("dialogs.history.empty")}
    </Box>
  );
}

function TextDiff({ from, to }: { from: string | null; to: string | null }) {
  const { t } = useTranslation();
  const fromStr = from ?? "";
  const toStr = to ?? "";
  const ops = useMemo(() => diffWords(fromStr, toStr), [fromStr, toStr]);
  const identical = ops.every((o) => o.type === "eq");
  return (
    <Box
      sx={{
        p: 1,
        border: "1px solid",
        borderColor: "divider",
        borderRadius: 1,
        bgcolor: "grey.50",
        minHeight: 32,
        whiteSpace: "pre-wrap",
        fontFamily: '"Source Serif Pro","Cambria","Times New Roman",serif',
        fontSize: 15,
      }}
    >
      {identical && fromStr === "" && toStr === "" ? (
        <Box component="span" sx={{ color: "text.disabled" }}>
          {t("dialogs.history.empty")}
        </Box>
      ) : identical ? (
        <Box component="span">{fromStr}</Box>
      ) : (
        ops.map((op, idx) => {
          if (op.type === "eq") {
            return (
              <Box key={idx} component="span">
                {op.text}
              </Box>
            );
          }
          if (op.type === "del") {
            return (
              <Box
                key={idx}
                component="span"
                sx={{
                  backgroundColor: "rgba(244, 67, 54, 0.18)",
                  color: "#b71c1c",
                  textDecoration: "line-through",
                  borderRadius: 0.5,
                }}
              >
                {op.text}
              </Box>
            );
          }
          return (
            <Box
              key={idx}
              component="span"
              sx={{
                backgroundColor: "rgba(76, 175, 80, 0.22)",
                color: "#1b5e20",
                borderRadius: 0.5,
              }}
            >
              {op.text}
            </Box>
          );
        })
      )}
    </Box>
  );
}
