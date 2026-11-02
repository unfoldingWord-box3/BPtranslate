// Tests for the pure Setup-wizard helpers (web/src/lib/setupWizard.ts): step
// gating after Apply, import-error → replacement-step routing, the source-URL
// verify state machine's error classification, and the lane upstream-choice
// mapping.
//
// Run from web/:
//   node --experimental-strip-types --no-warnings --test src/lib/setupWizard.test.mjs

import assert from "node:assert/strict";
import test from "node:test";
import {
  verifyErrorKind,
  laneChoiceFromMode,
  toggleResourceChecked,
  door43RepoUrl,
  laneUrlChoiceSelection,
  clearedOverrideSelection,
  pendingOverrideSelection,
  isUnverifiedOverride,
  unverifiedOverrideResources,
  hasUnverifiedOverride,
  defaultReplaceSelection,
  upstreamLanguageOf,
  jobActionable,
  describeBookError,
  shouldPrefillFromCurrent,
  overrideFieldInitialUrl,
  shouldClearOverrideOnBlur,
  wizardApply409,
  shouldCheckBooks,
  resolveVerifiedSource,
  laneSourceEstablished,
  laneActiveSourceRepo,
  laneSourceReconcilable,
} from "./setupWizard.ts";
import { defaultResourceSources } from "./orgDraft.ts";

test("verifyErrorKind never turns a transient 503 into 'not_found'", () => {
  assert.equal(verifyErrorKind(400), "invalid");
  assert.equal(verifyErrorKind(404), "not_found");
  assert.equal(verifyErrorKind(503), "unreachable");
  assert.equal(verifyErrorKind(500), "unreachable");
  assert.equal(verifyErrorKind(undefined), "unreachable");
});

test("laneChoiceFromMode maps resourceSource mode to the lane control value", () => {
  assert.equal(laneChoiceFromMode("upstream"), "unfoldingWord");
  assert.equal(laneChoiceFromMode("override"), "url");
  assert.equal(laneChoiceFromMode("blank"), "none");
});

test("toggleResourceChecked: checked pulls upstream, unchecked defaults to blank", () => {
  assert.deepEqual(toggleResourceChecked(true), { mode: "upstream" });
  assert.deepEqual(toggleResourceChecked(false), { mode: "blank" });
});

test("door43RepoUrl builds the canonical repo web URL", () => {
  assert.equal(door43RepoUrl("BibleAquifer", "ar_tn"), "https://git.door43.org/BibleAquifer/ar_tn");
});

test("shouldPrefillFromCurrent: only a same-org match (a re-run) prefills; a fresh org does not", () => {
  // Fresh org: live config is the default preset (different org) → inference wins.
  assert.equal(shouldPrefillFromCurrent("unfoldingWord", "BibleEditorMLTest"), false);
  // Re-run: the DB is already configured for THIS org → prefill from current.
  assert.equal(shouldPrefillFromCurrent("BibleEditorMLTest", "BibleEditorMLTest"), true);
  // Missing either side → never prefill.
  assert.equal(shouldPrefillFromCurrent("", "X"), false);
  assert.equal(shouldPrefillFromCurrent("X", ""), false);
  assert.equal(shouldPrefillFromCurrent(null, undefined), false);
});

test("overrideFieldInitialUrl: a verified override mounts showing its Door43 URL, not empty", () => {
  // Same-org override → default org, so the URL uses the default upstream org.
  assert.equal(
    overrideFieldInitialUrl({ mode: "override", repo: "ar_tn" }, "unfoldingWord"),
    "https://git.door43.org/unfoldingWord/ar_tn",
  );
  // Different-org override → its own org.
  assert.equal(
    overrideFieldInitialUrl({ mode: "override", org: "BibleAquifer", repo: "ar_tn" }, "unfoldingWord"),
    "https://git.door43.org/BibleAquifer/ar_tn",
  );
  // Pending (repo-less) override, blank, or upstream → empty (nothing to show).
  assert.equal(overrideFieldInitialUrl({ mode: "override" }, "unfoldingWord"), "");
  assert.equal(overrideFieldInitialUrl({ mode: "blank" }, "unfoldingWord"), "");
  assert.equal(overrideFieldInitialUrl(undefined, "unfoldingWord"), "");
});

test("shouldClearOverrideOnBlur: only a touched+emptied field clears; a mounted-empty display does not", () => {
  // The defect: a fresh remount whose display field is empty but the override
  // still exists must NOT be blanked on focus+blur.
  assert.equal(shouldClearOverrideOnBlur(false, ""), false); // untouched empty → keep
  assert.equal(shouldClearOverrideOnBlur(true, ""), true); // user emptied it → clear
  assert.equal(shouldClearOverrideOnBlur(true, "  "), true); // whitespace-only → clear
  assert.equal(shouldClearOverrideOnBlur(true, "https://x"), false); // has a value → verify, not clear
  assert.equal(shouldClearOverrideOnBlur(false, "https://x"), false);
});

test("wizardApply409: maps the code (and re-run flag) to the right message + revert affordance", () => {
  assert.deepEqual(wizardApply409("lane_source_change_requires_migration", false), {
    messageKey: "setup.laneSourceMigration",
    revert: "lanes",
  });
  // Same-org re-run identity change → revert-all, NOT the recreate-DB guidance.
  assert.deepEqual(wizardApply409("project_not_empty", true), {
    messageKey: "setup.identityChangedRevert",
    revert: "allRepos",
  });
  // Genuinely different org → the real tenancy stop.
  assert.deepEqual(wizardApply409("project_not_empty", false), {
    messageKey: "setup.projectNotEmpty",
    revert: "none",
  });
  // Anything else (e.g. lane_busy) → generic, no revert.
  assert.deepEqual(wizardApply409("lane_busy", true), { messageKey: "setup.laneBusy", revert: "none" });
});

test("shouldCheckBooks: only scripture (lit/sim) pull-sources are book-checked", () => {
  assert.equal(shouldCheckBooks("lit"), true);
  assert.equal(shouldCheckBooks("sim"), true);
  for (const r of ["tn", "tq", "twl", "tw", "ta"]) {
    assert.equal(shouldCheckBooks(r), false, `${r} is not USFM — no book check`);
  }
});

test("resolveVerifiedSource: a scripture source to a scaffolding-only repo is rejected (no_books)", () => {
  assert.deepEqual(resolveVerifiedSource("lit", false), { ok: false, errorKind: "no_books" });
  assert.deepEqual(resolveVerifiedSource("sim", false), { ok: false, errorKind: "no_books" });
});

test("resolveVerifiedSource: a scripture source WITH books passes", () => {
  assert.deepEqual(resolveVerifiedSource("lit", true), { ok: true });
});

test("resolveVerifiedSource: a transient (hasBooks omitted) does NOT block a scripture source", () => {
  // A DCS contents blip omits hasBooks — never a false 'empty'.
  assert.deepEqual(resolveVerifiedSource("lit", undefined), { ok: true });
});

test("resolveVerifiedSource: non-scripture overrides are unaffected by the book check", () => {
  // Even hasBooks:false (which we never request for these) must not reject them.
  assert.deepEqual(resolveVerifiedSource("tn", false), { ok: true });
  assert.deepEqual(resolveVerifiedSource("tw", undefined), { ok: true });
  assert.deepEqual(resolveVerifiedSource("ta", true), { ok: true });
});

test("laneSourceEstablished: a lane with verses or mid-migration is locked; a fresh lane isn't", () => {
  assert.equal(laneSourceEstablished({ populated: true }), true);
  assert.equal(laneSourceEstablished({ replacementRequired: true }), true);
  assert.equal(laneSourceEstablished({ populated: false, replacementRequired: false }), false);
  assert.equal(laneSourceEstablished(undefined), false);
});

test("laneActiveSourceRepo returns the active source repo (the 409 baseline)", () => {
  assert.equal(laneActiveSourceRepo({ config: { source: { owner: "X", repo: "en_glt" } } }), "en_glt");
  assert.equal(laneActiveSourceRepo({}), "");
  assert.equal(laneActiveSourceRepo(undefined), "");
});

test("laneSourceReconcilable: a fresh lane is fine; a normal populated same-org lane is fine", () => {
  // Fresh/empty → freely choosable.
  assert.equal(laneSourceReconcilable(undefined, "MyOrg"), true);
  assert.equal(laneSourceReconcilable({ populated: false }, "MyOrg"), true);
  // Normal populated lane whose active source owner is the org → reconcilable
  // (lock to active repo makes desired === active, no 409).
  assert.equal(
    laneSourceReconcilable({ populated: true, config: { source: { owner: "MyOrg", repo: "ar_glt" } } }, "MyOrg"),
    true,
  );
});

test("laneSourceReconcilable: owner matching is case-insensitive (DCS org names are)", () => {
  // The BSOJ block: the lane's active source owner was persisted as `bsoj`
  // before org names were canonicalized against DCS, while detect() now reports
  // `BSOJ`. Same org — Apply must NOT be blocked.
  assert.equal(
    laneSourceReconcilable({ populated: true, config: { source: { owner: "bsoj", repo: "ar_avd" } } }, "BSOJ"),
    true,
  );
  assert.equal(
    laneSourceReconcilable({ populated: true, config: { source: { owner: "BSOJ", repo: "ar_avd" } } }, " bsoj "),
    true,
  );
  // A genuinely foreign owner is still blocked, case-folding or not.
  assert.equal(
    laneSourceReconcilable({ populated: true, config: { source: { owner: "unfoldingword", repo: "en_ult" } } }, "BSOJ"),
    false,
  );
});

test("laneSourceReconcilable: mltest drift (foreign owner / mid-migration) is NOT reconcilable → block", () => {
  // The mltest quarantine: active source owner unfoldingWord, being configured as
  // BibleEditorMLTest — desired.owner can never equal unfoldingWord → block, not loop.
  assert.equal(
    laneSourceReconcilable(
      { populated: true, config: { source: { owner: "unfoldingWord", repo: "en_ult" } } },
      "BibleEditorMLTest",
    ),
    false,
  );
  // A lane mid-migration (replacement_required) is never reconcilable here.
  assert.equal(
    laneSourceReconcilable(
      { replacementRequired: true, config: { source: { owner: "MyOrg", repo: "ar_glt" } } },
      "MyOrg",
    ),
    false,
  );
});

test("laneUrlChoiceSelection makes the choice read as 'url' without committing a repo", () => {
  const sel = laneUrlChoiceSelection();
  assert.equal(laneChoiceFromMode(sel.mode), "url");
  assert.equal(sel.repo, undefined); // nothing committed until a URL verifies
});

test("clearedOverrideSelection resets to upstream when checked, blank when not", () => {
  assert.deepEqual(clearedOverrideSelection(true), { mode: "upstream" });
  assert.deepEqual(clearedOverrideSelection(false), { mode: "blank" });
});

test("a failed verify (incl. 503) does NOT blank the source — it stays a pending override", () => {
  // The load-bearing claim: verification failure must not silently persist as
  // "no source". pendingOverrideSelection is an override with no repo.
  const pending = pendingOverrideSelection();
  assert.equal(pending.mode, "override");
  assert.equal(pending.repo, undefined);
  assert.notDeepEqual(pending, { mode: "blank" }); // NOT blanked
  assert.equal(isUnverifiedOverride(pending), true);
});

test("isUnverifiedOverride: pending override yes; verified/blank/upstream no", () => {
  assert.equal(isUnverifiedOverride({ mode: "override" }), true);
  assert.equal(isUnverifiedOverride({ mode: "override", repo: "  " }), true);
  assert.equal(isUnverifiedOverride({ mode: "override", org: "X", repo: "ar_tn" }), false);
  assert.equal(isUnverifiedOverride({ mode: "blank" }), false);
  assert.equal(isUnverifiedOverride({ mode: "upstream" }), false);
  assert.equal(isUnverifiedOverride(undefined), false);
});

test("hasUnverifiedOverride / unverifiedOverrideResources gate on any pending override", () => {
  const clean = defaultResourceSources(); // all upstream
  assert.equal(hasUnverifiedOverride(clean), false);
  assert.deepEqual(unverifiedOverrideResources(clean), []);

  // A 503 during tn verify left tn a pending override.
  const withPending = { ...defaultResourceSources(), tn: pendingOverrideSelection() };
  assert.equal(hasUnverifiedOverride(withPending), true);
  assert.deepEqual(unverifiedOverrideResources(withPending), ["tn"]);

  // A genuine clear (blank) does NOT block.
  const cleared = { ...defaultResourceSources(), tn: clearedOverrideSelection(false) };
  assert.equal(hasUnverifiedOverride(cleared), false);
});

test("upstreamLanguageOf uses the inferred code, falling back to 'en'", () => {
  assert.equal(upstreamLanguageOf("ar"), "ar");
  assert.equal(upstreamLanguageOf("  es-419 "), "es-419");
  assert.equal(upstreamLanguageOf(""), "en");
  assert.equal(upstreamLanguageOf(null), "en");
  assert.equal(upstreamLanguageOf(undefined), "en");
});

test("jobActionable is true only when a book needs retry/waive", () => {
  assert.equal(jobActionable([{ status: "pending" }, { status: "artifact_ok" }]), false);
  assert.equal(jobActionable([{ status: "retryable_error" }]), true);
  assert.equal(jobActionable([{ status: "artifact_ok" }, { status: "failed" }]), true);
  assert.equal(jobActionable([]), false);
});

test("describeBookError maps sha_unavailable to a not-found location", () => {
  const src = { owner: "BibleAquifer", repo: "ar_avd", ref: "master" };
  assert.deepEqual(describeBookError(JSON.stringify({ error: "sha_unavailable" }), src), {
    kind: "not_found",
    location: "BibleAquifer/ar_avd@master",
  });
  // Bare (non-JSON) string form.
  assert.deepEqual(describeBookError("sha_unavailable", src), {
    kind: "not_found",
    location: "BibleAquifer/ar_avd@master",
  });
  // No ref → omit the @ref suffix.
  assert.deepEqual(describeBookError("sha_unavailable", { owner: "o", repo: "r" }), {
    kind: "not_found",
    location: "o/r",
  });
  // Other errors pass through as detail; empty → null.
  assert.deepEqual(describeBookError(JSON.stringify({ error: "boom" }), src), {
    kind: "other",
    detail: "boom",
  });
  assert.equal(describeBookError(null, src), null);
  assert.equal(describeBookError("", src), null);
});

// ── defaultReplaceSelection (issue #94 smart default) ────────────────────────

test("defaultReplaceSelection keeps books with work done, replaces the rest", () => {
  const books = ["GEN", "JOL", "MAL", "OBA"];
  const stats = {
    GEN: { verses: 50, edited: 0 },
    JOL: { verses: 73, edited: 12 }, // edited → keep (excluded)
    MAL: { verses: 55, edited: 0 },
    OBA: { verses: 21, edited: 1 }, // edited → keep (excluded)
  };
  // Only the unedited books default to replace.
  assert.deepEqual(defaultReplaceSelection(books, stats), ["GEN", "MAL"]);
});

test("defaultReplaceSelection: no stats → replace all (unchanged whole-lane default)", () => {
  const books = ["GEN", "JOL", "MAL"];
  assert.deepEqual(defaultReplaceSelection(books, undefined), books);
  assert.deepEqual(defaultReplaceSelection(books, {}), books);
});

test("defaultReplaceSelection: all books edited → replace none (all kept)", () => {
  const books = ["JOL", "OBA"];
  const stats = { JOL: { verses: 73, edited: 1 }, OBA: { verses: 21, edited: 21 } };
  assert.deepEqual(defaultReplaceSelection(books, stats), []);
});

test("defaultReplaceSelection: a book missing from stats defaults to replace", () => {
  // A book with no stats entry is treated as unedited (edited defaults to 0).
  const books = ["GEN", "JOL"];
  const stats = { JOL: { verses: 73, edited: 4 } };
  assert.deepEqual(defaultReplaceSelection(books, stats), ["GEN"]);
});

test("shouldPrefillFromCurrent: same org in different case still counts as a re-run", () => {
  // Config persisted `bsoj`, detect() reports `BSOJ` — a re-run, so the non-lane
  // repos must prefill from the current config. Reading it as a different org
  // proposed a fresh-inference repo set and tripped the identity guard on apply.
  assert.equal(shouldPrefillFromCurrent("bsoj", "BSOJ"), true);
  assert.equal(shouldPrefillFromCurrent(" BSOJ ", "bsoj"), true);
  assert.equal(shouldPrefillFromCurrent("unfoldingWord", "BSOJ"), false);
  assert.equal(shouldPrefillFromCurrent("", "BSOJ"), false);
  assert.equal(shouldPrefillFromCurrent("BSOJ", null), false);
});
