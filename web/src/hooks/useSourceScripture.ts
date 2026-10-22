import { useEffect, useState } from "react";
import type { VerseDto } from "../sync/api";
import { parseSourceUsfm, sourceUsfmPath, type SourceBookVerses } from "../lib/sourceUsfm";

// A published SOURCE bible (e.g. unfoldingWord/en_ult) for one chapter, read
// straight from Door43 in the browser. In a gateway-language workspace the D1
// ULT/UST roles hold the project's OWN lit/sim texts (BSOJ: ar_avd / ar_nav);
// the English the notes were drafted against lives only in the published
// source repo. Same pattern and same reasoning as useSourceNotes.ts: Door43
// serves raw files with permissive CORS and the CSP already allows
// git.door43.org. The whole book is fetched once and parsed once (usfm-js is
// already bundled), then served per chapter from the module cache.
//
// Read-only by construction: the parsed verses never enter the outbox, the
// chapter payload, or any save path — they are handed to the lane renderer and
// nothing else (issue #430).

export type SourceScriptureStatus = "idle" | "loading" | "ready" | "error";

export interface SourceScripture {
  status: SourceScriptureStatus;
  // Keyed by verse start, the wire shape buildVerseIndex expands.
  verses: Record<number, VerseDto> | undefined;
}

const IDLE: SourceScripture = { status: "idle", verses: undefined };

function rawUrl(org: string, repo: string, path: string): string {
  return `https://git.door43.org/${org}/${repo}/raw/branch/master/${path}`;
}

const cache = new Map<string, Promise<SourceBookVerses>>();

function fetchSourceBook(
  org: string,
  repo: string,
  book: string,
  bibleVersion: string,
): Promise<SourceBookVerses> | null {
  const path = sourceUsfmPath(book);
  if (!path) return null;
  const url = rawUrl(org, repo, path);
  let pending = cache.get(url);
  if (!pending) {
    pending = fetch(url)
      .then((r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.text();
      })
      .then((text) => parseSourceUsfm(text, book, bibleVersion))
      .catch((err) => {
        cache.delete(url); // don't cache failures — allow retry
        throw err;
      });
    cache.set(url, pending);
  }
  return pending;
}

// What the effect has settled, keyed by the source BOOK it belongs to. The
// chapter is picked out at render time, so a chapter change inside a loaded
// book needs no state transition at all (no "loading" flash, no frame where a
// stale chapter's verses sit under the new reference), while a book or source
// change is recognised by the key mismatch and renders as loading until its
// own fetch settles — never as the previous book's text.
interface LoadedBook {
  key: string;
  status: "ready" | "error";
  book?: SourceBookVerses;
}

// `source` is the resolved translationSource projection for the lit role
// ({org, repo}); null — or a null `book` (the caller's way of saying "toggle is
// off") — short-circuits to idle so no fetch fires. `bibleVersion` is only a
// tag stamped on the produced DTOs (never a D1 role).
export function useSourceScripture(
  book: string | null | undefined,
  chapter: number,
  source: { org: string; repo: string } | null,
  bibleVersion: string,
): SourceScripture {
  const key = book && source ? `${source.org}/${source.repo}/${book.toUpperCase()}` : null;
  const [loaded, setLoaded] = useState<LoadedBook | null>(null);
  // Depend on the two strings, not the object, so a caller that builds `source`
  // fresh each render does not refetch on every render.
  const org = source?.org ?? null;
  const repo = source?.repo ?? null;
  useEffect(() => {
    if (!key || !book || org === null || repo === null) return;
    const pending = fetchSourceBook(org, repo, book, bibleVersion);
    if (!pending) {
      setLoaded({ key, status: "error" });
      return;
    }
    let mounted = true;
    pending
      .then((bookVerses) => {
        if (mounted) setLoaded({ key, status: "ready", book: bookVerses });
      })
      .catch(() => {
        if (mounted) setLoaded({ key, status: "error" });
      });
    return () => {
      mounted = false;
    };
  }, [key, book, org, repo, bibleVersion]);

  if (!key) return IDLE;
  if (!loaded || loaded.key !== key) return { status: "loading", verses: undefined };
  if (loaded.status !== "ready" || !loaded.book) return { status: "error", verses: undefined };
  // `loaded.book[chapter]` is a stable reference from the parsed book, so
  // consumers memoising on `verses` don't recompute on every render.
  return { status: "ready", verses: loaded.book[chapter] ?? EMPTY_CHAPTER };
}

const EMPTY_CHAPTER: Record<number, VerseDto> = {};
