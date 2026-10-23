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
} from "@mui/material";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import {
  api,
  type TemplateHistory,
  type TemplateHistoryEntry,
  type RowHistoryUser,
} from "../sync/api";
import { diffWords } from "../lib/wordDiff";
import { formatEpochSecondsDateTime } from "../lib/formatDate";
import { MarkdownView } from "./MarkdownView";

interface Props {
  open: boolean;
  templateId: string;
  // The live row version — the "current" anchor the diff compares against.
  currentVersion: number;
  direction: "ltr" | "rtl";
  onClose: () => void;
  // Loads the chosen version's target markdown back into the editor draft; the
  // user then saves it through the normal If-Match pipe (the PATCH endpoint
  // takes only target_md, so a "restore" is just a re-save of old text).
  onUseVersion: (targetMd: string) => void;
}

const fmtTime = (epochSec: number) => formatEpochSecondsDateTime(epochSec);

function userLabel(u: RowHistoryUser | null, t: TFunction): string {
  if (!u) return "—";
  return u.full_name || u.username || t("dialogs.history.userNumber", { id: u.id });
}

type ViewMode = "snapshot" | "diff";
type Side = "target" | "source";

export function TemplateHistoryDialog({
  open,
  templateId,
  currentVersion,
  direction,
  onClose,
  onUseVersion,
}: Props) {
  const { t } = useTranslation();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [history, setHistory] = useState<TemplateHistory | null>(null);
  const [side, setSide] = useState<Side>("target");
  const [selectedVersion, setSelectedVersion] = useState<number | null>(null);
  const [viewMode, setViewMode] = useState<ViewMode>("snapshot");

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- the history fetch starts when the dialog opens, and this clears the previous open's result and error so the dialog shows its loading state instead of another row's history while the request is in flight.
    setLoading(true);
    setError(null);
    api
      .getTemplateHistory(templateId)
      .then((res) => {
        if (cancelled) return;
        setHistory(res);
        // Default to the most recent entry that isn't the current one, so the
        // dialog opens on "what was here before this".
        const visible = res.target.filter((e) => e.restored_from_version == null);
        const previous = [...visible].reverse().find((e) => e.version !== currentVersion);
        setSelectedVersion(previous?.version ?? visible.at(-1)?.version ?? null);
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
  }, [open, templateId, currentVersion]);

  const ordered = useMemo<TemplateHistoryEntry[]>(
    () =>
      history
        ? [...history.target]
            .filter((e) => e.restored_from_version == null)
            .sort((a, b) => b.version - a.version)
        : [],
    [history],
  );

  const selected = useMemo(
    () => ordered.find((e) => e.version === selectedVersion) ?? null,
    [ordered, selectedVersion],
  );
  const currentEntry = useMemo(
    () => history?.target.find((e) => e.version === currentVersion) ?? null,
    [history, currentVersion],
  );

  const selectedMd = selected?.snapshot.target_md ?? "";
  const currentMd = currentEntry?.snapshot.target_md ?? "";
  const isCurrent = selected?.version === currentVersion;
  const canDiff = !isCurrent && selected != null;

  const diffOps = useMemo(() => diffWords(selectedMd, currentMd), [selectedMd, currentMd]);

  const sources = history?.source ?? [];

  return (
    <Dialog open={open} onClose={onClose} maxWidth="md" fullWidth>
      <DialogTitle>
        <Stack direction="row" alignItems="center" spacing={1}>
          <Typography variant="h6" component="span">
            {t("templates.historyTitle")}
          </Typography>
          <Chip
            label={templateId}
            size="small"
            variant="outlined"
            sx={{ fontFamily: "monospace", height: 22 }}
          />
          <Box sx={{ flex: 1 }} />
          <ToggleButtonGroup
            size="small"
            exclusive
            value={side}
            onChange={(_, v) => {
              if (v) setSide(v as Side);
            }}
            sx={{ "& .MuiToggleButton-root": { py: 0.25, px: 1 } }}
          >
            <ToggleButton value="target">{t("templates.historyTarget")}</ToggleButton>
            <ToggleButton value="source">{t("templates.historySource")}</ToggleButton>
          </ToggleButtonGroup>
        </Stack>
      </DialogTitle>
      <DialogContent dividers sx={{ p: 0 }}>
        {loading ? (
          <Box sx={{ p: 4, display: "flex", justifyContent: "center" }}>
            <CircularProgress size={24} />
          </Box>
        ) : error ? (
          <Box sx={{ p: 2 }}>
            <Alert severity="error">{error}</Alert>
          </Box>
        ) : side === "source" ? (
          <Box sx={{ p: 2, maxHeight: 480, overflowY: "auto" }}>
            {sources.length === 0 ? (
              <Typography variant="body2" color="text.secondary">
                {t("templates.noSourceHistory")}
              </Typography>
            ) : (
              <Stack spacing={2}>
                {sources.map((s, i) => (
                  <Box key={`${s.source_hash}-${i}`}>
                    <Typography variant="caption" color="text.secondary" sx={{ display: "block", mb: 0.5 }}>
                      {fmtTime(s.seen_at)}
                      {i === 0 ? ` · ${t("templates.latest")}` : ""}
                    </Typography>
                    <Box
                      dir="ltr"
                      sx={{ p: 1.5, border: "1px solid", borderColor: "divider", borderRadius: 1 }}
                    >
                      <MarkdownView markdown={s.source_md} dir="ltr" />
                    </Box>
                  </Box>
                ))}
              </Stack>
            )}
          </Box>
        ) : (
          <Stack direction="row" sx={{ minHeight: 360 }}>
            <Box
              sx={{
                width: 240,
                borderInlineEnd: "1px solid",
                borderColor: "divider",
                overflowY: "auto",
                maxHeight: 480,
              }}
            >
              <List dense disablePadding>
                {ordered.map((e) => {
                  const isLive = e.version === currentVersion;
                  return (
                    <ListItemButton
                      key={e.version}
                      selected={e.version === selectedVersion}
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
                                label={t("templates.current")}
                                size="small"
                                color="primary"
                                variant="outlined"
                                sx={{ height: 18, fontSize: 10 }}
                              />
                            )}
                            {(e.action === "imported" || e.synthetic) && (
                              <Chip
                                label={t("templates.started")}
                                size="small"
                                variant="outlined"
                                sx={{ height: 18, fontSize: 10 }}
                              />
                            )}
                          </Stack>
                        }
                        secondary={
                          <>
                            <Typography variant="caption" component="div">
                              {e.created_at ? fmtTime(e.created_at) : ""}
                            </Typography>
                            <Typography
                              variant="caption"
                              color="text.secondary"
                              component="div"
                            >
                              {userLabel(e.user, t)}
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
                        ? t("dialogs.history.diffVersions", {
                            from: selected.version,
                            to: currentVersion,
                          })
                        : t("aligner.versionChip", { version: selected.version })}
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
                      <ToggleButton value="snapshot">{t("templates.snapshot")}</ToggleButton>
                      <ToggleButton value="diff" disabled={!canDiff}>
                        {t("templates.diffVsCurrent")}
                      </ToggleButton>
                    </ToggleButtonGroup>
                  </Stack>
                  {viewMode === "diff" && canDiff ? (
                    <Box
                      dir={direction}
                      sx={{
                        p: 1.5,
                        border: "1px solid",
                        borderColor: "divider",
                        borderRadius: 1,
                        whiteSpace: "pre-wrap",
                        fontSize: 14,
                        lineHeight: 1.6,
                        textAlign: "start",
                      }}
                    >
                      {diffOps.map((op, idx) => {
                        if (op.type === "eq") return <span key={idx}>{op.text}</span>;
                        if (op.type === "del")
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
                      })}
                    </Box>
                  ) : selectedMd.trim() ? (
                    <Box
                      sx={{ p: 1.5, border: "1px solid", borderColor: "divider", borderRadius: 1 }}
                    >
                      <MarkdownView markdown={selectedMd} dir={direction} />
                    </Box>
                  ) : (
                    <Typography variant="body2" color="text.disabled">
                      {t("templates.emptyTranslation")}
                    </Typography>
                  )}
                </Stack>
              ) : (
                <Typography variant="body2" color="text.secondary">
                  {t("templates.pickVersion")}
                </Typography>
              )}
            </Box>
          </Stack>
        )}
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose}>{t("common.close")}</Button>
        <Button
          variant="contained"
          disabled={!selected || isCurrent || loading || side === "source"}
          onClick={() => {
            if (!selected) return;
            onUseVersion(selectedMd);
            onClose();
          }}
        >
          {selected && !isCurrent
            ? t("templates.useVersion", { v: selected.version })
            : t("templates.alreadyCurrent")}
        </Button>
      </DialogActions>
    </Dialog>
  );
}
