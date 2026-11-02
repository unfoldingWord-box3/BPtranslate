// React wrapper around openChapterRoom — subscribes to the live event
// stream for {book, chapter} and dispatches typed handlers.
//
// Handlers are held in a ref so the caller can pass fresh closures every
// render without retriggering the WS reconnect. The effect only depends
// on (book, chapter); it tears down the socket on unmount or when the
// chapter changes.

import { useEffect, useRef } from "react";
import { openChapterRoom } from "../sync/wsClient";
import { parseReviewStateSwept, type ReviewStateSweptEvent } from "../lib/reviewStateSweep";
import type { TnRow, TqRow, TwlRow, VerseDto, VerseStatus, LaneCheckState, VerseLaneCheck, CheckLane, LaneReplacementEvent } from "../sync/api";

type RowKind = "tn" | "tq" | "twl";
type AnyRow = TnRow | TqRow | TwlRow;

interface WireEvent {
  type: string;
  kind?: RowKind;
  row?: AnyRow;
  id?: string;
  version?: number;
  verse?: VerseDto;
  status?: VerseStatus;
  check?: LaneCheckState;
  // Lane-check events carry a CheckLane ("text"|"tn"|"tw"|"tq"); lane.replacement
  // events carry a scripture lane ("lit"|"sim"). Typed loosely and narrowed at
  // the dispatch site.
  lane?: string;
  checks?: VerseLaneCheck[];
  book?: string;
  chapter?: number;
  pipeline_type?: string;
  // lane.replacement_freeze / lane.replacement_settled
  jobId?: string;
  predecessorGeneration?: number;
  activeGeneration?: number;
  configRevision?: number;
}

export interface UseChapterRoomHandlers {
  onUpsert: (kind: RowKind, row: AnyRow) => void;
  onDelete: (kind: RowKind, id: string) => void;
  onVerseUpdate: (verse: VerseDto) => void;
  onVerseStatusUpdate: (status: VerseStatus) => void;
  onLaneCheckUpdate: (check: LaneCheckState) => void;
  onLaneCheckBulkUpdate: (lane: CheckLane, checks: VerseLaneCheck[]) => void;
  // An AI pipeline wrote rows into this chapter out of band — the row list is
  // stale. Optional: tabs that don't care (or aren't this chapter) can ignore it.
  onPipelineApplied?: (book: string, chapter: number, pipelineType: string) => void;
  // An admin bulk-set this chapter's review state (#296/#395) — the rows'
  // translation_state is stale; content and version are not. Optional.
  onReviewStateSwept?: (event: ReviewStateSweptEvent) => void;
  // A scripture lane froze for a replacement — quarantine queued edits for the
  // lane's bible_version and stop editing it. Optional.
  onLaneFreeze?: (event: LaneReplacementEvent) => void;
  // The replacement settled (activated / cancelled / failed) — refresh config +
  // chapter. Optional.
  onLaneSettled?: (event: LaneReplacementEvent) => void;
}

export function useChapterRoom(
  book: string,
  // null = no room (lets a caller subscribe conditionally without breaking
  // the rules of hooks).
  chapter: number | null,
  handlers: UseChapterRoomHandlers,
): void {
  const handlersRef = useRef(handlers);
  useEffect(() => {
    handlersRef.current = handlers;
  }, [handlers]);

  useEffect(() => {
    if (chapter === null) return;
    const cleanup = openChapterRoom(book, chapter, {
      onEvent: (raw) => {
        const ev = raw as WireEvent | null;
        if (!ev || typeof ev.type !== "string") return;
        if (ev.type === "row.upserted" && ev.kind && ev.row) {
          handlersRef.current.onUpsert(ev.kind, ev.row);
          return;
        }
        if (ev.type === "row.deleted" && ev.kind && typeof ev.id === "string") {
          handlersRef.current.onDelete(ev.kind, ev.id);
          return;
        }
        if (ev.type === "verse.updated" && ev.verse) {
          handlersRef.current.onVerseUpdate(ev.verse);
          return;
        }
        if (ev.type === "verse_status.updated" && ev.status) {
          handlersRef.current.onVerseStatusUpdate(ev.status);
          return;
        }
        if (ev.type === "lane_check.updated" && ev.check) {
          handlersRef.current.onLaneCheckUpdate(ev.check);
          return;
        }
        if (ev.type === "lane_check.bulk" && ev.lane && Array.isArray(ev.checks)) {
          handlersRef.current.onLaneCheckBulkUpdate(ev.lane as CheckLane, ev.checks);
          return;
        }
        if (
          (ev.type === "lane.replacement_freeze" || ev.type === "lane.replacement_settled") &&
          (ev.lane === "lit" || ev.lane === "sim") &&
          typeof ev.jobId === "string"
        ) {
          const rawStatus = (ev as unknown as { status?: unknown }).status;
          const detail: LaneReplacementEvent = {
            lane: ev.lane,
            jobId: ev.jobId,
            predecessorGeneration: ev.predecessorGeneration ?? 0,
            activeGeneration: ev.activeGeneration ?? 0,
            configRevision: ev.configRevision ?? 0,
            status: typeof rawStatus === "string" ? rawStatus : "",
          };
          if (ev.type === "lane.replacement_freeze") handlersRef.current.onLaneFreeze?.(detail);
          else handlersRef.current.onLaneSettled?.(detail);
          return;
        }
        if (
          ev.type === "chapter.pipeline_applied" &&
          typeof ev.book === "string" &&
          typeof ev.chapter === "number" &&
          typeof ev.pipeline_type === "string"
        ) {
          handlersRef.current.onPipelineApplied?.(ev.book, ev.chapter, ev.pipeline_type);
          return;
        }
        const swept = parseReviewStateSwept(ev);
        if (swept) {
          handlersRef.current.onReviewStateSwept?.(swept);
          return;
        }
      },
    });
    return cleanup;
  }, [book, chapter]);
}
