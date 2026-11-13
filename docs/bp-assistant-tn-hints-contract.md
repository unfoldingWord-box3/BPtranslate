# bp-assistant ↔ bible-editor: TN hint expansion contract

## Status

**Retired (2026-11, #726).** This contract fed the `notes` pipeline, which is
retired: `/api/pipelines/start` no longer gathers hint stubs into
`options.hints`, and the hint-expansion apply is removed. Kept as a record.

**Final agreed design.** Bible-editor side is pre-staged on branch
`claude/note-hints-preservation-LrRj7` (Ship 1 + Ship 2). bp-assistant ships
the corresponding `tn-writer` update on their side. End-to-end activates as
soon as both sides land.

## Core design

bible-editor sends a 4-char TN row id with each hint. bp-assistant writes that
same id into the **TSV `ID` column** (column 1) for the row that expands that
hint. The id round-trip IS the mapping — no extra columns, no sidecar files,
no status-endpoint extensions, no atomicity coordination.

- The TSV pushed to DCS (`unfoldingWord/en_tn`) stays canonical 7-col
  (`Reference`, `ID`, `Tags`, `SupportReference`, `Quote`, `Occurrence`,
  `Note`). Downstream consumers see no schema change.
- The whole exchange is invisible to existing Zulip-triggered runs and to any
  API caller that doesn't send `options.hints`.

## What bible-editor sends

`POST /api/pipeline/start` body gains an optional `options.hints` array:

```json
{
  "pipelineType": "notes",
  "book": "ZEC",
  "startChapter": 7,
  "endChapter": 7,
  "username": "...",
  "sessionKey": "...",
  "options": {
    "hints": [
      {
        "rowId": "ab12",
        "verse": 7,
        "quote": "מֵרֵעֵהוּ",
        "supportReference": "rc://*/ta/man/translate/figs-metaphor",
        "seed": "Could be either the neighbor's view or the speaker's view — need both options."
      },
      {
        "rowId": "cd34",
        "verse": 9,
        "quote": "וְ⁠נִכְרַ֖תָּ",
        "supportReference": "rc://*/ta/man/translate/figs-idiom",
        "seed": null
      }
    ]
  }
}
```

Field semantics:

- `rowId` — 4-char `[a-z][a-z0-9]{3}` string. bible-editor's stable TN row id.
  Same format and purpose as the TSV `ID` column. **Must be echoed back as the
  TSV `ID` column value** for the corresponding expanded row.
- `verse` — integer. The verse the hint targets.
- `quote` — string. Source-language phrase the note explains. May be Hebrew,
  Greek, or empty.
- `supportReference` — string or null. The issue type / TA link.
- `seed` — string or null. Editor's seed prose for the note. May be a stub
  like `"This could mean: (1) NOTE Alternate translation: [ALT] (2) NOTE
  Alternate translation: [ALT]"`, a one-line reason, or null. Expand into a
  fully-formed note when present; write fresh when null.

`hints` may be empty or absent on any run. When empty/absent, behave as
today.

## What `tn-writer` must do

For each hint:

1. **Produce exactly one TN row** matching the hint's `verse`, `quote`, and
   `supportReference`. Use `seed` as guidance for the note content; produce a
   complete, well-formed note (not just the seed echoed back).
2. **Set the TSV `ID` column to the hint's `rowId` value.** Do not mint a
   fresh id for these rows.
3. **Suppress competing notes** for the same `(verse, quote)` pair. The
   translator has already chosen the issue framing; don't generate alternative
   notes that would conflict.

For verses not covered by a hint: behave exactly as today (fresh ids, normal
output).

bp-assistant has confirmed that the hint's `rowId` will be preserved into the
final DCS output TSV that gets merged.

## What bible-editor does on its side

For your awareness:

- **Outbound** (`api/src/pipelines.ts`): at `/api/pipelines/start` time the
  proxy SELECTs all `hint = 1` rows from D1 in `(book, startChapter..endChapter)`
  and folds them into `options.hints`. Wire shape above is authoritative — what's
  in D1 at start time, not whatever was in the editor's local cache.
- **Sweep** (`api/src/pipelineImport.ts`, `deleteUnkeptTns`): already excludes
  `hint = 1` rows (Ship 1, already merged). The stub row survives until the
  expanded version lands.
- **Apply** (`api/src/pipelineImport.ts`, new `applyTnHintExpansion`): when a
  TN proposal's `id` matches an existing `hint = 1` row in D1 for the chapter,
  UPDATE the stub in place — preserves version history, sort position,
  `updated_by`, and the `preserve` bit. Clears `hint`. The `edit_log` entry is
  written with `source = 'hint_expansion'` so the history dialog can attribute
  the revision to AI but the row's "AI" chip (keyed on `source = 'ai_pipeline'`)
  does not show — standing authorship of the note's existence stays with the
  human who created the hint.

## Verification

bp-assistant smoke test:

1. Call `tn-writer` (or whichever skill `pipelineType: "notes"` dispatches to)
   with `options.hints` containing two entries — one with a `seed`, one with
   `seed: null`.
2. Verify the output TSV:
   - Has exactly one row per hint with `ID` column equal to the hint's `rowId`.
   - Each such row's `Reference` / `Quote` / `SupportReference` matches the
     hint.
   - No second AI-generated note exists for the same `(verse, quote)` pair.
   - Un-hinted verses generate fresh ids and normal output.
3. Confirm `repo-insert` preserves the `ID` column unchanged when pushing to
   DCS.

bible-editor smoke test (post-merge of Ship 2):

1. Mark a TN stub with `hint = 1`, with `quote` and `supportReference` set.
2. Trigger the notes pipeline for the chapter.
3. Confirm: stub row survives the sweep; on pipeline completion, the same row
   id now has the AI-expanded `note` content; `hint = 0`; `preserve` and
   `updated_by` unchanged; row has v2+ on the version chip; history dialog
   shows the v(N) entry attributed to AI; no "AI" chip on the row.
