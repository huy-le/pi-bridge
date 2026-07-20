// Scan ~/.pi/agent/sessions/<encoded-cwd>/*.jsonl and return session summaries.
//
// Newer pi sessions store messages as:
//   {"type":"message","message":{"role":"user|assistant","content":[...]}}
// Older sessions may still use user_message / assistant_message records.

import { appendFile, readdir, readFile, realpath, stat } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { join, sep } from "node:path";
import type { SessionSummary } from "./types.ts";

export const SESSIONS_ROOT = join(homedir(), ".pi", "agent", "sessions");

export function decodeCwd(encoded: string): string {
  return encoded.replace(/-/g, "/");
}

interface SessionMeta {
  id: string;
  cwd: string;
  timestamp: string;
  name?: string;
  messageCount: number;
  lastUserText?: string;
  lastMessageText?: string;
  searchText?: string;
}

/**
 * Cap for the per-session `searchText` blob sent to clients. Keeps list
 * payloads bounded (~1500 sessions x 2KB worst case = ~3MB, realistically
 * far less). Most recent user messages win when the cap is hit, since
 * those are what users remember typing.
 */
const SEARCH_TEXT_MAX = 2000;

/** Join user texts newest-first up to the cap, returned in original order. */
function buildSearchText(userTexts: string[]): string | undefined {
  if (userTexts.length === 0) return undefined;
  const kept: string[] = [];
  let total = 0;
  for (let i = userTexts.length - 1; i >= 0; i--) {
    const text = userTexts[i]!;
    if (total + text.length > SEARCH_TEXT_MAX) {
      // Include a truncated slice of the message that crosses the cap so
      // its most recent content is still searchable.
      const remaining = SEARCH_TEXT_MAX - total;
      if (remaining > 0) kept.unshift(text.slice(text.length - remaining));
      break;
    }
    kept.unshift(text);
    total += text.length;
  }
  return kept.length > 0 ? kept.join("\n") : undefined;
}

function normalizePreview(text: string): string | undefined {
  const normalized = text.replace(/\s+/g, " ").trim();
  return normalized.length > 0 ? normalized : undefined;
}

function extractPreview(value: unknown): string | undefined {
  if (typeof value === "string") {
    return normalizePreview(value);
  }

  if (Array.isArray(value)) {
    const textParts: string[] = [];
    const toolNames: string[] = [];

    for (const item of value) {
      if (!item || typeof item !== "object") continue;
      const record = item as Record<string, unknown>;
      const type = record["type"];

      if (type === "text") {
        const text = extractPreview(record["text"]);
        if (text) textParts.push(text);
        continue;
      }

      if (type === "toolCall") {
        const name = record["name"];
        if (typeof name === "string" && name.length > 0) {
          toolNames.push(name);
        }
      }
    }

    if (textParts.length > 0) {
      return normalizePreview(textParts.join(" "));
    }

    if (toolNames.length > 0) {
      return normalizePreview(`Tool call: ${toolNames.join(", ")}`);
    }

    return undefined;
  }

  if (!value || typeof value !== "object") {
    return undefined;
  }

  const record = value as Record<string, unknown>;
  return extractPreview(record["content"]) ?? extractPreview(record["text"]);
}

async function readSessionMeta(path: string): Promise<SessionMeta | null> {
  try {
    const buf = await readFile(path, "utf8");
    const lines = buf.split("\n").filter((line) => line.length > 0);
    if (lines.length === 0) return null;

    let id = "";
    let cwd = "";
    let timestamp = "";
    let name: string | undefined;
    let messageCount = 0;
    let lastUserText: string | undefined;
    let lastMessageText: string | undefined;
    const userTexts: string[] = [];

    for (const line of lines) {
      let rec: Record<string, unknown>;
      try {
        rec = JSON.parse(line);
      } catch {
        continue;
      }

      const type = rec["type"];
      if (type === "session") {
        id = String(rec["id"] ?? "");
        cwd = String(rec["cwd"] ?? "");
        timestamp = String(rec["timestamp"] ?? "");
        continue;
      }

      // `session_info` is the current pi format. Keep reading the legacy
      // `session_name` event too so old logs remain compatible. The latest
      // event wins, matching pi's own SessionManager behavior.
      if (type === "session_info" || type === "session_name") {
        const nextName = rec["name"];
        if (typeof nextName === "string") {
          name = nextName.trim() || undefined;
        }
        continue;
      }

      if (type === "message") {
        const message = rec["message"];
        if (!message || typeof message !== "object") continue;
        const msg = message as Record<string, unknown>;
        const role = msg["role"];
        if (role !== "user" && role !== "assistant") continue;

        messageCount++;
        const preview = extractPreview(msg);
        if (role === "assistant" && preview) lastMessageText = preview;
        if (role === "user" && preview) {
          lastUserText = preview;
          userTexts.push(preview);
        }
        continue;
      }

      if (type === "user_message" || type === "user") {
        messageCount++;
        const preview = extractPreview(rec);
        if (preview) {
          lastUserText = preview;
          userTexts.push(preview);
        }
        continue;
      }

      if (type === "assistant_message" || type === "assistant") {
        messageCount++;
        const preview = extractPreview(rec);
        if (preview) lastMessageText = preview;
      }
    }

    if (!id) return null;
    return {
      id, cwd, timestamp, name, messageCount, lastUserText, lastMessageText,
      searchText: buildSearchText(userTexts),
    };
  } catch {
    return null;
  }
}

/**
 * Parsed-metadata cache keyed by absolute file path. A session jsonl is
 * append-only, so (mtimeMs, size) is a reliable fingerprint: if neither
 * changed since the last scan we can reuse the parsed meta and skip the
 * readFile + per-line JSON.parse entirely. `meta: null` records files
 * that failed to parse so we don't re-read them every refresh either.
 *
 * With ~1500 sessions (~2.5 GB) this turns a ~4.6s full scan into a
 * ~50ms stat-only pass after the first request.
 */
interface MetaCacheEntry {
  mtimeMs: number;
  size: number;
  meta: SessionMeta | null;
}

const metaCache = new Map<string, MetaCacheEntry>();

/** Test hook: clear the parsed-metadata cache. */
export function clearSessionMetaCache(): void {
  metaCache.clear();
}

/** Run async tasks with bounded concurrency, preserving input order. */
async function mapLimit<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i]!);
    }
  });
  await Promise.all(workers);
  return results;
}

export async function renameDiskSession(
  sessionPath: string,
  requestedName: string,
  root: string = SESSIONS_ROOT,
): Promise<string> {
  const name = requestedName.trim();
  if (!name) throw new Error("Session name cannot be empty");

  const [resolvedRoot, resolvedSession] = await Promise.all([
    realpath(root),
    realpath(sessionPath),
  ]);
  const rootPrefix = resolvedRoot.endsWith(sep) ? resolvedRoot : resolvedRoot + sep;
  if (!resolvedSession.startsWith(rootPrefix) || !resolvedSession.endsWith(".jsonl")) {
    throw new Error("Session path is outside the sessions directory");
  }

  const contents = await readFile(resolvedSession, "utf8");
  const ids = new Set<string>();
  let hasSessionHeader = false;
  let parentId: string | null = null;

  for (const line of contents.split("\n")) {
    if (!line) continue;
    try {
      const record = JSON.parse(line) as Record<string, unknown>;
      if (record["type"] === "session" && typeof record["id"] === "string") {
        hasSessionHeader = true;
        continue;
      }
      if (typeof record["id"] === "string") {
        ids.add(record["id"]);
        parentId = record["id"];
      }
    } catch {
      // Match the scanner's tolerance of malformed historical lines. A
      // valid session header is still required before we append anything.
    }
  }
  if (!hasSessionHeader) throw new Error("Invalid pi session file");

  let id = randomUUID().slice(0, 8);
  while (ids.has(id)) id = randomUUID().slice(0, 8);
  const entry = {
    type: "session_info",
    id,
    parentId,
    timestamp: new Date().toISOString(),
    name,
  };
  const leadingNewline = contents.length > 0 && !contents.endsWith("\n") ? "\n" : "";
  await appendFile(resolvedSession, leadingNewline + JSON.stringify(entry) + "\n", "utf8");
  metaCache.delete(resolvedSession);
  return name;
}

export async function listSessions(root: string = SESSIONS_ROOT): Promise<SessionSummary[]> {
  let dirs: string[] = [];
  try {
    dirs = await readdir(root);
  } catch {
    return [];
  }

  // Collect all candidate files first so we can stat/parse them with
  // bounded parallelism instead of strictly sequentially.
  const candidates: Array<{ full: string; dir: string }> = [];
  for (const dir of dirs) {
    const cwdDir = join(root, dir);
    let files: string[] = [];
    try {
      files = await readdir(cwdDir);
    } catch {
      continue;
    }
    for (const file of files) {
      if (!file.endsWith(".jsonl")) continue;
      candidates.push({ full: join(cwdDir, file), dir });
    }
  }

  const seen = new Set<string>();
  const results = await mapLimit(candidates, 16, async ({ full, dir }): Promise<SessionSummary | null> => {
    let mtime = 0;
    let size = 0;
    try {
      const fileStat = await stat(full);
      mtime = fileStat.mtimeMs;
      size = fileStat.size;
    } catch {
      return null;
    }
    seen.add(full);

    const cached = metaCache.get(full);
    let meta: SessionMeta | null;
    if (cached && cached.mtimeMs === mtime && cached.size === size) {
      meta = cached.meta;
    } else {
      meta = await readSessionMeta(full);
      metaCache.set(full, { mtimeMs: mtime, size, meta });
    }
    if (!meta) return null;

    return {
      sessionId: meta.id,
      cwd: meta.cwd || decodeCwd(dir),
      sessionPath: full,
      name: meta.name,
      timestamp: meta.timestamp,
      mtime,
      messageCount: meta.messageCount,
      lastUserText: meta.lastUserText,
      lastMessageText: meta.lastMessageText,
      searchText: meta.searchText,
    };
  });

  // Prune cache entries for deleted files so the map can't grow unbounded.
  // Only prune entries under this root so a custom-root call (tests) can't
  // wipe the main cache.
  for (const key of metaCache.keys()) {
    if (key.startsWith(root) && !seen.has(key)) metaCache.delete(key);
  }

  const out = results.filter((r): r is SessionSummary => r !== null);
  out.sort((a, b) => b.mtime - a.mtime);
  return out;
}
