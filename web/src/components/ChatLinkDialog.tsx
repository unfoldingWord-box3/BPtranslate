// Dialog for linking the BT Servant chat (WhatsApp/Telegram) to the signed-in
// editor's account (#669). The editor generates a one-time code, types it to
// the bot in a one-to-one chat, and from then on the bot can save edits as
// them. The same dialog lists the existing links so one can be revoked.
import { useCallback, useEffect, useState } from "react";
import {
  Box,
  Button,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  Divider,
  Stack,
  Typography,
} from "@mui/material";
import { useTranslation } from "react-i18next";
import { api, type ChatLink } from "../sync/api";

type Props = { open: boolean; onClose: () => void };

function formatDate(unixSeconds: number): string {
  return new Date(unixSeconds * 1000).toLocaleDateString();
}

function formatCountdown(seconds: number): string {
  const s = Math.max(0, seconds);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

export function ChatLinkDialog({ open, onClose }: Props) {
  const { t } = useTranslation();
  const [code, setCode] = useState<{ code: string; expiresAt: number } | null>(null);
  const [now, setNow] = useState(() => Math.floor(Date.now() / 1000));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);
  const [links, setLinks] = useState<ChatLink[]>([]);

  const refresh = useCallback(async () => {
    try {
      const res = await api.chatLinksList();
      setLinks(res.links);
    } catch {
      setError(true);
    }
  }, []);

  // Load the list each time the dialog opens, and drop a stale code.
  useEffect(() => {
    if (!open) return;
    setCode(null);
    setError(false);
    void refresh();
  }, [open, refresh]);

  // Tick once a second while a code is showing, for the countdown.
  const remaining = code ? code.expiresAt - now : 0;
  useEffect(() => {
    if (!open || !code || code.expiresAt <= Math.floor(Date.now() / 1000)) return;
    const id = setInterval(() => setNow(Math.floor(Date.now() / 1000)), 1000);
    return () => clearInterval(id);
  }, [open, code]);

  const generate = async () => {
    setBusy(true);
    setError(false);
    try {
      const res = await api.chatLinkCode();
      setNow(Math.floor(Date.now() / 1000));
      setCode({ code: res.code, expiresAt: res.expiresAt });
    } catch {
      setError(true);
    } finally {
      setBusy(false);
    }
  };

  const revoke = async (id: number) => {
    setError(false);
    try {
      await api.chatLinkRevoke(id);
    } catch {
      setError(true);
    }
    await refresh();
  };

  const lastUsed = (l: ChatLink) =>
    l.lastUsedAt == null
      ? t("chatLink.neverUsed")
      : t("chatLink.lastUsed", { when: formatDate(l.lastUsedAt) });

  return (
    <Dialog open={open} onClose={onClose} fullWidth maxWidth="sm">
      <DialogTitle>{t("chatLink.title")}</DialogTitle>
      <DialogContent>
        <Typography variant="body2" sx={{ mb: 2 }}>
          {t("chatLink.intro")}
        </Typography>
        <Button variant="contained" onClick={generate} disabled={busy}>
          {t(busy ? "chatLink.generating" : "chatLink.generate")}
        </Button>
        {code && (
          <Box sx={{ mt: 2 }}>
            <Typography
              sx={{ fontFamily: "monospace", fontSize: 32, fontWeight: 700, letterSpacing: 2 }}
            >
              {code.code}
            </Typography>
            <Typography variant="body2" color={remaining > 0 ? "text.secondary" : "error"} role="status">
              {remaining > 0
                ? t("chatLink.expiresIn", { time: formatCountdown(remaining) })
                : t("chatLink.expired")}
            </Typography>
          </Box>
        )}
        {error && (
          <Typography variant="body2" color="error" role="alert" sx={{ mt: 1 }}>
            {t("chatLink.error")}
          </Typography>
        )}
        <Divider sx={{ my: 2 }} />
        <Typography variant="subtitle2" sx={{ mb: 1 }}>
          {t("chatLink.linkedChats")}
        </Typography>
        {links.length === 0 ? (
          <Typography variant="body2" color="text.secondary">
            {t("chatLink.none")}
          </Typography>
        ) : (
          <Stack spacing={1}>
            {links.map((l) => (
              <Stack key={l.id} direction="row" alignItems="center" spacing={1}>
                <Box sx={{ flex: 1 }}>
                  <Typography variant="body2">
                    {t("chatLink.linked", { date: formatDate(l.createdAt) })}
                  </Typography>
                  <Typography variant="caption" color="text.secondary">
                    {lastUsed(l)} · {t("chatLink.linkExpires", { date: formatDate(l.expiresAt) })}
                  </Typography>
                </Box>
                <Button size="small" color="error" onClick={() => revoke(l.id)}>
                  {t("chatLink.revoke")}
                </Button>
              </Stack>
            ))}
          </Stack>
        )}
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose}>{t("chatLink.close")}</Button>
      </DialogActions>
    </Dialog>
  );
}
