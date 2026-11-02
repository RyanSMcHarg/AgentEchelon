import { defineConfig } from 'vitest/config'

// @ae/shared — code both SPAs depend on (message parsing, event tracking, Chime/Cognito clients).
//
// This config exists because the package had test FILES but no way to run them: `npm test` at the
// workspace root is `npm -ws --if-present run test`, and with no `test` script here the --if-present
// flag skipped the package silently. Two suites — including messageParser, which strips the control
// markers that are a deliberate injection defense — had never run in this layout.
//
// `node` environment by default: the parsing and tracking suites touch no DOM, and the one global
// they need (sessionStorage) is stubbed by the test itself with vi.stubGlobal. A suite that does need
// a document says so per file with `// @vitest-environment jsdom` - AuthProvider.test.tsx renders the
// provider - which keeps the cost on the file that asks for it rather than on every run.
export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    root: '.',
  },
})
