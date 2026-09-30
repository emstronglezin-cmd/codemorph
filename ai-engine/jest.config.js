/** @type {import('jest').Config} */
module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  roots: ['<rootDir>/tests'],
  testMatch: ['**/*.test.ts'],
  transform: {
    '^.+\\.ts$': ['ts-jest', {
      tsconfig: {
        target: 'ES2022',
        module: 'CommonJS',
        moduleResolution: 'node',
        esModuleInterop: true,
        strict: true,
        skipLibCheck: true,
        resolveJsonModule: true,
        noUncheckedIndexedAccess: false,
        exactOptionalPropertyTypes: false,
        types: ['node', 'jest'],
      },
    }],
  },
  testTimeout: 120_000,
  verbose: true,
  // Le pipeline réel (pino loggers, timers heartbeat, ZIP) laisse des handles
  // ouverts après les tests → forceExit évite que Jest reste suspendu.
  forceExit: true,
};
