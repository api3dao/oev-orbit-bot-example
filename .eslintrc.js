module.exports = {
  root: true, // https://github.com/eslint/eslint/issues/13385#issuecomment-641252879
  env: {
    es6: true,
    node: true,
  },
  parser: '@typescript-eslint/parser',
  parserOptions: {
    project: ['./tsconfig.json'],
    ecmaVersion: 11,
    sourceType: 'module',
  },
  globals: {
    Atomics: 'readonly',
    SharedArrayBuffer: 'readonly',
  },
  plugins: ['@typescript-eslint', 'import'],
  rules: {
    'unicorn/no-process-exit': 'off',
    'unicorn/prefer-top-level-await': 'off',

    // Typescript
    '@typescript-eslint/consistent-return': 'off', // Does not play with no useless undefined when function return type is "T | undefined" and does not have a fixer.
    '@typescript-eslint/max-params': 'off',
    '@typescript-eslint/no-dynamic-delete': 'off',
    '@typescript-eslint/no-var-requires': 'off',
    '@typescript-eslint/use-unknown-in-catch-callback-variable': 'off',

    // Lodash
    'lodash/prefer-immutable-method': 'off',
    'lodash/prop-shorthand': 'off',

    // Removal of typechain
    '@typescript-eslint/no-unsafe-call': 'off',
  },
};
