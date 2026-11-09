# CONTEXT-REPO-CONTRACT — `{org}/translation-context`

**Status:** CONFIRMED against bp-assistant reader · 2026-07-14 · owner: Benjamin
**Consumers:** the bp-assistant `translate` skill (reader) · Bible Editor's context-export job (writer)
**Referenced by:** `INTEGRATION.md` §0.1 (`contextRef` opt-in), `PIPELINE-SPEC.md` §2.2/§3/§4 (both in the parent strategy folder), [`preferences-panel-design.md`](preferences-panel-design.md) §1.

## Parser compatibility pin

Pinned HEAD SHAs of the bot-side contract PRs (update to merge commits when they land on `main`):

```yaml
parser_compat:
  bp_assistant: "f78cce88b2a3bca52e93ad44da9b36dabd367f55"   # unfoldingWord/bp-assistant#206 feat/context-repo-contract
  bp_assistant_skills: "6475d5cdc95c96025d0e04e713b9d2be75754439" # unfoldingWord/bp-assistant-skills#136
  format: 1
  empty_pack_error_prefix: 'context pack has no content files at "'
```

Shared fixtures: `api/test-fixtures/context-pack/{minimal,full,invalid}/`.
Validation gate (Node, not Worker): `node scripts/validate-context-pack.mjs --pack <dir>`.

This pins the file layout and schemas of the per-language context repo so both sides can build independently. It **supersedes PIPELINE-SPEC §3's sketch** where they differ — the deltas exist because the editor side is now *built* (migration `0040_translation_memory.sql`, `/api/translation-memory/*`, panel UI — branch `feat/translation-preferences-panel`) and the schemas below are what its export will actually render from D1.

---

## 1. Semantics (already live on both sides)

- `translate.contextRef` is **opt-in**. Omitted → the bot runs **raw baseline** (English source + its internal defaults). Present → the bot MUST load the repo and MUST fail the run if it has no content files (current live behavior — keep it; a silent fallback would mask a misconfigured repo). `[VERIFIED — INTEGRATION.md §0.1; api/src/translateOptions.ts:57-66]`
- `contextRef` format: `{org}/translation-context@{ref}` where `{ref}` is a branch name or commit SHA. The editor resolves the repo's HEAD at translate-start and pins the SHA for reproducible runs.
- One repo per GL org (e.g. `BSOJ/translation-context`). Git history is the audit trail; the repo is a **derived artifact** — Bible Editor's D1 is the operational source of truth and the export overwrites files wholesale (teams edit in the editor's Preferences & Memory panel, not the repo; hand-edits will be clobbered by the next export).

## 2. Repo layout

```
translation-context/
  manifest.yaml            # REQUIRED — language code, direction, format versions
  brief.md                 # translation brief (audience, purpose, register, script notes)
  instructions.md          # standing instructions, injected into every drafting prompt
  terminology/
    terms.csv              # terminology table (schema §3.3 — CHANGED from PIPELINE-SPEC §3)
  examples/
    validated.jsonl        # human-approved source→target pairs (schema §3.4)
  templates/
    templates.tsv          # per-SupportReference translated note templates (schema §3.5)
```

Dropped from the PIPELINE-SPEC §3 sketch, deliberately:
- **`standards.md`** — folded into `instructions.md` for v1 (the editor has one instructions field; a separate self-check standards file can be added later without breaking readers — see §5 versioning).
- **`rules/custom-rules.yaml`** — deferred past the pilot (PIPELINE-SPEC §4.3/§6). QA rules run editor-side; the bot doesn't need them.

A file may be absent (e.g. no templates yet). **At least one content file besides `manifest.yaml` must exist**, else the repo counts as unpopulated and the run fails per §1.

## 3. File schemas

### 3.1 `manifest.yaml` (REQUIRED)

```yaml
format: 1                  # bump on breaking layout/schema change (§5)
language: ar               # BCP-47 / DCS language code
direction: rtl             # ltr | rtl
exported_at: 2026-07-14T05:30:00Z
exported_by: bible-editor  # provenance marker: derived artifact, do not hand-edit
```

### 3.2 `brief.md` + `instructions.md`

Free markdown, UTF-8. The editor renders `brief.md` from its `translation_prefs` singleton:

```markdown
# Translation brief — العربية (ar)

**Audience:** Arabic-speaking church translation teams (ESL, high-school level)
**Purpose:** …
**Register:** formal          <!-- enum: default | formal | informal -->
**Script / direction notes:** …
```

`instructions.md` is the `instructions_md` field verbatim. **Bot consumption:** both are prompt-layer context, injected into every drafting call (PIPELINE-SPEC §2.2 items 2–3). `register` is the one machine-readable line — if the skill can honor a formality signal, parse it from the `**Register:**` line (values are a closed enum); otherwise treat the file as prose.

As of migration 0053, `instructions.md` is the concatenation of the editor's `instructions_md` field and, when present, its `common_issues_md` field under a `## Common issues` heading (recurring translation problems for this language — false friends, grammar traps, formatting habits). Still free markdown to the reader — no schema change, no `format` bump (§5, additive).

### 3.3 `terminology/terms.csv` — **CHANGED from PIPELINE-SPEC §3**

PIPELINE-SPEC sketched `source_term, target_term, status(approved|candidate), added_by, notes`. The as-built model is concept-oriented with a TBX-derived status vocabulary (research: [`translation-preferences-research.md`](translation-preferences-research.md) §2; design §5). The export writes exactly what `GET /api/translation-memory/terms/export` already emits today:

```csv
concept_id,source_term,target_term,status,replacement,comment,tw_link
kt/grace,grace,نعمة,preferred,,,
kt/lord,Lord,الرب,preferred,,,rc://ar/tw/dict/bible/kt/lord
kt/lord,Lord,السيد,forbidden,الرب,use the standard rendering,
names/yhwh,YHWH,,do_not_translate,,,
```

- UTF-8, header row required, RFC-4180 quoting (fields may contain commas), CRLF or LF.
- `concept_id` groups multiple renderings of one concept (one concept MAY have several `preferred`/`admitted` rows — sense-dependent renderings are legitimate; do not treat the table as one-term-one-string).
- `status` closed enum and required bot behavior:

| status | bot MUST |
|---|---|
| `preferred` | use this rendering for the source term (hard constraint; if several preferred renderings exist for a concept, any of them satisfies the constraint) |
| `admitted` | accept as valid; prefer a `preferred` sibling when drafting fresh |
| `deprecated` | not emit in new drafts |
| `forbidden` | never emit; `replacement` carries what to use instead (always populated for forbidden rows — editor-enforced) |
| `do_not_translate` | leave the source term untransliterated/untranslated (`target_term` empty) |

- `comment` is human rationale — ignore for matching. `tw_link` ties the concept to the language's translationWords article (context, not a constraint).
- **Candidate terms are NOT in this file.** Unlike the spec sketch's `approved|candidate`, unreviewed candidates stay in D1 until a human approves them; everything in `terms.csv` is team-approved and enforceable.

### 3.4 `examples/validated.jsonl`

One JSON object per line, append-ordered by validation time (most recent last):

```json
{"resource":"tn","rowId":"abcd","book":"OBA","ref":"1:1","supportReference":"figs-metaphor","source":"<EN note text>","target":"<AR note text>","validated_at":1752470000}
{"resource":"tn","rowId":"abcd","tombstone":true,"validated_at":1752480000}
```

- `resource`: `tn | tq` (tq lines carry `source`/`target` as `question\tresponse` pairs — exact tq shape to be finalized when the export lands; tn-only is fine for the pilot).
- **Tombstones:** a later line with `"tombstone": true` for the same `(resource, rowId)` revokes the example (a validated row was un-approved or re-edited). Readers MUST apply last-line-wins per `(resource, rowId)`.
- **Bot consumption** (PIPELINE-SPEC §2.2 item 4): select up to N (start 15) live examples as few-shots, by `supportReference` match first, then recency. Selection is the skill's call; this file is just the pool.
- **Bounded pool (writer side, #813).** The file is a selection, not the full history: the 8 most recently validated rows of each `(resource, supportReference)` group (tq rows form one group), plus every validated row of the 4 chapters, across all books, with the most recent validations. Teams work in chapter order, so the reader's "same slug, then most recent" pick lands on the chapters just before the one being drafted. Before this, the file held every validated row and grew with the Bible (2.4 MB at 3,270 Arabic rows). Readers need no change: the schema, ordering and tombstone rule are unchanged. The full history stays in D1, and older selections in this repo's git history.
- `validated_by` from the spec sketch is dropped (user IDs are editor-internal; provenance lives in the editor's `edit_log`).

### 3.5 `templates/templates.tsv`

```tsv
support_reference	target_template	status	comment
figs-metaphor	<AR template text>	active	from the Google-sheet export
figs-idiom	<AR template text>	active	needs review
```

- Tab-separated, header row, UTF-8. One row per SupportReference slug per language.
- **Bot consumption** (PIPELINE-SPEC §2.2 item 1): use the row matching each note's `SupportReference` as the structural scaffold; **fall back to the English template and set the template-fallback flag** (translate-report sidecar) for slugs with no row or `status != active`.
- **Writer-side (editor export):** `support_reference`, `target_template`, and `comment` fields must not contain a literal tab, CR, or LF — the writer flattens any run of those to a single space before emitting (readers do no unescaping, so a raw tab/newline would corrupt the row layout). `comment` carries the editor's variant `type` (e.g. `note`), not free-text rationale. Only `translation_state = 'validated'` template units export, and `status` is always `active` — non-validated translations simply have no row (bot falls back to English per the rule above). One row per `support_reference`: when multiple validated variants share a slug, the first (by sheet order) wins and the rest are omitted. Only sheet-origin units export — the editor's two built-in template units are not tA SupportReference slugs and never appear here. This path is **pack-managed**: once the editor's export runs, it owns `templates/templates.tsv` wholesale — a bootstrap-seeded English-fallback file at this path is replaced by the render, or deleted when D1 holds zero validated units (the bot's per-slug English fallback covers the gap).

## 4. Who writes what, when

| Writer | What | When |
|---|---|---|
| Bible Editor export job *(to be built — the one unbuilt piece on the editor side)* | all files, wholesale render from D1 | nightly per language + on-demand from the panel |
| Bootstrap script | repo creation, `manifest.yaml`, optional English-fallback templates | once per language (~scripted day, PIPELINE-SPEC §3) |
| Humans | nothing (derived artifact; edit via the editor panel) | — |

The bot never writes to this repo.

## 5. Versioning

`manifest.yaml:format` is the compatibility gate. Additive changes (new optional file, new optional CSV column appended on the right) do NOT bump it — readers MUST ignore unknown files/columns. Breaking changes (column removal/reorder, semantics change) bump `format`; the skill SHOULD refuse a `format` it doesn't know rather than guess.

## 6. Asks of bp-assistant (delta to PIPELINE-SPEC §2.4 item 4)

1. **Confirm the reader matches §2–§3** — especially: terms.csv's 7-column concept-oriented schema (not the older 5-column sketch), the forbidden→`replacement` semantics, JSONL tombstones, and template fallback flagging.
2. **Confirm the "context pack has no content files" failure stays** for a populated-manifest-only repo (§2 minimum-content rule), and tell us the exact error string so the editor can surface it meaningfully.
3. **Normalization:** any Hebrew/Greek text inside examples/terms must be compared NFC-normalized (same class of bug as the live `passthrough-quote` NFC failure, INTEGRATION.md §0.1).
4. **Register:** can the skill honor the `**Register:**` enum from `brief.md` (§3.2)? If not, say so and we document it as prose-only.
5. Smoke test offer: we bootstrap `BSOJ/translation-context` with the §3 fixtures above (they are real rows from the editor's verified export), you run `translate` OBA 1 with `contextRef` pinned and we jointly check: terms enforced (نعمة for grace, never السيد for Lord), template scaffold used or fallback-flagged, ≥1 few-shot consumed.

## 7. Open questions

1. tq line shape in `validated.jsonl` (§3.4) — finalize when tq validation volume exists.
2. Where `standards.md` lands when it splits back out of `instructions.md` (needs a `format` note, not a bump).
3. Whether `common_issues_md` should split into its own pack file (e.g. `common-issues.md`) once the bot grows a reader for it — same shape as the `standards.md` question above.
4. Export cadence vs. bot caching — if the skill caches by SHA (it should), no issue; if by repo name, stale reads are possible within a day.

---

*Editor-side evidence: schemas verified against `api/migrations/0040_translation_memory.sql`, `api/src/translationMemory.ts` (export endpoint), and a browser-verified round-trip on 2026-07-14 (the terms.csv sample above is the literal export output). One correction since: 0040's `terminology_identity` uniqueness index keyed on `(concept_id, source_term, status)`, which contradicted §3.3 — a second `preferred` rendering of the same concept could not be stored at all. Migration `0063_terminology_rendering_identity.sql` (2026-07-24) widened that index to include `target_term`, so the several `preferred`/`admitted` rows per concept this contract has always required are now actually storable; `format:` is unchanged, because the contract was right and the writer was wrong. The export job that writes this repo is designed ([`preferences-panel-design.md`](preferences-panel-design.md) §1) and not yet built — this contract is what unblocks building it.*
