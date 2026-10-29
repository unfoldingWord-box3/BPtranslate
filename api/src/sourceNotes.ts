// The published English translation notes a project's notes were drafted
// from, keyed by row id, for bpt_chunk_work's en_note (issue #671). Server
// twin of web/src/hooks/useSourceNotes.ts: the English source is not stored on
// the row, so read the book's tN TSV from the project's translationSource on
// Door43 and match by id (ids pass through import byte-identical).
//
// Never throws: a project in authoring mode, no tN source configured, a 404 or
// a failed fetch all come back as { ok: false, reason } so the tool can still
// return the rows. Notes keep the TSV's literal "\n" escapes, the same form the
// imported row's own note is stored in, so the two compare like for like.

import type { Env } from "./index";
import { getProjectConfig } from "./projectConfig.ts";
import { isTranslationConfig } from "./workflowLayouts.ts";
import { dcsRawUrl, resolveSourceRef } from "./dcsSources.ts";
import { parseTsv } from "./importParsers.ts";

export type SourceNotes =
  | { ok: true; source: string; notes: Map<string, string> }
  | { ok: false; reason: string };

// A hanging Door43 must not stall the tool: past this, en_note is null.
export const SOURCE_FETCH_TIMEOUT_MS = 8_000;

// Anonymous on purpose. The web app reads this TSV from the browser with no
// credentials, so a private source repo shows the reviewer nothing there; chat
// (viewers included) must not see more than that, so the DCS service token
// that fetchTextWithStatus sends is never attached here. Otherwise the same
// rules as that helper: a non-2xx is not content, and a body shorter than its
// Content-Length is a truncated read, not content.
async function fetchAnonymous(
  url: string,
): Promise<{ status: number; text: string | null; truncated?: boolean; timedOut?: boolean }> {
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(SOURCE_FETCH_TIMEOUT_MS) });
    if (!r.ok) return { status: r.status, text: null };
    const buf = await r.arrayBuffer();
    const cl = r.headers.get("content-length");
    const expected = cl == null ? null : Number(cl);
    if (expected != null && Number.isFinite(expected) && buf.byteLength < expected) {
      return { status: 200, text: null, truncated: true };
    }
    return { status: 200, text: new TextDecoder("utf-8").decode(buf) };
  } catch (e) {
    // DOMException (the abort reason) is not an Error in every runtime.
    const name = (e as { name?: unknown } | null)?.name;
    return { status: 0, text: null, timedOut: name === "TimeoutError" || name === "AbortError" };
  }
}

// Per isolate. English tN changes rarely and a reviewer pages through a
// chapter in a few calls, so a short TTL saves a Door43 fetch per page without
// serving a stale source for long. Failures are never cached.
const TTL_MS = 10 * 60_000;
const MAX_ENTRIES = 16;
const cache = new Map<string, { at: number; notes: Map<string, string> }>();

export function clearSourceNotesCache(): void {
  cache.clear();
}

export async function readSourceNotes(env: Env, book: string): Promise<SourceNotes> {
  try {
    const cfg = await getProjectConfig(env);
    if (!isTranslationConfig(cfg)) {
      return { ok: false, reason: "This project writes its notes in English, so they have no separate English source." };
    }
    const ref = resolveSourceRef(cfg.translationSource, "tn");
    if (!ref) return { ok: false, reason: "This project has no English tN source repository set up." };
    const source = `${ref.org}/${ref.repo}`;
    const file = `tn_${book}.tsv`;
    const url = dcsRawUrl(env, ref.org, ref.repo, file);

    const hit = cache.get(url);
    if (hit && Date.now() - hit.at < TTL_MS) return { ok: true, source, notes: hit.notes };

    const res = await fetchAnonymous(url);
    if (res.text === null) {
      const why = res.timedOut
        ? "Door43 did not answer in time"
        : res.status === 404
          ? "it has no such file"
          : res.truncated
            ? "the download was cut short"
            : res.status
              ? `HTTP ${res.status}`
              : "network error";
      return { ok: false, reason: `Could not read the English notes ${file} from ${source} (${why}).` };
    }
    const notes = new Map<string, string>();
    for (const row of parseTsv(res.text).rows) {
      const id = row["ID"];
      if (id) notes.set(id, row["Note"] ?? "");
    }
    if (notes.size === 0) return { ok: false, reason: `${source} ${file} has no notes with an ID column.` };

    cache.delete(url);
    cache.set(url, { at: Date.now(), notes });
    while (cache.size > MAX_ENTRIES) cache.delete(cache.keys().next().value as string);
    return { ok: true, source, notes };
  } catch (e) {
    console.error("readSourceNotes failed", e instanceof Error ? e.message : String(e));
    return { ok: false, reason: "Could not read the English source notes." };
  }
}
