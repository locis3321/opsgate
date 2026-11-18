import js from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['dist/', 'node_modules/', 'coverage/', '.e2e/'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['**/*.{js,mjs}'],
    languageOptions: { globals: globals.node },
  },
  {
    // §5.9.4 / project-rules §2：原生工具禁止直接 import ssh2 / authorize / audit / credential / instancePool / dispatch
    //（横切逻辑由框架承担；列出的每一条都是安全边界，AC-50。transfer/guardRules 服务允许——传输旁路声明为框架能力）
    files: ['src/native/tools/**/*.{ts,js}'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: [
                'ssh2',
                '**/services/authorize*',
                '**/services/audit*',
                '**/services/credential*',
                '**/services/instance*',
                '**/framework/dispatch*',
              ],
              message:
                '原生工具禁止直接 import ssh2 / authorize / auditService / credentialService / instancePool / dispatch——横切由框架承担（project-rules §2）',
            },
          ],
        },
      ],
    },
  },
  {
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
    },
  },
);
