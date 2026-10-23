// a2-import's two queue panels: the shared pending-imports review queue and the
// recent import/pipeline activity list. Both read real endpoints:
//   GET /api/pending-imports?book=&chapter=   (api.getPendingImports)
//   GET /api/pipelines                        (api.pipelineList)
//
// Honest scope note carried over from the mockup: /api/pending-imports is
// scoped to ONE book + chapter. There is no whole-project aggregate endpoint,
// so this panel asks for a chapter rather than pretending to show everything.

import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Alert, Box, Button, CircularProgress, Stack, TextField, Typography } from "@mui/material";
import {
  api,
  ApiError,
  type PendingImport,
  type PipelineJobRow,
} from "../../sync/api";
import { FlowStatusChip, type FlowStatusKind } from "./FlowStatusChip";
import { errorCopy } from "../../lib/aiErrorCopy";
import { Panel, PanelBody, PanelFoot, PanelTop, ListRow } from "./BooksPanel";

function errorText(e: unknown): string {
  if (e instanceof ApiError) {
    const body = e.body as { error?: string; message?: string } | undefined;
    return body?.message ?? body?.error ?? `HTTP ${e.status}`;
  }
  return e instanceof Error ? e.message : String(e);
}

export function BooksPendingPanel({ book }: { book: string }) {
  const { t } = useTranslation();
  const [chapter, setChapter] = useState(1);
  const [items, setItems] = useState<PendingImport[] | null>(null);
  const [status, setStatus] = useState<"loading" | "loaded" | "error">("loading");
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async (signal?: AbortSignal) => {
    setStatus("loading");
    setError(null);
    try {
      const res = await api.getPendingImports(book, chapter, signal);
      if (signal?.aborted) return;
      setItems(res.items);
      setStatus("loaded");
    } catch (e) {
      if (signal?.aborted || (e instanceof DOMException && e.name === "AbortError")) return;
      setItems(null);
      setError(errorText(e));
      setStatus("error");
    }
  }, [book, chapter]);

  useEffect(() => {
    const controller = new AbortController();
    const timer = setTimeout(() => {
      void load(controller.signal);
    }, 400);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [load]);

  return (
    <Panel>
      <PanelTop title={t("flowBooks.pending.title")} sub={t("flowBooks.pending.sub")} />
      <PanelBody>
        <Stack direction="row" alignItems="flex-end" spacing={1.5} sx={{ mb: 1.5, flexWrap: "wrap", rowGap: 1 }}>
          <Typography variant="body2" color="text.secondary">
            {t("flowBooks.pending.bookLabel", { book })}
          </Typography>
          <TextField
            size="small"
            type="number"
            label={t("flowBooks.pending.chapter")}
            value={chapter}
            onChange={(e) => {
              const n = Number(e.target.value);
              if (Number.isFinite(n) && n >= 0) setChapter(n);
            }}
            sx={{ width: 110 }}
            inputProps={{ min: 0 }}
          />
        </Stack>

        {status === "loading" ? (
          <Stack direction="row" spacing={1} alignItems="center">
            <CircularProgress size={16} />
            <Typography variant="body2">{t("common.loading")}</Typography>
          </Stack>
        ) : status === "error" ? (
          <Alert severity="error">{t("flowBooks.pending.loadFailed", { error })}</Alert>
        ) : !items || items.length === 0 ? (
          <Typography variant="body2" color="text.secondary">
            {t("flowBooks.pending.empty")}
          </Typography>
        ) : (
          items.map((p) => (
            <ListRow key={p.id}>
              <Box sx={{ flex: 1, minWidth: 0 }}>
                <Stack direction="row" alignItems="center" spacing={1} sx={{ flexWrap: "wrap" }}>
                  <Typography component="strong" sx={{ fontWeight: 700, fontSize: "0.875rem" }}>
                    {p.book} {p.chapter}
                  </Typography>
                  <FlowStatusChip kind="draft" label={p.kind} />
                </Stack>
                <Typography variant="caption" color="text.secondary">
                  {t("flowBooks.pending.itemMeta", {
                    verse: p.verse,
                    user: p.startedByUsername ?? t("flowBooks.pending.unknownUser"),
                    pipeline: p.pipelineType,
                  })}
                </Typography>
              </Box>
            </ListRow>
          ))
        )}
      </PanelBody>
      <PanelFoot
        state={
          status === "loaded"
            ? t("flowBooks.pending.footState", { count: items?.length ?? 0, book, chapter })
            : status === "error"
              ? t("flowBooks.loadFailed")
              : t("common.loading")
        }
      >
        <Button size="small" sx={{ minHeight: 36 }} onClick={() => void load()}>
          {t("flowBooks.refresh")}
        </Button>
      </PanelFoot>
    </Panel>
  );
}

const JOB_CHIP: Record<string, FlowStatusKind> = {
  running: "edited",
  dispatching: "edited",
  done: "approved",
  failed: "warn",
};

export function BooksActivityPanel({ book }: { book: string }) {
  const { t } = useTranslation();
  const [jobs, setJobs] = useState<PipelineJobRow[] | null>(null);
  const [status, setStatus] = useState<"loading" | "loaded" | "error" | "forbidden">("loading");
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setStatus("loading");
    setError(null);
    try {
      const res = await api.pipelineList();
      setJobs(res.jobs);
      setStatus("loaded");
    } catch (e) {
      setJobs(null);
      if (e instanceof ApiError && e.status === 403) {
        setStatus("forbidden");
        return;
      }
      setError(errorText(e));
      setStatus("error");
    }
  }, []);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- mount-time load; the same `load` backs the Retry buttons, and it sets status to loading at start so the spinner shows instead of the old job list.
    void load();
  }, [load]);

  const forBook = (jobs ?? []).filter((j) => j.book === book);
  const others = (jobs?.length ?? 0) - forBook.length;

  return (
    <Panel>
      <PanelTop title={t("flowBooks.activity.title")} sub={t("flowBooks.activity.sub", { book })} />
      <PanelBody>
        {status === "loading" ? (
          <Stack direction="row" spacing={1} alignItems="center">
            <CircularProgress size={16} />
            <Typography variant="body2">{t("common.loading")}</Typography>
          </Stack>
        ) : status === "forbidden" ? (
          <Typography variant="body2" color="text.secondary">
            {t("flowBooks.activity.forbidden")}
          </Typography>
        ) : status === "error" ? (
          <Alert severity="error">{t("flowBooks.activity.loadFailed", { error })}</Alert>
        ) : forBook.length === 0 ? (
          <Typography variant="body2" color="text.secondary">
            {others > 0
              ? t("flowBooks.activity.emptyOthers", { book, count: others })
              : t("flowBooks.activity.emptyQueue", { book })}
          </Typography>
        ) : (
          forBook.map((j) => (
            <ListRow key={j.job_id}>
              <Box sx={{ flex: 1, minWidth: 0 }}>
                <Stack direction="row" alignItems="center" spacing={1} sx={{ flexWrap: "wrap" }}>
                  <Typography component="strong" sx={{ fontWeight: 700, fontSize: "0.875rem" }}>
                    {j.book} {j.start_chapter === j.end_chapter ? j.start_chapter : `${j.start_chapter}–${j.end_chapter}`}
                  </Typography>
                  <FlowStatusChip kind={JOB_CHIP[j.state] ?? "draft"} label={j.state} />
                </Stack>
                <Typography variant="caption" color="text.secondary" sx={{ display: "block" }}>
                  {j.pipeline_type}
                  {j.started_by_username ? ` — ${j.started_by_username}` : ""}
                  {j.current_status ? ` — ${j.current_status}` : ""}
                </Typography>
                {j.state === "failed" && (j.error_message || j.error_kind) && (
                  <Typography variant="caption" color="text.secondary" sx={{ display: "block" }}>
                    {j.error_kind ? errorCopy(j.error_kind, t) : t("flowBooks.activity.errorKindFallback")}{" — "}
                    {j.error_message ?? t("flowBooks.activity.noMessage")}
                  </Typography>
                )}
              </Box>
            </ListRow>
          ))
        )}
      </PanelBody>
      <PanelFoot
        state={
          status === "loaded"
            ? others > 0
              ? t("flowBooks.activity.footJobsElsewhere", { count: forBook.length, book, others })
              : t("flowBooks.activity.footJobs", { count: forBook.length, book })
            : status === "forbidden"
              ? t("flowBooks.activity.notAvailableRole")
              : status === "error"
                ? t("flowBooks.loadFailed")
                : t("common.loading")
        }
      >
        <Button size="small" sx={{ minHeight: 36 }} onClick={() => void load()}>
          {t("flowBooks.refreshStatus")}
        </Button>
      </PanelFoot>
    </Panel>
  );
}
