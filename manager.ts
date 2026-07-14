// Manages the pool of live RpcClients keyed by iOS-facing sessionId.
//
// sessionId scheme:
//   - "new:<timestamp>"  — client just created, no underlying jsonl yet
//   - "<pi-session-uuid>" — resumed from an existing jsonl file
//
// We treat these handles as the authoritative id inside the bridge.
// When multiple iPhones connect to the same handle, they receive the same
// event stream (fanout).

import { randomUUID } from "node:crypto";
import { PiRpc } from "./rpc.ts";
import type { AgentEvent } from "./types.ts";

export interface ManagedSession {
  id: string;
  rpc: PiRpc;
  cwd: string;
  sessionPath?: string;
  /** The underlying pi session UUID (from get_state). Durable identity the
   *  iOS client uses to key its local transcript cache. Unlike `sessionPath`
   *  this is populated for sessions created new, not only resumed ones. */
  piSessionId?: string;
  name?: string;
  lastActivity: number;
  subscribers: Set<(e: AgentEvent) => void>;
  recentEvents: AgentEvent[]; // small ring buffer for late subscribers
  /** Monotonic counter stamped onto every outgoing event as `seq`. */
  nextSeq: number;
  /** Current turn's UUID. Set on turn_start/message_start, cleared on
   *  turn_end/agent_end. Stamped onto turn-scoped events as `turnId`. */
  currentTurnId?: string;
  /** When true, the idle reaper will not tear this session down regardless
   *  of how long it has been since `lastActivity`. Toggled per-session by
   *  the iOS client via `POST /sessions/:id/keep-alive`. */
  keepAlive: boolean;
}

export interface CreateOptions {
  cwd: string;
  model?: string;
  provider?: string;
  resumeSessionPath?: string;
}

const IDLE_TIMEOUT_MS = 30 * 60 * 1000; // 30 min
const EVENT_BUFFER = 500;

/**
 * Events that open a new turn. First occurrence mints a fresh turnId.
 */
const TURN_OPEN_TYPES = new Set(["turn_start"]);

/**
 * Events that close the current turn. The terminal event itself still
 * carries the old turnId; the turnId is cleared immediately after.
 */
const TURN_CLOSE_TYPES = new Set(["turn_end", "agent_end"]);

/**
 * Events that belong to a turn and should carry turnId if one is active.
 * Clients can use this to reject stale cross-turn events.
 */
const TURN_SCOPED_TYPES = new Set([
  "turn_start",
  "turn_end",
  "message_start",
  "message_update",
  "message_end",
  "tool_execution_start",
  "tool_execution_end",
  "agent_end",
  "compaction_start",
  "compaction_end",
]);

/**
 * Stamp an incoming raw event with a monotonic seq and (when applicable)
 * the current turnId. Mutates session turn state on turn_start/_end.
 */
function stampEvent(session: ManagedSession, e: AgentEvent): AgentEvent {
  // Open a turn on turn_start, or lazily on first message_start if the
  // agent didn't emit an explicit turn_start.
  if (TURN_OPEN_TYPES.has(e.type) && !session.currentTurnId) {
    session.currentTurnId = randomUUID();
  } else if (e.type === "message_start" && !session.currentTurnId) {
    session.currentTurnId = randomUUID();
  }

  const stamped: AgentEvent = { ...e, seq: ++session.nextSeq };
  if (session.currentTurnId && TURN_SCOPED_TYPES.has(e.type)) {
    stamped.turnId = session.currentTurnId;
  }

  // Close the turn AFTER stamping so the closing event itself carries
  // the outgoing turnId. The next turn-scoped event will mint a new id.
  if (TURN_CLOSE_TYPES.has(e.type)) {
    session.currentTurnId = undefined;
  }
  return stamped;
}

export class SessionManager {
  private sessions = new Map<string, ManagedSession>();
  /** Listeners that receive every fanout event from every session. Used
   *  by the bridge to fire APNs pushes on `agent_end` regardless of
   *  whether any iOS clients have an active WebSocket. */
  private globalListeners = new Set<(e: AgentEvent, session: ManagedSession) => void>();

  constructor(private cliPath: string) {
    setInterval(() => this.reapIdle(), 60_000);
  }

  /**
   * Register a callback that fires for every event from every session.
   * Listeners run after per-session subscribers and exceptions are
   * swallowed so a slow listener can't break event delivery.
   */
  addGlobalListener(fn: (e: AgentEvent, session: ManagedSession) => void): () => void {
    this.globalListeners.add(fn);
    return () => this.globalListeners.delete(fn);
  }

  list(): Array<{
    id: string;
    cwd: string;
    name?: string;
    sessionPath?: string;
    piSessionId?: string;
    lastActivity: number;
    subscribers: number;
    alive: boolean;
    keepAlive: boolean;
  }> {
    return [...this.sessions.values()].map((s) => ({
      id: s.id,
      cwd: s.cwd,
      name: s.name,
      sessionPath: s.sessionPath,
      piSessionId: s.piSessionId,
      lastActivity: s.lastActivity,
      subscribers: s.subscribers.size,
      alive: s.rpc.isAlive,
      keepAlive: s.keepAlive,
    }));
  }

  /**
   * Toggle the per-session keep-alive flag. When enabled, `reapIdle` will
   * skip this session even if it has been idle past IDLE_TIMEOUT_MS. Returns
   * true if the session exists and was updated.
   */
  setKeepAlive(id: string, enabled: boolean): boolean {
    const s = this.sessions.get(id);
    if (!s) return false;
    s.keepAlive = enabled;
    console.log(`[manager] setKeepAlive id=${id} enabled=${enabled}`);
    return true;
  }

  get(id: string): ManagedSession | undefined {
    return this.sessions.get(id);
  }

  async create(opts: CreateOptions): Promise<ManagedSession> {
    // Test-container override: when PI_FORCE_PROVIDER / PI_FORCE_MODEL are
    // set in the environment (see server/.env.test), ignore client-supplied
    // provider/model and lock pi to the configured pair. This keeps the
    // sandbox bridge cheap and predictable for App Store / TestFlight tests.
    const forceProvider = process.env.PI_FORCE_PROVIDER?.trim() || undefined;
    const forceModel = process.env.PI_FORCE_MODEL?.trim() || undefined;
    const provider = forceProvider ?? opts.provider;
    const model = forceModel ?? opts.model;
    if (forceProvider || forceModel) {
      console.log(`[manager] forcing provider=${forceProvider ?? "(unchanged)"} model=${forceModel ?? "(unchanged)"} (client requested provider=${opts.provider ?? "-"} model=${opts.model ?? "-"})`);
    }
    console.log(`[manager] create session cwd=${opts.cwd} model=${model ?? "(default)"} provider=${provider ?? "(default)"} resume=${opts.resumeSessionPath ?? "no"}`);
    const rpc = new PiRpc({
      cli: this.cliPath,
      cwd: opts.cwd,
      args: [
        ...(provider ? ["--provider", provider] : []),
        ...(model ? ["--model", model] : []),
      ],
    });

    const id = randomUUID();
    const session: ManagedSession = {
      id,
      rpc,
      cwd: opts.cwd,
      sessionPath: opts.resumeSessionPath,
      lastActivity: Date.now(),
      subscribers: new Set(),
      recentEvents: [],
      nextSeq: 0,
      currentTurnId: undefined,
      keepAlive: false,
    };

    const fanout = (raw: AgentEvent) => {
      const stamped = stampEvent(session, raw);
      session.recentEvents.push(stamped);
      if (session.recentEvents.length > EVENT_BUFFER) {
        session.recentEvents.shift();
      }
      for (const sub of session.subscribers) {
        try {
          sub(stamped);
        } catch {}
      }
      for (const listener of this.globalListeners) {
        try {
          listener(stamped, session);
        } catch (err: any) {
          console.error("[manager] global listener error:", err?.message ?? err);
        }
      }
    };

    rpc.onClose = (code) => {
      // Log stderr so we can debug crashes even without a WS subscriber
      console.error(`[manager] rpc for session ${id} exited with code ${code}`);
      if (rpc.stderrTail) {
        console.error(`[manager] stderr tail:\n${rpc.stderrTail}`);
      }
      // Fan out a synthetic exit event through the same stamping path so
      // late subscribers can replay it from the ring buffer.
      fanout({ type: "bridge_rpc_exit", stderr: rpc.stderrTail });
      this.sessions.delete(id);
    };

    rpc.onEvent((e) => {
      session.lastActivity = Date.now();
      fanout(e);
    });

    await rpc.start();
    console.log(`[manager] pi rpc spawned for session ${id} pid=${(rpc as any).proc?.pid}`);

    if (opts.resumeSessionPath) {
      const resp = await rpc.send({ type: "switch_session", sessionPath: opts.resumeSessionPath });
      if (!resp.success) {
        rpc.stop();
        throw new Error(`switch_session failed: ${resp.error ?? "unknown"}`);
      }
    }

    this.sessions.set(id, session);
    return session;
  }

  async destroy(id: string): Promise<void> {
    const s = this.sessions.get(id);
    if (!s) return;
    this.sessions.delete(id);
    await s.rpc.stop();
  }

  private reapIdle() {
    const now = Date.now();
    for (const s of this.sessions.values()) {
      if (s.subscribers.size > 0) continue;
      if (s.keepAlive) continue;
      if (now - s.lastActivity > IDLE_TIMEOUT_MS) {
        this.destroy(s.id).catch(() => {});
      }
    }
  }
}
