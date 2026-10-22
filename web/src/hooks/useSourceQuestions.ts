import { useEffect, useState } from "react";

// The published source-language tQ (e.g. unfoldingWord/en_tq) for a book, keyed
// by row ID — the tQ analogue of useSourceNotes. In a gateway-language project
// the row's OWN question/response is the target being translated/reviewed; the
// English SOURCE it was drafted from lives in the published source repo, not D1.
// Row IDs pass through byte-identical, so we fetch the source TSV once per book
// and match by id. Door43 serves raw TSV with permissive CORS and the prod CSP
// already allows git.door43.org.
//
// Degrades gracefully: a failed fetch or an id with no source row yields no
// entry, and the card simply omits the source block.

export interface SourceQuestion {
  question: string;
  response: string;
  quote: string;
  reference: string;
}

export type SourceQuestionMap = Map<string, SourceQuestion>;

const EMPTY: SourceQuestionMap = new Map();

function rawUrl(org: string, repo: string, book: string): string {
  return `https://git.door43.org/${org}/${repo}/raw/branch/master/tq_${book.toUpperCase()}.tsv`;
}

// tQ TSV columns: Reference \t ID \t Tags \t Quote \t Occurrence \t Question \t Response
function parseTsv(text: string): SourceQuestionMap {
  const map: SourceQuestionMap = new Map();
  // Strip a leading UTF-8 BOM and split on \r?\n (see useSourceNotes for why).
  const lines = text.replace(/^﻿/, "").split(/\r?\n/);
  for (const line of lines) {
    if (!line) continue;
    const cols = line.split("\t");
    if (cols.length < 7) continue;
    const [reference, id, , quote, , question, response] = cols;
    // Skip the header by CONTENT, not position. Real row IDs are 4-char slugs.
    if (id === "ID") continue;
    if (!id) continue;
    map.set(id, {
      question: (question ?? "").replace(/\\n/g, "\n"),
      response: (response ?? "").replace(/\\n/g, "\n"),
      quote: quote ?? "",
      reference: reference ?? "",
    });
  }
  return map;
}

const cache = new Map<string, Promise<SourceQuestionMap>>();

function fetchSourceQuestions(org: string, repo: string, book: string): Promise<SourceQuestionMap> {
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
export function useSourceQuestions(
  book: string | null | undefined,
  source: { org: string; repo: string } | null,
): SourceQuestionMap {
  const [map, setMap] = useState<SourceQuestionMap>(EMPTY);
  // Depend on the two strings, not the object, so a caller that builds `source`
  // fresh each render does not refetch on every render.
  const org = source?.org ?? null;
  const repo = source?.repo ?? null;
  useEffect(() => {
    if (!book || org === null || repo === null) {
      setMap(EMPTY);
      return;
    }
    let mounted = true;
    fetchSourceQuestions(org, repo, book)
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
