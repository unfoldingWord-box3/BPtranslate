import { useEffect, useState } from "react";
import { Alert, Box, Button, Chip, CircularProgress, FormControlLabel, Stack, Switch, Typography } from "@mui/material";
import { useTranslation } from "react-i18next";
import {
  ApiError,
  api,
  type Lesson,
  type LessonEditAction,
  type LessonRun,
  type LessonSetSummary,
  type LessonsState,
  type TranslationPrefs,
} from "../sync/api";
import { formatEpochSecondsDateTime } from "../lib/formatDate";

// ── Lessons from editor corrections (issue #817, admin-only) ────────────────
// Each night, when this is on and editors approved notes, the server reads what
// they changed in the AI drafts, asks the project's own AI model for a short
// list of lessons, and adds them to instructions.md in the context pack
// (api/src/lessons.ts). Off by default for every project, and the page must say
// plainly when it is off or cannot run, so nobody expects drafts to improve
// when they will not. An admin can pin, delete or move a lesson to Common
// issues, and restore an earlier list (#908); each change is saved on the
// server as a new version of the list. Mounted in classic Preferences
// (section "lessons") and on the desk's Style page. `heading` is false where
// the host already renders a title; `onPrefsChanged` gets the saved
// Translation preferences after a lesson moved to Common issues, so the host
// can show the new line in its Common issues editor without a reload.

// Text from the data (often Arabic) inside UI text in either direction.
function Sample({ text }: { text: string }) {
  return (
    <Box
      component="bdi"
      dir="auto"
      sx={{ px: 0.75, py: 0.25, borderRadius: 0.75, bgcolor: "action.hover", fontSize: "1.05em", whiteSpace: "pre-wrap" }}
    >
      {text}
    </Box>
  );
}

function LessonCard({
  lesson,
  busy,
  promoteBlocked,
  onAction,
}: {
  lesson: Lesson;
  busy: boolean;
  promoteBlocked: boolean;
  onAction: (action: LessonEditAction) => void;
}) {
  const { t } = useTranslation();
  return (
    <Box sx={{ border: 1, borderColor: lesson.pinned ? "primary.main" : "divider", borderRadius: 1.5, p: 1.5 }} data-testid="lesson-card">
      {lesson.pinned && (
        <Chip size="small" color="primary" variant="outlined" label={t("lessons.pinned")} sx={{ mb: 0.75 }} />
      )}
      <Typography variant="body2" dir="auto">
        {lesson.lesson}
      </Typography>
      {(lesson.before || lesson.after) && (
        <Stack direction="row" flexWrap="wrap" alignItems="center" gap={1} sx={{ mt: 0.75 }}>
          <Typography variant="caption" color="text.secondary">
            {t("lessons.before")}
          </Typography>
          <Sample text={lesson.before || "∅"} />
          <Typography variant="caption" color="text.secondary">
            {t("lessons.after")}
          </Typography>
          <Sample text={lesson.after || "∅"} />
        </Stack>
      )}
      <Typography variant="caption" color="text.secondary" component="p" sx={{ mt: 0.75 }}>
        {t("lessons.meta", { n: lesson.evidence, date: formatEpochSecondsDateTime(lesson.firstSeenAt) })}
      </Typography>
      <Stack direction="row" flexWrap="wrap" gap={1} sx={{ mt: 1 }}>
        <Button size="small" variant="outlined" disabled={busy} onClick={() => onAction(lesson.pinned ? "unpin" : "pin")}>
          {lesson.pinned ? t("lessons.actions.unpin") : t("lessons.actions.pin")}
        </Button>
        <Button size="small" variant="outlined" disabled={busy || promoteBlocked} onClick={() => onAction("promote")}>
          {t("lessons.actions.promote")}
        </Button>
        <Button size="small" color="error" disabled={busy} onClick={() => onAction("delete")}>
          {t("lessons.actions.delete")}
        </Button>
      </Stack>
    </Box>
  );
}

function setLabel(s: LessonSetSummary, t: (k: string, o?: Record<string, unknown>) => string): string {
  if (s.kind === "night") return t("lessons.sets.night");
  switch (s.action) {
    case "delete":
      return t("lessons.sets.delete");
    case "pin":
      return t("lessons.sets.pin");
    case "unpin":
      return t("lessons.sets.unpin");
    case "promote":
      return t("lessons.sets.promote");
    case "restore":
      return t("lessons.sets.restore");
    default:
      return t("lessons.sets.edit");
  }
}

// What a refused change (409/413) means, in words; the server's fresh state
// comes with a 409 and replaces the page's copy.
function editErrorText(e: unknown, t: (k: string) => string): string {
  const code = e instanceof ApiError && e.body && typeof e.body === "object" ? (e.body as { error?: unknown }).error : null;
  switch (code) {
    case "stale_set":
      return t("lessons.error.stale");
    case "run_in_progress":
      return t("lessons.error.runInProgress");
    case "prefs_changed":
      return t("lessons.error.prefsChanged");
    case "common_issues_full":
      return t("lessons.error.commonIssuesFull");
    default:
      return t("lessons.error.failed");
  }
}

function runSummary(run: LessonRun, t: (k: string, o?: Record<string, unknown>) => string): string {
  const when = formatEpochSecondsDateTime(run.finishedAt ?? run.startedAt);
  const status =
    run.status === "ok"
      ? t("lessons.run.ok")
      : run.status === "no_changes"
        ? t("lessons.run.noChanges")
        : run.status === "failed"
          ? t("lessons.run.failed", { reason: run.failureReason ?? "?" })
          : t("lessons.run.running");
  const cost =
    run.calls === 0
      ? t("lessons.run.noCall")
      : run.costUsd != null
        ? t("lessons.run.cost", { cost: run.costUsd.toFixed(4) })
        : t("lessons.run.costUnknown");
  return t("lessons.run.summary", { when, status, cost });
}

export function LessonsSection({
  heading = true,
  onPrefsChanged,
  promoteBlocked: promoteBlockedProp = false,
  promoteBlockedNow,
}: {
  heading?: boolean;
  onPrefsChanged?: (prefs: TranslationPrefs) => void;
  /**
   * The host shows a Common issues editor holding unsaved text: "Move to
   * Common issues" waits until it is saved or undone, so the move cannot
   * replace that text (#908).
   */
  promoteBlocked?: boolean;
  /**
   * Asked right before a move is sent, for a host whose `promoteBlocked`
   * follows an async source (classic Preferences reads the drafts store,
   * #909): true refuses the move and shows the same hint.
   */
  promoteBlockedNow?: () => Promise<boolean>;
}) {
  const { t } = useTranslation();
  const [blockedAtClick, setBlockedAtClick] = useState(false);
  const promoteBlocked = promoteBlockedProp || blockedAtClick;
  // A refusal at click time holds until the host's own flag catches up and
  // later clears.
  const [prevProp, setPrevProp] = useState(promoteBlockedProp);
  if (prevProp !== promoteBlockedProp) {
    setPrevProp(promoteBlockedProp);
    if (!promoteBlockedProp) setBlockedAtClick(false);
  }
  const [state, setState] = useState<LessonsState | null>(null);
  const [loadError, setLoadError] = useState(false);
  const [busy, setBusy] = useState(false);
  const [saveError, setSaveError] = useState(false);
  const [editError, setEditError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    api
      .getLessons()
      .then((s) => {
        if (!cancelled) setState(s);
      })
      .catch(() => {
        if (!cancelled) setLoadError(true);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const toggle = async (enabled: boolean) => {
    setBusy(true);
    setSaveError(false);
    try {
      setState(await api.setLessonsEnabled(enabled));
    } catch {
      setSaveError(true);
    } finally {
      setBusy(false);
    }
  };

  // Pin / delete / promote / restore: each answers with the new state. A
  // refusal carries the server's current state, which replaces ours.
  const change = async (run: () => Promise<LessonsState & { prefs?: TranslationPrefs }>, done?: string) => {
    setBusy(true);
    setEditError(null);
    setNotice(null);
    try {
      const next = await run();
      setState(next);
      if (next.prefs) onPrefsChanged?.(next.prefs);
      if (done) setNotice(done);
    } catch (e) {
      setEditError(editErrorText(e, t));
      const fresh = e instanceof ApiError && e.body && typeof e.body === "object" ? (e.body as { state?: LessonsState }).state : undefined;
      if (fresh) setState(fresh);
    } finally {
      setBusy(false);
    }
  };
  const edit = async (position: number, action: LessonEditAction) => {
    if (state?.setId == null) return;
    const setId = state.setId;
    if (action === "promote" && promoteBlockedNow) {
      const blocked = await promoteBlockedNow().catch(() => false);
      if (blocked) {
        setBlockedAtClick(true);
        return;
      }
    }
    void change(() => api.editLesson(setId, position, action), action === "promote" ? t("lessons.promoted") : undefined);
  };
  const restore = (setId: number) => {
    if (state?.setId == null) return;
    const current = state.setId;
    void change(() => api.restoreLessonSet(setId, current), t("lessons.sets.restored"));
  };

  const availability = state?.availability;
  const unavailable = availability && !availability.available ? availability : null;
  // No run can call the AI: say so as plainly as Off. When the switch is on
  // and a set is already saved, that set still reaches the drafts, so the
  // message says that instead of "not learning" (one message, no caption).
  const storedStillUsed = !!unavailable && !!state?.enabled && (state?.lessons.length ?? 0) > 0;
  const unavailableText = !unavailable
    ? null
    : storedStillUsed
      ? t("lessons.unavailableStillUsed", {
          why:
            unavailable.reason === "provider_not_supported"
              ? t("lessons.why.provider", { provider: unavailable.provider ?? "?" })
              : unavailable.reason === "not_translation_project"
                ? t("lessons.why.notTranslation")
                : t("lessons.why.noKey"),
          n: state?.lessons.length ?? 0,
        })
      : unavailable.reason === "provider_not_supported"
        ? t("lessons.unavailableProvider", { provider: unavailable.provider ?? "?" })
        : unavailable.reason === "not_translation_project"
          ? t("lessons.unavailableNotTranslation")
          : t("lessons.unavailableNoKey");

  return (
    <Stack spacing={2} data-testid="lessons-section">
      {heading && (
        <Box>
          <Typography variant="h6">{t("lessons.title")}</Typography>
          <Typography variant="body2" color="text.secondary" sx={{ mt: 0.5 }}>
            {t("lessons.intro")}
          </Typography>
        </Box>
      )}
      {saveError && (
        <Alert severity="error" onClose={() => setSaveError(false)}>
          {t("lessons.saveFailed")}
        </Alert>
      )}
      {editError && (
        <Alert severity="error" onClose={() => setEditError(null)} data-testid="lessons-edit-error">
          {editError}
        </Alert>
      )}
      {notice && (
        <Alert severity="success" onClose={() => setNotice(null)} data-testid="lessons-notice">
          {notice}
        </Alert>
      )}
      {loadError ? (
        <Alert severity="error">{t("lessons.loadFailed")}</Alert>
      ) : state === null ? (
        <CircularProgress size={22} />
      ) : state.notMigrated ? (
        <Alert severity="warning" variant="outlined">
          {t("lessons.notMigrated")}
        </Alert>
      ) : (
        <>
          <FormControlLabel
            sx={{ m: 0, alignSelf: "flex-start" }}
            control={
              <Switch
                checked={state.enabled}
                // Switching off is always allowed; switching on needs a provider that can run.
                disabled={busy || (!state.enabled && !!unavailable)}
                onChange={(e) => toggle(e.target.checked)}
                inputProps={{ "aria-label": t("lessons.toggleAria") }}
              />
            }
            label={busy ? <CircularProgress size={16} /> : state.enabled ? t("lessons.switchOn") : t("lessons.switchOff")}
          />
          {unavailableText ? (
            <Alert severity="warning" data-testid="lessons-status">
              {unavailableText}
            </Alert>
          ) : state.enabled ? (
            <Alert severity="success" variant="outlined" data-testid="lessons-status">
              {t("lessons.statusOn")}
            </Alert>
          ) : (
            <Alert severity="warning" data-testid="lessons-status">
              {t("lessons.statusOff")}
            </Alert>
          )}
          <Typography variant="body2" color="text.secondary">
            {t("lessons.cost")}
          </Typography>
          <Typography variant="body2" color="text.secondary" data-testid="lessons-last-run">
            {state.lastRun ? runSummary(state.lastRun, t) : t("lessons.run.never")}
          </Typography>
          <Box>
            <Typography variant="subtitle2" sx={{ mb: 1 }}>
              {t("lessons.listTitle", { n: state.lessons.length, max: state.maxLessons })}
            </Typography>
            {state.lessons.length === 0 ? (
              <Typography variant="body2" color="text.secondary">
                {t("lessons.empty")}
              </Typography>
            ) : (
              <Stack spacing={1}>
                {promoteBlocked && (
                  <Alert severity="info" variant="outlined" data-testid="lessons-promote-blocked">
                    {t("lessons.promoteBlocked")}
                  </Alert>
                )}
                {state.lessons.map((l, i) => (
                  <LessonCard
                    key={`${state.setId}-${i}`}
                    lesson={l}
                    busy={busy}
                    promoteBlocked={promoteBlocked}
                    onAction={(a) => void edit(i + 1, a)}
                  />
                ))}
              </Stack>
            )}
            {state.lessons.length > 0 && !state.enabled && (
              <Typography variant="caption" color="text.secondary" component="p" sx={{ mt: 1 }}>
                {t("lessons.storedNotUsed")}
              </Typography>
            )}
            <Typography variant="caption" color="text.secondary" component="p" sx={{ mt: 1 }}>
              {t("lessons.editHelp")}
            </Typography>
          </Box>
          {state.sets.length > 1 && (
            <Box data-testid="lessons-sets">
              <Typography variant="subtitle2" sx={{ mb: 0.5 }}>
                {t("lessons.sets.title")}
              </Typography>
              <Typography variant="caption" color="text.secondary" component="p" sx={{ mb: 1 }}>
                {t("lessons.sets.intro")}
              </Typography>
              <Stack spacing={0.5}>
                {state.sets.map((s, i) => {
                  const when = s.at != null ? formatEpochSecondsDateTime(s.at) : "?";
                  return (
                    <Stack key={s.id} direction="row" alignItems="center" gap={1} flexWrap="wrap">
                      <Typography variant="body2" sx={{ flex: 1, minWidth: 0 }}>
                        {t("lessons.sets.line", { when, label: setLabel(s, t), n: s.count })}
                      </Typography>
                      {i === 0 ? (
                        <Chip size="small" label={t("lessons.sets.current")} />
                      ) : (
                        <Button
                          size="small"
                          disabled={busy}
                          onClick={() => restore(s.id)}
                          aria-label={t("lessons.sets.restoreAria", { when })}
                        >
                          {t("lessons.sets.restoreButton")}
                        </Button>
                      )}
                    </Stack>
                  );
                })}
              </Stack>
            </Box>
          )}
        </>
      )}
    </Stack>
  );
}
