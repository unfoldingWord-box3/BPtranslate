import { useEffect, useState } from "react";
import { Alert, Box, CircularProgress, FormControlLabel, Stack, Switch, Typography } from "@mui/material";
import { useTranslation } from "react-i18next";
import { api, type HouseStyleRule } from "../sync/api";
import { formatEpochSecondsDateTime } from "../lib/formatDate";

// ── House-style rules (issue #815, admin-only) ──────────────────────────────
// Mechanical fixes made to AI translate drafts when they are imported (the
// engine is api/src/houseStyle.ts). Rules arrive by migration with their
// examples; an admin can only switch each one on or off here. Mounted in
// classic Preferences (section "houseStyle") and on the desk's Style page.
// `heading` is false where the host already renders a title (the desk Panel).

function kindLabelKey(rule: HouseStyleRule): string {
  switch (rule.kind) {
    case "literal":
      return rule.replace === "" ? "houseStyle.kind.delete" : "houseStyle.kind.literal";
    case "whole_word":
      return "houseStyle.kind.wholeWord";
    case "final_bracket_period":
      return "houseStyle.kind.finalBracketPeriod";
    default:
      return "houseStyle.kind.unknown";
  }
}

// Text from the rule data (often Arabic) inside UI text in either direction:
// dir="auto" isolates it so brackets and periods land on the right side.
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

function RuleCard({
  rule,
  busy,
  onToggle,
}: {
  rule: HouseStyleRule;
  busy: boolean;
  onToggle: (enabled: boolean) => void;
}) {
  const { t } = useTranslation();
  const textRule = rule.kind === "literal" || rule.kind === "whole_word";
  return (
    <Box
      data-rule-id={rule.id}
      sx={{ border: 1, borderColor: rule.enabled ? "primary.main" : "divider", borderRadius: 1.5, p: 2 }}
    >
      <Stack direction="row" alignItems="flex-start" justifyContent="space-between" gap={2}>
        <Box sx={{ minWidth: 0 }}>
          <Typography variant="subtitle1" sx={{ fontWeight: 700 }}>
            {t(kindLabelKey(rule))}
          </Typography>
          {textRule && (
            <Stack direction="row" flexWrap="wrap" alignItems="center" gap={1} sx={{ mt: 0.5 }}>
              <Typography variant="body2" color="text.secondary">
                {t("houseStyle.find")}
              </Typography>
              <Sample text={rule.find} />
              {rule.replace !== "" && (
                <>
                  <Typography variant="body2" color="text.secondary">
                    {t("houseStyle.replaceWith")}
                  </Typography>
                  <Sample text={rule.replace} />
                </>
              )}
            </Stack>
          )}
          <Typography variant="body2" color="text.secondary" sx={{ mt: 0.5 }}>
            {rule.kind === "final_bracket_period"
              ? t("houseStyle.finalBracketPeriodDetail")
              : rule.scope === "end-of-note"
                ? t("houseStyle.scope.endOfNote")
                : t("houseStyle.scope.note")}
          </Typography>
        </Box>
        <FormControlLabel
          sx={{ flexShrink: 0, m: 0 }}
          control={
            <Switch
              checked={rule.enabled}
              // An unsupported rule may not be switched ON (the API refuses),
              // but one that is somehow on can always be switched off.
              disabled={busy || (!rule.supported && !rule.enabled)}
              onChange={(e) => onToggle(e.target.checked)}
              inputProps={{ "aria-label": t("houseStyle.toggleAria", { rule: t(kindLabelKey(rule)) }) }}
            />
          }
          label={busy ? <CircularProgress size={16} /> : rule.enabled ? t("houseStyle.on") : t("houseStyle.off")}
        />
      </Stack>
      {!rule.supported && (
        <Alert severity="warning" variant="outlined" sx={{ mt: 1 }}>
          {t("houseStyle.unsupported")}
        </Alert>
      )}
      {rule.examples.length > 0 && (
        <Box sx={{ mt: 1.5 }}>
          <Typography variant="body2" sx={{ fontWeight: 600 }}>
            {t("houseStyle.examples")}
          </Typography>
          <Stack spacing={0.75} sx={{ mt: 0.5 }}>
            {rule.examples.map((ex, i) => (
              <Stack key={i} direction="row" flexWrap="wrap" alignItems="center" gap={1}>
                <Typography variant="caption" color="text.secondary">
                  {t("houseStyle.before")}
                </Typography>
                <Sample text={ex.before} />
                <Typography variant="caption" color="text.secondary">
                  {t("houseStyle.after")}
                </Typography>
                <Sample text={ex.after} />
              </Stack>
            ))}
          </Stack>
        </Box>
      )}
      {rule.counterExamples.length > 0 && (
        <Box sx={{ mt: 1.5 }}>
          <Typography variant="body2" sx={{ fontWeight: 600 }}>
            {t("houseStyle.counterExamples")}
          </Typography>
          <Stack direction="row" flexWrap="wrap" gap={1} sx={{ mt: 0.5 }}>
            {rule.counterExamples.map((ce, i) => (
              <Sample key={i} text={ce} />
            ))}
          </Stack>
        </Box>
      )}
      {rule.updatedBy && (
        <Typography variant="caption" color="text.secondary" component="p" sx={{ mt: 1.5 }}>
          {t("houseStyle.changedBy", { name: rule.updatedBy, when: formatEpochSecondsDateTime(rule.updatedAt) })}
        </Typography>
      )}
    </Box>
  );
}

export function HouseStyleRulesSection({ heading = true }: { heading?: boolean }) {
  const { t } = useTranslation();
  const [rules, setRules] = useState<HouseStyleRule[] | null>(null);
  const [loadError, setLoadError] = useState(false);
  // The server's database has not had migration 0082 yet (no rules table).
  const [notMigrated, setNotMigrated] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [toggleError, setToggleError] = useState(false);

  useEffect(() => {
    let cancelled = false;
    api
      .getHouseStyleRules()
      .then((r) => {
        if (cancelled) return;
        setRules(r.rules);
        setNotMigrated(r.notMigrated === true);
      })
      .catch(() => {
        if (!cancelled) setLoadError(true);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const toggle = async (id: string, enabled: boolean) => {
    setBusyId(id);
    setToggleError(false);
    try {
      const { rule } = await api.setHouseStyleRuleEnabled(id, enabled);
      setRules((prev) => prev?.map((r) => (r.id === id ? rule : r)) ?? prev);
    } catch {
      setToggleError(true);
    } finally {
      setBusyId(null);
    }
  };

  return (
    <Stack spacing={2}>
      {heading && (
        <Box>
          <Typography variant="h6">{t("houseStyle.title")}</Typography>
          <Typography variant="body2" color="text.secondary" sx={{ mt: 0.5 }}>
            {t("houseStyle.intro")}
          </Typography>
        </Box>
      )}
      <Alert severity="info" variant="outlined">
        {t("houseStyle.safety")}
      </Alert>
      {toggleError && (
        <Alert severity="error" onClose={() => setToggleError(false)}>
          {t("houseStyle.toggleFailed")}
        </Alert>
      )}
      {loadError ? (
        <Alert severity="error">{t("houseStyle.loadFailed")}</Alert>
      ) : rules === null ? (
        <CircularProgress size={22} />
      ) : notMigrated ? (
        <Alert severity="warning" variant="outlined">
          {t("houseStyle.notMigrated")}
        </Alert>
      ) : rules.length === 0 ? (
        <Typography variant="body2" color="text.secondary">
          {t("houseStyle.empty")}
        </Typography>
      ) : (
        rules.map((rule) => (
          <RuleCard key={rule.id} rule={rule} busy={busyId === rule.id} onToggle={(on) => toggle(rule.id, on)} />
        ))
      )}
    </Stack>
  );
}
