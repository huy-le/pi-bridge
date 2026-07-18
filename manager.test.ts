// Tests for stampEvent busy-state tracking (busySince) used by the session
// list `busy` flag. Run: bun test manager.test.ts

import { describe, test, expect } from "bun:test";
import { stampEvent, type ManagedSession } from "./manager.ts";
import type { AgentEvent } from "./types.ts";

function makeSession(): ManagedSession {
  return {
    id: "test",
    rpc: {} as any,
    cwd: "/tmp",
    lastActivity: Date.now(),
    subscribers: new Set(),
    recentEvents: [],
    nextSeq: 0,
    currentTurnId: undefined,
    keepAlive: false,
    busySince: undefined,
  };
}

function ev(type: string): AgentEvent {
  return { type } as AgentEvent;
}

describe("stampEvent busy tracking", () => {
  test("turn_start marks the session busy", () => {
    const s = makeSession();
    stampEvent(s, ev("turn_start"));
    expect(s.busySince).toBeDefined();
  });

  test("message_start without turn_start also marks busy", () => {
    const s = makeSession();
    stampEvent(s, ev("message_start"));
    expect(s.busySince).toBeDefined();
  });

  test("turn_end clears busy", () => {
    const s = makeSession();
    stampEvent(s, ev("turn_start"));
    stampEvent(s, ev("turn_end"));
    expect(s.busySince).toBeUndefined();
  });

  test("agent_end clears busy", () => {
    const s = makeSession();
    stampEvent(s, ev("turn_start"));
    stampEvent(s, ev("agent_end"));
    expect(s.busySince).toBeUndefined();
  });

  test("error clears busy", () => {
    const s = makeSession();
    stampEvent(s, ev("turn_start"));
    stampEvent(s, ev("error"));
    expect(s.busySince).toBeUndefined();
  });

  test("bridge_rpc_exit clears busy", () => {
    const s = makeSession();
    stampEvent(s, ev("turn_start"));
    stampEvent(s, ev("bridge_rpc_exit"));
    expect(s.busySince).toBeUndefined();
  });

  test("busySince is stable across mid-turn events", () => {
    const s = makeSession();
    stampEvent(s, ev("turn_start"));
    const started = s.busySince;
    stampEvent(s, ev("message_start"));
    stampEvent(s, ev("message_update"));
    stampEvent(s, ev("tool_execution_start"));
    expect(s.busySince).toBe(started!);
  });

  test("a new turn after turn_end marks busy again", () => {
    const s = makeSession();
    stampEvent(s, ev("turn_start"));
    stampEvent(s, ev("turn_end"));
    stampEvent(s, ev("turn_start"));
    expect(s.busySince).toBeDefined();
  });

  test("non-turn events do not mark an idle session busy", () => {
    const s = makeSession();
    stampEvent(s, ev("tool_execution_end"));
    expect(s.busySince).toBeUndefined();
  });
});
