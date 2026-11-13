// Tell the other open tabs when a row op is thrown away (issue #637 item 3).
//
// outbox.drop() (Discard of a failed or conflicted save, keep theirs) tells
// only the tab it runs in, but a tab that typed the save may be another one:
// any tab can show the shared outbox's conflicts and failures. That tab kept
// the thrown-away text as its cached row until a reload. The dropping tab now
// posts the op's id, row, action, patch and 409 row on a BroadcastChannel;
// each other tab re-reads the row (rowRebuild.ts), and its editors end their
// tracking of that save (onOpDropped in outbox.ts), as a local Discard does.
// The drafts store is shared, so the dropping tab already settled the row's
// draft.
//
// The channel is named per workspace (outbox.ts passes workspaceDbName's
// name), as the outbox and drafts databases are, so one org's discards never
// reach a tab open on another org.
//
// Where BroadcastChannel is missing or blocked, nothing is sent and the other
// tab keeps its copy until a reload, as before. Messages are shape-checked:
// tabs open on different builds may share the channel.
//
// Kept free of IndexedDB / api.ts imports so it can be unit-tested from a plain
// Node script (rowRebuild.test.mjs).

import type { OutboxOp, RowTarget } from "./outbox.ts";

export const ROW_DROP_CHANNEL_BASE = "be-row-drop";

/** A row op another tab dropped: what this tab needs to treat it as its own drop. */
export interface RowDrop {
  id: string;
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

const ROW_KINDS = new Set(["tn", "tq", "twl"]);

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

function parseRowDrop(data: unknown): RowDrop | null {
  if (!isPlainObject(data)) return null;
  const d = data as Partial<RowDrop>;
  const t = d.target as Partial<RowTarget> | undefined;
  if (!isPlainObject(t) || t.kind !== "row" || !ROW_KINDS.has(t.rowKind as string)) return null;
  if (typeof t.id !== "string" || typeof t.book !== "string") return null;
  if (typeof d.id !== "string") return null;
  if (d.action !== "patch" && d.action !== "delete") return null;
  if (!isPlainObject(d.patch)) return null;
  return {
    id: d.id,
    target: { kind: "row", rowKind: t.rowKind!, id: t.id, book: t.book },
    action: d.action,
    patch: d.patch,
    conflictCurrent: d.conflictCurrent,
  };
}

/**
 * Open this tab's channel `name`. `onRemoteDrop` hears row ops other tabs
 * dropped (never this channel's own posts); `announce` posts one this tab
 * dropped. Open one per tab: a second channel in the same tab would hear the
 * first.
 */
export function openRowDropChannel(
  name: string,
  onRemoteDrop: (drop: RowDrop) => void,
  make: () => ChannelLike | null = () =>
    typeof BroadcastChannel === "function" ? new BroadcastChannel(name) : null,
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
        id: op.id,
        target: op.target,
        action: op.action,
        patch: isPlainObject(op.patch) ? op.patch : {},
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
