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

function skillNamesFromText(text) {
  if (!text || typeof text !== "string") return []

  const names = new Set()
  for (const match of text.matchAll(/\[\$?([^\]\s()]+)\]\(([^)]*\/SKILL\.md)\)/g)) {
    names.add(normalizeSkillName(match[1] || match[2]))
  }
  for (const match of text.matchAll(/(?:Using|Использую)\s+`([^`]+)`/g)) {
    names.add(normalizeSkillName(match[1]))
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
  const oldestAcceptedMs = Date.now() - historyWindowDays * 24 * 60 * 60 * 1000
  for (const line of chunk.split(/\r?\n/)) {
    if (!line.trim()) continue
    try {
      const entry = JSON.parse(line)
      const skillName = normalizeSkillName(entry.attributionSkill)
      if (!skillName) continue
      const entryMs = Date.parse(entry.timestamp || "")
      if (!Number.isFinite(entryMs) || entryMs < oldestAcceptedMs) continue
      const ingestMs = Date.now() + records.length
      records.push({
        agent: "claude",
        eventName: "skill_activated",
        sessionId: String(entry.sessionId || entry.parentUuid || "unknown"),
        skillName,
        timeUnixNano: String(ingestMs * 1e6),
      })
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
