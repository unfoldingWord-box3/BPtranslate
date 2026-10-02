import { expect, type Locator } from "@playwright/test";

// Geometric paint check for RTL text (issue #486).
//
// `getComputedStyle(el).direction === "rtl"` is not proof that a line PAINTS
// right-to-left: a child can override `dir`, or a bidi-isolation break can put
// the sentence-final punctuation on the wrong side — the exact 2026-08-22
// regression ("the period on the wrong side"). Pixel baselines
// (`toHaveScreenshot()`) would catch it, but they are font- and
// Chromium-build-specific, so a baseline generated on one machine fails on CI's
// ubuntu runner. Instead this reads where the browser actually laid out each
// character, via `Range.getClientRects()`, which is platform-independent:
//
//   - In an RTL paragraph the END of the sentence is on the LEFT, so the
//     sentence-final punctuation must be the leftmost glyph on its line. Under
//     a wrong `dir="ltr"` the same neutral punctuation resolves to the
//     paragraph direction and paints at the RIGHT end — the check fails.
//   - An embedded Latin token is an LTR run inside the RTL line: its own
//     letters read left-to-right, and the Arabic word logically before it sits
//     to its RIGHT (and the one after it to its LEFT).
//
// Every comparison is made between glyphs on the SAME line (the punctuation's
// line, or the Latin token's line), so a sentence that wraps differently on
// CI's fonts still checks cleanly. Nothing is skipped silently: a missing
// `within` sentence, a missing Latin token, a missing neighbour word, or a
// token with no neighbour on its own line all fail with a message.

export interface PaintOpts {
  /** Sentence-final punctuation to look for (default "."); its LAST occurrence. */
  punct?: string;
  /** Embedded Latin token to check for LTR letters in RTL word order. */
  latin?: string;
  /** Measure only this substring of the element's text (default: all of it). */
  within?: string;
}

type Box = { left: number; right: number };

export interface PaintReport {
  text: string;
  /** False when `within` was given but is not in the element's text. */
  withinFound: boolean;
  /** Punctuation glyph's box on its line. */
  punct: Box | null;
  /** Leftmost / rightmost painted edge of every other glyph on that line. */
  lineLeft: number;
  lineRight: number;
  /** False when `latin` was given but is not in the measured text. */
  latinFound: boolean;
  /** Lefts of each Latin token letter, in logical order (empty if not asked). */
  latinLefts: number[];
  /** Box of the Latin token. */
  latinBox: Box | null;
  /** Whether a whitespace-delimited word exists logically before / after the token. */
  hasBefore: boolean;
  hasAfter: boolean;
  /**
   * Box of that neighbour word's glyphs ON THE TOKEN'S LINE — null when the
   * neighbour wrapped to another line (then it is not comparable).
   */
  beforeBox: Box | null;
  afterBox: Box | null;
}

/**
 * Measure where `punct` (the LAST occurrence in the measured text) and an
 * optional embedded `latin` token were painted inside the element `locator`
 * resolves to.
 */
export async function measurePaint(
  locator: Locator,
  opts: PaintOpts = {},
): Promise<PaintReport> {
  const punct = opts.punct ?? ".";
  return locator.evaluate(
    (root, { punct, latin, within }) => {
      // Flatten the element's text nodes into one logical string, keeping a
      // back-map from string offset → (node, offset) for Range measurement.
      let map: { node: Text; off: number }[] = [];
      let text = "";
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
      for (let n = walker.nextNode(); n; n = walker.nextNode()) {
        const t = n as Text;
        for (let i = 0; i < t.data.length; i++) map.push({ node: t, off: i });
        text += t.data;
      }
      // Measure only the given sentence when the element holds other text too
      // (e.g. an English hint after the Arabic line).
      let withinFound = true;
      if (within) {
        const w0 = text.indexOf(within);
        withinFound = w0 >= 0;
        if (withinFound) {
          map = map.slice(w0, w0 + within.length);
          text = within;
        }
      }
      const rectAt = (i: number): DOMRect | null => {
        const m = map[i];
        if (!m) return null;
        const r = document.createRange();
        r.setStart(m.node, m.off);
        r.setEnd(m.node, m.off + 1);
        const rs = Array.from(r.getClientRects()).filter((x) => x.width > 0);
        return rs[0] ?? null;
      };
      // Base glyphs only: combining marks (Arabic harakat, U+064B–065F, U+0670,
      // Hebrew points) and whitespace have no box of their own.
      const isBase = (ch: string) => /\S/.test(ch) && !/\p{M}/u.test(ch);
      // Horizontal extent of the base glyphs in [from, to) — optionally only
      // those whose box spans the vertical midline `onY` (i.e. on that line).
      const span = (from: number, to: number, onY?: number) => {
        let left = Infinity;
        let right = -Infinity;
        for (let i = from; i < to; i++) {
          if (!isBase(text[i])) continue;
          const r = rectAt(i);
          if (!r) continue;
          if (onY !== undefined && (onY < r.top || onY > r.bottom)) continue;
          left = Math.min(left, r.left);
          right = Math.max(right, r.right);
        }
        return left === Infinity ? null : { left, right };
      };

      const pi = text.lastIndexOf(punct);
      const pr = pi >= 0 ? rectAt(pi) : null;
      let lineLeft = Infinity;
      let lineRight = -Infinity;
      if (pr) {
        const midY = (pr.top + pr.bottom) / 2;
        for (let i = 0; i < text.length; i++) {
          if (i === pi || !isBase(text[i])) continue;
          const r = rectAt(i);
          if (!r || midY < r.top || midY > r.bottom) continue; // other line
          lineLeft = Math.min(lineLeft, r.left);
          lineRight = Math.max(lineRight, r.right);
        }
      }

      let latinFound = false;
      let latinLefts: number[] = [];
      let latinBox: { left: number; right: number } | null = null;
      let hasBefore = false;
      let hasAfter = false;
      let beforeBox: { left: number; right: number } | null = null;
      let afterBox: { left: number; right: number } | null = null;
      if (latin) {
        const li = text.indexOf(latin);
        latinFound = li >= 0;
        if (latinFound) {
          latinLefts = Array.from(latin).map((_, k) => rectAt(li + k)?.left ?? NaN);
          latinBox = span(li, li + latin.length);
          const first = rectAt(li);
          const tokenY = first ? (first.top + first.bottom) / 2 : undefined;
          // The whitespace-delimited word just before / after the token,
          // measured only where it shares the token's line.
          const before = text.slice(0, li).trimEnd();
          const bStart = before.search(/\S+$/);
          hasBefore = bStart >= 0;
          if (hasBefore && tokenY !== undefined) beforeBox = span(bStart, before.length, tokenY);
          const aFrom = li + latin.length;
          const rest = text.slice(aFrom);
          const lead = rest.length - rest.trimStart().length;
          const word = rest.trimStart().match(/^[^\s.]+/)?.[0] ?? "";
          hasAfter = word.length > 0;
          if (hasAfter && tokenY !== undefined) {
            afterBox = span(aFrom + lead, aFrom + lead + word.length, tokenY);
          }
        }
      }

      return {
        text,
        withinFound,
        punct: pr ? { left: pr.left, right: pr.right } : null,
        lineLeft,
        lineRight,
        latinFound,
        latinLefts,
        latinBox,
        hasBefore,
        hasAfter,
        beforeBox,
        afterBox,
      };
    },
    { punct, latin: opts.latin, within: opts.within },
  );
}

/**
 * Assert the element PAINTS as RTL: sentence-final punctuation at the line's
 * left end and (when `latin` is given) the embedded Latin token laid out as an
 * LTR run in RTL word order. `label` names the surface in failure messages.
 */
export async function expectRtlPaint(
  locator: Locator,
  label: string,
  opts: PaintOpts = {},
): Promise<void> {
  const tol = 1; // px — sub-pixel glyph overlap at word joins
  const r = await measurePaint(locator, opts);
  const why = `${label}: ${JSON.stringify(r)}`;
  expect(r.withinFound, `${why} — sentence ${JSON.stringify(opts.within)} not in the element`).toBe(true);
  expect(r.punct, `${why} — punctuation not painted`).not.toBeNull();
  expect(r.lineLeft, `${why} — no other glyph on the punctuation's line`).toBeLessThan(Infinity);
  // Period on the LEFT end of its line (RTL sentence end).
  expect(r.punct!.left, `${why} — punctuation is not at the line's left end`).toBeLessThanOrEqual(
    r.lineLeft + tol,
  );
  expect(r.punct!.right, `${why} — punctuation painted right of line start`).toBeLessThan(
    r.lineRight,
  );
  if (opts.latin) {
    expect(r.latinFound, `${why} — Latin token ${JSON.stringify(opts.latin)} not in the text`).toBe(true);
    expect(r.latinBox, `${why} — Latin token not painted`).not.toBeNull();
    // Inside the token, letters read left-to-right.
    for (let k = 1; k < r.latinLefts.length; k++) {
      expect(r.latinLefts[k], `${why} — Latin letters out of LTR order`).toBeGreaterThan(
        r.latinLefts[k - 1],
      );
    }
    // The fixtures always embed the token mid-sentence, so both neighbours
    // must exist; a missing one means the wrong element or text was measured.
    expect(r.hasBefore, `${why} — no word before the Latin token`).toBe(true);
    expect(r.hasAfter, `${why} — no word after the Latin token`).toBe(true);
    // A neighbour that wrapped to another line is not comparable, but at
    // least one must share the token's line, or the order check would be empty.
    expect(
      r.beforeBox !== null || r.afterBox !== null,
      `${why} — neither neighbour word shares the Latin token's line`,
    ).toBe(true);
    // RTL word order around the token: logically-previous word to its right,
    // logically-next word to its left (each compared only on the token's line).
    if (r.beforeBox) {
      expect(r.beforeBox.left, `${why} — word before the token is not to its right`).toBeGreaterThanOrEqual(
        r.latinBox!.right - tol,
      );
    }
    if (r.afterBox) {
      expect(r.afterBox.right, `${why} — word after the token is not to its left`).toBeLessThanOrEqual(
        r.latinBox!.left + tol,
      );
    }
  }
}
