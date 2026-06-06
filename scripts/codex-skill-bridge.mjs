#!/usr/bin/env node
import { createServer } from "node:http"
import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs"

import {
  jsonlFiles,
  normalizeSkillName,
  parseCodexSessionChunk,
  readCodexSessionMetrics,
  renderPrometheusMetrics,
  skillNamesFromText,
} from "./codex-observability.mjs"

const historyPath = process.env.CODEX_HISTORY_PATH || "/home/admin/.codex/history.jsonl"
const sessionsPath = process.env.CODEX_SESSIONS_PATH || "/home/admin/.codex/sessions"
const archivedSessionsPath = process.env.CODEX_ARCHIVED_SESSIONS_PATH || "/home/admin/.codex/archived_sessions"
const claudeProjectsPath = process.env.CLAUDE_PROJECTS_PATH || "/home/admin/.claude/projects"
const statePath = process.env.CODEX_BRIDGE_STATE_PATH || "/tmp/codex-skill-bridge-state.json"
const endpoint = process.env.LOKI_PUSH_ENDPOINT || "http://127.0.0.1:3100/loki/api/v1/push"
const pollIntervalMs = Number(process.env.CODEX_BRIDGE_POLL_INTERVAL_MS || 5000)
const metricsPort = Number(process.env.CODEX_METRICS_PORT || 9464)
const metricsRefreshMs = Number(process.env.CODEX_METRICS_REFRESH_MS || 30000)
const historyWindowDays = Number(process.env.CODEX_BRIDGE_HISTORY_WINDOW_DAYS || 30)
const batchSize = 1000
let metricsText = "# HELP codex_bridge_metrics_ready Whether Codex bridge metrics have been collected.\n# TYPE codex_bridge_metrics_ready gauge\ncodex_bridge_metrics_ready 0\n"
let nextMetricsRefreshMs = 0

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

function parseCodexSessionRecords(chunk, file) {
  const oldestAcceptedMs = Date.now() - historyWindowDays * 24 * 60 * 60 * 1000
  return parseCodexSessionChunk(chunk, file).skillEvents
    .filter((event) => event.timestampMs >= oldestAcceptedMs)
    .map((event) => ({
      agent: event.agent,
      eventName: event.eventName,
      sessionId: event.sessionId,
      skillName: event.skillName,
      timeUnixNano: String(event.timestampMs * 1e6),
    }))
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

function codexSessionFiles() {
  return [...jsonlFiles(sessionsPath), ...jsonlFiles(archivedSessionsPath)]
}

function refreshMetricsIfNeeded(force = false) {
  const now = Date.now()
  if (!force && now < nextMetricsRefreshMs) return
  const files = codexSessionFiles()
  metricsText = renderPrometheusMetrics(readCodexSessionMetrics(files))
  nextMetricsRefreshMs = now + metricsRefreshMs
}

function startMetricsServer() {
  createServer((request, response) => {
    if (request.url !== "/metrics") {
      response.writeHead(404)
      response.end("not found\n")
      return
    }
    refreshMetricsIfNeeded()
    response.writeHead(200, { "Content-Type": "text/plain; version=0.0.4; charset=utf-8" })
    response.end(metricsText)
  }).listen(metricsPort, "0.0.0.0", () => {
    console.log(`serving Codex metrics on :${metricsPort}/metrics`)
  })
}

async function pollOnce() {
  const state = readState()
  const nextSources = { ...state.sources }
  refreshMetricsIfNeeded()
  const records = [
    ...readSourceRecords(`codex:${historyPath}`, historyPath, nextSources, parseCodexRecords),
  ]
  for (const file of codexSessionFiles()) {
    records.push(...readSourceRecords(`codex-session:${file}`, file, nextSources, parseCodexSessionRecords))
  }
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

  const records = parse(nextChunk.slice(0, completeLength), file)
  sources[sourceKey] = { inode: ino, offset: offset + completeLength }
  return records
}

function completeJsonlLength(chunk) {
  const newlineIndex = chunk.lastIndexOf("\n")
  if (newlineIndex === -1) return 0
  return newlineIndex + 1
}

async function main() {
  refreshMetricsIfNeeded(true)
  startMetricsServer()
  console.log(`watching ${historyPath}, ${sessionsPath}, ${archivedSessionsPath}, and ${claudeProjectsPath}`)
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
