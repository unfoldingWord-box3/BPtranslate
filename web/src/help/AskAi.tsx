// "Ask AI" area at the bottom of the Help panel. Search-first: matching guide
// articles show while the user types, and nothing reaches /api/help/ask until
// the Ask AI button is pressed. The conversation lives in component state only.

import { useEffect, useMemo, useRef, useState } from "react";
import { Alert, Box, Button, Chip, CircularProgress, Divider, List, ListItemButton, ListItemText, Stack, TextField, Typography } from "@mui/material";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import { useTranslation } from "react-i18next";
import { api, ApiError, type HelpAskErrorBody, type HelpStatus } from "../sync/api";
import type { HelpArticle } from "./guideMap";
import { searchHelp } from "./search";

const MAX_MESSAGES = 10;
const MAX_CONTENT = 2000;

type Msg = { role: "user" | "assistant"; content: string };

/** Dollar amounts shown in the help UI: always two decimals. */
export function formatUsd(n: number): string {
  return n.toFixed(2);
}

interface Props {
  open: boolean;
  articles: HelpArticle[];
  lang: string;
  routeKey: string | null;
  onOpenArticle: (id: string) => void;
  components: Components;
  bodySx: object;
}

export default function AskAi({ open, articles, lang, routeKey, onOpenArticle, components, bodySx }: Props) {
  const { t } = useTranslation();
  const [status, setStatus] = useState<HelpStatus | null>(null);
  const [question, setQuestion] = useState("");
  const [history, setHistory] = useState<Msg[]>([]);
  const [cited, setCited] = useState<string[]>([]);
  const [remaining, setRemaining] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inFlight = useRef(false);

  // Refetch each time the drawer opens so an admin's switch / key change shows
  // up without a reload; a failed fetch is retried on the next open.
  useEffect(() => {
    if (!open) return;
    let alive = true;
    api
      .getHelpStatus()
      .then((s) => {
        if (alive) {
          setStatus(s);
          setRemaining(s.remainingUsd);
        }
      })
      .catch(() => {
        /* keep the last known status; search keeps working */
      });
    return () => {
      alive = false;
    };
  }, [open]);

  const trimmed = question.trim();
  const hits = useMemo(() => (trimmed ? searchHelp(articles, trimmed).slice(0, 3) : []), [articles, trimmed]);

  if (!status || !status.enabled) return null;

  if (!status.configured) {
    return (
      <Box sx={{ px: 2, py: 1.5, borderBlockStart: "1px solid", borderColor: "divider" }}>
        <Typography variant="body2" color="text.secondary">
          {t("help.ask.notConfigured")}
        </Typography>
      </Box>
    );
  }

  const done = history.length >= MAX_MESSAGES;
  const followUp = history.length > 0;

  const describe = (e: unknown): string => {
    if (e instanceof ApiError) {
      const b = (e.body ?? {}) as HelpAskErrorBody;
      if (e.status === 429 && b.code === "help_budget_exhausted") {
        if (typeof b.remainingUsd === "number") setRemaining(b.remainingUsd);
        const when = b.resetsAt ? new Date(b.resetsAt) : null;
        if (when && !Number.isNaN(when.getTime())) {
          return t("help.ask.budgetExhausted", {
            when: new Intl.DateTimeFormat(lang, { dateStyle: "medium", timeStyle: "short" }).format(when),
          });
        }
        return t("help.ask.budgetExhaustedNoTime");
      }
      if (e.status === 403 && b.code === "help_ai_disabled") return t("help.ask.disabled");
      if (e.status === 409) return t("help.ask.unavailable");
    }
    return t("help.ask.failed");
  };

  const ask = async () => {
    if (!trimmed || busy || done || inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    setError(null);
    const messages: Msg[] = [...history, { role: "user", content: trimmed }];
    try {
      const res = await api.askHelp({ lang, route: routeKey ?? "", messages });
      setHistory([...messages, { role: "assistant", content: res.answer }]);
      setCited(res.articleIds);
      setRemaining(res.remainingUsd);
      setQuestion("");
    } catch (e) {
      setError(describe(e));
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  };

  const reset = () => {
    setHistory([]);
    setCited([]);
    setQuestion("");
    setError(null);
  };

  const lastAnswerIdx = history.length - 1;

  return (
    <Box
      sx={{
        borderBlockStart: "1px solid",
        borderColor: "divider",
        px: 2,
        py: 1.5,
        maxHeight: "55%",
        overflowY: "auto",
        flexShrink: 0,
      }}
      aria-label={t("help.ask.title")}
      component="section"
    >
      <Typography variant="subtitle2" component="h3" sx={{ mb: 1 }}>
        {t("help.ask.title")}
      </Typography>

      {remaining !== null && (
        <Typography variant="caption" color="text.secondary" component="p" sx={{ mb: 1 }}>
          {t("help.ask.remaining", { amount: formatUsd(remaining) })}
        </Typography>
      )}

      {history.map((m, i) =>
        m.role === "user" ? (
          <Typography key={i} variant="body2" sx={{ fontWeight: 600, mt: 1 }}>
            {m.content}
          </Typography>
        ) : (
          <Box key={i} sx={{ ...bodySx, "& p:first-of-type": { marginBlockStart: "0.2em" } }}>
            <ReactMarkdown remarkPlugins={[remarkGfm]} components={components}>
              {m.content}
            </ReactMarkdown>
            {i === lastAnswerIdx && (
              <>
                {cited.length > 0 && (
                  <Box sx={{ mt: 1 }}>
                    <Typography variant="caption" color="text.secondary">
                      {t("help.ask.sources")}
                    </Typography>
                    <Stack direction="row" gap={0.5} flexWrap="wrap" sx={{ mt: 0.5 }}>
                      {cited.map((id) => {
                        const a = articles.find((x) => x.id === id);
                        return a ? <Chip key={id} size="small" label={a.title} onClick={() => onOpenArticle(id)} /> : null;
                      })}
                    </Stack>
                  </Box>
                )}
              </>
            )}
            <Divider sx={{ my: 1 }} />
          </Box>
        ),
      )}

      {error && (
        <Alert severity="info" sx={{ mb: 1 }}>
          {error}
        </Alert>
      )}

      {done ? (
        <Typography variant="body2" color="text.secondary" sx={{ mb: 1 }}>
          {t("help.ask.limitReached")}
        </Typography>
      ) : (
        <>
          <TextField
            size="small"
            fullWidth
            multiline
            minRows={2}
            maxRows={5}
            value={question}
            onChange={(e) => setQuestion(e.target.value)}
            label={t(followUp ? "help.ask.followUpLabel" : "help.ask.label")}
            placeholder={t("help.ask.placeholder")}
            disabled={busy}
            slotProps={{ htmlInput: { maxLength: MAX_CONTENT }, inputLabel: { shrink: true } }}
          />
          {hits.length > 0 && !busy && (
            <Box sx={{ mt: 1 }}>
              <Typography variant="caption" color="text.secondary">
                {t("help.ask.didOneAnswer")}
              </Typography>
              <List dense disablePadding>
                {hits.map((h) => (
                  <ListItemButton key={h.article.id} onClick={() => onOpenArticle(h.article.id)} sx={{ px: 0, py: 0 }}>
                    <ListItemText primary={h.article.title} slotProps={{ primary: { sx: { fontSize: 13 } } }} />
                  </ListItemButton>
                ))}
              </List>
            </Box>
          )}
        </>
      )}

      <Stack direction="row" gap={1} sx={{ mt: 1 }} alignItems="center">
        {!done && (
          <Button
            size="small"
            variant="contained"
            onClick={() => void ask()}
            disabled={!trimmed || busy}
            startIcon={busy ? <CircularProgress size={14} color="inherit" /> : undefined}
          >
            {busy ? t("help.ask.asking") : t("help.ask.button")}
          </Button>
        )}
        {history.length > 0 && (
          <Button size="small" onClick={reset} disabled={busy}>
            {t("help.ask.newQuestion")}
          </Button>
        )}
      </Stack>
    </Box>
  );
}
