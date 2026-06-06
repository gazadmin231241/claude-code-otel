import test from "node:test"
import assert from "node:assert/strict"

import {
  buildCodexMetrics,
  parseCodexSessionChunk,
  renderPrometheusMetrics,
} from "../scripts/codex-observability.mjs"

test("parses token_count usage events from Codex session chunks", () => {
  const chunk = [
    JSON.stringify({
      timestamp: "2026-06-06T09:34:26.703Z",
      type: "event_msg",
      payload: {
        type: "token_count",
        info: {
          last_token_usage: {
            input_tokens: 10,
            cached_input_tokens: 7,
            output_tokens: 3,
            reasoning_output_tokens: 1,
            total_tokens: 13,
          },
          total_token_usage: {
            input_tokens: 100,
            cached_input_tokens: 70,
            output_tokens: 30,
            reasoning_output_tokens: 10,
            total_tokens: 130,
          },
        },
        rate_limits: {
          primary: { used_percent: 8, window_minutes: 300, resets_at: 1780754400 },
          secondary: { used_percent: 38, window_minutes: 10080, resets_at: 1781161200 },
        },
      },
    }),
    "",
  ].join("\n")

  const records = parseCodexSessionChunk(chunk, "/codex/sessions/example.jsonl")

  assert.equal(records.usageEvents.length, 1)
  assert.deepEqual(records.usageEvents[0].usage, {
    input_tokens: 10,
    cached_input_tokens: 7,
    output_tokens: 3,
    reasoning_output_tokens: 1,
    total_tokens: 13,
  })
  assert.equal(records.usageEvents[0].sessionId, "example")
  assert.equal(records.rateLimitEvents[0].primary.used_percent, 8)
})

test("extracts Codex skill activations from assistant text in session chunks", () => {
  const chunk = [
    JSON.stringify({
      timestamp: "2026-06-06T09:35:00.000Z",
      type: "event_msg",
      payload: {
        type: "agent_message",
        message: "Использую `superpowers:test-driven-development` и $commit. См. /skills/code-simplifier/SKILL.md",
      },
    }),
    JSON.stringify({
      timestamp: "2026-06-06T09:35:01.000Z",
      type: "response_item",
      payload: {
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text: "Using `docker-compose-nginx-best-practices` now." }],
      },
    }),
    "",
  ].join("\n")

  const records = parseCodexSessionChunk(chunk, "/codex/sessions/example.jsonl")
  const skillNames = records.skillEvents.map((event) => event.skillName).sort()

  assert.deepEqual(skillNames, [
    "code-simplifier",
    "commit",
    "docker-compose-nginx-best-practices",
    "superpowers:test-driven-development",
  ])
})

test("builds Prometheus metrics for Codex token windows and rate limits", () => {
  const nowMs = Date.parse("2026-06-06T10:00:00.000Z")
  const usageEvents = [
    {
      timestampMs: nowMs - 60_000,
      sessionId: "recent",
      usage: { input_tokens: 10, cached_input_tokens: 7, output_tokens: 3, reasoning_output_tokens: 1, total_tokens: 13 },
    },
    {
      timestampMs: nowMs - 8 * 24 * 60 * 60_000,
      sessionId: "old",
      usage: { input_tokens: 20, cached_input_tokens: 5, output_tokens: 4, reasoning_output_tokens: 2, total_tokens: 24 },
    },
  ]
  const rateLimitEvents = [{
    timestampMs: nowMs - 10_000,
    primary: { used_percent: 8, window_minutes: 300, resets_at: 1780754400 },
    secondary: { used_percent: 38, window_minutes: 10080, resets_at: 1781161200 },
  }]

  const metrics = buildCodexMetrics({ usageEvents, rateLimitEvents, sessionCount: 2, filesScanned: 3, nowMs })
  const text = renderPrometheusMetrics(metrics)

  assert.match(text, /codex_token_usage_window_tokens\{window="last_5h",type="total_tokens"\} 13/)
  assert.match(text, /codex_token_usage_window_tokens\{window="last_30d",type="total_tokens"\} 37/)
  assert.match(text, /codex_rate_limit_used_percent\{window="primary"\} 8/)
  assert.match(text, /codex_sessions_total 2/)
})
