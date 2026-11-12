// Tell the other open tabs when a row op is thrown away (issue #637 item 3).
//
// outbox.drop() (Discard of a failed or conflicted save, keep theirs) tells
// only the tab it runs in, but a tab that typed the save may be another one:
// any tab can show the shared outbox's conflicts and failures. That tab kept
// the thrown-away text as its cached row until a reload. The dropping tab now
// posts the op's row, action, patch and 409 row on a BroadcastChannel; each
// other tab re-reads the row (rowRebuild.ts) and its row editors end their
// hold on that save (useRefusedSaveHold), as a local Discard does. The drafts
// store is shared, so the dropping tab already settled the row's draft.
//
// Where BroadcastChannel is missing or blocked, nothing is sent and the other
// tab keeps its copy until a reload, as before. Messages are shape-checked:
// tabs open on different builds may share the channel.
//
// Kept free of IndexedDB / api.ts imports so it can be unit-tested from a plain
// Node script (rowRebuild.test.mjs).

import type { OutboxOp, RowTarget } from "./outbox.ts";

export const ROW_DROP_CHANNEL = "be-row-drop";

/** A row op another tab dropped: what this tab needs to treat it as its own drop. */
export interface RowDrop {
  target: RowTarget;
  action: OutboxOp["action"];
  patch: OutboxOp["patch"];
  conflictCurrent?: unknown;
}

interface ChannelLike {
  postMessage(message: unknown): void;
  onmessage: ((event: MessageEvent) => void) | null;
  close(): void;
}

function defaultChannel(): ChannelLike | null {
  return typeof BroadcastChannel === "function" ? new BroadcastChannel(ROW_DROP_CHANNEL) : null;
}

const ROW_KINDS = new Set(["tn", "tq", "twl"]);

function parseRowDrop(data: unknown): RowDrop | null {
  const d = data as Partial<RowDrop> | null;
  const t = d?.target as Partial<RowTarget> | undefined;
  if (!t || t.kind !== "row" || !ROW_KINDS.has(t.rowKind as string)) return null;
  if (typeof t.id !== "string" || typeof t.book !== "string") return null;
  if (d!.action !== "patch" && d!.action !== "delete") return null;
  const patch = d!.patch && typeof d!.patch === "object" ? d!.patch : {};
  return {
    target: { kind: "row", rowKind: t.rowKind!, id: t.id, book: t.book },
    action: d!.action,
    patch,
    conflictCurrent: d!.conflictCurrent,
  };
}

/**
 * Open this tab's channel. `onRemoteDrop` hears row ops other tabs dropped
 * (never this channel's own posts); `announce` posts one this tab dropped.
 * Open one per tab: a second channel in the same tab would hear the first.
 */
export function openRowDropChannel(
  onRemoteDrop: (drop: RowDrop) => void,
  make: () => ChannelLike | null = defaultChannel,
): { announce(op: OutboxOp): void; close(): void } {
  let channel: ChannelLike | null = null;
  try {
    channel = make();
  } catch {
    channel = null;
  }
  if (channel) {
    channel.onmessage = (event) => {
      const drop = parseRowDrop(event.data);
      if (drop) onRemoteDrop(drop);
    };
  }
  return {
    announce(op) {
      if (!channel || op.target.kind !== "row") return;
      const message: RowDrop = {
        target: op.target,
        action: op.action,
        patch: op.patch,
        conflictCurrent: op.conflictCurrent,
      };
      try {
        channel.postMessage(message);
      } catch (e) {
        console.warn("row drop broadcast failed", e);
      }
    },
    close() {
      channel?.close();
      channel = null;
    },
  };
}
