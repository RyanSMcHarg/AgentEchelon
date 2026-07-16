#!/usr/bin/env npx ts-node
/**
 * ADR-011 measurement spike — InvokeAgent vs Converse.
 *
 * Invokes the DEPLOYED basic-tier Bedrock Agent (agent-interface-basic,
 * which carries the tier-scoped load_company_context action group) with
 * enableTrace, against a representative mix of tool-using and non-tool
 * prompts. Captures the three numbers ADR-011 gates sign-off on:
 *
 *   1. TTFR / TTFF distribution, split by tool-using vs non-tool turns,
 *      vs the 15s/45s thresholds.
 *   2. Whether the trace stream reconstructs per-step model / token /
 *      (derived) cost telemetry the admin scorecard needs.
 *   3. Per-turn token-cost delta vs Converse (Converse = 1 model call;
 *      agent = N orchestration calls).
 *
 * No new infra — runs against what's already deployed. Read-only except
 * for the S3 reads the agent's action group performs.
 *
 *   AWS_PROFILE=<your-profile> npx ts-node scripts/spike-invoke-agent.ts
 */

import {
  BedrockAgentRuntimeClient,
  InvokeAgentCommand,
} from '@aws-sdk/client-bedrock-agent-runtime';
import { SSMClient, GetParameterCommand } from '@aws-sdk/client-ssm';

const region = process.env.AWS_REGION || 'us-east-1';
const agentRt = new BedrockAgentRuntimeClient({ region });
const ssm = new SSMClient({ region });

// Haiku 3 (basic tier) approximate on-demand pricing, USD per token.
// Source: AWS Bedrock pricing as of early 2026 — adjust if rates moved.
const HAIKU_IN_PER_TOKEN = 0.25 / 1_000_000;
const HAIKU_OUT_PER_TOKEN = 1.25 / 1_000_000;

interface PromptCase {
  label: string;
  text: string;
  expectsTool: boolean; // company/product/FAQ → should invoke load_company_context
}

const CASES: PromptCase[] = [
  { label: 'greeting (non-tool)', text: 'hi there', expectsTool: false },
  { label: 'ack (non-tool)', text: 'thanks, that helps', expectsTool: false },
  { label: 'products (tool)', text: 'What products does Stratum offer and what do they cost?', expectsTool: true },
  { label: 'company (tool)', text: 'Give me an overview of Stratum Technologies — what does the company do?', expectsTool: true },
  { label: 'faq (tool)', text: 'Is there a free plan, and what browsers are supported?', expectsTool: true },
  { label: 'out-of-tier (tool-attempt)', text: 'What was our Q2 revenue and ARR?', expectsTool: true },
];

interface Measurement {
  label: string;
  expectsTool: boolean;
  ttffMs: number | null;
  ttfrMs: number | null;
  orchestrationSteps: number;
  modelCalls: number;
  actionGroupInvocations: number;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  answerPreview: string;
  toolFired: boolean;
  error?: string;
}

async function getBasicAgent(): Promise<{ agentId: string; aliasId: string }> {
  const [id, alias] = await Promise.all([
    ssm.send(new GetParameterCommand({ Name: '/agent-echelon/bedrock-agent/basic/agent-id' })),
    ssm.send(new GetParameterCommand({ Name: '/agent-echelon/bedrock-agent/basic/alias-id' })),
  ]);
  return { agentId: id.Parameter!.Value!, aliasId: alias.Parameter!.Value! };
}

async function runCase(
  agentId: string,
  aliasId: string,
  c: PromptCase,
): Promise<Measurement> {
  const m: Measurement = {
    label: c.label,
    expectsTool: c.expectsTool,
    ttffMs: null,
    ttfrMs: null,
    orchestrationSteps: 0,
    modelCalls: 0,
    actionGroupInvocations: 0,
    inputTokens: 0,
    outputTokens: 0,
    costUsd: 0,
    answerPreview: '',
    toolFired: false,
  };

  const t0 = Date.now();
  try {
    const resp = await agentRt.send(
      new InvokeAgentCommand({
        agentId,
        agentAliasId: aliasId,
        sessionId: `spike-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        inputText: c.text,
        enableTrace: true,
      }),
    );

    let answer = '';
    for await (const event of resp.completion ?? []) {
      // First chunk of the final answer → TTFF.
      if (event.chunk?.bytes) {
        if (m.ttffMs === null) m.ttffMs = Date.now() - t0;
        answer += Buffer.from(event.chunk.bytes).toString('utf-8');
      }
      // Trace events carry the per-step telemetry.
      if (event.trace?.trace) {
        const tr = event.trace.trace;
        const orch = (tr as unknown as Record<string, unknown>).orchestrationTrace as
          | Record<string, unknown>
          | undefined;
        if (orch) {
          m.orchestrationSteps += 1;
          const modelOut = orch.modelInvocationOutput as
            | { metadata?: { usage?: { inputTokens?: number; outputTokens?: number } } }
            | undefined;
          if (modelOut?.metadata?.usage) {
            m.modelCalls += 1;
            m.inputTokens += modelOut.metadata.usage.inputTokens ?? 0;
            m.outputTokens += modelOut.metadata.usage.outputTokens ?? 0;
          }
          const invocationInput = orch.invocationInput as
            | { actionGroupInvocationInput?: { actionGroupName?: string } }
            | undefined;
          if (invocationInput?.actionGroupInvocationInput) {
            m.actionGroupInvocations += 1;
            if (
              invocationInput.actionGroupInvocationInput.actionGroupName
                ?.toLowerCase()
                .includes('company')
            ) {
              m.toolFired = true;
            }
          }
        }
      }
    }
    m.ttfrMs = Date.now() - t0;
    m.answerPreview = answer.replace(/\s+/g, ' ').slice(0, 120);
    m.costUsd = m.inputTokens * HAIKU_IN_PER_TOKEN + m.outputTokens * HAIKU_OUT_PER_TOKEN;
  } catch (err) {
    m.ttfrMs = Date.now() - t0;
    m.error = (err as Error).message;
  }
  return m;
}

function fmt(n: number | null): string {
  return n === null ? '—' : `${(n / 1000).toFixed(1)}s`;
}

async function main(): Promise<void> {
  console.log('\nADR-011 spike — InvokeAgent on the deployed basic agent\n');
  const { agentId, aliasId } = await getBasicAgent();
  console.log(`agent ${agentId} alias ${aliasId}\n`);

  const results: Measurement[] = [];
  for (const c of CASES) {
    process.stdout.write(`running: ${c.label} … `);
    const m = await runCase(agentId, aliasId, c);
    console.log(m.error ? `ERROR ${m.error}` : `TTFR ${fmt(m.ttfrMs)}`);
    results.push(m);
  }

  console.log('\n=== Results ===\n');
  console.log(
    [
      'case'.padEnd(26),
      'tool?'.padEnd(6),
      'fired'.padEnd(6),
      'TTFF'.padEnd(7),
      'TTFR'.padEnd(7),
      'steps'.padEnd(6),
      'mCalls'.padEnd(7),
      'inTok'.padEnd(7),
      'outTok'.padEnd(7),
      'cost$',
    ].join(' '),
  );
  for (const m of results) {
    console.log(
      [
        m.label.padEnd(26),
        (m.expectsTool ? 'yes' : 'no').padEnd(6),
        (m.toolFired ? 'yes' : 'no').padEnd(6),
        fmt(m.ttffMs).padEnd(7),
        fmt(m.ttfrMs).padEnd(7),
        String(m.orchestrationSteps).padEnd(6),
        String(m.modelCalls).padEnd(7),
        String(m.inputTokens).padEnd(7),
        String(m.outputTokens).padEnd(7),
        m.costUsd.toFixed(6),
      ].join(' '),
    );
  }

  // Threshold summary (DEFAULT_RESPONSE_THRESHOLDS: TTFR fail 45s, demo 30s).
  const ok = results.filter((m) => !m.error && m.ttfrMs !== null);
  const tool = ok.filter((m) => m.expectsTool);
  const nonTool = ok.filter((m) => !m.expectsTool);
  const avg = (xs: Measurement[], f: (m: Measurement) => number) =>
    xs.length ? xs.reduce((s, m) => s + f(m), 0) / xs.length : 0;

  console.log('\n=== Summary vs thresholds (TTFR warn 15s / fail 45s; demo 30s) ===\n');
  console.log(`non-tool turns: avg TTFR ${fmt(avg(nonTool, (m) => m.ttfrMs!))}, avg cost $${avg(nonTool, (m) => m.costUsd).toFixed(6)}`);
  console.log(`tool turns:     avg TTFR ${fmt(avg(tool, (m) => m.ttfrMs!))}, avg cost $${avg(tool, (m) => m.costUsd).toFixed(6)}, avg model-calls ${avg(tool, (m) => m.modelCalls).toFixed(1)}`);
  const over45 = ok.filter((m) => (m.ttfrMs ?? 0) > 45000).length;
  const over30 = ok.filter((m) => (m.ttfrMs ?? 0) > 30000).length;
  const over15 = ok.filter((m) => (m.ttfrMs ?? 0) > 15000).length;
  console.log(`\nTTFR breaches: >15s warn: ${over15}/${ok.length}   >30s demo: ${over30}/${ok.length}   >45s fail: ${over45}/${ok.length}`);
  console.log(`telemetry: ${ok.every((m) => m.modelCalls > 0) ? 'per-step token usage RECOVERED from trace on all turns' : 'WARNING — some turns had no token usage in trace'}`);
  const errs = results.filter((m) => m.error);
  if (errs.length) console.log(`\nerrors: ${errs.map((m) => `${m.label}: ${m.error}`).join(' | ')}`);
  console.log('');
}

main().catch((e) => {
  console.error('spike failed:', e);
  process.exit(1);
});
