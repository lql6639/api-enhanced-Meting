const { defineConfig, globalIgnores } = require('eslint/config')

const html = require('eslint-plugin-html')
const globals = require('globals')
const tsParser = require('@typescript-eslint/parser')
const js = require('@eslint/js')

const { FlatCompat } = require('@eslint/eslintrc')

const compat = new FlatCompat({
  baseDirectory: __dirname,
  recommendedConfig: js.configs.recommended,
  allConfig: js.configs.all,
})

module.exports = defineConfig([
  {
    languageOptions: {
      ecmaVersion: 2020,
      sourceType: 'module',
      parserOptions: {
        parser: 'babel-eslint',
      },
      globals: {
        ...globals.browser,
        ...globals.node,
      },
    },

    plugins: {
      html,
    },

    extends: compat.extends('plugin:prettier/recommended'),

    rules: {
      // 缩进完全交给 prettier。核心 indent 规则与 prettier 在「三元表达式里的对象字面量」
      // 等场景下的判断不一致（期望 16 空格 vs prettier 的 18 空格），两者同时开启会让
      // eslint --fix 报 ESLintCircularFixesWarning 并永远收敛不了。
      'prettier/prettier': [
        'error',
        {
          endOfLine: 'auto',
        },
      ],

      'space-infix-ops': [
        'error',
        {
          int32Hint: false,
        },
      ],

      'key-spacing': [
        2,
        {
          beforeColon: false,
          afterColon: true,
        },
      ],

      'no-octal': 2,
      'no-redeclare': 2,
      'comma-spacing': 2,
      'no-new-object': 2,
      'arrow-spacing': 2,

      quotes: [
        2,
        'single',
        {
          avoidEscape: true,
          allowTemplateLiterals: true,
        },
      ],
    },
  },
  globalIgnores(['**/public/']),
  {
    files: ['**/*.ts'],
    languageOptions: {
      parser: tsParser,
    },
    extends: compat.extends('plugin:@typescript-eslint/recommended'),
  },
])
