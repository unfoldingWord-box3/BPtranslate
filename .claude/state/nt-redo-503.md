# nt-redo-503 — flows Redo 503 on New Testament verse notes

Branch `fix/nt-redo-503` (worktree `.claude/worktrees/nt-redo-503`). Uncommitted, awaiting Benjamin's go for commit + push + PR.

- Root cause: bot `tn-quick` loads only UHB; any NT verse answers 503 `uhb_missing_for_verse` (unfoldingWord/bp-assistant#394).
- Fix here: NT verse-note Redo routes through the single-row translate pipeline (same as intro notes); Redo failure toast carries the error code. `isHebrewBook` moved to `web/src/lib/testament.ts` so the pure helper is unit-testable.
- Verified: `npm --workspace web run test` 243/243, typecheck clean, browser click on LUK 1:1 note hits `POST /api/pipelines/start`.
- Delete this file in the PR that merges the work.
