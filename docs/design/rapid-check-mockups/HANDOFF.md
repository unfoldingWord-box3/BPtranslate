# Handoff: Rapid notes check mockups (BPtranslate)

Written 2026-11-09 on agentbox, at the end of a session on the home account. Benjamin is switching accounts for usage reasons. These are design mockups only: no app code changed. This folder exists so the work can be picked up from the repo on branch `design/rapid-check-mockups` and its PR.

## What this is

Desktop mockups for a fast edit/approve screen for translated notes (tN), which Benjamin asked for. There are two modes:

- **By verse.** The verse stays pinned at the top. Under it is a spreadsheet-like list of that verse's notes:
  - The Arabic note can be edited inline.
  - Checkboxes support shift-click ranges and select-all.
  - Notes can be approved one at a time or in bulk.
- **By issue type.** For example, every Metaphor note in a chapter, with a scope that can widen to the whole book or a page of 20. Each note shows the target-language literal text, an optional ULT, the English note (can be hidden) and the Arabic note (editable).

The sample data is Obadiah 1 with Arabic as the target language. The note text is real, taken from `api/test-fixtures/translate/tn_OBA.tsv` and `api/test-fixtures/translate/dry-run-ar-OBA/tn_OBA.tsv`. ULT and Hebrew come from `docs/samples/31-OBA.usfm` and `docs/samples/hbo_uhb_31-OBA.usfm`. I wrote the Arabic verse lines myself as illustration; they are not project data. The quote highlights are plain string matches standing in for real alignment.

## Where it lives

- **Published canvas (version 9):** https://claude.ai/artifact/Nb9Yv2DyiKreaqgXRGDcbY. It is private to the home account, built from the design-canvas Artifact type https://claude.ai/artifact/QKN21svewxgyPb6SYRqWnd.
- **Source files:** `docs/design/rapid-check-mockups/canvas/project/` in this repo. These are the exact files behind version 9.

| File | Board |
|---|---|
| `Main.dc.html` | A: by verse, OBA 1:3, at laptop size 1366×768 with an inner scroll |
| `VerseAction.dc.html` | B: `<dc-import name="Main" scenario="action">`, 4 rows checked and qpw7 open in the editor with an unsaved change |
| `Issue.dc.html` | C: by issue type, Metaphor, full length (1366×3400; the height is a guess) |
| `IssueCompact.dc.html` | D: `<dc-import name="Issue" preset="compact">`, ULT and English off, 1366×768 |
| `canvas.json` | Board positions, sizes and titles |

B and D only wrap A and C with a preset, so any change to A or C carries over to them.

## How to pick it up on the new account

The new account cannot open or publish to the home account's artifact unless Benjamin shares it. There are two options:

1. **Keep the same link (preferred).** Benjamin opens the artifact while signed in to the home account, uses Share to give the work account edit access, and pastes the link into the new session. The new session reads it (Artifact `action: "read"`), then publishes from the copied files:
   - `url`: the artifact link
   - `root`: `<checkout>/docs/design/rapid-check-mockups/canvas`
   - `file_path`: `<checkout>/docs/design/rapid-check-mockups/canvas/project/Main.dc.html`
   - `files`: the other four `project/*` files
2. **Start a new artifact.** Run Artifact `quickstart` with `intent: "design"`, create a new canvas from the design-canvas type, then publish the five `project/*` files into it. The type URL above may not be visible from another account; if it isn't, use whatever design-canvas type the quickstart returns.

Prompt to paste into the new session:

> Continue the rapid notes check mockups. Check out branch design/rapid-check-mockups (its PR in unfoldingWord-box3/BPtranslate) and read docs/design/rapid-check-mockups/HANDOFF.md first. [Link to the shared artifact if you shared it.]

When you change the boards, commit the updated `canvas/project/*` files to this branch as well, so the repo copy stays the source of truth.

## Feedback history

**Round 1** (Benjamin: "they're all pretty good"):
- Shrink the UI for laptop screens.
- The issue-type side panel wasted width.
- Status, note ID and type took too much room.
- The Arabic quote was left-aligned while the Hebrew was right-aligned.
- In verse mode the verse must stay visible even at the bottom of the list.

All of this was fixed in v7/v8:
- 1366 wide, smaller text and padding.
- The issue types became a row of buttons across the top.
- The meta column was narrowed.
- The quote cell was set right-to-left.
- A sticky header holds the verse card, the selection bar and the column headings.

**Round 2:**
- **Status vs. approve:** the status was far from the approve check, and the check showed on unapproved notes, which read as "already approved." Fixed: one status circle on the left that you click to approve. It is an empty ring until approved, then filled green with a check.
- **Colors:** Benjamin asked about red/yellow/green and about colorblind users. Fixed with a colorblind-safe palette (orange-red, amber, blue-green), a different shape for each status, and the status word always printed.
- **Keyboard:** J/K did nothing. Fixed: keyboard handling now works (see below).

**Round 3:** "looks good." Then this handoff.

## Open decisions (still waiting on Benjamin)

- **D1:** in issue mode, notes from the same verse share one Arabic-literal and ULT block (as built). The alternative is a full block for every note, which repeats the verse. He has not answered across three rounds; ask once, briefly.
- **D4:** the approve control is a circle, because Benjamin said "empty box" but a square would look like the select checkbox. Not yet confirmed.
- **D2 (shown on screen, not formally confirmed):** bulk Approve saves any unsaved edit first, the same as the existing Save & approve.
- **D3 (only if built):** whether this becomes a mode of the existing `#/notes` screen or its own route.
- **Hit targets:** buttons were shrunk to 26–32 px for laptop density. The canvas type's accessibility guidance may expect 44 px; Benjamin has not objected.

## What works in Play mode

- **Selection:** shift-click ranges (crossing verses in mode 2), select-all with a partly-selected state, and a per-verse group box in mode 2.
- **Editing:** inline edit with Save and Save & approve. A note with an unsaved change shows "Unsaved edit".
- **Bulk actions:** Approve / Redo with AI / Not needed, each with Undo.
- **Status circle:** click to approve; click again to take approval off.
- **Show toggles:** ULT, Hebrew and English note in mode 1; ULT and English note in mode 2.
- **Keys:** these work once the list has focus (click a note's box first):
  - J / K or the arrow keys move, and Shift+J / Shift+K extend the selection.
  - Space checks the current note, and Enter edits it.
  - A approves the current note and moves to the next, or approves the checked notes if any.
  - Ctrl+A checks all.
  - Inside the editor, Ctrl+Enter saves and approves and moves on; Esc cancels.
  - In mode 2, U toggles the ULT and E toggles the English note.
- **Drawn only:** `[` and `]` (next verse or issue type), the verse number buttons, the "22 more types" button, the scope and page-size controls, and the pager. Obadiah has one chapter, so "Whole book" and paging cannot really be shown.

## Verification state

- **Checked:**
  - Every opening tag in both main files has a closing tag (div, sc-if, sc-for, button, span, svg, p).
  - `node --check` passes on both scripts.
  - Logic tests drove the real keystroke sequences and ended in the right states: `node tests/Main.test.js` and `node tests/Issue.test.js`. They hold a copy of each file's script as of v9; to retest after changes, rebuild them from the `<script type="text/x-dc">` block.
- **Never checked:** nothing has been rendered or screenshotted. The canvas type's rule is not to render unless the user asks, and Benjamin has not asked yet. Things to check if he does:
  - whether the sticky verse header really pins when scrolling (A, B, D);
  - how many notes fit on the first 768-px screen;
  - board C's 3400 px height (too tall leaves a blank strip; too short cuts off the last verse groups);
  - whether clicking a blank spot in the list gives it keyboard focus (`tabindex` passthrough);
  - whether J in C lands a row under the sticky bar;
  - whether "Pending · AI" and "Unsaved edit" fit in the 112 px meta column.

## Gotchas in the `.dc.html` format, learned the hard way

- **Styling and events:**
  - Inline styles only.
  - Use `{{hole}}`, `sc-for` (with `hint-placeholder-count`), `sc-if` (with `hint-placeholder-val`) and `dc-import`.
  - Event handlers are attributes such as `onClick="{{fn}}"`, `onKeyDown` and `onChange`.
- **Accessibility rule:** no `onClick` on a div. The row-level "make current" action is a transparent button around the type and ID.
- **Booleans:** write `disabled="{{ true }}"`, not bare `disabled`.
- **Grids:** an `sc-if` must not wrap two grid children. Give each lane its own grid div inside a flex column.
- **Sticky header:** sticky only works when no `overflow: hidden` ancestor sits between the sticky block and the scroll container. Keep one sticky wrapper, not several stacked ones.
- **Logic structure:** the logic is a `class Component extends DCLogic`, with state merged through `defaults()` plus `this.state`. The preset/scenario props are declared in `data-props` on the script tag.
- **Keyboard code:** DOM access in the key handler is scoped to `e.currentTarget`, using `data-cb`, `data-row` and `data-sticky` attributes rather than global IDs, because several boards may share a document.
- **Text direction:** Arabic and Hebrew cells are `dir="rtl"` and the chrome stays LTR. Put `dir="rtl"` on the quote cell container so `flex-start` means the right edge.
- **Rendering:** don't render or screenshot boards unless Benjamin asks.

## If this moves to real code

Nothing has been filed or built. The existing screen to build on is `web/src/components/flows/TranslateNotesScreen.tsx` (the Lane component and the status types), plus `ReviewSourceStrip.tsx`. Note save rules from CLAUDE.md:
- Save only on an explicit click.
- Unsaved text goes to the IndexedDB drafts store.
- Never save on unmount.
