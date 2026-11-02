import { useEffect, useSyncExternalStore } from "react";

// Which drafts have their editor on screen right now (#372). Each flows editor
// publishes the draft keys of what it is currently showing (the selected
// verse's lanes, the selected note or question, the open article's parts, the
// open template), and the flows unsaved-drafts toast stays quiet only for
// those. A draft whose editor was paged away from (Next verse, next card,
// another article or template) gets its reminder even on the same screen and
// chapter. An editor that does not publish errs toward showing the toast.

const shown = new Map<string, number>();
const subscribers = new Set<() => void>();
let version = 0;

function emit() {
  version++;
  for (const s of subscribers) s();
}

// Mark these draft keys' editors as showing; call the returned function when
// they stop showing. Counted, so two holders of one key both must release.
export function showDraftEditors(keys: readonly string[]): () => void {
  if (keys.length === 0) return () => {};
  for (const k of keys) shown.set(k, (shown.get(k) ?? 0) + 1);
  emit();
  let released = false;
  return () => {
    if (released) return;
    released = true;
    for (const k of keys) {
      const n = (shown.get(k) ?? 0) - 1;
      if (n <= 0) shown.delete(k);
      else shown.set(k, n);
    }
    emit();
  };
}

export function isDraftEditorShown(key: string): boolean {
  return shown.has(key);
}

export function subscribeDraftEditors(cb: () => void): () => void {
  subscribers.add(cb);
  return () => {
    subscribers.delete(cb);
  };
}

export function draftEditorsVersion(): number {
  return version;
}

// For editors: publish `keys` while mounted and while they are unchanged.
export function useShowDraftEditors(keys: readonly string[]): void {
  const joined = keys.join("\n");
  useEffect(() => showDraftEditors(joined ? joined.split("\n") : []), [joined]);
}

// For readers: re-render whenever the set of showing editors changes.
export function useDraftEditorsVersion(): number {
  return useSyncExternalStore(subscribeDraftEditors, draftEditorsVersion);
}
