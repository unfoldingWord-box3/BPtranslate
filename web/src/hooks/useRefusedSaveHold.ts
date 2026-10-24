// A row editor's hold on the text of its refused saves (refusedSaveHold.ts,
// issue #637 item 1).
//   * `noteSave(patch, version)`: call with the exact patch a Save hands to the
//     outbox and the row version it is sent at.
//   * In the effect that reconciles fields with a changed row: call
//     `rowChanged(row.version)` once, then `decide(field, local, released)` per
//     field ("keep" the local text, "adopt" the row's new value, or
//     "reconcile" as usual). `local` is in the form the Save sends.
//   * `onRelease` runs when the user discards a held save or the row's draft,
//     with the fields still held, so the editor can put the row's value back in
//     each field still showing them.

import { useCallback, useEffect, useLayoutEffect, useRef } from "react";
import { onOutboxDrop, onOutboxResult } from "../sync/outbox";
import { onDraftDiscarded, rowKey } from "../sync/drafts";
import type { RowKind } from "../sync/api";
import {
  EMPTY_HOLD,
  holdDecision,
  holdOnDraftDiscard,
  holdOnDrop,
  holdOnResult,
  holdOnRowVersion,
  holdOnSave,
  type Fields,
  type HoldState,
} from "../sync/refusedSaveHold";

export function useRefusedSaveHold(
  rowKind: RowKind,
  id: string,
  book: string,
  onRelease: (released: Fields) => void,
) {
  const stateRef = useRef<HoldState>(EMPTY_HOLD);
  const onReleaseRef = useRef(onRelease);
  useLayoutEffect(() => {
    onReleaseRef.current = onRelease;
  });

  useEffect(() => {
    stateRef.current = EMPTY_HOLD;
    const target = { rowKind, id, book };
    const key = rowKey(rowKind, book, id);
    const offResult = onOutboxResult((op, result) => {
      stateRef.current = holdOnResult(stateRef.current, op, result, target);
    });
    const offDrop = onOutboxDrop((op) => {
      const { state, released } = holdOnDrop(stateRef.current, op, target);
      stateRef.current = state;
      if (released) onReleaseRef.current(released);
    });
    const offDiscard = onDraftDiscarded((k) => {
      if (k !== key) return;
      const { state, released } = holdOnDraftDiscard(stateRef.current);
      stateRef.current = state;
      for (const f of released) onReleaseRef.current(f);
    });
    return () => {
      offResult();
      offDrop();
      offDiscard();
    };
  }, [rowKind, id, book]);

  const noteSave = useCallback((patch: Fields, version: number) => {
    stateRef.current = holdOnSave(stateRef.current, patch, version);
  }, []);
  const rowChanged = useCallback((version: number): Fields[] => {
    const { state, released } = holdOnRowVersion(stateRef.current, version);
    stateRef.current = state;
    return released;
  }, []);
  const decide = useCallback(
    (field: string, local: unknown, released: Fields[]) => holdDecision(stateRef.current, released, field, local),
    [],
  );
  return { noteSave, rowChanged, decide };
}
