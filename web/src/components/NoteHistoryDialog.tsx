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
  Divider,
  CircularProgress,
  Alert,
  ToggleButton,
  ToggleButtonGroup,
} from "@mui/material";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import { api, type RowHistoryEntry } from "../sync/api";
import { diffWords } from "../lib/wordDiff";
import { formatEpochSecondsDateTime } from "../lib/formatDate";

interface NoteSnapshot {
  quote: string | null;
  note: string | null;
  support_reference: string | null;
}

interface Props {
  open: boolean;
  noteId: string;
  book: string;
  // The actual row.version — monotonically increasing, used as the
  // If-Match expectation when we PATCH.
  currentVersion: number;
  // The version the chip displays — equals `restored_from_version` if the
  // latest edit was a revert, otherwise equals currentVersion. The dialog
  // surfaces this entry as "current" and hides revert phantoms from the
  // list (their snapshot is identical to the version they restored).
  effectiveVersion: number;
  onClose: () => void;
  // Fires the chosen version's snapshot + the version number it came from
  // back to the card, which PATCHes through the normal save pipe. The
  // server marks that PATCH as a revert via the row's restored_from_version
  // column so this dialog can keep hiding it next time around.
  onUseVersion: (snapshot: NoteSnapshot, fromVersion: number) => void;
  // When true the dialog is view-only: history is browsable but the restore
  // ("Switch to vN") action is hidden. Used when the card itself is read-only
  // (e.g. an unapproved AI/Aquifer draft locked in Editor mode) so history can't
  // be used as a back door to persist a change the card otherwise forbids.
  readOnly?: boolean;
}

const fmtTime = (epochSec: number) => formatEpochSecondsDateTime(epochSec);

const userLabel = (e: RowHistoryEntry, t: TFunction) => {
  if (!e.user) return t("dialogs.history.unknownUser");
  return e.user.full_name || e.user.username || t("dialogs.history.userNumber", { id: e.user.id });
};

const tsvToDisplay = (s: string | null) => (s ?? "").replace(/\\n/g, "\n");

type ViewMode = "snapshot" | "diff";

export function NoteHistoryDialog({
  open,
  noteId,
  book,
  currentVersion,
  effectiveVersion,
  onClose,
  onUseVersion,
  readOnly = false,
}: Props) {
  const { t } = useTranslation();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [entries, setEntries] = useState<RowHistoryEntry[]>([]);
  const [selectedVersion, setSelectedVersion] = useState<number | null>(null);
  const [viewMode, setViewMode] = useState<ViewMode>("snapshot");

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- the history fetch starts when the dialog opens, and this clears the previous open's result and error so the dialog shows its loading state instead of another row's history while the request is in flight.
    setLoading(true);
    setError(null);
    api
      .getRowHistory("tn", noteId, book)
      .then((res) => {
        if (cancelled) return;
        setEntries(res.versions);
        // Default selection: most recent *visible* entry that isn't the
        // effective-current one, so the dialog opens showing "what was
        // here before this one".
        const visible = res.versions.filter(
          (v) => v.restored_from_version == null,
        );
        const previous = [...visible]
          .reverse()
          .find((v) => v.version !== effectiveVersion);
        setSelectedVersion(
          previous?.version ?? visible.at(-1)?.version ?? null,
        );
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
  }, [open, noteId, book, effectiveVersion]);

  // Most recent first; phantom revert entries (same snapshot as the
  // version they restored) are filtered out — the user wanted "the other
  // 3 accessible", not the empty v(current+1) we just wrote.
  const ordered = useMemo(
    () =>
      [...entries]
        .filter((e) => e.restored_from_version == null)
        .sort((a, b) => b.version - a.version),
    [entries],
  );

  const selected = useMemo(
    () => entries.find((e) => e.version === selectedVersion) ?? null,
    [entries, selectedVersion],
  );

  const selectedSnapshot: NoteSnapshot | null = selected
    ? {
        quote: (selected.snapshot.quote as string | null) ?? null,
        note: (selected.snapshot.note as string | null) ?? null,
        support_reference:
          (selected.snapshot.support_reference as string | null) ?? null,
      }
    : null;

  const effectiveEntry = useMemo(
    () => entries.find((e) => e.version === effectiveVersion) ?? null,
    [entries, effectiveVersion],
  );
  const effectiveSnapshot: NoteSnapshot | null = effectiveEntry
    ? {
        quote: (effectiveEntry.snapshot.quote as string | null) ?? null,
        note: (effectiveEntry.snapshot.note as string | null) ?? null,
        support_reference:
          (effectiveEntry.snapshot.support_reference as string | null) ?? null,
      }
    : null;

  const isCurrent = selected?.version === effectiveVersion;
  const canDiff = !isCurrent && selected !== null && effectiveSnapshot !== null;

  return (
    <Dialog open={open} onClose={onClose} maxWidth="md" fullWidth>
      <DialogTitle>
        <Stack direction="row" alignItems="center" spacing={1}>
          <Typography variant="h6" component="span">
            {t("dialogs.noteHistory.title")}
          </Typography>
          <Chip
            label={noteId}
            size="small"
            variant="outlined"
            sx={{ fontFamily: "monospace", height: 22 }}
          />
          <Box sx={{ flex: 1 }} />
          <Typography variant="caption" color="text.secondary">
            {t("dialogs.history.currentVersion", { version: effectiveVersion })}
            {effectiveVersion !== currentVersion ? t("dialogs.history.restoredSuffix") : ""}
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
                  const isSelected = e.version === selectedVersion;
                  const isLive = e.version === effectiveVersion;
                  return (
                    <ListItemButton
                      key={e.version}
                      selected={isSelected}
                      onClick={() => setSelectedVersion(e.version)}
                    >
                      <ListItemText
                        primary={
                          <Stack direction="row" spacing={1} alignItems="center">
                            <Typography
                              variant="body2"
                              sx={{ fontFamily: "monospace", fontWeight: 600 }}
                            >
                              {t("aligner.versionChip", { version: e.version })}
                            </Typography>
                            {isLive && (
                              <Chip
                                label={t("dialogs.history.current")}
                                size="small"
                                color="primary"
                                variant="outlined"
                                sx={{ height: 18, fontSize: 10 }}
                              />
                            )}
                            {e.action === "create" && (
                              <Chip
                                label={t("dialogs.noteHistory.created")}
                                size="small"
                                variant="outlined"
                                sx={{ height: 18, fontSize: 10 }}
                              />
                            )}
                            {e.action === "imported" && (
                              <Chip
                                label={t("dialogs.history.imported")}
                                size="small"
                                variant="outlined"
                                sx={{ height: 18, fontSize: 10 }}
                              />
                            )}
                            {e.action === "delete" && (
                              <Chip
                                label={t("dialogs.noteHistory.deleted")}
                                size="small"
                                color="error"
                                variant="outlined"
                                sx={{ height: 18, fontSize: 10 }}
                              />
                            )}
                          </Stack>
                        }
                        secondary={
                          <>
                            <Typography variant="caption" component="div">
                              {fmtTime(e.created_at)}
                            </Typography>
                            <Typography
                              variant="caption"
                              color="text.secondary"
                              component="div"
                            >
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
              {selectedSnapshot ? (
                <Stack spacing={1.5}>
                  <Stack direction="row" alignItems="center" spacing={1}>
                    <Typography variant="caption" color="text.secondary">
                      {viewMode === "diff" && canDiff
                        ? t("dialogs.history.diffHeading", {
                            from: selected!.version,
                            to: effectiveVersion,
                          })
                        : t("dialogs.history.previewHeading", { version: selected?.version })}
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
                    <>
                      <DiffPreview
                        label={t("dialogs.noteHistory.fieldSupportRef")}
                        from={selectedSnapshot.support_reference}
                        to={effectiveSnapshot!.support_reference}
                      />
                      <DiffPreview
                        label={t("dialogs.noteHistory.fieldQuote")}
                        from={tsvToDisplay(selectedSnapshot.quote)}
                        to={tsvToDisplay(effectiveSnapshot!.quote)}
                        rtl
                      />
                      <Divider />
                      <DiffPreview
                        label={t("dialogs.noteHistory.fieldNote")}
                        from={tsvToDisplay(selectedSnapshot.note)}
                        to={tsvToDisplay(effectiveSnapshot!.note)}
                      />
                    </>
                  ) : (
                    <>
                      <FieldPreview
                        label={t("dialogs.noteHistory.fieldSupportRef")}
                        value={selectedSnapshot.support_reference}
                      />
                      <FieldPreview
                        label={t("dialogs.noteHistory.fieldQuote")}
                        value={tsvToDisplay(selectedSnapshot.quote)}
                        rtl
                      />
                      <Divider />
                      <FieldPreview
                        label={t("dialogs.noteHistory.fieldNote")}
                        value={tsvToDisplay(selectedSnapshot.note)}
                      />
                    </>
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
      <DialogActions>
        <Button onClick={onClose}>{t("common.close")}</Button>
        {!readOnly && (
        <Button
          variant="contained"
          disabled={!selected || isCurrent || loading}
          onClick={() => {
            if (!selected || !selectedSnapshot) return;
            onUseVersion(selectedSnapshot, selected.version);
            onClose();
          }}
        >
          {isCurrent
            ? t("dialogs.history.alreadyCurrent")
            : selected
              ? t("dialogs.history.switchTo", { version: selected.version })
              : t("dialogs.history.switch")}
        </Button>
        )}
      </DialogActions>
    </Dialog>
  );
}

function FieldPreview({
  label,
  value,
  rtl,
}: {
  label: string;
  value: string | null;
  rtl?: boolean;
}) {
  const { t } = useTranslation();
  return (
    <Box>
      <Typography
        variant="caption"
        sx={{
          fontFamily: "monospace",
          color: "text.secondary",
          textTransform: "uppercase",
        }}
      >
        {label}
      </Typography>
      <Box
        sx={{
          mt: 0.5,
          p: 1,
          border: "1px solid",
          borderColor: "divider",
          borderRadius: 1,
          bgcolor: "grey.50",
          minHeight: 32,
          whiteSpace: "pre-wrap",
          fontFamily: rtl
            ? '"Times New Roman","SBL Hebrew","Cardo",serif'
            : '"Source Serif Pro","Cambria","Times New Roman",serif',
          fontSize: rtl ? 20 : 13,
          textAlign: "start",
          color: value ? "text.primary" : "text.disabled",
        }}
        dir={rtl ? "rtl" : "ltr"}
      >
        {value || t("dialogs.history.empty")}
      </Box>
    </Box>
  );
}

function DiffPreview({
  label,
  from,
  to,
  rtl,
}: {
  label: string;
  from: string | null;
  to: string | null;
  rtl?: boolean;
}) {
  const { t } = useTranslation();
  const fromStr = from ?? "";
  const toStr = to ?? "";
  const ops = useMemo(() => diffWords(fromStr, toStr), [fromStr, toStr]);
  const identical = ops.every((o) => o.type === "eq");
  return (
    <Box>
      <Typography
        variant="caption"
        sx={{
          fontFamily: "monospace",
          color: "text.secondary",
          textTransform: "uppercase",
        }}
      >
        {label}
      </Typography>
      <Box
        sx={{
          mt: 0.5,
          p: 1,
          border: "1px solid",
          borderColor: "divider",
          borderRadius: 1,
          bgcolor: "grey.50",
          minHeight: 32,
          whiteSpace: "pre-wrap",
          fontFamily: rtl
            ? '"Times New Roman","SBL Hebrew","Cardo",serif'
            : '"Source Serif Pro","Cambria","Times New Roman",serif',
          fontSize: rtl ? 20 : 13,
          textAlign: "start",
        }}
        dir={rtl ? "rtl" : "ltr"}
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
    </Box>
  );
}
