// Tell the other open tabs when a prefs draft (Brief, Instructions, Common
// issues; #909) was discarded or saved (issue #913 review A1/A2).
//
// The drafts store is shared by every tab of a workspace, and an editor that
// still shows typed text writes its draft again when another tab deletes it
// (#913 item 1). The drafts-changed message carries no key or reason, so on
// its own a tab could not tell "thrown away" or "saved" from "deleted by
// mistake". Two messages, by key:
// - prefs-discard: the user discarded this draft, whose text was `text`. A tab
//   showing exactly that text puts the server's text back, as the discarding
//   tab does, and writes nothing; a tab showing other typing keeps it (round
//   2, B3).
// - prefs-saved: `row` is the prefs row the save returned. Every tab takes it
//   as its prefs row, so it never holds the new version with an old row (B1),
//   and an editor whose typed boxes hold the saved text is clean.
// The sender posts before it deletes the record, so a receiving tab has
// settled before it can see the record missing.
//
// The channel is named per workspace (drafts.ts passes workspaceDbName's
// name), as the drafts database is. Where BroadcastChannel is missing or
// blocked, nothing is sent. Messages are shape-checked: tabs open on different
// builds may share the channel.
//
// Kept free of IndexedDB / api.ts imports so it can be unit-tested from a plain
// Node script (prefsDraftChannel.test.mjs).

export const PREFS_DRAFT_CHANNEL_BASE = "be-prefs-draft";

type Fields = Record<string, string | null>;

export type PrefsDraftMessage =
  | { type: "prefs-discard"; key: string; text: Fields }
  | { type: "prefs-saved"; key: string; row: Record<string, unknown> & { version: number } };

interface ChannelLike {
  postMessage(message: unknown): void;
  onmessage: ((event: MessageEvent) => void) | null;
  close(): void;
}

function isFields(v: unknown): v is Fields {
  if (!v || typeof v !== "object" || Array.isArray(v)) return false;
  return Object.values(v).every((x) => x === null || typeof x === "string");
}

export function parsePrefsDraftMessage(data: unknown): PrefsDraftMessage | null {
  if (!data || typeof data !== "object" || Array.isArray(data)) return null;
  const d = data as Record<string, unknown>;
  if (typeof d.key !== "string" || !d.key.startsWith("prefs:")) return null;
  if (d.type === "prefs-discard" && isFields(d.text)) return { type: "prefs-discard", key: d.key, text: d.text };
  const row = d.row as Record<string, unknown> | undefined;
  if (d.type === "prefs-saved" && row && typeof row === "object" && !Array.isArray(row) && Number.isInteger(row.version)) {
    return { type: "prefs-saved", key: d.key, row: row as Record<string, unknown> & { version: number } };
  }
  return null;
}

/**
 * Open this tab's channel `name`. `onRemote` hears messages other tabs posted
 * (never this channel's own); `announce` posts one. Open one per tab: a second
 * channel in the same tab would hear the first.
 */
export function openPrefsDraftChannel(
  name: string,
  onRemote: (message: PrefsDraftMessage) => void,
  make: () => ChannelLike | null = () =>
    typeof BroadcastChannel === "function" ? new BroadcastChannel(name) : null,
): { announce(message: PrefsDraftMessage): void; close(): void } {
  let channel: ChannelLike | null = null;
  try {
    channel = make();
  } catch {
    channel = null;
  }
  if (channel) {
    channel.onmessage = (event) => {
      const m = parsePrefsDraftMessage(event.data);
      if (m) onRemote(m);
    };
  }
  return {
    announce(message) {
      if (!channel) return;
      try {
        channel.postMessage(message);
      } catch (e) {
        console.warn("prefs draft broadcast failed", e);
      }
    },
    close() {
      channel?.close();
      channel = null;
    },
  };
}
