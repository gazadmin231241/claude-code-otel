import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

async function readJson(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

function panelTargets(dashboard) {
  return dashboard.panels
    .flatMap((panel) => panel.targets ?? [])
    .map((target) => target.expr ?? target.query ?? "")
    .filter(Boolean);
}

test("AI Code Observability dashboard combines Claude, Codex, and skill views", async () => {
  const dashboard = await readJson("ai-code-observability-dashboard.json");
  const compose = await readFile("docker-compose.yml", "utf8");
  const targets = panelTargets(dashboard).join("\n");
  const panelTitles = dashboard.panels.map((panel) => panel.title);

  assert.equal(dashboard.title, "AI Code Observability");
  assert.equal(dashboard.uid, "ai-code-observability");
  assert.ok(compose.includes("ai-code-observability-dashboard.json"));

  assert.ok(targets.includes("claude_code_token_usage_tokens_total"));
  assert.ok(targets.includes("codex_token_usage_window_tokens"));
  assert.ok(targets.includes('{event_name=~"skill_activated|skill_invoked"}'));

  assert.ok(panelTitles.includes("Claude Code"));
  assert.ok(panelTitles.includes("Codex"));
  assert.ok(panelTitles.includes("Skills & Logs"));
});
