/**
 * `/stop` IS ACTED ON IMMEDIATELY, BEFORE ANYTHING ELSE IS READ (ADR-033 "Cancellation";
 * DESIGN-TASK-ACCESS 2.5: "it is the only kind acted on before the queue is read at all").
 *
 * The stop branch sat after the intent classifier and after the waiting-task step. Two things followed,
 * both measured from the router logs: a stop waited on a model call before it was answered, and the
 * waiting-task step had already applied "/stop" as the person's answer to the task they owed, so a
 * private stop that was then REFUSED still handed that task back to the assistant. The refusal said
 * nothing had been stopped while the task had moved.
 *
 * Asserted on the router SOURCE, as the other stop tests are: observing the order needs a whole Lex
 * turn with a channel and a model, and the property is the position of one block.
 */
import * as fs from 'fs';
import * as path from 'path';

const SRC = fs.readFileSync(path.join(__dirname, '..', '..', 'lambda', 'src', 'router-agent-handler.ts'), 'utf8');
const STOP = SRC.indexOf('const parsedStop = parseStopCommand(userMessage);');
const at = (needle: string): number => {
  const i = SRC.indexOf(needle);
  // A needle that is gone would make every "before" pass trivially, so its absence fails here.
  expect(i).toBeGreaterThan(-1);
  return i;
};

describe('the stop branch runs before anything reads the message for meaning', () => {
  it('exists', () => {
    expect(STOP).toBeGreaterThan(-1);
  });

  it('runs before the intent classifier, so no model call sits in front of it', () => {
    expect(STOP).toBeLessThan(at('await classifyIntent(userMessage'));
    expect(STOP).toBeLessThan(at('classifyIntentByKeyword(userMessage, packForClassification)'));
  });

  it('runs before the waiting-task step, so a stop is never applied as an answer', () => {
    expect(STOP).toBeLessThan(at('await applyUserResponseToTask({'));
    expect(STOP).toBeLessThan(at('const heldByPerson = personTasks.live;'));
  });

  it('runs before the onboarding intake and the drift check', () => {
    expect(STOP).toBeLessThan(at('const step = advanceIntake('));
    expect(STOP).toBeLessThan(at('await runLiveDriftFlow({'));
  });

  it('parses the text with the private address already stripped, as it did before', () => {
    expect(STOP).toBeGreaterThan(at('userMessage = stripPrivatePrefix(userMessage, privateTo);'));
  });
});

describe('the private-stop refusal moved with it', () => {
  const end = SRC.indexOf('const turnAttachment = bypassAttachment(event);');
  const block = SRC.slice(STOP, end);

  it('is inside the stop branch and ahead of the rest of the turn', () => {
    expect(end).toBeGreaterThan(STOP);
    expect(block).toContain("templateLine('stop-must-be-public', stopWords)");
    // Refused BEFORE anything is stopped: the refusal returns ahead of the suppression and the cancel.
    expect(block.indexOf("templateLine('stop-must-be-public', stopWords)")).toBeLessThan(block.indexOf('await recordStop('));
    expect(block.indexOf("templateLine('stop-must-be-public', stopWords)")).toBeLessThan(block.indexOf('await cancelStoppedTasks('));
  });

  it('every path through the branch returns, so a stop never falls through into the turn', () => {
    const tail = block.slice(block.lastIndexOf('return formatLexSilentResponse(event);'));
    expect(tail).toMatch(/return formatLexResponse\(\s*event,/);
  });
});
