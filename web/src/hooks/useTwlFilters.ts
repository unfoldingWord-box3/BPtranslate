import { useEffect, useState } from "react";
import { api } from "../sync/api";
import { twlFilterKey } from "../lib/hebrew";

// Per-book TWL suggestion deny-lists, used by Shell to suppress suggestions
// translators already rejected upstream:
//   isUnlinked(orig, twLink)        — (word, article) must never be linked, anywhere
//   isDeletedHere(reference, orig)  — this reference+quote was deleted (any article)
//
// Both compare on the consonant-only fold (twlFilterKey) so pointing/separator
// drift between the stored deny-list and a freshly resolved quote never splits
// a match. Mirrors useCatalogs' stale-while-revalidate shape, but keyed by book
// (the deleted list is book-scoped).

export interface TwlFilters {
  isUnlinked: (origWords: string, twLink: string) => boolean;
  isDeletedHere: (reference: string, origWords: string) => boolean;
  // True once the fetch has resolved OR failed. Suggestions hold off rendering
  // until this flips so a blocked link can't briefly show (and be added) before
  // the deny-list arrives. On failure it still flips true → fail open (show all)
  // rather than hiding every suggestion for the session on a filters outage.
  settled: boolean;
}

interface FilterSets {
  unlinked: Set<string>; // `${filterKey}|${twLink}`
  deleted: Set<string>; // `${reference}|${filterKey}`
}

const EMPTY: FilterSets = { unlinked: new Set(), deleted: new Set() };

// One cache + one in-flight promise per book; subscribers refresh on resolve.
const cache = new Map<string, FilterSets>();
const inflight = new Map<string, Promise<FilterSets>>();
const subscribers = new Map<string, Set<(f: FilterSets) => void>>();

function load(book: string): Promise<FilterSets> {
  const existing = inflight.get(book);
  if (existing) return existing;
  const p = api
    .getTwlFilters(book)
    .then((r) => {
      const sets: FilterSets = {
        unlinked: new Set(r.unlinked.map((u) => `${twlFilterKey(u.normOrigWords)}|${u.twLink}`)),
        deleted: new Set(r.deleted.map((d) => `${d.reference}|${twlFilterKey(d.normOrigWords)}`)),
      };
      cache.set(book, sets);
      inflight.delete(book);
      subscribers.get(book)?.forEach((s) => s(sets));
      return sets;
    })
    .catch((err) => {
      // Don't cache the rejection — retry on next mount rather than leaving the
      // deny-list empty for the whole session.
      inflight.delete(book);
      throw err;
    });
  inflight.set(book, p);
  return p;
}

export function useTwlFilters(book: string): TwlFilters {
  const [sets, setSets] = useState<FilterSets>(() => cache.get(book) ?? EMPTY);
  // Already-cached books are settled synchronously; otherwise the fetch flips it.
  const [settled, setSettled] = useState<boolean>(() => cache.has(book));

  useEffect(() => {
    let mounted = true;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- seed from the module-level cache on a book change before subscribing to it, so the previous book's filters never apply to the new book while load() resolves.
    setSets(cache.get(book) ?? EMPTY);
    setSettled(cache.has(book));
    load(book)
      .then((f) => {
        if (mounted) {
          setSets(f);
          setSettled(true);
        }
      })
      .catch(() => {
        // Fail open: mark settled so suggestions render (un-filtered) instead of
        // staying hidden for the session on a filters-fetch outage.
        if (mounted) setSettled(true);
      });
    let subs = subscribers.get(book);
    if (!subs) {
      subs = new Set();
      subscribers.set(book, subs);
    }
    subs.add(setSets);
    return () => {
      mounted = false;
      subscribers.get(book)?.delete(setSets);
    };
  }, [book]);

  return {
    settled,
    isUnlinked: (origWords, twLink) =>
      sets.unlinked.has(`${twlFilterKey(origWords)}|${twLink}`),
    isDeletedHere: (reference, origWords) =>
      sets.deleted.has(`${reference}|${twlFilterKey(origWords)}`),
  };
}
