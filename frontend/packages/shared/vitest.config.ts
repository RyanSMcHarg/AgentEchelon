import { defineConfig } from 'vitest/config'

// @ae/shared — code both SPAs depend on (message parsing, event tracking, Chime/Cognito clients).
//
// This config exists because the package had test FILES but no way to run them: `npm test` at the
// workspace root is `npm -ws --if-present run test`, and with no `test` script here the --if-present
// flag skipped the package silently. Two suites — including messageParser, which strips the control
// markers that are a deliberate injection defence — had never run in this layout.
//
// `node` environment, not jsdom: neither suite touches the DOM, and the one global they need
// (sessionStorage) is stubbed by the test itself with vi.stubGlobal.
export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    root: '.',
  },
})
