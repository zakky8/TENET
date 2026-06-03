/** @type {import('jest').Config} */
module.exports = {
  testEnvironment: 'node',
  extensionsToTreatAsEsm: ['.ts'],
  moduleNameMapper: {
    '^(\\.{1,2}/.*)\\.js$': '$1',
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
  testMatch: ['<rootDir>/packages/*/src/**/*.test.ts'],
  collectCoverageFrom: [
    'packages/*/src/**/*.ts',
    '!packages/*/src/**/*.test.ts',
    '!packages/*/src/index.ts',
  ],
  coverageThreshold: {
    global: {
      branches: 60,
      functions: 70,
      lines: 70,
      statements: 70,
    },
  },
  testTimeout: 10_000,
};
