/** @type {import('jest').Config} */
module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  roots: ['<rootDir>/src'],
  testMatch: ['**/__tests__/**/*.spec.ts'],
  setupFiles: ['reflect-metadata'],
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
        experimentalDecorators: true,
        emitDecoratorMetadata: true,
        noUncheckedIndexedAccess: false,
        exactOptionalPropertyTypes: false,
        types: ['node', 'jest'],
      },
    }],
  },
  testTimeout: 60_000,
  verbose: true,
  // NestJS providers (timers heartbeat, RxJS) peuvent laisser des handles
  // ouverts après les tests → forceExit évite que Jest reste suspendu.
  forceExit: true,
};
