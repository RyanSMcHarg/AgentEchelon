# E2E watchdog

**Audience:** engineers writing or running the Playwright e2e suite. **Code:** `tests/e2e/helpers/fixtures.ts` and `tests/e2e/helpers/watchdog/`. **Guard:** `backend/test/e2e-watchdog.test.ts`.

Every e2e test runs under three listeners that watch what its assertions do not: the operator alerts the platform emails to its admins, the backend's log lines, and the test's own progress. A finding fails the test that is running when it arrives, so a broken backend ends a test in seconds instead of leaving it to wait out its timeout, and an alarm that fires during a run is a failure of that run rather than an email found later.

A spec gets all three by importing `test` and `expect` from `./helpers/fixtures` rather than from `@playwright/test`. The guard test refuses a spec that does not.

## The listeners

| Listener | Signal | Fails the test with |
|---|---|---|
| Operator alerts | The e2e admin's own Amazon Chime SDK messaging session on the admin notification channel, the channel every `ae.alert` is posted to and emailed from | The alarm's name, CloudWatch's reason, and the time |
| Backend errors | CloudWatch Logs Live Tail over the live log groups of the turn path (router, async processors, data plane, channel flow), one session per ten groups | The line, its request id, and its log group |
| Stalls | The page's own events, backend lines that name the test's conversation, runner-side message events, and helper reads whose answer changed | When the page, the backend, and the harness were each last heard from |

**Operator alerts.** An alarm going into ALARM fails the running test, and so does any other operator notice (an assistant error, a turn that did not start, an audit finding). A recovery and a completed clean-copy run are reported and fail nothing. Alarms already in ALARM when a phase begins are reported as standing, apart from the ones that fire during it. The listener is event-driven: a dropped session reconnects and reads the channel's messages since the last one it saw, once, as part of reconnecting. The e2e admin reaches the channel as a member, which the admins group grants through the platform's own membership sync.

**Backend errors.** A line counts as an error on the same terms as the per-file CloudWatch sweep (`ERROR`, `Exception`, `AccessDenied`, `Denied` as whole terms, and the Lambda runtime's timeout line), with the same exclusions, so the live check never reports what the sweep would not. `guardBackendErrors` stays in every spec as the backstop for a line the stream missed while a session was reopening.

**Stalls.** A test that sees no progress for its window fails as stalled. The window is 120 seconds. A backend line counts when it names one of the test's conversations, or comes from a request that did; a test that names no conversation counts any turn-path line.

A finding that arrives with no test running (an alert between tests, an error during a file's `afterAll`) is kept in the run record and fails the worker as it ends. `validate.mjs` prints each phase's record, `tests/test-results/<phase>/watchdog-record.json`, and fails the phase over such a finding.

## Declaring what a test causes on purpose

Each declaration is made inside the test that needs it, the way `allowConsoleError` is.

| Declaration | Use | Scope |
|---|---|---|
| `expectAlarm(nameOrPattern)` | An alarm (by name), an operator notice (by message type), or a synthetic alarm (by words its alert carries) the spec trips on purpose | The rest of the run, because an alarm evaluates on its own period and can go into ALARM after the test that caused it |
| `allowBackendError(pattern)` | An error line the test causes on purpose | That test, live, and its file's sweep |
| `declareWait(reason, dueAt)` | The test waits on a timer, such as a workflow deadline | Silence is expected until `dueAt` plus 90 seconds; the window resumes after it |
| `test.use({ stallWindowMs })` | A wider window for a step that raises no event at all | The tests the `use` covers |

Declare an alarm as narrowly as it can be named. `context-source-alarm.spec.ts` declares its synthetic alarm by the words of its own description, so a real context source alarm later in the same run still fails it.

## Waiting on events

A wait on a room's messages wakes on the room's message events. Use `roomMessagesUntil(channelArn, memberArn, done, { timeoutMs })` (`helpers/event-run-messages.ts`) or `waitFor` (`helpers/workflow-task.ts`): each reads the room now, then again only when a message in it is created, updated, redacted or deleted, through a messaging session the runner holds as that member. `pollFor` remains for state that raises no event the runner can subscribe to (a task row, a schedule, an archive projection), and reports a read whose answer changed as progress.

## Timeouts

A spec that raises its timeout above 10 minutes names the timer it waits on with `declareWait`. The specs that run longer on live multi-turn model work are listed on a ratchet in the guard test, which only shrinks. Workflow deadlines in the specs use the platform's shortest allowed deadline (`MIN_DEADLINE_MINUTES`, five minutes).

## Settings

| Variable | Effect |
|---|---|
| `E2E_STALL_WINDOW_MS` | The default stall window for the run |
| `E2E_WATCHDOG=0` | Turns the listeners and the stall detector off for the run |
| `E2E_PHASE_STARTED_AT` | Set by `validate.mjs` per phase; an alert posted before it is standing, not the phase's |

Without AWS credentials the alert and backend listeners say so in the run log and in the record, and the stall detector still watches the page.
