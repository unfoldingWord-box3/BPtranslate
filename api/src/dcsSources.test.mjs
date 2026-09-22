// Unit tests for fetchText and fetchDcsMasterText (dcsSources.ts) — the
// truncated-fetch transport guards. Stubs global fetch with crafted
// responses. Run from api/:
//   node --experimental-strip-types --no-warnings src/dcsSources.test.mjs
//
// Not a test framework; a failed assert exits non-zero.

import {
  fetchText,
  dcsFileSize,
  fetchDcsMasterText,
  dcsUrls,
  sourceProvenance,
  translationSourceRepoRef,
  scriptureImportOverrides,
  heldOutNoteResources,
  releaseLockedLaneHoldOuts,
  unlockedLaneHoldOutsToProbe,
  shouldReleaseProbedHoldOut,
  shouldFallBackOnStatus,
  resolveSourceRef,
  normalizeSourceRef,
} from "./dcsSources.ts";

function assert(cond, msg) {
  if (!cond) {
    console.error(`FAIL: ${msg}`);
    process.exit(1);
  }
  console.log(`  ok: ${msg}`);
}

// A minimal Response stand-in with full control over the content-length header.
function res({ ok = true, body = "", contentLength = undefined }) {
  return {
    ok,
    headers: {
      get: (k) => (k.toLowerCase() === "content-length" ? (contentLength ?? null) : null),
    },
    arrayBuffer: async () => new TextEncoder().encode(body).buffer,
  };
}

// A minimal JSON Response stand-in for the Gitea contents API (used by
// dcsFileSize / fetchDcsMasterText).
function jsonRes({ ok = true, body = {} }) {
  return {
    ok,
    headers: { get: () => null },
    json: async () => body,
  };
}

const env = { DCS_BASE_URL: "https://example.test" };

// Queue responses; each fetch() call shifts the next one.
let queue = [];
let calls = 0;
globalThis.fetch = async () => {
  calls++;
  if (queue.length === 0) throw new Error("fetch called more times than queued");
  return queue.shift();
};

// Silence the expected console.error/warn noise so the test output stays clean.
const origError = console.error;
const origWarn = console.warn;
console.error = () => {};
console.warn = () => {};

async function run() {
  // 1. Body matches declared content-length → returned as-is.
  queue = [res({ body: "hello world", contentLength: "11" })];
  calls = 0;
  assert((await fetchText("u")) === "hello world", "exact content-length → body returned");
  assert(calls === 1, "  ...single fetch, no retry");

  // 2. Body shorter than declared content-length → truncated → retry, second
  //    attempt is complete → returns the complete body.
  queue = [
    res({ body: "partial", contentLength: "999" }), // truncated
    res({ body: "the whole file", contentLength: "14" }), // complete
  ];
  calls = 0;
  assert((await fetchText("u")) === "the whole file", "short-vs-declared → retry yields complete body");
  assert(calls === 2, "  ...retried exactly once");

  // 3. Truncated on BOTH attempts → null (never accept a partial body).
  queue = [
    res({ body: "partial", contentLength: "999" }),
    res({ body: "still partial", contentLength: "999" }),
  ];
  calls = 0;
  assert((await fetchText("u")) === null, "short on both attempts → null");
  assert(calls === 2, "  ...two attempts then give up");

  // 4. No content-length at all (the HAB blind spot) → body is returned (the
  //    transport layer can't verify completeness; the reimport row-count gate
  //    is the backstop). The point of this case: a missing header is NOT, by
  //    itself, treated as a transport failure — so we don't break every file
  //    served without content-length.
  queue = [res({ body: "no-length body", contentLength: undefined })];
  calls = 0;
  assert((await fetchText("u")) === "no-length body", "missing content-length → body still returned");
  assert(calls === 1, "  ...no retry on missing content-length alone");

  // 5. Non-OK response → null immediately.
  queue = [res({ ok: false, body: "404", contentLength: "3" })];
  calls = 0;
  assert((await fetchText("u")) === null, "non-ok response → null");
  assert(calls === 1, "  ...no retry on non-ok");

  // 6. Longer-than-declared body (transparent gzip decode) → accepted, NOT
  //    treated as truncation.
  queue = [res({ body: "decoded is longer", contentLength: "5" })];
  calls = 0;
  assert((await fetchText("u")) === "decoded is longer", "longer-than-declared → accepted (gzip case)");

  // ── dcsFileSize ──────────────────────────────────────────────────────────

  // 7. Contents API reports a numeric size → returned as-is.
  queue = [jsonRes({ body: { size: 547000 } })];
  calls = 0;
  assert((await dcsFileSize(env, "unfoldingWord", "en_twl", "twl_PSA.tsv")) === 547000, "dcsFileSize: numeric size returned");
  assert(calls === 1, "  ...single fetch");

  // 8. Contents API 404 → null.
  queue = [jsonRes({ ok: false, body: {} })];
  assert((await dcsFileSize(env, "unfoldingWord", "en_twl", "twl_PSA.tsv")) === null, "dcsFileSize: non-ok → null");

  // 9. Contents API body missing a `size` field → null (never fabricate one).
  queue = [jsonRes({ body: {} })];
  assert((await dcsFileSize(env, "unfoldingWord", "en_twl", "twl_PSA.tsv")) === null, "dcsFileSize: missing size field → null");

  // 10. Network error → null.
  queue = [];
  globalThis.fetch = async () => {
    throw new Error("network down");
  };
  assert((await dcsFileSize(env, "unfoldingWord", "en_twl", "twl_PSA.tsv")) === null, "dcsFileSize: network error → null");
  globalThis.fetch = async () => {
    calls++;
    if (queue.length === 0) throw new Error("fetch called more times than queued");
    return queue.shift();
  };

  // ── fetchDcsMasterText — issue #494 regression ──────────────────────────
  // The defect: a no-Content-Length truncated master fetch used to be
  // accepted as a legitimately smaller master (fetchText has no way to catch
  // it). fetchDcsMasterText must catch it via the independent Gitea
  // contents-API size instead.

  // 11. THE ISSUE #494 CASE: no Content-Length on the raw fetch (the HAB
  //     shape) + a body far shorter than the contents API's recorded size on
  //     the first attempt, complete on the retry → retried, then returns the
  //     complete body. Before this fix there was no way to detect this at
  //     all; the short body would have been accepted outright.
  queue = [
    jsonRes({ body: { size: 20 } }), // contents API: file is 20 bytes on master
    res({ body: "short", contentLength: undefined }), // raw fetch #1: truncated, no Content-Length
    res({ body: "the complete master body", contentLength: undefined }), // raw fetch #2: complete (25 bytes)
  ];
  calls = 0;
  assert(
    (await fetchDcsMasterText(env, "unfoldingWord", "en_twl", "twl_PSA.tsv")).text === "the complete master body",
    "fetchDcsMasterText: no-CL short read vs contents-API size → retried → complete body",
  );
  assert(calls === 3, "  ...one contents-API call + two raw fetches");

  // 12. Same shape, but truncated on BOTH raw attempts → text null with
  //     truncated:true (fails closed — export.ts's masterFetchGate classifies
  //     a 200-with-null-text as "unreadable", so checkTsvShrink /
  //     checkUsfmAlignmentShrink block the export as master_unreadable,
  //     exactly like a network failure would; it must NOT read as a 404
  //     bootstrap).
  queue = [
    jsonRes({ body: { size: 20 } }),
    res({ body: "short", contentLength: undefined }),
    res({ body: "short", contentLength: undefined }),
  ];
  calls = 0;
  {
    const r = await fetchDcsMasterText(env, "unfoldingWord", "en_twl", "twl_PSA.tsv");
    assert(
      r.text === null && r.truncated === true && r.status === 200,
      "fetchDcsMasterText: no-CL short read on both attempts vs contents-API size → null text, truncated (master_unreadable)",
    );
  }
  assert(calls === 3, "  ...gives up after the retry");

  // 13. Complete body, no Content-Length, contents API agrees → accepted in
  //     one raw fetch (no false-positive retry when the body is actually
  //     whole).
  queue = [
    jsonRes({ body: { size: 11 } }), // "hello world" is 11 bytes
    res({ body: "hello world", contentLength: undefined }),
  ];
  calls = 0;
  assert(
    (await fetchDcsMasterText(env, "unfoldingWord", "en_twl", "twl_PSA.tsv")).text === "hello world",
    "fetchDcsMasterText: no-CL complete body matching contents-API size → accepted, no retry",
  );
  assert(calls === 2, "  ...one contents-API call + one raw fetch, no retry");

  // 14. Content-Length present and correct, contents API unreachable (null)
  //     → falls back to the Content-Length-only check, same as fetchText.
  //     Confirms the new check never turns a healthy fetch into a false
  //     block when the API happens to be unavailable.
  queue = [jsonRes({ ok: false, body: {} }), res({ body: "hello world", contentLength: "11" })];
  calls = 0;
  assert(
    (await fetchDcsMasterText(env, "unfoldingWord", "en_twl", "twl_PSA.tsv")).text === "hello world",
    "fetchDcsMasterText: contents-API unavailable, Content-Length correct → still accepted",
  );

  // 15. Both Content-Length AND contents-API size unavailable → body is
  //     still returned (matches fetchText's documented blind spot when
  //     NEITHER independent signal exists — nothing left to check against).
  queue = [jsonRes({ ok: false, body: {} }), res({ body: "unverifiable body", contentLength: undefined })];
  calls = 0;
  assert(
    (await fetchDcsMasterText(env, "unfoldingWord", "en_twl", "twl_PSA.tsv")).text === "unverifiable body",
    "fetchDcsMasterText: neither Content-Length nor contents-API size available → body still returned",
  );

  // 16. Non-ok raw response → null text immediately, preserving the status
  //     (contents API call still happens first, but a 404 on the raw
  //     endpoint is still a 404 — masterFetchGate needs the real status to
  //     tell a first-export bootstrap (#235) apart from an unreadable
  //     master).
  queue = [jsonRes({ body: { size: 11 } }), { ...res({ ok: false, body: "404" }), status: 404 }];
  calls = 0;
  {
    const r = await fetchDcsMasterText(env, "unfoldingWord", "en_twl", "twl_PSA.tsv");
    assert(r.text === null && r.status === 404, "fetchDcsMasterText: non-ok raw response → null text with real status");
  }
  assert(calls === 2, "  ...no retry on non-ok");

  console.error = origError;
  console.warn = origWarn;
  console.log("dcsSources/fetchText + fetchDcsMasterText: all assertions passed");

  runPure();
}

// ── Pure helpers: URL overrides + note-source provenance (no fetch/env/DB) ──

const ENV = { DCS_BASE_URL: "https://git.door43.org" };
const CFG = {
  org: "BSOJ",
  repos: {
    lit: "ar_avd", sim: "ar_nav", tn: "ar_tn", tq: "ar_tq", twl: "ar_twl",
    tw: "ar_tw", ta: "ar_ta",
  },
  translationSource: {
    org: "unfoldingWord",
    languageCode: "en",
    repos: {
      lit: "en_ult", sim: "en_ust", tn: "en_tn", tq: "en_tq", twl: "en_twl",
      tw: "en_tw", ta: "en_ta",
    },
  },
};

function runPure() {
  // No overrides → every URL points at the project's own org on master.
  const plain = dcsUrls(ENV, CFG, "ZEC");
  assert(plain.tn === "https://git.door43.org/BSOJ/ar_tn/raw/branch/master/tn_ZEC.tsv", "no overrides → tn from org repo");
  assert(plain.tq === "https://git.door43.org/BSOJ/ar_tq/raw/branch/master/tq_ZEC.tsv", "no overrides → tq from org repo");
  assert(plain.twl === "https://git.door43.org/BSOJ/ar_twl/raw/branch/master/twl_ZEC.tsv", "no overrides → twl from org repo");
  assert(plain.ult === "https://git.door43.org/BSOJ/ar_avd/raw/branch/master/38-ZEC.usfm", "no overrides → lit from org repo");

  // tn/tq overrides → those two URLs move to the override owner/repo/ref;
  // twl and lit/sim are untouched.
  const over = dcsUrls(ENV, CFG, "ZEC", {
    tn: { owner: "unfoldingWord", repo: "en_tn", ref: "v86" },
    tq: { owner: "unfoldingWord", repo: "en_tq", ref: "master" },
  });
  assert(over.tn === "https://git.door43.org/unfoldingWord/en_tn/raw/branch/v86/tn_ZEC.tsv", "tn override → owner/repo/ref honoured");
  assert(over.tq === "https://git.door43.org/unfoldingWord/en_tq/raw/branch/master/tq_ZEC.tsv", "tq override → owner/repo honoured");
  assert(over.twl === plain.twl, "tn/tq overrides leave twl on the org repo");
  assert(over.ult === plain.ult && over.ust === plain.ust, "tn/tq overrides leave lit/sim untouched");

  // twl override → honored the same way tn/tq are (translate-mode import).
  const overTwl = dcsUrls(ENV, CFG, "ZEC", {
    twl: { owner: "unfoldingWord", repo: "en_twl", ref: "v86" },
  });
  assert(
    overTwl.twl === "https://git.door43.org/unfoldingWord/en_twl/raw/branch/v86/twl_ZEC.tsv",
    "twl override → owner/repo/ref honoured",
  );
  assert(overTwl.tn === plain.tn && overTwl.tq === plain.tq, "twl override leaves tn/tq untouched");
  assert(overTwl.ult === plain.ult && overTwl.ust === plain.ust, "twl override leaves lit/sim untouched");

  // Provenance marker + source repo refs.
  assert(sourceProvenance("unfoldingWord", "en_tn") === "source:unfoldingWord/en_tn", "sourceProvenance shape");
  const tnRef = translationSourceRepoRef(CFG, "tn");
  assert(
    tnRef.owner === "unfoldingWord" && tnRef.repo === "en_tn" && tnRef.ref === "master",
    "translationSourceRepoRef(tn) → source org + en_tn on master",
  );
  assert(translationSourceRepoRef(CFG, "tq").repo === "en_tq", "translationSourceRepoRef(tq) → en_tq");
  assert(
    translationSourceRepoRef({ ...CFG, translationSource: null }, "tn") === null,
    "no translationSource → null (authored project)",
  );
  // Partial translationSource: a role omitted from repos (blank in Setup) → null,
  // NOT a RepoRef with an undefined repo (which would build org/undefined@master).
  const partialCfg = {
    ...CFG,
    translationSource: { org: "unfoldingWord", languageCode: "en", repos: { tn: "en_tn" } },
  };
  assert(
    translationSourceRepoRef(partialCfg, "tn").repo === "en_tn",
    "partial source: present tn role → its RepoRef",
  );
  assert(
    translationSourceRepoRef(partialCfg, "tq") === null,
    "partial source: absent tq role → null (no undefined repo)",
  );

  // translationSourceRepoRef now also resolves lit/sim/twl (translate-mode
  // scripture import), delegating to the same role-generic resolveSourceRef.
  assert(
    translationSourceRepoRef(CFG, "lit").repo === "en_ult",
    "translationSourceRepoRef(lit) → en_ult",
  );
  assert(
    translationSourceRepoRef(CFG, "sim").repo === "en_ust",
    "translationSourceRepoRef(sim) → en_ust",
  );
  assert(
    translationSourceRepoRef(CFG, "twl").repo === "en_twl",
    "translationSourceRepoRef(twl) → en_twl",
  );
  // A role blank in the translationSource (not configured in Setup) → null,
  // same "no upstream source for this resource" contract as tn/tq.
  const partialScriptureCfg = {
    ...CFG,
    translationSource: { org: "unfoldingWord", languageCode: "en", repos: { tn: "en_tn" } },
  };
  assert(
    translationSourceRepoRef(partialScriptureCfg, "lit") === null,
    "translationSourceRepoRef(lit): absent role → null",
  );
  assert(
    translationSourceRepoRef(partialScriptureCfg, "twl") === null,
    "translationSourceRepoRef(twl): absent role → null",
  );

  // ── scriptureImportOverrides — importBookFromDcs's lit/sim/twl decision ──
  const laneLit = { owner: "BSOJ", repo: "ar_avd", ref: "master" };
  const laneSim = { owner: "BSOJ", repo: "ar_nav", ref: "master" };
  const unlocked = { lit: false, sim: false };
  const locked = { lit: true, sim: true };

  // Load mode (translateFromSource=false) → always the lane/org refs, twl
  // absent from the result, no fallback offered.
  const loadMode = scriptureImportOverrides(CFG, false, laneLit, laneSim, unlocked);
  assert(
    loadMode.lit === laneLit && loadMode.sim === laneSim,
    "scriptureImportOverrides: load mode → lane refs, unchanged",
  );
  assert(loadMode.twl === undefined, "scriptureImportOverrides: load mode → no twl override");
  assert(
    !loadMode.fromSource.lit && !loadMode.fromSource.sim && !loadMode.fromSource.twl,
    "scriptureImportOverrides: load mode → fromSource all false",
  );
  assert(
    loadMode.fallback.lit === null && loadMode.fallback.sim === null,
    "scriptureImportOverrides: load mode → no scripture fallback",
  );

  // Translate mode, unlocked lanes: ULT/UST STILL come from the lane repo —
  // the project's own scripture text wins whenever it has the book. The English
  // translationSource is only OFFERED as the 404 fallback; fromSource stays
  // false until bookImport actually takes it. twl keeps the eager swap.
  // Regression: BSOJ LUK (2026-09) imported en_ult/en_ust into lanes labelled
  // AR_AVD/AR_NAV because this used to swap eagerly.
  const translateMode = scriptureImportOverrides(CFG, true, laneLit, laneSim, unlocked);
  assert(
    translateMode.lit === laneLit && translateMode.sim === laneSim,
    "scriptureImportOverrides: translate mode → lit/sim stay on the lane repo (never eager English)",
  );
  assert(
    !translateMode.fromSource.lit && !translateMode.fromSource.sim,
    "scriptureImportOverrides: translate mode → lit/sim fromSource false until a 404 fallback",
  );
  assert(
    translateMode.fallback.lit?.repo === "en_ult" && translateMode.fallback.sim?.repo === "en_ust",
    "scriptureImportOverrides: translate mode, unlocked → English offered as 404 fallback",
  );
  assert(translateMode.twl?.repo === "en_twl", "scriptureImportOverrides: translate mode → twl from translationSource");
  assert(translateMode.fromSource.twl, "scriptureImportOverrides: translate mode → fromSource.twl true");

  // Translate mode, LOCKED lanes (textReadOnly, e.g. BSOJ AVD/NAV): no
  // fallback at all — a missing book on a published Bible is an error, not a
  // reason to show English.
  const lockedTranslate = scriptureImportOverrides(CFG, true, laneLit, laneSim, locked);
  assert(
    lockedTranslate.lit === laneLit && lockedTranslate.sim === laneSim,
    "scriptureImportOverrides: locked lanes → lane refs",
  );
  assert(
    lockedTranslate.fallback.lit === null && lockedTranslate.fallback.sim === null,
    "scriptureImportOverrides: locked lanes → no English fallback",
  );
  assert(lockedTranslate.twl?.repo === "en_twl", "scriptureImportOverrides: locked lanes → twl still from translationSource");

  // Per-lane lock: only the locked lane loses its fallback.
  const halfLocked = scriptureImportOverrides(CFG, true, laneLit, laneSim, { lit: true, sim: false });
  assert(
    halfLocked.fallback.lit === null && halfLocked.fallback.sim?.repo === "en_ust",
    "scriptureImportOverrides: per-lane lock → only the locked lane loses its fallback",
  );

  // Translate mode with translationSource missing a role → no fallback for
  // that role, twl absent (falls through to org).
  const partialTranslateOverrides = scriptureImportOverrides(partialScriptureCfg, true, laneLit, laneSim, unlocked);
  assert(
    partialTranslateOverrides.lit === laneLit && partialTranslateOverrides.fallback.lit === null,
    "scriptureImportOverrides: translate mode, blank lit role → lane ref, no fallback",
  );
  assert(
    partialTranslateOverrides.twl === undefined,
    "scriptureImportOverrides: translate mode, blank twl role → no override (falls through to org)",
  );
  assert(
    !partialTranslateOverrides.fromSource.lit && !partialTranslateOverrides.fromSource.twl,
    "scriptureImportOverrides: blank roles report fromSource=false",
  );

  // ── releaseLockedLaneHoldOuts — reimport self-heal for poisoned locked lanes ──
  const heldAll = new Set(["ult", "ust", "twl", "tn"]);
  assert(
    releaseLockedLaneHoldOuts(heldAll, unlocked).length === 0,
    "releaseLockedLaneHoldOuts: unlocked lanes → nothing released (provenance may be legitimate)",
  );
  assert(
    releaseLockedLaneHoldOuts(heldAll, locked).join(",") === "ult,ust",
    "releaseLockedLaneHoldOuts: locked lanes → ult+ust released, twl/tn untouched",
  );
  assert(
    releaseLockedLaneHoldOuts(heldAll, { lit: true, sim: false }).join(",") === "ult",
    "releaseLockedLaneHoldOuts: per-lane",
  );
  assert(
    releaseLockedLaneHoldOuts(new Set(["twl"]), locked).length === 0,
    "releaseLockedLaneHoldOuts: nothing held for ult/ust → nothing released",
  );

  // ── unlockedLaneHoldOutsToProbe — issue #441 self-heal candidate selection ──
  // The mirror of releaseLockedLaneHoldOuts: locked lanes are handled there
  // (released blind); this returns the held ult/ust on UNLOCKED lanes, which
  // must be probed before releasing.
  assert(
    unlockedLaneHoldOutsToProbe(heldAll, locked).length === 0,
    "unlockedLaneHoldOutsToProbe: locked lanes → nothing to probe (releaseLockedLaneHoldOuts handles them)",
  );
  assert(
    unlockedLaneHoldOutsToProbe(heldAll, unlocked).join(",") === "ult,ust",
    "unlockedLaneHoldOutsToProbe: unlocked lanes → ult+ust probed, twl/tn untouched",
  );
  assert(
    unlockedLaneHoldOutsToProbe(heldAll, { lit: false, sim: true }).join(",") === "ult",
    "unlockedLaneHoldOutsToProbe: per-lane (only the unlocked one is probed)",
  );
  assert(
    unlockedLaneHoldOutsToProbe(new Set(["twl", "tn"]), unlocked).length === 0,
    "unlockedLaneHoldOutsToProbe: nothing held for ult/ust → nothing to probe",
  );
  // Complementary with releaseLockedLaneHoldOuts on a mixed lane pair: every
  // held ult/ust lands in exactly one bucket (locked→release, unlocked→probe).
  assert(
    releaseLockedLaneHoldOuts(heldAll, { lit: true, sim: false }).join(",") === "ult" &&
      unlockedLaneHoldOutsToProbe(heldAll, { lit: true, sim: false }).join(",") === "ust",
    "locked/unlocked buckets are complementary on a mixed lane pair",
  );

  // ── shouldReleaseProbedHoldOut — only a whole 200 lifts the fallback ──
  assert(
    shouldReleaseProbedHoldOut({ status: 200, text: "\\id LUK\n" }) === true,
    "shouldReleaseProbedHoldOut: 200 with body → release (lane repo now has the book)",
  );
  assert(
    shouldReleaseProbedHoldOut({ status: 404, text: null }) === false,
    "shouldReleaseProbedHoldOut: 404 → keep held (lane still lacks the book)",
  );
  assert(
    shouldReleaseProbedHoldOut({ status: 0, text: null }) === false,
    "shouldReleaseProbedHoldOut: network error (status 0) → keep held (transient)",
  );
  assert(
    shouldReleaseProbedHoldOut({ status: 500, text: null }) === false,
    "shouldReleaseProbedHoldOut: 5xx → keep held (transient)",
  );
  assert(
    shouldReleaseProbedHoldOut({ status: 200, text: null, truncated: true }) === false,
    "shouldReleaseProbedHoldOut: truncated 200 → keep held (never re-pull a partial)",
  );

  // ── resolveSourceRef + normalizeSourceRef (the shared per-resource accessor) ──
  // Backward-compat: a bare repo STRING resolves under the default (primary) org.
  assert(
    JSON.stringify(normalizeSourceRef("unfoldingWord", "en_tn")) ===
      JSON.stringify({ org: "unfoldingWord", repo: "en_tn" }),
    "normalizeSourceRef: bare string → { defaultOrg, repo }",
  );
  assert(normalizeSourceRef("unfoldingWord", undefined) === null, "normalizeSourceRef: undefined → null");
  assert(normalizeSourceRef("unfoldingWord", "") === null, "normalizeSourceRef: blank string → null");
  assert(normalizeSourceRef("unfoldingWord", { repo: "" }) === null, "normalizeSourceRef: blank repo ref → null");
  // Per-resource org: an { org, repo } ref points at a DIFFERENT org.
  assert(
    JSON.stringify(normalizeSourceRef("unfoldingWord", { org: "BibleAquifer", repo: "ar_tn" })) ===
      JSON.stringify({ org: "BibleAquifer", repo: "ar_tn" }),
    "normalizeSourceRef: { org, repo } → honors the override org",
  );
  // An org-less ref falls back to the default org.
  assert(
    JSON.stringify(normalizeSourceRef("unfoldingWord", { repo: "en_tq" })) ===
      JSON.stringify({ org: "unfoldingWord", repo: "en_tq" }),
    "normalizeSourceRef: { repo } (no org) → default org",
  );

  // resolveSourceRef over a mixed/partial map: legacy string + per-resource org.
  const mixedTs = {
    org: "unfoldingWord",
    languageCode: "en",
    repos: { tn: "en_tn", tw: { org: "BibleAquifer", repo: "ar_tw" }, ta: { repo: "en_ta" } },
  };
  assert(
    JSON.stringify(resolveSourceRef(mixedTs, "tn")) === JSON.stringify({ org: "unfoldingWord", repo: "en_tn" }),
    "resolveSourceRef: legacy string role → default org",
  );
  assert(
    JSON.stringify(resolveSourceRef(mixedTs, "tw")) === JSON.stringify({ org: "BibleAquifer", repo: "ar_tw" }),
    "resolveSourceRef: per-resource org override honored",
  );
  assert(
    JSON.stringify(resolveSourceRef(mixedTs, "ta")) === JSON.stringify({ org: "unfoldingWord", repo: "en_ta" }),
    "resolveSourceRef: org-less object role → default org",
  );
  assert(resolveSourceRef(mixedTs, "tq") === null, "resolveSourceRef: absent role → null");
  assert(resolveSourceRef(null, "tn") === null, "resolveSourceRef: no translationSource → null");

  // translationSourceRepoRef delegates → a per-resource org override flows to the
  // import/reimport RepoRef (owner is the override org, not translationSource.org).
  const overrideOrgCfg = {
    ...CFG,
    translationSource: { org: "unfoldingWord", languageCode: "en", repos: { tn: { org: "BibleAquifer", repo: "ar_tn" } } },
  };
  const overRef = translationSourceRepoRef(overrideOrgCfg, "tn");
  assert(
    overRef.owner === "BibleAquifer" && overRef.repo === "ar_tn" && overRef.ref === "master",
    "translationSourceRepoRef: per-resource org override → owner is the override org",
  );

  // ── SECURITY: non-ident override org/repo must never yield a usable ref ──
  // A non-custom-preset override reaches normalizeSourceRef UNVALIDATED. A path-
  // traversal org/repo must resolve to null (treated as no-source), never a ref.
  assert(
    normalizeSourceRef("unfoldingWord", { org: "uW/../../other", repo: "x_tn" }) === null,
    "normalizeSourceRef: traversal in org → null (no source)",
  );
  assert(
    normalizeSourceRef("unfoldingWord", { repo: "../../../etc" }) === null,
    "normalizeSourceRef: traversal in repo → null",
  );
  assert(normalizeSourceRef("unfoldingWord", "bad repo!") === null, "normalizeSourceRef: non-ident bare string → null");
  const evilTs = {
    org: "unfoldingWord",
    languageCode: "en",
    repos: { tn: { org: "a/../../b", repo: "x_tn" }, tq: "ok_tq" },
  };
  assert(resolveSourceRef(evilTs, "tn") === null, "resolveSourceRef: traversal org role → null");
  assert(
    JSON.stringify(resolveSourceRef(evilTs, "tq")) === JSON.stringify({ org: "unfoldingWord", repo: "ok_tq" }),
    "resolveSourceRef: a valid sibling role still resolves (only the bad one is dropped)",
  );

  // Belt-and-suspenders: even if a slash-bearing owner/repo reached a URL builder
  // (it can't via resolveSourceRef, but a legacy DcsRepoOverrides caller might),
  // dcsUrls encodes the owner/repo segments so no traversal escapes.
  const traversalUrls = dcsUrls(ENV, CFG, "ZEC", {
    tn: { owner: "a/../../evil", repo: "x_tn", ref: "master" },
  });
  assert(
    !traversalUrls.tn.includes("/../") && traversalUrls.tn.includes("a%2F..%2F..%2Fevil"),
    "dcsUrls: owner/repo segments encoded — traversal neutralized",
  );

  // Held-out predicate — any non-null marker means "don't sync with the org repo".
  const setOf = (p) => [...heldOutNoteResources(p)].sort().join(",");
  assert(setOf(null) === "", "null provenance → nothing held out");
  assert(setOf(undefined) === "", "undefined provenance → nothing held out");
  assert(setOf({ tn_source: null, tq_source: null }) === "", "all-null provenance → nothing held out");
  assert(setOf({ tn_source: "aquifer:arb" }) === "tn", "aquifer tn → tn held out");
  assert(
    setOf({ tn_source: "source:unfoldingWord/en_tn", tq_source: "source:unfoldingWord/en_tq" }) === "tn,tq",
    "source-sourced tn+tq → both held out",
  );
  assert(setOf({ tq_source: "source:unfoldingWord/en_tq" }) === "tq", "source-sourced tq only → tq held out");

  // Issue #142: heldOutNoteResources widened to also cover ult/ust/twl
  // provenance (scripture/twl-from-translationSource has no Aquifer path, so
  // only 'source:<owner>/<repo>' shows up in these three columns).
  assert(
    setOf({ ult_source: null, ust_source: null, twl_source: null }) === "",
    "all-null scripture provenance → nothing held out",
  );
  assert(
    setOf({ ult_source: "source:unfoldingWord/en_ult" }) === "ult",
    "source-sourced ult only → ult held out",
  );
  assert(
    setOf({ ust_source: "source:unfoldingWord/en_ust" }) === "ust",
    "source-sourced ust only → ust held out",
  );
  assert(
    setOf({ twl_source: "source:unfoldingWord/en_twl" }) === "twl",
    "source-sourced twl only → twl held out",
  );
  assert(
    setOf({
      tn_source: "source:unfoldingWord/en_tn",
      tq_source: "source:unfoldingWord/en_tq",
      ult_source: "source:unfoldingWord/en_ult",
      ust_source: "source:unfoldingWord/en_ust",
      twl_source: "source:unfoldingWord/en_twl",
    }) === "tn,tq,twl,ult,ust",
    "all five source-pulled → all five held out (force+translateFromSource over a populated org/lane)",
  );

  // Auto-fallback trigger: ONLY a hard 404 means "the org genuinely has no such
  // file". Every transient failure must keep the import failing + retrying
  // rather than silently substituting English notes.
  assert(shouldFallBackOnStatus(404) === true, "404 → fall back to translation source");
  assert(shouldFallBackOnStatus(0) === false, "network error (status 0) → no fallback");
  assert(shouldFallBackOnStatus(500) === false, "5xx → no fallback");
  assert(shouldFallBackOnStatus(502) === false, "502 → no fallback");
  assert(shouldFallBackOnStatus(429) === false, "rate limit → no fallback");
  // A truncated read surfaces as {status:200, text:null} — must not fall back.
  assert(shouldFallBackOnStatus(200) === false, "truncated 200 → no fallback");
  assert(shouldFallBackOnStatus(403) === false, "403 (auth) → no fallback");

  console.log("dcsSources/pure helpers: all assertions passed");
}

run().catch((e) => {
  console.error = origError;
  console.error("threw:", e);
  process.exit(1);
});
