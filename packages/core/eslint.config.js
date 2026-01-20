import onlyWarn from "eslint-plugin-only-warn";
import securityPlugin from 'eslint-plugin-security';
import turboPlugin from "eslint-plugin-turbo";
import unicornPlugin from 'eslint-plugin-unicorn';
import globals from 'globals';
import tsPlugin from 'typescript-eslint';

/**
 * A shared ESLint configuration for the repository.
 *
 * @type {import("eslint").Linter.Config[]}
 * */
export const config = [
  // Security
  securityPlugin.configs.recommended,
  {
    files: ['**/*.ts'],
  },
  {
    languageOptions: { globals: globals.node },
  },
  {
    rules: {
      'func-style': ['error', 'expression'],
      'no-restricted-syntax': ['off', 'ForOfStatement'],
      'no-console': ['error'],
      'prefer-template': 'error',
      quotes: ['error', 'single', { avoidEscape: true }],
    },
  },
  // TypeScript Eslint
  {
    rules: {
      '@typescript-eslint/explicit-function-return-type': 'error',
      '@typescript-eslint/consistent-type-definitions': ['error', 'type'],
    },
  },
  // Prettier
  {
    plugins: {
      prettier,
    },
    rules: {
      'prettier/prettier': [
        1,
        {
          endOfLine: 'lf',
          printWidth: 120,
          semi: true,
          singleQuote: true,
          tabWidth: 2,
          trailingComma: 'es5',
          bracketSameLine: true
        },
      ],
    },
  },
  // Unicorn
  {
    plugins: {
      unicorn: unicornPlugin,
    },
    rules: {
      'unicorn/empty-brace-spaces': 'off',
      'unicorn/no-null': 'off',
    },
  },
  pluginJs.configs.recommended,
  ...tsPlugin.configs.recommended,
  {
    plugins: {
      turbo: turboPlugin,
    },
    rules: {
      "turbo/no-undeclared-env-vars": "warn",
    },
  },
  {
    plugins: {
      onlyWarn,
    },
  },
  {
    ignores: ["dist/**"],
  },
];
