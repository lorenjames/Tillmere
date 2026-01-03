/** @type {import('jest').Config} */
module.exports = {
  testEnvironment: 'jsdom',
  roots: ['<rootDir>/__tests__'],
  moduleNameMapper: {
    '^electron$': '<rootDir>/__mocks__/electron.js'
  },
  setupFilesAfterEnv: [],
};

