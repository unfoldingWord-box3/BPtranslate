// A row editor's hold on the text of its refused saves (refusedSaveHold.ts,
// issue #637 item 1). Call `noteSave(patch)` with the exact patch a Save hands
// to the outbox, and check `keepsHeld(field, local)` before a field adopts a
// new row value. `onRelease` runs when the user discards a held save, with the
// patch it sent, so the editor can put the row's value back in each field
// still showing it.

import { useCallback, useEffect, useLayoutEffect, useRef } from "react";
import { onOutboxDrop, onOutboxResult } from "../sync/outbox";
import {
  EMPTY_HOLD,
  holdOnDrop,
  holdOnResult,
  holdOnSave,
  keepsHeldText,
  type Fields,
  type HoldState,
} from "../sync/refusedSaveHold";

export function useRefusedSaveHold(
  rowKind: string,
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
    const offResult = onOutboxResult((op, result) => {
      stateRef.current = holdOnResult(stateRef.current, op, result, target);
    });
    const offDrop = onOutboxDrop((op) => {
      const { state, released } = holdOnDrop(stateRef.current, op, target);
      stateRef.current = state;
      if (released) onReleaseRef.current(released);
    });
    return () => {
      offResult();
      offDrop();
    };
  }, [rowKind, id, book]);

  const noteSave = useCallback((patch: Fields) => {
    stateRef.current = holdOnSave(stateRef.current, patch);
  }, []);
  const keepsHeld = useCallback(
    (field: string, local: unknown) => keepsHeldText(stateRef.current, field, local),
    [],
  );
  return { noteSave, keepsHeld };
}
