# Latency targets (industry-sourced)

The admin console's latency targets (`frontend/packages/admin/src/components/admin/metricTargets.ts` and
`LatencyTab.latencyColor`) are set to published industry standards, not to a self-imposed
ceiling. This doc records the standards and how they map onto AgentEchelon so the numbers are
defensible and reviewable.

## The metric that matters: time to first feedback (TTFF)

AgentEchelon delivers a reply in two phases (see [`MESSAGE-FLOW.md`](MESSAGE-FLOW.md) section 5):
a placeholder ("One moment...") is sent within about a second, then the real answer updates that
message in place. So the latency a user actually perceives is **TTFF**, not the total time to the
finished answer. TTFF is the primary latency SLO; total time is a secondary throughput and cost
signal.

This is why judging the console red on a 2-second total-latency target was wrong: an agentic turn
runs a self-hosted tool loop (reason, call `load_company_context`, answer) with input and output
guardrails, which is two or more Bedrock calls plus a retrieval. Completion in seconds is expected;
the user is not waiting on it blind because the placeholder already landed.

## Where the time goes: the numbers explained by the message flow

Each latency metric maps onto a hop in the message journey (see
[`MESSAGE-FLOW.md`](MESSAGE-FLOW.md)). This is what the numbers mean and why they land
where they do.

| Phase (MESSAGE-FLOW) | What happens | Contributes to |
|---|---|---|
| Send + Channel Flow (section 2) | The user message is received and released; conversation-level handling | negligible (ms) |
| Fulfillment handler (section 4) | Resolve `min(userTier, channelTier)`, classify intent (a fast Haiku call), resolve the model, pick a delivery mode, and RETURN THE PLACEHOLDER | **TTFF** |
| Async processor tool loop (section 6.1) | Input guardrail, then the self-hosted loop: Bedrock call (reason), `load_company_context` retrieval, Bedrock call (answer), output guardrail | **avg / p95 total** and **avg Bedrock** |
| Delivery (section 5) | `UpdateChannelMessage` swaps the placeholder for the answer | tail of total |

**Why TTFF is small and total is seconds.** The fulfillment handler returns the
placeholder before any answer-generation work, so TTFF is a fast path: a tier and intent
resolve plus one lightweight classification. The answer, by contrast, runs an **agentic
tool loop**: two or more Bedrock calls plus a retrieval plus two guardrail passes. That is
inherently seconds, and Bedrock generation dominates it. So a 2s total target was never
reachable for an answer that reasons and calls a tool; the honest target is the Nielsen 10s
attention limit, held acceptable by the placeholder.

**Why this is the right trade.** The delivery design (`MESSAGE-FLOW.md` section 5,
`PLACEHOLDER_UPDATE`) deliberately trades total time for reliability and perceived speed:
the user sees feedback in under a second and the answer fills in. Optimizing the total
number at the expense of that pattern would make the product feel worse, not better, which
is why TTFF is the SLO and total is a throughput and cost signal.

## Response-time standards

### Nielsen Norman Group response-time limits

The foundational UX thresholds (Jakob Nielsen, *Usability Engineering*, 1993) are still the standard:

| Threshold | User perception | Implication |
|---|---|---|
| 0.1s (100ms) | Instantaneous | Direct manipulation feels immediate |
| 1.0s | Noticeable delay | User stays focused; no feedback needed |
| 10s | Attention limit | Flow breaks; users may abandon |

Rule: past 1s, show a progress indicator; past 10s, show percent-done. AgentEchelon's placeholder is
that progress indicator, which is what keeps a multi-second completion acceptable.

### Research-based targets

| Metric | Good | Warn | Source |
|---|---|---|---|
| Time to first feedback (TTFF) | < 1s | < 2s | Nielsen NNG |
| Time to complete response | < 10s | < 30s | Nielsen NNG (10s attention limit, ~30s abandon) |
| Placeholder display | < 500ms | < 1s | UX best practice |
| AI chatbot TTFR | < 1s excellent, < 2s good, < 5s acceptable | | 2025 AI-chatbot benchmarks |
| Bedrock time-to-first-token | 200 to 800ms typical | | AWS Bedrock |

## AgentEchelon targets (as configured)

| Console metric | Good | Warn | Basis |
|---|---|---|---|
| `ttff_ms` (time to first feedback) | <= 1s | <= 2s | Nielsen 1s focus limit. The primary UX SLO. |
| `avg_total_ms` (avg time to complete) | <= 10s | <= 30s | Nielsen 10s attention limit / 30s abandon. |
| `p95_total_ms` (tail time to complete) | <= 15s | <= 30s | Tail kept under the 30s abandon threshold. |
| `avg_bedrock_ms` (model time) | <= 6s | <= 12s | Dominant share of the completion budget (Bedrock processing dominates a turn). |
| `LatencyTab.latencyColor` (table cells) | <= 10s | <= 30s | Same Nielsen time-to-complete bands. |

Note: **tune from observed data, within the standard.** Once traffic flows, set the target near a
p50 you are happy with and the warn near p90, but keep both inside the Nielsen 10s / 30s envelope.
The standard is the ceiling of acceptability, not the goal.

## Not yet implemented

- **TTFF capture.** The Latency tab now shows a **TTFF card** as the first, primary metric, wired to
  the `<= 1s` target. The pipeline does not yet record `ttff_ms` (the moment the placeholder is sent),
  so the card reads **"not captured yet"** until that field is emitted. Capturing it is the
  highest-value latency improvement: the fulfillment handler (or the client, measuring send to first
  bot message) should record the time from the user message to the placeholder and write it alongside
  the other latency fields. The card and its target are already wired and populate automatically once
  `ttff_ms` is present.
- **Per-tier targets and metrics.** Latency is currently aggregated and targeted **globally**.
  Premium runs a larger model over more context, so its completion time is legitimately higher than
  basic; a single global target flatters basic and unfairly reds premium. Per-tier latency metrics
  and per-tier targets are the more honest model, and the data is already there (the `latency_metrics`
  query carries `agent_type` per row). Not yet implemented: the console aggregates across tiers, and
  `metricTargets.ts` holds one target per metric rather than one per tier. When added, each tier gets
  its own good/warn bands (a premium turn legitimately sits higher in the Nielsen 10s envelope than a
  basic turn).

## References

1. Nielsen Norman Group, [Response Time Limits](https://www.nngroup.com/articles/response-times-3-important-limits/) - foundational UX research on human perception of delay.
2. [Acceptable AI response time (2025)](https://agentiveaiq.com/blog/what-is-an-acceptable-response-time-in-2025) - industry benchmarks for AI customer service.
3. [The Need for Speed in AI](https://www.uxtigers.com/post/ai-response-time) - AI-specific response-time research.
4. AWS, [Amazon Bedrock latency-optimized inference](https://aws.amazon.com/blogs/machine-learning/optimizing-ai-responsiveness-a-practical-guide-to-amazon-bedrock-latency-optimized-inference/) - Bedrock performance guidance.

## Related

- [`MESSAGE-FLOW.md`](MESSAGE-FLOW.md) section 5 - the placeholder/update delivery pattern that makes TTFF the perceived metric.
- [`SPEC-ADMIN-CONSOLE.md`](../../specs/admin-console/SPEC-ADMIN-CONSOLE.md) - the Latency tab and the metric-target registry.
