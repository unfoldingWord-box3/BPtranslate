// Which spec uses which ZEC chapter, and why (#891).
//
// Every concurrency spec runs against the same seeded ZEC book. A spec that
// writes to a chapter, or that relies on global-setup's seed state for one,
// collides with any other spec that picks the same chapter: #835 seeded ZEC 13's
// notes as AI drafts for notes-rapid-lanes, which made them read-only in the
// classic editor, and a spec written earlier on ZEC 13 then timed out in all six
// cases with no clear message.
//
// So the chapter numbers live only here. One entry per chapter; its `specs`
// list names every file allowed to use it (the first is the one that writes or
// owns the seed state; the rest say why they can share in `why`). A spec reads
// its chapter as `ZEC_CHAPTERS.<key>.chapter`, never as a number.
//
// web/src/lib/concurrencyChapters.test.mjs (run by `npm --workspace web run test`)
// fails when:
//   - two entries name the same chapter,
//   - a file in tests/concurrency uses a ZEC chapter number outside this file,
//   - a file uses an entry whose `specs` list does not name it,
//   - a `specs` list names a file that does not exist,
//   - a *.spec.ts that mentions ZEC is in no entry's `specs`.
//
// To give a new spec a chapter: add an entry on a chapter no entry uses. To
// share one: add the spec to that entry's `specs` and say in `why` why it is safe.
//
// Keep this file free of imports and of TypeScript-only runtime syntax (no
// enums): the node unit test loads it with --experimental-strip-types.

export type ChapterClaim = {
  readonly chapter: number;
  /** Spec files (basenames in tests/concurrency) allowed to use this chapter. */
  readonly specs: readonly string[];
  readonly why: string;
  /** Seed state global-setup applies to this chapter on every run. */
  readonly seed?: "ai_draft";
};

export const ZEC_CHAPTERS = {
  readOnly: {
    chapter: 1,
    specs: [
      "notes-ult-alignment.spec.ts",
      "verse-view-layout.spec.ts",
      "verse-view-article-inplace.spec.ts",
      "legacy-flow-redirects.spec.ts",
      "rtl-direction.spec.ts",
      "ws-first-load.spec.ts",
    ],
    why:
      "Read-only screens: ULT alignment hover (ZEC 1:1 has 16 Hebrew words), verse view, " +
      "route landmarks, the classic chapter view. No spec writes here.",
  },
  crossTabDrafts: {
    chapter: 2,
    specs: ["cross-tab-drafts-count.spec.ts"],
    why:
      "Two tabs: one types a tQ question or a ULT verse draft (2:1) and discards it from the " +
      "unsaved menu, the other checks its unsaved count. Nothing is saved to the server.",
  },
  rapidCheck: {
    chapter: 3,
    specs: ["notes-rapid-check.spec.ts", "notes-rapid-columns.spec.ts"],
    why:
      "notes-rapid-check saves and approves notes, so the notes are seeded as AI drafts. " +
      "notes-rapid-columns only reads it.",
    seed: "ai_draft",
  },
  rapidBulk: {
    chapter: 4,
    specs: ["notes-rapid-bulk.spec.ts"],
    why: "Bulk approve / Not needed / Undo; the notes are seeded as AI drafts.",
    seed: "ai_draft",
  },
  crossTabDiscard: {
    chapter: 5,
    specs: ["cross-tab-discard.spec.ts"],
    why: "Two tabs edit the same tQ and tN rows and one discards.",
  },
  shared: {
    chapter: 6,
    specs: [
      "global-setup.ts",
      "s1-adjacent-verses.spec.ts",
      "s2-same-verse.spec.ts",
      "s5-version-mismatch.spec.ts",
      "s6-realtime-push.spec.ts",
      "s7-offline-resilience.spec.ts",
      "s8-trash-restore.spec.ts",
      "s9-stranded-outbox.spec.ts",
      "chat-edit-race.spec.ts",
      "flows-unsaved-toast.spec.ts",
      "phone-header-title.spec.ts",
      "legacy-flow-redirects.spec.ts",
      // These three reach it through global-setup's RTL_FIXTURE.
      "rtl-direction.spec.ts",
      "notes-arabic-size.spec.ts",
      "ws-first-load.spec.ts",
    ],
    why:
      "The original save-race chapter: the s* specs race edits on ZEC 6:1 notes, one at a time " +
      "(one Playwright worker). global-setup's RTL fixture rewrites ULT 6:1 as Arabic and note " +
      "f66i (6:11) as Arabic, which nothing else writes.",
  },
  offline: {
    chapter: 7,
    specs: ["s7-offline-resilience.spec.ts"],
    why: "The second s7 case edits a ZEC 7:1 note offline.",
  },
  keepsTextAway: {
    chapter: 8,
    specs: ["refused-save-keeps-text.spec.ts"],
    why: "Only visited (8:2) to unmount refused-save-keeps-text's chapter; never written.",
  },
  keepsText: {
    chapter: 9,
    specs: ["refused-save-keeps-text.spec.ts", "typeback-during-pending-save.spec.ts"],
    why:
      "refused-save-keeps-text writes a tQ row here. typeback-during-pending-save only visits " +
      "9:2 to unmount its own chapter, and never edits here.",
  },
  typeback: {
    chapter: 10,
    specs: ["typeback-during-pending-save.spec.ts"],
    why: "Types into a tN row while its save is held.",
  },
  rebuildsRow: {
    chapter: 11,
    specs: ["refused-save-rebuilds-row.spec.ts"],
    why: "Refused saves on tQ and tN rows here.",
  },
  reenablesSave: {
    chapter: 12,
    specs: ["refused-save-reenables-save.spec.ts"],
    why: "A refused save then a real one on a tN row here.",
  },
  rapidLanes: {
    chapter: 13,
    specs: ["notes-rapid-lanes.spec.ts", "notes-rapid-verse-placement.spec.ts"],
    why:
      "notes-rapid-lanes approves, un-approves and edits quotes, so the notes are seeded as AI " +
      "drafts, which makes them read-only in the classic editor. notes-rapid-verse-placement " +
      "only reads it.",
    seed: "ai_draft",
  },
} as const satisfies Record<string, ChapterClaim>;

/** Chapters whose tN notes global-setup seeds as `ai_draft`. */
export const AI_DRAFT_CHAPTERS: readonly number[] = Object.values(ZEC_CHAPTERS as Record<string, ChapterClaim>)
  .filter((c) => c.seed === "ai_draft")
  .map((c) => c.chapter);

/**
 * The chapter the app opens when a route names a book but no chapter. Not a
 * fixture claim: it is app behavior a redirect spec asserts.
 */
export const APP_DEFAULT_CHAPTER = 1;
