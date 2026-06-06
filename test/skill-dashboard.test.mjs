import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

async function readJson(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

test("Agent Skill Usage Top Skills ranks skills by usage for the selected range", async () => {
  const dashboard = await readJson("skill-usage-dashboard.json");
  const topSkills = dashboard.panels.find((panel) => panel.title === "Top Skills");
  const query = topSkills?.targets?.[0]?.expr ?? "";
  const transformations = topSkills?.transformations ?? [];

  assert.equal(dashboard.title, "Agent Skill Usage");
  assert.ok(topSkills, "Top Skills panel should exist");
  assert.equal(topSkills.targets[0].queryType, "instant");
  assert.equal(topSkills.targets[0].legendFormat, "{{skill_name}}");
  assert.match(query, /topk\(25,/);
  assert.match(query, /sum by \(skill_name\)/);
  assert.match(query, /\[\$__range\]/);
  assert.doesNotMatch(query, /sum by \(agent, skill_name\)/);
  assert.deepEqual(transformations.map((transformation) => transformation.id), [
    "labelsToFields",
    "organize",
    "sortBy",
  ]);
});
