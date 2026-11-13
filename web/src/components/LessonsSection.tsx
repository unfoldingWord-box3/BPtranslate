import { useEffect, useState } from "react";
import { Alert, Box, CircularProgress, FormControlLabel, Stack, Switch, Typography } from "@mui/material";
import { useTranslation } from "react-i18next";
import { api, type Lesson, type LessonRun, type LessonsState } from "../sync/api";
import { formatEpochSecondsDateTime } from "../lib/formatDate";

// ── Lessons from editor corrections (issue #817, admin-only) ────────────────
// Each night, when this is on and editors approved notes, the server reads what
// they changed in the AI drafts, asks the project's own AI model for a short
// list of lessons, and adds them to instructions.md in the context pack
// (api/src/lessons.ts). Off by default for every project, and the page must say
// plainly when it is off or cannot run, so nobody expects drafts to improve
// when they will not. Read-only list for now; delete / pin / promote is part 2.
// Mounted in classic Preferences (section "lessons") and on the desk's Style
// page. `heading` is false where the host already renders a title.

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

function LessonCard({ lesson }: { lesson: Lesson }) {
  const { t } = useTranslation();
  return (
    <Box sx={{ border: 1, borderColor: "divider", borderRadius: 1.5, p: 1.5 }}>
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
    </Box>
  );
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

export function LessonsSection({ heading = true }: { heading?: boolean }) {
  const { t } = useTranslation();
  const [state, setState] = useState<LessonsState | null>(null);
  const [loadError, setLoadError] = useState(false);
  const [busy, setBusy] = useState(false);
  const [saveError, setSaveError] = useState(false);

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

  const availability = state?.availability;
  const unavailable = availability && !availability.available ? availability : null;
  // On, but no run can call the AI: say so as plainly as Off.
  const unavailableText = !unavailable
    ? null
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
                {state.lessons.map((l, i) => (
                  <LessonCard key={i} lesson={l} />
                ))}
              </Stack>
            )}
            {state.lessons.length > 0 && !state.enabled && (
              <Typography variant="caption" color="text.secondary" component="p" sx={{ mt: 1 }}>
                {t("lessons.storedNotUsed")}
              </Typography>
            )}
            {state.lessons.length > 0 && state.enabled && unavailable && (
              <Typography variant="caption" color="text.secondary" component="p" sx={{ mt: 1 }}>
                {t("lessons.storedStillUsed")}
              </Typography>
            )}
            <Typography variant="caption" color="text.secondary" component="p" sx={{ mt: 1 }}>
              {t("lessons.readOnly")}
            </Typography>
          </Box>
        </>
      )}
    </Stack>
  );
}
