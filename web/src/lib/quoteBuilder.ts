// Convert a user's click-to-select Hebrew/Greek word set into the TN
// quote format used by row.quote + row.occurrence. Tokens get sorted into
// document order, runs of consecutive document positions become a single
// space-joined sub-quote, and disjoint runs are joined with " & " — the
// same gap marker findSourceHighlights / findTargetHighlights consume.
//
// Occurrence is best-effort: we walk the verse looking for the same
// gap-separated pattern and report 1-based index of the FIRST run start
// that matches the user's selection range. For unambiguous selections
// (the picked tokens are the only instance in the verse), the result is
// always 1, matching how new TNs are typically written.

import type { HighlightKey } from "./highlight";
import { matchNorm, matchSourceTokens } from "./highlight.ts";
import { nfc } from "./hebrew.ts";
import { isCharacterWrapper, isSourceWordContainer, isSuperscription } from "./usfm.ts";

// Build a HighlightKey from a Hebrew/Greek string + 1-based occurrence.
// All callers (picker + buildQuoteFromSelection + collectTargetTokens)
// MUST go through this — UHB \w text is stored in legacy combining-mark
// order while UST/ULT zaln x-content is NFC, so a raw `${text}|${occ}`
// comparison loses the join. Use matchNorm (NFC + word-joiner U+2060 /
// U+200D stripping) — the SAME fold the highlighter joins by in
// matchSourceTokens / matchGroupsAt. nfc() alone left the joiner in, so a
// UHB token carrying a U+2060 (הָ⁠אֶבֶן) and an AI-generated x-content that
// omitted it minted two different keys: clicking the English chip toggled a
// phantom key the UHB row could never match, and the quote never built. One
// fold must govern every quote/selection equality.
export function tokenKey(text: string, occurrence: number): HighlightKey {
  return `${matchNorm(text)}|${occurrence}`;
}

interface UhbWord {
  text: string;       // raw text, preserved for quote string rendering
  key: HighlightKey;  // matchNorm-normalized lookup key (see tokenKey)
  occurrence: number;
  // 0-based document position among all \w tokens in this verse. Stable
  // across re-render because the verseObjects tree is immutable while
  // the user is selecting.
  position: number;
  // Text node(s) sitting between this \w and the next one — usually a
  // single space, but a Hebrew maqqef (־) for joined words like
  // כָל־הַגֹּנֵב. Used to rejoin a consecutive run with the ORIGINAL
  // separator instead of a flat space, so a built quote reads כָל־הַגֹּנֵב
  // (matching how TN quotes are written) and not כָל הַגֹּנֵב.
  trailing: string;
}

// One raw \w node in document order, with the inter-word separator text that
// trails it. This is the single source-word traversal the picker family shares
// — quoteBuilder's `collectUhbWords` and QuoteBuilderPopper's chip list both
// project off it, so POSITION means the same thing to every consumer and the
// wrapper-descent rule lives in exactly one place (issue #364).
export interface SourceWordNode {
  node: Record<string, unknown>;
  // 0-based document position among all \w tokens in this verse.
  position: number;
  // Text node(s) between this \w and the next one (space, or a Hebrew maqqef
  // ־ for joined words). Callers that don't rejoin runs can ignore it.
  trailing: string;
}

// Flatten the verse tree to its bare \w nodes in document order, descending
// `\zaln` alignment milestones, `\qs`-style character wrappers, and `\d` (Psalm
// superscription) the SAME way `matchSourceTokens` / `highlight.ts` do — the
// descent gate is the shared `isSourceWordContainer` predicate (usfm.ts), whose
// milestone half is `isZalnMilestone`, so this picker walk and the matcher walk
// can never disagree on which nodes to descend (issue #370; before it, this walk
// descended ANY `type:"milestone"`, so a `\k-s` keyterm milestone yielded extra
// source words here that the zaln-only matcher never saw — position drift). A
// `\qs`-wrapped source \w is verse body, so it MUST be walked or the picker
// diverges from the wrapper-aware matcher (post-#354) and pre-seeded chips can't
// be deselected.
//
// This is the walk every position-bearing source consumer projects off — the
// picker chips, the flows spine, and (since #370 item 2) the aligner's index
// maps, strip render positions and panel offsets. Change the rule HERE (or in
// `isSourceWordContainer`), never in a caller.
export function collectSourceWordNodes(verseObjects: unknown[]): SourceWordNode[] {
  const out: SourceWordNode[] = [];
  function walk(nodes: unknown[]) {
    for (const node of nodes ?? []) {
      const o = node as Record<string, unknown> | null;
      if (!o) continue;
      if (o["type"] === "word" && o["tag"] === "w") {
        out.push({ node: o, position: out.length, trailing: "" });
      } else if (o["type"] === "text") {
        // Attach to the most recent word as its separator. usfm-js emits the
        // maqqef / inter-word space as a bare text sibling of the \w tokens.
        const prev = out[out.length - 1];
        if (prev) prev.trailing += String(o["text"] ?? "");
      } else if (isSourceWordContainer(o)) {
        walk((o["children"] as unknown[] | undefined) ?? []);
      }
    }
  }
  walk(verseObjects);
  return out;
}

function collectUhbWords(verseObjects: unknown[]): UhbWord[] {
  return collectSourceWordNodes(verseObjects).map(({ node, position, trailing }) => {
    const text = String(node["text"] ?? "");
    const occurrence = parseInt(String(node["occurrence"] ?? "1"), 10) || 1;
    return { text, key: tokenKey(text, occurrence), occurrence, position, trailing };
  });
}

export interface BuiltQuote {
  quote: string;
  occurrence: number;
}

// Reverse of buildQuoteFromSelection: resolve a stored quote + occurrence
// against the UHB/UGNT verse and return the picker selection keys (tokenKey
// format) for the matched source words. Used to PRE-SEED the picker when
// "build from source" opens on a note that already carries a quote — the
// translator keeps the existing words selected and just adds more, rather
// than starting from scratch. Returns an empty set when the quote doesn't
// resolve in this verse (e.g. it was typed by hand as English support text
// and never converted to source), so the picker simply starts fresh.
//
// Keys go through tokenKey (matchNorm) so they match what
// buildQuoteFromSelection / collectUhbWords look up — matchSourceTokens
// returns the same per-word (text, occurrence) the builder keys by.
export function selectionFromQuote(
  verseObjects: unknown[] | undefined | null,
  quote: string | null | undefined,
  occurrence: number | null | undefined,
): Set<HighlightKey> {
  const out = new Set<HighlightKey>();
  if (!Array.isArray(verseObjects) || !quote) return out;
  for (const t of matchSourceTokens(verseObjects, quote, occurrence ?? 1)) {
    out.add(tokenKey(t.text, t.occurrence));
  }
  return out;
}

// True when a built quote is the one the row already stores, so committing
// it would be a no-op write (which still bumps the version and demotes an
// approved row). Quotes compare NFC-normalized: the builder emits UHB's legacy
// combining-mark order while a stored quote may be NFC. A null stored
// occurrence means "first", == 1. Same rule as Shell's commitQuoteBuild.
export function quotePickUnchanged(
  built: { quote: string; occurrence: number },
  storedQuote: string | null | undefined,
  storedOccurrence: number | null | undefined,
): boolean {
  return nfc(built.quote) === nfc(storedQuote ?? "") && built.occurrence === (storedOccurrence ?? 1);
}

// Separator to place after `w` when rejoining it with the next word in the
// same run. A maqqef in the trailing text wins (joined Hebrew word); anything
// else is a plain space.
function separatorAfter(w: UhbWord): string {
  return w.trailing.includes("־") ? "־" : " ";
}

export function buildQuoteFromSelection(
  verseObjects: unknown[] | undefined | null,
  selectedKeys: Set<HighlightKey>,
): BuiltQuote | null {
  if (!Array.isArray(verseObjects) || selectedKeys.size === 0) return null;
  const all = collectUhbWords(verseObjects);
  const selected = all.filter((w) => selectedKeys.has(w.key));
  if (selected.length === 0) return null;

  // selected is already in document order — collectUhbWords walks in order
  // and selected preserves that. Group runs of consecutive positions.
  const groups: UhbWord[][] = [];
  let current: UhbWord[] = [selected[0]];
  for (let i = 1; i < selected.length; i++) {
    if (selected[i].position === selected[i - 1].position + 1) {
      current.push(selected[i]);
    } else {
      groups.push(current);
      current = [selected[i]];
    }
  }
  if (current.length > 0) groups.push(current);

  // Join each consecutive run with the original inter-word separator so a
  // maqqef-joined pair (כָל־הַגֹּנֵב) round-trips with its maqqef. Any other
  // separator (a normal space, cantillation gaps) collapses to a single
  // space — the highlight matcher splits on /[\s־]+/ either way.
  const quote = groups
    .map((g) =>
      g
        .map((w, i) => (i === 0 ? w.text : separatorAfter(g[i - 1]) + w.text))
        .join(""),
    )
    .join(" & ");

  // Occurrence — count how many positions in `all` start a matching
  // pattern. A pattern matches when scanning forward from `start`: for
  // each group, find a sub-position whose text equals the group's
  // sequence; subsequent groups can start anywhere after the previous
  // group ends (the `&` gap). 1-based; the first match is the selection.
  const matches: number[] = [];
  for (let start = 0; start < all.length; start++) {
    if (matchGroupsAt(start, groups, all)) matches.push(start);
  }
  // Which match starts at our first selected position?
  const firstSelectedPos = selected[0].position;
  const occurrence = Math.max(1, matches.indexOf(firstSelectedPos) + 1);
  return { quote, occurrence };
}

// One source ancestor: the content + occurrence from a \zaln-s milestone.
// The picker turns a click on a target word into a set of these so the
// existing UHB-keyed selection (used by buildQuoteFromSelection) can be
// fed without translating between formats. The `key` field is the
// matchNorm-normalized selection key — always compare keys, never raw
// content, since UHB \w text and zaln x-content can drift in combining-mark
// order AND in word-joiner presence.
export interface SourceAncestor {
  content: string;     // raw, for display in tooltips
  occurrence: number;
  key: HighlightKey;   // matchNorm-normalized, for selection set lookups
}

// Per-token shape returned by collectTargetTokens. Outer-to-inner ancestor
// chain — same direction findSourceForTargetText emits, so the picker can
// preserve the convention.
export interface TargetToken {
  text: string;
  occurrence: number;
  position: number;
  sources: SourceAncestor[];
}

// Walk a ULT/UST verseObjects tree. For each \w token, capture its
// enclosing \zaln-s ancestor chain (outer first) as SourceAncestor[].
// Mirrors findSourceForTargetText's stack-based walk but emits per-token
// records instead of merging into one string. Used by the picker so a
// click on "first" inside zaln(בַחֹדֶשׁ) > zaln(הָרִאשׁוֹן) > w(first)
// can toggle both Hebrew words at their correct occurrence indices.
export function collectTargetTokens(
  verseObjects: unknown[] | undefined | null,
): TargetToken[] {
  if (!Array.isArray(verseObjects)) return [];
  const out: TargetToken[] = [];
  function walk(nodes: unknown[], stack: SourceAncestor[]) {
    for (const node of nodes ?? []) {
      const o = node as Record<string, unknown> | null;
      if (!o) continue;
      if (o["type"] === "milestone" && o["tag"] === "zaln") {
        const content = String(o["content"] ?? "");
        // Clamp occurrence into [1, occurrences]. A split-gloss continuation —
        // one source token whose target words are NON-CONTIGUOUS — is stamped
        // occurrence="2" while occurrences stays "1", which is impossible ("the
        // 2nd of 1"). Real case: ZEC 6:2 בַּ⁠מֶּרְכָּבָה → "In the" … (interrupted
        // by "first") … "chariot", where "chariot" sits under the occurrence="2"
        // milestone. Left raw, its source key (…|2) names a phantom the single
        // UHB token (…|1) can never match, so the picker neither selects nor
        // highlights "chariot" with its "In the" siblings. No-op on well-formed
        // data. Mirrors effectiveOccurrence in alignment.ts and the split-run
        // merge in highlight.ts.
        const rawOcc = parseInt(String(o["occurrence"] ?? "1"), 10) || 1;
        const total = parseInt(String(o["occurrences"] ?? "1"), 10) || 1;
        const occurrence = Math.min(Math.max(rawOcc, 1), Math.max(total, 1));
        const children = (o["children"] as unknown[] | undefined) ?? [];
        // Skip ancestors with no content — defensive: a malformed milestone
        // without x-content would otherwise insert empty selection keys.
        const nextStack = content
          ? [...stack, { content, occurrence, key: tokenKey(content, occurrence) }]
          : stack;
        walk(children, nextStack);
      } else if (isSuperscription(o)) {
        // \d (Psalm superscription) content IS alignable verse body —
        // descend, carrying the current ancestor stack unchanged (it
        // contributes no source of its own). Mirrors collectMilestoneRuns /
        // collectUhbWords.
        walk((o["children"] as unknown[] | undefined) ?? [], stack);
      } else if (isCharacterWrapper(o)) {
        // \qs (Selah) and other character wrappers hold \zaln / \w content
        // but contribute no source of their own — descend, stack unchanged,
        // exactly like the \d branch above. Without this the picker cannot
        // pre-select or rebuild a \qs-wrapped target word that
        // findTargetHighlights now highlights.
        walk((o["children"] as unknown[] | undefined) ?? [], stack);
      } else if (o["type"] === "word" && o["tag"] === "w") {
        const text = String(o["text"] ?? "");
        const occurrence = parseInt(String(o["occurrence"] ?? "1"), 10) || 1;
        out.push({
          text,
          occurrence,
          position: out.length,
          sources: stack.slice(),
        });
      }
    }
  }
  walk(verseObjects, []);
  return out;
}

function matchGroupsAt(
  start: number,
  groups: UhbWord[][],
  all: UhbWord[],
): boolean {
  // Compare via matchNorm (NFC + joiner stripping) so the occurrence this
  // builder stamps counts the same matches the highlighter's
  // matchSourceTokens will find — legacy-vs-NFC drift AND word-joiner
  // presence both tolerated, keeping built quotes round-tripping.
  const norm = (w: UhbWord) => matchNorm(w.text);
  let pos = start;
  for (let gi = 0; gi < groups.length; gi++) {
    const group = groups[gi];
    if (gi === 0) {
      if (pos + group.length > all.length) return false;
      for (let wi = 0; wi < group.length; wi++) {
        if (norm(all[pos + wi]) !== norm(group[wi])) return false;
      }
      pos = pos + group.length;
    } else {
      let found = -1;
      for (let s = pos; s + group.length <= all.length; s++) {
        let ok = true;
        for (let wi = 0; wi < group.length; wi++) {
          if (norm(all[s + wi]) !== norm(group[wi])) {
            ok = false;
            break;
          }
        }
        if (ok) {
          found = s;
          break;
        }
      }
      if (found < 0) return false;
      pos = found + group.length;
    }
  }
  return true;
}
