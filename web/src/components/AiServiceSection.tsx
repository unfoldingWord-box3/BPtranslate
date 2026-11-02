// Org-wide AI provider + bring-your-own-key admin section (backend:
// api/src/aiProvider.ts). The adaptive-flows redesign (docs/flows/02-architecture.md
// D2/D3) places admin-scoped config on dedicated Admin-flow screens, so this
// component is expected to move to an a5-class Admin screen when the flows port
// reaches preferences — kept free of prefs-rail dependencies so that's a one-line
// import move.

import { useEffect, useRef, useState } from "react";
import {
  Alert,
  Box,
  Button,
  CircularProgress,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  MenuItem,
  Snackbar,
  Stack,
  TextField,
  Typography,
} from "@mui/material";
import DeleteOutlineIcon from "@mui/icons-material/DeleteOutline";
import SaveIcon from "@mui/icons-material/Save";
import { useTranslation } from "react-i18next";
import { api, ApiError, type AiProviderSettings } from "../sync/api";
import { adminKeyWarningCopyKey } from "../lib/aiErrorCopy";

type KeyStatus = { available: boolean; reason: string | null };

// "default" is not in the picker: it means "no org key", and there is no shared
// account behind it (#551), so the server refuses it on PUT. Clear (DELETE) is
// what leaves the org on it. Gemini is the suggested starting point for a new
// key (bsoj has a key; Gemini/Grok have been strongest for translation).
const PROVIDER_ORDER = ["gemini", "xai", "claude", "openai"] as const;
const UI_DEFAULT_PROVIDER = "gemini" as const;

// Same shape/contract as prefsConflict.ts's currentPrefsFromConflict, just for
// the ai-provider row instead of TranslationPrefs — kept local since that
// helper is typed to TranslationPrefs specifically.
function currentFromConflict(body: unknown): AiProviderSettings | null {
  if (!body || typeof body !== "object") return null;
  const b = body as Record<string, unknown>;
  if (b.error !== "version_mismatch") return null;
  const current = b.current;
  if (!current || typeof current !== "object") return null;
  const c = current as Record<string, unknown>;
  if (typeof c.version !== "number") return null;
  return current as AiProviderSettings;
}

// ── Shared save-state helper (mirrors PreferencesWorkspace's useSaveState;
// that one is module-internal there, so this is a standalone equivalent). ──
function useSaveState() {
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  return { saving, setSaving, msg, setMsg, clear: () => setMsg(null) };
}

export function AiServiceSection() {
  const { t } = useTranslation();
  const [settings, setSettings] = useState<AiProviderSettings | null>(null);
  const [loadError, setLoadError] = useState(false);
  const save = useSaveState();

  // Draft form state, seeded from `settings` once loaded.
  const [draftProvider, setDraftProvider] = useState<string>(UI_DEFAULT_PROVIDER);
  const [draftModel, setDraftModel] = useState<string>("");
  const [apiKey, setApiKey] = useState("");
  const [replacing, setReplacing] = useState(false);
  const [clearOpen, setClearOpen] = useState(false);
  const [clearing, setClearing] = useState(false);
  // GET /api/ai-provider/status: `configured` above only says a key is stored;
  // this says whether it can actually be used (it decrypts). A rotated wrapping
  // secret leaves a key that looks configured but fails every run (#551 part F).
  const [keyStatus, setKeyStatus] = useState<KeyStatus | null>(null);

  // Only the latest probe may set keyStatus: a slow load-time probe resolving
  // after the post-Save one would otherwise show a stale warning under a key
  // that was just saved. `mounted` stops a late answer landing after unmount.
  const statusSeq = useRef(0);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  // Best effort: a failed probe shows no warning rather than a wrong one.
  const refreshStatus = () => {
    const seq = ++statusSeq.current;
    const isCurrent = () => mounted.current && seq === statusSeq.current;
    setKeyStatus(null);
    api
      .getAiProviderStatus()
      .then((res) => {
        if (isCurrent()) setKeyStatus(res);
      })
      .catch(() => {
        if (isCurrent()) setKeyStatus(null);
      });
  };

  // Map a server row into draft fields. provider=default is no longer selectable,
  // so treat it as an empty slate pre-filled with Gemini + its first model.
  const applySettingsToDraft = (res: AiProviderSettings) => {
    if (res.provider === "default") {
      setDraftProvider(UI_DEFAULT_PROVIDER);
      setDraftModel(res.catalog.models[UI_DEFAULT_PROVIDER]?.[0] ?? "");
    } else {
      setDraftProvider(res.provider);
      setDraftModel(res.model ?? "");
    }
  };

  const load = async () => {
    setLoadError(false);
    try {
      const res = await api.getAiProvider();
      setSettings(res);
      applySettingsToDraft(res);
      refreshStatus();
    } catch {
      setLoadError(true);
    }
  };

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- mount-time load; the same `load` backs the Retry button, so it must clear loadError at start or a retry keeps showing the failure alert while it refetches.
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- mount-only load; `load` is a new function every render (the Retry button calls it directly), so listing it would refetch on every render.
  }, []);

  if (settings === null) {
    return loadError ? (
      <Alert
        severity="error"
        action={
          <Button size="small" onClick={() => void load()}>
            {t("common.retry")}
          </Button>
        }
      >
        {t("preferences.aiService.loadFailed")}
      </Alert>
    ) : (
      <CircularProgress size={22} />
    );
  }

  const catalog = settings.catalog;
  const modelsForProvider = catalog.models[draftProvider] ?? [];
  const encryptionAvailable = settings.encryptionAvailable;
  // A stored key applies to `draftProvider` only when the draft hasn't been
  // switched away from the saved provider — an OpenAI key is meaningless to
  // Gemini (same reasoning as the server's applyWrite carry-over guard).
  const hasStoredKeyForDraft = settings.configured && settings.provider === draftProvider;
  const showKeyField = !hasStoredKeyForDraft || replacing;
  const keyRequired = showKeyField && apiKey.trim() === "";
  // Key field and Replace need the wrapping secret; Clear still works without it
  // (server-side Clear wipes the key without needing to encrypt a new one).
  const keyActionsDisabled = !encryptionAvailable;
  // Shown in place of "Configured •••• hint" when the stored key can't be used.
  const keyWarning = adminKeyWarningCopyKey(settings.configured, keyStatus);

  const handleProviderChange = (next: string) => {
    setDraftProvider(next);
    setReplacing(false);
    setApiKey("");
    if (next === settings.provider && settings.model) {
      setDraftModel(settings.model);
    } else {
      const models = catalog.models[next] ?? [];
      setDraftModel(models[0] ?? "");
    }
  };

  const applyConflictOrError = (e: unknown) => {
    if (e instanceof ApiError && e.status === 409) {
      const current = currentFromConflict(e.body);
      if (current) {
        setSettings(current);
        applySettingsToDraft(current);
        // Another admin may have re-entered (or cleared) the key: re-probe so
        // the can't-be-read warning matches the reloaded row.
        refreshStatus();
        setApiKey("");
        setReplacing(false);
      }
      save.setMsg(t("preferences.aiService.conflictReloaded"));
    } else if (e instanceof ApiError && e.status === 403) {
      save.setMsg(t("preferences.saveForbidden"));
    } else if (e instanceof ApiError && e.status === 503) {
      // Two distinct 503s: the wrapping-key secret is unset, or this workspace's
      // DB predates the ai_provider_config migration. Don't blame encryption for
      // a migration gap — the admin fixes them differently.
      const code = (e.body as { error?: string } | null)?.error;
      save.setMsg(
        t(
          code === "ai_provider_not_migrated"
            ? "preferences.aiService.notMigrated"
            : "preferences.aiService.encryptionUnavailable",
        ),
      );
    } else {
      save.setMsg(t("preferences.saveFailed"));
    }
  };

  const onSave = async () => {
    save.setSaving(true);
    try {
      const body = apiKey.trim()
        ? { provider: draftProvider, model: draftModel, apiKey: apiKey.trim() }
        : { provider: draftProvider, model: draftModel };
      const res = await api.putAiProvider(settings.version, body);
      setSettings(res);
      applySettingsToDraft(res);
      refreshStatus();
      setApiKey("");
      setReplacing(false);
      save.setMsg(t("preferences.saved"));
    } catch (e) {
      applyConflictOrError(e);
    } finally {
      save.setSaving(false);
    }
  };

  const onClear = async () => {
    setClearing(true);
    try {
      const res = await api.clearAiProvider(settings.version);
      setSettings(res);
      applySettingsToDraft(res);
      refreshStatus();
      setApiKey("");
      setReplacing(false);
      save.setMsg(t("preferences.saved"));
    } catch (e) {
      applyConflictOrError(e);
    } finally {
      setClearing(false);
      setClearOpen(false);
    }
  };

  const saveDisabled = save.saving || !encryptionAvailable || keyRequired;

  return (
    <Box component="section" aria-labelledby="ai-service-heading">
      <Typography id="ai-service-heading" variant="h6" gutterBottom>
        {t("preferences.aiService.title")}
      </Typography>
      <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
        {t("preferences.aiService.intro")}
      </Typography>

      {/* `configured` = a usable key is stored (server's publicShape), so this
          also covers a never-written row and the moment after Clear key. The
          form below keeps its Gemini pre-fill as the start for a new key. */}
      {!settings.configured && (
        <Alert severity="info" sx={{ mb: 2 }}>
          {t("preferences.aiService.noKey")}
        </Alert>
      )}

      {!encryptionAvailable && (
        <Alert severity="warning" sx={{ mb: 2 }}>
          {t("preferences.aiService.encryptionUnavailable")}
        </Alert>
      )}

      <Stack spacing={2} sx={{ maxWidth: 480 }}>
        <TextField
          select
          size="small"
          label={t("preferences.aiService.providerLabel")}
          value={draftProvider}
          onChange={(e) => handleProviderChange(e.target.value)}
        >
          {PROVIDER_ORDER.map((p) => (
            <MenuItem key={p} value={p}>
              {t(`preferences.aiService.provider.${p}`)}
            </MenuItem>
          ))}
        </TextField>

        <TextField
          select
          size="small"
          label={t("preferences.aiService.model")}
          value={draftModel}
          onChange={(e) => setDraftModel(e.target.value)}
        >
          {modelsForProvider.map((m) => (
            <MenuItem key={m} value={m}>
              {m}
            </MenuItem>
          ))}
        </TextField>

        {!showKeyField && keyWarning && (
          <Alert severity="warning" role="alert">
            {t(keyWarning)}
          </Alert>
        )}

        {!showKeyField && (
          <Stack direction="row" spacing={1} alignItems="center" flexWrap="wrap" gap={1}>
            {!keyWarning && (
              <Typography variant="body2">
                {t("preferences.aiService.configured", { hint: settings.keyHint ?? "" })}
              </Typography>
            )}
            <Button size="small" onClick={() => setReplacing(true)} disabled={keyActionsDisabled}>
              {t("preferences.aiService.replace")}
            </Button>
            <Button
              size="small"
              color="warning"
              startIcon={<DeleteOutlineIcon />}
              onClick={() => setClearOpen(true)}
            >
              {t("preferences.aiService.clear")}
            </Button>
          </Stack>
        )}

        {showKeyField && (
          <Stack direction="row" spacing={1} alignItems="flex-start">
            <TextField
              type="password"
              autoComplete="new-password"
              size="small"
              label={t("preferences.aiService.apiKey")}
              helperText={t("preferences.aiService.apiKeyHelper")}
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
              disabled={keyActionsDisabled}
              fullWidth
            />
            {replacing && (
              <Button
                size="small"
                onClick={() => {
                  setReplacing(false);
                  setApiKey("");
                }}
              >
                {t("common.cancel")}
              </Button>
            )}
          </Stack>
        )}

        <Box>
          <Button
            variant="contained"
            startIcon={<SaveIcon />}
            onClick={() => void onSave()}
            disabled={saveDisabled}
          >
            {t("preferences.save")}
          </Button>
        </Box>
      </Stack>

      <Dialog open={clearOpen} onClose={() => !clearing && setClearOpen(false)} maxWidth="xs" fullWidth>
        <DialogTitle>{t("preferences.aiService.clearConfirmTitle")}</DialogTitle>
        <DialogContent>
          <Typography variant="body2">{t("preferences.aiService.clearConfirmBody")}</Typography>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setClearOpen(false)} disabled={clearing}>
            {t("common.cancel")}
          </Button>
          <Button
            color="warning"
            variant="contained"
            onClick={() => void onClear()}
            disabled={clearing}
            startIcon={clearing ? <CircularProgress size={16} color="inherit" /> : <DeleteOutlineIcon />}
          >
            {t("preferences.aiService.clearConfirmConfirm")}
          </Button>
        </DialogActions>
      </Dialog>

      <Snackbar open={!!save.msg} autoHideDuration={4000} onClose={save.clear} message={save.msg ?? ""} />
    </Box>
  );
}
