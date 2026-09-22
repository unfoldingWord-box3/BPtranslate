// Typed fetch helpers for the editor API. All paths are relative (Vite's
// dev proxy points /api/* at the local Worker; production serves the SPA
// from the same origin as the Worker).

import type { LayoutSpec } from "../lib/layoutSpec";
import { getWorkspaceSlug, setWorkspaceSlug } from "./workspace";

export type RowKind = "tn" | "tq" | "twl";

export interface TnRow {
  id: string;
  book: string;
  chapter: number;
  verse: number;
  ref_raw: string;
  tags: string | null;
  support_reference: string | null;
  quote: string | null;
  occurrence: number | null;
  note: string | null;
  sort_order: number | null;
  version: number;
  restored_from_version: number | null;
  updated_by: number | null;
  updated_at: number;
  deleted_at: number | null;
  /**
   * Visible, restorable soft-delete. Set via /trash (the delete button),
   * cleared via /restore. A trashed note stays in the chapter read (grayed,
   * sorted last) until the nightly 06:00 UTC job promotes it to a permanent
   * deleted_at tombstone. NULL means "not trashed".
   */
  trashed_at: number | null;
  /** Explicit "survive future AI pipeline sweeps" bit. Set via /preserve. */
  preserve: 0 | 1;
  /** Editor-authored stub queued for the next chapter-wide AI pipeline run. */
  hint: 0 | 1;
  /**
   * AI provenance: 'ai_pipeline' when the last edit came from the auto-apply
   * step (chip should show), otherwise null. Cleared by any later human
   * edit/keep. Computed at read time from edit_log, not stored on the row.
   */
  latest_source?: string | null;
  /**
   * Translation-mode state machine (migration 0037; returned via `SELECT t.*`).
   * NULL for the English root project and for any row the translate pipeline
   * never touched, so the English workflow is unaffected. 'ai_draft' = the
   * translate pipeline just applied an AI translation; 'edited' = a human
   * changed the draft (set server-side on a content PATCH of a non-NULL row);
   * 'validated' = a human approved it (POST /tn/:id/validate).
   */
  translation_state?: "ai_draft" | "edited" | "validated" | null;
  /** Hash of the EN source row the draft was made from (source-drift detection). */
  source_row_hash?: string | null;
  /** translate-report.json entry for this row (confidence/terms); NULL when the bot ships no sidecar. */
  draft_meta_json?: string | null;
}

export interface TqRow {
  id: string;
  book: string;
  chapter: number;
  verse: number;
  ref_raw: string;
  tags: string | null;
  quote: string | null;
  occurrence: number | null;
  question: string | null;
  response: string | null;
  sort_order: number | null;
  version: number;
  restored_from_version: number | null;
  updated_by: number | null;
  updated_at: number;
  deleted_at: number | null;
  /** Translation-mode state machine (multilingual; mirrors TnRow). */
  translation_state?: "ai_draft" | "edited" | "validated" | null;
  source_row_hash?: string | null;
  draft_meta_json?: string | null;
  /** See TnRow.latest_source. */
  latest_source?: string | null;
}

export interface TwlRow {
  id: string;
  book: string;
  chapter: number;
  verse: number;
  ref_raw: string;
  tags: string | null;
  orig_words: string | null;
  occurrence: number | null;
  tw_link: string | null;
  sort_order: number | null;
  version: number;
  restored_from_version: number | null;
  updated_by: number | null;
  updated_at: number;
  deleted_at: number | null;
}

export interface VerseDto {
  book: string;
  chapter: number;
  verse: number;
  // Inclusive end of a multi-verse block (e.g. `\v 6-9` → verse=6, verse_end=9).
  // NULL for singleton verses. PR 2 widens UI rendering to span these.
  verse_end: number | null;
  bible_version: string;
  /** Lane generation for ULT/UST; typically 1 for UHB/UGNT. */
  source_generation?: number;
  plain_text: string | null;
  version: number;
  updated_by: number | null;
  updated_at: number;
  content: unknown;
}

export type AlignmentIntent =
  | "text_edit"
  | "find_replace"
  | "section_edit"
  | "alignment_edit";

export interface VerseStatus {
  book: string;
  chapter: number;
  verse: number;
  done: 0 | 1;
  updated_at: number;
}

// Per-resource checkoff lanes. "text" = ULT + UST together.
export type CheckLane = "text" | "tn" | "tw" | "tq";
export const CHECK_LANES: readonly CheckLane[] = ["text", "tn", "tw", "tq"] as const;

export interface VerseLaneCheck {
  book: string;
  chapter: number;
  verse: number;
  lane: CheckLane;
  checked_by: number;
  checked_at: number;
}

// Response from a lane toggle / WS event: the full checker set for one (verse,
// lane) so the client can recompute its own shade.
export interface LaneCheckState {
  book: string;
  chapter: number;
  verse: number;
  lane: CheckLane;
  checkers: number[];
}

export interface ChapterPayload {
  book: string;
  chapter: number;
  verses: Record<string, Record<number, VerseDto>>;
  tn: TnRow[];
  tq: TqRow[];
  twl: TwlRow[];
  verseStatuses: VerseStatus[];
  verseLaneChecks: VerseLaneCheck[];
}

export interface BookSummary {
  book: string;
  chapters: Array<{
    chapter: number;
    verses: number;
    tn: number;
    tq: number;
    twl: number;
    // Review rollup (docs/ux-simplification.md A2): live rows with
    // translation_state='validated' and verses flagged done. Optional because
    // an older API build omits them — consumers must treat absence as
    // "rollup unavailable", not as zero progress.
    tnValidated?: number;
    tqValidated?: number;
    versesDone?: number;
  }>;
}

// One DCS-validation finding from GET /api/books/:book/lint. `bucket` splits
// content problems a translator must resolve ("flag") from integrity issues
// like footnotes ("escalate"). `ref` is "chapter:verse" (or "chapter"); `rowId`
// is present for TN findings so the UI can jump straight to the offending note.
export interface BookLintIssue {
  check: string;
  bucket: "flag" | "escalate";
  ref: string;
  rowId?: string;
  message: string;
  resource: "tn" | "ult" | "ust";
}

export interface BookLintReport {
  book: string;
  total: number;
  /** Issues needing a human decision (the "flag" bucket). */
  flagCount: number;
  /** Integrity issues (footnotes) — secondary, count only. */
  escalateCount: number;
  issues: BookLintIssue[];
}

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
    public body?: unknown,
  ) {
    super(message);
  }
}

// 409 body returned by mutation routes when a chapter has a non-terminal
// AI pipeline targeting it. The Worker returns this for POST/PATCH/DELETE on
// rows + PATCH on verses; client widgets can surface "AI run in progress
// (started X min ago)" without a second fetch.
export interface ChapterLockedBody {
  error: "chapter_locked";
  jobId: string;
  pipelineType: PipelineType;
  startedAt: number; // unix seconds
}

export function isChapterLockedBody(body: unknown): body is ChapterLockedBody {
  if (!body || typeof body !== "object") return false;
  const b = body as Record<string, unknown>;
  return b.error === "chapter_locked" && typeof b.jobId === "string";
}

// 409 body returned by /api/pipelines/start when the upstream rejects the
// request because another sessionKey already has this (pipelineType, scope)
// running. The Worker enriches the bare upstream body with `existing` —
// pulled from D1 so translator B can see who's running it without an
// ownership-bumping endpoint.
export interface PipelineConflictExisting {
  job_id: string;
  pipeline_type: PipelineType;
  book: string;
  start_chapter: number;
  end_chapter: number;
  state: PipelineState;
  current_skill: string | null;
  current_status: string | null;
  created_at: number;
  updated_at: number;
  started_by_username: string | null;
}
export interface PipelineConflictBody {
  error: "conflict";
  jobId: string;
  /**
   * Present when the conflicting job was started via this editor (it lives
   * in our D1). Absent for jobs started outside the editor (e.g. Zulip).
   */
  existing?: PipelineConflictExisting;
}

// Auth lives in cookies set by the server (be_access HttpOnly + be_refresh
// HttpOnly + be_csrf non-HttpOnly). We never store the JWT on the client.
// All fetches in this module pass `credentials: "include"` so the cookies
// ride along even on cross-origin requests (the prod deployment is same-
// origin, but the credentials flag is harmless either way).
//
// Writes also mirror the be_csrf cookie value into an X-CSRF-Token header so
// the server can validate double-submit.

const CSRF_COOKIE_NAME = "be_csrf";

// Guards the workspace-mismatch reload below from looping forever if the
// server keeps disagreeing with what we just reconciled to (shouldn't
// happen, but must never reload-loop the tab). Mirrors App.tsx's
// WS_RECONCILED_KEY for the boot-time reconciliation path.
const WS_MISMATCH_RELOAD_KEY = "bible-editor.ws-mismatch-reloaded";

function readCookie(name: string): string | null {
  if (typeof document === "undefined") return null;
  const prefix = `${name}=`;
  for (const part of document.cookie.split(";")) {
    const t = part.trim();
    if (t.startsWith(prefix)) {
      try {
        return decodeURIComponent(t.slice(prefix.length));
      } catch {
        return t.slice(prefix.length);
      }
    }
  }
  return null;
}

function getCsrfToken(): string | null {
  return readCookie(CSRF_COOKIE_NAME);
}

// Read-only flag — set when the current JWT carries role='viewer'. The
// outbox checks this before enqueueing a write so editor UI components that
// haven't been individually gated still can't trigger 403s. UI components
// that want to disable inputs can read this directly.
let readOnly = false;
export function isReadOnly(): boolean {
  return readOnly;
}
export function setReadOnly(v: boolean) {
  readOnly = v;
}

// Admin flag — set when the current JWT carries role='admin'. Admin-only
// surfaces (assisted-mode toggle, context export, prefs PUT) check this so
// editors see a clear disabled state instead of a silent 403.
let adminRole = false;
export function isAdmin(): boolean {
  return adminRole;
}
export function setIsAdmin(v: boolean) {
  adminRole = v;
}

// Surface to the UI that we tried to silently refresh a 401 and it failed.
// App.tsx subscribes to render a "Session expired — sign in again" banner;
// the outbox keeps queuing edits in the meantime so nothing is lost.
type AuthErrorListener = () => void;
const authErrorListeners = new Set<AuthErrorListener>();
export function onAuthError(fn: AuthErrorListener): () => void {
  authErrorListeners.add(fn);
  return () => authErrorListeners.delete(fn);
}
function emitAuthError() {
  for (const fn of authErrorListeners) {
    try { fn(); } catch { /* listener bug — don't break the request pipeline */ }
  }
}

// Fired after a *successful* silent refresh. The outbox subscribes to
// revive ops that were parked as failed (max_attempts_exceeded) while the
// session was dead — a fresh access cookie is exactly the condition change
// that makes them worth a new retry budget.
type AuthRefreshedListener = () => void;
const authRefreshedListeners = new Set<AuthRefreshedListener>();
export function onAuthRefreshed(fn: AuthRefreshedListener): () => void {
  authRefreshedListeners.add(fn);
  return () => authRefreshedListeners.delete(fn);
}
function emitAuthRefreshed() {
  for (const fn of authRefreshedListeners) {
    try { fn(); } catch { /* listener bug — don't break the request pipeline */ }
  }
}

// Concurrent failing requests share a single refresh attempt so we don't
// trigger N refresh calls when N in-flight outbox ops all 401 at once. The
// server reads the be_refresh cookie (SameSite=Strict, sent automatically
// on same-origin POST) and rotates the be_access cookie.
// Exported for wsClient.ts — a WS handshake rejected before `open` can't go
// through request()'s 401 path, so the reconnect loop calls this directly.
let refreshInFlight: Promise<boolean> | null = null;

// A refresh must not hang forever. wsClient.ts runs
// `refreshAuthOnce().then(() => scheduleReconnect())` on a pre-open WS close;
// if the refresh fetch stalls on a half-open socket (post network-change),
// scheduleReconnect never fires *and* refreshInFlight stays pinned, blocking
// every 401 caller behind it. Cap it like request() does. A bit shorter than
// the 30s request default — refresh is a tiny POST, and we'd rather fail fast
// and let the outbox's online/focus retries get another shot.
const REFRESH_TIMEOUT_MS = 12_000;

export async function refreshAuthOnce(): Promise<boolean> {
  if (refreshInFlight) return refreshInFlight;
  refreshInFlight = (async () => {
    const ctrl = new AbortController();
    const timer = setTimeout(
      () => ctrl.abort(new DOMException("timeout", "TimeoutError")),
      REFRESH_TIMEOUT_MS,
    );
    try {
      const res = await fetch("/api/auth/refresh", {
        method: "POST",
        credentials: "include",
        signal: ctrl.signal,
      });
      if (res.ok) emitAuthRefreshed();
      return res.ok;
    } catch {
      // Timeout or network error — treat as a failed refresh. Resolving
      // false (rather than rejecting) keeps wsClient's `.then()` chain intact
      // so scheduleReconnect still fires.
      return false;
    } finally {
      clearTimeout(timer);
      // Clear after a brief delay so a burst of concurrent 401s coalesce on
      // the same refresh promise. Without the delay we could race a second
      // refresh between resolution and the next call's `if (refreshInFlight)`
      // check.
      setTimeout(() => { refreshInFlight = null; }, 0);
    }
  })();
  return refreshInFlight;
}

// Default 30s. Picked over 15s because verse PATCH with full USFM tree on a
// slow link can legitimately take double-digit seconds. Higher than this and
// a half-open socket starts to block sibling outbox ops (the outbox's per-
// target FIFO means a hung op holds back everything on that row).
// Exported so the outbox can derive its in-flight recovery threshold from it.
export const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;

export interface RequestInitWithTimeout extends RequestInit {
  /** Override the default 30s timeout. Pass 0 to disable. */
  timeoutMs?: number;
}

// Compose any number of AbortSignals into one. Aborts as soon as any input
// aborts. We can't use AbortSignal.any directly because Safari < 17.4 and
// Firefox < 124 didn't ship it yet.
function composeSignals(signals: AbortSignal[]): AbortSignal {
  if (signals.length === 1) return signals[0]!;
  const controller = new AbortController();
  const onAbort = (s: AbortSignal) => {
    if (controller.signal.aborted) return;
    controller.abort(s.reason);
  };
  for (const s of signals) {
    if (s.aborted) {
      onAbort(s);
      break;
    }
    s.addEventListener("abort", () => onAbort(s), { once: true });
  }
  return controller.signal;
}

async function request<T>(
  path: string,
  init?: RequestInitWithTimeout,
  _retriedAfterRefresh = false,
): Promise<T> {
  // Viewer (read-only) accounts: short-circuit anything that isn't a GET so
  // the server never sees a write attempt. ApiError(403, "read_only") is a
  // distinct sentinel callers can detect; the outbox already treats 403 as
  // fatal so it won't loop.
  const method = (init?.method ?? "GET").toUpperCase();
  if (readOnly && method !== "GET" && method !== "HEAD") {
    throw new ApiError(403, "read_only");
  }

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    ...((init?.headers as Record<string, string>) ?? {}),
  };
  // Double-submit CSRF on writes. Server matches X-CSRF-Token against the
  // be_csrf cookie and 403s on mismatch. GETs are exempt server-side.
  if (method !== "GET" && method !== "HEAD" && !headers["X-CSRF-Token"]) {
    const csrf = getCsrfToken();
    if (csrf) headers["X-CSRF-Token"] = csrf;
  }
  // Stamp this tab's own notion of the active workspace on every request.
  // The server (requireWorkspaceMatch in api/src/workspaces.ts) compares it
  // against the workspace it actually resolved the request against (from the
  // be_ws cookie) and 409s workspace_mismatch on a mismatch — the signal that
  // a SIBLING tab switched orgs and this tab is now stale. See the 409
  // handling below and outbox.ts's dispatch().
  headers["X-Workspace"] = getWorkspaceSlug();

  const timeoutMs = init?.timeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
  let signal = init?.signal ?? undefined;
  let timer: ReturnType<typeof setTimeout> | null = null;
  if (timeoutMs > 0) {
    const timeoutCtrl = new AbortController();
    timer = setTimeout(
      () => timeoutCtrl.abort(new DOMException("timeout", "TimeoutError")),
      timeoutMs,
    );
    signal = signal ? composeSignals([signal, timeoutCtrl.signal]) : timeoutCtrl.signal;
  }

  // Strip our extension before handing to fetch. credentials: "include"
  // means cookies always ride along — same-origin in production, and Vite's
  // dev proxy preserves them too.
  const fetchInit: RequestInit = { ...init, headers, signal, credentials: "include" };
  delete (fetchInit as RequestInitWithTimeout).timeoutMs;

  // The timeout signal must stay armed until the *body* is consumed, not
  // just until headers arrive — a stalled response body would otherwise hang
  // res.json() forever and freeze the globally-serial outbox drain. The
  // finally below is the single release point.
  let res: Response;
  try {
    try {
      res = await fetch(path, fetchInit);
    } catch (e) {
      // Surface our timeout as a plain Error so callers (notably the outbox at
      // outbox.ts dispatch → `e instanceof ApiError === false` branch)
      // classify it as `network`/retry instead of `fatal`.
      if (e instanceof DOMException && e.name === "TimeoutError") {
        throw new Error("request timeout");
      }
      throw e;
    }

    if (res.status === 401 && !_retriedAfterRefresh) {
      // First attempt is settled (we never read its body) — release its
      // timer now; the retry below arms its own body-covering timeout.
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      // Silent refresh once per request. Only attempt while online — refreshing
      // through a captive portal would just burn the refresh window. The
      // outbox retries on `online`/`focus` so we'll get another shot then.
      if (typeof navigator !== "undefined" && navigator.onLine === false) {
        throw new ApiError(401, "HTTP 401");
      }
      const refreshed = await refreshAuthOnce();
      if (refreshed) {
        return await request<T>(path, init, true);
      }
      // Refresh failed — token is dead or user was revoked. Surface to UI so
      // the user sees *why* their edits are queueing forever.
      emitAuthError();
      throw new ApiError(401, "HTTP 401");
    }

    if (!res.ok) {
      let body: unknown = null;
      try {
        body = await res.json();
      } catch {
        /* ignore — status alone is enough to classify the error */
      }
      // workspace_mismatch: the server resolved this request against a
      // different org than the X-Workspace header claimed (see
      // requireWorkspaceMatch in api/src/workspaces.ts) — a SIBLING tab
      // switched orgs and this tab's localStorage slug is now stale.
      // Reconcile onto the server's slug and reload so this tab re-derives
      // its outbox database + config from the org it's actually talking to.
      // Guarded by a sessionStorage flag (same shape as App.tsx's boot
      // reconciliation) so a persistent disagreement can't reload-loop.
      //
      // Do NOT treat this as fatal here: still throw ApiError below so
      // outbox.ts's dispatch() can classify it distinctly from a version
      // conflict (409 + `current`) — the op stays queued, it belongs to the
      // OTHER workspace's outbox and will drain once the user is back there.
      if ((body as { error?: string } | null)?.error === "workspace_mismatch") {
        const expected = (body as { expected?: string }).expected;
        if (expected && expected !== getWorkspaceSlug()) {
          let alreadyReloaded = false;
          try {
            alreadyReloaded = sessionStorage.getItem(WS_MISMATCH_RELOAD_KEY) === "1";
          } catch {
            /* private mode */
          }
          if (!alreadyReloaded) {
            setWorkspaceSlug(expected);
            try {
              sessionStorage.setItem(WS_MISMATCH_RELOAD_KEY, "1");
            } catch {
              /* private mode */
            }
            location.reload();
          }
        }
      }
      // csrf_mismatch is recoverable, not fatal: the be_csrf cookie expired
      // (or was cleared) while the session itself is still valid. A refresh
      // re-mints the cookie via setSessionCookies, so the retry reads a fresh
      // value. Same one-shot, online-only refresh-and-retry as the 401 path
      // above. (read_only 403s short-circuit before fetch, so they never land
      // here.)
      if (
        res.status === 403 &&
        !_retriedAfterRefresh &&
        (body as { error?: string } | null)?.error === "csrf_mismatch" &&
        !(typeof navigator !== "undefined" && navigator.onLine === false)
      ) {
        if (timer) {
          clearTimeout(timer);
          timer = null;
        }
        const refreshed = await refreshAuthOnce();
        if (refreshed) {
          return await request<T>(path, init, true);
        }
        // Refresh failed — the session is dead, not just the CSRF cookie.
        emitAuthError();
        throw new ApiError(401, "HTTP 401");
      }
      throw new ApiError(res.status, `HTTP ${res.status}`, body);
    }
    try {
      return (await res.json()) as T;
    } catch (e) {
      // A timeout firing mid-body-read aborts the stream with our reason —
      // map it to the same plain Error as the fetch path above.
      if (e instanceof DOMException && e.name === "TimeoutError") {
        throw new Error("request timeout");
      }
      throw e;
    }
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export type Role = "admin" | "editor" | "viewer";

// user_roles allowlist row (api/src/adminUserRoutes.ts). role is really only
// "admin"|"editor" here (viewers come from DCS org membership, not this
// table) but Role is reused since the narrower union buys nothing.
export interface AdminUser {
  username: string;
  role: Role;
  addedAt: number | null;
  addedBy: string | null;
  /** "manual" = granted in this panel; "dcs_team" = derived from Door43 team membership. */
  source?: "manual" | "dcs_team";
}

/** A live Door43 org member (from GET /api/admin/users/org-members), not the allowlist. */
export interface OrgMember {
  login: string;
  fullName: string;
  avatarUrl: string;
  /** Live team-derived role (BE-Admins → admin, BE-Editors → editor), resolved
   *  from Door43 team membership independent of whether the member has ever
   *  signed in. Present only when team membership could be read (the
   *  authenticated roster paths); absent on the public-members fallback. */
  teamRole?: "admin" | "editor";
}

export interface OrgMembersResponse {
  /** The project's configured org that was queried. */
  org: string;
  members: OrgMember[];
  /** Set when DCS was unreachable / errored — members is empty; page stays usable. */
  error?: string;
  /** True when the roster exceeded the page cap and is incomplete. */
  truncated: boolean;
  /** True when `members`/`error` came from a public-members fallback (the
   *  service account can't see full org membership) rather than a full roster. */
  partial?: boolean;
}

export interface AquiferDraftsResponse {
  ok: true;
  book: string;
  aqLang: string;
  approved: number;
  inserted: number;
  replaced: number;
  skippedApproved: number;
  report: {
    enRows: number;
    aqItems: number;
    matchedQuote: number;
    matchedOrdinal: number;
    matchedIntro: number;
    unmatched: number;
    flagged: number;
  };
}

export interface MeResponse {
  userId: number;
  username: string | null;
  role: Role | null;
  // Whether this account is a super-admin (SUPER_ADMINS env allowlist). The
  // `role` above collapses super-admin to "admin", so this is the only signal
  // that distinguishes the two client-side. Absent on an older/cached response
  // — callers treat that as "not a super-admin". See issue #241 / ObserveScreen.
  superAdmin?: boolean;
  // Persisted last-visited location. Used to restore the view after sign-in
  // (which round-trips through DCS OAuth and loses the URL hash).
  lastBook: string | null;
  lastChapter: number | null;
  lastVerse: number | null;
  // The server's active workspace slug for this session's be_ws cookie.
  // Absent on an older/cached response — callers treat that as "no reconciliation
  // needed" (see App.tsx boot reconciliation).
  workspace?: string;
  // Whether `workspace` is the FALLBACK workspace (first entry in WORKSPACES,
  // or the sole implicit "default" one) — see workspace.ts's
  // getWorkspaceIsFallback / outbox.ts's outboxDbName. Absent alongside
  // `workspace` on an older/cached response.
  workspaceIsFallback?: boolean;
  // Whether this deployment registers the nightly export cron (prod does; the
  // public dev worker does not — crons = []). Drives showing the 05:30 schedule
  // vs. a manual-exports notice (#240). Absent on older/cached responses →
  // treat as not enabled.
  nightlyExportsEnabled?: boolean;
}

// One org-per-D1 workspace the switcher can offer. For non-super-admins the
// server now OMITS workspaces the user may not enter (issue #93 — showing them
// disabled leaked other orgs' names), so every entry a non-super-admin receives
// is one they're allowed into and carries `allowed: true`. Super admins still
// receive every configured workspace, also all `allowed: true`. The flag is
// retained for the (now-defensive) disabled render path and forward
// compatibility.
export interface WorkspaceInfo {
  slug: string;
  label: string;
  org: string;
  allowed: boolean;
  // Whether this is the FALLBACK workspace (first entry in WORKSPACES, or the
  // sole implicit "default" one) — see workspace.ts's getWorkspaceIsFallback.
  isFallback: boolean;
}

export interface WorkspacesResponse {
  current: string;
  workspaces: WorkspaceInfo[];
  // Set when the server couldn't confirm Door43 org membership (no token, or
  // the DCS lookup failed) — the `allowed` flags may be stale/incomplete.
  membershipUnknown?: boolean;
}

export type AlertSeverity = "error" | "warning" | "info";

export interface SystemAlert {
  id: number;
  severity: AlertSeverity;
  message: string;
  linkUrl: string | null;
  createdAt: number;
}

// GET /api/alerts/me — undismissed banner alerts targeted at this user.
// Empty array when there's nothing to show. Used by the App-level banner
// stack rendered above the viewer alert.
export async function fetchAlerts(): Promise<SystemAlert[]> {
  try {
    const res = await request<{ alerts: SystemAlert[] }>(`/api/alerts/me`);
    return res.alerts;
  } catch (err) {
    if (err instanceof ApiError && err.status === 401) return [];
    throw err;
  }
}

// POST /api/alerts/:id/dismiss — sets dismissed_at = now so the row stops
// showing up in /api/alerts/me. Returns { ok, changed }; we don't surface
// `changed` to callers (dismissing an already-dismissed row is a no-op).
export async function dismissAlert(id: number): Promise<void> {
  await request<{ ok: true; changed: boolean }>(`/api/alerts/${id}/dismiss`, {
    method: "POST",
  });
}

// GET /api/auth/me — confirms the current cookie session's identity + role.
// Returns null on 401 (no cookie / expired) so callers can show the sign-in
// flow. Throws ApiError on other 4xx/5xx.
export async function fetchAuthMe(): Promise<MeResponse | null> {
  try {
    return await request<MeResponse>(`/api/auth/me`);
  } catch (err) {
    if (err instanceof ApiError && err.status === 401) return null;
    throw err;
  }
}

// POST /api/auth/logout — server-side: revokes the session row, clears
// cookies, best-effort revokes DCS token. Always succeeds from the client's
// perspective; failures don't block the UI.
export async function authLogout(): Promise<void> {
  try {
    await request<{ ok: true }>(`/api/auth/logout`, { method: "POST" });
  } catch {
    /* logout is best-effort — failure should never block the UI */
  }
}

// PUT /api/users/me/location — fire-and-forget; App.tsx debounces calls so
// we don't hammer D1 on every hashchange. Failures are silent — the URL hash
// is still the source of truth in-session; this is just for cross-session.
export async function updateLastLocation(
  book: string,
  chapter: number,
  verse: number,
): Promise<void> {
  try {
    await request<{ ok: true }>(`/api/users/me/location`, {
      method: "PUT",
      body: JSON.stringify({ book, chapter, verse }),
    });
  } catch {
    /* non-critical */
  }
}

// Dev-only sign-in. Sets the session cookies for `username`, creating a
// users row on first use. Only works while the worker has DEV_AUTH_ENABLED=
// true and a JWT_SIGNING_KEY configured. Returns the same shape as
// /api/auth/me so callers can skip a follow-up fetch.
export async function devSignIn(username = "dev"): Promise<MeResponse> {
  const res = await fetch(`/api/auth/dev`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username }),
    credentials: "include",
  });
  if (!res.ok) {
    let body: unknown = null;
    try {
      body = await res.json();
    } catch {
      /* ignore */
    }
    throw new ApiError(res.status, `HTTP ${res.status}`, body);
  }
  // A successful dev mint means we now hold a fresh access cookie — the same
  // condition change a silent refresh represents. Fire onAuthRefreshed so the
  // outbox revives parked ops AND any "session expired" banner raised by the
  // boot-time 401s (before this mint landed) clears. Without this the banner
  // stuck until a manual reload (issue #283).
  emitAuthRefreshed();
  return (await res.json()) as MeResponse;
}

export interface RowHistoryUser {
  id: number;
  username: string | null;
  full_name: string | null;
}

export interface RowHistoryEntry {
  version: number;
  // "imported" is synthesized server-side for rows that never had a real
  // `create` entry — the server fills it in from the current row state so
  // every row has a v1 anchor in its history.
  action: "create" | "update" | "delete" | "restore" | "imported";
  created_at: number;
  user: RowHistoryUser | null;
  // Just the fields that changed in this entry, intersected with the
  // kind-specific content fields the server tracks.
  patch: Record<string, unknown>;
  // The full reconstructed value of every content field at this version,
  // after this entry was applied.
  snapshot: Record<string, unknown>;
  synthetic: boolean;
  // Set when this entry was created by "switch to v{N}" from the history
  // dialog. The snapshot is identical to v{N}'s, so the UI hides these
  // phantom entries and surfaces the restored version as current instead.
  restored_from_version: number | null;
}

export interface RowHistory {
  versions: RowHistoryEntry[];
}

export interface VerseHistoryEntry {
  version: number;
  // 'create' | 'update' | 'baseline' (pre-AI capture) | 'imported' (synthetic
  // anchor for an unedited verse with no log entry).
  action: string;
  // edit_log.source: 'ai_pipeline' | 'dcs_reimport' | 'hint_expansion' | null.
  source: string | null;
  created_at: number;
  user: RowHistoryUser | null;
  plain_text: string | null;
  // Full verse-objects tree at this version, or null when only plain_text was
  // logged (older AI / re-import entries). null ⇒ not restorable.
  content: unknown | null;
  restorable: boolean;
  current: boolean;
}

export interface VerseHistory {
  versions: VerseHistoryEntry[];
}

// One sibling article in a disambiguation group: the full tw_link + its
// human heading (the synonym line that tells the alternatives apart).
export interface DisambiguationOption {
  link: string;
  title: string;
}

export interface Catalogs {
  supportReferences: string[];
  twLinks: string[];
  // Articles that share a word with at least one sibling, grouped. `Index`
  // maps a committed tw_link to its group in `Groups`. Optional so a cached
  // pre-feature payload still validates.
  disambiguationGroups?: DisambiguationOption[][];
  disambiguationIndex?: Record<string, number>;
}

// One per-verse TWL suggestion from GET /api/twl-suggestions/:book/:ch/:v.
// Mirrors api/src/twlSuggest.ts TwlSuggestion.
export interface TwlSuggestion {
  matchedText: string;
  glOccurrence: number;
  articleId: string;
  twLink: string;
  tag: string;
  disambiguation: string[];
}

// TWL suggestion deny-lists from GET /api/twl-filters/:book. Mirrors
// api/src/twlFilters.ts. `unlinked` is global (word+article never linked);
// `deleted` is this book's deleted reference+quote pairs (article-agnostic).
export interface TwlFiltersResponse {
  unlinked: { normOrigWords: string; twLink: string }[];
  deleted: { reference: string; normOrigWords: string }[];
}

// One curated note template for a support reference. `type` is the variant
// label from the sheet ("generic", "plural", …); empty string is the default
// unnamed variant.
export interface NoteTemplate {
  type: string;
  body: string;
}

// Curated note templates keyed by short support reference (e.g. "figs-metaphor"),
// each an ordered list of variants. Sourced from a Google Sheet, edge-cached.
export interface NoteTemplatesResponse {
  templates: Record<string, NoteTemplate[]>;
}

export interface BookListEntry {
  book: string;
  imported_at: number;
}

// One per-book / per-chapter-range resource source override (api/src/bookSource.ts).
// A whole-book override uses chapter_start=0, chapter_end=999; a range override
// carries its real [start, end] bounds. Only "tn" and "tq" are overridable.
// `kind` discriminates a DCS org/repo source from an Aquifer source (tN-only; for
// Aquifer, org is the "aquifer" sentinel and repo holds the aqLang, e.g. "arb").
export interface BookSourceOverride {
  resource: "tn" | "tq";
  chapter_start: number;
  chapter_end: number;
  kind: "dcs" | "aquifer";
  org: string;
  repo: string;
  updated_at: number;
}

// Mirrors api/src/bookReimport.ts. Counts of rows/verses touched per
// resource by a single POST /api/books/:book/reimport call.
export type ReimportResource = "ult" | "ust" | "tn" | "tq" | "twl";

export interface ReimportCounts {
  updated: number;
  // AI-generated rows (written by the AI pipeline, never human-edited) that were
  // refreshed from master and returned to master-owned. Tracked apart from
  // `updated` so the UI reports them as refreshed, not "skipped (already edited)".
  // Optional: the server always sends it, but an older/cached response may omit it.
  reimported_ai?: number;
  inserted: number;
  skipped_edited: number;
  skipped_locked: number;
  skipped_noop: number;
  // Edited verses whose source-owned `\zaln-s` attrs (x-content/x-lemma/x-morph)
  // were reconciled from master (translator's target text + grouping preserved).
  // Optional: the server always sends it, but an older/cached response may omit it.
  source_attr_reconciled?: number;
  dcs_404: number;
  errors: string[];
}

export interface ReimportResponse {
  ok: true;
  book: string;
  perResource: Record<ReimportResource, ReimportCounts>;
  totals: ReimportCounts;
}

// Error bodies for the admin-only `force` re-import (POST
// /api/books/:book/import with { force: true }). 403 when the caller is not an
// admin; 409 when the book carries local note/question edits and the request
// did not also set `confirmDiscardEdits`.
export interface ImportHasLocalEditsBody {
  error: "has_local_edits";
  book: string;
  tn: number;
  tq: number;
  twl: number;
  verses: number;
}

// Display form of the import response's note-source provenance: the stored
// value is `source:<owner>/<repo>` (see SOURCE_PROVENANCE_PREFIX in the API);
// the prefix is a storage detail, not something to show a translator.
export function importedSourceRepos(sources?: { tn: string | null; tq: string | null }): string[] {
  return [...new Set(
    [sources?.tn, sources?.tq].filter((s): s is string => !!s).map((s) => s.replace(/^source:/, "")),
  )];
}

// Translation-note AI draft endpoint (proxied through this Worker; the
// shared bot lives at uw-bt-bot.fly.dev). Schema is the bot's; keep in
// sync with its zod definition. The Worker adds the BT_API_TOKEN bearer
// AND injects contextRef/targetLang/direction server-side (derived from
// the project config, never from client input — see api/src/tnQuick.ts),
// so types live on this side but the wire body isn't a pure pass-through.
export interface TnQuickRequest {
  ref: {
    book: string;
    chapter: number;
    verse: number;
  };
  issueType: string;
  ult: {
    selection: string;
    verse: string;
    context: { prev5: string[]; next5: string[] };
  };
  ust: {
    selection: string;
    verse: string;
    context: { prev5: string[]; next5: string[] };
  };
  hebrewGuess: string;
  model?: "sonnet" | "opus";
}

export interface TnQuickResponse {
  quote: string;
  note: string;
  warnings: string[];
}

// ── AI pipeline (chapter-scale) — see docs/ai-pipeline-integration.md ──────
// Types mirror the bp-assistant client-side contract; both sides change
// together if the contract is revised.

export type PipelineType = "generate" | "notes" | "tqs" | "translate";

// Translate-pipeline overrides (only meaningful when pipelineType ===
// 'translate'). The server derives the full option set from the active project
// config (buildTranslateOptions) and folds these in; all optional. rowIds
// scopes a single-note / subset translate (INTEGRATION.md §0).
export interface TranslateRequestOptions {
  // Which resource to translate. Row-keyed TSV: 'tn' (default) | 'tq' (book +
  // startChapter scope). Markdown article: 'tw' | 'ta' (articleId/articleUrl
  // scope, no book/chapter). The server picks the matching source repo.
  resourceType?: "tn" | "tq" | "tw" | "ta";
  // Article selector (tw|ta only) — exactly one. articleId is a name
  // ('kt/god', 'translate/figs-aside'); articleUrl a git.door43.org URL.
  articleId?: string;
  articleUrl?: string;
  model?: "sonnet" | "opus";
  delivery?: "path" | "branch";
  branchOnly?: boolean;
  direction?: "ltr" | "rtl";
  rowIds?: string[];
  verseStart?: number;
  verseEnd?: number;
  targetLang?: string;
  targetOrg?: string;
  sourceRef?: string;
  contextRef?: string;
  literalRef?: string;
  simplifiedRef?: string;
}

// tW / tA markdown article file (article_units). Keyed by (resource, path).
export interface ArticleUnit {
  resource: "tw" | "ta";
  path: string;
  article_id: string;
  part: "body" | "title" | "sub-title";
  source_md: string;
  source_sha: string | null;
  target_md: string | null;
  translation_state?: "ai_draft" | "edited" | "validated" | null;
  draft_meta_json?: string | null;
  version: number;
  updated_by: number | null;
  updated_at: number;
  deleted_at: number | null;
  latest_source?: string | null;
}

// ── UI localization overrides (migration 0052) ──
// A nested {namespace:{key:"text"}} bag mirroring the i18next resource shape.
export type L10nBag = { [k: string]: string | L10nBag };

// ── Translation preferences & memory (migration 0040) ──
export const TERM_STATUSES = ["preferred", "admitted", "deprecated", "forbidden", "do_not_translate"] as const;
export type TermStatus = (typeof TERM_STATUSES)[number];
export const REGISTERS = ["default", "formal", "informal"] as const;
export type Register = (typeof REGISTERS)[number];

export interface TranslationPrefs {
  id: number;
  audience: string | null;
  purpose: string | null;
  register: Register;
  script_notes: string | null;
  instructions_md: string | null;
  common_issues_md: string | null;
  notes: string | null;
  assisted_mode: 0 | 1;
  version: number;
  updated_at: number;
  updated_by: number | null;
}
export type TranslationPrefsInput = {
  audience: string | null;
  purpose: string | null;
  register: Register;
  script_notes: string | null;
  instructions_md: string | null;
  common_issues_md: string | null;
  notes: string | null;
  // assisted_mode removed: the server injects contextRef whenever a successful
  // context export exists — there is no client-settable gate any more.
};

// ── Org-wide AI provider config (migration 0065; api/src/aiProvider.ts) ──
export interface AiProviderCatalog {
  providers: readonly string[];
  models: Record<string, readonly string[]>;
}
export interface AiProviderSettings {
  provider: string;
  model: string | null;
  // A BYO key is stored and in force for `provider`. Never true for 'default'.
  configured: boolean;
  // Last 4 chars of the stored key, for "Configured •••• {{hint}}" display.
  // The plaintext key never leaves the server after the PUT that set it.
  keyHint: string | null;
  version: number;
  // False when AI_KEY_WRAPPING_KEY isn't set on this deployment — BYO keys
  // can't be encrypted, so key entry must be disabled.
  encryptionAvailable: boolean;
  catalog: AiProviderCatalog;
}
export type AiProviderInput =
  | { provider: "default" }
  | { provider: string; model: string; apiKey?: string };

export interface ContextExportStatus {
  status: string;
  sha: string | null;
  completedAt: number | null;
  terms: number;
  examplesTn: number;
  examplesTq: number;
  contentFiles: number;
  totalBytes: number;
  owner: string | null;
  failureReason: string | null;
}

export interface Term {
  id: number;
  concept_id: string;
  source_term: string;
  target_term: string | null;
  status: TermStatus;
  replacement: string | null;
  comment: string | null;
  tw_link: string | null;
  source_status: string;
  version: number;
  created_at: number;
  updated_at: number;
  updated_by: number | null;
}
export type TermInput = {
  concept_id: string;
  source_term: string;
  target_term?: string | null;
  status?: TermStatus;
  replacement?: string | null;
  comment?: string | null;
  tw_link?: string | null;
};
export interface TermImportResult {
  dryRun: boolean;
  added: number;
  updated: number;
  total: number;
  parseErrors: { line: number; message: string }[];
  // Non-fatal per-line notices — currently genuine duplicate rows (same
  // concept_id + source_term + target_term + status) that would silently
  // overwrite each other. Optional so the client typechecks against a Worker
  // that hasn't shipped the field yet.
  parseWarnings?: { line: number; message: string }[];
}
export interface TranslationExample {
  id: string;
  book: string;
  ref_raw: string;
  support_reference?: string | null;
  quote: string | null;
  occurrence: number | null;
  note?: string | null;
  question?: string | null;
  response?: string | null;
  translation_state: string;
  updated_at: number;
}

// Lightweight rail item (source_md/target_md excluded server-side for weight).
export interface ArticleUnitMeta {
  resource: "tw" | "ta";
  path: string;
  article_id: string;
  part: "body" | "title" | "sub-title";
  source_sha: string | null;
  translation_state: "ai_draft" | "edited" | "validated" | null;
  version: number;
  updated_at: number;
  has_target: 0 | 1;
  latest_source?: string | null;
}

// ── Note templates (migration 0054) ──
// A single translatable note-template unit. Mirrors ArticleUnit, but a template
// is one indivisible markdown body (no title/sub-title parts): source_md is the
// English sheet text (column C), target_md is the translation (NULL = not
// started).
export interface TemplateUnit {
  template_id: string;
  support_ref: string;
  sheet_order: number | null;
  type: string | null;
  source_md: string;
  source_hash: string;
  origin: string;
  target_md: string | null;
  translation_state: "ai_draft" | "edited" | "validated" | null;
  draft_meta_json: string | null;
  pre_draft_json?: string | null;
  version: number;
  updated_by: number | null;
  updated_at: number;
  deleted_at: number | null;
  latest_source?: string | null;
}

// Lightweight rail item (source_md/target_md excluded server-side for weight).
export interface TemplateUnitMeta {
  template_id: string;
  support_ref: string;
  type: string | null;
  sheet_order: number | null;
  origin: string;
  has_target: 0 | 1;
  translation_state: "ai_draft" | "edited" | "validated" | null;
  version: number;
  // 1 when a source change demoted the draft and the target is now stale.
  stale_source: 0 | 1;
}

// One English-source revision (newest first).
export interface TemplateSourceRevision {
  source_hash: string;
  source_md: string;
  seen_at: number;
}

// Target-side history entry — the same word-diff-ready shape RowHistoryEntry
// uses, narrowed to the single `target_md` content field.
export interface TemplateHistoryEntry {
  version: number;
  action: string;
  created_at: number;
  user: RowHistoryUser | null;
  patch: { target_md?: string | null };
  snapshot: { target_md: string | null };
  synthetic: boolean;
  restored_from_version: number | null;
}

export interface TemplateHistory {
  source: TemplateSourceRevision[];
  target: TemplateHistoryEntry[];
}

export type PipelineState =
  // queued: accepted by us, not yet sent to the bot (cancellable).
  // dispatching: claimed the single bot slot; upstream POST in flight.
  // cancelled: a queued job the user withdrew (terminal).
  | "queued"
  | "dispatching"
  | "running"
  | "paused_for_outage"
  | "paused_for_usage_limit"
  | "failed"
  | "cancelled"
  | "done";

export type PipelineErrorKind =
  // Fly bot kinds (docs/ai-pipeline-integration.md §3).
  | "transient_outage"
  | "auth_error"
  | "usage_limit"
  | "sdk_error"
  | "non_success_result"
  | "missing_output"
  | "stale_output"
  | "interrupted"
  | "import_failed"
  // Internal translate-runner kinds (#445): api/src/translate/llm.ts
  // RETRYABLE_CODES / NON_RETRYABLE_CODES plus workflowSteps.ts. Listed here so
  // ERROR_COPY_KEY in AiScreen.tsx is exhaustive — a new runner code without
  // copy is a typecheck error, not a silent "Unrecognized error" fallback (#471).
  | "rate_limited"
  | "provider_overloaded"
  | "timeout"
  | "network_error"
  | "invalid_key"
  | "model_not_found"
  | "context_too_long"
  | "output_too_long"
  | "empty_output"
  | "provider_error"
  | "provider_not_supported_internal"
  | "resource_not_supported_internal"
  | "checks_failed"
  | "internal_error_after_call"
  | "internal_error";

// Mirrors the bp-assistant contract (docs/ai-pipeline-integration.md §3).
// Server validates with .strict(); unknown keys are rejected. Per-pipeline-type
// flag mixing (e.g. contentTypes on a "notes" run) is also rejected.
export interface PipelineRequestOptions {
  model?: "sonnet" | "opus";
  /** Clear prior checkpoint + outputs. Useful for retrying a failed run. */
  fresh?: boolean;

  // -- generate-only --
  /** Restrict to a subset of content types. Default is both. */
  contentTypes?: ("ult" | "ust")[];
  /** Skip alignment + repo-insert; USFM is NOT pushed to Door43. */
  noAlign?: boolean;
  /** Reuse already-generated USFM and only run alignment + repo-insert. */
  alignOnly?: boolean;
  /** Push the unaligned USFM to Door43 (no alignment performed). */
  textOnly?: boolean;

  // -- notes-only --
  /** Skip the chapter intro generation step. */
  noIntro?: boolean;
  /** Pause before generating Alternate Translations so a human can review. */
  pauseBeforeATs?: boolean;
}

export interface PipelineChainStep {
  pipelineType: PipelineType;
  options?: PipelineRequestOptions;
}

export interface PipelineStartRequest {
  pipelineType: PipelineType;
  // Optional for article translate jobs (tw/ta), which are scoped by
  // translate.articleId, not book/chapter. Row-keyed jobs (generate/notes/
  // tqs and tn/tq translate) still pass both.
  book?: string;
  startChapter?: number;
  endChapter?: number;
  sessionKey: string;
  options?: PipelineRequestOptions;
  /**
   * Translate-pipeline overrides (only meaningful when pipelineType ===
   * 'translate'; ignored otherwise). The server builds the full option set
   * from the active project config and folds these in.
   */
  translate?: TranslateRequestOptions;
  /**
   * Optional second pipeline to fire on the parent's done-transition. Used
   * to express asymmetric ULT/UST alignment (e.g. ULT aligned + UST text-
   * only) since the upstream contract can't carry asymmetric align flags
   * in one call. Same scope and pipelineType — only the options differ.
   * Mutually exclusive with followUpChain.
   */
  followUpOptions?: PipelineRequestOptions;
  /**
   * Cross-type follow-up chain. First entry fires on the parent's done-
   * transition; the rest is stored on the child and fires in turn. Used by
   * the chapter macro to chain generate -> notes -> tqs without leaving the
   * chapter unlocked between steps. Mutually exclusive with followUpOptions.
   */
  followUpChain?: PipelineChainStep[];
}

export interface PipelineStartResponse {
  jobId: string;
  scope: { book: string; startChapter: number; endChapter: number };
  status: "running" | "queued" | "already_running";
  /** 1-based position in the global queue when status === "queued". */
  queuePosition?: number;
}

export interface PipelineOutput {
  type: "ult" | "ust" | "tn" | "tq";
  repo: string;
  branch: string;
  path: string;
  rawUrl: string;
  prNumber: number;
  mergedAt: string;
  commitSha: string;
}

export interface PipelineStatusResponse {
  jobId: string;
  pipelineType: PipelineType;
  scope: { book: string; startChapter: number; endChapter: number };
  state: PipelineState;
  current?: {
    chapter: number;
    skill: string;
    status: "running" | "succeeded" | "failed" | "skipped_complete";
    startedAt: string;
    errorKind?: PipelineErrorKind;
    error?: string;
  };
  updatedAt: string;
  createdAt: string;
  interrupted?: boolean;
  output?: PipelineOutput[];
  /**
   * Present on queued/dispatching jobs (which aren't on the bot yet): the
   * Worker synthesizes the status from D1 and includes the live queue
   * position so the chip can show "#N in line" and refresh it each poll.
   */
  queuePosition?: number;
  queueAhead?: number;
}

// AI pipeline proposal staged in pending_imports. The server parses payload
// from TEXT into a JSON object so clients don't repeat that work. Phase 2b
// renders these as a placeholder list; Phase 2c is the real diff UI.
export interface PendingImport {
  id: number;
  jobId: string;
  kind: "tn" | "tq" | "verse";
  book: string;
  chapter: number;
  verse: number;
  bibleVersion: string | null;
  payload: unknown;
  createdAt: number;
  pipelineType: PipelineType;
  startedByUsername: string | null;
}

// Row shape returned by GET /api/pipelines (list). Columns are snake_case —
// this is the persisted D1 row, not the live upstream response shape.
export interface PipelineJobRow {
  job_id: string;
  /**
   * The bot's opaque jobId, assigned on dispatch. NULL while queued/dispatching.
   * job_id (our local UUID) is the stable identity the client keys on — it
   * never changes as a job moves queued → running → done.
   */
  upstream_job_id: string | null;
  user_id: number;
  pipeline_type: PipelineType;
  book: string;
  start_chapter: number;
  end_chapter: number;
  session_key: string;
  state: PipelineState;
  /** Follow-up / macro-chain children get priority=1 so they jump the queue. */
  priority: number;
  /** 1-based global queue position; set by the list/status endpoints for queued jobs. */
  queue_position?: number | null;
  /** How many jobs run before this one (active + higher-ranked queued). */
  queue_ahead?: number | null;
  current_skill: string | null;
  current_status: string | null;
  error_kind: PipelineErrorKind | null;
  error_message: string | null;
  output_json: string | null;
  /**
   * Set on a parent row once its asymmetric-alignment follow-up has been
   * spawned. Lets the UI render a "follow-up: jobX" line on the parent and
   * the reciprocal "after: jobY" line on the child (whose row matches this
   * column elsewhere in the list).
   */
  follow_up_job_id: string | null;
  created_at: number;
  updated_at: number;
  last_polled_at: number | null;
  /**
   * Set the first time the browser surfaces a "completed-while-away" toast
   * for this job (via POST /api/pipelines/:id/notified). Null on jobs the
   * user hasn't yet been told about — those drive the toast.
   */
  notified_user_at: number | null;
  /**
   * DCS username of whoever requested the run. Populated on the shared-queue
   * list for jobs that aren't the current user's, so the chip can attribute
   * them ("requested by X"). Undefined/null on the current user's own rows.
   */
  started_by_username?: string | null;
}

// Global queue context returned alongside GET /api/pipelines so the chip can
// render "what's running ahead of you". activeJob reuses the conflict-dialog
// shape (it's the single job currently on the bot, or null when idle).
export interface PipelineQueueSummary {
  activeJob: PipelineConflictExisting | null;
  queuedCount: number;
}

// Resource scope for POST /api/exports/run — an admin-chosen slice of the
// nightly export, not tied to a particular book (chapter scoping additionally
// requires book + one of tn/tq/twl; see AdminWorkflowScreen.tsx).
export type ExportRunResource = "tn" | "tq" | "twl" | "ult" | "ust";

// One row from GET /api/exports — a nightly (or manual) export snapshot.
// Mirrors the SELECT in api/src/exports.ts's GET / handler field-for-field.
export interface ExportSnapshot {
  id: number;
  book: string;
  resource: string;
  branch: string | null;
  commit_sha: string | null;
  committed_at: number;
  rows_exported: number;
  error: string | null;
  pr_number: number | null;
  pr_error: string | null;
  // Chapter-scoped export descriptor ("13" or "13-14"); null for a whole-book
  // (or whole-project) export. See api/src/exports.ts's chapterStart/chapterEnd
  // handling on POST /api/exports/run.
  chapters: string | null;
  // Server-derived Door43 web URL for pr_number (api/src/exportPrUrl.ts) —
  // resolved from the CURRENT export destination config, absent/null when the
  // destination can't be resolved or on an older API build. Fall back to
  // plain "PR #n" text when missing.
  prUrl?: string | null;
}

// Per-project source configuration (api/src/projectConfig.ts). Drives UI
// labels, direction, the language-pair switcher, and — via translationSource —
// whether translation-mode UI is shown at all. The English root project has
// translationSource === null.
export interface GlBiblePane {
  repo: string;
  version: string;
  title: string;
}
export interface LanePublicState {
  lane: "lit" | "sim";
  activeGeneration: number;
  configRevision: number;
  replacementJobId: string | null;
  exportsBlocked: boolean;
  replacementRequired: boolean;
  // True when this lane already has verses (from getProjectConfig's overlay). The
  // Setup wizard locks a populated lane's source so it can't propose a change.
  populated?: boolean;
  config: {
    label: string;
    source: { owner: string; repo: string; ref: string };
    export: { owner: string; repo: string; baseRef: string; branchPolicy: string } | null;
    textReadOnly: boolean;
    alignmentWritable: boolean;
  };
  pendingTarget: LanePublicState["config"] | null;
}

// WS event fired when a scripture lane freezes for a replacement (source swap)
// or the replacement settles. Mirrors api/src/wsEvents.ts. Open tabs use these
// to quarantine queued edits and refresh once the generation flips.
export interface LaneReplacementEvent {
  lane: "lit" | "sim";
  jobId: string;
  predecessorGeneration: number;
  activeGeneration: number;
  configRevision: number;
  status: string;
}

// Replacement job + per-book staging state. Mirrors the D1 rows returned by
// GET /api/project-config/lanes/:lane/replacements/:jobId.
export type LaneReplacementStatus =
  | "reserved"
  | "staging"
  | "ready"
  | "completed"
  | "failed"
  | "cancelled";

export interface LaneReplacementJob {
  job_id: string;
  lane: "lit" | "sim";
  generation: number;
  predecessor_generation: number;
  status: LaneReplacementStatus;
  error_json: string | null;
  created_at: number;
  completed_at: number | null;
}

export interface LaneReplacementBook {
  job_id: string;
  book: string;
  // pending | artifact_ok | retryable_error | absent_authorized | failed
  status: string;
  source_sha: string | null;
  completeness_json: string | null;
  error_json: string | null;
  updated_at: number;
}

export interface LaneReplacementJobResponse {
  job: LaneReplacementJob;
  books: LaneReplacementBook[];
}

export interface ProjectConfig {
  preset: string;
  org: string;
  exportOrg: string;
  languageCode: string;
  languageName: string;
  languageTitle: string;
  direction: "ltr" | "rtl";
  repos: Record<string, string>;
  litLabel: string;
  simLabel: string;
  origHebrewLabel: string;
  origGreekLabel: string;
  glBibles: GlBiblePane[];
  translationSource: {
    org: string;
    languageCode: string;
    // Per-resource value is a bare repo string (org = `org` above) OR an
    // { org?, repo } ref pointing the resource at a different org. PARTIAL: an
    // absent role has no upstream source. Read via lib/sourceRef.resolveSourceRef,
    // never directly.
    repos: Record<string, string | { org?: string; repo: string }>;
  } | null;
  // Explicit editor/translator workflow mode (always materialized concrete by
  // the server; derives from translationSource when no override is set).
  mode: "authoring" | "translation";
  reposVerified: boolean;
  laneState?: {
    lit: LanePublicState;
    sim: LanePublicState;
  };
}
export interface ProjectConfigResponse {
  config: ProjectConfig;
  // Server-shipped built-in layout defaults (flexible-layouts). Optional so an
  // older server (or the localStorage cache, which stores only `config`) makes
  // the client fall back to its bundled built-ins. Validated against the panel
  // registry before use — a drifted/invalid spec is dropped, never fatal.
  layouts?: LayoutSpec[];
}

// PR B: draft-only manifest inference response — applies nothing.
export interface InferredOrgProposal {
  languageCode: string | null;
  languageName: string | null;
  languageTitle: string | null;
  direction: "ltr" | "rtl";
  repos: Partial<Record<string, string>>; // verified roles only
  litLabel: string | null;
  simLabel: string | null;
  suggestedTranslationSource: "UW_SOURCE";
  suggestedExportOrg: string;
}
export interface InferredOrgAmbiguousRole {
  role: "lit" | "sim";
  candidates: string[];
}
export interface InferredOrgConfigResponse {
  org: string;
  proposal: InferredOrgProposal;
  missing: string[];
  ambiguous: InferredOrgAmbiguousRole[];
  manifestFound: boolean;
  warnings: string[];
}

export const api = {
  getBookSummary: (book: string, signal?: AbortSignal) =>
    request<BookSummary>(`/api/chapters/${encodeURIComponent(book)}`, { signal }),

  getChapter: (book: string, chapter: number, signal?: AbortSignal) =>
    request<ChapterPayload>(
      `/api/chapters/${encodeURIComponent(book)}/${chapter}`,
      { signal },
    ),

  // DCS-validation summary for a book (issues that need a human decision).
  // Book-level, fetched once per book change by useBookLint.
  getBookLint: (book: string, signal?: AbortSignal) =>
    request<BookLintReport>(`/api/books/${encodeURIComponent(book)}/lint`, { signal }),

  getCatalogs: () => request<Catalogs>(`/api/catalogs`),

  // Per-verse TWL suggestions (links the verse doesn't already carry). The
  // server scans the ULT with the en_tw headword matcher; the client resolves
  // each match's English span to an OL quote + occurrence via twlResolve.
  getTwlSuggestions: (book: string, chapter: number, verse: number, signal?: AbortSignal) =>
    request<{ suggestions: TwlSuggestion[] }>(
      `/api/twl-suggestions/${encodeURIComponent(book)}/${chapter}/${verse}`,
      { signal },
    ),

  // TWL suggestion deny-lists for a book (global unlinked word+article pairs +
  // this book's deleted reference+quotes). Fetched once per book change by
  // useTwlFilters; the client folds + compares against resolved OL quotes.
  getTwlFilters: (book: string, signal?: AbortSignal) =>
    request<TwlFiltersResponse>(`/api/twl-filters/${encodeURIComponent(book)}`, { signal }),

  getNoteTemplates: () => request<NoteTemplatesResponse>(`/api/note-templates`),

  // Active per-project source config (org/language/direction/labels +
  // translationSource). Readable by any authenticated user; drives the
  // translation-mode UI gate. Fetched once per session by useProjectConfig.
  getProjectConfig: () => request<ProjectConfigResponse>(`/api/project-config`),
  // PR B: apply a full override set (custom-gl activation, or any explicit
  // org/repo/translationSource change). Always supplies `overrides`
  // explicitly — the server's override-lifecycle rule only preserves stored
  // overrides when the field is OMITTED.
  putProjectConfigWithOverrides: (preset: string, overrides: Record<string, unknown> | null) =>
    request<{ config: ProjectConfig }>(`/api/project-config`, {
      method: "PUT",
      body: JSON.stringify({ preset, overrides }),
    }),
  // Toggle the editor/translator mode only (admin). Independent of the preset;
  // the server merges the `mode` override into overrides_json — identity-
  // preserving, so it succeeds even on a populated DB.
  patchProjectMode: (mode: "authoring" | "translation") =>
    request<{ config: ProjectConfig }>(`/api/project-config/mode`, {
      method: "PATCH",
      body: JSON.stringify({ mode }),
    }),

  // PR B: draft-only manifest inference for a Door43 org. Applies nothing.
  getInferredOrgConfig: (org: string) =>
    request<InferredOrgConfigResponse>(`/api/orgs/${encodeURIComponent(org)}/inferred-config`),

  // Resolve a pasted Door43 source URL (or bare owner/repo) into a verified
  // { org, repo } for the Setup wizard's per-resource source override. On a 2xx
  // the repo is confirmed to exist on DCS. Throws ApiError on 400 (garbage /
  // unsupported host), 404 (repo_not_found), or 503 (dcs_unavailable — transient,
  // NOT a real "does not exist"); callers classify via lib/setupWizard.verifyErrorKind.
  // `checkBooks` additionally verifies the repo CONTAINS USFM book files (a
  // scripture lane source that only has scaffolding is a trap). `hasBooks` is
  // present only when checked and the content lookup succeeded; a transient
  // contents-API failure OMITS it (treat missing as "couldn't check", not empty).
  verifySource: (url: string, opts?: { checkBooks?: boolean }) =>
    request<{ ok: true; org: string; repo: string; fullName?: string; hasBooks?: boolean }>(
      `/api/orgs/verify-source?url=${encodeURIComponent(url)}${opts?.checkBooks ? "&checkBooks=1" : ""}`,
    ),

  // Per-book resource source overrides (issue #103). Whole-book override rows
  // come back as (chapter_start=0, chapter_end=999); range rows carry their real
  // bounds. Readable by any authenticated user; the PUT below is admin-only.
  getBookSources: (book: string) =>
    request<{ book: string; overrides: BookSourceOverride[] }>(
      `/api/books/${encodeURIComponent(book)}/sources`,
    ),

  // Set an override (admin only; non-admins get 403). For a DCS source, pass a
  // verified org+repo (verify it first with verifySource). Both chapterStart and
  // chapterEnd together set a range; omitting both sets the whole book. A range
  // that overlaps an existing one answers 409 { error: "overlapping_range" }.
  // For Aquifer, pass kind:"aquifer" with a chapter range (tN only; the aqLang is
  // derived server-side from the project language — no url/org/repo, no verify).
  setBookSource: (
    book: string,
    body: {
      resource: "tn" | "tq";
      kind?: "aquifer";
      url?: string;
      org?: string;
      repo?: string;
      chapterStart?: number;
      chapterEnd?: number;
    },
  ) =>
    request<{ ok: true }>(`/api/books/${encodeURIComponent(book)}/sources`, {
      method: "PUT",
      body: JSON.stringify(body),
    }),

  // Clear one range (pass chapterStart) or a whole resource's overrides (omit
  // chapterStart). Admin only. Same PUT endpoint, distinguished by `clear`.
  clearBookSource: (
    book: string,
    body: { resource: "tn" | "tq"; chapterStart?: number },
  ) =>
    request<{ ok: true }>(`/api/books/${encodeURIComponent(book)}/sources`, {
      method: "PUT",
      body: JSON.stringify({ ...body, clear: true }),
    }),

  getBooks: () => request<{ books: BookListEntry[] }>(`/api/books`),

  // Trigger a server-side import of a book from DCS. Long-running: ~5-60s
  // depending on book size, so the caller gets a wider timeout.
  // `translateFromSource` pulls tN/tQ from the project's configured English
  // source repos instead of the org's own; `sources` reports which resources
  // actually came from the source (also set when the server falls back on its
  // own because the org's file is missing), e.g. "source:unfoldingWord/en_tn".
  // `force` (admin-only) bypasses the already-imported short-circuit and does a
  // full wipe-and-reload; the server answers 403 `forbidden` for non-admins and
  // 409 `has_local_edits` (with tn/tq/twl/verses counts) unless `confirmDiscardEdits`
  // is also set. See ImportHasLocalEditsBody for those bodies.
  importBook: (
    book: string,
    opts?: { translateFromSource?: boolean; force?: boolean; confirmDiscardEdits?: boolean },
  ) => {
    const body: Record<string, true> = {};
    if (opts?.translateFromSource) body.translateFromSource = true;
    if (opts?.force) body.force = true;
    if (opts?.confirmDiscardEdits) body.confirmDiscardEdits = true;
    return request<{
      ok: true;
      book: string;
      alreadyImported?: boolean;
      forced?: boolean;
      verses?: number;
      tn?: number;
      tq?: number;
      twl?: number;
      fetched?: { ult: boolean; ust: boolean; orig: boolean; tn: boolean; tq: boolean; twl: boolean };
      sources?: { tn: string | null; tq: string | null };
    }>(`/api/books/${encodeURIComponent(book)}/import`, {
      method: "POST",
      timeoutMs: 120_000,
      ...(Object.keys(body).length ? { body: JSON.stringify(body) } : {}),
    });
  },

  // Non-destructive per-chapter, per-resource re-import from Door43. Only
  // overwrites rows that have never been touched by a human; counts are
  // returned per-resource so the dialog can summarize what changed vs. was
  // skipped. Server-side: api/src/bookReimport.ts.
  reimportFromDoor43: (
    book: string,
    body: { chapters: number[]; resources: ReimportResource[] },
  ) =>
    request<ReimportResponse>(
      `/api/books/${encodeURIComponent(book)}/reimport`,
      {
        method: "POST",
        body: JSON.stringify(body),
        timeoutMs: 120_000,
      },
    ),

  setVerseDone: (book: string, chapter: number, verse: number, done: boolean) =>
    request<VerseStatus>(
      `/api/chapters/${encodeURIComponent(book)}/${chapter}/${verse}/status`,
      { method: "PATCH", body: JSON.stringify({ done }) },
    ),

  // Toggle my checkoff stamp on one (verse, lane). Returns the full checker set.
  setLaneCheck: (book: string, chapter: number, verse: number, lane: CheckLane, checked: boolean) =>
    request<LaneCheckState>(
      `/api/chapters/${encodeURIComponent(book)}/${chapter}/${verse}/lanes/${lane}`,
      { method: "PATCH", body: JSON.stringify({ checked }) },
    ),

  // Bulk "I'm done with <lane> for the chapter": apply across the given verses
  // (client supplies the applicable list). Returns the chapter+lane check set.
  setLaneCheckBulk: (book: string, chapter: number, lane: CheckLane, checked: boolean, verses: number[]) =>
    request<{ book: string; chapter: number; lane: CheckLane; checks: VerseLaneCheck[] }>(
      `/api/chapters/${encodeURIComponent(book)}/${chapter}/lanes/${lane}/bulk`,
      { method: "PATCH", body: JSON.stringify({ checked, verses }) },
    ),

  createRow: <T = unknown>(kind: RowKind, body: Record<string, unknown>) =>
    request<T>(`/api/rows/${kind}`, {
      method: "POST",
      body: JSON.stringify(body),
    }),

  // book is required after the composite-(book, id) PK migration (0015);
  // the server returns 400 if it's missing because the same 4-char id can
  // exist in two books with different content.
  getRowHistory: (kind: RowKind, id: string, book: string) =>
    request<RowHistory>(
      `/api/rows/${kind}/${encodeURIComponent(id)}/history?book=${encodeURIComponent(book)}`,
    ),

  patchRow: <T = unknown>(
    kind: RowKind,
    id: string,
    expectedVersion: number,
    patch: Record<string, unknown>,
    opts: { restoredFromVersion?: number | null; book: string },
  ) =>
    request<T>(`/api/rows/${kind}/${encodeURIComponent(id)}?book=${encodeURIComponent(opts.book)}`, {
      method: "PATCH",
      headers: { "If-Match": String(expectedVersion) },
      body: JSON.stringify(
        typeof opts.restoredFromVersion === "number"
          ? { ...patch, restored_from_version: opts.restoredFromVersion }
          : patch,
      ),
    }),

  deleteRow: (kind: RowKind, id: string, expectedVersion: number, book: string) =>
    request<{ ok: true }>(`/api/rows/${kind}/${encodeURIComponent(id)}?book=${encodeURIComponent(book)}`, {
      method: "DELETE",
      headers: { "If-Match": String(expectedVersion) },
    }),

  // Legacy: alias for setPreserveNote(id, true). Server still accepts it for
  // any in-flight outbox ops; new code should call setPreserveNote.
  keepNote: (id: string, book: string) =>
    request<TnRow>(`/api/rows/tn/${encodeURIComponent(id)}/keep?book=${encodeURIComponent(book)}`, {
      method: "POST",
    }),

  // Toggle the "survive future AI pipeline sweeps" bit. Lock-exempt.
  // Returns the updated row so the caller can refresh local state.
  setPreserveNote: (id: string, book: string, value: boolean) =>
    request<TnRow>(`/api/rows/tn/${encodeURIComponent(id)}/preserve?book=${encodeURIComponent(book)}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ value }),
    }),

  // Toggle the "queue as AI-pipeline hint" bit. Lock-exempt. hint=1 rows
  // are sent into the next pipeline run as options.hints and are excluded
  // from the sweep; AI expansion clears the bit.
  setHintNote: (id: string, book: string, value: boolean) =>
    request<TnRow>(`/api/rows/tn/${encodeURIComponent(id)}/hint?book=${encodeURIComponent(book)}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ value }),
    }),

  // Translation-mode "Approve" action. value=true → translation_state
  // 'validated'; value=false → 'edited' (un-approve). Lock-exempt, non-version-
  // bumping, mirrors setPreserveNote. Returns the updated row so the caller can
  // refresh local state (the collapsed/green treatment keys off the new state).
  validateNote: (id: string, book: string, value: boolean) =>
    request<TnRow>(`/api/rows/tn/${encodeURIComponent(id)}/validate?book=${encodeURIComponent(book)}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ value: value ? 1 : 0 }),
    }),

  // Translation-mode "Approve" for translationQuestions — the tQ analogue of
  // validateNote. value=true → 'validated'; value=false → 'edited'.
  validateQuestion: (id: string, book: string, value: boolean) =>
    request<TqRow>(`/api/rows/tq/${encodeURIComponent(id)}/validate?book=${encodeURIComponent(book)}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ value: value ? 1 : 0 }),
    }),

  // ── tW / tA articles ──
  // Rail list (metadata only; source_md/target_md excluded server-side).
  getArticles: (resource: "tw" | "ta") =>
    request<{ resource: string; units: ArticleUnitMeta[] }>(`/api/articles/${resource}`),

  // Full unit (source_md + target_md) for the editor.
  getArticle: (resource: "tw" | "ta", path: string) =>
    request<ArticleUnit>(`/api/articles/${resource}/unit?path=${encodeURIComponent(path)}`),

  // Save the translation. If-Match version CAS (409 on mismatch). Editing an
  // ai_draft/validated unit demotes it to 'edited' server-side.
  patchArticle: (resource: "tw" | "ta", path: string, expectedVersion: number, targetMd: string) =>
    request<ArticleUnit>(`/api/articles/${resource}/unit?path=${encodeURIComponent(path)}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", "If-Match": String(expectedVersion) },
      body: JSON.stringify({ target_md: targetMd }),
    }),

  // "Approve" — value=true → 'validated'; value=false → 'edited'. Non-version-bumping.
  validateArticle: (resource: "tw" | "ta", path: string, value: boolean) =>
    request<ArticleUnit>(`/api/articles/${resource}/unit/validate?path=${encodeURIComponent(path)}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ value: value ? 1 : 0 }),
    }),

  // Manually add a single article by id ("kt/grace" / "translate/figs-aside").
  // Restores a soft-deleted unit. 400 unparseable_id/not_translation_project,
  // 404 source_not_found.
  addArticle: (resource: "tw" | "ta", id: string) =>
    request<{ ok: true; resource: "tw" | "ta"; article_id: string; paths: string[] }>(
      `/api/articles/${resource}/add`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id }),
      },
    ),

  // Populate tW/tA article sources from imported notes. One bounded chunk per
  // call — the caller loops until `remaining === 0`. `book` scopes it to one
  // book; omitted → global.
  populateArticles: (opts?: { book?: string; retryFailed?: boolean }) =>
    request<{
      processed: number;
      remaining: number;
      warnings: string[];
      skipped?: boolean;
      aborted?: "source_changed";
    }>(`/api/articles/populate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(opts ?? {}),
    }),

  // ── Note templates (migration 0054) ──
  // Rail list (metadata only; source_md/target_md excluded server-side).
  getTemplates: (opts?: { includeDeleted?: boolean }) =>
    request<{ units: TemplateUnitMeta[] }>(
      `/api/templates${opts?.includeDeleted ? "?includeDeleted=1" : ""}`,
    ),

  // Full unit (source_md + target_md) for the editor.
  getTemplate: (id: string) =>
    request<TemplateUnit>(`/api/templates/unit?id=${encodeURIComponent(id)}`),

  // Save the translation. If-Match version CAS (409 on mismatch, 428 if the
  // header is missing). Editing an ai_draft/validated unit demotes it to
  // 'edited' server-side.
  patchTemplate: (id: string, expectedVersion: number, targetMd: string) =>
    request<TemplateUnit>(`/api/templates/unit?id=${encodeURIComponent(id)}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", "If-Match": String(expectedVersion) },
      body: JSON.stringify({ target_md: targetMd }),
    }),

  // "Draft with AI" — generates a translation for this unit's target_md via
  // the uw-bt-bot proxy and persists it server-side as translation_state=
  // 'ai_draft' in the same request (templates have no separate apply step).
  // If-Match CAS like patchTemplate; long timeout since generation can take a
  // while (mirrors api.tnQuick's 120s ceiling).
  draftTemplate: (id: string, expectedVersion: number, signal?: AbortSignal) =>
    request<TemplateUnit>(`/api/templates/unit/draft?id=${encodeURIComponent(id)}`, {
      method: "POST",
      headers: { "If-Match": String(expectedVersion) },
      signal,
      timeoutMs: 120_000,
    }),

  // "Approve" — value=true → 'validated'; value=false → 'edited'. Non-version-
  // bumping; 404 if the unit has no translation to (un)validate.
  validateTemplate: (id: string, value: boolean) =>
    request<TemplateUnit>(`/api/templates/unit/validate?id=${encodeURIComponent(id)}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ value: value ? 1 : 0 }),
    }),

  // Source revisions + word-diff-ready target history for the history dialog.
  getTemplateHistory: (id: string) =>
    request<TemplateHistory>(`/api/templates/unit/history?id=${encodeURIComponent(id)}`),

  // ── UI localization overrides (migration 0052) ──
  getL10nOverrides: () =>
    request<{ overrides: Record<string, L10nBag>; versions: Record<string, number> }>(`/api/l10n/overrides`),
  putL10nOverrides: (lang: string, expectedVersion: number, overrides: L10nBag) =>
    request<{ version: number }>(`/api/l10n/overrides/${lang}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json", "If-Match": String(expectedVersion) },
      body: JSON.stringify(overrides),
    }),

  // ── Translation preferences & memory (migration 0040) ──
  getTranslationPrefs: () => request<{ prefs: TranslationPrefs }>(`/api/translation-memory/prefs`),
  putTranslationPrefs: (expectedVersion: number, patch: Partial<TranslationPrefsInput>) =>
    request<{ prefs: TranslationPrefs }>(`/api/translation-memory/prefs`, {
      method: "PUT",
      headers: { "Content-Type": "application/json", "If-Match": String(expectedVersion) },
      body: JSON.stringify(patch),
    }),

  // ── Org-wide AI provider config (migration 0065) ──
  getAiProvider: () => request<AiProviderSettings>(`/api/ai-provider`),
  putAiProvider: (expectedVersion: number, body: AiProviderInput) =>
    request<AiProviderSettings>(`/api/ai-provider`, {
      method: "PUT",
      headers: { "Content-Type": "application/json", "If-Match": String(expectedVersion) },
      body: JSON.stringify(body),
    }),
  clearAiProvider: (expectedVersion: number) =>
    request<AiProviderSettings>(`/api/ai-provider`, {
      method: "DELETE",
      headers: { "If-Match": String(expectedVersion) },
    }),
  getContextExportStatus: () =>
    request<ContextExportStatus>(`/api/translation-memory/export-status`),
  runContextExport: (opts?: { dryDcs?: boolean; shrinkOverride?: boolean }) =>
    request<{ id: string; status: string }>(`/api/exports/run`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contextOnly: true,
        dryDcs: opts?.dryDcs,
        shrinkOverride: opts?.shrinkOverride,
      }),
    }),
  aquiferDrafts: (book: string) =>
    request<AquiferDraftsResponse>(`/api/books/${encodeURIComponent(book)}/aquifer-drafts`, {
      method: "POST",
    }),
  getTerms: (opts?: { status?: string; q?: string }) => {
    const qs = new URLSearchParams();
    if (opts?.status) qs.set("status", opts.status);
    if (opts?.q) qs.set("q", opts.q);
    const suffix = qs.toString() ? `?${qs}` : "";
    return request<{ terms: Term[] }>(`/api/translation-memory/terms${suffix}`);
  },
  getTermsCount: () => request<{ count: number }>(`/api/translation-memory/terms/count`),
  createTerm: (body: TermInput) =>
    request<Term>(`/api/translation-memory/terms`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }),
  patchTerm: (id: number, expectedVersion: number, patch: Partial<TermInput>) =>
    request<Term>(`/api/translation-memory/terms/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", "If-Match": String(expectedVersion) },
      body: JSON.stringify(patch),
    }),
  deleteTerm: (id: number) =>
    request<{ ok: boolean }>(`/api/translation-memory/terms/${id}`, { method: "DELETE" }),
  importTerms: (csvText: string, dryRun: boolean) =>
    request<TermImportResult>(`/api/translation-memory/terms/import${dryRun ? "?dryRun=1" : ""}`, {
      method: "POST",
      headers: { "Content-Type": "text/csv" },
      body: csvText,
    }),
  // CSV export is a plain GET (cookie-auth, same-origin); the caller downloads
  // this URL via an anchor rather than parsing a JSON body.
  termsExportPath: () => `/api/translation-memory/terms/export`,
  getExamples: (opts: { resource: "tn" | "tq"; supportReference?: string; q?: string; limit?: number }) => {
    const qs = new URLSearchParams({ resource: opts.resource });
    if (opts.supportReference) qs.set("supportReference", opts.supportReference);
    if (opts.q) qs.set("q", opts.q);
    if (opts.limit) qs.set("limit", String(opts.limit));
    return request<{ resource: string; examples: TranslationExample[] }>(
      `/api/translation-memory/examples?${qs}`,
    );
  },

  // Move a note to the visible "trash" state (the delete button). Returns the
  // updated row with trashed_at set. Reversible via restoreNote; finalized to a
  // deleted_at tombstone by the nightly job. Lock-exempt, no If-Match.
  trashNote: (id: string, book: string) =>
    request<TnRow>(`/api/rows/tn/${encodeURIComponent(id)}/trash?book=${encodeURIComponent(book)}`, {
      method: "POST",
    }),

  // Bring a trashed note back to the live set (trashed_at cleared).
  restoreNote: (id: string, book: string) =>
    request<TnRow>(`/api/rows/tn/${encodeURIComponent(id)}/restore?book=${encodeURIComponent(book)}`, {
      method: "POST",
    }),

  // Verse version history (ULT/UST), reconstructed from the edit_log audit
  // trail server-side. requireEditor — same gate as note history. Mirrors
  // getRowHistory above.
  getVerseHistory: (book: string, chapter: number, verse: number, bibleVersion: string) =>
    request<VerseHistory>(
      `/api/verses/${encodeURIComponent(book)}/${chapter}/${verse}/${encodeURIComponent(bibleVersion)}/history`,
    ),

  patchVerse: <T = unknown>(
    book: string,
    chapter: number,
    verse: number,
    bibleVersion: string,
    expectedVersion: number,
    payload: { content: unknown; plain_text?: string | null; alignment_intent?: AlignmentIntent },
    opts?: { sourceGeneration?: number },
  ) => {
    const headers: Record<string, string> = { "If-Match": String(expectedVersion) };
    if (opts?.sourceGeneration != null) {
      headers["X-Source-Generation"] = String(opts.sourceGeneration);
    }
    return request<T>(
      `/api/verses/${encodeURIComponent(book)}/${chapter}/${verse}/${encodeURIComponent(bibleVersion)}`,
      {
        method: "PATCH",
        headers,
        body: JSON.stringify(payload),
      },
    );
  },

  tnQuick: (body: TnQuickRequest, signal?: AbortSignal) =>
    request<TnQuickResponse>(`/api/tn-quick`, {
      method: "POST",
      body: JSON.stringify(body),
      signal,
      // AI note drafting (bot → Anthropic + Hebrew validation) routinely
      // exceeds the 30s default, which surfaced as a "request timeout" toast.
      // The call is lifecycle-keyed (aborts on Shell unmount) and runs in the
      // background, so a generous ceiling is safe.
      timeoutMs: 120_000,
    }),

  pipelineStart: (body: PipelineStartRequest, signal?: AbortSignal) =>
    request<PipelineStartResponse>(`/api/pipelines/start`, {
      method: "POST",
      body: JSON.stringify(body),
      signal,
    }),

  pipelineStatus: (jobId: string, signal?: AbortSignal) =>
    request<PipelineStatusResponse>(
      `/api/pipelines/${encodeURIComponent(jobId)}`,
      { signal },
    ),

  pipelineList: (
    states?: PipelineState[],
    signal?: AbortSignal,
  ) =>
    request<{ jobs: PipelineJobRow[]; queue?: PipelineQueueSummary }>(
      states && states.length > 0
        ? `/api/pipelines?state=${encodeURIComponent(states.join(","))}`
        : `/api/pipelines`,
      { signal },
    ),

  // Withdraw a job that hasn't reached the front of the line. Server returns
  // 409 {error:"cannot_cancel", state} if it's already dispatching/running.
  pipelineCancel: (jobId: string, signal?: AbortSignal) =>
    request<{ ok: boolean; jobId: string; state: "cancelled" }>(
      `/api/pipelines/${encodeURIComponent(jobId)}/cancel`,
      { method: "POST", signal },
    ),

  // Acknowledge a "completed-while-away" toast so the server clears its
  // unnotified flag. Fire-and-forget — if it fails the user just sees the
  // toast again on the next reload, which is harmless.
  pipelineNotified: (jobId: string, signal?: AbortSignal) =>
    request<{ ok: boolean; changed: number }>(
      `/api/pipelines/${encodeURIComponent(jobId)}/notified`,
      { method: "POST", signal },
    ),

  // ── Nightly export admin surface (api/src/exports.ts) ──
  // Previously hand-rolled per admin screen (ObserveScreen.tsx's observeFetch,
  // AdminProgressScreen.tsx's adminGet, AdminWorkflowScreen.tsx's adminFetch)
  // with duplicated CSRF logic and none of request()'s silent 401-refresh —
  // see issue #166.
  // Accepts either the legacy bare limit or an options object — the server
  // supports a book filter (api/src/exports.ts GET /) used by the package
  // hub's lifecycle card.
  exportsList: (opts?: number | { limit?: number; book?: string }, signal?: AbortSignal) => {
    const o = typeof opts === "number" ? { limit: opts } : (opts ?? {});
    const qs = new URLSearchParams();
    if (o.limit != null) qs.set("limit", String(o.limit));
    if (o.book) qs.set("book", o.book);
    const suffix = qs.toString() ? `?${qs}` : "";
    return request<{ snapshots: ExportSnapshot[] }>(`/api/exports${suffix}`, { signal });
  },

  exportsRun: (
    opts?: {
      shrinkOverride?: boolean;
      book?: string;
      resource?: ExportRunResource;
      chapterStart?: number;
      chapterEnd?: number;
      mode?: "merge" | "overwrite";
    },
    signal?: AbortSignal,
  ) => {
    const body: {
      shrinkOverride?: boolean;
      book?: string;
      resource?: ExportRunResource;
      chapterStart?: number;
      chapterEnd?: number;
      mode?: "merge" | "overwrite";
    } = {};
    if (opts?.shrinkOverride !== undefined) body.shrinkOverride = opts.shrinkOverride;
    if (opts?.book) body.book = opts.book;
    if (opts?.resource) body.resource = opts.resource;
    if (opts?.chapterStart !== undefined) body.chapterStart = opts.chapterStart;
    if (opts?.chapterEnd !== undefined) body.chapterEnd = opts.chapterEnd;
    if (opts?.mode !== undefined) body.mode = opts.mode;
    return request<{ id: string; status: string }>(`/api/exports/run`, {
      method: "POST",
      body: JSON.stringify(body),
      signal,
    });
  },

  exportsInstance: (id: string, signal?: AbortSignal) =>
    request<{ id: string; status: unknown }>(
      `/api/exports/instance/${encodeURIComponent(id)}`,
      { signal },
    ),

  getPendingImports: (book: string, chapter: number, signal?: AbortSignal) =>
    request<{ items: PendingImport[] }>(
      `/api/pending-imports?book=${encodeURIComponent(book)}&chapter=${chapter}`,
      { signal },
    ),

  // ── Scripture lane management ──
  laneValidate: (lane: "lit" | "sim", url: string) =>
    request<{
      source: { owner: string; repo: string; ref: string };
      currentSource: { owner: string; repo: string; ref: string };
      impactBooks: number;
      impactVerses: number;
      laneState: LanePublicState;
    }>(`/api/project-config/lanes/${lane}/validate`, {
      method: "POST",
      body: JSON.stringify({ url }),
    }),

  laneStartReplacement: (
    lane: "lit" | "sim",
    config: LanePublicState["config"],
    confirm: boolean,
    // Optional per-book selection (issue #94): the books to STAGE from the new
    // source. Omit to replace every book (unchanged whole-lane behavior); the
    // un-selected books are carried forward from the current generation. Must be
    // a subset of laneAffectedBooks — the server 400s (`unknown_books`) otherwise.
    replaceBooks?: string[],
  ) =>
    request<{ job: unknown; books: unknown[] }>(
      `/api/project-config/lanes/${lane}/replacements`,
      {
        method: "POST",
        body: JSON.stringify(
          replaceBooks ? { config, confirm, replaceBooks } : { config, confirm },
        ),
      },
    ),

  // The exact book set a replacement on this lane would re-stage (issue #97),
  // from the lane's required-books snapshot of the active generation. Used to
  // list affected books in the confirm dialog + staging view — NOT getBooks(),
  // which reflects the whole DB rather than this lane's imported generation.
  laneAffectedBooks: (lane: "lit" | "sim") =>
    request<{
      books: string[];
      // Per-book existing-content stats (issue #94): verse count + how many
      // verses have a translator edit. Lets the checklist show what each book
      // holds before it's overwritten. Absent on older servers.
      stats?: Record<string, { verses: number; edited: number }>;
    }>(
      `/api/project-config/lanes/${lane}/affected-books`,
    ),

  laneGetJob: (lane: "lit" | "sim", jobId: string) =>
    request<LaneReplacementJobResponse>(
      `/api/project-config/lanes/${lane}/replacements/${encodeURIComponent(jobId)}`,
    ),

  laneCancelJob: (lane: "lit" | "sim", jobId: string) =>
    request<{ ok: boolean }>(
      `/api/project-config/lanes/${lane}/replacements/${encodeURIComponent(jobId)}/cancel`,
      { method: "POST" },
    ),

  // Full back-out (issue #97): abort an in-progress replacement AND revert the
  // lane to its prior source — clears replacement_required + pendingTarget that
  // /cancel keeps, without overwriting gen-1 content. This is the escape hatch
  // for a lane stuck spinning on staging failures.
  laneBackOutJob: (lane: "lit" | "sim", jobId: string) =>
    request<{ ok: boolean }>(
      `/api/project-config/lanes/${lane}/replacements/${encodeURIComponent(jobId)}/back-out`,
      { method: "POST" },
    ),

  // Re-stage a single book that hit a retryable_error. Returns updated job
  // readiness (ready + pending list) so the caller can re-poll / enable activate.
  laneRetryBook: (lane: "lit" | "sim", jobId: string, book: string) =>
    request<{ status: string; ready?: boolean; pending?: string[] }>(
      `/api/project-config/lanes/${lane}/replacements/${encodeURIComponent(jobId)}/retry-book`,
      { method: "POST", body: JSON.stringify({ book }) },
    ),

  // Authorize a book's absence (skip it) — marks it absent_authorized so it no
  // longer blocks readiness. Requires confirm:true so a misclick can't permanently
  // omit a book from the new generation. Returns updated job readiness.
  laneWaiveBook: (lane: "lit" | "sim", jobId: string, book: string, confirm = true) =>
    request<{ ready?: boolean; pending?: string[] }>(
      `/api/project-config/lanes/${lane}/replacements/${encodeURIComponent(jobId)}/waive-book`,
      { method: "POST", body: JSON.stringify({ book, confirm }) },
    ),

  // Flip the generation pointer once the job is ready. The fencing token guards
  // against a split-brain export completing a stale render after the flip.
  laneActivate: (lane: "lit" | "sim", jobId: string, fencingToken: string) =>
    request<{ activated: boolean }>(
      `/api/project-config/lanes/${lane}/replacements/${encodeURIComponent(jobId)}/activate`,
      { method: "POST", body: JSON.stringify({ fencingToken }) },
    ),

  lanePatch: (
    lane: "lit" | "sim",
    configRevision: number,
    patch: { label?: string; textReadOnly?: boolean; alignmentWritable?: boolean },
  ) =>
    request<{ laneState: LanePublicState }>(
      `/api/project-config/lanes/${lane}`,
      {
        method: "PATCH",
        body: JSON.stringify({ ...patch, configRevision }),
      },
    ),

  // ── Admin user allowlist (migration 0016) ──
  adminListUsers: () => request<{ users: AdminUser[] }>(`/api/admin/users`),
  // Live DCS org roster (NOT the allowlist) for reconciliation — see issue #64.
  // Fails soft server-side, so a 200 with { error, members: [] } is normal when
  // DCS is unreachable; callers surface that inline rather than treating it as
  // a hard failure.
  adminListOrgMembers: () => request<OrgMembersResponse>(`/api/admin/users/org-members`),
  // wasTeamManaged: the row belonged to Door43 team sync BEFORE this edit
  // (post-edit it reads source='manual' — the admin just took ownership), so
  // the edit will be re-taken at the user's next team check while they stay
  // on the team. Optional so older cached responses stay type-compatible.
  adminSetUserRole: (username: string, role: "admin" | "editor") =>
    request<{ user: AdminUser; wasTeamManaged?: boolean; dcsVerified: boolean }>(
      `/api/admin/users/${encodeURIComponent(username)}`,
      { method: "PUT", body: JSON.stringify({ role }) },
    ),
  adminRemoveUser: (username: string) =>
    // wasTeamDerived: the removed row came from a Door43 team, so the user's
    // next team check re-creates it — removal only sticks once they're taken
    // out of the team on Door43.
    request<{ ok: true; wasTeamDerived?: boolean }>(
      `/api/admin/users/${encodeURIComponent(username)}`,
      { method: "DELETE" },
    ),
  // Bulk-clears every manual allowlist grant so roles come from Door43 teams.
  // `kept` names any manual admin preserved to keep the admin set non-empty
  // (the caller if applicable); `removed` is everyone cleared.
  adminPurgeManualGrants: () =>
    request<{ removed: string[]; kept: string[] }>(`/api/admin/users/purge-manual`, {
      method: "POST",
    }),

  // ── Workspaces (org-per-D1) ──
  listWorkspaces: () => request<WorkspacesResponse>(`/api/workspaces`),
  // Sets the be_ws cookie server-side. 404 unknown_workspace / 403
  // workspace_forbidden are surfaced to callers as ApiError.
  switchWorkspace: (slug: string) =>
    request<{ ok: true; slug: string }>(`/api/workspaces/${encodeURIComponent(slug)}`, {
      method: "POST",
    }),
};
