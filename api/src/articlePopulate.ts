// Article population (PR A): fill the tW/tA translate areas from a book's
// imported notes, replacing the old manual whole-corpus `import-articles.mjs`
// run. When a book is imported/reimported (or on a POLL_CRON backstop), we scan
// the book's tn/twl rows for the tA (SupportReference / inline rc:// links) and
// tW (TWLink) articles they reference, fetch just those article files from the
// project's translationSource, and upsert them into article_units — so the
// translator only sees the articles their book actually needs, populated on
// demand rather than all ~1000 tW + ~200 tA up front.
//
// Design points (docs/plan rev 4, "PR A"):
//  - Source-IDENTITY-aware upsert: a sha-only staleness guard breaks when the
//    source ORG changes but the bytes match, so the row would stay perpetually
//    "mismatched". We track source_org/source_repo and re-stamp on identity
//    change, bumping version only on a real sha change and demoting a stale
//    validated/ai_draft to 'edited' (the draft was generated against old source).
//  - fetch-state memory (article_fetch_state), scoped to the source it was seen
//    against: a 404 is terminal for that source (skip thereafter); a 5xx /
//    truncated / network error retries with an attempt cap. Rows observed against
//    a DIFFERENT source than the current translationSource are VOID (deleted, path
//    treated fresh) — a 404 from org A must not block the path after switching to
//    org B.
//  - Write-time config fence: population may run in the background (waitUntil /
//    cron). getProjectConfig caches for 60s per isolate and a PUT clears only its
//    own isolate, so re-reading before writing is neither fresh nor race-free.
//    Instead we capture the raw config snapshot at planning time and prepend to
//    every write batch a guard statement that RAISES (CHECK-violating INSERT into
//    article_fetch_state) when the live snapshot no longer matches — D1 rolls back
//    the whole batch, and the driver reports {aborted:"source_changed"}. An
//    old-source invocation can never land rows after an admin switches source.

import type { Env } from "./index";
import { getProjectConfig, type TranslationSourceRef } from "./projectConfig.ts";
import { dcsRawUrl, fetchTextWithStatus, resolveSourceRef, type FetchTextResult, type SourceRef } from "./dcsSources.ts";
import { gitBlobSha } from "./articleExport.ts";
import { sameDcsName } from "./repoUrl.ts";

export type ArticleResource = "tw" | "ta";

// tA manuals and tW categories are a closed, server-known set — anything else is
// a malformed reference and is dropped rather than fetched.
const TA_MANUALS = new Set(["translate", "checking", "process", "intro"]);
const TW_CATEGORIES = new Set(["kt", "names", "other"]);
const SLUG_RE = /^[a-z0-9-]{1,80}$/;

const MAX_FETCH_ATTEMPTS = 5; // 'error' fetch-state retries until this cap, then manual reset
const FETCH_CONCURRENCY = 10;
const WRITE_ITEM_BATCH = 20; // article files are large; keep D1 batches small

// ── Pure parsers ────────────────────────────────────────────────────────────

export interface TaRef {
  manual: string;
  slug: string;
}
export interface TwRef {
  cat: string;
  slug: string;
}

function stripMd(seg: string): string {
  return seg.replace(/\.md$/, "");
}

// tA reference: 'figs-metaphor' (bare, → translate manual), 'translate/figs-aside'
// (bare, 2-seg), or rc:// forms with any language segment
// ('rc://en/ta/man/translate/figs-metaphor', also tolerates a missing 'man').
export function parseTaRef(ref: string | null | undefined): TaRef | null {
  if (!ref) return null;
  const raw = ref.trim();
  if (!raw) return null;
  let segs: string[];
  if (raw.startsWith("rc://")) {
    segs = raw.slice("rc://".length).split("/").filter(Boolean);
    const ti = segs.indexOf("ta");
    if (ti === -1) return null;
    segs = segs.slice(ti + 1);
    if (segs[0] === "man") segs = segs.slice(1);
  } else {
    segs = raw.replace(/^\/+|\/+$/g, "").split("/").filter(Boolean);
  }
  segs = segs.map(stripMd).filter(Boolean);
  let manual: string;
  let slug: string;
  if (segs.length === 1) {
    manual = "translate";
    slug = segs[0];
  } else if (segs.length === 2) {
    [manual, slug] = segs;
  } else {
    return null;
  }
  if (!TA_MANUALS.has(manual) || !SLUG_RE.test(slug)) return null;
  return { manual, slug };
}

// tW reference: 'kt/god' (bare, 2-seg), 'bible/kt/god' (bare with prefix), or
// rc:// forms ('rc://en/tw/dict/bible/kt/god'). A bare one-segment value can't
// determine a category, so it is rejected.
export function parseTwRef(ref: string | null | undefined): TwRef | null {
  if (!ref) return null;
  const raw = ref.trim();
  if (!raw) return null;
  let segs: string[];
  if (raw.startsWith("rc://")) {
    segs = raw.slice("rc://".length).split("/").filter(Boolean);
    const ti = segs.indexOf("tw");
    if (ti === -1) return null;
    segs = segs.slice(ti + 1);
  } else {
    segs = raw.replace(/^\/+|\/+$/g, "").split("/").filter(Boolean);
  }
  segs = segs.map(stripMd).filter((s) => s && s !== "dict" && s !== "bible");
  if (segs.length !== 2) return null;
  const [cat, slug] = segs;
  if (!TW_CATEGORIES.has(cat) || !SLUG_RE.test(slug)) return null;
  return { cat, slug };
}

// Inline rc:// links embedded in tn note markdown (OBA intro carries a tA link
// with an empty SupportReference — the note body is the only place it appears).
export function extractRcLinks(md: string | null | undefined): string[] {
  if (!md) return [];
  const out: string[] = [];
  const re = /rc:\/\/[^\s)\]}"'`>]+/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(md)) !== null) out.push(m[0]);
  return out;
}

// The three markdown files an article maps to. tA articles are body (01.md) +
// optional title / sub-title; tW articles are body-only.
export function taPaths(manual: string, slug: string): Array<{ path: string; part: string }> {
  const base = `${manual}/${slug}`;
  return [
    { path: `${base}/01.md`, part: "body" },
    { path: `${base}/title.md`, part: "title" },
    { path: `${base}/sub-title.md`, part: "sub-title" },
  ];
}
export function twPath(cat: string, slug: string): string {
  return `bible/${cat}/${slug}.md`;
}
export function articleIdForTa(ref: TaRef): string {
  return `${ref.manual}/${ref.slug}`;
}
export function articleIdForTw(ref: TwRef): string {
  return `${ref.cat}/${ref.slug}`;
}

// ── planWork ──────────────────────────────────────────────────────────────

export interface ReferencedPath {
  resource: ArticleResource;
  path: string;
  article_id: string;
  part: string;
}
export interface ExistingUnit {
  resource: string;
  path: string;
  source_org: string | null;
  source_repo: string | null;
  deleted_at: number | null;
}
export interface FetchStateRow {
  resource: string;
  path: string;
  source_org: string;
  source_repo: string;
  status: string;
  attempts: number;
}
export interface CurrentSource {
  // PARTIAL and PER-RESOURCE: a resource whose upstream repo was left blank in
  // Setup is omitted, meaning "no upstream source for this resource" — callers
  // must skip it, never build a `${org}/undefined/raw/...` URL. A present entry
  // carries its OWN org (the tW/tA source may live in a different org than the
  // default upstream), so identity stamping/comparison is per-resource org+repo.
  refs: { tw?: SourceRef; ta?: SourceRef };
}

function keyOf(resource: string, path: string): string {
  return `${resource}\u0000${path}`;
}
// undefined when this resource has no upstream source configured.
function refForResource(src: CurrentSource, resource: ArticleResource): SourceRef | undefined {
  return src.refs[resource];
}
function stateBlocks(state: FetchStateRow): boolean {
  if (state.status === "not_found") return true; // terminal for its source
  return state.status === "error" && state.attempts >= MAX_FETCH_ATTEMPTS;
}

// Decide which referenced paths need a fetch under the current source. Order:
// (1) missing paths not blocked by a same-source fetch-state, then
// (2) identity-mismatched existing rows (refetch to re-stamp identity). A
// soft-deleted row counts as PRESENT and is skipped (restore is manual-only).
// A fetch-state row observed against a different source is treated as absent.
export function planWork(
  referenced: ReferencedPath[],
  existingUnits: ExistingUnit[],
  fetchState: FetchStateRow[],
  currentSource: CurrentSource,
): ReferencedPath[] {
  const existing = new Map<string, ExistingUnit>();
  for (const u of existingUnits) existing.set(keyOf(u.resource, u.path), u);
  const state = new Map<string, FetchStateRow>();
  for (const s of fetchState) state.set(keyOf(s.resource, s.path), s);

  const missing: ReferencedPath[] = [];
  const mismatched: ReferencedPath[] = [];
  const seen = new Set<string>();

  for (const ref of referenced) {
    const k = keyOf(ref.resource, ref.path);
    if (seen.has(k)) continue;
    seen.add(k);
    const srcRef = refForResource(currentSource, ref.resource);
    // No upstream repo for this resource (blank in Setup) → nothing to populate.
    // Skip so we never plan a fetch against a `${org}/undefined` URL.
    if (!srcRef) continue;
    const unit = existing.get(k);
    if (unit) {
      if (unit.deleted_at != null) continue; // present (soft-deleted) — never revived by reconciler
      const identOk = sameDcsName(unit.source_org, srcRef.org) && sameDcsName(unit.source_repo, srcRef.repo);
      if (identOk) continue; // present & fresh
      mismatched.push(ref);
      continue;
    }
    const st = state.get(k);
    if (st && sameDcsName(st.source_org, srcRef.org) && sameDcsName(st.source_repo, srcRef.repo) && stateBlocks(st)) {
      continue; // blocked by same-source terminal/capped fetch-state
    }
    missing.push(ref);
  }
  return [...missing, ...mismatched];
}

// ── D1 reads / write helpers ────────────────────────────────────────────────

// Raw, UNCACHED config snapshot for the write-time fence (getProjectConfig's
// 60s isolate cache is unsafe here). Absent row → sentinel. The SQL EXPRESSION
// (not a full statement) is reused inside the fence's WHERE clause.
const CONFIG_SNAPSHOT_EXPR =
  "COALESCE((SELECT preset || '|' || COALESCE(overrides_json,'') FROM project_config WHERE id = 1), '<absent>')";

async function readConfigSnapshot(env: Env): Promise<string> {
  const row = await env.DB.prepare(`SELECT ${CONFIG_SNAPSHOT_EXPR} AS snap`).first<{ snap: string }>();
  return row?.snap ?? "<absent>";
}

// Guard statement prepended to every write batch: when the live config snapshot
// no longer equals the one captured at planning time, it INSERTs a row with
// status='abort_config_changed' — violating article_fetch_state's CHECK — so D1
// rolls back the entire batch. When the config is unchanged the WHERE is false
// and it is a no-op.
function fenceStmt(env: Env, snapshot: string): D1PreparedStatement {
  return env.DB
    .prepare(
      `INSERT INTO article_fetch_state (resource, path, source_org, source_repo, status, updated_at)
       SELECT 'x', 'x', '', '', 'abort_config_changed', 0
        WHERE (${CONFIG_SNAPSHOT_EXPR}) <> ?1`,
    )
    .bind(snapshot);
}

function isAbortError(e: unknown): boolean {
  const msg = e instanceof Error ? e.message : String(e);
  return /constraint/i.test(msg);
}

// Identity-aware reconciler upsert (never touches target_md / deleted_at /
// pre_draft_json / draft_meta_json / updated_by). Exported for the executable
// SQL test (articlePopulate.test.mjs).
export function upsertStmt(
  env: Env,
  r: ArticleResource,
  path: string,
  articleId: string,
  part: string,
  sourceMd: string,
  sourceSha: string,
  org: string,
  repo: string,
  now: number,
): D1PreparedStatement {
  return env.DB
    .prepare(
      `INSERT INTO article_units
         (resource, path, article_id, part, source_md, source_sha, source_org, source_repo, version, updated_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, 1, ?9)
       ON CONFLICT(resource, path) DO UPDATE SET
         source_md   = excluded.source_md,
         source_sha  = excluded.source_sha,
         source_org  = excluded.source_org,
         source_repo = excluded.source_repo,
         version     = article_units.version + (article_units.source_sha IS NOT excluded.source_sha),
         translation_state = CASE
           WHEN article_units.source_sha IS NOT excluded.source_sha
                AND article_units.translation_state IN ('validated','ai_draft') THEN 'edited'
           ELSE article_units.translation_state END,
         updated_at  = excluded.updated_at
       WHERE article_units.source_sha  IS NOT excluded.source_sha
          OR article_units.source_org  IS NOT excluded.source_org
          OR article_units.source_repo IS NOT excluded.source_repo`,
    )
    .bind(r, path, articleId, part, sourceMd, sourceSha, org, repo, now);
}

// Manual-add upsert: always refreshes source + RESTORES a soft-deleted row
// (deleted_at = NULL), preserving target_md, even when the sha is unchanged.
// Exported for the executable SQL test.
export function manualUpsertStmt(
  env: Env,
  r: ArticleResource,
  path: string,
  articleId: string,
  part: string,
  sourceMd: string,
  sourceSha: string,
  org: string,
  repo: string,
  now: number,
): D1PreparedStatement {
  return env.DB
    .prepare(
      `INSERT INTO article_units
         (resource, path, article_id, part, source_md, source_sha, source_org, source_repo, version, updated_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, 1, ?9)
       ON CONFLICT(resource, path) DO UPDATE SET
         source_md   = excluded.source_md,
         source_sha  = excluded.source_sha,
         source_org  = excluded.source_org,
         source_repo = excluded.source_repo,
         version     = article_units.version + (article_units.source_sha IS NOT excluded.source_sha),
         translation_state = CASE
           WHEN article_units.source_sha IS NOT excluded.source_sha
                AND article_units.translation_state IN ('validated','ai_draft') THEN 'edited'
           ELSE article_units.translation_state END,
         deleted_at  = NULL,
         updated_at  = excluded.updated_at`,
    )
    .bind(r, path, articleId, part, sourceMd, sourceSha, org, repo, now);
}

function deleteStateStmt(env: Env, r: ArticleResource, path: string): D1PreparedStatement {
  return env.DB
    .prepare(`DELETE FROM article_fetch_state WHERE resource = ?1 AND path = ?2`)
    .bind(r, path);
}

function recordStateStmt(
  env: Env,
  r: ArticleResource,
  path: string,
  org: string,
  repo: string,
  status: "not_found" | "error",
  httpStatus: number,
  now: number,
): D1PreparedStatement {
  return env.DB
    .prepare(
      `INSERT INTO article_fetch_state
         (resource, path, source_org, source_repo, status, attempts, last_http_status, updated_at)
       VALUES (?1, ?2, ?3, ?4, ?5, 1, ?6, ?7)
       ON CONFLICT(resource, path) DO UPDATE SET
         status = excluded.status,
         source_org = excluded.source_org,
         source_repo = excluded.source_repo,
         attempts = article_fetch_state.attempts + 1,
         last_http_status = excluded.last_http_status,
         updated_at = excluded.updated_at`,
    )
    .bind(r, path, org, repo, status, httpStatus, now);
}

// ── Ref collection ──────────────────────────────────────────────────────────

// Exported for the chat MCP package status (packageRefs.ts), which counts the
// same references this population step fetches.
export async function collectReferenced(env: Env, book?: string): Promise<ReferencedPath[]> {
  const bookClause = book ? " AND book = ?1" : "";
  const bind = (stmt: D1PreparedStatement) => (book ? stmt.bind(book) : stmt);

  const [tnSup, twl, tnNotes] = await Promise.all([
    bind(
      env.DB.prepare(
        `SELECT DISTINCT support_reference AS v FROM tn_rows
          WHERE support_reference IS NOT NULL AND support_reference <> ''
            AND deleted_at IS NULL AND trashed_at IS NULL${bookClause}`,
      ),
    ).all<{ v: string }>(),
    bind(
      env.DB.prepare(
        `SELECT DISTINCT tw_link AS v FROM twl_rows
          WHERE tw_link IS NOT NULL AND tw_link <> '' AND deleted_at IS NULL${bookClause}`,
      ),
    ).all<{ v: string }>(),
    bind(
      env.DB.prepare(
        `SELECT note AS v FROM tn_rows
          WHERE note IS NOT NULL AND note LIKE '%rc://%'
            AND deleted_at IS NULL AND trashed_at IS NULL${bookClause}`,
      ),
    ).all<{ v: string }>(),
  ]);

  const out: ReferencedPath[] = [];
  const seen = new Set<string>();
  const addTa = (ref: TaRef) => {
    const id = articleIdForTa(ref);
    for (const { path, part } of taPaths(ref.manual, ref.slug)) {
      const k = keyOf("ta", path);
      if (seen.has(k)) continue;
      seen.add(k);
      out.push({ resource: "ta", path, article_id: id, part });
    }
  };
  const addTw = (ref: TwRef) => {
    const path = twPath(ref.cat, ref.slug);
    const k = keyOf("tw", path);
    if (seen.has(k)) return;
    seen.add(k);
    out.push({ resource: "tw", path, article_id: articleIdForTw(ref), part: "body" });
  };

  for (const row of tnSup.results ?? []) {
    const ta = parseTaRef(row.v);
    if (ta) addTa(ta);
  }
  for (const row of twl.results ?? []) {
    const tw = parseTwRef(row.v);
    if (tw) addTw(tw);
  }
  for (const row of tnNotes.results ?? []) {
    for (const link of extractRcLinks(row.v)) {
      if (link.includes("/ta/")) {
        const ta = parseTaRef(link);
        if (ta) addTa(ta);
      } else if (link.includes("/tw/")) {
        const tw = parseTwRef(link);
        if (tw) addTw(tw);
      }
    }
  }
  return out;
}

async function readExisting(env: Env): Promise<ExistingUnit[]> {
  const rs = await env.DB.prepare(
    `SELECT resource, path, source_org, source_repo, deleted_at FROM article_units
      WHERE resource IN ('tw','ta')`,
  ).all<ExistingUnit>();
  return rs.results ?? [];
}
async function readFetchState(env: Env): Promise<FetchStateRow[]> {
  const rs = await env.DB.prepare(
    `SELECT resource, path, source_org, source_repo, status, attempts FROM article_fetch_state`,
  ).all<FetchStateRow>();
  return rs.results ?? [];
}

function currentSourceFrom(cfg: {
  translationSource: { org: string; repos: Partial<Record<string, TranslationSourceRef>> } | null;
}): CurrentSource | null {
  const ts = cfg.translationSource;
  if (!ts) return null;
  // Resolve each article resource to its own { org, repo } (a role may point at a
  // different org than ts.org). Omit a role with no upstream source.
  const refs: { tw?: SourceRef; ta?: SourceRef } = {};
  const tw = resolveSourceRef(ts, "tw");
  if (tw) refs.tw = tw;
  const ta = resolveSourceRef(ts, "ta");
  if (ta) refs.ta = ta;
  return { refs };
}

// ── Fetch + write driver ────────────────────────────────────────────────────

export interface PopulateResult {
  processed: number;
  remaining: number;
  warnings: string[];
  skipped?: boolean;
  aborted?: "source_changed";
}

export interface PopulateOptions {
  book?: string;
  maxFetches?: number;
  retryFailed?: boolean;
  deps?: { fetch?: (env: Env, url: string) => Promise<FetchTextResult> };
}

type Fetched =
  | { item: ReferencedPath; kind: "ok"; text: string; sha: string }
  | { item: ReferencedPath; kind: "not_found"; httpStatus: number }
  | { item: ReferencedPath; kind: "error"; httpStatus: number };

async function fetchAll(
  env: Env,
  work: ReferencedPath[],
  src: CurrentSource,
  doFetch: (env: Env, url: string) => Promise<FetchTextResult>,
): Promise<Fetched[]> {
  const out: Fetched[] = [];
  // Pair each item with its resolved source ref, dropping any whose resource has
  // no upstream source (planWork already excludes these; belt-and-suspenders so a
  // `${org}/undefined` URL can never be built here).
  const jobs = work
    .map((item) => ({ item, ref: refForResource(src, item.resource) }))
    .filter((j): j is { item: ReferencedPath; ref: SourceRef } => !!j.ref);
  for (let i = 0; i < jobs.length; i += FETCH_CONCURRENCY) {
    const chunk = jobs.slice(i, i + FETCH_CONCURRENCY);
    const settled = await Promise.all(
      chunk.map(async ({ item, ref }): Promise<Fetched> => {
        const url = dcsRawUrl(env, ref.org, ref.repo, item.path, "master");
        const res = await doFetch(env, url);
        if (res.status === 200 && res.text != null && !res.truncated) {
          return { item, kind: "ok", text: res.text, sha: await gitBlobSha(res.text) };
        }
        if (res.status === 404) return { item, kind: "not_found", httpStatus: 404 };
        return { item, kind: "error", httpStatus: res.status };
      }),
    );
    out.push(...settled);
  }
  return out;
}

// The reconciler entry point. Scans the book's (or the whole project's) tn/twl
// references and populates the tW/tA articles they need.
export async function populateReferencedArticles(
  env: Env,
  opts: PopulateOptions = {},
): Promise<PopulateResult> {
  const maxFetches = opts.maxFetches ?? 150;
  const doFetch = opts.deps?.fetch ?? fetchTextWithStatus;
  const cfg = await getProjectConfig(env);
  const src = currentSourceFrom(cfg);
  if (!src) return { processed: 0, remaining: 0, warnings: [], skipped: true };

  const [referenced, existing, fetchState] = await Promise.all([
    collectReferenced(env, opts.book),
    readExisting(env),
    readFetchState(env),
  ]);

  // Void fetch-state rows observed against a different source than the current
  // translationSource (best-effort, unfenced — deleting a stale-source marker
  // cannot corrupt content). Exclude them from planning too.
  const voidKeys: FetchStateRow[] = [];
  const liveState: FetchStateRow[] = [];
  for (const s of fetchState) {
    const ref = s.resource === "tw" || s.resource === "ta"
      ? refForResource(src, s.resource)
      : undefined;
    if (ref != null && sameDcsName(s.source_org, ref.org) && sameDcsName(s.source_repo, ref.repo)) liveState.push(s);
    else voidKeys.push(s);
  }
  if (voidKeys.length > 0) {
    await env.DB.batch(
      voidKeys.map((s) =>
        env.DB
          .prepare(`DELETE FROM article_fetch_state WHERE resource = ?1 AND path = ?2`)
          .bind(s.resource, s.path),
      ),
    ).catch(() => {});
  }

  // retryFailed: clear eligible same-source 'error' state so those paths re-plan.
  if (opts.retryFailed) {
    const errKeys = liveState.filter((s) => s.status === "error");
    if (errKeys.length > 0) {
      await env.DB.batch(
        errKeys.map((s) =>
          env.DB
            .prepare(`DELETE FROM article_fetch_state WHERE resource = ?1 AND path = ?2`)
            .bind(s.resource, s.path),
        ),
      ).catch(() => {});
      for (const s of errKeys) s.status = "__cleared__";
    }
  }

  const plan = planWork(
    referenced,
    existing,
    liveState.filter((s) => s.status === "not_found" || s.status === "error"),
    src,
  );
  const totalPlanned = plan.length;
  const attempt = plan.slice(0, maxFetches);
  const remaining = Math.max(0, totalPlanned - attempt.length);

  if (attempt.length === 0) return { processed: 0, remaining, warnings: [] };

  const snapshot = await readConfigSnapshot(env);
  const fetched = await fetchAll(env, attempt, src, doFetch);
  const now = Math.floor(Date.now() / 1000);

  const warnings: string[] = [];
  let processed = 0;
  let aborted: "source_changed" | undefined;

  // Write in item-batches, each fenced against the planning-time config snapshot.
  for (let i = 0; i < fetched.length; i += WRITE_ITEM_BATCH) {
    const group = fetched.slice(i, i + WRITE_ITEM_BATCH);
    const stmts: D1PreparedStatement[] = [fenceStmt(env, snapshot)];
    let okCount = 0;
    const groupWarnings: string[] = [];
    for (const f of group) {
      const ref = refForResource(src, f.item.resource);
      if (!ref) continue; // no source for this resource — never written (unreachable: planWork filtered)
      if (f.kind === "ok") {
        stmts.push(
          upsertStmt(
            env,
            f.item.resource,
            f.item.path,
            f.item.article_id,
            f.item.part,
            f.text,
            f.sha,
            ref.org,
            ref.repo,
            now,
          ),
          deleteStateStmt(env, f.item.resource, f.item.path),
        );
        okCount++;
      } else if (f.kind === "not_found") {
        stmts.push(recordStateStmt(env, f.item.resource, f.item.path, ref.org, ref.repo, "not_found", 404, now));
        // tA title/sub-title absence is expected (many articles have neither) —
        // silent. A missing body (tA 01.md) or tW article is worth surfacing.
        if (f.item.part === "body") {
          groupWarnings.push(`${f.item.resource} source not found: ${f.item.path}`);
        }
      } else {
        stmts.push(
          recordStateStmt(env, f.item.resource, f.item.path, ref.org, ref.repo, "error", f.httpStatus, now),
        );
        groupWarnings.push(`${f.item.resource} fetch error (${f.httpStatus}): ${f.item.path}`);
      }
    }
    try {
      await env.DB.batch(stmts);
      processed += okCount;
      warnings.push(...groupWarnings);
    } catch (e) {
      if (isAbortError(e)) {
        aborted = "source_changed";
        break;
      }
      throw e;
    }
  }

  return { processed, remaining, warnings, ...(aborted ? { aborted } : {}) };
}

// ── Manual single-article add (restores soft-deleted units) ──────────────────

export type AddArticleResult =
  | { ok: true; resource: ArticleResource; article_id: string; paths: string[] }
  | {
      error:
        | "not_translation_project"
        | "no_source_configured"
        | "unparseable_id"
        | "source_not_found"
        | "source_changed";
    };

export async function populateSingleArticle(
  env: Env,
  resource: ArticleResource,
  id: string,
  deps?: { fetch?: (env: Env, url: string) => Promise<FetchTextResult> },
): Promise<AddArticleResult> {
  const doFetch = deps?.fetch ?? fetchTextWithStatus;
  const cfg = await getProjectConfig(env);
  const src = currentSourceFrom(cfg);
  if (!src) return { error: "not_translation_project" };

  let articleId: string;
  let want: Array<{ path: string; part: string }>;
  if (resource === "ta") {
    const ta = parseTaRef(id);
    if (!ta) return { error: "unparseable_id" };
    articleId = articleIdForTa(ta);
    want = taPaths(ta.manual, ta.slug);
  } else {
    const tw = parseTwRef(id);
    if (!tw) return { error: "unparseable_id" };
    articleId = articleIdForTw(tw);
    want = [{ path: twPath(tw.cat, tw.slug), part: "body" }];
  }

  const ref = refForResource(src, resource);
  // The chosen resource has no upstream source repo (blank in Setup) — there is
  // nothing to fetch. Distinct from source_not_found (which means the id didn't
  // resolve at a configured source).
  if (!ref) return { error: "no_source_configured" };
  // Snapshot BEFORE the fetch (as the reconciler does) so the fence window
  // covers the fetch: a source switch mid-fetch must abort the write, not slip
  // through because the snapshot was taken after the switch.
  const snapshot = await readConfigSnapshot(env);
  const fetched = await Promise.all(
    want.map(async (w) => {
      const url = dcsRawUrl(env, ref.org, ref.repo, w.path, "master");
      const res = await doFetch(env, url);
      return { ...w, res };
    }),
  );

  // The body must exist — its absence means the article id doesn't resolve at
  // the source. tA title/sub-title are optional (404 → skip silently).
  const body = fetched.find((f) => f.part === "body");
  if (!body || body.res.status === 404 || body.res.text == null) {
    return { error: "source_not_found" };
  }

  const now = Math.floor(Date.now() / 1000);
  const stmts: D1PreparedStatement[] = [fenceStmt(env, snapshot)];
  const written: string[] = [];
  for (const f of fetched) {
    if (f.res.status !== 200 || f.res.text == null || f.res.truncated) continue;
    const sha = await gitBlobSha(f.res.text);
    stmts.push(
      manualUpsertStmt(env, resource, f.path, articleId, f.part, f.res.text, sha, ref.org, ref.repo, now),
    );
    written.push(f.path);
  }
  try {
    await env.DB.batch(stmts);
  } catch (e) {
    if (isAbortError(e)) return { error: "source_changed" };
    throw e;
  }
  return { ok: true, resource, article_id: articleId, paths: written };
}

// ── Manual refresh (pull upstream edits for current-identity rows) ───────────

export interface RefreshOptions {
  resource?: ArticleResource;
  maxFetches?: number;
  cursor?: { resource: string; path: string } | null;
  deps?: { fetch?: (env: Env, url: string) => Promise<FetchTextResult> };
}
export interface RefreshResult {
  processed: number;
  changed: number;
  nextCursor: { resource: string; path: string } | null;
  skipped?: boolean;
  aborted?: "source_changed";
}

export async function refreshFromSource(env: Env, opts: RefreshOptions = {}): Promise<RefreshResult> {
  const maxFetches = opts.maxFetches ?? 150;
  const doFetch = opts.deps?.fetch ?? fetchTextWithStatus;
  const cfg = await getProjectConfig(env);
  const src = currentSourceFrom(cfg);
  if (!src) return { processed: 0, changed: 0, nextCursor: null, skipped: true };

  // Only resources with an actual upstream repo can be refreshed. A resource
  // omitted from translationSource.repos has no source, so exclude it entirely
  // rather than binding an `undefined` repo into the query (which would build a
  // `${org}/undefined` fetch URL and pollute the results with 404s).
  const sourced = (["tw", "ta"] as const)
    .map((r) => ({ r, ref: refForResource(src, r) }))
    .filter((x): x is { r: "tw" | "ta"; ref: SourceRef } => !!x.ref);
  if (sourced.length === 0) return { processed: 0, changed: 0, nextCursor: null, skipped: true };

  // Current-identity rows only, ordered by (resource, path) with a continuation
  // cursor — sha no-ops don't remove rows from candidacy, so a plain "first N"
  // would repeat forever. Identity is per-resource org+repo (a role may point at
  // a different org than the others), so each OR-clause binds its OWN source_org.
  const params: unknown[] = [];
  const orClauses: string[] = [];
  for (const { r, ref } of sourced) {
    params.push(ref.org);
    const orgIdx = params.length;
    params.push(ref.repo);
    const repoIdx = params.length;
    // `r` is a compile-time literal ('tw'|'ta'), never user input — safe to inline.
    // COLLATE NOCASE: source_org/source_repo are DCS names (case-insensitive).
    orClauses.push(`(resource = '${r}' AND source_org = ?${orgIdx} COLLATE NOCASE AND source_repo = ?${repoIdx} COLLATE NOCASE)`);
  }
  let where = `deleted_at IS NULL AND (${orClauses.join(" OR ")})`;
  if (opts.resource) {
    where += ` AND resource = ?${params.length + 1}`;
    params.push(opts.resource);
  }
  if (opts.cursor) {
    const rp = params.length;
    where += ` AND (resource > ?${rp + 1} OR (resource = ?${rp + 1} AND path > ?${rp + 2}))`;
    params.push(opts.cursor.resource, opts.cursor.path);
  }
  const rs = await env.DB
    .prepare(
      `SELECT resource, path, article_id, part, source_sha FROM article_units
        WHERE ${where}
        ORDER BY resource, path
        LIMIT ?${params.length + 1}`,
    )
    .bind(...params, maxFetches)
    .all<{ resource: ArticleResource; path: string; article_id: string; part: string; source_sha: string | null }>();
  const rows = rs.results ?? [];
  if (rows.length === 0) return { processed: 0, changed: 0, nextCursor: null };

  const snapshot = await readConfigSnapshot(env);
  const now = Math.floor(Date.now() / 1000);
  let changed = 0;
  let aborted: "source_changed" | undefined;

  const changes: Array<{ row: (typeof rows)[number]; text: string; sha: string }> = [];
  for (let i = 0; i < rows.length; i += FETCH_CONCURRENCY) {
    const chunk = rows.slice(i, i + FETCH_CONCURRENCY);
    const settled = await Promise.all(
      chunk.map(async (row) => {
        const ref = refForResource(src, row.resource);
        if (!ref) return null; // no source (unreachable: the WHERE only selects sourced resources)
        const res = await doFetch(env, dcsRawUrl(env, ref.org, ref.repo, row.path, "master"));
        if (res.status !== 200 || res.text == null || res.truncated) return null;
        const sha = await gitBlobSha(res.text);
        if (sha === row.source_sha) return null; // unchanged
        return { row, text: res.text, sha };
      }),
    );
    for (const s of settled) if (s) changes.push(s);
  }

  for (let i = 0; i < changes.length; i += WRITE_ITEM_BATCH) {
    const group = changes.slice(i, i + WRITE_ITEM_BATCH);
    const stmts: D1PreparedStatement[] = [fenceStmt(env, snapshot)];
    for (const c of group) {
      const ref = refForResource(src, c.row.resource);
      if (!ref) continue; // no source (unreachable: the WHERE only selects sourced resources)
      stmts.push(
        upsertStmt(
          env,
          c.row.resource,
          c.row.path,
          c.row.article_id,
          c.row.part,
          c.text,
          c.sha,
          ref.org,
          ref.repo,
          now,
        ),
      );
    }
    try {
      await env.DB.batch(stmts);
      changed += group.length;
    } catch (e) {
      if (isAbortError(e)) {
        aborted = "source_changed";
        break;
      }
      throw e;
    }
  }

  const last = rows[rows.length - 1];
  const nextCursor = rows.length === maxFetches ? { resource: last.resource, path: last.path } : null;
  return { processed: rows.length, changed, nextCursor, ...(aborted ? { aborted } : {}) };
}
