/** @type {import('jest').Config} */
module.exports = {
  testEnvironment: 'node',
  extensionsToTreatAsEsm: ['.ts'],
  moduleNameMapper: {
    '^(\\.{1,2}/.*)\\.js$': '$1',
    '^@tenet/eval-(.*)$': '<rootDir>/eval/$1/src',
    '^@tenet/models-(.*)$': '<rootDir>/models/$1/src',
    '^@tenet/surface-(.*)$': '<rootDir>/surfaces/$1/src',
    '^@tenet/connectors-(.*)$': '<rootDir>/connectors/$1/src',
    '^@tenet/stores-vector-(.*)$': '<rootDir>/stores/vector/$1/src',
    '^@tenet/stores-state-(.*)$': '<rootDir>/stores/state/$1/src',
    '^@tenet/app-(.*)$': '<rootDir>/apps/$1/src',
    '^@tenet/rerank-(.*)$': '<rootDir>/packages/rerank-$1/src',
    '^@tenet/judge-(.*)$': '<rootDir>/packages/judge-$1/src',
    '^@tenet/voice-(.*)$': '<rootDir>/packages/voice-$1/src',
    '^@tenet/voice$': '<rootDir>/packages/voice/src',
    '^@tenet/(.*)$': '<rootDir>/packages/$1/src',
  },
  transform: {
    '^.+\\.ts$': [
      'ts-jest',
      {
        useESM: true,
        tsconfig: {
          target: 'ES2023',
          module: 'ESNext',
          moduleResolution: 'Bundler',
          strict: true,
          esModuleInterop: true,
          isolatedModules: true,
        },
      },
    ],
  },
  testMatch: [
    '<rootDir>/packages/*/src/**/*.test.ts',
    '<rootDir>/models/*/src/**/*.test.ts',
    '<rootDir>/surfaces/*/src/**/*.test.ts',
    '<rootDir>/connectors/*/src/**/*.test.ts',
    '<rootDir>/stores/*/*/src/**/*.test.ts',
    '<rootDir>/stores/*/src/**/*.test.ts',
    '<rootDir>/apps/*/src/**/*.test.ts',
    '<rootDir>/eval/*/src/**/*.test.ts',
  ],
  collectCoverageFrom: [
    'packages/*/src/**/*.ts',
    'models/*/src/**/*.ts',
    'surfaces/*/src/**/*.ts',
    'connectors/*/src/**/*.ts',
    'stores/*/*/src/**/*.ts',
    'apps/*/src/**/*.ts',
    '!**/src/**/*.test.ts',
    '!**/src/index.ts',
  ],
  // Raised 2026-07-18 to just-below the actual level (90.3/78.5/94.4/93.0 with a small
  // margin) so this gate PROTECTS the current coverage — a regression below these fails
  // CI, instead of the old floor that silently allowed a drop to 60%. Enforced by
  // `pnpm test:coverage` in CI.
  coverageThreshold: {
    global: {
      branches: 75,
      functions: 90,
      lines: 90,
      statements: 88,
    },
  },
  testTimeout: 10_000,
};
