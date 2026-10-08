// @ts-check
import eslint from '@eslint/js';
import eslintConfigPrettier from 'eslint-config-prettier';
import { defineConfig } from 'eslint/config';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default defineConfig(
  {
    ignores: ['eslint.config.mjs', 'webpack.config.js'],
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
  eslintConfigPrettier,
);
