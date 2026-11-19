/**
 * A RUN'S END CARRIES ITS PROCESS ID (SPEC-PROCESSES P8; DESIGN-PROCESSES section 6).
 *
 * What it proves: the run-ended fact names the run's process, its edition and the team that owned the run's assistant, and a
 * settled task's fact names the process its run carries, each kept only where it has its shape; every message a run says
 * has its process on its out-of-band analytics record, keyed by the id the send returned; no run message's Amazon Chime
 * SDK Metadata gains a key; and the router's role gains exactly the processor's write-only put on that one table.
 */
import { readFileSync } from 'fs';
import { resolve } from 'path';
import * as iam from 'aws-cdk-lib/aws-iam';
import { wireMessageAnalytics } from '../../lib/stacks/agent-classification-common';

const read = (p: string) => readFileSync(resolve(__dirname, '../..', p), 'utf8');
const router = read('lambda/src/router-agent-handler.ts');
const processor = read('lambda/src/assistant-async-processor.ts');
const service = read('lambda/src/task-service.ts');
const facts = read('lambda/src/lib/archive-facts.ts');

describe('the facts carry the process (P8)', () => {
  it('the run-ended fact: the id, the edition and the run\'s owner team', () => {
    const runEnded = facts.slice(facts.indexOf('export interface RunEndedFact'), facts.indexOf('let client'));
    expect(runEnded).toMatch(/processId\?: string;[\s\S]{0,80}process\?: string;\s+processEdition\?: string;\s+ownerTeam\?: string;/);
    const ended = router.slice(router.indexOf('ended: async (disposition, steps, ending)'), router.indexOf('withheld: async'));
    expect(ended).toMatch(/\.\.\.processFactFields\(ctx\.process\)/);
    expect(router).toMatch(/\.\.\.processFactFields\(run\.process\)/);
  });

  it('kept by the task service only where each part has its shape', () => {
    const fn = service.slice(service.indexOf('function processFieldsOf('), service.indexOf('/** The archive record of a settlement'));
    expect(fn).toMatch(/!PROCESS_ID\.test\(input\.processId\)\) return \{\};/);
    expect(fn).toMatch(/PROCESS_ID\.test\(input\.processEdition\)/);
    const record = service.slice(service.indexOf('async function recordRunEnded('), service.indexOf('function processFieldsOf('));
    expect(record).toMatch(/\.\.\.processFieldsOf\(input\)/);
  });

  it('the task-settled fact: the process its run carries', () => {
    const settled = service.slice(service.indexOf('function settledFact('), service.indexOf('function settledFact(') + 1400);
    expect(settled).toMatch(/task\.workflowRun\?\.process && PROCESS_ID\.test\(task\.workflowRun\.process\.id\) \? \{ processId: task\.workflowRun\.process\.id \}/);
    expect(facts.slice(facts.indexOf('export interface TaskSettledFact'), facts.indexOf('export interface RunEndedFact'))).toMatch(/processId\?: string;/);
  });
});

describe('a run message\'s process rides its out-of-band record, never its Metadata', () => {
  it('the router writes it for each run send, by the id the send returned', () => {
    const fn = router.slice(router.indexOf('async function recordRunMessageProcess('), router.indexOf('function runnerOf('));
    expect(fn).toMatch(/writeMessageAnalytics\(\{ messageId: sent\.MessageId, channelArn, analytics: \{ processRun: processFactFields\(proc\) \} \}\)/);
    // The workflow send, the welcome's opening, the intake offer and a move's notice.
    expect(router.match(/await recordRunMessageProcess\(sent, /g)?.length).toBe(4);
  });

  it('the processor writes it for an agent step\'s and a voiced send\'s message, on the one record a welcome\'s turn also uses', () => {
    expect(processor.match(/await recordRunMessageProcess\(sent, event\.channelArn, /g)?.length).toBe(3);
    expect(processor).toMatch(/\.\.\.\(proc \? \{ processRun: processRunOf\(proc\) \} : \{\}\)/);
    // ONE SHAPE FOR EVERY WRITER (`processRunOf`): the id, the name, and the edition and team where the run has them.
    expect(read('lambda/src/lib/analytics-metadata.ts')).toMatch(/return \{ processId: proc\.id, process: proc\.name, \.\.\.\(proc\.edition \? \{ processEdition: proc\.edition \}/);
  });

  it('no run message\'s Metadata gains a key: neither the run card nor any other inline field names the process', () => {
    for (const src of [router, processor]) {
      const cards = src.match(/eventRun: \{[^}]*\}/g) ?? [];
      expect(cards.length).toBeGreaterThan(0);
      for (const card of cards) expect(card).not.toMatch(/process/i);
      // `processRun` is written only on the out-of-band record.
      const uses = src.split('processRun:').length - 1;
      expect(uses).toBe(1);
    }
  });
});

describe('the router\'s grant: write-only, on the analytics table only (synth)', () => {
  it('wireMessageAnalytics grants exactly dynamodb:PutItem on the one table', () => {
    const statements: iam.PolicyStatement[] = [];
    const env: Record<string, string> = {};
    wireMessageAnalytics({ addEnvironment: (k, v) => { env[k] = v; }, addToRolePolicy: (s) => { statements.push(s); } }, { tableName: 'ae-message-analytics', tableArn: 'arn:aws:dynamodb:us-east-1:111122223333:table/ae-message-analytics' });
    expect(env).toEqual({ MESSAGE_ANALYTICS_TABLE: 'ae-message-analytics' });
    expect(statements.map((s) => s.toStatementJson())).toEqual([
      { Action: 'dynamodb:PutItem', Effect: 'Allow', Resource: 'arn:aws:dynamodb:us-east-1:111122223333:table/ae-message-analytics' },
    ]);
  });

  it('is wired on the router\'s own role, beside the processor\'s', () => {
    const stack = read('lib/stacks/assistant-profile-stack.ts');
    expect(stack).toMatch(/addEnvironment: \(k: string, v: string\) => agentHandler\.addEnvironment\(k, v\),\s+addToRolePolicy: \(st: iam\.PolicyStatement\) => handlerRole\.addToPrincipalPolicy\(st\),\s+\}, props\.messageAnalytics\);/);
  });
});
