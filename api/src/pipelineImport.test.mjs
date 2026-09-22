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
import { importJobOutput } from "./pipelineImport.ts";
import { coerceRowId, deriveAltRowId } from "./rowId.ts";

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
// Deterministic clock for the fake-D1 apply tests below: applyTqUpsert stamps
// updated_at from Date.now(), so pin it (advancing 16s per read) to keep runs
// reproducible. Mirrors the upstream suite's withMockedClock helper.
async function withMockedClock(fn) {
  const originalNow = Date.now;
  let t = 1_700_000_000_000;
  Date.now = () => {
    t += 16_000;
    return t;
  };
  try {
    return await fn();
  } finally {
    Date.now = originalNow;
  }
}

// ── TQ candidate-id chain: an 8-long DETERMINISTIC chain (seedId, then
//    deriveAltRowId(seedId, 1..7)) walked per proposal. Live-in-same-chapter
//    -> UPDATE; live-in-different-chapter -> step past it; no live row ->
//    INSERT, stepping past a tombstoned PK slot (UNIQUE/PRIMARY KEY) rather
//    than throwing; any other insert error rethrows immediately. The
//    load-bearing property is RE-RUN IDEMPOTENCY: because the chain is
//    deterministic, a second job proposing the same chapter walks the same
//    candidates, finds the row the first run created, and UPDATEs it instead
//    of inserting a duplicate. (1CH 23:7 proposed `hoig`, held by a
//    hand-deleted 1CH 5:4 question — the original incident this guard traces
//    to; the re-run-doubling failure mode is the reason the fix was redesigned
//    away from random re-minting.)

// Configurable fake tq_rows + pipeline_jobs backing store. `liveRows` is a
// mutable Map<id, {version, chapter, verse}> so callers can pre-seed a live row (the
// cross-chapter test) and so the map persists across multiple importJobOutput
// calls against the same env (the re-run-idempotency test). `tombstonedIds`
// simulates a soft-deleted row that still owns its (book, id) PK slot (the
// live-row SELECT filters deleted_at IS NULL, but the INSERT constraint has no
// such filter). `hardErrorIds` simulates a non-UNIQUE insert failure that must
// propagate rather than being retried down the chain.
function buildFakeTqDb({ tombstonedIds = new Set(), hardErrorIds = new Set(), racedIds = new Set(), liveRows = new Map() } = {}) {
  const batches = [];
  const insertedIds = [];
  const updatedIds = [];
  const updatedVerses = [];
  const insertAttempts = [];
  const insertArgs = [];
  const acceptedPendingIds = [];
  const dbState = { claimedAt: 4000 };
  // Row count of the most-recent `UPDATE tq_rows SET` dispatched, so the accept
  // (`... AND changes() > 0`) and the EXISTS-gated audit INSERT in applyTqUpsert
  // can report changes:0 when the guarded UPDATE they depend on matched nothing
  // — the way real SQLite would in one batch. See the CAS-conflict test.
  let lastTqUpdateChanges = 1;

  // Each importJobOutput call issues exactly one pending_imports SELECT (in
  // applyJobOutput); proposalsQueue hands out one array per call, in order, so
  // a caller simulating "a new job re-proposes the same content" pushes a
  // fresh array for each run rather than reusing object identity.
  const proposalsQueue = [];
  let proposalsCallIndex = 0;
  function setProposals(rows) {
    proposalsQueue.push(rows);
  }

  function dispatch(sql, args) {
    if (/UPDATE pipeline_jobs SET import_claimed_at = unixepoch\(\)/.test(sql) && /IS NULL OR/.test(sql)) {
      return { changes: 1, rows: [{ import_claimed_at: dbState.claimedAt }], single: { import_claimed_at: dbState.claimedAt } };
    }
    if (/SELECT staged_at FROM pipeline_jobs/.test(sql)) {
      return { changes: 0, rows: [], single: { staged_at: 999999 } }; // already staged
    }
    if (/SELECT user_id,/.test(sql)) {
      // applyJobOutput's starter lookup (user_id + source stamp columns +
      // pipeline_type; a non-"translate" pipeline_type keeps the tq upsert path).
      return {
        changes: 0,
        rows: [],
        single: {
          user_id: 1,
          source_generation: null,
          source_owner: null,
          source_repo: null,
          source_ref: null,
          source_stamps_json: null,
          pipeline_type: "tqs",
        },
      };
    }
    if (/ORDER BY kind, chapter, verse, id/.test(sql)) {
      const rows = proposalsQueue[proposalsCallIndex] ?? [];
      proposalsCallIndex += 1;
      return { changes: 0, rows, single: null };
    }
    if (/MAX\(sort_order\)/.test(sql)) {
      return { changes: 0, rows: [], single: null };
    }
    if (/SELECT version, chapter, verse FROM tq_rows/.test(sql)) {
      const id = args[0];
      const row = liveRows.get(id) ?? null;
      return { changes: 0, rows: row ? [row] : [], single: row };
    }
    if (/UPDATE tq_rows\s+SET/.test(sql)) {
      // bind order per applyTqUpsert's UPDATE: ref_raw(0), tags(1), quote(2),
      // occurrence(3), question(4), response(5), sort_order(6), verse(7),
      // updated_at(8), updated_by(9), id(10), book(11), expectedVersion(12).
      const id = args[10];
      const expectedVersion = args[12];
      const live = liveRows.get(id);
      // CAS: the UPDATE only matches while `version = ?13` still holds. For an id
      // in racedIds, simulate a concurrent writer that advanced the version
      // AFTER applyTqUpsert's SELECT read it (the SELECT returned live.version,
      // which is what got bound), so the compare-and-swap misses by one.
      let effectiveStored = live ? live.version : expectedVersion;
      if (racedIds.has(id)) {
        effectiveStored = (live?.version ?? 0) + 1;
        racedIds.delete(id); // one simulated race per id
      }
      if (effectiveStored !== expectedVersion) {
        lastTqUpdateChanges = 0;
        return { changes: 0, rows: [], single: null };
      }
      lastTqUpdateChanges = 1;
      updatedIds.push(id);
      updatedVerses.push(args[7]);
      if (live) live.version = expectedVersion + 1;
      return { changes: 1, rows: [], single: null };
    }
    if (/INSERT INTO tq_rows/.test(sql)) {
      const id = args[0];
      const chapter = args[2];
      const verse = args[3];
      insertAttempts.push(id);
      insertArgs.push(args);
      if (hardErrorIds.has(id)) {
        throw new Error("D1_ERROR: NOT NULL constraint failed: tq_rows.question: SQLITE_CONSTRAINT_NOTNULL");
      }
      if (tombstonedIds.has(id)) {
        throw new Error(
          "D1_ERROR: UNIQUE constraint failed: tq_rows.book, tq_rows.id: SQLITE_CONSTRAINT (extended: SQLITE_CONSTRAINT_PRIMARYKEY)",
        );
      }
      insertedIds.push(id);
      liveRows.set(id, { version: 1, chapter, verse });
      return { changes: 1, rows: [], single: null };
    }
    if (/INSERT INTO edit_log/.test(sql)) {
      // The tq UPDATE-path audit self-gates on `WHERE EXISTS (... FROM tq_rows
      // ...)`; it must report no write when the guarded UPDATE it depends on
      // missed. The create-path audit (plain VALUES) always lands.
      if (/WHERE EXISTS/.test(sql) && /FROM tq_rows/.test(sql)) {
        return { changes: lastTqUpdateChanges > 0 ? 1 : 0, rows: [], single: null };
      }
      return { changes: 1, rows: [], single: null };
    }
    if (/SET accepted_at = unixepoch\(\), accepted_by = \?2/.test(sql)) {
      // The tq UPDATE-path accept carries `AND changes() > 0`; it must not
      // accept the proposal when the guarded UPDATE before it matched nothing.
      // The create-path / lane-skip accepts (no changes() clause) always land.
      if (/changes\(\) > 0/.test(sql) && lastTqUpdateChanges === 0) {
        return { changes: 0, rows: [], single: null };
      }
      acceptedPendingIds.push(args[0]);
      return { changes: 1, rows: [], single: null };
    }
    if (/UPDATE pipeline_jobs SET import_claimed_at = NULL/.test(sql)) {
      return { changes: 1, rows: [], single: null };
    }
    throw new Error(`fakeTqDb: unhandled SQL: ${sql}`);
  }

  const env = {
    DB: {
      prepare(sql) {
        return {
          bind(...args) {
            return {
              sql,
              args,
              async run() {
                const res = dispatch(sql, args);
                return { meta: { changes: res.changes }, results: res.rows };
              },
              async first() {
                return dispatch(sql, args).single;
              },
              async all() {
                return { results: dispatch(sql, args).rows };
              },
            };
          },
        };
      },
      async batch(stmts) {
        const results = [];
        const batchSqls = [];
        for (const s of stmts) {
          const res = dispatch(s.sql, s.args);
          batchSqls.push({ sql: s.sql, args: s.args });
          results.push({ meta: { changes: res.changes }, results: res.rows });
        }
        batches.push(batchSqls);
        return results;
      },
    },
  };

  return { env, batches, insertedIds, updatedIds, updatedVerses, insertAttempts, insertArgs, acceptedPendingIds, liveRows, setProposals };
}

await withMockedClock(async () => {
  const { env, batches, insertedIds, updatedIds, setProposals } = buildFakeTqDb({
    tombstonedIds: new Set(["hoig"]),
  });

  const tqProposals = () => [
    {
      id: 1,
      kind: "tq",
      book: "GEN",
      chapter: 1,
      verse: 1,
      bible_version: null,
      payload_json: JSON.stringify({ id: "hoig", book: "GEN", chapter: 1, verse: 1, question: "q-tombstone" }),
    },
    {
      id: 2,
      kind: "tq",
      book: "GEN",
      chapter: 1,
      verse: 2,
      bible_version: null,
      payload_json: JSON.stringify({ id: "abc1", book: "GEN", chapter: 1, verse: 2, question: "q-clean" }),
    },
    {
      id: 3,
      kind: "tq",
      book: "GEN",
      chapter: 1,
      verse: 3,
      bible_version: null,
      payload_json: JSON.stringify({ id: "9BAD", book: "GEN", chapter: 1, verse: 3, question: "q-malformed" }),
    },
  ];

  const originalConsoleError = console.error;
  console.error = () => {};
  let result;
  try {
    setProposals(tqProposals());
    result = await importJobOutput(
      env,
      { jobId: "job-tq-chain", pipelineType: "tqs", book: "GEN", startChapter: 1, endChapter: 1 },
      [],
    );
  } finally {
    console.error = originalConsoleError;
  }

  assert(
    result.claimLost !== true && result.applied?.tqCreated === 3,
    `TQ candidate chain: the job completes with all 3 rows created instead of throwing on the tombstoned PK slot (claimLost=${result.claimLost}, tqCreated=${result.applied?.tqCreated})`,
  );
  assert(insertedIds.length === 3, `TQ candidate chain: all 3 proposals reached an INSERT (got ${insertedIds.length})`);
  assert(
    insertedIds[0] === deriveAltRowId("hoig", 1),
    `TQ candidate chain: the proposal colliding with tombstoned "hoig" lands on the exact deterministic next candidate deriveAltRowId("hoig", 1) (${deriveAltRowId("hoig", 1)}), not just "some other id" (got "${insertedIds[0]}")`,
  );
  assert(
    insertedIds[1] === "abc1",
    `TQ candidate chain: a clean, free proposed id ("abc1") is preserved verbatim, not over-corrected into always minting (got "${insertedIds[1]}")`,
  );
  assert(
    insertedIds[2] === coerceRowId("9BAD"),
    `TQ candidate chain: a malformed proposed id ("9BAD") is inserted as its coerced form coerceRowId("9BAD") (${coerceRowId("9BAD")}), never as "9BAD" itself (got "${insertedIds[2]}")`,
  );
  assert(insertedIds[2] !== "9BAD", `TQ candidate chain: the malformed id "9BAD" itself is never inserted (got "${insertedIds[2]}")`);

  const tombstoneInsertBatch = batches.find(
    (b) => b.some((s) => /INSERT INTO tq_rows/.test(s.sql) && s.args[0] === insertedIds[0]),
  );
  const tombstoneEditLog = tombstoneInsertBatch?.find((s) => /INSERT INTO edit_log/.test(s.sql));
  assert(
    tombstoneEditLog?.args[0] === insertedIds[0],
    `TQ candidate chain: the edit_log row for the tombstone case carries the id that was ACTUALLY inserted (${insertedIds[0]}), not the proposed "hoig" (got "${tombstoneEditLog?.args[0]}")`,
  );

  // ── RE-RUN IDEMPOTENCY (the key property this redesign exists for) ──
  // A second job re-proposes the exact same three notes for the same chapter,
  // against the SAME env (so the live-rows map created by run 1 persists).
  // Because the candidate chain is deterministic, every proposal must walk the
  // identical chain, land on the row run 1 created, and UPDATE it — never
  // insert a second copy.
  setProposals(tqProposals());
  console.error = () => {};
  let rerunResult;
  try {
    rerunResult = await importJobOutput(
      env,
      { jobId: "job-tq-chain", pipelineType: "tqs", book: "GEN", startChapter: 1, endChapter: 1 },
      [],
    );
  } finally {
    console.error = originalConsoleError;
  }

  assert(
    rerunResult.claimLost !== true,
    `TQ re-run idempotency: the second run completes without losing the claim (claimLost=${rerunResult.claimLost})`,
  );
  assert(
    insertedIds.length === 3,
    `TQ re-run idempotency: a re-run for the same chapter must UPDATE the rows the first run created, never insert duplicate copies — insertedIds stayed at 3 (got ${insertedIds.length})`,
  );
  assert(
    updatedIds.length === 3 &&
      updatedIds.includes(insertedIds[0]) &&
      updatedIds.includes(insertedIds[1]) &&
      updatedIds.includes(insertedIds[2]),
    `TQ re-run idempotency: all 3 of run 1's inserted ids (${insertedIds.join(",")}) took the UPDATE branch on re-run (got updatedIds=${updatedIds.join(",")})`,
  );
});

// ── Cross-chapter live id is not trampled: a live row at the candidate id in
//    a DIFFERENT chapter must be stepped past, never overwritten ──
await withMockedClock(async () => {
  const { env, insertedIds, updatedIds, setProposals } = buildFakeTqDb({
    liveRows: new Map([["xyz1", { version: 1, chapter: 1 }]]),
  });

  setProposals([
    {
      id: 1,
      kind: "tq",
      book: "GEN",
      chapter: 2,
      verse: 1,
      bible_version: null,
      payload_json: JSON.stringify({ id: "xyz1", book: "GEN", chapter: 2, verse: 1, question: "q-cross-chapter" }),
    },
  ]);

  const originalConsoleError = console.error;
  console.error = () => {};
  let result;
  try {
    result = await importJobOutput(
      env,
      { jobId: "job-tq-cross-chapter", pipelineType: "tqs", book: "GEN", startChapter: 2, endChapter: 2 },
      [],
    );
  } finally {
    console.error = originalConsoleError;
  }

  assert(result.claimLost !== true, `TQ cross-chapter guard: the job completes (claimLost=${result.claimLost})`);
  assert(
    !updatedIds.includes("xyz1"),
    `TQ cross-chapter guard: the chapter-1 live row at "xyz1" is left alone, not trampled by a chapter-2 proposal (updatedIds=${updatedIds.join(",")})`,
  );
  assert(
    insertedIds.includes(deriveAltRowId("xyz1", 1)),
    `TQ cross-chapter guard: the chapter-2 proposal steps to the next deterministic candidate deriveAltRowId("xyz1", 1) (${deriveAltRowId("xyz1", 1)}) instead of overwriting the chapter-1 row (insertedIds=${insertedIds.join(",")})`,
  );
});

// ── Non-UNIQUE insert errors are not retried down the chain — they rethrow
//    immediately, so the caller sees the real failure instead of a job that
//    silently exhausts all 8 candidates and reports a misleading "collision
//    exhausted" error ──
await withMockedClock(async () => {
  const { env, insertAttempts, setProposals } = buildFakeTqDb({
    hardErrorIds: new Set(["errd"]),
  });

  setProposals([
    {
      id: 1,
      kind: "tq",
      book: "GEN",
      chapter: 1,
      verse: 1,
      bible_version: null,
      payload_json: JSON.stringify({ id: "errd", book: "GEN", chapter: 1, verse: 1, question: "q-hard-error" }),
    },
  ]);

  const originalConsoleError = console.error;
  console.error = () => {};
  let threw = null;
  try {
    await importJobOutput(
      env,
      { jobId: "job-tq-hard-error", pipelineType: "tqs", book: "GEN", startChapter: 1, endChapter: 1 },
      [],
    );
  } catch (e) {
    threw = e;
  } finally {
    console.error = originalConsoleError;
  }

  assert(
    threw != null && /NOT NULL/.test(threw.message),
    `TQ non-UNIQUE error: importJobOutput rejects with the underlying NOT NULL failure instead of swallowing it (got ${threw?.message ?? "no throw"})`,
  );
  assert(
    insertAttempts.length === 1,
    `TQ non-UNIQUE error: the chain stops after the first insert attempt instead of retrying all 8 candidates (got ${insertAttempts.length} attempts: ${insertAttempts.join(",")})`,
  );
});

// ── Same-chapter alt-id merge cannot happen silently: two proposals in the
//    SAME chapter whose seed ids are BOTH tombstoned must land on two
//    DIFFERENT alternate ids and both reach INSERT — this is exactly the
//    scenario the deriveAltRowId entropy fix protects (a collapsed output
//    pool could make two colliding proposals derive the same alternate id,
//    at which point the second silently UPDATEs over the first) ──
await withMockedClock(async () => {
  const { env, insertedIds, updatedIds, setProposals } = buildFakeTqDb({
    tombstonedIds: new Set(["hoig", "zorp"]),
  });

  setProposals([
    {
      id: 1,
      kind: "tq",
      book: "GEN",
      chapter: 1,
      verse: 1,
      bible_version: null,
      payload_json: JSON.stringify({ id: "hoig", book: "GEN", chapter: 1, verse: 1, question: "q-tombstone-1" }),
    },
    {
      id: 2,
      kind: "tq",
      book: "GEN",
      chapter: 1,
      verse: 2,
      bible_version: null,
      payload_json: JSON.stringify({ id: "zorp", book: "GEN", chapter: 1, verse: 2, question: "q-tombstone-2" }),
    },
  ]);

  const originalConsoleError = console.error;
  console.error = () => {};
  let result;
  try {
    result = await importJobOutput(
      env,
      { jobId: "job-tq-same-chapter-collision", pipelineType: "tqs", book: "GEN", startChapter: 1, endChapter: 1 },
      [],
    );
  } finally {
    console.error = originalConsoleError;
  }

  assert(result.claimLost !== true, `TQ same-chapter alt-id merge guard: the job completes (claimLost=${result.claimLost})`);
  assert(
    insertedIds.length === 2 && updatedIds.length === 0,
    `TQ same-chapter alt-id merge guard: two proposals with distinct tombstoned seeds in the same chapter both ` +
      `reach INSERT and none silently merge into an UPDATE (insertedIds=${insertedIds.join(",")}, updatedIds=${updatedIds.join(",")})`,
  );
  assert(
    insertedIds[0] !== insertedIds[1],
    `TQ same-chapter alt-id merge guard: the two proposals land on DIFFERENT alternate ids ` +
      `(deriveAltRowId("hoig",1)=${deriveAltRowId("hoig", 1)}, deriveAltRowId("zorp",1)=${deriveAltRowId("zorp", 1)}) ` +
      `— a collapsed id pool would let them collide and the second would silently overwrite the first (got ${insertedIds.join(",")})`,
  );
});

// ── The UPDATE branch writes `verse`: a question moved to another verse of
//    the same chapter must not stay filed under its old verse ──
await withMockedClock(async () => {
  const { env, updatedVerses, setProposals } = buildFakeTqDb({
    liveRows: new Map([["abc1", { version: 1, chapter: 1 }]]),
  });

  setProposals([
    {
      id: 1,
      kind: "tq",
      book: "GEN",
      chapter: 1,
      verse: 5,
      bible_version: null,
      payload_json: JSON.stringify({ id: "abc1", book: "GEN", chapter: 1, verse: 5, question: "q-moved-verse" }),
    },
  ]);

  const originalConsoleError = console.error;
  console.error = () => {};
  let result;
  try {
    result = await importJobOutput(
      env,
      { jobId: "job-tq-verse-move", pipelineType: "tqs", book: "GEN", startChapter: 1, endChapter: 1 },
      [],
    );
  } finally {
    console.error = originalConsoleError;
  }

  assert(result.claimLost !== true, `TQ verse-move: the job completes (claimLost=${result.claimLost})`);
  assert(
    updatedVerses.length === 1 && updatedVerses[0] === 5,
    `TQ verse-move: a live row at verse 1 updated by a proposal for verse 5 must have its UPDATE bind verse=5, ` +
      `not stay filed under its old verse (got updatedVerses=${updatedVerses.join(",")})`,
  );
});

// ── TQ CAS conflict: a concurrent write landing between applyTqUpsert's SELECT
//    and its UPDATE must NOT be silently overwritten. The guarded UPDATE
//    (`AND version = ?13`) matches nothing, so the row is skipped, counted in
//    tqSkippedConflict, left NOT accepted in pending_imports, and NOT audited —
//    the app's own 409 re-queue behaviour, not a clobber. (Ports upstream #776,
//    adapted to this fork's changes()/EXISTS-fingerprint gate — the fork has no
//    last_change_source column.) ──
await withMockedClock(async () => {
  const { env, updatedIds, acceptedPendingIds, batches, setProposals } = buildFakeTqDb({
    liveRows: new Map([["abc1", { version: 7, chapter: 1, verse: 1 }]]),
    racedIds: new Set(["abc1"]),
  });

  setProposals([
    {
      id: 42,
      kind: "tq",
      book: "GEN",
      chapter: 1,
      verse: 1,
      bible_version: null,
      payload_json: JSON.stringify({ id: "abc1", book: "GEN", chapter: 1, verse: 1, question: "q-would-clobber" }),
    },
  ]);

  const originalConsoleWarn = console.warn;
  const originalConsoleError = console.error;
  console.warn = () => {};
  console.error = () => {};
  let result;
  try {
    result = await importJobOutput(
      env,
      { jobId: "job-tq-cas-conflict", pipelineType: "tqs", book: "GEN", startChapter: 1, endChapter: 1 },
      [],
    );
  } finally {
    console.warn = originalConsoleWarn;
    console.error = originalConsoleError;
  }

  assert(result.claimLost !== true, `TQ CAS conflict: the job still completes (claimLost=${result.claimLost})`);
  assert(
    result.applied?.tqSkippedConflict === 1 && result.applied?.tqUpdated === 0,
    `TQ CAS conflict: the raced row is counted as a skipped conflict, not an update ` +
      `(got tqSkippedConflict=${result.applied?.tqSkippedConflict}, tqUpdated=${result.applied?.tqUpdated})`,
  );
  assert(
    updatedIds.length === 0,
    `TQ CAS conflict: no UPDATE is treated as landed (got updatedIds=${updatedIds.join(",")})`,
  );
  assert(
    !acceptedPendingIds.includes(42),
    `TQ CAS conflict: the proposal is left UNACCEPTED in pending_imports so it stays visible for review, ` +
      `not marked accepted over a clobbered write (acceptedPendingIds=${acceptedPendingIds.join(",")})`,
  );
  // The guard SQL must actually be present — a regression guard against it being
  // simplified back to an unconditional UPDATE / accept.
  const tqUpdateBatch = batches.find((b) => b.some((s) => /UPDATE tq_rows\s+SET/.test(s.sql)));
  const tqUpdateStmt = tqUpdateBatch?.find((s) => /UPDATE tq_rows\s+SET/.test(s.sql));
  const tqAcceptStmt = tqUpdateBatch?.find((s) => /SET accepted_at = unixepoch\(\)/.test(s.sql));
  const tqAuditStmt = tqUpdateBatch?.find((s) => /INSERT INTO edit_log/.test(s.sql));
  assert(
    tqUpdateStmt != null && /AND version = \?13/.test(tqUpdateStmt.sql),
    `TQ CAS conflict: the tq_rows UPDATE carries the version CAS ("AND version = ?13")`,
  );
  assert(
    tqAcceptStmt != null && /changes\(\) > 0/.test(tqAcceptStmt.sql),
    `TQ CAS conflict: the accept self-gates on "changes() > 0"`,
  );
  assert(
    tqAuditStmt != null && /WHERE EXISTS/.test(tqAuditStmt.sql) && /FROM tq_rows/.test(tqAuditStmt.sql),
    `TQ CAS conflict: the audit INSERT self-gates on a "WHERE EXISTS (... FROM tq_rows ...)" fingerprint`,
  );
});

// ── insertTqAtId binds the pending_imports book/chapter/verse, not the
//    payload's — a stray TSV cell in the payload must not divert the row
//    into a different (book, id) space than the one the caller checked ──
await withMockedClock(async () => {
  const { env, insertArgs, setProposals } = buildFakeTqDb();

  setProposals([
    {
      id: 1,
      kind: "tq",
      book: "GEN",
      chapter: 1,
      verse: 1,
      bible_version: null,
      payload_json: JSON.stringify({
        id: "abc1",
        book: "EXO",
        chapter: 9,
        verse: 9,
        question: "q-payload-mismatch",
      }),
    },
  ]);

  const originalConsoleError = console.error;
  console.error = () => {};
  let result;
  try {
    result = await importJobOutput(
      env,
      { jobId: "job-tq-payload-mismatch", pipelineType: "tqs", book: "GEN", startChapter: 1, endChapter: 1 },
      [],
    );
  } finally {
    console.error = originalConsoleError;
  }

  assert(result.claimLost !== true, `TQ payload book/chapter/verse guard: the job completes (claimLost=${result.claimLost})`);
  assert(insertArgs.length === 1, `TQ payload book/chapter/verse guard: exactly one INSERT was attempted (got ${insertArgs.length})`);
  // cols = ["id", "book", "chapter", "verse", ...] so args[1]=book, args[2]=chapter, args[3]=verse.
  const [, insertedBook, insertedChapter, insertedVerse] = insertArgs[0];
  assert(
    insertedBook === "GEN" && insertedChapter === 1 && insertedVerse === 1,
    `TQ payload book/chapter/verse guard: the INSERT binds the pending_imports row's book/chapter/verse ` +
      `(GEN/1/1), not the payload's mismatched EXO/9/9 (got ${insertedBook}/${insertedChapter}/${insertedVerse})`,
  );
});

// ── A randomly minted candidate must never adopt a live row: a tq proposal
//    with NO id at all (payload_json has no "id", so seedId is null and
//    every candidate id is a fresh newRowId()) must never overwrite a live
//    row it happens to land on — a random candidate asserts no identity, so a
//    live row there belongs to some OTHER question, and updating it would
//    silently destroy it while marking this unrelated proposal "accepted".
//    This is a SILENT DATA LOSS scenario. ──
await withMockedClock(async () => {
  // Math.random is stubbed so newRowId()'s first draw is deterministic
  // ("aaaa": newRowId makes 4 calls per id — 1 for ID_LETTERS[floor(r*24)]
  // then 3 for ID_CHARS[floor(r*32)] — all four Math.random()=0 draws map to
  // index 0, i.e. 'a' each time) and its second draw is a different,
  // also-deterministic id ("nsss": four Math.random()=0.5 draws). Verified
  // directly against rowId.ts's newRowId before writing this test.
  const firstDrawnId = "aaaa";
  const secondDrawnId = "nsss";

  const { env, insertedIds, updatedIds, setProposals } = buildFakeTqDb({
    liveRows: new Map([[firstDrawnId, { version: 1, chapter: 1, verse: 9 }]]),
  });

  setProposals([
    {
      id: 1,
      kind: "tq",
      book: "GEN",
      chapter: 1,
      verse: 1,
      bible_version: null,
      // No "id" field at all -> seedId is null -> every candidate is a random newRowId().
      payload_json: JSON.stringify({ book: "GEN", chapter: 1, verse: 1, question: "q-random-mint" }),
    },
  ]);

  let callCount = 0;
  const originalRandom = Math.random;
  Math.random = () => {
    callCount++;
    return callCount <= 4 ? 0 : 0.5;
  };
  const originalConsoleError = console.error;
  console.error = () => {};
  let result;
  try {
    result = await importJobOutput(
      env,
      { jobId: "job-tq-random-mint", pipelineType: "tqs", book: "GEN", startChapter: 1, endChapter: 1 },
      [],
    );
  } finally {
    Math.random = originalRandom;
    console.error = originalConsoleError;
  }

  assert(result.claimLost !== true, `TQ random-mint guard: the job completes (claimLost=${result.claimLost})`);
  assert(
    updatedIds.length === 0,
    `TQ random-mint guard (SILENT DATA LOSS if this fails): a proposal with no seed id must never adopt (UPDATE) ` +
      `a live row it randomly lands on — the live row at "${firstDrawnId}" belongs to some other question, and ` +
      `updating it would silently overwrite that question while marking this unrelated proposal accepted ` +
      `(got updatedIds=${updatedIds.join(",")})`,
  );
  assert(
    insertedIds.length === 1 && insertedIds[0] === secondDrawnId,
    `TQ random-mint guard: the proposal steps past the live "${firstDrawnId}" and INSERTs at the next random draw ` +
      `"${secondDrawnId}" instead (got insertedIds=${insertedIds.join(",")})`,
  );
});

// ── A derived candidate must not adopt a live row at a DIFFERENT verse: two
//    seeds — "aa8a" and "abr4" — were found by brute force (iterating every
//    valid 4-char id and comparing deriveAltRowId(id, 1)) to hash to the SAME
//    alternate id. This is a genuine ~1-in-786k-per-pair coincidence, not a
//    contrived input, but the consequence (one proposal's INSERT silently
//    turning into an UPDATE that overwrites an unrelated live question) is
//    SILENT DATA LOSS, so it is worth hardcoding as a regression test. Both
//    seeds are tombstoned so both proposals step to attempt 1 and land on the
//    shared derived id; the two proposals are filed at DIFFERENT verses (1
//    and 2) of the same chapter, so the second must not treat the first's
//    freshly-inserted row as its own. ──
await withMockedClock(async () => {
  const s1 = "aa8a";
  const s2 = "abr4";
  const sharedAlt = deriveAltRowId(s1, 1);
  assert(
    sharedAlt === deriveAltRowId(s2, 1),
    `TQ derived-candidate verse guard: test setup sanity check — deriveAltRowId("${s1}",1) and ` +
      `deriveAltRowId("${s2}",1) must actually collide (got ${sharedAlt} vs ${deriveAltRowId(s2, 1)})`,
  );

  const { env, insertedIds, updatedIds, setProposals } = buildFakeTqDb({
    tombstonedIds: new Set([s1, s2]),
  });

  setProposals([
    {
      id: 1,
      kind: "tq",
      book: "GEN",
      chapter: 1,
      verse: 1,
      bible_version: null,
      payload_json: JSON.stringify({ id: s1, book: "GEN", chapter: 1, verse: 1, question: "q-derived-1" }),
    },
    {
      id: 2,
      kind: "tq",
      book: "GEN",
      chapter: 1,
      verse: 2,
      bible_version: null,
      payload_json: JSON.stringify({ id: s2, book: "GEN", chapter: 1, verse: 2, question: "q-derived-2" }),
    },
  ]);

  const originalConsoleError = console.error;
  console.error = () => {};
  let result;
  try {
    result = await importJobOutput(
      env,
      { jobId: "job-tq-derived-verse-mismatch", pipelineType: "tqs", book: "GEN", startChapter: 1, endChapter: 1 },
      [],
    );
  } finally {
    console.error = originalConsoleError;
  }

  assert(result.claimLost !== true, `TQ derived-candidate verse guard: the job completes (claimLost=${result.claimLost})`);
  assert(
    !updatedIds.includes(sharedAlt),
    `TQ derived-candidate verse guard (SILENT DATA LOSS if this fails): two seeds hashing to the same alternate ` +
      `id ("${sharedAlt}") at DIFFERENT verses (1 vs 2) must not let the second proposal silently UPDATE over ` +
      `(overwrite) the first proposal's question (got updatedIds=${updatedIds.join(",")})`,
  );
  assert(
    insertedIds.length === 2 && new Set(insertedIds).size === 2,
    `TQ derived-candidate verse guard: both proposals reach INSERT at two DISTINCT ids instead of the second ` +
      `merging into an UPDATE of the first (got insertedIds=${insertedIds.join(",")})`,
  );
});

// ── Companion: the intended-adoption case still works — a derived candidate
//    whose live row is the SAME chapter AND SAME verse IS adopted (UPDATE,
//    not a duplicate insert). This is the re-run idempotency path for a
//    tombstoned seed and must not regress from the two guards above. ──
await withMockedClock(async () => {
  const seed = "hoig"; // tombstoned, so attempt 1 is the first live candidate checked
  const derivedId = deriveAltRowId(seed, 1);

  const { env, insertedIds, updatedIds, setProposals } = buildFakeTqDb({
    tombstonedIds: new Set([seed]),
    liveRows: new Map([[derivedId, { version: 1, chapter: 1, verse: 3 }]]),
  });

  setProposals([
    {
      id: 1,
      kind: "tq",
      book: "GEN",
      chapter: 1,
      verse: 3,
      bible_version: null,
      payload_json: JSON.stringify({ id: seed, book: "GEN", chapter: 1, verse: 3, question: "q-rerun-derived" }),
    },
  ]);

  const originalConsoleError = console.error;
  console.error = () => {};
  let result;
  try {
    result = await importJobOutput(
      env,
      { jobId: "job-tq-derived-samechapter-verse", pipelineType: "tqs", book: "GEN", startChapter: 1, endChapter: 1 },
      [],
    );
  } finally {
    console.error = originalConsoleError;
  }

  assert(result.claimLost !== true, `TQ derived-candidate adoption: the job completes (claimLost=${result.claimLost})`);
  assert(
    updatedIds.length === 1 && updatedIds[0] === derivedId,
    `TQ derived-candidate adoption: a derived candidate whose live row is the SAME chapter AND verse IS adopted ` +
      `(UPDATE), not duplicated as a new insert — this is the re-run idempotency path and must not regress ` +
      `(got updatedIds=${updatedIds.join(",")}, insertedIds=${insertedIds.join(",")})`,
  );
  assert(
    insertedIds.length === 0,
    `TQ derived-candidate adoption: no new INSERT happens when the derived candidate's live row is legitimately ` +
      `ours (got insertedIds=${insertedIds.join(",")})`,
  );
});

// ── SAME-verse twin of the guard above: the chapter+verse check alone cannot
//    separate two proposals that land in the SAME verse — which is normal,
//    since a verse routinely has several questions. Seeds "aa8a" and "abr4"
//    both hash (deriveAltRowId(seed, 1)) to the same alternate id "fdvf"; both
//    are tombstoned so both proposals step to attempt 1 and reach that id.
//    Proposal A inserts at "fdvf" first. Without claimedIds, proposal B would
//    then find "fdvf" live at the SAME chapter AND SAME verse as itself,
//    read that as "my row from a previous run", and UPDATE over it —
//    destroying A's question while marking B accepted. claimedIds (populated
//    on every UPDATE/INSERT success within this pass) is what tells B that
//    "fdvf" was just claimed by A this run, so B steps to attempt 2 instead. ──
await withMockedClock(async () => {
  const s1 = "aa8a";
  const s2 = "abr4";
  const sharedAlt = deriveAltRowId(s1, 1);
  assert(
    sharedAlt === deriveAltRowId(s2, 1),
    `TQ same-verse claim guard: test setup sanity check — deriveAltRowId("${s1}",1) and ` +
      `deriveAltRowId("${s2}",1) must actually collide (got ${sharedAlt} vs ${deriveAltRowId(s2, 1)})`,
  );

  const { env, insertedIds, updatedIds, setProposals } = buildFakeTqDb({
    tombstonedIds: new Set([s1, s2]),
  });

  setProposals([
    {
      id: 1,
      kind: "tq",
      book: "GEN",
      chapter: 1,
      verse: 1,
      bible_version: null,
      payload_json: JSON.stringify({ id: s1, book: "GEN", chapter: 1, verse: 1, question: "q-same-verse-1" }),
    },
    {
      id: 2,
      kind: "tq",
      book: "GEN",
      chapter: 1,
      verse: 1,
      bible_version: null,
      payload_json: JSON.stringify({ id: s2, book: "GEN", chapter: 1, verse: 1, question: "q-same-verse-2" }),
    },
  ]);

  const originalConsoleError = console.error;
  console.error = () => {};
  let result;
  try {
    result = await importJobOutput(
      env,
      { jobId: "job-tq-same-verse-claim", pipelineType: "tqs", book: "GEN", startChapter: 1, endChapter: 1 },
      [],
    );
  } finally {
    console.error = originalConsoleError;
  }

  assert(result.claimLost !== true, `TQ same-verse claim guard: the job completes (claimLost=${result.claimLost})`);
  assert(
    insertedIds.length === 2 && new Set(insertedIds).size === 2,
    `TQ same-verse claim guard (SILENT DATA LOSS if this fails): two questions in the same verse whose ids hash ` +
      `to the same alternate id must not collapse into one row — both proposals must reach INSERT at two ` +
      `DISTINCT ids (got insertedIds=${insertedIds.join(",")})`,
  );
  assert(
    insertedIds[0] === sharedAlt,
    `TQ same-verse claim guard: the first proposal lands on the shared derived id ("${sharedAlt}") ` +
      `(got insertedIds[0]="${insertedIds[0]}")`,
  );
  assert(
    insertedIds[1] !== sharedAlt,
    `TQ same-verse claim guard (SILENT DATA LOSS if this fails): the second proposal must step past the ` +
      `just-claimed id ("${sharedAlt}") to a further candidate instead of colliding with it ` +
      `(got insertedIds=${insertedIds.join(",")})`,
  );
  assert(
    !updatedIds.includes(sharedAlt),
    `TQ same-verse claim guard (SILENT DATA LOSS if this fails): the second proposal must not UPDATE over the ` +
      `first proposal's freshly-inserted row at "${sharedAlt}" (got updatedIds=${updatedIds.join(",")})`,
  );
  assert(
    result.applied?.tqCreated === 2,
    `TQ same-verse claim guard: both questions survive as separate created rows (got tqCreated=${result.applied?.tqCreated})`,
  );
});

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
