// Inline "saved/saving/issues" pill (lives in the top bar) plus a floating
// bottom-right action panel that only appears when there are conflicts or
// failed ops that need user input. Without this, a 409 from the server
// marked the op "conflict" in IndexedDB and the queue silently stalled —
// there was no call site for outbox.resolveConflict anywhere in the app.
// A proper diff/merge UI is docs/plan.md territory and out of scope here.

import { useEffect, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import { Box, Button, Chip, Dialog, DialogActions, DialogContent, DialogContentText, DialogTitle, Divider, IconButton, ListItemText, Menu, MenuItem, Stack, Tooltip, Typography } from "@mui/material";
import CloudDoneIcon from "@mui/icons-material/CloudDone";
import CloudQueueIcon from "@mui/icons-material/CloudQueue";
import ErrorOutlineIcon from "@mui/icons-material/ErrorOutline";
import RefreshIcon from "@mui/icons-material/Refresh";
import DeleteOutlineIcon from "@mui/icons-material/DeleteOutline";
import WarningAmberIcon from "@mui/icons-material/WarningAmber";
import EditNoteIcon from "@mui/icons-material/EditNote";
import { onOutboxResult, outbox, isOpPending, type OutboxOp, type OpTarget } from "../sync/outbox";
import { drafts, type DraftRecord, type DraftMeta } from "../sync/drafts";

// If we believe we're online but haven't seen a successful save in this
// long while pending ops exist, treat it as effectively offline —
// navigator.onLine returns true on any LAN even with no real internet.
// Picked 30s because outbox backoff caps there: by then at least one full
// retry has been attempted and failed.
const STALE_PROGRESS_MS = 30_000;

interface FreshRow {
  version: number;
}

function isFreshRow(x: unknown): x is FreshRow {
  return typeof x === "object" && x !== null && typeof (x as { version?: unknown }).version === "number";
}

// Short label for the failed-ops drawer. Doesn't need to be unique — the
// op.id key handles React reconciliation — just needs to be readable enough
// that the translator can recognize which row didn't save.
function formatTarget(target: OpTarget, t: TFunction): string {
  if (target.kind === "row") return `${target.rowKind.toUpperCase()} ${target.book} · ${target.id}`;
  if (target.kind === "verse_status") {
    return t("appShell.sync.targetVerseStatus", {
      ref: `${target.book} ${target.chapter}:${target.verse}`,
    });
  }
  if (target.kind === "lane_check") {
    return t("appShell.sync.targetLaneCheck", {
      lane: target.lane,
      ref: `${target.book} ${target.chapter}:${target.verse}`,
    });
  }
  return `${target.bibleVersion} ${target.book} ${target.chapter}:${target.verse}`;
}

// Label for the confirm-before-discard dialogs and their clipboard copy — one
// definition so what the user reads on screen always matches what they paste.
// A delete op carries no content (patch is {}), so say what the intent was.
function formatOpLabel(op: OutboxOp, t: TFunction): string {
  return `${formatTarget(op.target, t)}${
    op.action === "delete" ? t("appShell.sync.deleteSuffix") : ""
  }`;
}

// Clipboard write for a discard dialog's "copy" button. This is the user's
// last copy of the edit — the caller must never flip to "copied" unless the
// write actually landed. Clipboard API needs a focused document; fall back to
// the textarea trick when it rejects. Returns whether a copy landed.
async function copyToClipboard(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    try {
      const ta = document.createElement("textarea");
      ta.value = text;
      ta.style.position = "fixed";
      ta.style.opacity = "0";
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand("copy");
      ta.remove();
      return ok;
    } catch {
      /* both copy paths failed — keep the label "copy edits" rather than
         claim a copy that never landed */
      return false;
    }
  }
}

// One-line preview of what a draft actually holds, so the "N unsaved" jump
// menu shows WHAT is unsaved, not only where. Payload shapes vary by editor —
// verse lanes stash {plainText}, rows {patch:{note|question|...}}, articles and
// templates {target_md} — so scan the likely fields and take the first real
// text. Null (no preview) just omits the secondary line.
function draftPreviewLine(d: DraftRecord): string | null {
  const p = d.payload as Record<string, unknown>;
  const patch =
    typeof p.patch === "object" && p.patch !== null ? (p.patch as Record<string, unknown>) : {};
  // The prose fields first: a row patch can also carry quote (raw Hebrew/Greek
  // — noise in a one-line preview, same reasoning as the notes screen's own
  // list preview) or a support_reference URI ahead of the text the translator
  // actually typed. The generic patch spread stays as the last resort.
  const candidates = [
    patch.note,
    patch.question,
    patch.response,
    p.plainText,
    p.target_md,
    ...Object.values(patch),
  ];
  for (const c of candidates) {
    if (typeof c !== "string") continue;
    const line = c.split("\n").find((l) => l.trim())?.trim();
    if (!line) continue;
    // Code-point slice, not string slice — a cut mid-surrogate-pair would
    // render a lone � before the ellipsis.
    const points = [...line];
    return points.length > 60 ? `${points.slice(0, 60).join("")}…` : line;
  }
  return null;
}

function formatDraftMeta(m: DraftMeta): string {
  if (m.kind === "verse") return `${m.bibleVersion} ${m.book} ${m.chapter}:${m.verse}`;
  if (m.kind === "article") {
    // tA parts split into title / sub-title / body; name the part so two drafts
    // on the same article are tellable apart.
    return `${m.resource.toUpperCase()} ${m.articleId}${m.part === "body" ? "" : ` · ${m.part}`}`;
  }
  // Note templates have no reference either; the support_ref is what a
  // translator recognises them by, so lead with it and keep the id for
  // disambiguation (several templates can share a support_ref).
  if (m.kind === "template") return `${m.supportRef} · ${m.templateId}`;
  return `${m.rowKind.toUpperCase()} ${m.book} ${m.chapter}:${m.verse}`;
}

export interface SyncSummary {
  pending: number;
  conflicts: OutboxOp[];
  failed: OutboxOp[];
  effectivelyOffline: boolean;
  online: boolean;
  draftCount: number;
  activeDrafts: DraftRecord[];
  quarantinedDrafts: DraftRecord[];
}

// Shared save-state computation. Extracted so the merged TopBar "Status"
// indicator can pick a label/color for its outer chip using the exact same
// priority logic (conflicts > failed > offline > saving > saved) that
// SyncStatusBar itself uses for its embedded detail view — one source of
// truth for "what does the save state actually say right now".
export function useSyncSummary(): SyncSummary {
  const [ops, setOps] = useState<OutboxOp[]>([]);
  useEffect(() => outbox.subscribe(setOps), []);

  // Draft count — unsaved typing the user hasn't clicked Save on yet.
  // Distinct from outbox "saving N": those are in-flight to the server;
  // drafts haven't left the browser.
  const [draftList, setDraftList] = useState<DraftRecord[]>([]);
  useEffect(() => drafts.subscribe(setDraftList), []);
  const activeDrafts = draftList.filter((d) => !d.quarantined);
  const quarantinedDrafts = draftList.filter((d) => !!d.quarantined);
  const draftCount = activeDrafts.length;

  // Track navigator.onLine + last successful drain so we can distinguish
  // "actively saving" from "queueing because we have no internet". A separate
  // "stale-progress" check guards against navigator.onLine lying (it goes
  // true on any LAN regardless of actual reachability).
  const [online, setOnline] = useState<boolean>(
    typeof navigator === "undefined" ? true : navigator.onLine,
  );
  const [lastSuccessAt, setLastSuccessAt] = useState<number>(() => Date.now());
  useEffect(() => {
    const onOnline = () => setOnline(true);
    const onOffline = () => setOnline(false);
    window.addEventListener("online", onOnline);
    window.addEventListener("offline", onOffline);
    return () => {
      window.removeEventListener("online", onOnline);
      window.removeEventListener("offline", onOffline);
    };
  }, []);
  useEffect(() =>
    onOutboxResult((_op, result) => {
      if (result.kind === "ok") setLastSuccessAt(Date.now());
    }),
  []);

  const pending = ops.filter(isOpPending).length;
  const conflicts = ops.filter((o) => o.status === "conflict");
  const failed = ops.filter((o) => o.status === "failed");

  // Tick once a second when pending > 0 so the "stale progress" heuristic
  // can flip the pill to offline-style without waiting for the next outbox
  // event. Cheap: 1Hz timer only when there's actually work outstanding.
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (pending === 0) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [pending]);
  const effectivelyOffline = !online || (pending > 0 && now - lastSuccessAt > STALE_PROGRESS_MS);

  return { pending, conflicts, failed, effectivelyOffline, online, draftCount, activeDrafts, quarantinedDrafts };
}

interface Props {
  // Optional so the bar still renders standalone (e.g. in a stripped TopBar).
  // When present, the "N unsaved" chip becomes a menu that jumps to each draft.
  onNavigate?: (book: string, chapter: number, verse?: number) => void;
  // The merged TopBar "Status" indicator mounts two instances of this
  // component: one always-live (hideInlineChip) so the conflict/failed
  // floating panel and discard dialog keep working regardless of whether the
  // Status popover is open, and one embedded inside that popover
  // (hideFloating) as the interactive "Save state" row. Neither prop defaults
  // to true — a standalone `<SyncStatusBar />` (used nowhere else today, kept
  // for tests/back-compat) still renders everything, as before.
  hideInlineChip?: boolean;
  hideFloating?: boolean;
  // Set only at the new-UI (flow-screen) mount. When true, verse/row drafts in
  // the jump menu navigate to the new-UI flow hashes (#/scripture/…, #/notes/…)
  // instead of calling onNavigate — whose un-prefixed #/{book}/{chapter} hash
  // resolves to the classic Shell catch-all and ejects the user out of the new
  // UI (#229). Classic mounts leave this unset and keep the onNavigate path.
  flowRouting?: boolean;
}

export function SyncStatusBar({ onNavigate, hideInlineChip, hideFloating, flowRouting }: Props = {}) {
  const { t } = useTranslation();
  const { pending, conflicts, failed, effectivelyOffline, online, draftCount, activeDrafts, quarantinedDrafts } =
    useSyncSummary();

  // "Discard all" permanently deletes queued edits — gate it behind an
  // explicit confirm so it can't be a one-misclick data loss.
  const [confirmDiscardAll, setConfirmDiscardAll] = useState(false);

  // Single-op "discard this edit" confirm — same one-misclick protection as
  // "discard all". Snapshot of the op at click time; the dialog auto-closes
  // if the op leaves the failed list (retry / auto-revival).
  const [confirmDropOp, setConfirmDropOp] = useState<OutboxOp | null>(null);
  const [copiedDropOp, setCopiedDropOp] = useState(false);
  const closeDropOp = () => {
    setConfirmDropOp(null);
    setCopiedDropOp(false);
  };
  const liveDropOp =
    confirmDropOp && failed.some((f) => f.id === confirmDropOp.id) ? confirmDropOp : null;
  useEffect(() => {
    if (confirmDropOp && !liveDropOp) setConfirmDropOp(null);
  }, [confirmDropOp, liveDropOp]);

  // Conflicts whose 409 body carried no current row/version: resolve can't
  // re-arm them, and dropping deletes the edit — same one-misclick data-loss
  // stakes as "discard all", so they get the same confirm gate. Snapshot of
  // the ops at resolve-click time.
  const [unresolvableOps, setUnresolvableOps] = useState<OutboxOp[]>([]);
  const [copiedUnresolvable, setCopiedUnresolvable] = useState(false);
  const closeUnresolvable = () => {
    setUnresolvableOps([]);
    setCopiedUnresolvable(false);
  };

  // Live view of that snapshot: an op that has since left conflict status in
  // this tab (a same-target resolve re-armed it, or it was dropped elsewhere)
  // falls out of the dialog's count/list/copy/discard, so the user only ever
  // confirms what will actually be deleted. Cross-tab changes never reach
  // this tab's subscription — outbox.drop's onlyIfStatus guard is the
  // backstop there.
  const conflictIds = new Set(conflicts.map((c) => c.id));
  const liveUnresolvable = unresolvableOps.filter((op) => conflictIds.has(op.id));
  const oneUnresolvable = liveUnresolvable.length === 1;

  // Anchor for the "N unsaved" jump menu (only used when onNavigate is wired).
  const [draftMenuEl, setDraftMenuEl] = useState<null | HTMLElement>(null);

  const resolveAllConflicts = async () => {
    // The 409 response includes the server's current row in op.conflictCurrent —
    // re-queue against its version so the next dispatch sails through. The
    // user's local patch overwrites the upstream change (last-edit-wins).
    // If the server didn't return a current row we can't re-arm, and dropping
    // deletes the user's edit — never do that silently; route it through the
    // confirm dialog below (with copy-to-clipboard) instead. Partition and
    // surface the dialog BEFORE any awaits: if a resolveConflict below throws,
    // the unresolvable ops must still get their dialog rather than vanish
    // until the next click.
    const unresolvable: OutboxOp[] = [];
    const fresh: Array<{ id: string; version: number }> = [];
    for (const op of conflicts) {
      if (isFreshRow(op.conflictCurrent)) {
        fresh.push({ id: op.id, version: op.conflictCurrent.version });
      } else {
        unresolvable.push(op);
      }
    }
    // Set unconditionally — an empty result must also clear any stale
    // snapshot left from an earlier click.
    setUnresolvableOps(unresolvable);
    setCopiedUnresolvable(false);
    for (const f of fresh) {
      await outbox.resolveConflict(f.id, f.version);
    }
  };

  const copyUnresolvable = async () => {
    const text = liveUnresolvable
      .map((op) => `${formatOpLabel(op, t)}\n${JSON.stringify(op.patch, null, 2)}`)
      .join("\n\n");
    if (await copyToClipboard(text)) setCopiedUnresolvable(true);
  };

  const discardUnresolvable = async () => {
    // onlyIfStatus: another tab may have re-armed one of these ops to pending
    // (about to save) since the dialog opened — a plain drop would delete
    // that live edit. Only ops still in conflict are dropped; anything else
    // stays queued and remains visible via the normal chips.
    for (const op of liveUnresolvable) {
      await outbox.drop(op.id, { onlyIfStatus: "conflict" });
    }
    closeUnresolvable();
  };

  // Priority: conflicts > failed > offline > saving > saved.
  // Conflicts and failed always win because they need user action regardless
  // of connection state. Offline outranks "saving N" because they describe
  // the same fact (ops queued, no progress) — offline is the honest framing.
  let inline: ReactNode;
  if (conflicts.length > 0) {
    inline = (
      <Tooltip title={t("sync.conflictsTooltip")}>
        <Chip
          icon={<WarningAmberIcon />}
          label={`${conflicts.length} ${t("sync.conflict", { count: conflicts.length })}`}
          size="small"
          variant="outlined"
          color="warning"
        />
      </Tooltip>
    );
  } else if (failed.length > 0) {
    inline = (
      <Tooltip title={t("sync.failedTooltip")}>
        <Chip
          icon={<ErrorOutlineIcon />}
          label={`${failed.length} ${t("sync.failed")}`}
          size="small"
          variant="outlined"
          color="error"
        />
      </Tooltip>
    );
  } else if (effectivelyOffline) {
    const offlineLabel = pending > 0
      ? t("sync.queuedStatus", { pending, status: online ? t("sync.reconnecting") : t("sync.offline") })
      : online ? t("sync.reconnecting") : t("sync.offline");
    const offlineTooltip = pending > 0
      ? `${t("sync.queuedLocally", { count: pending })} ${online ? t("sync.tryingToReach") : t("sync.willSaveWhenOnline")}`
      : online ? t("sync.tryingToReachLower") : t("sync.youAreOffline");
    // Kindle warning accent (#E59D33 from CLAUDE.md brand palette) — offline
    // is a transient state, not a failure, so the MUI default error red is
    // wrong tone.
    inline = (
      <Tooltip title={offlineTooltip}>
        <Chip
          icon={<CloudQueueIcon />}
          label={offlineLabel}
          size="small"
          variant="outlined"
          sx={{
            color: "#E59D33",
            borderColor: "#E59D33",
            "& .MuiChip-icon": { color: "#E59D33" },
          }}
        />
      </Tooltip>
    );
  } else if (pending > 0) {
    inline = (
      <Tooltip title={t("sync.savingTooltip", { count: pending })}>
        <Chip
          icon={<CloudQueueIcon />}
          label={`${t("sync.saving")} ${pending}`}
          size="small"
          variant="outlined"
          color="primary"
        />
      </Tooltip>
    );
  } else if (draftCount === 0) {
    inline = (
      <Tooltip title={t("sync.savedTooltip")}>
        <Chip
          icon={<CloudDoneIcon />}
          label={t("sync.saved")}
          size="small"
          variant="outlined"
          color="success"
          sx={{ opacity: 0.6, "&:hover": { opacity: 1 } }}
        />
      </Tooltip>
    );
  } else {
    // Drafts exist but no server-side activity — the unsaved chip alone tells
    // the truth; showing "saved" next to "N unsaved" is contradictory.
    inline = null;
  }

  const showFloating = conflicts.length > 0 || failed.length > 0 || quarantinedDrafts.length > 0;

  // The drafts chip rides alongside the outbox chip. It surfaces unsaved
  // typing — distinct from "saving N" which is server in-flight. When
  // onNavigate is wired it's clickable: opens a menu that jumps to each draft;
  // otherwise it falls back to a passive tooltip listing them.
  const draftDirtyColorSx = {
    color: "#E59D33",
    borderColor: "#E59D33",
    "& .MuiChip-icon": { color: "#E59D33" },
  } as const;

  const navigateToDraft = (m: DraftMeta) => {
    // Article drafts have no scripture reference to navigate to — route to the
    // article route instead so "jump to unsaved" still lands the user on the
    // editor holding the draft.
    if (m.kind === "article") {
      location.hash = `#/articles/${m.resource}/${encodeURIComponent(m.articleId)}`;
    } else if (m.kind === "template") {
      // Same reasoning as articles: no scripture reference to navigate to, so
      // route to the template's own hash instead of calling onNavigate with
      // book/chapter/verse this variant does not carry.
      location.hash = `#/templates/${encodeURIComponent(m.templateId)}`;
    } else if (m.kind === "verse") {
      // #/scripture/B/C opens TranslateScriptureScreen. The 3-segment form this
      // used to request (#229) opened the flows ScriptureScreen, which could
      // seek to the exact verse; that screen was deleted with the rest of the
      // old flows screens (#173) and parseHash now redirects the arity here, so
      // ask for the live route directly. The jump lands on the draft's chapter
      // rather than its verse until the redesigned screen grows verse seeking
      // (#389 — same shape as the tq/twl row-landing gap in #335).
      if (flowRouting) location.hash = `#/scripture/${m.book}/${m.chapter}`;
      else onNavigate?.(m.book, m.chapter, m.verse);
    } else {
      // Row draft — branch by rowKind so tq/twl don't land on Translate Notes.
      if (flowRouting) {
        if (m.rowKind === "tn") {
          // Carry the exact row id so the notes screen lands on the note that
          // holds the draft, not just the verse's first card — several notes
          // can share a verse, and the point of this jump is telling them apart.
          location.hash = `#/notes/${m.book}/${m.chapter}/${m.verse}?row=${encodeURIComponent(m.id)}`;
        } else if (m.rowKind === "tq") {
          // Carry verse + exact row id (like tn) so the questions screen lands
          // on the question holding the draft, not just the chapter — several
          // questions can share a verse, and telling them apart is the point of
          // this jump. parseHash accepts the verse and ?row= tail (#335).
          location.hash = `#/questions/${m.book}/${m.chapter}/${m.verse}?row=${encodeURIComponent(m.id)}`;
        } else {
          // twl row-level parity is deferred (#335): the #/words/{book} route
          // opens the flows TranslateWordsScreen, which edits tW/tA *article*
          // content and has no twl-row queue to seek or badge. twl row drafts
          // are authored by the classic WordsTable (a structurally different
          // 3-column editor), so mirroring the tn/tq pattern here
          // would be a broad cross-surface change. Left book-scoped until that
          // screen grows row-level seeking.
          location.hash = `#/words/${m.book}`;
        }
      } else {
        onNavigate?.(m.book, m.chapter, m.verse);
      }
    }
    setDraftMenuEl(null);
  };

  let draftsChip: ReactNode = null;
  if (draftCount > 0 && onNavigate) {
    draftsChip = (
      <Tooltip title={t("sync.jumpToUnsaved")}>
        <Chip
          icon={<EditNoteIcon />}
          label={`${draftCount} ${t("sync.unsaved")}`}
          size="small"
          variant="outlined"
          clickable
          onClick={(e) => setDraftMenuEl(e.currentTarget)}
          sx={draftDirtyColorSx}
        />
      </Tooltip>
    );
  } else if (draftCount > 0) {
    const draftsTooltip = (
      <Stack spacing={0.25}>
        <Typography variant="caption" sx={{ fontWeight: 600 }}>
          {t("sync.unsavedEditsColon", { count: draftCount })}
        </Typography>
        {activeDrafts.map((d) => (
          <Typography
            key={d.key}
            variant="caption"
            sx={{ fontFamily: "monospace", display: "block" }}
          >
            {formatDraftMeta(d.meta)}
          </Typography>
        ))}
      </Stack>
    );
    draftsChip = (
      <Tooltip title={draftsTooltip}>
        <Chip
          icon={<EditNoteIcon />}
          label={`${draftCount} ${t("sync.unsaved")}`}
          size="small"
          variant="outlined"
          sx={draftDirtyColorSx}
        />
      </Tooltip>
    );
  }

  return (
    <>
      {!hideInlineChip && (
        <Stack direction="row" spacing={0.5} alignItems="center">
          {draftsChip}
          {inline}
        </Stack>
      )}
      {!hideInlineChip && onNavigate && (
        <Menu
          anchorEl={draftMenuEl}
          open={Boolean(draftMenuEl) && draftCount > 0}
          onClose={() => setDraftMenuEl(null)}
          anchorOrigin={{ vertical: "bottom", horizontal: "right" }}
          transformOrigin={{ vertical: "top", horizontal: "right" }}
        >
          <Typography
            variant="caption"
            color="text.secondary"
            sx={{ px: 2, py: 0.5, display: "block" }}
          >
            {t("sync.unsavedEditsClickToJump", { count: draftCount })}
          </Typography>
          {activeDrafts.map((d) => (
            <MenuItem key={d.key} onClick={() => navigateToDraft(d.meta)} dense>
              <ListItemText
                primary={formatDraftMeta(d.meta)}
                secondary={draftPreviewLine(d)}
                primaryTypographyProps={{ sx: { fontFamily: "monospace", fontSize: 13 } }}
                secondaryTypographyProps={{
                  // The drafted text itself, so the menu answers "which edit is
                  // this?" without a jump. dir=auto: drafts can be RTL text.
                  dir: "auto",
                  sx: { fontSize: 12, maxWidth: 280, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" },
                }}
                sx={{ mr: 1 }}
              />
              <Tooltip title={t("sync.discardThisEdit")}>
                <IconButton
                  size="small"
                  color="error"
                  edge="end"
                  onClick={(e) => {
                    // Stop the MenuItem's navigate onClick from also firing.
                    e.stopPropagation();
                    void drafts.clear(d.key);
                  }}
                  sx={{ p: 0.25 }}
                >
                  <DeleteOutlineIcon fontSize="inherit" />
                </IconButton>
              </Tooltip>
            </MenuItem>
          ))}
        </Menu>
      )}
      {!hideFloating && showFloating && (
        <Box
          sx={{
            position: "fixed",
            right: 12,
            bottom: 12,
            bgcolor: "background.paper",
            border: "1px solid",
            borderColor: "divider",
            borderRadius: 1,
            boxShadow: 2,
            px: 1.25,
            py: 0.75,
            maxWidth: 360,
            zIndex: (t) => t.zIndex.snackbar,
          }}
        >
          <Stack spacing={0.75}>
            {conflicts.length > 0 && (
              <Tooltip title={t("sync.resolveConflictTooltip")}>
                <Button
                  size="small"
                  variant="contained"
                  color="warning"
                  startIcon={<WarningAmberIcon />}
                  onClick={resolveAllConflicts}
                >
                  {t("sync.resolveConflicts", { count: conflicts.length })}
                </Button>
              </Tooltip>
            )}
            {failed.length > 0 && conflicts.length > 0 && <Divider flexItem />}
            {failed.length > 0 && (
              <Stack spacing={0.25}>
                <Stack direction="row" alignItems="center" justifyContent="space-between">
                  <Typography variant="caption" color="error" sx={{ fontWeight: 600 }}>
                    {failed.length} {t("sync.failed")}
                  </Typography>
                  <Tooltip title={t("sync.discardAllTooltip")}>
                    <Button
                      size="small"
                      variant="text"
                      color="error"
                      onClick={() => setConfirmDiscardAll(true)}
                      sx={{ minWidth: 0, py: 0, fontSize: 11 }}
                    >
                      {t("sync.discardAll")}
                    </Button>
                  </Tooltip>
                </Stack>
                {failed.map((op) => (
                  <Stack
                    key={op.id}
                    direction="row"
                    alignItems="center"
                    spacing={0.5}
                    sx={{
                      bgcolor: "action.hover",
                      borderRadius: 0.5,
                      px: 0.75,
                      py: 0.25,
                    }}
                  >
                    <Box sx={{ flex: 1, minWidth: 0 }}>
                      <Typography
                        variant="caption"
                        sx={{
                          display: "block",
                          whiteSpace: "nowrap",
                          overflow: "hidden",
                          textOverflow: "ellipsis",
                          fontFamily: "monospace",
                        }}
                      >
                        {formatTarget(op.target, t)}
                      </Typography>
                      {op.lastError && (
                        <Typography
                          variant="caption"
                          color="text.secondary"
                          sx={{
                            display: "block",
                            fontSize: 10,
                            whiteSpace: "nowrap",
                            overflow: "hidden",
                            textOverflow: "ellipsis",
                          }}
                        >
                          {op.lastError}
                        </Typography>
                      )}
                    </Box>
                    <Tooltip title={t("sync.retryThisEdit")}>
                      <IconButton
                        size="small"
                        color="primary"
                        onClick={() => void outbox.retry(op.id)}
                        sx={{ p: 0.25 }}
                      >
                        <RefreshIcon fontSize="inherit" />
                      </IconButton>
                    </Tooltip>
                    <Tooltip title={t("sync.discardThisEdit")}>
                      <IconButton
                        size="small"
                        color="error"
                        onClick={() => {
                          setConfirmDropOp(op);
                          setCopiedDropOp(false);
                        }}
                        sx={{ p: 0.25 }}
                      >
                        <DeleteOutlineIcon fontSize="inherit" />
                      </IconButton>
                    </Tooltip>
                  </Stack>
                ))}
              </Stack>
            )}
            {quarantinedDrafts.length > 0 && (failed.length > 0 || conflicts.length > 0) && (
              <Divider flexItem />
            )}
            {quarantinedDrafts.length > 0 && (
              <Stack spacing={0.25}>
                <Stack direction="row" alignItems="center" justifyContent="space-between">
                  <Typography variant="caption" color="warning.main" sx={{ fontWeight: 600 }}>
                    {t("sync.quarantinedDrafts", { count: quarantinedDrafts.length })}
                  </Typography>
                  <Stack direction="row" spacing={0.5}>
                    <Tooltip title={t("sync.exportQuarantinedDrafts")}>
                      <Button
                        size="small"
                        variant="text"
                        onClick={() => {
                          const blob = new Blob(
                            [JSON.stringify(quarantinedDrafts, null, 2)],
                            { type: "application/json" },
                          );
                          const url = URL.createObjectURL(blob);
                          const a = document.createElement("a");
                          a.href = url;
                          a.download = `quarantined-drafts-${Date.now()}.json`;
                          a.click();
                          URL.revokeObjectURL(url);
                        }}
                        sx={{ minWidth: 0, py: 0, fontSize: 11 }}
                      >
                        {t("sync.export")}
                      </Button>
                    </Tooltip>
                    <Tooltip title={t("sync.discardQuarantinedDrafts")}>
                      <Button
                        size="small"
                        variant="text"
                        color="error"
                        onClick={async () => {
                          for (const d of quarantinedDrafts) await drafts.clear(d.key);
                        }}
                        sx={{ minWidth: 0, py: 0, fontSize: 11 }}
                      >
                        {t("sync.discardAll")}
                      </Button>
                    </Tooltip>
                  </Stack>
                </Stack>
                {quarantinedDrafts.map((d) => (
                  <Stack
                    key={d.key}
                    direction="row"
                    alignItems="center"
                    spacing={0.5}
                    sx={{
                      bgcolor: "action.hover",
                      borderRadius: 0.5,
                      px: 0.75,
                      py: 0.25,
                    }}
                  >
                    <Box sx={{ flex: 1, minWidth: 0 }}>
                      <Typography
                        variant="caption"
                        sx={{
                          display: "block",
                          whiteSpace: "nowrap",
                          overflow: "hidden",
                          textOverflow: "ellipsis",
                          fontFamily: "monospace",
                        }}
                      >
                        {formatDraftMeta(d.meta)}
                      </Typography>
                      {d.quarantined && (
                        <Typography
                          variant="caption"
                          color="text.secondary"
                          sx={{
                            display: "block",
                            fontSize: 10,
                            whiteSpace: "nowrap",
                            overflow: "hidden",
                            textOverflow: "ellipsis",
                          }}
                        >
                          {d.quarantined}
                        </Typography>
                      )}
                    </Box>
                    <Tooltip title={t("sync.discardThisEdit")}>
                      <IconButton
                        size="small"
                        color="error"
                        onClick={() => void drafts.clear(d.key)}
                        sx={{ p: 0.25 }}
                      >
                        <DeleteOutlineIcon fontSize="inherit" />
                      </IconButton>
                    </Tooltip>
                  </Stack>
                ))}
              </Stack>
            )}
          </Stack>
        </Box>
      )}
      <Dialog
        // Auto-closes if the failed list empties out from under it (retry /
        // auto-revival) — nothing left to discard.
        open={!hideFloating && confirmDiscardAll && failed.length > 0}
        onClose={() => setConfirmDiscardAll(false)}
        // The floating action panel sits at zIndex.snackbar and stays mounted
        // while this dialog is open (its ops are still failed) — lift the
        // dialog above it so the panel can't cover the buttons.
        sx={{ zIndex: (theme) => theme.zIndex.snackbar + 1 }}
      >
        <DialogTitle>
          {t("sync.discardConfirmTitle", { count: failed.length })}
        </DialogTitle>
        <DialogContent>
          <DialogContentText>
            {t("sync.discardConfirmBody")}
          </DialogContentText>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setConfirmDiscardAll(false)}>{t("sync.cancel")}</Button>
          <Button
            color="error"
            variant="contained"
            onClick={async () => {
              // onlyIfStatus: a cross-tab retry may have moved an op from
              // "failed" to "pending" (about to save) since this dialog
              // opened — a plain drop would delete that live edit.
              for (const op of failed) await outbox.drop(op.id, { onlyIfStatus: "failed" });
              setConfirmDiscardAll(false);
            }}
          >
            {t("sync.discardAll")}
          </Button>
        </DialogActions>
      </Dialog>
      <Dialog
        open={!hideFloating && liveDropOp !== null}
        onClose={closeDropOp}
        sx={{ zIndex: (theme) => theme.zIndex.snackbar + 1 }}
      >
        {liveDropOp && (
          <>
            <DialogTitle>
              {t("sync.discardOneConfirmTitle", "Discard this edit?")}
            </DialogTitle>
            <DialogContent>
              <DialogContentText>
                {t(
                  "sync.discardOneConfirmBody",
                  "This edit never reached the server. Discarding deletes it from this device permanently — copy it first if you want to keep the text.",
                )}
              </DialogContentText>
              <Typography
                variant="caption"
                sx={{ fontFamily: "monospace", display: "block", mt: 1 }}
              >
                {formatOpLabel(liveDropOp, t)}
              </Typography>
            </DialogContent>
            <DialogActions>
              <Button
                onClick={async () => {
                  const text = `${formatOpLabel(liveDropOp, t)}\n${JSON.stringify(liveDropOp.patch, null, 2)}`;
                  if (await copyToClipboard(text)) setCopiedDropOp(true);
                }}
              >
                {copiedDropOp ? t("sync.copied", "copied") : t("sync.copyEdit", "copy edit")}
              </Button>
              <Button onClick={closeDropOp}>{t("sync.cancel")}</Button>
              <Button
                color="error"
                variant="contained"
                onClick={async () => {
                  // onlyIfStatus: a cross-tab retry may have re-armed this op
                  // to pending since the dialog opened — never delete an edit
                  // that's about to save.
                  await outbox.drop(liveDropOp.id, { onlyIfStatus: "failed" });
                  closeDropOp();
                }}
              >
                {t("sync.discard", "discard")}
              </Button>
            </DialogActions>
          </>
        )}
      </Dialog>
      <Dialog
        // liveUnresolvable already filters the snapshot against current
        // conflicts, so this auto-closes when every op has left conflict
        // status in this tab — mirrors the discard-all dialog above.
        open={!hideFloating && liveUnresolvable.length > 0}
        onClose={closeUnresolvable}
        // The floating action panel sits at zIndex.snackbar and stays mounted
        // while this dialog is open (its ops are still conflicts) — lift the
        // dialog above it so the panel can't cover the buttons.
        sx={{ zIndex: (theme) => theme.zIndex.snackbar + 1 }}
      >
        <DialogTitle>
          {t("sync.unresolvableConfirmTitle", {
            count: liveUnresolvable.length,
            defaultValue: "Discard {{count}} unresolvable conflict?",
            defaultValue_other: "Discard {{count}} unresolvable conflicts?",
          })}
        </DialogTitle>
        <DialogContent>
          <DialogContentText>
            {t("sync.unresolvableConfirmBody", {
              count: liveUnresolvable.length,
              defaultValue:
                "The server did not send back its current version for this edit, so it cannot be retried automatically. Discarding deletes it from this device permanently — copy it first if you want to keep the text.",
              defaultValue_other:
                "The server did not send back its current version for these edits, so they cannot be retried automatically. Discarding deletes them from this device permanently — copy them first if you want to keep the text.",
            })}
          </DialogContentText>
          <Stack spacing={0.25} sx={{ mt: 1 }}>
            {liveUnresolvable.map((op) => (
              <Typography
                key={op.id}
                variant="caption"
                sx={{ fontFamily: "monospace", display: "block" }}
              >
                {formatOpLabel(op, t)}
              </Typography>
            ))}
          </Stack>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => void copyUnresolvable()}>
            {copiedUnresolvable
              ? t("sync.copied", "copied")
              : oneUnresolvable
                ? t("sync.copyEdit", "copy edit")
                : t("sync.copyEdits", "copy edits")}
          </Button>
          <Button onClick={closeUnresolvable}>{t("sync.cancel")}</Button>
          <Button color="error" variant="contained" onClick={() => void discardUnresolvable()}>
            {t("sync.discard", "discard")}
          </Button>
        </DialogActions>
      </Dialog>
    </>
  );
}
