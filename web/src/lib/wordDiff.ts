// Word-level LCS diff shared by the note + verse history dialogs. Tokenizes
// runs of word chars vs non-word chars so whitespace + punctuation stay in
// their own tokens (a comma flipping to a period highlights cleanly without
// dragging the surrounding word along). Strings up to a few hundred tokens are
// plenty fast on a DP table.

export type DiffOp = { type: "eq" | "add" | "del"; text: string };

export function tokenize(s: string): string[] {
  return s.match(/\w+|\W+/g) ?? [];
}

// Unicode-aware variant: `\w` is ASCII-only, so Arabic or Hebrew text would
// come out as one big non-word token and diff as a whole-text replace.
export function tokenizeUnicode(s: string): string[] {
  return s.match(/[\p{L}\p{M}\p{N}_]+|[^\p{L}\p{M}\p{N}_]+/gu) ?? [];
}

export function diffWords(a: string, b: string, tok: (s: string) => string[] = tokenize): DiffOp[] {
  const A = tok(a);
  const B = tok(b);
  const m = A.length;
  const n = B.length;
  const dp: number[][] = Array.from({ length: m + 1 }, () =>
    new Array(n + 1).fill(0),
  );
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      dp[i][j] =
        A[i - 1] === B[j - 1]
          ? dp[i - 1][j - 1] + 1
          : Math.max(dp[i - 1][j], dp[i][j - 1]);
    }
  }
  const out: DiffOp[] = [];
  let i = m;
  let j = n;
  while (i > 0 && j > 0) {
    if (A[i - 1] === B[j - 1]) {
      out.push({ type: "eq", text: A[i - 1] });
      i--;
      j--;
    } else if (dp[i - 1][j] >= dp[i][j - 1]) {
      out.push({ type: "del", text: A[i - 1] });
      i--;
    } else {
      out.push({ type: "add", text: B[j - 1] });
      j--;
    }
  }
  while (i > 0) {
    out.push({ type: "del", text: A[i - 1] });
    i--;
  }
  while (j > 0) {
    out.push({ type: "add", text: B[j - 1] });
    j--;
  }
  out.reverse();
  // Merge runs of same-type ops so the rendered output has fewer spans.
  const merged: DiffOp[] = [];
  for (const op of out) {
    const last = merged[merged.length - 1];
    if (last && last.type === op.type) last.text += op.text;
    else merged.push({ ...op });
  }
  return merged;
}
