// Unit tests for the pipeline import single-applier claim (pipelineImport.ts).
// The regression the ISA 48 incident demands: two pollers (the */5 cron and a
// translator's open tab polling GET /api/pipelines/:jobId) must never both run
// the destructive delete/insert apply for one job — their chapter-scoped TN
// deletes interleaved and wiped/doubled the chapter (2026-06-30). The
// production guard is one atomic CAS UPDATE; mayClaimImport is its predicate,
// tested here so the concurrency rule can't silently regress.
// Run from api/:
//   node --experimental-strip-types --no-warnings src/pipelineImport.test.mjs
//
// Not a test framework; a failed assert exits non-zero.

import { mayClaimImport, IMPORT_CLAIM_STALE_SECONDS } from "./pipelineImportClaim.ts";
import { rawUrlOriginError } from "./rawUrlPin.ts";

function assert(cond, msg) {
  if (!cond) {
    console.error(`FAIL: ${msg}`);
    process.exit(1);
  }
  console.log(`  ok: ${msg}`);
}

const NOW = 1_000_000;

// --- Unclaimed slot: the first poller may take it ---
assert(mayClaimImport(null, NOW), "unclaimed (NULL) → may claim");

// --- The race: once a poller claims, a concurrent racer must NOT re-claim ---
// Model the atomic CAS: poller A wins and stamps import_claimed_at = NOW.
// Poller B, which read the same pre-apply state, now re-evaluates against the
// stamped value and must be refused.
const afterA = NOW; // A's claim timestamp
assert(
  !mayClaimImport(afterA, NOW),
  "fresh claim by a concurrent poller → refused (no interleaving second apply)",
);
assert(
  !mayClaimImport(afterA, NOW + 1),
  "claim 1s old → still refused",
);
assert(
  !mayClaimImport(afterA, NOW + IMPORT_CLAIM_STALE_SECONDS),
  "claim exactly at the stale window → still held (strictly-less-than)",
);

// --- Crash recovery: a claim left dangling by a hard Worker death (no JS
//     throw to release it) becomes reclaimable once older than the window ---
assert(
  mayClaimImport(afterA, NOW + IMPORT_CLAIM_STALE_SECONDS + 1),
  "claim older than the stale window → reclaimable (crash recovery)",
);

// --- Release path: a failed apply sets import_claimed_at back to NULL, so the
//     one-retry poll can immediately re-import ---
assert(
  mayClaimImport(null, NOW + 5),
  "released claim (NULL) → immediately reclaimable for the retry",
);

// --- The stale window must comfortably exceed a real apply (~1 min) so a
//     still-running apply is never reclaimed out from under itself ---
assert(
  IMPORT_CLAIM_STALE_SECONDS >= 300,
  `stale window (${IMPORT_CLAIM_STALE_SECONDS}s) is well beyond a real apply`,
);

// --- rawUrl origin pin: the bot's poll response must not be able to point
//     the Worker at an arbitrary host (content would be staged into
//     pending_imports and from there reach the live tables) ---
const DCS = "https://git.door43.org";
assert(
  rawUrlOriginError(`${DCS}/unfoldingWord/en_tn/raw/branch/x/tn_ZEC.tsv`, DCS) === null,
  "DCS-origin rawUrl allowed",
);
assert(
  rawUrlOriginError("https://evil.example/payload.tsv", DCS) !== null,
  "foreign-host rawUrl rejected",
);
assert(
  rawUrlOriginError("http://git.door43.org/x.tsv", DCS) !== null,
  "scheme downgrade to http rejected (origin compare includes scheme)",
);
assert(
  rawUrlOriginError("https://git.door43.org.evil.example/x.tsv", DCS) !== null,
  "suffix-spoofed hostname rejected",
);
assert(
  rawUrlOriginError("not a url", DCS) !== null,
  "unparseable rawUrl rejected",
);
console.log("pipelineImport (claim guard): all assertions passed");

// ─── tnPayload / tqPayload quote curling (AI-pipeline note/question/response) ──
// Upstream JER 32/33 / NUM 26:53 prod forensics found straight quotes in
// AI-pipeline output that exported verbatim to Door43 master. Verse text is
// curled in applyVerseUpdate's self-heal block (curlifyVerseObjects); these
// pin the sibling fix for note/question/response PROSE, which must use the
// SAME shared curlifyText (importParsers.ts) as verse text — not
// tsvFormat.ts's educateQuotes — so a straight quote curls identically in an
// AI-drafted verse and an AI-drafted note from the same run.
// Ported from upstream unfoldingWord/bible-editor 7a535ea (#445).
{
  const { tnPayload, tqPayload } = await import("./pipelineImport.ts");

  const tn = tnPayload("ZEC", "1:1", {
    ID: "ab12",
    Tags: "",
    SupportReference: "",
    Quote: 'don׳t "touch" me', // Quote must stay byte-exact — never curled
    Occurrence: "1",
    Note: `The word "glory" means God's weighty presence.`,
  });
  assert(
    tn.payload.note === "The word “glory” means God’s weighty presence.",
    `tnPayload curls straight quotes in Note prose (got ${JSON.stringify(tn.payload.note)})`,
  );
  assert(
    tn.payload.quote === 'don׳t "touch" me',
    "tnPayload leaves Quote byte-exact (occurrence matching depends on it)",
  );

  const tq = tqPayload("ZEC", "1:2", {
    ID: "cd34",
    Tags: "",
    Quote: '"as-is"',
    Occurrence: "1",
    Question: `What does "return" mean?`,
    Response: `It means to turn back to Yahweh's ways.`,
  });
  assert(
    tq.payload.question === "What does “return” mean?",
    `tqPayload curls straight quotes in Question (got ${JSON.stringify(tq.payload.question)})`,
  );
  assert(
    tq.payload.response === "It means to turn back to Yahweh’s ways.",
    `tqPayload curls the apostrophe in Response (got ${JSON.stringify(tq.payload.response)})`,
  );
  assert(tq.payload.quote === '"as-is"', "tqPayload leaves Quote byte-exact");

  // Empty fields stay null — curling must not turn "" into a non-null value.
  const tnEmpty = tnPayload("ZEC", "1:3", { ID: "ef56", Occurrence: "" });
  assert(tnEmpty.payload.note === null, "tnPayload: absent Note stays null after the curl wiring");
  const tqEmpty = tqPayload("ZEC", "1:4", { ID: "gh78", Occurrence: "" });
  assert(
    tqEmpty.payload.question === null && tqEmpty.payload.response === null,
    "tqPayload: absent Question/Response stay null after the curl wiring",
  );
  console.log("pipelineImport (payload quote curling): all assertions passed");
}
