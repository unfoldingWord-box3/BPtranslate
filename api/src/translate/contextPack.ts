// contextPack.ts — load a per-language translation context pack.
//
// Ported from bp-assistant src/lib/context-pack.js (issue #445). Dropped: the
// local-directory branch (no filesystem in a Worker); `Buffer.byteLength` is
// `TextEncoder` here. Everything else — parsers, statuses, the contractual
// empty-pack error string — is verbatim.
//
// The pack is a DCS repo per gateway-language org (CONTEXT-REPO-CONTRACT.md),
// pinned by contextRef ("org/repo@ref") for reproducible runs and fetched from
// git.door43.org raw endpoints.
//
// Human-authority layout (prompt input; never written by the runner):
//   manifest.yaml                 format, language, direction, provenance
//   brief.md  instructions.md     (+ optional leftover standards.md)
//   templates/templates.tsv       support_reference → target_template (status=active)
//   terminology/terms.csv         concept-oriented 7-col schema
//   examples/validated.jsonl      with tombstones (last-line-wins)
//
// Bot namespace (runs/, candidates/) is never loaded here.

/** The subset of the fetch Response contract the loaders use; tests pass fakes. */
export type FetchLikeResponse = {
  status: number;
  ok: boolean;
  headers?: { get(name: string): string | null } | null;
  text(): Promise<string>;
  json?(): Promise<unknown>;
};
export type FetchLike = (url: string) => Promise<FetchLikeResponse>;

const DCS_BASE = "https://git.door43.org";
export const SUPPORTED_MANIFEST_FORMAT = 1;
// Hardening bounds that protect the translate runner from an oversized,
// misconfigured or malicious pack file. The hand-authored files (manifest,
// brief, instructions, templates, terms) are KBs, so they keep a 2 MB cap.
// examples/validated.jsonl is different: the daily context export writes one
// line per human-validated row and the file only grows (BSOJ Arabic reached
// 2.4 MB at 3,240 rows, ~745 bytes/row, on 2026-11-07, which failed every
// translate run). 16 MB is ~21k rows. It stays well under the Worker's 128 MB
// memory: the text is held as a string and once more as UTF-8 bytes for the
// size check, then parsed.
export const MAX_PACK_FILE_BYTES = 2_000_000;
export const MAX_EXAMPLES_FILE_BYTES = 16_000_000;

export const PACK_FILES = {
  manifest: "manifest.yaml",
  brief: "brief.md",
  instructions: "instructions.md",
  standards: "standards.md", // optional leftover; additive / ignore-unknown
  templates: "templates/templates.tsv",
  terminology: "terminology/terms.csv",
  examples: "examples/validated.jsonl",
} as const;
type PackFileKey = keyof typeof PACK_FILES;

export type TermStatus = "preferred" | "admitted" | "deprecated" | "forbidden" | "do_not_translate";
const TERM_STATUSES = new Set<string>(["preferred", "admitted", "deprecated", "forbidden", "do_not_translate"]);

export type PackTerm = {
  conceptId: string;
  source: string;
  target: string;
  status: TermStatus;
  replacement: string;
  comment: string;
  notes: string;
  twLink: string;
};

export type PackTemplate = {
  template: string;
  status: "active";
  comment: string;
  notes: string;
};

export type PackExample = {
  resource: string;
  rowId: string;
  book: string | null;
  ref: string | null;
  supportReference: string | null;
  source: string;
  target: string;
  validated_at: number;
  _seq: number;
};

export type PackManifest = Record<string, string | number> & { format: number | string };

export type ContextPack = {
  ref: string;
  sha: string | null;
  manifest: PackManifest | null;
  brief: string | null;
  instructions: string | null;
  standards: string | null;
  register: "default" | "formal" | "informal" | null;
  templates: Map<string, PackTemplate>;
  terms: PackTerm[];
  examples: PackExample[];
  missing: string[];
  hasContent: boolean;
};

function nfc(s: string): string {
  return String(s).normalize("NFC");
}

export type ParsedRef = { org: string; repo: string; ref: string };

export function parseContextRef(contextRef: unknown): ParsedRef | null {
  const m = /^([^/@\s]+)\/([^/@\s]+)@(.+)$/.exec(String(contextRef || "").trim());
  if (!m) return null;
  return { org: m[1], repo: m[2], ref: m[3] };
}

function rawUrl({ org, repo, ref }: ParsedRef, filePath: string): string {
  const kind = /^[0-9a-f]{40}$/i.test(ref) ? "commit" : "branch";
  return `${DCS_BASE}/${org}/${repo}/raw/${kind}/${encodeURIComponent(ref)}/${filePath}`;
}

async function fetchText(url: string, fetchImpl: FetchLike | undefined, maxBytes: number): Promise<string | null> {
  const res = await (fetchImpl || (fetch as unknown as FetchLike))(url);
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`fetch ${url} → HTTP ${res.status}`);
  const contentLength = Number(res.headers && typeof res.headers.get === "function" ? res.headers.get("content-length") : null);
  if (Number.isFinite(contentLength) && contentLength > maxBytes) {
    throw new Error(`file too large (>${maxBytes} bytes): ${url}`);
  }
  const text = await res.text();
  // Byte length, not string length: pack files are often Arabic/Hebrew, where
  // one character is 2-3 bytes, so a character count would let a file through
  // at several times the intended cap.
  if (new TextEncoder().encode(text).length > maxBytes) {
    throw new Error(`file too large (>${maxBytes} bytes): ${url}`);
  }
  return text;
}

/** Resolve a branch contextRef to its current commit SHA (best effort). */
export async function resolveContextSha(parsed: ParsedRef, fetchImpl?: FetchLike): Promise<string | null> {
  if (/^[0-9a-f]{40}$/i.test(parsed.ref)) return parsed.ref;
  try {
    const url = `${DCS_BASE}/api/v1/repos/${parsed.org}/${parsed.repo}/branches/${encodeURIComponent(parsed.ref)}`;
    const res = await (fetchImpl || (fetch as unknown as FetchLike))(url);
    if (!res.ok || typeof res.json !== "function") return null;
    const body = (await res.json()) as { commit?: { id?: string } } | null;
    return body && body.commit && body.commit.id ? body.commit.id : null;
  } catch {
    return null;
  }
}

/** Minimal YAML subset for manifest.yaml (key: value scalars). */
export function parseManifestYaml(text: unknown): PackManifest {
  const out: Record<string, string | number> = {};
  for (const line of String(text || "").split(/\r?\n/)) {
    const m = /^([A-Za-z_][\w]*)\s*:\s*(.*?)\s*$/.exec(line);
    if (!m) continue;
    let v = m[2];
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
      v = v.slice(1, -1);
    }
    out[m[1]] = v;
  }
  if (out.format != null && out.format !== "") {
    const n = Number(out.format);
    out.format = Number.isFinite(n) ? n : out.format;
  } else {
    out.format = 1;
  }
  return out as PackManifest;
}

export function parseRegisterFromBrief(brief: string | null | undefined): "default" | "formal" | "informal" | null {
  if (!brief) return null;
  const m = /\*\*Register:\*\*\s*(\w+)/i.exec(brief);
  if (!m) return null;
  const v = m[1].toLowerCase();
  if (v === "default" || v === "formal" || v === "informal") return v;
  return null;
}

/**
 * RFC-4180 CSV parsers. Quoted fields may contain commas, "" escapes, and
 * CRLF/LF newlines — so we scan the whole text as a record stream rather than
 * splitting on physical lines first.
 */

/** Parse one CSV record starting at `start`. Returns { fields, next } or null at EOF. */
export function parseCsvRecord(text: unknown, start = 0): { fields: string[]; next: number } | null {
  const s = String(text);
  let i = start;
  while (i < s.length && (s[i] === "\n" || s[i] === "\r")) i += 1;
  if (i >= s.length) return null;

  const fields: string[] = [];
  while (i <= s.length) {
    if (i >= s.length) {
      fields.push("");
      return { fields, next: i };
    }
    if (s[i] === '"') {
      let out = "";
      i += 1;
      while (i < s.length) {
        if (s[i] === '"') {
          if (s[i + 1] === '"') {
            out += '"';
            i += 2;
            continue;
          }
          i += 1;
          break;
        }
        out += s[i];
        i += 1;
      }
      fields.push(out);
      if (s[i] === ",") {
        i += 1;
        continue;
      }
      if (s[i] === "\r") i += 1;
      if (s[i] === "\n") i += 1;
      return { fields, next: i };
    }

    let j = i;
    while (j < s.length && s[j] !== "," && s[j] !== "\n" && s[j] !== "\r") j += 1;
    fields.push(s.slice(i, j));
    if (s[j] === ",") {
      i = j + 1;
      continue;
    }
    if (s[j] === "\r") j += 1;
    if (s[j] === "\n") j += 1;
    return { fields, next: j };
  }
  return { fields, next: i };
}

/** Yield all CSV records from text (skips blank all-empty records). */
export function parseCsvRecords(text: unknown): string[][] {
  const records: string[][] = [];
  let pos = 0;
  while (true) {
    const rec = parseCsvRecord(text, pos);
    if (!rec) break;
    pos = rec.next;
    if (rec.fields.length === 1 && rec.fields[0] === "") continue;
    records.push(rec.fields);
  }
  return records;
}

/** @deprecated Prefer parseCsvRecord; kept for callers that already have one physical line. */
export function parseCsvLine(line: unknown): string[] | null {
  const rec = parseCsvRecord(String(line).replace(/\r?\n$/, ""), 0);
  return rec ? rec.fields : null;
}

// templates.tsv: support_reference \t target_template \t status \t comment
// Keyed by bare slug (figs-metaphor). Only status=active rows are retained
export function parseTemplatesTsv(text: unknown): Map<string, PackTemplate> {
  const templates = new Map<string, PackTemplate>();
  const lines = String(text).replace(/\r\n/g, "\n").split("\n").filter(Boolean);
  for (const line of lines) {
    if (/^support[_]?reference\t/i.test(line)) continue;
    const [slug, template, status, comment] = line.split("\t");
    if (!slug || !template) continue;
    const st = (status || "").trim().toLowerCase();
    if (st !== "active") continue;
    templates.set(slug.trim(), {
      template,
      status: "active",
      comment: comment || "",
      notes: comment || "",
    });
  }
  return templates;
}

// terms.csv: concept_id,source_term,target_term,status,replacement,comment,tw_link
export function parseTermsCsv(text: unknown): PackTerm[] {
  const terms: PackTerm[] = [];
  const records = parseCsvRecords(text);
  if (!records.length) return terms;
  const header = records[0].map((h) => h.trim().toLowerCase());
  for (let r = 1; r < records.length; r++) {
    const fields = records[r];
    const row: Record<string, string> = {};
    header.forEach((h, idx) => {
      row[h] = fields[idx] != null ? fields[idx] : "";
    });

    const source = nfc((row.source_term || "").trim());
    if (!source) continue;
    let status = (row.status || "").trim().toLowerCase() || "preferred";
    if (status === "approved") status = "preferred";
    if (status === "candidate") status = "admitted";
    if (!TERM_STATUSES.has(status)) continue;

    const target = nfc((row.target_term || "").trim());
    if (status !== "do_not_translate" && status !== "forbidden" && !target) continue;

    terms.push({
      conceptId: (row.concept_id || "").trim(),
      source,
      target,
      status: status as TermStatus,
      replacement: nfc((row.replacement || "").trim()),
      comment: (row.comment || row.notes || "").trim(),
      notes: (row.comment || row.notes || "").trim(),
      twLink: (row.tw_link || "").trim(),
    });
  }
  return terms;
}

/**
 * Parse validated.jsonl with tombstone last-line-wins on (resource, rowId).
 */
export function parseExamplesJsonl(text: unknown): PackExample[] {
  const byKey = new Map<string, PackExample>();
  let seq = 0;
  for (const line of String(text).split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let obj: unknown;
    try {
      obj = JSON.parse(trimmed);
    } catch {
      continue;
    }
    if (!obj || typeof obj !== "object") continue;
    const o = obj as Record<string, unknown>;
    seq += 1;
    const resource = o.resource ? String(o.resource) : "tn";
    const rowId = o.rowId != null ? String(o.rowId) : `anon-${seq}`;
    const key = `${resource}\0${rowId}`;
    if (o.tombstone) {
      byKey.delete(key);
      continue;
    }
    if (!o.source || !o.target) continue;
    byKey.set(key, {
      resource,
      rowId,
      book: o.book ? String(o.book) : null,
      ref: o.ref ? String(o.ref) : null,
      supportReference: o.supportReference ? String(o.supportReference) : null,
      source: nfc(String(o.source)),
      target: nfc(String(o.target)),
      validated_at: o.validated_at != null ? Number(o.validated_at) : seq,
      _seq: seq,
    });
  }
  return [...byKey.values()].sort((a, b) => (a.validated_at - b.validated_at) || (a._seq - b._seq));
}

/**
 * Load and parse a context pack from DCS.
 * @param contextRef "org/repo@ref"
 * @param opts.allowEmpty if false, throw when the pack has no prompt-affecting
 *   content files (misconfig guard for an EXPLICIT ref).
 */
export async function loadContextPack(
  contextRef: string,
  { fetchImpl, allowEmpty = false }: { fetchImpl?: FetchLike; allowEmpty?: boolean } = {},
): Promise<ContextPack> {
  const parsed = parseContextRef(contextRef);
  if (!parsed) {
    throw new Error(`contextRef must be "org/repo@ref", got: ${contextRef}`);
  }

  const entries = Object.entries(PACK_FILES) as [PackFileKey, string][];
  const raw: Partial<Record<PackFileKey, string | null>> = {};
  const missing: string[] = [];
  const [contents, sha] = await Promise.all([
    Promise.all(entries.map(([key, rel]) =>
      fetchText(rawUrl(parsed, rel), fetchImpl, key === "examples" ? MAX_EXAMPLES_FILE_BYTES : MAX_PACK_FILE_BYTES))),
    resolveContextSha(parsed, fetchImpl),
  ]);
  entries.forEach(([key, rel], i) => {
    raw[key] = contents[i];
    if (raw[key] == null) missing.push(rel);
  });

  let manifest: PackManifest | null = null;
  if (raw.manifest != null) {
    manifest = parseManifestYaml(raw.manifest);
    if (typeof manifest.format === "number" && manifest.format > SUPPORTED_MANIFEST_FORMAT) {
      throw new Error(
        `context pack manifest format ${manifest.format} is not supported `
        + `(max supported: ${SUPPORTED_MANIFEST_FORMAT}) at "${contextRef}"`);
    }
  }

  // Exact empty-pack error string is contractual (CONTEXT-REPO-CONTRACT.md §1) —
  // keep stable so the editor can surface it.
  const contentPresent = (["brief", "instructions", "standards", "templates", "terminology", "examples"] as PackFileKey[])
    .some((k) => raw[k] != null);
  if (!contentPresent && !allowEmpty) {
    throw new Error(
      `context pack has no content files at "${contextRef}" — every prompt-affecting file is missing `
      + `(present: ${entries.filter(([, rel]) => !missing.includes(rel)).map(([, rel]) => rel).join(", ") || "none"}). `
      + `Check the org/repo/ref exists and is populated. Translating with an empty pack is refused.`);
  }

  const brief = raw.brief ?? null;
  return {
    ref: String(contextRef),
    sha,
    manifest,
    brief,
    instructions: raw.instructions ?? null,
    standards: raw.standards ?? null,
    register: parseRegisterFromBrief(brief),
    templates: raw.templates ? parseTemplatesTsv(raw.templates) : new Map(),
    terms: raw.terminology ? parseTermsCsv(raw.terminology) : [],
    examples: raw.examples ? parseExamplesJsonl(raw.examples) : [],
    missing,
    hasContent: contentPresent,
  };
}
