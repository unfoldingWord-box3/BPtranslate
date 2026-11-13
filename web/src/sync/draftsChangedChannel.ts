// Tell the other open tabs when the drafts store changed (issue #896).
//
// The drafts database (drafts.ts) is shared by every tab of a workspace, but a
// tab's subscribers (the "N unsaved" chip, the unsaved toasts) only re-read it
// after a change made in that same tab. When tab A saved or discarded a draft,
// tab B kept the old count until a reload. Now drafts.ts posts a "changed"
// message after each committed write or delete, and every other tab re-reads
// the store for its subscribers that opted in (only the count; editors keep
// hearing their own tab's changes only). A received message never posts
// another one, so tabs cannot ping-pong.
//
// The channel is named per workspace (drafts.ts passes workspaceDbName's
// name), as the drafts database is, so one org's drafts never reach a tab open
// on another org.
//
// Where BroadcastChannel is missing or blocked, nothing is sent and the other
// tab keeps its count until a reload, as before. Messages are shape-checked:
// tabs open on different builds may share the channel.
//
// Kept free of IndexedDB / api.ts imports so it can be unit-tested from a plain
// Node script (draftsChangedChannel.test.mjs).

export const DRAFTS_CHANGED_CHANNEL_BASE = "be-drafts-changed";

const MESSAGE_TYPE = "drafts-changed";

/**
 * Wrap the re-read a received message starts. Messages can arrive faster than
 * reads finish, and reads can resolve out of order, so only the newest read
 * started is delivered; an older one landing later would show a stale count.
 * A failed read is logged and dropped (the next message reads again), never
 * left as an unhandled rejection.
 */
export function latestOnly<T>(
  read: () => Promise<T>,
  deliver: (value: T) => void,
  onError: (e: unknown) => void = (e) => console.warn("drafts re-read after another tab's change failed", e),
): () => Promise<void> {
  let seq = 0;
  return async () => {
    const mine = ++seq;
    let value: T;
    try {
      value = await read();
    } catch (e) {
      onError(e);
      return;
    }
    if (mine === seq) deliver(value);
  };
}

interface ChannelLike {
  postMessage(message: unknown): void;
  onmessage: ((event: MessageEvent) => void) | null;
  close(): void;
}

function isDraftsChanged(data: unknown): boolean {
  return (
    !!data &&
    typeof data === "object" &&
    !Array.isArray(data) &&
    (data as { type?: unknown }).type === MESSAGE_TYPE
  );
}

/**
 * Open this tab's channel `name`. `onRemoteChange` hears changes other tabs
 * made (never this channel's own posts); `announce` posts one this tab made.
 * Open one per tab: a second channel in the same tab would hear the first.
 */
export function openDraftsChangedChannel(
  name: string,
  onRemoteChange: () => void,
  make: () => ChannelLike | null = () =>
    typeof BroadcastChannel === "function" ? new BroadcastChannel(name) : null,
): { announce(): void; close(): void } {
  let channel: ChannelLike | null = null;
  try {
    channel = make();
  } catch {
    channel = null;
  }
  if (channel) {
    channel.onmessage = (event) => {
      if (isDraftsChanged(event.data)) onRemoteChange();
    };
  }
  return {
    announce() {
      if (!channel) return;
      try {
        channel.postMessage({ type: MESSAGE_TYPE });
      } catch (e) {
        console.warn("drafts change broadcast failed", e);
      }
    },
    close() {
      channel?.close();
      channel = null;
    },
  };
}
