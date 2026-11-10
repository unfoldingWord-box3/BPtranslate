// In-app assistant chat (issue #858). Generic: it knows nothing about the
// screen it sits on. The host supplies the context to send (buildContext), a
// way to name and show a note by id (describeId) and the Apply handler. The
// server only proposes; nothing changes until the user ticks rows and presses
// Apply on a proposal card. The conversation lives in component state only.
//
// Layout: from the md breakpoint up the panel is an inline column the host
// places beside its content (so it never covers the host's own bars); below
// md it is a full-width temporary drawer.

import { useEffect, useRef, useState } from "react";
import { Alert, Box, Button, CircularProgress, Drawer, IconButton, Stack, TextField, Typography } from "@mui/material";
import CloseIcon from "@mui/icons-material/Close";
import { useTheme } from "@mui/material/styles";
import useMediaQuery from "@mui/material/useMediaQuery";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { useTranslation } from "react-i18next";
import { api, ApiError, type AssistantActions, type AssistantErrorBody, type AssistantNote, type AssistantStatus } from "../sync/api";
import { formatUsd } from "../help/money";
import ProposalCard, { type NoteInfo, type ProposalState } from "./ProposalCard";
import { actionCount, echoContent, normalizeActions, selectedActions } from "./proposal";
import { assistantVisible } from "./useAssistantStatus";

const MAX_MESSAGES = 10;
const MAX_CONTENT = 2000;

export interface AssistantContext {
  book: string;
  chapter: number;
  notes: AssistantNote[];
  /** Kept with each proposal and handed back to onApply (e.g. the versions sent). */
  snapshot?: unknown;
}

export interface AssistantApplyResult {
  text: string;
  severity: "success" | "info" | "warning";
  /** Nothing was tried (another action was running): keep the card open for another Apply. */
  retryable?: boolean;
}

interface Turn {
  role: "user" | "assistant";
  /** What the user sees (the reply text). */
  text: string;
  /** What goes back to the server as this turn. */
  echo: string;
  proposal?: ProposalState;
}

interface Props {
  open: boolean;
  onClose: () => void;
  lang: string;
  screen: "rapid_check";
  status: AssistantStatus | null;
  refreshStatus: () => void;
  /** A new value starts a new chat (e.g. another chapter). */
  resetKey: string;
  buildContext: () => AssistantContext;
  describeId: (id: string) => NoteInfo | null;
  onApply: (selection: AssistantActions, snapshot: unknown) => Promise<AssistantApplyResult>;
}

export default function AssistantPanel(props: Props) {
  const { open, onClose, lang, screen, status, refreshStatus, resetKey, buildContext, describeId, onApply } = props;
  const { t } = useTranslation();
  const theme = useTheme();
  const wide = useMediaQuery(theme.breakpoints.up("md"));
  const [chat, setChat] = useState<{ key: string; turns: Turn[] }>({ key: resetKey, turns: [] });
  const turns = chat.key === resetKey ? chat.turns : [];
  const [text, setText] = useState("");
  // A figure from a chat reply or error, good until the next status fetch.
  const [override, setOverride] = useState<{ for: AssistantStatus | null; usd: number } | null>(null);
  const remaining = override && override.for === status ? override.usd : (status?.remainingUsd ?? null);
  const setRemaining = (usd: number) => setOverride({ for: status, usd });
  const [busy, setBusy] = useState(false);
  const [applyingIdx, setApplyingIdx] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const inFlight = useRef(false);
  const abortRef = useRef<AbortController | null>(null);
  const endRef = useRef<HTMLDivElement>(null);
  const setTurns = (fn: (prev: Turn[]) => Turn[]) =>
    setChat((c) => ({ key: resetKey, turns: fn(c.key === resetKey ? c.turns : []) }));

  // Closing the panel or moving to another chapter cancels a pending question.
  useEffect(() => {
    if (!open) abortRef.current?.abort();
    return () => abortRef.current?.abort();
  }, [open, resetKey]);

  useEffect(() => {
    endRef.current?.scrollIntoView?.({ block: "end" });
  }, [turns.length, busy]);

  if (!open || !assistantVisible(status)) return null;

  const unavailable = !status.configured || !status.keyUsable;
  const done = turns.length >= MAX_MESSAGES;
  const trimmed = text.trim();
  const canSend = !!trimmed && !busy && !done && status.canAsk && (remaining === null || remaining > 0);

  const describeError = (e: unknown): string => {
    if (e instanceof ApiError) {
      const b = (e.body ?? {}) as AssistantErrorBody;
      if (e.status === 429 && b.code === "assistant_budget_exhausted") {
        if (typeof b.remainingUsd === "number") setRemaining(b.remainingUsd);
        const when = b.resetsAt ? new Date(b.resetsAt) : null;
        if (when && !Number.isNaN(when.getTime())) {
          const fmt = (loc?: string) => new Intl.DateTimeFormat(loc, { dateStyle: "medium", timeStyle: "short" }).format(when);
          let formatted: string;
          try {
            formatted = fmt(lang);
          } catch {
            formatted = fmt(undefined);
          }
          return t("assistant.budgetExhausted", { when: formatted });
        }
        return t("assistant.budgetExhaustedNoTime");
      }
      if (e.status === 403 && b.code === "assistant_disabled") return t("assistant.disabled");
      if (e.status === 409) return t("assistant.unavailable");
      if (e.status === 502 && b.code === "assistant_failed" && b.kind === "truncated") return t("assistant.truncated");
    }
    return t("assistant.failed");
  };

  const send = async () => {
    if (!canSend || inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    setError(null);
    const userTurn: Turn = { role: "user", text: trimmed, echo: trimmed };
    const sent = [...turns, userTurn];
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    try {
      const ctx = buildContext();
      const res = await api.assistantChat(
        {
          lang,
          screen,
          context: { book: ctx.book, chapter: ctx.chapter, notes: ctx.notes },
          messages: sent.map((m) => ({ role: m.role, content: m.echo })),
        },
        ctrl.signal,
      );
      const actions = normalizeActions(res.actions);
      const has = actionCount(actions) > 0;
      // Append to the turns as they are NOW: a tick or an Apply on an earlier
      // card while this message was in flight must survive the reply.
      setTurns((prev) => [
        ...prev,
        userTurn,
        {
          role: "assistant",
          text: res.reply,
          echo: echoContent(res.reply, actions),
          proposal: has ? { actions, snapshot: ctx.snapshot, unticked: [], applied: null } : undefined,
        },
      ]);
      setRemaining(res.remainingUsd);
      setText("");
    } catch (e) {
      // Cancelled (button, close, or another chapter): keep the question, show no error.
      if (!ctrl.signal.aborted) setError(describeError(e));
    } finally {
      if (abortRef.current === ctrl) abortRef.current = null;
      inFlight.current = false;
      setBusy(false);
      // A failed call may still have been charged; pick up the real amount.
      refreshStatus();
    }
  };

  const patchProposal = (i: number, fn: (p: ProposalState) => ProposalState) =>
    setTurns((prev) => prev.map((m, j) => (j === i && m.proposal ? { ...m, proposal: fn(m.proposal) } : m)));

  const toggle = (i: number, key: string) =>
    patchProposal(i, (p) => ({
      ...p,
      unticked: p.unticked.includes(key) ? p.unticked.filter((k) => k !== key) : [...p.unticked, key],
    }));

  const apply = async (i: number) => {
    const p = turns[i]?.proposal;
    if (!p || p.applied || applyingIdx !== null) return;
    setApplyingIdx(i);
    setError(null);
    try {
      const sel = selectedActions(p.actions, new Set(p.unticked));
      const r = await onApply(sel, p.snapshot);
      if (r.retryable) setError(r.text);
      else patchProposal(i, (q) => ({ ...q, applied: r }));
    } catch {
      patchProposal(i, (q) => ({ ...q, applied: { text: t("assistant.apply.failed"), severity: "warning" } }));
    } finally {
      setApplyingIdx(null);
    }
  };

  const reset = () => {
    abortRef.current?.abort();
    setTurns(() => []);
    setText("");
    setError(null);
  };

  const body = (
    <Box
      component="aside"
      aria-label={t("assistant.title")}
      data-assistant-panel=""
      sx={{
        display: "flex",
        flexDirection: "column",
        height: "100%",
        minHeight: 0,
        width: wide ? 400 : "100%",
        flexShrink: 0,
        bgcolor: "background.paper",
        borderInlineStart: wide ? "1px solid" : "none",
        borderColor: "divider",
      }}
    >
      <Stack direction="row" alignItems="center" sx={{ px: 2, py: 1, borderBlockEnd: "1px solid", borderColor: "divider" }}>
        <Typography variant="subtitle1" component="h3" sx={{ fontWeight: 700, flex: 1 }}>
          {t("assistant.title")}
        </Typography>
        <IconButton size="small" onClick={onClose} aria-label={t("assistant.close")}>
          <CloseIcon fontSize="small" />
        </IconButton>
      </Stack>

      <Box sx={{ flex: 1, minHeight: 0, overflowY: "auto", px: 2, py: 1 }}>
        {unavailable ? (
          <Typography variant="body2" color="text.secondary">
            {t(status.configured ? "assistant.unavailable" : "assistant.notConfigured")}
          </Typography>
        ) : (
          <>
            {turns.length === 0 && (
              <Typography variant="body2" color="text.secondary" sx={{ textAlign: "start" }}>
                {t("assistant.intro")}
              </Typography>
            )}
            {/* New replies are announced to screen readers as they arrive. */}
            <Box aria-live="polite" aria-relevant="additions">
              {turns.map((m, i) =>
                m.role === "user" ? (
                  <Typography key={i} variant="body2" dir="auto" sx={{ fontWeight: 600, mt: 1.5, textAlign: "start", whiteSpace: "pre-wrap" }}>
                    {m.text}
                  </Typography>
                ) : (
                  <Box
                    key={i}
                    dir="auto"
                    sx={{
                      mt: 1,
                      textAlign: "start",
                      fontSize: "0.875rem",
                      "& p": { marginBlock: "0.4em" },
                      "& ul, & ol": { paddingInlineStart: "1.4em", marginBlock: "0.4em" },
                    }}
                  >
                    <ReactMarkdown remarkPlugins={[remarkGfm]} components={{ a: ({ children }) => <>{children}</>, img: ({ alt }) => <>{alt}</> }}>
                      {m.text}
                    </ReactMarkdown>
                    {m.proposal && (
                      <ProposalCard
                        proposal={m.proposal}
                        describeId={describeId}
                        applying={applyingIdx === i}
                        disabled={applyingIdx !== null}
                        onToggle={(key) => toggle(i, key)}
                        onApply={() => void apply(i)}
                      />
                    )}
                  </Box>
                ),
              )}
            </Box>
            <Box aria-live="polite">
              {error && (
                <Alert severity="info" sx={{ mt: 1 }}>
                  {error}
                </Alert>
              )}
            </Box>
            <div ref={endRef} />
          </>
        )}
      </Box>

      {!unavailable && (
        <Box sx={{ px: 2, py: 1.5, borderBlockStart: "1px solid", borderColor: "divider" }}>
          {remaining !== null && (
            <Typography variant="caption" color="text.secondary" component="p" sx={{ mb: 1, mt: 0 }}>
              {t("assistant.remaining", { amount: formatUsd(remaining) })}
            </Typography>
          )}
          {done ? (
            <Typography variant="body2" color="text.secondary" sx={{ mb: 1 }}>
              {t("assistant.limitReached")}
            </Typography>
          ) : (
            <TextField
              size="small"
              fullWidth
              multiline
              minRows={2}
              maxRows={5}
              value={text}
              onChange={(e) => setText(e.target.value)}
              label={t(turns.length > 0 ? "assistant.followUpLabel" : "assistant.label")}
              placeholder={t("assistant.placeholder")}
              disabled={busy}
              slotProps={{ htmlInput: { maxLength: MAX_CONTENT, dir: "auto" }, inputLabel: { shrink: true } }}
              onKeyDown={(e) => {
                if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
                  e.preventDefault();
                  void send();
                }
              }}
            />
          )}
          <Stack direction="row" gap={1} sx={{ mt: 1 }} alignItems="center">
            {!done && (
              <Button
                size="small"
                variant="contained"
                onClick={() => void send()}
                disabled={!canSend}
                startIcon={busy ? <CircularProgress size={14} color="inherit" /> : undefined}
              >
                {busy ? t("assistant.sending") : t("assistant.send")}
              </Button>
            )}
            {busy && (
              <Button size="small" onClick={() => abortRef.current?.abort()}>
                {t("assistant.cancel")}
              </Button>
            )}
            {turns.length > 0 && (
              <Button size="small" onClick={reset} disabled={busy}>
                {t("assistant.newChat")}
              </Button>
            )}
          </Stack>
        </Box>
      )}
    </Box>
  );

  if (wide) return body;
  return (
    <Drawer anchor="right" open onClose={onClose} slotProps={{ paper: { sx: { width: "100%", maxWidth: "100%" } } }}>
      {body}
    </Drawer>
  );
}
