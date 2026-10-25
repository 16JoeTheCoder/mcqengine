import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import globals from 'globals';

export default tseslint.config(
  { ignores: ['dist', 'node_modules', 'test-results', 'playwright-report'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: { globals: { ...globals.browser, ...globals.node } },
    rules: {
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      'no-restricted-properties': ['error', { property: 'innerHTML', message: 'Untrusted content must go through text nodes or the SVG sanitiser.' }],
    },
  },
  { files: ['src/sw-template.js'], languageOptions: { globals: { ...globals.serviceworker, __PRECACHE__: 'readonly' } } },
);
