#!/usr/bin/env node
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs"
import path from "node:path"

const historyPath = process.env.CODEX_HISTORY_PATH || "/home/admin/.codex/history.jsonl"
const claudeProjectsPath = process.env.CLAUDE_PROJECTS_PATH || "/home/admin/.claude/projects"
const statePath = process.env.CODEX_BRIDGE_STATE_PATH || "/tmp/codex-skill-bridge-state.json"
const endpoint = process.env.LOKI_PUSH_ENDPOINT || "http://127.0.0.1:3100/loki/api/v1/push"
const pollIntervalMs = Number(process.env.CODEX_BRIDGE_POLL_INTERVAL_MS || 5000)
const historyWindowDays = Number(process.env.CODEX_BRIDGE_HISTORY_WINDOW_DAYS || 30)
const batchSize = 1000

function readState() {
  try {
    const state = JSON.parse(readFileSync(statePath, "utf8"))
    if (state.sources) return state
    return { sources: { [`codex:${historyPath}`]: state } }
  } catch {
    return { sources: {} }
  }
}

function writeState(nextState) {
  writeFileSync(statePath, JSON.stringify(nextState, null, 2))
}

function normalizeSkillName(name) {
  return String(name || "")
    .trim()
    .replace(/^\$/, "")
    .replace(/\/SKILL\.md$/i, "")
    .split("/")
    .filter(Boolean)
    .pop()
}

/**
 * Skill names that look like shell/NGINX/template variables but are real skills.
 * Kept short — only names that appear as $name in Codex transcripts without
 * a SKILL.md link and are confirmed real skill invocations.
 */
const KNOWN_SKILL_NAMES = new Set([
  "create-plan", "development-flow-run", "skill-creator", "skill-installer",
  "grace-execute", "personal-message-style", "task-pipeline-review",
  "commit", "review", "verify", "simplify", "run", "init", "loop",
  "deep-research", "claude-api", "code-review", "security-review",
  "fewer-permission-prompts", "update-config", "keybindings-help", "omarchy",
])

/**
 * Heuristic: reject $-prefixed tokens that are clearly NOT skill names.
 * Skill names are lowercase, hyphenated, and don't contain path separators,
 * shell special chars, or common variable patterns.
 */
function looksLikeSkillName(name) {
  if (!name) return false
  // Already stripped the leading $ by this point
  // Reject if it looks like a shell/NGINX/template variable
  if (/[/{}\\$]/.test(name)) return false          // path chars or nested vars
  if (/[A-Z]{2,}/.test(name)) return false          // ALLCAPS like ENV, NF, PID
  if (/^\d+$/.test(name)) return false              // pure number like $1, $2
  if (/^[A-Z]$/) return false   // single uppercase like $N
  if (name.length > 60) return false                // unreasonably long
  // Must contain at least one letter
  if (!/[a-z]/i.test(name)) return false
  // If it's in the known list, always accept
  if (KNOWN_SKILL_NAMES.has(name)) return true
  // Otherwise, require lowercase + hyphens/underscores/colons pattern (typical skill names)
  // Colons appear in namespaced skills like "superpowers:executing-plans"
  return /^[a-z][a-z0-9:_-]*$/.test(name)
}

function skillNamesFromText(text) {
  if (!text || typeof text !== "string") return []

  const names = new Set()
  // Pattern 1: Markdown links to SKILL.md — [$name](path/SKILL.md)
  for (const match of text.matchAll(/\[\$?([^\]\s()]+)\]\(([^)]*\/SKILL\.md)\)/g)) {
    names.add(normalizeSkillName(match[1] || match[2]))
  }
  // Pattern 2: "Using `skill-name`" / "Использую `skill-name`" text markers
  for (const match of text.matchAll(/(?:Using|Использую)\s+`([^`]+)`/g)) {
    names.add(normalizeSkillName(match[1]))
  }
  // Pattern 3: Standalone $skill-name invocations (no SKILL.md link)
  // These appear in Codex transcripts as "$skill-name" without a surrounding
  // markdown link — e.g. "$review", "$create-plan", "$commit".
  for (const match of text.matchAll(/\$([a-zA-Z][a-zA-Z0-9:_-]+)/g)) {
    const candidate = match[1].toLowerCase()
    if (looksLikeSkillName(candidate)) {
      names.add(normalizeSkillName(candidate))
    }
  }
  return Array.from(names).filter(Boolean)
}

function parseCodexRecords(chunk) {
  const records = []
  const oldestAcceptedMs = Date.now() - historyWindowDays * 24 * 60 * 60 * 1000
  for (const line of chunk.split(/\r?\n/)) {
    if (!line.trim()) continue
    try {
      const entry = JSON.parse(line)
      const entryMs = Math.round(Number(entry.ts || Date.now() / 1000) * 1000)
      if (entryMs < oldestAcceptedMs) continue
      for (const skillName of skillNamesFromText(entry.text)) {
        records.push({
          agent: "codex",
          eventName: "skill_activated",
          sessionId: String(entry.session_id || "unknown"),
          skillName,
          timeUnixNano: String(entryMs * 1e6),
        })
      }
    } catch {
      // Ignore partial lines and non-JSON rows.
    }
  }
  return records
}

function parseClaudeRecords(chunk) {
  const records = []
  const seen = new Set()
  const oldestAcceptedMs = Date.now() - historyWindowDays * 24 * 60 * 60 * 1000
  for (const line of chunk.split(/\r?\n/)) {
    if (!line.trim()) continue
    try {
      const entry = JSON.parse(line)

      // --- Source A: attributionSkill on assistant turns ---
      const attrSkill = normalizeSkillName(entry.attributionSkill)
      if (attrSkill) {
        const entryMs = Date.parse(entry.timestamp || "")
        if (Number.isFinite(entryMs) && entryMs >= oldestAcceptedMs) {
          const dedupeKey = `attr:${entry.sessionId || entry.parentUuid || "unknown"}:${attrSkill}:${entryMs}`
          if (!seen.has(dedupeKey)) {
            seen.add(dedupeKey)
            records.push({
              agent: "claude",
              eventName: "skill_activated",
              sessionId: String(entry.sessionId || entry.parentUuid || "unknown"),
              skillName: attrSkill,
              timeUnixNano: String(entryMs * 1e6),
            })
          }
        }
      }

      // --- Source B: Skill tool_use invocations (the trigger event) ---
      // Claude Code emits {"type":"tool_use", "name":"Skill", "input":{"skill":"review", ...}}
      // This captures the actual moment a skill was invoked, not just attributed output.
      if (entry.message?.content && Array.isArray(entry.message.content)) {
        for (const block of entry.message.content) {
          if (block?.type === "tool_use" && block?.name === "Skill" && block?.input?.skill) {
            const skillName = normalizeSkillName(block.input.skill)
            if (!skillName) continue
            const entryMs = Date.parse(entry.timestamp || "")
            const ts = Number.isFinite(entryMs) ? entryMs : Date.now()
            if (ts < oldestAcceptedMs) continue
            const dedupeKey = `tool:${entry.sessionId || entry.parentUuid || "unknown"}:${skillName}:${ts}`
            if (!seen.has(dedupeKey)) {
              seen.add(dedupeKey)
              records.push({
                agent: "claude",
                eventName: "skill_invoked",
                sessionId: String(entry.sessionId || entry.parentUuid || "unknown"),
                skillName,
                timeUnixNano: String(ts * 1e6),
              })
            }
          }
        }
      }
    } catch {
      // Ignore partial lines and non-JSON rows.
    }
  }
  return records
}

function jsonlFiles(root) {
  if (!existsSync(root)) return []
  const entries = readdirSync(root, { withFileTypes: true })
  const files = []
  for (const entry of entries) {
    const fullPath = path.join(root, entry.name)
    if (entry.isDirectory()) files.push(...jsonlFiles(fullPath))
    if (entry.isFile() && entry.name.endsWith(".jsonl")) files.push(fullPath)
  }
  return files
}

async function exportRecords(records) {
  const sortedRecords = records.toSorted((left, right) => Number(left.timeUnixNano) - Number(right.timeUnixNano))
  for (let index = 0; index < sortedRecords.length; index += batchSize) {
    const batch = sortedRecords.slice(index, index + batchSize)
    const response = await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ streams: streamsFor(batch) }),
    })
    if (!response.ok) {
      throw new Error(`Loki export failed: ${response.status} ${await response.text()}`)
    }
  }
}

function streamsFor(records) {
  const streams = new Map()
  for (const record of records) {
    const labels = {
      service_name: "codex-skill-bridge",
      agent: record.agent,
      event_name: record.eventName,
      skill_name: record.skillName,
    }
    const key = JSON.stringify(labels)
    const value = JSON.stringify({
      event_name: record.eventName,
      agent: record.agent,
      skill_name: record.skillName,
      session_id: record.sessionId,
    })
    const stream = streams.get(key) || { stream: labels, values: [] }
    stream.values.push([record.timeUnixNano, value])
    streams.set(key, stream)
  }
  return Array.from(streams.values())
}

async function pollOnce() {
  const state = readState()
  const nextSources = { ...state.sources }
  const records = [
    ...readSourceRecords(`codex:${historyPath}`, historyPath, nextSources, parseCodexRecords),
  ]
  for (const file of jsonlFiles(claudeProjectsPath)) {
    records.push(...readSourceRecords(`claude:${file}`, file, nextSources, parseClaudeRecords))
  }

  if (!records.length) {
    writeState({ sources: nextSources, updatedAt: new Date().toISOString() })
    return
  }

  await exportRecords(records)
  writeState({ sources: nextSources, updatedAt: new Date().toISOString() })
  console.log(`exported ${records.length} skill event(s)`)
}

function readSourceRecords(sourceKey, file, sources, parse) {
  if (!existsSync(file)) return []
  const { size, ino } = statSync(file)
  const previous = sources[sourceKey] || {}
  const offset = previous.inode === ino && previous.offset <= size ? previous.offset : 0
  if (offset === size) return []

  const nextChunk = readFileSync(file, "utf8").slice(offset)
  const completeLength = completeJsonlLength(nextChunk)
  if (!completeLength) return []

  const records = parse(nextChunk.slice(0, completeLength))
  sources[sourceKey] = { inode: ino, offset: offset + completeLength }
  return records
}

function completeJsonlLength(chunk) {
  const newlineIndex = chunk.lastIndexOf("\n")
  if (newlineIndex === -1) return 0
  return newlineIndex + 1
}

async function main() {
  console.log(`watching ${historyPath} and ${claudeProjectsPath}`)
  for (;;) {
    try {
      await pollOnce()
    } catch (error) {
      console.error(error?.message || String(error))
    }
    await new Promise((resolve) => setTimeout(resolve, pollIntervalMs))
  }
}

main()
