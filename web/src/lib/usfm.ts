// Shared USFM utilities used by both the web client and (transitively
// via the api side) the worker import path. The single source of
// truth for "the plain text of a verse" — both the importer
// (api/src/importParsers.ts) and the alignment save path
// (alignment.ts:alignmentPlainText) call this so the two never drift.

// Concatenate every `text` field in the verseObjects tree, recursing
// into children. Whitespace is collapsed to single spaces and the
// result is trimmed. Mirrors the historical behaviour of the
// importer's extractPlainText; included character-style markers
// like \qs Selah\qs* and \f ... \f* contribute their text via this
// walk (qs nodes carry `text` or `children`; \f carries `content`
// which is NOT named `text`, so footnote prose is intentionally
// excluded — matching what the importer already did).
export function extractPlainText(verseObjects: unknown): string {
  const parts: string[] = [];
  const walk = (vos: unknown[]): void => {
    for (const vo of vos ?? []) {
      if (!vo || typeof vo !== "object") continue;
      const v = vo as { text?: unknown; children?: unknown[] };
      // An in-flow line marker (\p, \q1, …) carries no text but IS a word
      // separator. Without this, a marker that directly abuts the words on
      // either side with no whitespace text node — reachable after an edit
      // moves a poetic line break (`{from}\q2{good}`) — fuses them in the
      // derived plain text used for search / fallback display: "fromgood".
      // Emit a separating space (collapsed below, so no churn when whitespace
      // already surrounds the marker), then keep any leading punctuation usfm-js
      // parked on the marker node. Character wrappers (\qs Selah\qs*) hold inline
      // CONTENT, not a break — fall through so their wrapped word still counts.
      if (isInFlowMarker(vo) && !isCharacterWrapper(vo)) {
        parts.push(" ");
        if (typeof v.text === "string") parts.push(v.text);
        continue;
      }
      if (typeof v.text === "string") parts.push(v.text);
      if (Array.isArray(v.children)) walk(v.children);
    }
  };
  const top = verseObjects as { verseObjects?: unknown[] } | null;
  if (top && Array.isArray(top.verseObjects)) {
    walk(top.verseObjects);
  } else if (Array.isArray(verseObjects)) {
    walk(verseObjects);
  }
  return parts.join("").replace(/\s+/g, " ").trim();
}

// In-flow paragraph / poetry / blank markers. These have no text payload
// (they're position-anchors only) and survive verseObjects round-trips
// as `{type:"paragraph", tag}` nodes. The display layer turns them into
// visual line breaks / indents; the edit layer surfaces them as visible
// literal `\p`/`\q1` tokens so users can add/remove them.
export const PARAGRAPH_TAGS: ReadonlySet<string> = new Set([
  "p", "m", "mi", "nb", "pi", "pi1", "pi2", "pi3", "pc",
  "q", "q1", "q2", "q3", "q4", "qm", "qm1", "qm2", "qm3",
  "b",
]);

// Section heading tags that are translator-supplied and NOT alignable to
// source words. Rendered as separate header bands above the verse body.
// `\d` (Psalm superscription) is also `type:"section"` but its text IS
// alignable Hebrew — explicitly EXCLUDED from this set so it stays in
// the verse body alongside its `\zaln-s` children.
export const SECTION_HEADER_TAGS: ReadonlySet<string> = new Set(["s1", "s2", "s3", "s4", "ms", "ms1", "ms2"]);

export interface SectionHeader {
  tag: string;
  text: string;
}

export interface SplitContent {
  sections: SectionHeader[];
  body: unknown[];
}

// Split a verse's verseObjects into:
//   - sections: leading `\s1`/`\s2`/`\s3` heading nodes, hoisted out
//     for separate header-band rendering. Source-unalignable.
//   - body: everything else, preserved in original order (paragraph
//     markers, words, milestones, `\d` Psalm superscriptions).
// USFM places section headers before the verse they introduce, so in
// practice these come from the leading slice of the verseObjects array.
// We pull section nodes from anywhere in the array defensively.
export function splitSectionHeaders(verseObjects: unknown[] | undefined | null): SplitContent {
  const sections: SectionHeader[] = [];
  const body: unknown[] = [];
  if (!Array.isArray(verseObjects)) return { sections, body };
  for (const node of verseObjects) {
    const o = node as Record<string, unknown> | null;
    if (
      o &&
      o["type"] === "section" &&
      typeof o["tag"] === "string" &&
      SECTION_HEADER_TAGS.has(o["tag"] as string)
    ) {
      // usfm-js stores the heading text as `content` on \s* nodes (not
      // `text`, which is what \d uses). Try both — strip trailing newline
      // that usfm-js often appends.
      const raw = String(o["content"] ?? o["text"] ?? "");
      sections.push({
        tag: o["tag"] as string,
        text: raw.replace(/\n+$/, "").trim(),
      });
      continue;
    }
    body.push(node);
  }
  return { sections, body };
}

// usfm-js stores poetry markers (\q1, \q2, \qm*) as `{type:"quote", tag}`
// and plain-paragraph markers (\p, \m, \pi*, \nb, \b) as
// `{type:"paragraph", tag}`. Both are inert structural anchors that we
// render and surface for editing in the same way. `\ts\*` (translator-
// section chunk milestone) is parsed by usfm-js as `{tag:"ts",
// content:"\\*"}` with no `type` field — we treat it as in-flow too so
// it surfaces in the editor as a visible chunk divider.
export function isInFlowMarker(node: unknown): boolean {
  const o = node as Record<string, unknown> | null;
  if (!o) return false;
  const t = o["type"];
  if ((t === "paragraph" || t === "quote") && typeof o["tag"] === "string") return true;
  if (isTsMilestone(o)) return true;
  return false;
}

// True iff `node` is a `\ts\*` translator-section chunk milestone, in ANY of the
// shapes usfm-js has produced for it. This predicate exists because matching only
// the legacy shape was a silent no-op on real data for as long as we've shipped
// usfm-js 3.5.0: it parks the whole marker in the tag (`{tag:"ts\\*"}`) and emits
// no `type` and no `content`, so the `tag === "ts"` test never fired. The visible
// cost was Micah 4 — a verse whose trailing marker run ended in a `\ts\*` failed
// to seed the next verse's lookback band at all (extractTrailingMarkers saw an
// unrecognized node and stopped scanning), and the divider itself never rendered.
// Shapes, newest first:
//   usfm-js 3.5.0, well-formed  → {tag:"ts\\*"}
//   editor-written, malformed   → {tag:"ts*"}     (repaired on export)
//   legacy usfm-js              → {tag:"ts", content:"\\*"|"*"}
// Mirrors isTsMilestone in api/src/tsMilestone.ts — keep the two in sync.
export function isTsMilestone(node: unknown): boolean {
  const o = node as Record<string, unknown> | null;
  if (!o) return false;
  const tag = o["tag"];
  if (tag === "ts\\*" || tag === "ts*") return true;
  return tag === "ts" && (o["content"] === "\\*" || o["content"] === "*");
}

// Character-style wrapper tags that usfm-js parses as `type:"quote"` but which
// hold verse CONTENT, not a line break — mirrors ALIGNMENT_WRAPPER_TAGS in
// alignment.ts (kept local: usfm.ts is the lower layer and can't import it).
const CHARACTER_WRAPPER_TAGS: ReadonlySet<string> = new Set(["qs"]);

// usfm-js gives BOTH poetry/paragraph line markers (`\q1`, `\qa`) and same-line
// character-style wrappers (`\qs Selah\qs*`) `type:"quote"`, so isInFlowMarker
// matches both. A character wrapper holds verse CONTENT (aligned `\zaln`/`\w`
// children, or its own `text`), not a line break, and must be treated as a
// content wrapper everywhere — surfaced via its children/text, never as a
// literal `\qs` token. A well-closed one carries a non-empty `endTag` (`\qs*`);
// an upstream tool can emit it WITHOUT its close (older gatewayEdit mishandled
// Selah this way → `{tag:"qs", endTag:""}`), so we also match the known wrapper
// tag defensively. Real line markers have neither.
export function isCharacterWrapper(node: unknown): boolean {
  const o = node as Record<string, unknown> | null;
  if (!o) return false;
  if (typeof o["endTag"] === "string" && o["endTag"] !== "" && typeof o["tag"] === "string" && CHARACTER_WRAPPER_TAGS.has(o["tag"]))
    return true;
  return typeof o["tag"] === "string" && CHARACTER_WRAPPER_TAGS.has(o["tag"]);
}

// The ONE milestone-descent rule for SOURCE-word walks (issue #370). Alignment
// data wraps source `\w` tokens in `\zaln-s`/`\zaln-e` milestones; a source
// walk must descend those to reach the words, but must NOT descend other
// milestone kinds (e.g. `\k-s`/`\k-e` keyterm milestones), because their `\w`
// children would then be counted as extra source words and drift every
// position-bearing consumer. Both the picker walk (`collectSourceWordNodes` in
// quoteBuilder.ts) and the matcher walk (`collectBareWords` /
// `matchSourceTokens` in highlight.ts, via `nodeIsMilestone`) route their
// milestone gate through this, so the two can never diverge again — the exact
// class of drift that #364/#368 kept re-introducing. `\qs`-style content
// wrappers and `\d` superscriptions are descended too, but by their own
// predicates (`isCharacterWrapper` / the `\d` section check) alongside this one.
export function isZalnMilestone(node: unknown): node is Record<string, unknown> {
  const o = node as Record<string, unknown> | null;
  return !!o && o["type"] === "milestone" && o["tag"] === "zaln";
}

// True iff `node` is a `\d` Psalm/canticle superscription. usfm-js 3.5.0
// parses a real `\d` as `{tag:"d", text}` with NO `type` — only \s/\s1…\s5
// get `type:"section"` (see SECTION_HEADER_TAGS above, which deliberately
// excludes "d"). Several call sites — highlight.ts's nodeIsPsalmTitle,
// alignment.ts's isPsalmTitleWrapper, quoteBuilder.ts's collectTargetTokens,
// scripts/scan-align-order.mjs — used to duplicate an inline
// `type:"section" && tag:"d"` check instead, a shape the real parser never
// emits, so those walks never matched a real superscription (#384/#410).
// `tag === "d"` alone is a strict superset of that old defensive shape (any
// node satisfying it also satisfies this), so centralizing on it here is
// behavior-safe: it can only make a walk find MORE `\d` nodes, never fewer.
// `isSourceWordContainer` below delegates its own `\d` arm to this so the
// two predicates can't drift apart again.
export function isSuperscription(node: unknown): node is Record<string, unknown> {
  const o = node as Record<string, unknown> | null;
  return !!o && o["tag"] === "d";
}

// The ONE descent rule for source-word walks: a node whose CHILDREN are source
// verse body and must therefore be walked through, rather than a token of its
// own (issue #370 item 2). Three kinds qualify:
//   - `\zaln` alignment milestones (isZalnMilestone — and ONLY those; a `\k`
//     keyterm milestone's `\w` is not verse-body source, see that predicate),
//   - `\qs`-style character wrappers (isCharacterWrapper — a Selah aligned as
//     `zaln → qs → w`, or `qs → zaln → w`; issue #331/#354),
//   - `\d` Psalm superscriptions (isSuperscription) — content IS alignable
//     Hebrew verse body.
// `collectSourceWordNodes` (quoteBuilder.ts) is built on this, and the walks
// that cannot project off it — because they render as they go, or interleave
// text nodes — gate their descent on this predicate instead, so every
// position-bearing consumer (UhbStrip's `wordPos`, Shell/AlignScreen's
// `posOffsets`, AlignmentPanel/AlignSourceModel's source index maps) enumerates
// exactly the same words in exactly the same order. Before #370 each site
// hand-rolled `type === "milestone"` and none descended `\qs`, so a wrapped word
// silently shifted every position after it.
export function isSourceWordContainer(node: unknown): boolean {
  const o = node as Record<string, unknown> | null;
  if (!o) return false;
  return isZalnMilestone(o) || isCharacterWrapper(o) || isSuperscription(o);
}

// A character wrapper holds verse content that belongs to THIS verse and must
// stay put — only true line markers lead the NEXT verse and may drift onto it.
// Used by the trailing-marker drift pair so a verse-final `\qs Selah[\qs*]`
// isn't peeled off and shown on the following verse.
function isDriftableMarker(node: unknown): boolean {
  if (!isInFlowMarker(node)) return false;
  const o = node as Record<string, unknown>;
  if (typeof o["endTag"] === "string" && o["endTag"] !== "") return false;
  if (isCharacterWrapper(node)) return false;
  // A `\ts\*` chunk milestone marks a translator-section boundary AT the point it
  // sits — it is not a line marker leading the next verse, so it stays in the
  // verse that holds it and is rendered there rather than ghosted forward into
  // the next verse's lookback band. It is still transparent to the trailing-run
  // scan (trailingMarkerRunStart) so real line markers behind it still drift.
  if (isTsMilestone(node)) return false;
  return true;
}

// usfm-js attaches the leading punctuation that follows an in-flow marker on
// the same source line — the opening quote in `\q2 “I am…`, the `{` that opens
// a word-addition — to the MARKER node's own `text` field:
//   { tag:"q2", type:"quote", text:"“" }
// We otherwise treat in-flow markers as text-less position anchors, so that
// text is invisible in display/editing and silently dropped when
// reconcileMarkers rebuilds the marker from its tag alone. Split it out into a
// plain text node right after the marker so every consumer (the segment
// renderer, the edit baseline, the marker reconcile) sees it as ordinary
// leading line text. Lossless on export — `\q2 “` round-trips identically
// whether the quote sits on the marker node or in a following text node.
// Top-level only: in aligned source, markers never nest inside a milestone.
export function liftMarkerText(verseObjects: unknown[]): unknown[] {
  if (!Array.isArray(verseObjects)) return verseObjects;
  const out: unknown[] = [];
  for (const node of verseObjects) {
    const o = node as Record<string, unknown> | null;
    // A character wrapper (`\qs Selah\qs*`) is `type:"quote"` so isInFlowMarker
    // matches it, but its `text` is CONTENT held between `\qs … \qs*`, not a
    // quote parked on a line marker. Lifting it would move the word OUTSIDE the
    // wrapper (`\qs\qs* Selah`) — so skip wrappers; only lift true line markers.
    if (o && isInFlowMarker(o) && !isCharacterWrapper(o) && typeof o["text"] === "string" && o["text"] !== "") {
      const { text, ...rest } = o;
      out.push(rest);
      out.push({ type: "text", text });
    } else {
      out.push(node);
    }
  }
  return out;
}

// Peel trailing in-flow paragraph / quote markers off a verse's
// verseObjects array. USFM places markers BEFORE the verse they lead
// (`\q1 \v 9 ...`), but usfm-js attaches them to the PREVIOUS verse's
// content_json — so the `\q1` that visually introduces the first line
// of verse 9 actually lives at the end of verse 8. The display layer
// uses this to drift those trailing markers down to the verse they
// were meant to introduce, while the data stays USFM-correct on disk.
//
// Walks backward from the end of the array, collecting consecutive
// in-flow markers. Stops at the first non-marker node. Returns the
// markers in document order (oldest-first).
export function extractTrailingMarkers(verseObjects: unknown[] | undefined | null): unknown[] {
  if (!Array.isArray(verseObjects)) return [];
  const start = trailingMarkerRunStart(verseObjects);
  return verseObjects.slice(start).filter(isDriftableMarker);
}

// Index of the first node in the verse-final "trailing marker run" — the tail of
// the array that holds no verse content, only line markers and the inert nodes
// that may be interleaved with them. Everything from here to the end is either
// drifted onto the next verse (the line markers) or left in place (the rest);
// `verseObjects.length` means there is no run at all. Shared by
// extractTrailingMarkers and stripTrailingMarkers so the two can never disagree
// about where the run begins.
//
// Three node kinds are transparent to the scan:
//   - driftable line markers (`\q1`, `\p`, …) — what we're collecting;
//   - whitespace-only text, INCLUDING zero-width spaces (U+200B), which crept in
//     from the editor's empty-block placeholder (`&#8203;`) and must not block
//     drift just because a user saved past one;
//   - a `\ts\*` chunk milestone, which is transparent but NOT driftable (see
//     isDriftableMarker). Making it transparent is the Micah 4 fix: prod stores
//     the tail as `\q1` then `\ts\*`, so a scan that stopped at the divider never
//     reached the `\q1` behind it and verses 2/4/6/9 lost their lookback band.
function trailingMarkerRunStart(verseObjects: unknown[]): number {
  let start = verseObjects.length;
  for (let i = verseObjects.length - 1; i >= 0; i--) {
    const node = verseObjects[i];
    if (isDriftableMarker(node) || isTsMilestone(node)) {
      start = i;
      continue;
    }
    const o = node as Record<string, unknown> | null;
    const txt = typeof o?.["text"] === "string" ? (o["text"] as string) : null;
    if (txt !== null && /^[\s​]*$/.test(txt)) {
      start = i;
      continue;
    }
    break;
  }
  return start;
}

// Inverse of extractTrailingMarkers: return verseObjects with their trailing
// in-flow markers removed. Those markers belong to (and are drifted onto) the
// NEXT verse's display, so a verse's own display body must NOT also render
// them — otherwise a text-bearing trailing marker (e.g. an acrostic
// `\qa ZAYIN` heading) shows TWICE: at the bottom of this verse's card AND
// drifted to the top of the next. Empty markers (`\q1`/`\q2`) are invisible so
// the doubling only surfaces for markers carrying text (LAM/PSA-119 acrostic
// letters). Mirrors extractTrailingMarkers' scan exactly (skips whitespace-only
// text nodes interspersed in the trailing-marker run) so the two stay in
// lockstep. Display/read paths only — never the active-editable render, whose
// save diff (extractEditableText) needs the verse's full objects.
export function stripTrailingMarkers(verseObjects: unknown[] | undefined | null): unknown[] {
  if (!Array.isArray(verseObjects)) return [];
  const start = trailingMarkerRunStart(verseObjects);
  if (start >= verseObjects.length) return verseObjects;
  // Drop ONLY the markers that actually drifted. The run can also hold a
  // `\ts\*` chunk milestone, which does not drift and must still render in this
  // verse — so this filters the run rather than truncating at `start`. (Prod
  // stores Micah 4's tails as `\q1` then `\ts\*`: a plain `slice(0, start)` would
  // delete the divider from the only verse that shows it.) Trailing whitespace in
  // the run is inert either way; keeping it preserves the pre-existing spacing.
  const kept = verseObjects.slice(start).filter((n) => !isDriftableMarker(n));
  return kept.length === verseObjects.length - start
    ? verseObjects
    : [...verseObjects.slice(0, start), ...kept];
}

// Collapse editor whitespace so the diff baseline (extractEditableText)
// and the captured contenteditable text (textContent / innerText) are
// byte-comparable. Strips zero-width spaces (U+200B — empty-block caret
// placeholders the editor emits as `&#8203;`) and collapses ASCII
// whitespace AND non-breaking spaces (U+00A0 — injected as `&nbsp;` after
// toolbar-inserted marker chips, and by `innerText` block boundaries) to
// single spaces, then trims. extractEditableText and smartEditVerse share
// this so a stray trailing/embedded space can't desync the edit diff and
// nuke alignment from the edit point to the verse end.
export function normalizeEditable(s: string): string {
  return s.replace(/​/g, "").replace(/[ \t\n\r\f\v ]+/g, " ").trim();
}

// Like extractPlainText but emits a literal USFM marker token (e.g.
// "\p ", "\q1 ", "\b ") inline for each in-flow marker node. Used as
// the BASELINE for diffing edits in the active-verse contenteditable
// when markers are surfaced as chips — the chip's textContent is
// exactly "\p" / "\q1", so the captured textContent stream lines up
// with this representation. Section-heading nodes (\s1/\s2/\s3) are
// skipped — they live in a separate header band.
export function extractEditableText(verseObjects: unknown): string {
  const parts: string[] = [];
  const walk = (vos: unknown[]): void => {
    for (const vo of vos ?? []) {
      if (!vo || typeof vo !== "object") continue;
      const v = vo as Record<string, unknown>;
      // Character-style wrappers (`\qs Selah\qs*`) are also `type:"quote"`, so
      // isInFlowMarker matches them — but they hold aligned verse CONTENT, not a
      // line break. Fall through to the generic text/children recursion below so
      // the wrapped word (e.g. "Selah") lands in the editable baseline and lines
      // up with the raw tree. Emitting a literal `\qs` token here instead (and
      // not recursing) hid "Selah" from the diff baseline — an edit elsewhere in
      // the verse then dropped it, and deleting the token unaligned the verse.
      if (isInFlowMarker(v) && !isCharacterWrapper(v)) {
        if (isTsMilestone(v)) {
          parts.push("\\ts\\* ");
        } else {
          parts.push(`\\${v["tag"]} `);
          // Surface any leading punctuation usfm-js attached to the marker
          // node (`\q2 “…` → text:"“") so the quote shows in the editor and
          // lands in the diff baseline. Mirrors liftMarkerText; harmless on
          // already-lifted trees (the marker carries no text there).
          if (typeof v["text"] === "string") parts.push(v["text"] as string);
        }
        continue;
      }
      if (
        v["type"] === "section" &&
        typeof v["tag"] === "string" &&
        SECTION_HEADER_TAGS.has(v["tag"] as string)
      ) {
        continue;
      }
      if (typeof v["text"] === "string") parts.push(v["text"] as string);
      if (Array.isArray(v["children"])) walk(v["children"] as unknown[]);
    }
  };
  const top = verseObjects as { verseObjects?: unknown[] } | null;
  if (top && Array.isArray(top.verseObjects)) {
    walk(top.verseObjects);
  } else if (Array.isArray(verseObjects)) {
    walk(verseObjects);
  }
  return normalizeEditable(parts.join(""));
}
