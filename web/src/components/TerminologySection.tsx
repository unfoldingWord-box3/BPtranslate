import { useEffect, useMemo, useState } from "react";
import {
  Alert,
  Box,
  Button,
  Chip,
  CircularProgress,
  IconButton,
  MenuItem,
  Snackbar,
  Stack,
  TextField,
  Tooltip,
  Typography,
} from "@mui/material";
import { alpha } from "@mui/material/styles";
import DeleteOutlineIcon from "@mui/icons-material/DeleteOutline";
import AddIcon from "@mui/icons-material/Add";
import DownloadIcon from "@mui/icons-material/Download";
import UploadIcon from "@mui/icons-material/Upload";
import { useTranslation } from "react-i18next";
import {
  api,
  ApiError,
  TERM_STATUSES,
  type Term,
  type TermImportResult,
  type TermInput,
  type TermStatus,
} from "../sync/api";
import { useTerms } from "../hooks/useTranslationMemory";
import { useSaveState } from "./useSaveState";

// Term-status → semantic palette (design §10). Not the violet AI identity —
// status is not an AI-draft state.
export function termStatusColor(status: TermStatus): string {
  switch (status) {
    case "preferred":
      return "success.main";
    case "admitted":
      return "info.main";
    case "forbidden":
      return "error.main";
    case "do_not_translate":
      return "text.primary";
    default:
      return "text.secondary"; // deprecated
  }
}

// ── Terminology ──────────────────────────────────────────────────────────────
function StatusChip({ status }: { status: TermStatus }) {
  const { t } = useTranslation();
  const color = termStatusColor(status);
  return (
    <Chip
      label={t(`preferences.status.${status}`)}
      size="small"
      variant="outlined"
      sx={{ height: 18, fontSize: 10, fontWeight: 600, color, borderColor: color }}
    />
  );
}

// A concept + the source string it renders. One concept legitimately carries
// several renderings (contract §3.3: "sense-dependent renderings are
// legitimate; do not treat the table as one-term-one-string"), and the same
// concept can also carry a Hebrew/Greek/English source variant — so the group
// key is the (concept_id, source_term) pair, not concept_id alone.
type TermGroup = { key: string; conceptId: string; sourceTerm: string; terms: Term[] };

// GET /terms caps its result set (server default `limit`). At the cap the page
// may have cut a concept's renderings in half, so a per-group count computed
// from it would under-report. We don't paginate here — we just stop claiming a
// count once the result set is at the cap.
const TERMS_PAGE_LIMIT = 500;

// GET /terms sorts by (concept_id, source_term, status, id) so grouped runs
// already arrive adjacent — but correctness must not depend on that, so group
// via a Map keyed by the pair while preserving first-appearance order.
function groupTerms(terms: Term[]): TermGroup[] {
  const byKey = new Map<string, TermGroup>();
  for (const term of terms) {
    // Separator is an explicit \u0000 escape, not a raw NUL byte in the source
    // (invisible in editors, and at risk from tooling that strips control chars).
    const key = `${term.concept_id}\u0000${term.source_term}`;
    let group = byKey.get(key);
    if (!group) {
      group = { key, conceptId: term.concept_id, sourceTerm: term.source_term, terms: [] };
      byKey.set(key, group);
    }
    group.terms.push(term);
  }
  return [...byKey.values()];
}

// The term routes discriminate their 409s by an `error` code in the body:
// `duplicate_term` when the full identity (concept_id, source_term,
// target_term, status) already exists, `version_mismatch` for a lost If-Match
// race. `ApiError.body` carries the parsed JSON body, so read the code.
//
// `codelessCountsAsDuplicate` is for POST /terms: it has no If-Match, so its
// only 409 is a duplicate — a 409 whose body didn't parse is still one, and
// saying so beats the generic "something went wrong". PATCH must not assume
// that, since its other 409 is `version_mismatch`.
function isDuplicateTermError(e: unknown, codelessCountsAsDuplicate = false): boolean {
  if (!(e instanceof ApiError) || e.status !== 409) return false;
  const code = (e.body as { error?: string } | null | undefined)?.error;
  if (!code) return codelessCountsAsDuplicate;
  return code === "duplicate_term";
}

export function TerminologySection({ direction }: { direction: "ltr" | "rtl" }) {
  const { t } = useTranslation();
  const [statusFilter, setStatusFilter] = useState<string>("");
  const [query, setQuery] = useState("");
  const [debouncedQ, setDebouncedQ] = useState("");
  const { terms, loading, refetch } = useTerms(true, {
    status: statusFilter || undefined,
    q: debouncedQ || undefined,
  });
  const [importOpen, setImportOpen] = useState(false);
  const save = useSaveState();
  const groups = useMemo(() => groupTerms(terms), [terms]);

  useEffect(() => {
    const h = setTimeout(() => setDebouncedQ(query.trim()), 300);
    return () => clearTimeout(h);
  }, [query]);

  const onExport = () => {
    const a = document.createElement("a");
    a.href = api.termsExportPath();
    a.download = "terminology.csv";
    document.body.appendChild(a);
    a.click();
    a.remove();
  };

  return (
    <Stack spacing={2}>
      <Stack direction="row" alignItems="center" justifyContent="space-between" flexWrap="wrap" gap={1}>
        <Typography variant="h6">{t("preferences.section.terminology")}</Typography>
        <Stack direction="row" spacing={1}>
          <Button size="small" startIcon={<UploadIcon />} onClick={() => setImportOpen((v) => !v)}>
            {t("preferences.import")}
          </Button>
          <Button size="small" startIcon={<DownloadIcon />} onClick={onExport}>
            {t("preferences.export")}
          </Button>
        </Stack>
      </Stack>
      <Typography variant="body2" color="text.secondary">
        {t("preferences.terminologyIntro")}
      </Typography>

      {importOpen && (
        <ImportPanel onApplied={refetch} onError={() => save.setMsg(t("preferences.actionFailed"))} />
      )}

      <Stack direction="row" spacing={1} flexWrap="wrap" gap={1}>
        <TextField
          size="small"
          placeholder={t("preferences.search")}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          sx={{ minWidth: 220 }}
        />
        <TextField
          select
          size="small"
          label={t("preferences.statusFilter")}
          value={statusFilter}
          onChange={(e) => setStatusFilter(e.target.value)}
          sx={{ minWidth: 180 }}
        >
          <MenuItem value="">{t("preferences.allStatuses")}</MenuItem>
          {TERM_STATUSES.map((s) => (
            <MenuItem key={s} value={s}>
              {t(`preferences.status.${s}`)}
            </MenuItem>
          ))}
        </TextField>
      </Stack>

      <NewTermRow direction={direction} onCreated={refetch} onError={(msg) => save.setMsg(msg)} />

      {loading && terms.length === 0 ? (
        <CircularProgress size={22} />
      ) : terms.length === 0 ? (
        <Typography variant="body2" color="text.secondary">
          {t("preferences.noTerms")}
        </Typography>
      ) : (
        <Stack spacing={1}>
          {groups.map((group) => (
            <TermConceptGroup
              key={group.key}
              group={group}
              direction={direction}
              countIsComplete={terms.length < TERMS_PAGE_LIMIT}
              onChanged={refetch}
              onError={(msg) => save.setMsg(msg)}
            />
          ))}
        </Stack>
      )}
      <Snackbar open={!!save.msg} autoHideDuration={3000} onClose={save.clear} message={save.msg ?? ""} />
    </Stack>
  );
}

function NewTermRow({
  direction,
  onCreated,
  onError,
}: {
  direction: "ltr" | "rtl";
  onCreated: () => void;
  onError: (msg: string) => void;
}) {
  const { t } = useTranslation();
  const [draft, setDraft] = useState<TermInput>({ concept_id: "", source_term: "", target_term: "", status: "preferred" });
  const [busy, setBusy] = useState(false);
  const canAdd =
    draft.concept_id.trim() &&
    draft.source_term.trim() &&
    // A forbidden entry always needs its "use instead" pointer (design §5.1) —
    // the server rejects this too, but disabling Add here avoids a round trip.
    (draft.status !== "forbidden" || !!draft.replacement?.trim());

  const add = async () => {
    if (!canAdd) return;
    setBusy(true);
    try {
      await api.createTerm({
        concept_id: draft.concept_id.trim(),
        source_term: draft.source_term.trim(),
        target_term: draft.target_term?.trim() || null,
        status: draft.status,
        // replacement only means anything for forbidden — force it null
        // otherwise so switching the status field away from forbidden can't
        // leave a stale value behind (the field stays in local draft state
        // even when hidden from the form).
        replacement: draft.status === "forbidden" ? draft.replacement?.trim() || null : null,
        comment: draft.comment?.trim() || null,
      });
      setDraft({ concept_id: "", source_term: "", target_term: "", status: "preferred" });
      onCreated();
    } catch (e) {
      // Same duplicate_term surfacing as AddRenderingRow — see that comment.
      onError(
        isDuplicateTermError(e, true) ? t("preferences.duplicateRendering") : t("preferences.saveFailed"),
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <Box sx={{ border: "1px dashed", borderColor: "divider", borderRadius: 1, p: 1.5 }}>
      <Stack direction="row" spacing={1} flexWrap="wrap" gap={1} alignItems="flex-start">
        <TextField
          size="small"
          label={t("preferences.conceptId")}
          value={draft.concept_id}
          onChange={(e) => setDraft({ ...draft, concept_id: e.target.value })}
          sx={{ width: 160 }}
        />
        <TextField
          size="small"
          label={t("preferences.sourceTerm")}
          value={draft.source_term}
          onChange={(e) => setDraft({ ...draft, source_term: e.target.value })}
          sx={{ width: 160 }}
        />
        <TextField
          size="small"
          label={t("preferences.targetTerm")}
          value={draft.target_term ?? ""}
          onChange={(e) => setDraft({ ...draft, target_term: e.target.value })}
          sx={{ width: 160 }}
          slotProps={{ htmlInput: { dir: direction } }}
        />
        <TextField
          select
          size="small"
          label={t("preferences.termStatus")}
          value={draft.status}
          onChange={(e) => setDraft({ ...draft, status: e.target.value as TermStatus })}
          sx={{ width: 160 }}
        >
          {TERM_STATUSES.map((s) => (
            <MenuItem key={s} value={s}>
              {t(`preferences.status.${s}`)}
            </MenuItem>
          ))}
        </TextField>
        {draft.status === "forbidden" && (
          <TextField
            size="small"
            label={t("preferences.replacement")}
            value={draft.replacement ?? ""}
            onChange={(e) => setDraft({ ...draft, replacement: e.target.value })}
            sx={{ width: 160 }}
            slotProps={{ htmlInput: { dir: direction } }}
          />
        )}
        <TextField
          size="small"
          label={t("preferences.termComment")}
          helperText={t("preferences.termCommentHelp")}
          value={draft.comment ?? ""}
          onChange={(e) => setDraft({ ...draft, comment: e.target.value })}
          sx={{ width: 280 }}
        />
        <Button variant="outlined" startIcon={<AddIcon />} onClick={add} disabled={!canAdd || busy}>
          {t("preferences.addTerm")}
        </Button>
      </Stack>
    </Box>
  );
}

// One concept + source term, with every rendering the team has entered for it.
// Owns the shared header (concept chip + source term, shown once) and the
// "add another rendering" affordance; each rendering's own edit/delete stays in
// TermRow, and the forbidden red tint stays on the individual rendering rather
// than washing the whole group.
function TermConceptGroup({
  group,
  direction,
  countIsComplete,
  onChanged,
  onError,
}: {
  group: TermGroup;
  direction: "ltr" | "rtl";
  // False when the fetched page hit the server's row cap, so a group could be
  // straddling it — see TERMS_PAGE_LIMIT. The count is then hidden rather than
  // asserting a number that may be short.
  countIsComplete: boolean;
  onChanged: () => void;
  onError: (msg: string) => void;
}) {
  const { t } = useTranslation();
  const [adding, setAdding] = useState(false);

  return (
    <Box sx={{ border: "1px solid", borderColor: "divider", borderRadius: 1, p: 1.25 }}>
      <Stack direction="row" alignItems="center" spacing={1} flexWrap="wrap" gap={0.5}>
        <Chip
          label={group.conceptId}
          size="small"
          variant="outlined"
          sx={{ height: 20, fontFamily: "monospace", fontSize: 11 }}
        />
        <Typography variant="body2" sx={{ fontWeight: 600 }}>
          {group.sourceTerm}
        </Typography>
        {group.terms.length > 1 && countIsComplete && (
          <Typography variant="caption" color="text.secondary">
            {t("preferences.renderingCount", { count: group.terms.length })}
          </Typography>
        )}
        <Box sx={{ flex: 1 }} />
        {/* Toggle, so its label has to say which way it toggles — an unchanged
            "Add another rendering" label made a second click silently throw a
            filled-in form away. */}
        <Button
          size="small"
          color={adding ? "inherit" : "primary"}
          startIcon={adding ? undefined : <AddIcon />}
          onClick={() => setAdding((v) => !v)}
        >
          {adding ? t("preferences.cancel") : t("preferences.addRendering")}
        </Button>
      </Stack>
      <Stack spacing={1} sx={{ mt: 1 }}>
        {group.terms.map((term) => (
          <TermRow
            key={term.id}
            term={term}
            direction={direction}
            onChanged={onChanged}
            onError={onError}
          />
        ))}
        {adding && (
          <AddRenderingRow
            conceptId={group.conceptId}
            sourceTerm={group.sourceTerm}
            direction={direction}
            onCreated={() => {
              setAdding(false);
              onChanged();
            }}
            onError={onError}
          />
        )}
      </Stack>
    </Box>
  );
}

// Inline mini-form for a second (third, fourth…) rendering of an existing
// concept. concept_id / source_term are prefilled from the group but stay
// editable — an editor adding the Hebrew or Greek source variant of the same
// concept needs to change source_term while keeping concept_id.
function AddRenderingRow({
  conceptId,
  sourceTerm,
  direction,
  onCreated,
  onError,
}: {
  conceptId: string;
  sourceTerm: string;
  direction: "ltr" | "rtl";
  onCreated: () => void;
  onError: (msg: string) => void;
}) {
  const { t } = useTranslation();
  const [draft, setDraft] = useState<TermInput>({
    concept_id: conceptId,
    source_term: sourceTerm,
    target_term: "",
    status: "preferred",
  });
  const [busy, setBusy] = useState(false);
  const canAdd =
    !!draft.concept_id.trim() &&
    !!draft.source_term.trim() &&
    (draft.status !== "forbidden" || !!draft.replacement?.trim());

  const add = async () => {
    if (!canAdd) return;
    setBusy(true);
    try {
      await api.createTerm({
        concept_id: draft.concept_id.trim(),
        source_term: draft.source_term.trim(),
        target_term: draft.target_term?.trim() || null,
        status: draft.status,
        // Same stale-replacement guard as NewTermRow.add — see that comment.
        replacement: draft.status === "forbidden" ? draft.replacement?.trim() || null : null,
        comment: draft.comment?.trim() || null,
      });
      onCreated();
    } catch (e) {
      // POST /terms answers 409 `duplicate_term` when this exact identity
      // (concept + source + rendering + status) already exists. That is a
      // distinct, actionable outcome — not the generic failure.
      if (isDuplicateTermError(e, true)) {
        onError(t("preferences.duplicateRendering"));
      } else {
        onError(t("preferences.saveFailed"));
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <Box sx={{ border: "1px dashed", borderColor: "divider", borderRadius: 1, p: 1.25 }}>
      <Stack direction="row" spacing={1} flexWrap="wrap" gap={1} alignItems="flex-start">
        <TextField
          size="small"
          label={t("preferences.conceptId")}
          value={draft.concept_id}
          onChange={(e) => setDraft({ ...draft, concept_id: e.target.value })}
          sx={{ width: 160 }}
        />
        <TextField
          size="small"
          label={t("preferences.sourceTerm")}
          value={draft.source_term}
          onChange={(e) => setDraft({ ...draft, source_term: e.target.value })}
          sx={{ width: 160 }}
        />
        <TextField
          size="small"
          label={t("preferences.targetTerm")}
          value={draft.target_term ?? ""}
          onChange={(e) => setDraft({ ...draft, target_term: e.target.value })}
          sx={{ width: 160 }}
          slotProps={{ htmlInput: { dir: direction } }}
        />
        <TextField
          select
          size="small"
          label={t("preferences.termStatus")}
          value={draft.status}
          onChange={(e) => setDraft({ ...draft, status: e.target.value as TermStatus })}
          sx={{ width: 160 }}
        >
          {TERM_STATUSES.map((s) => (
            <MenuItem key={s} value={s}>
              {t(`preferences.status.${s}`)}
            </MenuItem>
          ))}
        </TextField>
        {draft.status === "forbidden" && (
          <TextField
            size="small"
            label={t("preferences.replacement")}
            value={draft.replacement ?? ""}
            onChange={(e) => setDraft({ ...draft, replacement: e.target.value })}
            sx={{ width: 160 }}
            slotProps={{ htmlInput: { dir: direction } }}
          />
        )}
        <TextField
          size="small"
          label={t("preferences.termComment")}
          helperText={t("preferences.termCommentHelp")}
          value={draft.comment ?? ""}
          onChange={(e) => setDraft({ ...draft, comment: e.target.value })}
          sx={{ width: 280 }}
        />
        <Button variant="outlined" startIcon={<AddIcon />} onClick={add} disabled={!canAdd || busy}>
          {t("preferences.addTerm")}
        </Button>
      </Stack>
    </Box>
  );
}

function TermRow({
  term,
  direction,
  onChanged,
  onError,
}: {
  term: Term;
  direction: "ltr" | "rtl";
  onChanged: () => void;
  onError: (msg: string) => void;
}) {
  const { t } = useTranslation();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<Term>(term);
  const [busy, setBusy] = useState(false);
  // Resync the draft when the server copy changes — but never while this row is
  // being edited. Renderings of a concept are siblings now, so adding one (or
  // any other change in the group) refetches the whole list and hands every
  // sibling a fresh `Term`; without the guard that silently wipes a
  // half-finished edit next door. Paths that *should* replace the draft
  // (cancel, successful save, version_mismatch) all leave edit mode first, so
  // the resync still fires for them. Adjusted during render: outside edit mode
  // nothing else edits the draft, so this converges once it equals `term`.
  if (!editing && draft !== term) setDraft(term);

  const saveEdit = async () => {
    setBusy(true);
    try {
      await api.patchTerm(term.id, term.version, {
        target_term: draft.target_term,
        status: draft.status,
        // Same stale-replacement guard as NewTermRow.add — see that comment.
        replacement: draft.status === "forbidden" ? draft.replacement : null,
        comment: draft.comment,
        tw_link: draft.tw_link,
      });
      setEditing(false);
      onChanged();
    } catch (e) {
      // PATCH has two distinct 409s. `duplicate_term` means this edit would
      // collide with another rendering of the same concept — the row is NOT
      // stale, so stay in edit mode and don't refetch (that would throw the
      // edit away).
      if (isDuplicateTermError(e)) {
        onError(t("preferences.duplicateRendering"));
        // A version_mismatch means someone else edited this term first —
        // refresh the row so the retry has the right version instead of
        // leaving a stale, silently un-saved edit in place.
      } else if (e instanceof ApiError && e.status === 409) {
        onError(t("preferences.conflict"));
        // Leave edit mode so the resync is allowed to replace the draft
        // with whatever the refetch brings back — otherwise the guard would
        // keep the stale, unsaved edit on screen.
        setEditing(false);
        onChanged();
      } else {
        onError(t("preferences.actionFailed"));
      }
    } finally {
      setBusy(false);
    }
  };
  const del = async () => {
    setBusy(true);
    try {
      await api.deleteTerm(term.id);
      onChanged();
    } catch {
      onError(t("preferences.actionFailed"));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Box
      sx={{
        // A rendering is nested inside its concept card, so it takes a
        // status-coloured start rail rather than a second full border. The
        // forbidden tint stays here, on the individual rendering, never on the
        // whole concept group.
        // `borderColor` (not `borderInlineStartColor`): MUI v6's sx config has
        // no `borderInlineStartColor` entry, so a theme path like
        // "success.main" would pass through unresolved and the browser would
        // drop the declaration, leaving the rail at currentColor for every
        // status. borderColor resolves the path, and only the inline-start edge
        // has a non-zero width — so it stays a single RTL-safe rail.
        borderInlineStart: "3px solid",
        borderColor: termStatusColor(term.status),
        borderRadius: 1,
        px: 1.25,
        py: 0.75,
        bgcolor: (theme) =>
          term.status === "forbidden" ? alpha(theme.palette.error.main, 0.05) : "transparent",
      }}
    >
      <Stack direction="row" alignItems="center" spacing={1} flexWrap="wrap" gap={0.5}>
        {/* concept_id + source_term live in the enclosing TermConceptGroup
            header — a rendering row shows only what distinguishes it. */}
        <Typography variant="body2" color="text.disabled">
          {t("preferences.termArrow")}
        </Typography>
        {editing ? (
          <TextField
            size="small"
            value={draft.target_term ?? ""}
            onChange={(e) => setDraft({ ...draft, target_term: e.target.value || null })}
            slotProps={{ htmlInput: { dir: direction } }}
            sx={{ width: 180 }}
          />
        ) : (
          <Typography variant="body2" dir={direction} sx={{ fontWeight: 600 }}>
            {term.target_term ?? t("preferences.noRendering")}
          </Typography>
        )}
        {editing ? (
          <TextField
            select
            size="small"
            value={draft.status}
            onChange={(e) => setDraft({ ...draft, status: e.target.value as TermStatus })}
            sx={{ width: 150 }}
          >
            {TERM_STATUSES.map((s) => (
              <MenuItem key={s} value={s}>
                {t(`preferences.status.${s}`)}
              </MenuItem>
            ))}
          </TextField>
        ) : (
          <StatusChip status={term.status} />
        )}
        {term.status === "forbidden" && !editing && term.replacement && (
          <Typography variant="caption" color="error.main">
            {t("preferences.useInstead", { term: term.replacement })}
          </Typography>
        )}
        {editing && draft.status === "forbidden" && (
          <TextField
            size="small"
            label={t("preferences.replacement")}
            value={draft.replacement ?? ""}
            onChange={(e) => setDraft({ ...draft, replacement: e.target.value || null })}
            slotProps={{ htmlInput: { dir: direction } }}
            sx={{ width: 150 }}
          />
        )}
        <Box sx={{ flex: 1 }} />
        {editing ? (
          <>
            <Button
              size="small"
              onClick={saveEdit}
              disabled={busy || (draft.status === "forbidden" && !draft.replacement?.trim())}
            >
              {t("preferences.save")}
            </Button>
            <Button size="small" color="inherit" onClick={() => { setEditing(false); setDraft(term); }}>
              {t("preferences.cancel")}
            </Button>
          </>
        ) : (
          <>
            <Button size="small" onClick={() => setEditing(true)}>
              {t("preferences.edit")}
            </Button>
            <Tooltip title={t("preferences.delete")}>
              <IconButton size="small" onClick={del} disabled={busy}>
                <DeleteOutlineIcon fontSize="small" />
              </IconButton>
            </Tooltip>
          </>
        )}
      </Stack>
      {editing && (
        <TextField
          size="small"
          fullWidth
          label={t("preferences.termComment")}
          helperText={t("preferences.termCommentHelp")}
          value={draft.comment ?? ""}
          onChange={(e) => setDraft({ ...draft, comment: e.target.value || null })}
          sx={{ mt: 1 }}
        />
      )}
      {/* Rationale is read-only prose the bot ignores for matching — shown
          inline so an editor can see it without entering edit mode. */}
      {term.comment && !editing && (
        <Typography variant="caption" color="text.secondary" sx={{ display: "block" }}>
          {term.comment}
        </Typography>
      )}
      {term.tw_link && !editing && (
        <Typography variant="caption" color="text.secondary" sx={{ fontFamily: "monospace" }}>
          {term.tw_link}
        </Typography>
      )}
    </Box>
  );
}

// Per-line lists are capped so a bad 5000-row paste can't blow up the panel.
const IMPORT_LINE_LIMIT = 20;

function ImportLineList({
  lines,
  severity,
  title,
}: {
  lines: { line: number; message: string }[];
  severity: "error" | "warning";
  title: string;
}) {
  const { t } = useTranslation();
  const shown = lines.slice(0, IMPORT_LINE_LIMIT);
  const hidden = lines.length - shown.length;
  return (
    <Alert severity={severity} sx={{ mt: 1, py: 0.25 }}>
      <Typography variant="caption" sx={{ fontWeight: 600, display: "block" }}>
        {title}
      </Typography>
      {shown.map((l, i) => (
        <Typography key={`${l.line}-${i}`} variant="caption" sx={{ display: "block" }}>
          {t("preferences.importLine", { line: l.line, message: l.message })}
        </Typography>
      ))}
      {hidden > 0 && (
        <Typography variant="caption" sx={{ display: "block", fontStyle: "italic" }}>
          {t("preferences.importMore", { count: hidden })}
        </Typography>
      )}
    </Alert>
  );
}

function ImportPanel({ onApplied, onError }: { onApplied: () => void; onError: () => void }) {
  const { t } = useTranslation();
  const [text, setText] = useState("");
  // Keep the whole server response — the per-line parseErrors / parseWarnings
  // detail is the point of the Preview button, and the old code threw it away
  // in favour of a bare count.
  const [result, setResult] = useState<TermImportResult | null>(null);
  const [busy, setBusy] = useState(false);
  const parseErrors = result?.parseErrors ?? [];
  // Optional until the Worker that emits it ships.
  const parseWarnings = result?.parseWarnings ?? [];

  const run = async (dryRun: boolean) => {
    if (!text.trim()) return;
    setBusy(true);
    try {
      const res = await api.importTerms(text, dryRun);
      setResult(res);
      // Refresh the term list but keep the panel open — the added/updated/error
      // counts above are the whole point of a real (non-dry-run) import and
      // must stay visible until the user is done reviewing them.
      if (!dryRun) onApplied();
    } catch {
      onError();
    } finally {
      setBusy(false);
    }
  };

  return (
    <Box sx={{ border: "1px solid", borderColor: "divider", borderRadius: 1, p: 2 }}>
      <Typography variant="subtitle2" gutterBottom>
        {t("preferences.importTitle")}
      </Typography>
      <Typography variant="caption" color="text.secondary">
        {t("preferences.importHelp")}
      </Typography>
      <TextField
        value={text}
        onChange={(e) => setText(e.target.value)}
        multiline
        minRows={5}
        fullWidth
        placeholder={t("preferences.csvColumnPlaceholder")}
        sx={{ mt: 1 }}
        slotProps={{ input: { sx: { fontFamily: "monospace", fontSize: 12 } } }}
      />
      {result && (
        <>
          <Alert
            severity={parseErrors.length ? "error" : parseWarnings.length ? "warning" : "success"}
            sx={{ mt: 1, py: 0.25 }}
          >
            <Typography variant="caption" sx={{ display: "block", fontWeight: 600 }}>
              {t(result.dryRun ? "preferences.importPreviewLabel" : "preferences.importAppliedLabel")}
            </Typography>
            {/* importResult is already translated in every locale with its
                original {{added}}/{{updated}}/{{errors}} placeholders — total
                and the warning count are added as a separate key rather than
                widening it, so non-English users don't lose the new figures. */}
            {t("preferences.importResult", {
              added: result.added,
              updated: result.updated,
              errors: parseErrors.length,
            })}
            <Typography variant="caption" sx={{ display: "block" }}>
              {t("preferences.importTotals", {
                total: result.total,
                warnings: parseWarnings.length,
              })}
            </Typography>
          </Alert>
          {parseErrors.length > 0 && (
            <ImportLineList
              lines={parseErrors}
              severity="error"
              title={t("preferences.importErrorsTitle")}
            />
          )}
          {parseWarnings.length > 0 && (
            <ImportLineList
              lines={parseWarnings}
              severity="warning"
              title={t("preferences.importWarningsTitle")}
            />
          )}
        </>
      )}
      <Stack direction="row" spacing={1} sx={{ mt: 1 }}>
        <Button size="small" onClick={() => run(true)} disabled={busy || !text.trim()}>
          {t("preferences.dryRun")}
        </Button>
        <Button size="small" variant="contained" onClick={() => run(false)} disabled={busy || !text.trim()}>
          {t("preferences.applyImport")}
        </Button>
      </Stack>
    </Box>
  );
}
