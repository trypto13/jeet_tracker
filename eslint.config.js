// @ts-check

import eslint from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
    eslint.configs.recommended,
    ...tseslint.configs.strictTypeChecked,
    {
        languageOptions: {
            parserOptions: {
                projectService: true,
                tsconfigDirName: import.meta.dirname,
            },
        },
        rules: {
            'no-undef': 'off',
            '@typescript-eslint/no-unused-vars': 'off',
            'no-empty': 'off',
            '@typescript-eslint/restrict-template-expressions': 'off',
            '@typescript-eslint/only-throw-error': 'off',
            '@typescript-eslint/no-unnecessary-condition': 'off',
            '@typescript-eslint/no-confusing-void-expression': 'off',
            '@typescript-eslint/no-misused-promises': 'off',
            'no-async-promise-executor': 'off',
            '@typescript-eslint/no-base-to-string': 'off',
            '@typescript-eslint/no-dynamic-delete': 'off',
            '@typescript-eslint/require-await': 'off',
        },
    },
    {
        files: ['**/*.js'],
        ...tseslint.configs.disableTypeChecked,
    },
    {
        ignores: ['dist/**', 'node_modules/**'],
    },
);
