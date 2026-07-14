// Tests for listSessions() mtime-keyed metadata cache.
// Run: bun test sessions.test.ts

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtemp, mkdir, writeFile, rm, appendFile, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { listSessions, clearSessionMetaCache } from "./sessions.ts";

let root: string;

function sessionLine(id: string, cwd: string): string {
  return JSON.stringify({ type: "session", id, cwd, timestamp: "2026-07-14T00:00:00.000Z" }) + "\n";
}

function messageLine(role: "user" | "assistant", text: string): string {
  return JSON.stringify({ type: "message", message: { role, content: [{ type: "text", text }] } }) + "\n";
}

async function writeSession(dir: string, file: string, content: string): Promise<string> {
  const d = join(root, dir);
  await mkdir(d, { recursive: true });
  const full = join(d, file);
  await writeFile(full, content);
  return full;
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "pi-sessions-test-"));
  clearSessionMetaCache();
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("listSessions", () => {
  test("parses session summaries", async () => {
    await writeSession("--proj-a--", "s1.jsonl",
      sessionLine("id-1", "/proj/a") + messageLine("user", "hello") + messageLine("assistant", "world"));

    const sessions = await listSessions(root);
    expect(sessions.length).toBe(1);
    expect(sessions[0]!.sessionId).toBe("id-1");
    expect(sessions[0]!.cwd).toBe("/proj/a");
    expect(sessions[0]!.messageCount).toBe(2);
    expect(sessions[0]!.lastUserText).toBe("hello");
    expect(sessions[0]!.lastMessageText).toBe("world");
  });

  test("second call serves from cache with identical results", async () => {
    await writeSession("--proj-a--", "s1.jsonl",
      sessionLine("id-1", "/proj/a") + messageLine("user", "hi"));

    const first = await listSessions(root);
    const second = await listSessions(root);
    expect(second).toEqual(first);
  });

  test("cache invalidates when a file grows (append)", async () => {
    const full = await writeSession("--proj-a--", "s1.jsonl",
      sessionLine("id-1", "/proj/a") + messageLine("user", "hi"));

    let sessions = await listSessions(root);
    expect(sessions[0]!.messageCount).toBe(1);

    await appendFile(full, messageLine("assistant", "reply"));
    sessions = await listSessions(root);
    expect(sessions[0]!.messageCount).toBe(2);
    expect(sessions[0]!.lastMessageText).toBe("reply");
  });

  test("cache invalidates on mtime change even with same size", async () => {
    const contentA = sessionLine("id-1", "/proj/a") + messageLine("user", "aaaa");
    const contentB = sessionLine("id-1", "/proj/a") + messageLine("user", "bbbb");
    expect(contentA.length).toBe(contentB.length);

    const full = await writeSession("--proj-a--", "s1.jsonl", contentA);
    let sessions = await listSessions(root);
    expect(sessions[0]!.lastUserText).toBe("aaaa");

    await writeFile(full, contentB);
    // Force an mtime jump in case the rewrite lands within timestamp granularity.
    const future = new Date(Date.now() + 5000);
    await utimes(full, future, future);

    sessions = await listSessions(root);
    expect(sessions[0]!.lastUserText).toBe("bbbb");
  });

  test("deleted files disappear from results", async () => {
    const full = await writeSession("--proj-a--", "s1.jsonl",
      sessionLine("id-1", "/proj/a") + messageLine("user", "hi"));
    await writeSession("--proj-b--", "s2.jsonl",
      sessionLine("id-2", "/proj/b") + messageLine("user", "yo"));

    let sessions = await listSessions(root);
    expect(sessions.length).toBe(2);

    await rm(full);
    sessions = await listSessions(root);
    expect(sessions.length).toBe(1);
    expect(sessions[0]!.sessionId).toBe("id-2");
  });

  test("unparseable files are skipped and cached as null", async () => {
    await writeSession("--proj-a--", "bad.jsonl", "not json at all\n");
    await writeSession("--proj-a--", "good.jsonl",
      sessionLine("id-1", "/proj/a") + messageLine("user", "hi"));

    let sessions = await listSessions(root);
    expect(sessions.length).toBe(1);
    // Second pass hits the null-cache path.
    sessions = await listSessions(root);
    expect(sessions.length).toBe(1);
  });

  test("searchText contains all user messages, not assistant text", async () => {
    await writeSession("--proj-a--", "s1.jsonl",
      sessionLine("id-1", "/proj/a") +
      messageLine("user", "first question about swift") +
      messageLine("assistant", "assistant reply secretword") +
      messageLine("user", "second question about kotlin"));

    const sessions = await listSessions(root);
    const search = sessions[0]!.searchText!;
    expect(search).toContain("first question about swift");
    expect(search).toContain("second question about kotlin");
    expect(search).not.toContain("secretword");
  });

  test("searchText is capped, keeping the most recent user messages", async () => {
    const old = "OLDMARKER " + "x".repeat(3000);
    const recent = "RECENTMARKER hello";
    await writeSession("--proj-a--", "s1.jsonl",
      sessionLine("id-1", "/proj/a") +
      messageLine("user", old) +
      messageLine("user", recent));

    const sessions = await listSessions(root);
    const search = sessions[0]!.searchText!;
    expect(search.length).toBeLessThanOrEqual(2001); // cap + join newline
    expect(search).toContain("RECENTMARKER");
    expect(search).not.toContain("OLDMARKER");
  });

  test("searchText is undefined when there are no user messages", async () => {
    await writeSession("--proj-a--", "s1.jsonl",
      sessionLine("id-1", "/proj/a") + messageLine("assistant", "only assistant"));

    const sessions = await listSessions(root);
    expect(sessions[0]!.searchText).toBeUndefined();
  });

  test("sorted by mtime desc", async () => {
    const older = await writeSession("--proj-a--", "old.jsonl",
      sessionLine("id-old", "/proj/a") + messageLine("user", "old"));
    await writeSession("--proj-b--", "new.jsonl",
      sessionLine("id-new", "/proj/b") + messageLine("user", "new"));
    const past = new Date(Date.now() - 60_000);
    await utimes(older, past, past);

    const sessions = await listSessions(root);
    expect(sessions[0]!.sessionId).toBe("id-new");
    expect(sessions[1]!.sessionId).toBe("id-old");
  });
});
