// ESLint flat config for the web workspace (#485).
//
// Scope is deliberately narrow: only the React hooks rule family
// (eslint-plugin-react-hooks' flat `recommended` preset, including the v7
// React Compiler rules). No eslint:recommended, no typescript-eslint rule
// sets; typescript-eslint is here only as the parser.
//
// Warn-only for now (product decision on #485: warn first, block later).
// Every preset rule is forced to "warn", so `npm run lint` exits 0 and CI
// never blocks on it. Each rule moves to "error" in its own PR once its
// existing cases are cleaned up.
import reactHooks from 'eslint-plugin-react-hooks';
import tseslint from 'typescript-eslint';

const preset = reactHooks.configs.flat.recommended;

const warnOnly = Object.fromEntries(
  Object.keys(preset.rules).map((rule) => [rule, 'warn']),
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
    plugins: preset.plugins,
    rules: warnOnly,
  },
];
