// @ts-check
import tsEslint from 'typescript-eslint';
import reactPlugin from 'eslint-plugin-react';
import reactHooksPlugin from 'eslint-plugin-react-hooks';

export default tsEslint.config(
  {
    ignores: [
      'dist/**',
      'dist-electron/**',
      'node_modules/**',
      'coverage/**',
      '_reference/**',
      '**/*.cjs',
      'eslint.config.js',
      // Generated file (T055): output of `npm run codegen:api`. Linting it is
      // pointless — its shape is dictated by openapi-typescript, not project
      // conventions, and every regeneration would otherwise trip strict rules.
      'src/shared/api-types.ts',
      // Project-local Claude Code automation scripts (PR #191). These .mjs
      // files are not part of any tsconfig project; the project-service-based
      // parser cannot resolve them and fails CI lint with "was not found by
      // the project service". They are tooling, not production source, and
      // are out of scope for the renderer/main/preload type-check rules.
      '.claude/**',
      // Project-local Node build/CI utility scripts (e.g., scripts/update-loc-badge.mjs
      // from PR #221). Same rationale as `.claude/**` above — these `.mjs` files run
      // outside any tsconfig project, and the project-service parser fails them with
      // "was not found by the project service" on CI. They are CI tooling, not
      // production source. `.ts` scripts under `scripts/` (e.g., `verify-codegen.ts`)
      // remain covered by `tsconfig.json` and are NOT ignored.
      'scripts/**/*.mjs',
      // Transient scratch directory for hardware bench smokes (e.g.
      // `.tmp/receipt-smoke.ts`). Gitignored, outside any tsconfig project, and
      // not production source — the project-service parser fails it with "was
      // not found by the project service". Same rationale as `.claude/**` above.
      '.tmp/**',
      // Spec-Kit project-local automation scratch scripts (e.g.
      // `.specify/scratch/pos-011-015-seed-workflow.js` from PR #363 — a one-off
      // spec-seeding workflow). These run outside any tsconfig project and the
      // project-service parser fails them with "was not found by the project
      // service" on CI. Tooling, not production source. Same rationale as
      // `.claude/**` / `scripts/**/*.mjs` / `.tmp/**` above.
      '.specify/scratch/**',
    ],
  },
  tsEslint.configs.strictTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        projectService: true,
      },
    },
  },
  {
    plugins: {
      react: reactPlugin,
      'react-hooks': reactHooksPlugin,
    },
    settings: { react: { version: 'detect' } },
    rules: {
      'react/react-in-jsx-scope': 'off',
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'warn',
    },
  },
  // Deferred: add electron-security ESLint plugin rules once package name is confirmed
  // (e.g., eslint-plugin-electron or similar; verify on npm before installing)
);
