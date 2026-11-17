// The refused-save conflict of one row, for the classic note and question
// editors (#892). One outbox subscription is shared by every card on screen,
// rather than one IndexedDB read per card; each card reads its own row's view
// through useSyncExternalStore and re-renders only when that view changes.
//
// Known limit: the outbox notifies only the tab that changed it, so a
// conflict another tab's drain produced shows here on this tab's next outbox
// change (the status bar has the same limit).

import { useCallback, useSyncExternalStore } from "react";
import type { RowKind } from "../sync/api";
import { outbox, type OutboxOp, type RowTarget } from "../sync/outbox";
import { rowConflictView, type RowConflictView } from "../sync/rowConflictView";
import { targetKey } from "../sync/outboxTargeting";

let ops: OutboxOp[] = [];
let started = false;
const listeners = new Set<() => void>();
// Per row: the last view handed out and its signature, so an unchanged view
// keeps its identity and useSyncExternalStore does not re-render the card.
const views = new Map<string, { sig: string; view: RowConflictView | null }>();

function signature(v: RowConflictView | null): string {
  return v ? JSON.stringify([v.opId, v.theirsVersion, v.mine, v.fields, v.sending]) : "";
}

function viewFor(target: RowTarget): RowConflictView | null {
  const key = targetKey(target);
  const next = rowConflictView(ops, target);
  const sig = signature(next);
  const prev = views.get(key);
  if (prev && prev.sig === sig) return prev.view;
  views.set(key, { sig, view: next });
  return next;
}

function start() {
  if (started) return;
  started = true;
  outbox.subscribe((all) => {
    ops = all;
    for (const l of listeners) l();
  });
}

export function useRowConflict(rowKind: RowKind, id: string, book: string): RowConflictView | null {
  const subscribe = useCallback((fn: () => void) => {
    start();
    listeners.add(fn);
    return () => {
      listeners.delete(fn);
    };
  }, []);
  const get = useCallback(() => viewFor({ kind: "row", rowKind, id, book }), [rowKind, id, book]);
  return useSyncExternalStore(subscribe, get);
}
