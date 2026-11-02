// Translator-triggered re-import of selected resources for a chapter range
// directly from Door43. Maintenance lane (NOT the first-time bootstrap path,
// which is /api/books/:book/import — destructive). The backend pristine-only
// rule means edits already in flight are never clobbered: see
// api/src/bookReimport.ts.

import { useEffect, useMemo, useState } from "react";
import {
  Box,
  Button,
  Checkbox,
  CircularProgress,
  Dialog,
  DialogActions,
  DialogContent,
  DialogContentText,
  DialogTitle,
  FormControlLabel,
  FormGroup,
  TextField,
  Typography,
} from "@mui/material";
import { ApiError, api, type ReimportResource, type ReimportResponse } from "../sync/api";
import { parseChapterRange } from "../lib/refParser";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";

interface Props {
  open: boolean;
  onClose: () => void;
  book: string;
  currentChapter: number;
  /**
   * Optional seed for the chapter/range input each time the dialog opens.
   * When set (e.g. "1-50" for a whole-book re-pull) it wins over currentChapter,
   * so accepting the default refreshes the whole book rather than one chapter.
   */
  initialRef?: string;
  onMessage?: (msg: string) => void;
  /** Called after a successful import so the parent can refetch the chapter. */
  onImported?: () => void;
}

interface ResourceState {
  ult: boolean;
  ust: boolean;
  tn: boolean;
  tq: boolean;
  twl: boolean;
}

const LS_KEY = "bible-editor.import.door43.options";
const DEFAULT_STATE: ResourceState = {
  ult: false,
  ust: false,
  tn: false,
  tq: false,
  twl: false,
};

function loadOpts(): ResourceState {
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (!raw) return DEFAULT_STATE;
    const parsed = JSON.parse(raw) as Partial<ResourceState>;
    return {
      ult: !!parsed.ult,
      ust: !!parsed.ust,
      tn: !!parsed.tn,
      tq: !!parsed.tq,
      twl: !!parsed.twl,
    };
  } catch {
    return DEFAULT_STATE;
  }
}

function saveOpts(opts: ResourceState) {
  try {
    localStorage.setItem(LS_KEY, JSON.stringify(opts));
  } catch {
    /* private mode etc. */
  }
}

// `t` is passed in (not captured) so the summary is built in the language
// showing at the moment of the import.
function summarize(res: ReimportResponse, t: TFunction): string {
  const n = res.totals;
  const parts: string[] = [];
  if (n.updated) parts.push(t("dialogs.import.updated", { count: n.updated }));
  if (n.reimported_ai) parts.push(t("dialogs.import.refreshedAi", { count: n.reimported_ai }));
  if (n.inserted) parts.push(t("dialogs.import.inserted", { count: n.inserted }));
  if (n.skipped_edited) parts.push(t("dialogs.import.skippedEdited", { count: n.skipped_edited }));
  if (n.skipped_locked) parts.push(t("dialogs.import.skippedLocked", { count: n.skipped_locked }));
  if (n.skipped_noop) parts.push(t("dialogs.import.unchanged", { count: n.skipped_noop }));
  if (n.source_attr_reconciled)
    parts.push(t("dialogs.import.sourceAttrSynced", { count: n.source_attr_reconciled }));
  if (n.dcs_404) parts.push(t("dialogs.import.notOnDcs", { count: n.dcs_404 }));
  if (parts.length === 0) return t("dialogs.import.noChanges", { book: res.book });
  return t("dialogs.import.summary", { book: res.book, parts: parts.join(t("dialogs.import.separator")) });
}

export function ImportFromDoor43Dialog({
  open,
  onClose,
  book,
  currentChapter,
  initialRef,
  onMessage,
  onImported,
}: Props) {
  const { t } = useTranslation();
  const [opts, setOpts] = useState<ResourceState>(() => loadOpts());
  const [refInput, setRefInput] = useState<string>(initialRef ?? String(currentChapter));
  const [submitting, setSubmitting] = useState(false);

  // Reload last-used resource selection and reset the chapter/range input each
  // time the dialog opens. `initialRef` (e.g. a whole-book "1-50" range) wins
  // over currentChapter so the default re-pull refreshes everything.
  useEffect(() => {
    if (open) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- loadOpts() reads localStorage (an external store another tab can change) on each open; that read belongs after commit, not in render.
      setOpts(loadOpts());
      setRefInput(initialRef ?? String(currentChapter));
    }
  }, [open, currentChapter, initialRef]);

  // `t` is a dep because parseChapterRange returns a translated error message;
  // without it the message stays in the previous language after a switch. Safe
  // here — pure derivation, no fetch.
  // eslint-disable-next-line react-hooks/exhaustive-deps -- `t` is a deliberate recompute signal (see above); the linter cannot see that parseChapterRange reads the active language.
  const refParsed = useMemo(() => parseChapterRange(refInput, book), [refInput, book, t]);
  const nothingSelected = !opts.ult && !opts.ust && !opts.tn && !opts.tq && !opts.twl;
  const canSubmit = !submitting && refParsed.ok && !nothingSelected;

  const submit = async () => {
    if (!refParsed.ok) return;
    const resources: ReimportResource[] = [];
    if (opts.ult) resources.push("ult");
    if (opts.ust) resources.push("ust");
    if (opts.tn) resources.push("tn");
    if (opts.tq) resources.push("tq");
    if (opts.twl) resources.push("twl");
    if (resources.length === 0) return;

    const { startChapter, endChapter } = refParsed.range;
    const chapters: number[] = [];
    for (let c = startChapter; c <= endChapter; c++) chapters.push(c);

    setSubmitting(true);
    try {
      const res = await api.reimportFromDoor43(refParsed.range.book, { chapters, resources });
      saveOpts(opts);
      onMessage?.(summarize(res, t));
      onImported?.();
      onClose();
    } catch (e) {
      if (e instanceof ApiError) {
        const body = e.body as { error?: string; detail?: string } | undefined;
        if (e.status === 404) {
          onMessage?.(t("importDialog.notImportedYet", { book: refParsed.range.book }));
        } else if (e.status === 409) {
          onMessage?.(t("importDialog.alreadyRunning", { book: refParsed.range.book }));
        } else if (e.status === 401) {
          onMessage?.(t("importDialog.signIn"));
        } else if (e.status === 422) {
          onMessage?.(t("importDialog.invalidRequest", { detail: body?.detail ?? body?.error ?? t("importDialog.checkInput") }));
        } else {
          onMessage?.(t("importDialog.importFailed", { message: body?.error ?? e.message }));
        }
      } else {
        onMessage?.(t("importDialog.importFailedGeneric"));
      }
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Dialog open={open} onClose={() => !submitting && onClose()} maxWidth="sm" fullWidth>
      <DialogTitle>{t("importDialog.title")}</DialogTitle>
      <DialogContent>
        <DialogContentText>{t("importDialog.description")}</DialogContentText>
        <Box sx={{ mt: 2, display: "flex", alignItems: "flex-start", gap: 1.5 }}>
          <Typography sx={{ pt: 1, fontWeight: 500 }}>{book}</Typography>
          <TextField
            label={t("importDialog.chapterOrRange")}
            value={refInput}
            onChange={(e) => setRefInput(e.target.value.replace(/[^\d-]/g, ""))}
            disabled={submitting}
            fullWidth
            size="small"
            autoFocus
            error={!refParsed.ok}
            inputProps={{ inputMode: "numeric", pattern: "[0-9-]*" }}
            helperText={
              refParsed.ok
                ? refParsed.range.startChapter === refParsed.range.endChapter
                  ? t("importDialog.importsChapter", { book: refParsed.range.book, chapter: refParsed.range.startChapter })
                  : t("importDialog.importsRange", { book: refParsed.range.book, startChapter: refParsed.range.startChapter, endChapter: refParsed.range.endChapter })
                : refParsed.error
            }
          />
        </Box>
        <Box sx={{ mt: 2 }}>
          <DialogContentText sx={{ mb: 1, fontSize: "0.875rem" }}>
            {t("importDialog.whatToImport")}
          </DialogContentText>
          <FormGroup>
            <FormControlLabel
              control={
                <Checkbox
                  checked={opts.ult}
                  onChange={(_, v) => setOpts((o) => ({ ...o, ult: v }))}
                  disabled={submitting}
                />
              }
              label={t("importDialog.ultLabel")}
            />
            <FormControlLabel
              control={
                <Checkbox
                  checked={opts.ust}
                  onChange={(_, v) => setOpts((o) => ({ ...o, ust: v }))}
                  disabled={submitting}
                />
              }
              label={t("importDialog.ustLabel")}
            />
            <FormControlLabel
              control={
                <Checkbox
                  checked={opts.tn}
                  onChange={(_, v) => setOpts((o) => ({ ...o, tn: v }))}
                  disabled={submitting}
                />
              }
              label={t("importDialog.tnLabel")}
            />
            <FormControlLabel
              control={
                <Checkbox
                  checked={opts.tq}
                  onChange={(_, v) => setOpts((o) => ({ ...o, tq: v }))}
                  disabled={submitting}
                />
              }
              label={t("importDialog.tqLabel")}
            />
            <FormControlLabel
              control={
                <Checkbox
                  checked={opts.twl}
                  onChange={(_, v) => setOpts((o) => ({ ...o, twl: v }))}
                  disabled={submitting}
                />
              }
              label={t("importDialog.twlLabel")}
            />
          </FormGroup>
          {nothingSelected ? (
            <DialogContentText sx={{ mt: 1, fontSize: "0.8125rem", color: "warning.main" }}>
              {t("importDialog.selectAtLeastOne")}
            </DialogContentText>
          ) : null}
        </Box>
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose} disabled={submitting}>
          {t("importDialog.cancel")}
        </Button>
        <Button
          onClick={submit}
          variant="contained"
          disabled={!canSubmit}
          startIcon={submitting ? <CircularProgress size={14} /> : undefined}
        >
          {t("importDialog.import")}
        </Button>
      </DialogActions>
    </Dialog>
  );
}
