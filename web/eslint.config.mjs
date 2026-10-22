// ESLint flat config for the web workspace (#485).
//
// Scope is deliberately narrow: only the React hooks rule family
// (eslint-plugin-react-hooks' flat `recommended` preset, including the v7
// React Compiler rules). No eslint:recommended, no typescript-eslint rule
// sets; typescript-eslint is here only as the parser.
//
// Warn first, block later (product decision on #485). Every preset rule is
// forced to "warn"; the rules listed in `blocking` are "error" and fail CI.
// A rule moves into `blocking` in its own PR once its existing cases are
// cleaned up (#591 promoted the ones that already had zero cases).
import reactHooks from 'eslint-plugin-react-hooks';
import tseslint from 'typescript-eslint';

const preset = reactHooks.configs.flat.recommended;

// Listed by name, not derived, so a preset upgrade's new rules start at "warn".
// `incompatible-library` and `unsupported-syntax` stay "warn" even at zero
// cases: the plugin rates them as "compilation skipped" notices, not bugs, so
// ordinary code (a table/virtualizer hook, a class in a component) would trip them.
const blocking = [
  'react-hooks/rules-of-hooks',
  'react-hooks/static-components',
  'react-hooks/use-memo',
  'react-hooks/error-boundaries',
  'react-hooks/set-state-in-render',
  'react-hooks/config',
  'react-hooks/gating',
  'react-hooks/preserve-manual-memoization', // #595
];

for (const rule of blocking) {
  if (!(rule in preset.rules)) throw new Error(`eslint: ${rule} is not in the react-hooks preset`);
}

const rules = Object.fromEntries(
  Object.keys(preset.rules).map((rule) => [
    rule,
    blocking.includes(rule) ? 'error' : 'warn',
  ]),
);

export default [
  {
    ignores: ['dist/**', 'node_modules/**', 'graft/**'],
  },
  {
    files: ['src/**/*.{ts,tsx}'],
    languageOptions: {
      parser: tseslint.parser,
      ecmaVersion: 'latest',
      sourceType: 'module',
      parserOptions: {
        ecmaFeatures: { jsx: true },
      },
    },
    // A disable comment that no longer suppresses anything fails lint.
    linterOptions: { reportUnusedDisableDirectives: 'error' },
    plugins: preset.plugins,
    rules,
  },
];
