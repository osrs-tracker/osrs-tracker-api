// @ts-check
import eslint from '@eslint/js';
import eslintConfigPrettier from 'eslint-config-prettier';
import { defineConfig } from 'eslint/config';
import { createTypeScriptImportResolver } from 'eslint-import-resolver-typescript';
import { importX } from 'eslint-plugin-import-x';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default defineConfig(
  {
    ignores: ['eslint.config.mjs', 'rspack.config.js'],
  },
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  ...tseslint.configs.stylistic,
  {
    languageOptions: {
      globals: globals.node,
      sourceType: 'commonjs',
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
  },
  {
    rules: {
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/no-unsafe-argument': 'warn',
      // Misses reads in parameter decorators: a module constant only used as `@Query('skip', new
      // ParseIntRangePipe(SKIP))` in a class's last method is reported as useless. `no-unused-vars` still catches unused
      // ones.
      'no-useless-assignment': 'off',
      // The web app's SSR transfer cache drops `no-store`, `no-cache` and `private` responses (see the skill's
      // Cache-Control section). Regex literals don't match, so a spec can still test for them.
      'no-restricted-syntax': [
        'error',
        ...[
          'Literal[value=/no-store|no-cache|private/i]',
          'TemplateElement[value.raw=/no-store|no-cache|private/i]',
        ].map((selector) => ({
          selector,
          message: 'Never `no-store`, `no-cache` or `private` in Cache-Control: use a value from `CACHE_CONTROL`.',
        })),
      ],
    },
  },
  {
    // No circular imports: Nest resolves a provider cycle only through `forwardRef`, and a module that imports itself
    // through another reads it half-initialised. Resolved paths, so relative imports count too.
    files: ['src/**/*.ts'],
    plugins: { 'import-x': importX },
    settings: {
      'import-x/resolver-next': [createTypeScriptImportResolver({ project: 'tsconfig.json' })],
      // The files no-cycle parses to follow their imports; it skips the others, and the default is only .js
      'import-x/extensions': ['.ts'],
    },
    rules: {
      'import-x/no-cycle': 'error',
    },
  },
  eslintConfigPrettier,
);
