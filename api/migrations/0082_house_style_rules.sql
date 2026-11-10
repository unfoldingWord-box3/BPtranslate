-- 0082: house-style rules (issue #815).
--
-- A per-workspace (= per database) list of mechanical fixes applied to an AI
-- translate draft when it is imported (applyTranslateTnRow / applyTranslateTqRow
-- in api/src/pipelineImport.ts), so both runners are covered by one engine
-- (api/src/houseStyle.ts). The model's raw text stays in the edit_log payload
-- (raw_note, or raw_question / raw_response, plus applied_rules).
--
-- Rules are data, but matching is NOT admin-supplied regex. `kind` names one of
-- a fixed set of matchers implemented in code:
--   literal              find text anywhere outside **bold** spans (the order of
--                        combining marks inside find is ignored); replace is
--                        literal text; an empty replace deletes find plus one
--                        adjacent run of spaces.
--   whole_word           like literal, but find must not touch a letter, mark or
--                        digit on either side.
--   final_bracket_period appends "." after a note's final "]" unless the
--                        bracket's content already ends in punctuation
--                        (… ؟ . ! ? ؛, so "..." too); find and replace are
--                        descriptive only.
-- An unknown kind or scope is skipped by the engine. It is validated in code, not
-- by a CHECK, so adding a kind never needs a table rebuild.
--
-- The three seed rows come from 3,103 approved Arabic LUK/MRK notes. They ship
-- SWITCHED OFF (enabled = 0): nothing changes until an admin enables each one in
-- Preferences after the Arabic editor confirms it. The migration runs on every
-- workspace database, so non-Arabic workspaces get the same switched-off rows.
--
-- examples_json:         [{"before": "...", "after": "..."}]  (each must hold)
-- counter_examples_json: ["..."]                              (each left as is)
-- api/src/houseStyle.test.mjs proves both against these exact rows.

CREATE TABLE IF NOT EXISTS house_style_rules (
  id                    TEXT PRIMARY KEY,
  kind                  TEXT NOT NULL,
  find                  TEXT NOT NULL,
  replace               TEXT NOT NULL DEFAULT '',
  scope                 TEXT NOT NULL DEFAULT 'note',
  examples_json         TEXT NOT NULL DEFAULT '[]',
  counter_examples_json TEXT NOT NULL DEFAULT '[]',
  enabled               INTEGER NOT NULL DEFAULT 0 CHECK (enabled IN (0, 1)),
  sort_order            INTEGER NOT NULL DEFAULT 0,
  created_at            INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at            INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_by            INTEGER
);

INSERT OR IGNORE INTO house_style_rules
  (id, kind, find, replace, scope, examples_json, counter_examples_json, enabled, sort_order)
VALUES (
  'ar-drop-mukayyaf-tag',
  'literal',
  '(مُكيَّف)',
  '',
  'note',
  '[{"before": "ترجمة بديلة: [وكان معهم] (مُكيَّف)", "after": "ترجمة بديلة: [وكان معهم]"}, {"before": "هنا (مُكيَّف) تعني", "after": "هنا تعني"}, {"before": "كلمة (مُكيَّف).", "after": "كلمة."}, {"before": "(مُكيَّف) هنا تعني", "after": "هنا تعني"}]',
  '["يقول **(مُكيَّف)** هنا", "الغرفة (مُكيَّفة) هنا"]',
  0,
  10
);

INSERT OR IGNORE INTO house_style_rules
  (id, kind, find, replace, scope, examples_json, counter_examples_json, enabled, sort_order)
VALUES (
  'ar-mufidan-tanween',
  'whole_word',
  'مفيدا',
  'مفيدًا',
  'note',
  '[{"before": "قد يكون مفيدا أن", "after": "قد يكون مفيدًا أن"}, {"before": "إذا كان ذلك مفيدا،", "after": "إذا كان ذلك مفيدًا،"}]',
  '["قد يكون مفيدًا أن", "قد يكون مفيداً أن", "أشياء مفيدات", "يقول **مفيدا** هنا"]',
  0,
  20
);

INSERT OR IGNORE INTO house_style_rules
  (id, kind, find, replace, scope, examples_json, counter_examples_json, enabled, sort_order)
VALUES (
  'ar-final-bracket-period',
  'final_bracket_period',
  ']',
  '].',
  'end-of-note',
  '[{"before": "ترجمة بديلة: [وكان معهم]", "after": "ترجمة بديلة: [وكان معهم]."}, {"before": "ترجمة بديلة: [هذا] أو [ذلك]", "after": "ترجمة بديلة: [هذا] أو [ذلك]."}]',
  '["ترجمة بديلة: [وكان معهم].", "ترجمة بديلة: [ماذا نفعل؟]", "ترجمة بديلة: [ثم …]", "ترجمة بديلة: [وكان معهم.]", "ترجمة بديلة: [ثم ...]", "(انظر: [[rc://*/ta/man/translate/figs-metaphor]])", "[[rc://*/ta/man/translate/figs-metaphor]]", "يقول **[وكان معهم]**"]',
  0,
  30
);
