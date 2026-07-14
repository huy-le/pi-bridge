// Scan ~/.pi/agent/sessions/<encoded-cwd>/*.jsonl and return session summaries.
//
// Newer pi sessions store messages as:
//   {"type":"message","message":{"role":"user|assistant","content":[...]}}
// Older sessions may still use user_message / assistant_message records.

import { readdir, readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
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

      if (type === "session_name") {
        const nextName = rec["name"];
        if (typeof nextName === "string" && nextName.length > 0) {
          name = nextName;
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
        if (role === "user" && preview) lastUserText = preview;
        continue;
      }

      if (type === "user_message" || type === "user") {
        messageCount++;
        const preview = extractPreview(rec);
        if (preview) {
          lastUserText = preview;
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
    return { id, cwd, timestamp, name, messageCount, lastUserText, lastMessageText };
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
