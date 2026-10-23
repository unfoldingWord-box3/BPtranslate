import { useEffect, useMemo, useState } from "react";
import {
  Accordion,
  AccordionDetails,
  AccordionSummary,
  Alert,
  Box,
  Button,
  CircularProgress,
  FormControlLabel,
  InputAdornment,
  Snackbar,
  Stack,
  Switch,
  TextField,
  Typography,
} from "@mui/material";
import SaveIcon from "@mui/icons-material/Save";
import DownloadIcon from "@mui/icons-material/Download";
import ExpandMoreIcon from "@mui/icons-material/ExpandMore";
import SearchIcon from "@mui/icons-material/Search";
import { useTranslation } from "react-i18next";
import { api } from "../sync/api";
import { UI_LANGUAGES, dirForLang } from "../i18n";
import {
  flattenEn,
  currentValue,
  flatFromBag,
  mergedLocale,
  placeholdersOf,
  saveOverridePatch,
  type StringRow,
} from "../i18n/overrides";
import { useLocalizationMode, setLocalizationModeEnabled } from "../i18n/localizationMode";
import { useSaveState } from "./useSaveState";

// ── Localization editor (admin-only; migration 0052) ────────────────────────
// Edits the CURRENTLY-selected UI language against the English source. English
// column is read-only reference; the right column is the editable translation.
// Saves the whole language bag to the server (If-Match CAS) and applies it live
// via i18next, so the edit shows immediately and reaches other users on their
// next load. Export downloads the merged locale JSON for committing back.
export function LocalizationSection() {
  const { t, i18n } = useTranslation();
  const lang = i18n.language;
  const langLabel = UI_LANGUAGES.find((l) => l.code === lang)?.label ?? lang;
  const isEnglish = lang === "en";

  const rows = useMemo<StringRow[]>(() => flattenEn(), []);
  const save = useSaveState();
  const [version, setVersion] = useState<number | null>(null);
  const [stored, setStored] = useState<Record<string, string>>({}); // saved overrides, path→text
  const [draft, setDraft] = useState<Record<string, string>>({}); // unsaved edits, path→text
  const [query, setQuery] = useState("");
  const [loading, setLoading] = useState(true);
  // Perf (#77): ~3,218 keys means rendering every row's pair of TextFields at
  // once briefly freezes the main thread on open. Namespace groups are
  // collapsed by default (Accordion `unmountOnExit` means collapsed groups
  // mount ZERO fields), and a non-empty search auto-expands only the groups
  // that actually matched — so the common "hunt for a key" path only ever
  // mounts a small, filtered set of rows.
  const [manualExpanded, setManualExpanded] = useState<Set<string>>(new Set());
  const localizationModeOn = useLocalizationMode();

  // Load this language's stored overrides + version so the first save sends the
  // right If-Match and untouched overrides aren't wiped on a whole-bag PUT.
  useEffect(() => {
    let cancelled = false;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- on language change, show loading and drop the old language's unsaved draft before fetching that language's overrides; otherwise the old language's unsaved edits would show, and count as unsaved, against the new language's keys.
    setLoading(true);
    setDraft({});
    api
      .getL10nOverrides()
      .then(({ overrides, versions }) => {
        if (cancelled) return;
        setStored(flatFromBag(overrides[lang] ?? {}));
        setVersion(versions[lang] ?? 0);
      })
      .catch(() => {
        if (!cancelled) {
          setStored({});
          setVersion(0);
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [lang]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return rows;
    return rows.filter((r) => r.path.toLowerCase().includes(q) || r.english.toLowerCase().includes(q));
  }, [rows, query]);

  // Group rows by top-level namespace, preserving en.json order.
  const groups = useMemo(() => {
    const m = new Map<string, StringRow[]>();
    for (const r of filtered) {
      const list = m.get(r.ns);
      if (list) list.push(r);
      else m.set(r.ns, [r]);
    }
    return [...m.entries()];
  }, [filtered]);

  const valueFor = (path: string): string =>
    path in draft ? draft[path] : (currentValue(lang, path) ?? "");
  const dirtyCount = Object.keys(draft).length;

  const onSave = async () => {
    if (version == null || dirtyCount === 0) return;
    save.setSaving(true);
    try {
      // Whole-bag replace = prior stored overrides + this session's edits.
      const outcome = await saveOverridePatch(lang, version, stored, draft);
      if (outcome.ok) {
        setStored({ ...stored, ...draft });
        setVersion(outcome.version);
        setDraft({});
        save.setMsg(t("preferences.saved"));
      } else if (outcome.kind === "conflict") {
        // Another admin's write won — reload their overrides + version so the
        // next save has the right If-Match. Unsaved draft is kept.
        save.setMsg(t("preferences.conflict"));
        try {
          const { overrides, versions } = await api.getL10nOverrides();
          setStored(flatFromBag(overrides[lang] ?? {}));
          setVersion(versions[lang] ?? 0);
        } catch {
          /* leave state; user can retry */
        }
      } else if (outcome.kind === "forbidden") {
        save.setMsg(t("preferences.saveForbidden"));
      } else {
        save.setMsg(t("preferences.saveFailed"));
      }
    } finally {
      save.setSaving(false);
    }
  };

  const onExport = () => {
    const json = JSON.stringify(mergedLocale(lang), null, 2);
    const blob = new Blob([json], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${lang}.json`;
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <Stack spacing={2}>
      <Stack direction="row" alignItems="center" justifyContent="space-between" flexWrap="wrap" gap={1}>
        <Typography variant="h6">{t("preferences.section.localization")}</Typography>
        <Stack direction="row" spacing={1}>
          <Button variant="outlined" size="small" startIcon={<DownloadIcon />} onClick={onExport}>
            {t("preferences.localization.export")}
          </Button>
          <Button
            variant="contained"
            size="small"
            startIcon={<SaveIcon />}
            disabled={save.saving || dirtyCount === 0}
            onClick={onSave}
          >
            {dirtyCount > 0
              ? t("preferences.localization.saveCount", { count: dirtyCount })
              : t("preferences.save")}
          </Button>
        </Stack>
      </Stack>
      <Typography variant="body2" color="text.secondary">
        {isEnglish
          ? t("preferences.localization.introEnglish")
          : t("preferences.localization.intro", { language: langLabel })}
      </Typography>

      <FormControlLabel
        control={
          <Switch
            checked={localizationModeOn}
            onChange={(e) => setLocalizationModeEnabled(e.target.checked)}
          />
        }
        label={t("preferences.localization.inspectMode")}
      />

      <TextField
        size="small"
        fullWidth
        placeholder={t("preferences.localization.searchPlaceholder")}
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        InputProps={{
          startAdornment: (
            <InputAdornment position="start">
              <SearchIcon fontSize="small" />
            </InputAdornment>
          ),
        }}
      />

      {loading ? (
        <CircularProgress size={22} />
      ) : filtered.length === 0 ? (
        <Alert severity="info" variant="outlined">
          {t("preferences.localization.noMatches")}
        </Alert>
      ) : (
        <Stack spacing={1}>
          {groups.map(([ns, list]) => {
            // A live search forces every matching group open (the filtered
            // set is already small); otherwise only manually-expanded groups
            // mount their rows.
            const isSearching = query.trim().length > 0;
            const isOpen = isSearching || manualExpanded.has(ns);
            return (
              <Accordion
                key={ns}
                expanded={isOpen}
                disableGutters
                onChange={(_e, next) => {
                  if (isSearching) return; // search already forces this open
                  setManualExpanded((prev) => {
                    const nextSet = new Set(prev);
                    if (next) nextSet.add(ns);
                    else nextSet.delete(ns);
                    return nextSet;
                  });
                }}
                slotProps={{ transition: { unmountOnExit: true } }}
              >
                <AccordionSummary expandIcon={<ExpandMoreIcon />}>
                  <Typography variant="overline" color="text.secondary">
                    {ns} ({list.length})
                  </Typography>
                </AccordionSummary>
                <AccordionDetails>
                  <Stack spacing={1.5}>
                    {list.map((r) => {
                      const value = valueFor(r.path);
                      const dropped =
                        r.path in draft &&
                        placeholdersOf(r.english).filter((p) => !value.includes(p));
                      const hasWarning = Array.isArray(dropped) && dropped.length > 0;
                      const fieldId = `l10n-${lang}-${r.path}`;
                      return (
                        <Box key={r.path}>
                          <Typography
                            variant="caption"
                            color="text.secondary"
                            sx={{ fontFamily: "monospace", display: "block", mb: 0.25 }}
                          >
                            {r.path}
                          </Typography>
                          <Stack
                            direction={{ xs: "column", sm: "row" }}
                            spacing={1}
                            alignItems={{ sm: "flex-start" }}
                          >
                            <TextField
                              id={`${fieldId}-en`}
                              name={`${fieldId}-en`}
                              size="small"
                              fullWidth
                              value={r.english}
                              InputProps={{ readOnly: true }}
                              variant="filled"
                              multiline
                              maxRows={6}
                            />
                            <TextField
                              id={`${fieldId}-override`}
                              name={`${fieldId}-override`}
                              size="small"
                              fullWidth
                              dir={dirForLang(lang)}
                              value={value}
                              onChange={(e) => setDraft((d) => ({ ...d, [r.path]: e.target.value }))}
                              placeholder={isEnglish ? undefined : r.english}
                              multiline
                              maxRows={6}
                              error={hasWarning}
                              helperText={
                                hasWarning
                                  ? t("preferences.localization.placeholderWarning", {
                                      tokens: (dropped as string[]).join(", "),
                                    })
                                  : undefined
                              }
                            />
                          </Stack>
                        </Box>
                      );
                    })}
                  </Stack>
                </AccordionDetails>
              </Accordion>
            );
          })}
        </Stack>
      )}

      <Snackbar
        open={!!save.msg}
        autoHideDuration={4000}
        onClose={save.clear}
        message={save.msg ?? ""}
        anchorOrigin={{ vertical: "bottom", horizontal: "center" }}
      />
    </Stack>
  );
}
