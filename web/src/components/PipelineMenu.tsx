// Per-chapter trigger UI for bp-assistant pipelines (see
// docs/ai-pipeline-integration.md). Three pipeline types, ~1h each, run on
// the bot; we kick off and surface status via the bottom pill.

import { useEffect, useMemo, useState } from "react";
import {
  Button,
  Menu,
  MenuItem,
  ListItemText,
  Divider,
  Dialog,
  DialogTitle,
  DialogContent,
  DialogContentText,
  DialogActions,
  CircularProgress,
  FormGroup,
  FormControlLabel,
  Checkbox,
  Box,
  TextField,
  Typography,
} from "@mui/material";
import AutoAwesomeIcon from "@mui/icons-material/AutoAwesome";
import CloudDownloadIcon from "@mui/icons-material/CloudDownload";
import AutoStoriesIcon from "@mui/icons-material/AutoStories";
import TranslateIcon from "@mui/icons-material/Translate";
import { ApiError, api, importedSourceRepos, isAdmin, isReadOnly } from "../sync/api";
import { ImportFromDoor43Dialog } from "./ImportFromDoor43Dialog";
import type {
  ImportHasLocalEditsBody,
  PipelineChainStep,
  PipelineConflictBody,
  PipelineConflictExisting,
  PipelineRequestOptions,
  PipelineStartResponse,
  PipelineType,
  TranslateRequestOptions,
} from "../sync/api";
import { getSessionKey, pipelineStore, type PipelineJob } from "../sync/pipelineStore";
import { currentPipelineUserId } from "../sync/pipelineSession";
import { parseChapterRange } from "../lib/refParser";
import { useTranslation } from "react-i18next";
import { useProjectConfig, isTranslationProject } from "../hooks/useProjectConfig";

interface Props {
  book: string;
  chapter: number;
  onMessage?: (msg: string) => void;
  /** Called after a Door43 import completes so the parent can refetch the chapter. */
  onImported?: () => void;
}

interface PipelineOption {
  key: string;
  type: PipelineType;
  label: string;
  description: string;
  approxDuration: string;
  /**
   * When set, fires this pipeline plus a chain of cross-type follow-ups
   * after each step completes. The chapter lock holds across the full run.
   * Currently only used by the "Generate everything" macro.
   */
  followUpChain?: PipelineChainStep[];
  /**
   * Translate-pipeline overrides passed through to the start request. Used to
   * pick the resource (tn default | tq) for a chapter translate. The server
   * folds these into the config-derived options (buildTranslateOptions).
   */
  translate?: TranslateRequestOptions;
}

const OPTIONS: PipelineOption[] = [
  {
    key: "generate",
    type: "generate",
    label: "pipeline.generateUltUst",
    description: "pipeline.descGenerate",
    approxDuration: "pipeline.durationGenerate",
  },
  {
    key: "notes",
    type: "notes",
    label: "pipeline.writeTranslationNotes",
    description: "pipeline.descNotes",
    approxDuration: "pipeline.durationNotesTqs",
  },
  {
    key: "tqs",
    type: "tqs",
    label: "pipeline.writeTranslationQuestions",
    description: "pipeline.descTqs",
    approxDuration: "pipeline.durationNotesTqs",
  },
];

// Only offered in gateway-language projects (translationSource != null). Drafts
// the whole chapter's tN from the published source repo (server derives all
// options from project config via buildTranslateOptions).
const TRANSLATE_OPTION: PipelineOption = {
  key: "translate",
  type: "translate",
  label: "translation.translateChapter",
  description: "translation.descTranslate",
  approxDuration: "pipeline.durationNotesTqs",
};

// GL-only: drafts the whole chapter's tQ (translationQuestions) from the
// published source repo. Carries resourceType so the server reads en_tq and the
// bot outputs {lang}_tq.
const TRANSLATE_TQ_OPTION: PipelineOption = {
  key: "translate-tq",
  type: "translate",
  label: "translation.translateChapterQuestions",
  description: "translation.descTranslateQuestions",
  approxDuration: "pipeline.durationNotesTqs",
  translate: { resourceType: "tq" },
};

// Internal 4-checkbox state for the generate dialog. Maps to the wire shape
// (contract §3) at submit time via buildGenerateOptions. The contract's align
// flags are mutually exclusive within one call, so asymmetric combos
// (e.g. ULT-aligned + UST-not-aligned) are split into a parent call plus
// a server-side follow-up — see PipelineStartRequest.followUpOptions.
interface GenUiState {
  ult: boolean;
  ust: boolean;
  ultAlignment: boolean;
  ustAlignment: boolean;
}

const GEN_OPTS_LS = "bible-editor.pipeline.generate.options";
const DEFAULT_GEN_OPTS: GenUiState = {
  ult: true,
  ust: true,
  ultAlignment: true,
  ustAlignment: true,
};

function loadGenOpts(): GenUiState {
  try {
    const raw = localStorage.getItem(GEN_OPTS_LS);
    if (!raw) return DEFAULT_GEN_OPTS;
    const parsed = JSON.parse(raw) as Partial<GenUiState>;
    return {
      ult: parsed.ult ?? true,
      ust: parsed.ust ?? true,
      ultAlignment: parsed.ultAlignment ?? true,
      ustAlignment: parsed.ustAlignment ?? true,
    };
  } catch {
    return DEFAULT_GEN_OPTS;
  }
}

function saveGenOpts(opts: GenUiState) {
  try {
    localStorage.setItem(GEN_OPTS_LS, JSON.stringify(opts));
  } catch {
    /* private mode etc. */
  }
}

// Translate the UI state to the on-the-wire shape per the contract table.
// Returns a primary `options` plus an optional `followUpOptions` — the
// latter is only set when the user requested asymmetric alignment across
// ULT and UST (which the upstream can't express in a single call).
//
// Order for asymmetric: ULT first, then UST. Translators read ULT-first in
// the editor and the chapter is locked during the entire two-call sequence,
// so the visible order matches the reading order.
interface GenerateWireShape {
  options?: PipelineRequestOptions;
  followUpOptions?: PipelineRequestOptions;
}

function singleContentOptions(
  side: "ult" | "ust",
  aligned: boolean,
): PipelineRequestOptions {
  return aligned ? { contentTypes: [side] } : { contentTypes: [side], textOnly: true };
}

function buildGenerateWire(g: GenUiState): GenerateWireShape {
  if (g.ult && g.ust) {
    if (g.ultAlignment === g.ustAlignment) {
      // Symmetric — fits one call.
      return g.ultAlignment ? {} : { options: { textOnly: true } };
    }
    // Asymmetric — split into parent + follow-up. ULT first.
    return {
      options: singleContentOptions("ult", g.ultAlignment),
      followUpOptions: singleContentOptions("ust", g.ustAlignment),
    };
  }
  if (g.ult) return { options: singleContentOptions("ult", g.ultAlignment) };
  if (g.ust) return { options: singleContentOptions("ust", g.ustAlignment) };
  return {};
}

const TYPE_LABEL: Record<PipelineType, string> = {
  generate: "pipeline.generateUltUst",
  notes: "pipeline.translationNotes",
  tqs: "pipeline.translationQuestions",
  translate: "translation.translateChapter",
};

function relativeMinutes(seconds: number): string {
  const diff = Math.floor(Date.now() / 1000) - seconds;
  if (diff < 60) return `${diff}s`;
  if (diff < 3600) return `${Math.floor(diff / 60)} min`;
  return `${Math.floor(diff / 3600)}h ${Math.floor((diff % 3600) / 60)} min`;
}

export function PipelineMenu({ book, chapter, onMessage, onImported }: Props) {
  const { t } = useTranslation();
  const projectConfig = useProjectConfig();
  // Gateway-language projects also offer "Translate chapter" (drafts the whole
  // chapter's tN). The English root project (translationSource == null) sees
  // exactly the original three options.
  const visibleOptions = useMemo(
    () =>
      isTranslationProject(projectConfig)
        ? [...OPTIONS, TRANSLATE_OPTION, TRANSLATE_TQ_OPTION]
        : OPTIONS,
    [projectConfig],
  );
  const [anchorEl, setAnchorEl] = useState<HTMLElement | null>(null);
  const [confirm, setConfirm] = useState<PipelineOption | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [activeJobs, setActiveJobs] = useState<PipelineJob[]>([]);
  const [genOpts, setGenOpts] = useState<GenUiState>(() => loadGenOpts());
  const [conflict, setConflict] = useState<PipelineConflictExisting | null>(null);
  const [refInput, setRefInput] = useState("");
  const [importOpen, setImportOpen] = useState(false);
  const [aquiferBusy, setAquiferBusy] = useState(false);
  const canPullAquifer = isAdmin() && isTranslationProject(projectConfig);
  // Admin-only, translation projects only: wipe this book's notes/questions and
  // reload them from the configured English source repos.
  // "warn" = initial confirm (no local edits known yet); an ImportHasLocalEditsBody
  // = the sharper 409 confirm naming the tn/tq counts that would be discarded.
  const [resourceConfirm, setResourceConfirm] = useState<null | "warn" | ImportHasLocalEditsBody>(
    null,
  );
  const [resourceBusy, setResourceBusy] = useState(false);

  useEffect(() => pipelineStore.subscribe(setActiveJobs), []);

  // Re-load from localStorage whenever the dialog opens for a generate run, so
  // a change made in a different tab is reflected.
  useEffect(() => {
    if (confirm?.type === "generate") setGenOpts(loadGenOpts());
    if (confirm) setRefInput(String(chapter));
  }, [confirm, book, chapter]);

  const genNothingSelected = !genOpts.ult && !genOpts.ust;
  // `t` is a dep because parseChapterRange returns a translated error message;
  // without it the message stays in the previous language after a switch. Safe
  // here — pure derivation, no fetch.
  const refParsed = useMemo(() => parseChapterRange(refInput, book), [refInput, book, t]);

  // "In progress" for the chapter = queued/dispatching/running/paused. A
  // failed or cancelled job covering the chapter must NOT disable the menu —
  // the translator re-triggers from here. Only the current user's own runs
  // disable the menu; another user's run must fall through to Start so the
  // server's enriched 409 surfaces the "Already running" conflict dialog
  // (the shared-queue list now includes foreign jobs, so filter them out).
  const me = currentPipelineUserId();
  const runningType = (type: PipelineType): PipelineJob | undefined =>
    activeJobs.find(
      (j) =>
        j.pipeline_type === type &&
        j.book === book &&
        j.start_chapter <= chapter &&
        j.end_chapter >= chapter &&
        j.state !== "done" &&
        j.state !== "failed" &&
        j.state !== "cancelled" &&
        (me == null || j.user_id === me),
    );

  const close = () => setAnchorEl(null);

  const start = async () => {
    if (!confirm) return;
    if (!refParsed.ok) return;
    const isMacro = Boolean(confirm.followUpChain);
    if (confirm.type === "generate" && !isMacro && genNothingSelected) return;
    const { book: rangeBook, startChapter, endChapter } = refParsed.range;
    const chapters: number[] = [];
    for (let c = startChapter; c <= endChapter; c++) chapters.push(c);
    setSubmitting(true);
    try {
      let wire: GenerateWireShape = {};
      if (confirm.type === "generate" && !isMacro) {
        wire = buildGenerateWire(genOpts);
        saveGenOpts(genOpts);
      }
      let startedCount = 0;
      let lastRes: PipelineStartResponse | undefined;
      for (const ch of chapters) {
        const res = await pipelineStore.start({
          pipelineType: confirm.type,
          book: rangeBook,
          startChapter: ch,
          endChapter: ch,
          sessionKey: getSessionKey(),
          ...(wire.options ? { options: wire.options } : {}),
          ...(wire.followUpOptions ? { followUpOptions: wire.followUpOptions } : {}),
          ...(confirm.followUpChain ? { followUpChain: confirm.followUpChain } : {}),
          ...(confirm.translate ? { translate: confirm.translate } : {}),
        });
        lastRes = res;
        if (res.status !== "already_running") startedCount++;
      }
      const rangeLabel =
        chapters.length === 1
          ? `${rangeBook} ${startChapter}`
          : `${rangeBook} ${startChapter}-${endChapter}`;
      if (startedCount > 0) {
        // Single-chapter run that didn't win the bot slot — it's waiting in
        // line. Surface the position instead of "Started".
        if (chapters.length === 1 && lastRes?.status === "queued") {
          const posText = lastRes.queuePosition
            ? t("pipeline.posInLine", { position: lastRes.queuePosition })
            : t("pipeline.posWaiting");
          onMessage?.(t("pipeline.queuedToast", { label: t(confirm.label), range: rangeLabel, pos: posText }));
        } else {
          const suffix =
            chapters.length > 1
              ? t("pipeline.runsSuffix", { n: startedCount })
              : isMacro
                ? t("pipeline.runsSuffix", { n: 1 + (confirm.followUpChain?.length ?? 0) })
                : wire.followUpOptions
                  ? t("pipeline.runsSuffix", { n: 2 })
                  : "";
          onMessage?.(t("pipeline.startedToast", { label: t(confirm.label), range: rangeLabel, suffix }));
        }
      }
      // already_running: pipelineStore emits a focus event that opens the
      // status panel on the existing run — no toast needed.
      setConfirm(null);
    } catch (e) {
      if (e instanceof ApiError) {
        const body = e.body as PipelineConflictBody | { error?: string; jobId?: string } | undefined;
        if (e.status === 409 && body?.error === "conflict") {
          const enriched = (body as PipelineConflictBody).existing;
          if (enriched) {
            setConflict(enriched);
            setConfirm(null);
          } else {
            // Conflict with a job started outside the editor (e.g. Zulip).
            // We have no metadata to show — fall back to the bare toast.
            onMessage?.(t("pipeline.anotherTranslatorStarted", { jobId: body.jobId ?? t("pipeline.unknown") }));
            setConfirm(null);
          }
        } else if (e.status === 401) {
          onMessage?.(t("pipeline.signInToStart"));
        } else {
          onMessage?.(t("pipeline.couldNotStart", { error: body?.error ?? e.message }));
        }
      } else {
        onMessage?.(t("pipeline.couldNotStartGeneric"));
      }
    } finally {
      setSubmitting(false);
    }
  };

  // Aquifer is tN-only and matches by quote+reference, so it works even where
  // the imported rows' IDs don't line up with the current source (unlike the
  // AI translate pipeline). Admin-only; the book must already be imported.
  const runAquifer = async () => {
    close();
    if (aquiferBusy) return;
    setAquiferBusy(true);
    onMessage?.(t("pipeline.aquiferStarting", { book }));
    try {
      const res = await api.aquiferDrafts(book);
      onMessage?.(
        t("pipeline.aquiferDone", { book, approved: res.approved, inserted: res.inserted }),
      );
      onImported?.();
    } catch (e) {
      const code = e instanceof ApiError ? (e.body as { error?: string } | undefined)?.error : undefined;
      if (code === "aquifer_book_not_available") {
        onMessage?.(t("pipeline.aquiferNotAvailable", { book }));
      } else if (code === "book_not_imported") {
        onMessage?.(t("pipeline.aquiferNotImported", { book }));
      } else {
        onMessage?.(t("pipeline.aquiferFailed", { error: code ?? (e instanceof Error ? e.message : String(e)) }));
      }
    } finally {
      setAquiferBusy(false);
    }
  };

  // Two-step re-source: the first call omits confirmDiscardEdits so the server
  // can answer 409 has_local_edits with the counts; we then show a sharper
  // confirmation naming them and repeat the call with the flag set.
  const runResource = async (confirmDiscardEdits: boolean) => {
    if (resourceBusy) return;
    setResourceBusy(true);
    onMessage?.(t("pipeline.resourceStarting", { book }));
    try {
      const res = await api.importBook(book, {
        translateFromSource: true,
        force: true,
        ...(confirmDiscardEdits ? { confirmDiscardEdits: true } : {}),
      });
      const sources = importedSourceRepos(res.sources).join(", ");
      onMessage?.(
        sources
          ? t("pipeline.resourceDone", { book, sources })
          : t("pipeline.resourceDoneNoSources", { book }),
      );
      setResourceConfirm(null);
      onImported?.();
    } catch (e) {
      const body = e instanceof ApiError ? (e.body as { error?: string } | undefined) : undefined;
      if (e instanceof ApiError && e.status === 409 && body?.error === "has_local_edits") {
        setResourceConfirm(body as ImportHasLocalEditsBody);
      } else if (e instanceof ApiError && e.status === 403) {
        onMessage?.(t("pipeline.resourceAdminOnly"));
        setResourceConfirm(null);
      } else {
        onMessage?.(
          t("pipeline.resourceFailed", {
            error: body?.error ?? (e instanceof Error ? e.message : String(e)),
          }),
        );
        setResourceConfirm(null);
      }
    } finally {
      setResourceBusy(false);
    }
  };

  // Every action this menu exposes — AI runs (POST /pipelines/start), the
  // Door43 import (POST /books/:book/import) and the Aquifer pull/re-source —
  // is gated server-side to editors/admins (requireEditor / requireAdmin). A
  // viewer can only ever collect 403s here, so render nothing at all. This
  // fixes the classic-editor case where the AI trigger was shown to viewers
  // and 403'd on click (#481). AiScreen already returns early for viewers
  // before mounting this menu; keeping the guard on the component itself makes
  // it host-independent (Shell's top bar had no such gate).
  if (isReadOnly()) return null;

  return (
    <>
      <Button
        size="small"
        variant="outlined"
        startIcon={<AutoAwesomeIcon fontSize="small" />}
        onClick={(e) => setAnchorEl(e.currentTarget)}
      >
        {t("pipeline.aiButton")}
      </Button>
      <Menu anchorEl={anchorEl} open={Boolean(anchorEl)} onClose={close}>
        {visibleOptions.map((opt) => {
          const running = runningType(opt.type);
          return (
            <MenuItem
              key={opt.key}
              disabled={Boolean(running)}
              onClick={() => {
                close();
                setConfirm(opt);
              }}
            >
              <ListItemText
                primary={t(opt.label)}
                secondary={
                  running
                    ? t("pipeline.alreadyRunningState", { state: running.state })
                    : `${t(opt.description)} ${t(opt.approxDuration)}`
                }
              />
            </MenuItem>
          );
        })}
        <Divider />
        <MenuItem
          onClick={() => {
            close();
            setImportOpen(true);
          }}
        >
          <CloudDownloadIcon fontSize="small" sx={{ mr: 1, color: "text.secondary" }} />
          <ListItemText
            primary={t("pipeline.importFromDoor43")}
            secondary={t("pipeline.importFromDoor43Desc")}
          />
        </MenuItem>
        {canPullAquifer && (
          <MenuItem onClick={runAquifer} disabled={aquiferBusy}>
            {aquiferBusy ? (
              <CircularProgress size={16} sx={{ mr: 1 }} />
            ) : (
              <AutoStoriesIcon fontSize="small" sx={{ mr: 1, color: "text.secondary" }} />
            )}
            <ListItemText
              primary={t("pipeline.aquiferPull")}
              secondary={t("pipeline.aquiferPullDesc")}
            />
          </MenuItem>
        )}
        {canPullAquifer && (
          <MenuItem
            disabled={resourceBusy}
            onClick={() => {
              close();
              setResourceConfirm("warn");
            }}
          >
            {resourceBusy ? (
              <CircularProgress size={16} sx={{ mr: 1 }} />
            ) : (
              <TranslateIcon fontSize="small" sx={{ mr: 1, color: "text.secondary" }} />
            )}
            <ListItemText
              primary={t("pipeline.resourceFromSource")}
              secondary={t("pipeline.resourceFromSourceDesc")}
            />
          </MenuItem>
        )}
      </Menu>
      <ImportFromDoor43Dialog
        open={importOpen}
        onClose={() => setImportOpen(false)}
        book={book}
        currentChapter={chapter}
        onMessage={onMessage}
        onImported={onImported}
      />
      <Dialog open={Boolean(confirm)} onClose={() => !submitting && setConfirm(null)}>
        <DialogTitle>{t("pipeline.startAiPipeline")}</DialogTitle>
        <DialogContent>
          <DialogContentText>
            {confirm
              ? t("pipeline.confirmRun", { label: t(confirm.label), duration: t(confirm.approxDuration) })
              : ""}
          </DialogContentText>
          <Box sx={{ mt: 2, display: "flex", alignItems: "flex-start", gap: 1.5 }}>
            <Typography sx={{ pt: 1, fontWeight: 500 }}>{book}</Typography>
            <TextField
              label={t("pipeline.chapterOrRange")}
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
                    ? t("pipeline.runsOnce", { book: refParsed.range.book, chapter: refParsed.range.startChapter })
                    : t("pipeline.runsMultiple", {
                        n: refParsed.range.endChapter - refParsed.range.startChapter + 1,
                        book: refParsed.range.book,
                        start: refParsed.range.startChapter,
                        end: refParsed.range.endChapter,
                      })
                  : refParsed.error
              }
            />
          </Box>
          {confirm?.type === "generate" && !confirm.followUpChain ? (
            <Box sx={{ mt: 2 }}>
              <DialogContentText sx={{ mb: 1, fontSize: "0.875rem" }}>
                {t("pipeline.whatToGenerate")}
              </DialogContentText>
              <FormGroup>
                <FormControlLabel
                  control={
                    <Checkbox
                      checked={genOpts.ult}
                      onChange={(_, v) => setGenOpts((o) => ({ ...o, ult: v }))}
                      disabled={submitting}
                    />
                  }
                  label={t("pipeline.ultLiteralText")}
                />
                <FormControlLabel
                  control={
                    <Checkbox
                      checked={genOpts.ultAlignment}
                      onChange={(_, v) => setGenOpts((o) => ({ ...o, ultAlignment: v }))}
                      disabled={submitting || !genOpts.ult}
                    />
                  }
                  label={t("pipeline.ultAlignment")}
                  sx={{ ml: 3 }}
                />
                <FormControlLabel
                  control={
                    <Checkbox
                      checked={genOpts.ust}
                      onChange={(_, v) => setGenOpts((o) => ({ ...o, ust: v }))}
                      disabled={submitting}
                    />
                  }
                  label={t("pipeline.ustSimplifiedText")}
                />
                <FormControlLabel
                  control={
                    <Checkbox
                      checked={genOpts.ustAlignment}
                      onChange={(_, v) => setGenOpts((o) => ({ ...o, ustAlignment: v }))}
                      disabled={submitting || !genOpts.ust}
                    />
                  }
                  label={t("pipeline.ustAlignment")}
                  sx={{ ml: 3 }}
                />
              </FormGroup>
              {genOpts.ult && genOpts.ust && genOpts.ultAlignment !== genOpts.ustAlignment ? (
                <DialogContentText sx={{ mt: 1, fontSize: "0.75rem", fontStyle: "italic" }}>
                  {t("pipeline.asymmetricAlignment")}
                </DialogContentText>
              ) : null}
              {genNothingSelected ? (
                <DialogContentText sx={{ mt: 1, fontSize: "0.8125rem", color: "warning.main" }}>
                  {t("pipeline.selectAtLeastOne")}
                </DialogContentText>
              ) : null}
            </Box>
          ) : null}
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setConfirm(null)} disabled={submitting}>
            {t("pipeline.cancel")}
          </Button>
          <Button
            onClick={start}
            variant="contained"
            disabled={
              submitting ||
              !refParsed.ok ||
              (confirm?.type === "generate" &&
                !confirm.followUpChain &&
                genNothingSelected)
            }
            startIcon={submitting ? <CircularProgress size={14} /> : undefined}
          >
            {t("pipeline.start")}
          </Button>
        </DialogActions>
      </Dialog>
      <Dialog open={Boolean(conflict)} onClose={() => setConflict(null)}>
        <DialogTitle>{t("pipeline.alreadyRunning")}</DialogTitle>
        <DialogContent>
          {conflict && (
            <>
              <DialogContentText>
                {conflict.started_by_username
                  ? t("pipeline.userStarted", { user: conflict.started_by_username })
                  : t("pipeline.someoneStarted")}
                <strong>{t(TYPE_LABEL[conflict.pipeline_type])}</strong> for{" "}
                <strong>
                  {conflict.book} {conflict.start_chapter}
                  {conflict.end_chapter !== conflict.start_chapter
                    ? `–${conflict.end_chapter}`
                    : ""}
                </strong>{" "}
                {relativeMinutes(conflict.created_at)} ago.
              </DialogContentText>
              <DialogContentText sx={{ mt: 1, fontSize: "0.875rem" }}>
                {t("pipeline.stateColon")}<strong>{conflict.state}</strong>
                {conflict.current_skill ? ` · ${conflict.current_skill}` : ""}
                {` · updated ${relativeMinutes(conflict.updated_at)} ago`}
              </DialogContentText>
              <DialogContentText sx={{ mt: 1, fontSize: "0.8125rem", fontStyle: "italic" }}>
                {t("pipeline.chapterLockedNote")}
              </DialogContentText>
            </>
          )}
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setConflict(null)}>{t("pipeline.close")}</Button>
        </DialogActions>
      </Dialog>
      <Dialog
        open={resourceConfirm !== null}
        onClose={() => !resourceBusy && setResourceConfirm(null)}
      >
        <DialogTitle>
          {resourceConfirm === "warn"
            ? t("pipeline.resourceConfirmTitle")
            : t("pipeline.resourceEditsTitle")}
        </DialogTitle>
        <DialogContent>
          <DialogContentText>
            {resourceConfirm === "warn"
              ? t("pipeline.resourceConfirmBody", { book })
              : t("pipeline.resourceEditsBody", {
                  book,
                  tn: resourceConfirm?.tn ?? 0,
                  tq: resourceConfirm?.tq ?? 0,
                  twl: resourceConfirm?.twl ?? 0,
                  verses: resourceConfirm?.verses ?? 0,
                })}
          </DialogContentText>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setResourceConfirm(null)} disabled={resourceBusy}>
            {t("pipeline.cancel")}
          </Button>
          <Button
            onClick={() => void runResource(resourceConfirm !== "warn")}
            variant="contained"
            color={resourceConfirm === "warn" ? "warning" : "error"}
            disabled={resourceBusy}
            startIcon={resourceBusy ? <CircularProgress size={14} /> : undefined}
          >
            {resourceConfirm === "warn"
              ? t("pipeline.resourceContinue")
              : t("pipeline.resourceDiscardConfirm")}
          </Button>
        </DialogActions>
      </Dialog>
    </>
  );
}
