// Change history of the translation preferences (issue #788), shared by both
// admin surfaces: classic #/preferences (BriefSection) and the admin desk's
// Style page (BriefPanel). Lists every save of the brief / instructions /
// common issues newest first (who, when, web app or chat assistant, each
// changed field before and after) and lets an admin restore an earlier
// version.
//
// Restore is client-side (web/src/lib/prefsHistory.ts): the version is rebuilt
// from the `current` row the history route returned, then PUT with If-Match
// current.version, so it is saved and recorded as a new version. The editors
// on the page seed their text once and ignore later prefs changes, so the
// caller must remount them in `onRestored`, or their next Save would write the
// pre-restore text back.

import { useCallback, useEffect, useState } from "react";
import Alert from "@mui/material/Alert";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import Chip from "@mui/material/Chip";
import CircularProgress from "@mui/material/CircularProgress";
import Dialog from "@mui/material/Dialog";
import DialogActions from "@mui/material/DialogActions";
import DialogContent from "@mui/material/DialogContent";
import DialogContentText from "@mui/material/DialogContentText";
import DialogTitle from "@mui/material/DialogTitle";
import Stack from "@mui/material/Stack";
import Typography from "@mui/material/Typography";
import HistoryIcon from "@mui/icons-material/History";
import RestoreIcon from "@mui/icons-material/Restore";
import { useTranslation } from "react-i18next";

import { api, ApiError, type TranslationPrefs } from "../sync/api";
import { currentPrefsFromConflict } from "../sync/prefsConflict";
import {
  PREFS_HISTORY_FIELDS,
  rebuildPrefsVersion,
  restorableVersions,
  type PrefsHistoryEntry,
  type PrefsHistoryField,
} from "../lib/prefsHistory";
import { formatEpochSecondsDateTime } from "../lib/formatDate";

const PAGE = 20;

type Loaded = { current: TranslationPrefs; entries: PrefsHistoryEntry[]; next: number | null };

interface Props {
  /** Adopt a saved row (the restore's PUT response, or a 409's current row). */
  apply: (p: TranslationPrefs) => void;
  /** Called after a successful restore: remount the editors so they show it. */
  onRestored: () => void;
}

/** The "History" button and the dialog it opens. */
export function PrefsHistoryButton({ apply, onRestored }: Props) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button size="small" variant="outlined" startIcon={<HistoryIcon />} onClick={() => setOpen(true)}>
        {t("prefsHistory.button")}
      </Button>
      {open && <PrefsHistoryDialog onClose={() => setOpen(false)} apply={apply} onRestored={onRestored} />}
    </>
  );
}

function PrefsHistoryDialog({ onClose, apply, onRestored }: Props & { onClose: () => void }) {
  const { t } = useTranslation();
  const [data, setData] = useState<Loaded | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [msg, setMsg] = useState<{ severity: "success" | "warning" | "error"; text: string } | null>(null);
  const [confirm, setConfirm] = useState<number | null>(null);
  const [restoring, setRestoring] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);

  // Reload the first page: replaces whatever was loaded, including `current`,
  // which every restore rebuilds from.
  const reload = useCallback(() => {
    setLoading(true);
    setError(false);
    setReloadKey((k) => k + 1);
  }, []);

  useEffect(() => {
    let cancelled = false;
    api
      .getTranslationPrefsHistory({ limit: PAGE })
      .then((res) => {
        if (!cancelled) setData(res);
      })
      .catch(() => {
        if (!cancelled) setError(true);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [reloadKey]);

  const loadOlder = async () => {
    if (!data || data.next == null) return;
    setLoading(true);
    try {
      const res = await api.getTranslationPrefsHistory({ before: data.next, limit: PAGE });
      // Keep the first page's `current`: older pages can't change it, and
      // mixing in a newer one would let a rebuild cross an unseen save.
      setData({ current: data.current, entries: [...data.entries, ...res.entries], next: res.next });
    } catch {
      setError(true);
    } finally {
      setLoading(false);
    }
  };

  const restore = async (target: number) => {
    if (!data) return;
    setConfirm(null);
    const rebuilt = rebuildPrefsVersion(data.current, data.entries, target);
    if (!rebuilt.ok) {
      setMsg({ severity: "warning", text: t(rebuilt.reason === "stale" ? "prefsHistory.restoreStale" : "prefsHistory.restoreGap") });
      reload();
      return;
    }
    setRestoring(true);
    try {
      const res = await api.putTranslationPrefs(data.current.version, rebuilt.fields);
      apply(res.prefs);
      onRestored();
      setMsg({
        severity: "success",
        text: t("prefsHistory.restored", { version: target, newVersion: res.prefs.version }),
      });
    } catch (e) {
      if (e instanceof ApiError && e.status === 409) {
        const current = currentPrefsFromConflict(e.body);
        if (current) apply(current);
        setMsg({ severity: "warning", text: t("prefsHistory.restoreStale") });
      } else if (e instanceof ApiError && e.status === 403) {
        setMsg({ severity: "error", text: t("preferences.saveForbidden") });
      } else {
        setMsg({ severity: "error", text: t("preferences.saveFailed") });
      }
    } finally {
      setRestoring(false);
      reload();
    }
  };

  const complete = data?.next === null;
  const restorable = new Set(data ? restorableVersions(data.entries, complete) : []);
  const oldest = data?.entries[data.entries.length - 1];
  const beforeOldest = complete && oldest && oldest.prev_version > 0 ? oldest.prev_version : null;
  const currentVersion = data?.current.version;

  return (
    <Dialog open onClose={onClose} fullWidth maxWidth="md" scroll="paper" aria-labelledby="prefs-history-title">
      <DialogTitle id="prefs-history-title">{t("prefsHistory.title")}</DialogTitle>
      <DialogContent dividers>
        <Stack spacing={2}>
          <Typography variant="body2" color="text.secondary">
            {t("prefsHistory.intro")}
          </Typography>
          {msg && (
            <Alert severity={msg.severity} onClose={() => setMsg(null)}>
              {msg.text}
            </Alert>
          )}
          {error && <Alert severity="error">{t("prefsHistory.loadFailed")}</Alert>}
          {data && data.entries.length === 0 && (
            <Alert severity="info" variant="outlined">
              {t("prefsHistory.empty")}
            </Alert>
          )}
          {data?.entries.map((e) => (
            <EntryCard
              key={e.id}
              entry={e}
              isCurrent={e.new_version === currentVersion}
              canRestore={restorable.has(e.new_version) && e.new_version !== currentVersion}
              busy={restoring}
              onRestore={() => setConfirm(e.new_version)}
            />
          ))}
          {beforeOldest !== null && (
            <Box sx={{ border: 1, borderColor: "divider", borderRadius: 1, p: 1.5 }}>
              <Stack direction="row" alignItems="center" flexWrap="wrap" gap={1}>
                <Typography variant="subtitle2">{t("prefsHistory.version", { version: beforeOldest })}</Typography>
                <Typography variant="body2" color="text.secondary" sx={{ flex: 1 }}>
                  {t("prefsHistory.beforeOldest")}
                </Typography>
                <Button
                  size="small"
                  startIcon={<RestoreIcon />}
                  disabled={restoring}
                  onClick={() => setConfirm(beforeOldest)}
                >
                  {t("prefsHistory.restore")}
                </Button>
              </Stack>
            </Box>
          )}
          {loading && <CircularProgress size={22} />}
          {data && data.next != null && !loading && (
            <Box>
              <Button size="small" onClick={() => void loadOlder()}>
                {t("prefsHistory.loadOlder")}
              </Button>
            </Box>
          )}
        </Stack>
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose}>{t("prefsHistory.close")}</Button>
      </DialogActions>

      <Dialog open={confirm !== null} onClose={() => setConfirm(null)} aria-labelledby="prefs-restore-title">
        <DialogTitle id="prefs-restore-title">{t("prefsHistory.confirmTitle", { version: confirm ?? 0 })}</DialogTitle>
        <DialogContent>
          <DialogContentText>{t("prefsHistory.confirmBody", { version: confirm ?? 0 })}</DialogContentText>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setConfirm(null)}>{t("preferences.cancel")}</Button>
          <Button variant="contained" onClick={() => confirm !== null && void restore(confirm)}>
            {t("prefsHistory.restore")}
          </Button>
        </DialogActions>
      </Dialog>
    </Dialog>
  );
}

function EntryCard({
  entry,
  isCurrent,
  canRestore,
  busy,
  onRestore,
}: {
  entry: PrefsHistoryEntry;
  isCurrent: boolean;
  canRestore: boolean;
  busy: boolean;
  onRestore: () => void;
}) {
  const { t } = useTranslation();
  const fields = PREFS_HISTORY_FIELDS.filter((f) => entry.changed[f]);
  return (
    <Box
      data-testid="prefs-history-entry"
      sx={{ border: 1, borderColor: "divider", borderRadius: 1, p: 1.5 }}
    >
      <Stack direction="row" alignItems="center" flexWrap="wrap" gap={1} sx={{ mb: fields.length ? 1 : 0 }}>
        <Typography variant="subtitle2">{t("prefsHistory.version", { version: entry.new_version })}</Typography>
        {isCurrent && <Chip size="small" color="primary" label={t("prefsHistory.current")} />}
        <Chip
          size="small"
          variant="outlined"
          color={entry.source === "chat" ? "secondary" : "default"}
          label={t(entry.source === "chat" ? "prefsHistory.sourceChat" : "prefsHistory.sourceWeb")}
        />
        <Typography variant="body2" sx={{ flex: 1 }}>
          {t("prefsHistory.byLine", {
            user: entry.username ?? t("prefsHistory.unknownUser"),
            when: formatEpochSecondsDateTime(entry.created_at),
          })}
        </Typography>
        {canRestore && (
          <Button size="small" startIcon={<RestoreIcon />} disabled={busy} onClick={onRestore}>
            {t("prefsHistory.restore")}
          </Button>
        )}
      </Stack>
      {fields.length === 0 ? (
        <Typography variant="body2" color="text.secondary">
          {t("prefsHistory.noChanges")}
        </Typography>
      ) : (
        <Stack spacing={1.25}>
          {fields.map((f) => (
            <FieldDiff key={f} field={f} change={entry.changed[f]!} />
          ))}
        </Stack>
      )}
    </Box>
  );
}

function FieldDiff({ field, change }: { field: PrefsHistoryField; change: { prev: string | null; new: string | null } }) {
  const { t } = useTranslation();
  // Register is a fixed option; show its label, as the Brief editor does.
  const shown = (v: string | null) =>
    v && field === "register" ? t(`preferences.registerOption.${v}`, { defaultValue: v }) : v;
  return (
    <Box>
      <Typography variant="caption" sx={{ fontWeight: 700 }}>
        {t(`prefsHistory.field.${field}`)}
      </Typography>
      <Box sx={{ display: "grid", gap: 1, gridTemplateColumns: { xs: "minmax(0,1fr)", sm: "minmax(0,1fr) minmax(0,1fr)" } }}>
        <ValueBox label={t("prefsHistory.before")} value={shown(change.prev)} tone="error" />
        <ValueBox label={t("prefsHistory.after")} value={shown(change.new)} tone="success" />
      </Box>
    </Box>
  );
}

function ValueBox({ label, value, tone }: { label: string; value: string | null; tone: "error" | "success" }) {
  const { t } = useTranslation();
  return (
    <Box
      sx={{
        borderInlineStart: 3,
        borderColor: `${tone}.main`,
        bgcolor: "action.hover",
        borderRadius: 0.5,
        px: 1,
        py: 0.5,
        minWidth: 0,
      }}
    >
      <Typography variant="caption" color="text.secondary">
        {label}
      </Typography>
      {value ? (
        <Typography
          dir="auto"
          variant="body2"
          component="div"
          sx={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere", maxHeight: 180, overflowY: "auto" }}
        >
          {value}
        </Typography>
      ) : (
        <Typography variant="body2" color="text.secondary" sx={{ fontStyle: "italic" }}>
          {t("prefsHistory.emptyValue")}
        </Typography>
      )}
    </Box>
  );
}
