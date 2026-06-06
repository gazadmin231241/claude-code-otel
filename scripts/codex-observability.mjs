import { existsSync, readdirSync, readFileSync, statSync } from "node:fs"
import path from "node:path"

export const tokenTypes = [
  "input_tokens",
  "cached_input_tokens",
  "output_tokens",
  "reasoning_output_tokens",
  "total_tokens",
]

const metricWindows = [
  ["last_5h", 5 * 60 * 60 * 1000],
  ["last_24h", 24 * 60 * 60 * 1000],
  ["last_7d", 7 * 24 * 60 * 60 * 1000],
  ["last_30d", 30 * 24 * 60 * 60 * 1000],
]

export function normalizeSkillName(name) {
  return String(name || "")
    .trim()
    .replace(/^\$/, "")
    .replace(/\/SKILL\.md$/i, "")
    .split("/")
    .filter(Boolean)
    .pop()
}

const knownSkillNames = new Set([
  "create-plan", "development-flow-run", "skill-creator", "skill-installer",
  "grace-execute", "personal-message-style", "task-pipeline-review",
  "commit", "review", "verify", "simplify", "run", "init", "loop",
  "deep-research", "claude-api", "code-review", "security-review",
  "fewer-permission-prompts", "update-config", "keybindings-help", "omarchy",
])

function looksLikeSkillName(name) {
  if (!name) return false
  if (/[/{}\\$]/.test(name)) return false
  if (/[A-Z]{2,}/.test(name)) return false
  if (/^\d+$/.test(name)) return false
  if (/^[A-Z]$/.test(name)) return false
  if (name.length > 60) return false
  if (!/[a-z]/i.test(name)) return false
  if (knownSkillNames.has(name)) return true
  return /^[a-z][a-z0-9:_-]*$/.test(name)
}

export function skillNamesFromText(text) {
  if (!text || typeof text !== "string") return []

  const names = new Set()
  for (const match of text.matchAll(/\[\$?([^\]\s()]+)\]\(([^)]*\/SKILL\.md)\)/g)) {
    names.add(normalizeSkillName(match[1] || match[2]))
  }
  for (const match of text.matchAll(/((?:\/|[A-Za-z]:\\)[^\s`"')]+\/SKILL\.md)/g)) {
    names.add(normalizeSkillName(match[1]))
  }
  for (const match of text.matchAll(/(?:Using|Использую)\s+`([^`]+)`/g)) {
    names.add(normalizeSkillName(match[1]))
  }
  for (const match of text.matchAll(/\$([a-zA-Z][a-zA-Z0-9:_-]+)/g)) {
    const candidate = match[1].toLowerCase()
    if (looksLikeSkillName(candidate)) names.add(normalizeSkillName(candidate))
  }
  return Array.from(names).filter(Boolean)
}

function emptyUsage() {
  return Object.fromEntries(tokenTypes.map((type) => [type, 0]))
}

function usageFromMapping(value) {
  const usage = emptyUsage()
  if (!value || typeof value !== "object") return usage
  for (const type of tokenTypes) usage[type] = Math.max(0, Number(value[type] || 0))
  return usage
}

function usageHasActivity(usage) {
  return tokenTypes.some((type) => usage[type] > 0)
}

function addUsage(target, usage) {
  for (const type of tokenTypes) target[type] += usage[type]
}

function isoToMs(value) {
  const timestampMs = Date.parse(value || "")
  return Number.isFinite(timestampMs) ? timestampMs : Date.now()
}

export function sessionIdFromPath(filePath) {
  return path.basename(filePath || "unknown", ".jsonl").replace(/^rollout-[^-]+-\d{2}-\d{2}-\d{2}-/, "")
}

function textBlocksFromEntry(entry) {
  const payload = entry?.payload
  const blocks = []
  if (payload?.type === "agent_message" && payload.message) blocks.push(payload.message)
  if (payload?.type === "message" && payload.role === "assistant" && Array.isArray(payload.content)) {
    for (const item of payload.content) {
      if (item?.type === "output_text" && item.text) blocks.push(item.text)
    }
  }
  return blocks
}

export function parseCodexSessionChunk(chunk, filePath = "unknown.jsonl") {
  const usageEvents = []
  const rateLimitEvents = []
  const skillEvents = []
  const seenSkills = new Set()
  const sessionId = sessionIdFromPath(filePath)

  for (const line of chunk.split(/\r?\n/)) {
    if (!line.trim()) continue
    try {
      const entry = JSON.parse(line)
      const timestampMs = isoToMs(entry.timestamp)
      const payload = entry.payload && typeof entry.payload === "object" ? entry.payload : {}

      if (entry.type === "event_msg" && payload.type === "token_count") {
        const info = payload.info && typeof payload.info === "object" ? payload.info : {}
        const usage = usageFromMapping(info.last_token_usage || info.total_token_usage)
        if (usageHasActivity(usage)) usageEvents.push({ timestampMs, sessionId, usage })
        if (payload.rate_limits && typeof payload.rate_limits === "object") {
          rateLimitEvents.push({ timestampMs, ...payload.rate_limits })
        }
      }

      for (const text of textBlocksFromEntry(entry)) {
        for (const skillName of skillNamesFromText(text)) {
          const dedupeKey = `${timestampMs}:${sessionId}:${skillName}`
          if (seenSkills.has(dedupeKey)) continue
          seenSkills.add(dedupeKey)
          skillEvents.push({ agent: "codex", eventName: "skill_activated", sessionId, skillName, timestampMs })
        }
      }
    } catch {
      // Ignore partial lines and non-JSON rows.
    }
  }

  return { usageEvents, rateLimitEvents, skillEvents }
}

export function jsonlFiles(root) {
  if (!root || !existsSync(root)) return []
  const entries = readdirSync(root, { withFileTypes: true })
  const files = []
  for (const entry of entries) {
    const fullPath = path.join(root, entry.name)
    if (entry.isDirectory()) files.push(...jsonlFiles(fullPath))
    if (entry.isFile() && entry.name.endsWith(".jsonl")) files.push(fullPath)
  }
  return files
}

export function readCodexSessionMetrics(files) {
  const usageEvents = []
  const rateLimitEvents = []
  let newestMtimeMs = 0

  for (const file of files) {
    const stat = statSync(file)
    newestMtimeMs = Math.max(newestMtimeMs, stat.mtimeMs)
    const records = parseCodexSessionChunk(readFileSync(file, "utf8"), file)
    usageEvents.push(...records.usageEvents)
    rateLimitEvents.push(...records.rateLimitEvents)
  }

  return buildCodexMetrics({
    usageEvents,
    rateLimitEvents,
    sessionCount: new Set(usageEvents.map((event) => event.sessionId)).size,
    filesScanned: files.length,
    newestMtimeMs,
  })
}

export function buildCodexMetrics({ usageEvents, rateLimitEvents, sessionCount, filesScanned, newestMtimeMs = 0, nowMs = Date.now() }) {
  const allTime = emptyUsage()
  for (const event of usageEvents) addUsage(allTime, event.usage)

  const windows = {}
  for (const [name, durationMs] of metricWindows) {
    const usage = emptyUsage()
    const cutoffMs = nowMs - durationMs
    for (const event of usageEvents) {
      if (event.timestampMs >= cutoffMs) addUsage(usage, event.usage)
    }
    windows[name] = usage
  }

  const latestRateLimits = rateLimitEvents.toSorted((left, right) => left.timestampMs - right.timestampMs).at(-1) || {}
  const lastActivityMs = usageEvents.reduce((latest, event) => Math.max(latest, event.timestampMs), 0)

  return {
    allTime,
    windows,
    rateLimits: {
      primary: latestRateLimits.primary || {},
      secondary: latestRateLimits.secondary || {},
    },
    sessionCount,
    eventCount: usageEvents.length,
    filesScanned,
    lastActivitySeconds: Math.floor(lastActivityMs / 1000),
    newestMtimeSeconds: Math.floor(newestMtimeMs / 1000),
  }
}

function labelsText(labels) {
  const entries = Object.entries(labels)
  if (!entries.length) return ""
  return `{${entries.map(([key, value]) => `${key}="${String(value).replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`).join(",")}}`
}

function line(name, labels, value) {
  const safeValue = Number.isFinite(Number(value)) ? Number(value) : 0
  return `${name}${labelsText(labels)} ${safeValue}`
}

export function renderPrometheusMetrics(metrics) {
  const lines = [
    "# HELP codex_token_usage_tokens_total Codex token usage parsed from local session files.",
    "# TYPE codex_token_usage_tokens_total counter",
  ]
  for (const type of tokenTypes) lines.push(line("codex_token_usage_tokens_total", { type }, metrics.allTime[type]))

  lines.push(
    "# HELP codex_token_usage_window_tokens Codex token usage in rolling local windows.",
    "# TYPE codex_token_usage_window_tokens gauge",
  )
  for (const [windowName] of metricWindows) {
    for (const type of tokenTypes) {
      lines.push(line("codex_token_usage_window_tokens", { window: windowName, type }, metrics.windows[windowName][type]))
    }
  }

  lines.push(
    "# HELP codex_rate_limit_used_percent Latest Codex rate-limit used percent.",
    "# TYPE codex_rate_limit_used_percent gauge",
  )
  for (const [windowName, rate] of Object.entries(metrics.rateLimits)) {
    lines.push(line("codex_rate_limit_used_percent", { window: windowName }, rate.used_percent))
    lines.push(line("codex_rate_limit_resets_at_seconds", { window: windowName }, rate.resets_at))
  }

  lines.push(
    "# HELP codex_sessions_total Number of Codex sessions with token activity.",
    "# TYPE codex_sessions_total gauge",
    line("codex_sessions_total", {}, metrics.sessionCount),
    line("codex_token_events_total", {}, metrics.eventCount),
    line("codex_session_files_scanned_total", {}, metrics.filesScanned),
    line("codex_last_activity_timestamp_seconds", {}, metrics.lastActivitySeconds),
    line("codex_sessions_newest_mtime_seconds", {}, metrics.newestMtimeSeconds),
    "",
  )
  return lines.join("\n")
}
