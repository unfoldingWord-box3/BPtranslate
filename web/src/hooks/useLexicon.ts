// Module-level lexicon cache: each unique Strong's key is fetched at most
// once per page load. Components subscribe via useLexicon, which batches
// requested strongs into a single GET /api/lexicon?strongs=... call.
//
// The in-memory `cache` Map is mirrored to IndexedDB via lexiconCache.ts so
// F5 (or reload while offline) still renders tooltips and resource cards
// without hitting the network.

import { useEffect, useState } from "react";

import { lexiconKeys } from "../lib/lexiconKeys";
import { getEntries as getCachedEntries, putEntries as putCachedEntries } from "../sync/lexiconCache";

export interface LexiconEntry {
  strong: string;
  resource: "uhal" | "ugl";
  lemma: string | null;
  part_of_speech: string | null;
  gloss: string | null;
  definition: string | null;
}

const cache = new Map<string, LexiconEntry | null>();
const inFlight = new Set<string>();
const subscribers = new Set<() => void>();

async function ensure(rawStrongs: string[]) {
  const candidates: string[] = [];
  for (const s of rawStrongs) {
    for (const k of lexiconKeys(s)) {
      if (cache.has(k) || inFlight.has(k)) continue;
      // Claimed BEFORE the IndexedDB await below, so a second caller in the
      // same tick (React StrictMode's double effect, two components mounting
      // together) skips these keys instead of sending the same batch again.
      inFlight.add(k);
      candidates.push(k);
    }
  }
  if (candidates.length === 0) return;

  let want: string[] = [];
  try {
    // Try the persistent cache first — every IDB hit is one less network
    // call, and the only path that works while offline.
    const cached = await getCachedEntries(candidates);
    for (const [k, entry] of cached) {
      cache.set(k, entry);
    }
    want = candidates.filter((k) => !cache.has(k));
    if (cached.size > 0) {
      for (const fn of subscribers) fn();
    }
    if (want.length === 0) return;

    const url = `/api/lexicon?strongs=${encodeURIComponent(want.join(","))}`;
    const res = await fetch(url);
    // A 400/5xx is not an answer: caching its misses would turn every key
    // into a permanent null (memory + IndexedDB). Release them for a retry.
    if (!res.ok) return;
    const data = (await res.json()) as { entries?: LexiconEntry[] };
    const byStrong = new Map((data.entries ?? []).map((e) => [e.strong, e]));
    const fresh = new Map<string, LexiconEntry | null>();
    for (const k of want) {
      const entry = byStrong.get(k) ?? null;
      cache.set(k, entry);
      fresh.set(k, entry);
    }
    // Persist for next reload. Includes nulls so an explicit "we asked, no
    // such Strong's" answer is remembered too.
    void putCachedEntries(fresh);
  } catch {
    // Network failure (offline, fetch threw, server down) — don't poison the
    // in-memory cache with nulls so a later online retry can succeed.
  } finally {
    for (const k of candidates) inFlight.delete(k);
    if (want.length > 0) for (const fn of subscribers) fn();
  }
}

// Subscribe to lexicon updates for the given raw Strong's. Returns a map
// keyed by the *input* raw form so callers can look up by what they have.
export function useLexicon(rawStrongs: string[]): Map<string, LexiconEntry | null> {
  const [, force] = useState(0);
  const joined = rawStrongs.join(",");
  useEffect(() => {
    void ensure(rawStrongs);
    const fn = () => force((t) => t + 1);
    subscribers.add(fn);
    return () => {
      subscribers.delete(fn);
    };
    // joined captures the set of strongs; rawStrongs identity is irrelevant.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [joined]);
  const out = new Map<string, LexiconEntry | null>();
  for (const raw of rawStrongs) {
    const keys = lexiconKeys(raw);
    let hit: LexiconEntry | null = null;
    for (const k of keys) {
      const v = cache.get(k);
      if (v) {
        hit = v;
        break;
      }
    }
    out.set(raw, hit);
  }
  return out;
}
