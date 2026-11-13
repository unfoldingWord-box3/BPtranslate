// Tell the other open tabs when the drafts store changed (issue #896).
//
// The drafts database (drafts.ts) is shared by every tab of a workspace, but a
// tab's subscribers (the "N unsaved" chip, the unsaved toasts) only re-read it
// after a change made in that same tab. When tab A saved or discarded a draft,
// tab B kept the old count until a reload. Now drafts.ts posts a "changed"
// message after each committed write or delete, and every other tab re-reads
// the store and tells its own subscribers. A received message never posts
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
