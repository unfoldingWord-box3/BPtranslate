// Per-chapter trigger UI for the AI translate pipeline (translation notes and
// questions, ~1h a chapter); we kick off and surface status via the bottom
// pill. The bot's three older actions (Generate ULT + UST, Write translation
// notes, Write translation questions) were removed in #470.

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
  Box,
  TextField,
  Typography,
  Alert,
} from "@mui/material";
import AutoAwesomeIcon from "@mui/icons-material/AutoAwesome";
import CloudDownloadIcon from "@mui/icons-material/CloudDownload";
import AutoStoriesIcon from "@mui/icons-material/AutoStories";
import TranslateIcon from "@mui/icons-material/Translate";
import { ApiError, api, importedSourceRepos, isAdmin, isReadOnly } from "../sync/api";
import { ImportFromDoor43Dialog } from "./ImportFromDoor43Dialog";
import type {
  ImportHasLocalEditsBody,
  PipelineConflictBody,
  PipelineConflictExisting,
  PipelineStartResponse,
  PipelineType,
  TranslateRequestOptions,
} from "../sync/api";
import { getSessionKey, pipelineStore, type PipelineJob } from "../sync/pipelineStore";
import { currentPipelineUserId } from "../sync/pipelineSession";
import { parseChapterRange } from "../lib/refParser";
import { unpublishedWarning, type UnpublishedCheck } from "../lib/unpublishedScriptureWarning";
import { isAiNeedsOrgKey, isAiProviderNotConfigured } from "../lib/aiProviderErrors";
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
   * Translate-pipeline overrides passed through to the start request. Used to
   * pick the resource (tn default | tq) for a chapter translate. The server
   * folds these into the config-derived options (buildTranslateOptions).
   */
  translate?: TranslateRequestOptions;
}

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
  // Only gateway-language projects get AI actions ("Translate chapter" for tN
  // and tQ). The English root project (translationSource == null) has none
  // since the bot's three older actions were removed (#470); its menu keeps
  // the import items below.
  const visibleOptions = useMemo(
    () => (isTranslationProject(projectConfig) ? [TRANSLATE_OPTION, TRANSLATE_TQ_OPTION] : []),
    [projectConfig],
  );
  const [anchorEl, setAnchorEl] = useState<HTMLElement | null>(null);
  const [confirm, setConfirm] = useState<PipelineOption | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [activeJobs, setActiveJobs] = useState<PipelineJob[]>([]);
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
  // #679 option C: AI translate runs read the workspace's Bible from Door43
  // master, so warn in the run dialog when this book has ULT/UST edits that
  // have not reached it. Checked each time the dialog opens (confirmOpenId);
  // only a result for this opening and book shows (unpublishedWarning), so a
  // reopen or a failed check never shows an earlier answer. The run itself is
  // never blocked.
  const [confirmOpenId, setConfirmOpenId] = useState(0);
  const [unpublishedCheck, setUnpublishedCheck] = useState<UnpublishedCheck | null>(null);
  useEffect(() => {
    if (confirm?.type !== "translate") return;
    const ctrl = new AbortController();
    api
      .unpublishedScripture(book, ctrl.signal)
      .then((r) => setUnpublishedCheck({ openId: confirmOpenId, book, ult: r.ult, ust: r.ust }))
      .catch(() => {});
    return () => ctrl.abort();
  }, [confirm, confirmOpenId, book]);
  const unpublished = confirm?.type === "translate" ? unpublishedWarning(unpublishedCheck, confirmOpenId, book) : null;

  useEffect(() => pipelineStore.subscribe(setActiveJobs), []);

  // `t` is a dep because parseChapterRange returns a translated error message;
  // without it the message stays in the previous language after a switch. Safe
  // here — pure derivation, no fetch.
  // eslint-disable-next-line react-hooks/exhaustive-deps -- `t` is a deliberate recompute signal (see above); the linter cannot see that parseChapterRange reads the active language.
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
    const { book: rangeBook, startChapter, endChapter } = refParsed.range;
    const chapters: number[] = [];
    for (let c = startChapter; c <= endChapter; c++) chapters.push(c);
    setSubmitting(true);
    try {
      let startedCount = 0;
      let lastRes: PipelineStartResponse | undefined;
      for (const ch of chapters) {
        const res = await pipelineStore.start({
          pipelineType: confirm.type,
          book: rangeBook,
          startChapter: ch,
          endChapter: ch,
          sessionKey: getSessionKey(),
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
          const suffix = chapters.length > 1 ? t("pipeline.runsSuffix", { n: startedCount }) : "";
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
        } else if (isAiProviderNotConfigured(e)) {
          onMessage?.(t("pipeline.aiKeyNotConfigured"));
          setConfirm(null);
        } else if (isAiNeedsOrgKey(e)) {
          onMessage?.(t("ai.needsOrgKey"));
          setConfirm(null);
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
                // Each run's range field starts at the current chapter.
                setRefInput(String(chapter));
                setConfirmOpenId((n) => n + 1);
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
        {visibleOptions.length > 0 && <Divider />}
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
          {unpublished && (
            <Alert severity="warning" sx={{ mt: 2 }}>
              {t(
                unpublished === "unpublishable"
                  ? "pipeline.unpublishedScriptureNotPublished"
                  : "pipeline.unpublishedScriptureWarning",
              )}
            </Alert>
          )}
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
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setConfirm(null)} disabled={submitting}>
            {t("pipeline.cancel")}
          </Button>
          <Button
            onClick={start}
            variant="contained"
            disabled={submitting || !refParsed.ok}
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
