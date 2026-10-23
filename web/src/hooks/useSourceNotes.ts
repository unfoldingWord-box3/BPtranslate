import { useEffect, useState } from "react";

// The published source-language tN (e.g. unfoldingWord/en_tn) for a book, keyed
// by row ID. In a gateway-language project the row's OWN note is the target
// being translated/reviewed; the English SOURCE it was drafted from lives in the
// published source repo, not D1 (the translate pipeline fetches by reference and
// the draft_meta sidecar isn't wired yet — INTEGRATION.md §0). Row IDs pass
// through byte-identical, so we fetch the source TSV once per book and match by
// id. Door43 serves raw TSV with permissive CORS (same as the TW article
// viewer), and the prod CSP already allows git.door43.org.
//
// Degrades gracefully: a failed fetch or an id with no source row yields no
// entry, and the card simply omits the source block.

export interface SourceNote {
  note: string;
  quote: string;
  supportReference: string;
  reference: string;
}

export type SourceNoteMap = Map<string, SourceNote>;

const EMPTY: SourceNoteMap = new Map();

function rawUrl(org: string, repo: string, book: string): string {
  return `https://git.door43.org/${org}/${repo}/raw/branch/master/tn_${book.toUpperCase()}.tsv`;
}

// tN TSV columns: Reference \t ID \t Tags \t SupportReference \t Quote \t Occurrence \t Note
function parseTsv(text: string): SourceNoteMap {
  const map: SourceNoteMap = new Map();
  // Strip a leading UTF-8 BOM (Door43 raw files sometimes carry one) — without
  // this the first column of the header row would be "﻿Reference" and,
  // worse, the header's id would be "﻿Reference"'s neighbour, so the
  // content-based header skip below would miss it. Split on \r?\n so CRLF-served
  // files don't leave a trailing "\r" on the Note column.
  const lines = text.replace(/^﻿/, "").split(/\r?\n/);
  for (const line of lines) {
    if (!line) continue;
    const cols = line.split("\t");
    if (cols.length < 7) continue;
    const [reference, id, , supportReference, quote, , note] = cols;
    // Skip the header by CONTENT, not position (a leading blank line would push
    // it past index 0). Real row IDs are 4-char slugs, never the literal "ID".
    if (id === "ID") continue;
    if (!id) continue;
    map.set(id, {
      note: (note ?? "").replace(/\\n/g, "\n"),
      quote: quote ?? "",
      supportReference: supportReference ?? "",
      reference: reference ?? "",
    });
  }
  return map;
}

const cache = new Map<string, Promise<SourceNoteMap>>();

function fetchSourceNotes(org: string, repo: string, book: string): Promise<SourceNoteMap> {
  const url = rawUrl(org, repo, book);
  let pending = cache.get(url);
  if (!pending) {
    pending = fetch(url)
      .then((r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.text();
      })
      .then(parseTsv)
      .catch((err) => {
        cache.delete(url); // don't cache failures — allow retry
        throw err;
      });
    cache.set(url, pending);
  }
  return pending;
}

// `source` is the project's translationSource projection {org, repo}; null (the
// English root project) short-circuits to an empty map, so no fetch fires.
export function useSourceNotes(
  book: string | null | undefined,
  source: { org: string; repo: string } | null,
): SourceNoteMap {
  const [map, setMap] = useState<SourceNoteMap>(EMPTY);
  // Depend on the two strings, not the object, so a caller that builds `source`
  // fresh each render does not refetch on every render.
  const org = source?.org ?? null;
  const repo = source?.repo ?? null;
  useEffect(() => {
    if (!book || org === null || repo === null) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- clear the map when the book or source goes away. Deriving EMPTY in render instead would let the previous book's notes reappear when a source comes back, until its fetch lands.
      setMap(EMPTY);
      return;
    }
    let mounted = true;
    fetchSourceNotes(org, repo, book)
      .then((m) => {
        if (mounted) setMap(m);
      })
      .catch(() => {
        if (mounted) setMap(EMPTY);
      });
    return () => {
      mounted = false;
    };
  }, [book, org, repo]);
  return map;
}
