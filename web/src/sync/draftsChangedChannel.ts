// Tell the other open tabs when the drafts store changed (issue #896).
//
// The drafts database (drafts.ts) is shared by every tab of a workspace, but a
// tab's subscribers (the "N unsaved" chip, the unsaved toasts) only re-read it
// after a change made in that same tab. When tab A saved or discarded a draft,
// tab B kept the old count until a reload. Now drafts.ts posts a "changed"
// message after each committed write or delete, and every other tab re-reads
// the store for its subscribers that opted in (the count, and the prefs
// editors, which only check that their own draft is still stored, #913; other
// editors keep hearing their own tab's changes only). A received message never posts
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
 * Deliver store reads to subscribers in the order the reads started. drafts.ts
 * starts a read for each local change (to every subscriber), for each message
 * from another tab (to the subscribers that opted in) and on subscribe (to the
 * new one). Reads can resolve out of order, and the count hears both local and
 * remote reads, so an older read landing after a newer one would put back an
 * older list. Every read takes the next number when it starts; a subscriber
 * gets a result only if it is newer than the last one that subscriber got. A
 * failed read is logged, delivers nothing and changes no subscriber's last
 * number, so it never holds back an older read that succeeds.
 */
export function orderedReads<T>(
  onError: (e: unknown) => void = (e) => console.warn("drafts read failed", e),
): (read: () => Promise<T>, targets: Iterable<(value: T) => void>) => Promise<void> {
  let seq = 0;
  const lastDelivered = new WeakMap<(value: T) => void, number>();
  return async (read, targets) => {
    const mine = ++seq;
    let value: T;
    try {
      value = await read();
    } catch (e) {
      onError(e);
      return;
    }
    for (const s of targets) {
      if ((lastDelivered.get(s) ?? 0) >= mine) continue;
      lastDelivered.set(s, mine);
      s(value);
    }
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
