// pi-bridge entry point.
//
// Env vars:
//   PI_BRIDGE_TOKEN  - bearer token required on all requests (required)
//   PI_CLI           - path to pi launcher (default: "pi")
//   PI_BRIDGE_PORT   - port to bind (default: 7171)
//   PI_BRIDGE_HOST   - host to bind (default: "0.0.0.0")

import { listSessions } from "./sessions.ts";
import { SessionManager } from "./manager.ts";
import { APNs } from "./apns.ts";
import type { AgentEvent } from "./types.ts";

const TOKEN = process.env.PI_BRIDGE_TOKEN;
if (!TOKEN) {
  console.error("PI_BRIDGE_TOKEN must be set");
  process.exit(1);
}
const CLI = process.env.PI_CLI ?? "pi";
const PORT = Number(process.env.PI_BRIDGE_PORT ?? 7171);
const HOST = process.env.PI_BRIDGE_HOST ?? "0.0.0.0";

const manager = new SessionManager(CLI);
const apns = APNs.fromEnv();

/**
 * Per-session set of APNs device tokens. iOS clients register via
 * POST /sessions/:id/notifications/subscribe and we keep them in memory
 * for the bridge's lifetime. On `agent_end` we push every token in the
 * session's bucket. Tokens that come back as `BadDeviceToken` /
 * `Unregistered` are pruned.
 */
const pushSubscriptions = new Map<string, Set<string>>();

/**
 * Per-device foreground state, updated by iOS via
 * `POST /devices/:token/active`. We default to `true` (foreground) so
 * the bridge does NOT spam pushes to a device that hasn't reported its
 * phase yet, e.g. immediately after a bridge restart.
 */
const deviceActive = new Map<string, boolean>();

/**
 * Per-device pointer to the session id the user is currently looking
 * at, updated by iOS via `POST /devices/:token/viewing`. Combined with
 * `deviceActive`, the push filter only suppresses notifications when
 * the user is actively in that exact session in the foreground.
 */
const deviceViewing = new Map<string, string | null>();

function isDeviceForegrounded(deviceToken: string): boolean {
  return deviceActive.get(deviceToken) ?? true;
}

function setDeviceActive(deviceToken: string, active: boolean): void {
  deviceActive.set(deviceToken, active);
  console.log(`[push] device ${deviceToken.slice(0, 8)}… active=${active}`);
}

function setDeviceViewing(deviceToken: string, sessionId: string | null): void {
  deviceViewing.set(deviceToken, sessionId);
  console.log(`[push] device ${deviceToken.slice(0, 8)}… viewing=${sessionId ?? "(none)"}`);
}

function subscribePush(sessionId: string, deviceToken: string): void {
  let set = pushSubscriptions.get(sessionId);
  if (!set) {
    set = new Set();
    pushSubscriptions.set(sessionId, set);
  }
  set.add(deviceToken);
  console.log(`[push] subscribed session=${sessionId} token=${deviceToken.slice(0, 8)}… count=${set.size}`);
}

function unsubscribePush(sessionId: string, deviceToken: string): void {
  const set = pushSubscriptions.get(sessionId);
  if (!set) return;
  set.delete(deviceToken);
  if (set.size === 0) pushSubscriptions.delete(sessionId);
  console.log(`[push] unsubscribed session=${sessionId} token=${deviceToken.slice(0, 8)}…`);
}

if (apns) {
  manager.addGlobalListener((event, session) => {
    if (event.type !== "agent_end") return;
    const tokens = pushSubscriptions.get(session.id);
    if (!tokens || tokens.size === 0) return;
    // Only suppress pushes when the user is foregrounded AND looking
    // at THIS exact session. If they're in another chat, on the
    // session list, or backgrounded, we still want a banner so they
    // know this session finished.
    const targets = [...tokens].filter((token) => {
      const active = isDeviceForegrounded(token);
      const viewing = deviceViewing.get(token) ?? null;
      return !(active && viewing === session.id);
    });
    if (targets.length === 0) {
      console.log(`[push] all ${tokens.size} subscribers are viewing session=${session.id}, skipping`);
      return;
    }
    const title = session.name ?? "pi reply";
    const body = extractAssistantTail(event) ?? "Reply ready";
    apns.sendMany(targets, {
      title,
      body,
      // Both ids let the iOS deep-link try the live session first and
      // fall back to opening the on-disk jsonl if the bridge has been
      // restarted in the meantime.
      custom: {
        sessionId: session.id,
        sessionPath: session.sessionPath ?? null,
      },
    }).then((results) => {
      for (const { token, result } of results) {
        if (!result.ok && (result.reason === "BadDeviceToken" || result.reason === "Unregistered")) {
          tokens.delete(token);
          console.log(`[push] pruned stale token session=${session.id} reason=${result.reason}`);
        }
      }
    }).catch((err) => {
      console.error("[push] sendMany failed:", err?.message ?? err);
    });
  });
}

/**
 * Best-effort extraction of the final assistant text from an `agent_end`
 * event so the push body shows the reply preview. Falls back to a
 * generic message when no text is found (e.g. tool-only turn).
 */
function extractAssistantTail(event: AgentEvent): string | undefined {
  const messages = (event as any).messages;
  if (!Array.isArray(messages)) return undefined;
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (!m || m.role !== "assistant") continue;
    const content = m.content;
    if (typeof content === "string" && content.trim()) return content.trim().slice(0, 240);
    if (Array.isArray(content)) {
      for (let j = content.length - 1; j >= 0; j--) {
        const part = content[j];
        if (part && part.type === "text" && typeof part.text === "string" && part.text.trim()) {
          return part.text.trim().slice(0, 240);
        }
      }
    }
  }
  return undefined;
}

function unauthorized(): Response {
  return new Response(JSON.stringify({ error: "unauthorized" }), {
    status: 401,
    headers: { "content-type": "application/json" },
  });
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function checkAuth(req: Request, url: URL): boolean {
  const header = req.headers.get("authorization");
  if (header === `Bearer ${TOKEN}`) return true;
  // WebSocket upgrade can't easily set headers in JS on iOS; allow ?token= too.
  const q = url.searchParams.get("token");
  if (q && q === TOKEN) return true;
  return false;
}

interface WsData {
  sessionId: string;
  sinceSeq?: number;
  unsubscribe: () => void;
}

const server = Bun.serve<WsData>({
  hostname: HOST,
  port: PORT,
  idleTimeout: 255,
  async fetch(req, srv) {
    const url = new URL(req.url);
    const reqId = Math.random().toString(36).slice(2, 8);
    console.log(`[http #${reqId}] ${req.method} ${url.pathname}${url.search}`);

    // Public: health check (lets the iOS Settings screen verify reachability
    // before a token is entered).
    if (url.pathname === "/health") {
      return json({ ok: true, cli: CLI, sessions: manager.list().length });
    }

    if (!checkAuth(req, url)) {
      console.log(`[http #${reqId}] 401 unauthorized`);
      return unauthorized();
    }

    // WebSocket upgrade: /sessions/:id/events?sinceSeq=N
    const wsMatch = url.pathname.match(/^\/sessions\/([^/]+)\/events$/);
    if (wsMatch && req.headers.get("upgrade")?.toLowerCase() === "websocket") {
      const sessionId = wsMatch[1]!;
      const session = manager.get(sessionId);
      if (!session) return json({ error: "session not found" }, 404);
      const sinceSeqRaw = url.searchParams.get("sinceSeq");
      const sinceSeq = sinceSeqRaw !== null ? Number.parseInt(sinceSeqRaw, 10) : undefined;
      const upgraded = srv.upgrade(req, {
        data: {
          sessionId,
          sinceSeq: Number.isFinite(sinceSeq as number) ? (sinceSeq as number) : undefined,
          unsubscribe: () => {},
        },
      });
      if (upgraded) return undefined as unknown as Response;
      return json({ error: "websocket upgrade failed" }, 500);
    }

    try {
      const res = await route(req, url);
      console.log(`[http #${reqId}] -> ${res.status}`);
      return res;
    } catch (err: any) {
      console.error(`[http #${reqId}] route error:`, err?.message ?? err);
      return json({ error: String(err?.message ?? err) }, 500);
    }
  },
  websocket: {
    open(ws) {
      const session = manager.get(ws.data.sessionId);
      if (!session) {
        ws.close(1011, "session not found");
        return;
      }
      // Replay events from the ring buffer. If the client passed
      // `?sinceSeq=N`, only replay newer events. If the buffer no longer
      // contains events at or just past N (ring overflowed), emit a
      // `resync_required` sentinel so the client can do a full reload
      // rather than stitch from an incomplete event stream.
      const sinceSeq = ws.data.sinceSeq;
      const buffer = session.recentEvents;
      const oldestSeq = buffer.length > 0 ? (buffer[0] as AgentEvent).seq ?? 0 : 0;
      if (sinceSeq !== undefined && buffer.length > 0 && oldestSeq > sinceSeq + 1) {
        try {
          ws.send(JSON.stringify({
            type: "resync_required",
            sinceSeq,
            oldestSeq,
            reason: "ring buffer gap",
          }));
        } catch {}
      }
      for (const e of buffer) {
        if (sinceSeq !== undefined && (e.seq ?? 0) <= sinceSeq) continue;
        ws.send(JSON.stringify(e));
      }
      const fn = (e: AgentEvent) => {
        try {
          ws.send(JSON.stringify(e));
        } catch {}
      };
      session.subscribers.add(fn);
      ws.data.unsubscribe = () => session.subscribers.delete(fn);
    },
    message(ws, msg) {
      // Currently no inbound WS messages; prompts go via HTTP POST.
      // Echo a heartbeat if client pings.
      if (typeof msg === "string" && msg === "ping") {
        ws.send("pong");
      }
    },
    close(ws) {
      ws.data.unsubscribe?.();
    },
  },
});

console.log(`pi-bridge listening on http://${HOST}:${PORT}`);
console.log(`  PI_CLI=${CLI}`);
console.log(`  auth: Bearer ${TOKEN.slice(0, 4)}…${TOKEN.slice(-4)}`);

async function route(req: Request, url: URL): Promise<Response> {
  const path = url.pathname;
  const method = req.method;

  if (path === "/health") {
    return json({ ok: true, cli: CLI, sessions: manager.list().length });
  }

  // Sessions
  if (path === "/sessions" && method === "GET") {
    const onDisk = await listSessions();
    const live = manager.list();
    return json({ onDisk, live });
  }

  // Devices: per-device foreground/background state used to gate APNs
  // pushes. The token in the URL is the APNs device token; we don't
  // expose any per-device GET endpoint because we don't keep history.
  const devActiveMatch = path.match(/^\/devices\/([^/]+)\/active$/);
  if (devActiveMatch && method === "POST") {
    const deviceToken = devActiveMatch[1]!;
    const body = await req.json().catch(() => ({}));
    setDeviceActive(deviceToken, Boolean(body.active));
    return json({ ok: true, active: Boolean(body.active) });
  }

  const devViewingMatch = path.match(/^\/devices\/([^/]+)\/viewing$/);
  if (devViewingMatch && method === "POST") {
    const deviceToken = devViewingMatch[1]!;
    const body = await req.json().catch(() => ({}));
    const sessionId = typeof body.sessionId === "string" && body.sessionId.length > 0
      ? body.sessionId
      : null;
    setDeviceViewing(deviceToken, sessionId);
    return json({ ok: true, sessionId });
  }

  if (path === "/sessions" && method === "POST") {
    const body = await req.json().catch(() => ({}));
    const cwd = String(body.cwd ?? process.cwd());
    const model = body.model ? String(body.model) : undefined;
    const provider = body.provider ? String(body.provider) : undefined;
    const resumeSessionPath = body.resumeSessionPath ? String(body.resumeSessionPath) : undefined;
    const s = await manager.create({ cwd, model, provider, resumeSessionPath });
    // Fetch initial state so the client has something to render.
    let state: unknown = null;
    try {
      const r = await s.rpc.send({ type: "get_state" });
      if (r.success) {
        state = r.data;
        const data = r.data as { sessionId?: unknown; sessionFile?: unknown } | undefined;
        if (typeof data?.sessionId === "string" && data.sessionId) s.piSessionId = data.sessionId;
        // pi reports the on-disk jsonl path even for brand-new sessions.
        // Cache it so the client gets sessionPath without scanning the
        // whole sessions dir (used for resume-after-bridge-restart).
        if (!s.sessionPath && typeof data?.sessionFile === "string" && data.sessionFile) {
          s.sessionPath = data.sessionFile;
        }
      }
    } catch {}
    return json({ id: s.id, cwd: s.cwd, state, keepAlive: s.keepAlive, sessionPath: s.sessionPath ?? null });
  }

  const m = path.match(/^\/sessions\/([^/]+)(?:\/(.*))?$/);
  if (m) {
    const id = m[1]!;
    const sub = m[2];
    const session = manager.get(id);
    if (!session) return json({ error: "session not found" }, 404);

    if (!sub && method === "DELETE") {
      await manager.destroy(id);
      return json({ ok: true });
    }

    if (sub === "messages" && method === "GET") {
      const r = await session.rpc.send({ type: "get_messages" });
      // Inject latestSeq so the client can fast-forward its lastSeenSeq
      // before opening the WS, preventing the ring buffer replay from
      // appending duplicates of messages already in this snapshot.
      const latestSeq = session.nextSeq;
      if (r && typeof r === "object" && r.success && r.data && typeof r.data === "object") {
        (r.data as Record<string, unknown>).latestSeq = latestSeq;
      }
      return json(r);
    }

    if (sub === "state" && method === "GET") {
      const r = await session.rpc.send({ type: "get_state" });
      // Keep the cached pi session UUID + on-disk path fresh so the live
      // list can hand them to the iOS client for instant transcript-cache
      // hydration and resume-after-restart without a full disk scan.
      const data = r?.data as { sessionId?: unknown; sessionFile?: unknown } | undefined;
      if (typeof data?.sessionId === "string" && data.sessionId) session.piSessionId = data.sessionId;
      if (!session.sessionPath && typeof data?.sessionFile === "string" && data.sessionFile) {
        session.sessionPath = data.sessionFile;
      }
      return json(r);
    }

    if (sub === "stats" && method === "GET") {
      const r = await session.rpc.send({ type: "get_session_stats" });
      return json(r);
    }

    if (sub === "models" && method === "GET") {
      const r = await session.rpc.send({ type: "get_available_models" });
      // Test-container override: when PI_FORCE_PROVIDER / PI_FORCE_MODEL
      // are set, hide every other model from the iOS client so the picker
      // only shows the configured pair. The bridge already locks the
      // spawn args; this just keeps the UI honest.
      const fp = process.env.PI_FORCE_PROVIDER?.trim();
      const fm = process.env.PI_FORCE_MODEL?.trim();
      if ((fp || fm) && r && typeof r === "object" && r.success && r.data && typeof r.data === "object") {
        const data = r.data as { models?: Array<{ id?: string; provider?: string }> };
        if (Array.isArray(data.models)) {
          const before = data.models.length;
          data.models = data.models.filter((m) =>
            (!fp || m.provider === fp) && (!fm || m.id === fm),
          );
          console.log(`[forced-models] filtered ${before} -> ${data.models.length} (provider=${fp ?? "*"} model=${fm ?? "*"})`);
        }
      }
      return json(r);
    }

    if (sub === "prompt" && method === "POST") {
      const body = await req.json().catch(() => ({}));
      const message = String(body.message ?? "");
      const images = sanitizeImages(body.images);
      if (!message && images.length === 0) return json({ error: "message or images required" }, 400);
      const r = await session.rpc.send({ type: "prompt", message, images });
      return json(r);
    }

    if (sub === "steer" && method === "POST") {
      const body = await req.json().catch(() => ({}));
      const images = sanitizeImages(body.images);
      const r = await session.rpc.send({ type: "steer", message: String(body.message ?? ""), images });
      return json(r);
    }

    if (sub === "follow_up" && method === "POST") {
      const body = await req.json().catch(() => ({}));
      const images = sanitizeImages(body.images);
      const r = await session.rpc.send({ type: "follow_up", message: String(body.message ?? ""), images });
      return json(r);
    }

    if (sub === "abort" && method === "POST") {
      const r = await session.rpc.send({ type: "abort" });
      return json(r);
    }

    if (sub === "model" && method === "POST") {
      const body = await req.json().catch(() => ({}));
      const fp = process.env.PI_FORCE_PROVIDER?.trim();
      const fm = process.env.PI_FORCE_MODEL?.trim();
      // Test-container override: refuse model switches that don't match
      // the locked provider/model. We don't silently rewrite the call
      // because that would let the client think the switch succeeded.
      if ((fp || fm)) {
        const reqProvider = String(body.provider ?? "");
        const reqModel = String(body.modelId ?? "");
        const ok = (!fp || reqProvider === fp) && (!fm || reqModel === fm);
        if (!ok) {
          console.log(`[forced-models] reject set_model provider=${reqProvider} modelId=${reqModel} (locked to ${fp ?? "*"}/${fm ?? "*"})`);
          return json({
            success: false,
            error: `model is locked to ${fp ?? "*"}/${fm ?? "*"} on this bridge`,
            locked: { provider: fp, modelId: fm },
          }, 403);
        }
      }
      const r = await session.rpc.send({
        type: "set_model",
        provider: String(body.provider),
        modelId: String(body.modelId),
      });
      return json(r);
    }

    if (sub === "thinking" && method === "POST") {
      const body = await req.json().catch(() => ({}));
      const level = String(body.level ?? "").trim().toLowerCase();
      const allowed = ["off", "minimal", "low", "medium", "high", "xhigh"];
      if (!allowed.includes(level)) {
        return json({ error: `level must be one of ${allowed.join(", ")}` }, 400);
      }
      const r = await session.rpc.send({ type: "set_thinking_level", level });
      return json(r);
    }

    if (sub === "compact" && method === "POST") {
      const body = await req.json().catch(() => ({}));
      const customInstructions = body.customInstructions ? String(body.customInstructions) : undefined;
      const r = await session.rpc.send({ type: "compact", customInstructions });
      return json(r);
    }

    if (sub === "keep-alive" && method === "POST") {
      const body = await req.json().catch(() => ({}));
      const enabled = Boolean(body.enabled);
      const ok = manager.setKeepAlive(id, enabled);
      if (!ok) return json({ error: "session not found" }, 404);
      return json({ ok: true, keepAlive: enabled });
    }

    if (sub === "notifications/subscribe" && method === "POST") {
      const body = await req.json().catch(() => ({}));
      const deviceToken = String(body.deviceToken ?? "").trim();
      if (!deviceToken) return json({ error: "deviceToken required" }, 400);
      subscribePush(id, deviceToken);
      return json({ ok: true, apnsConfigured: !!apns });
    }

    if (sub === "notifications/subscribe" && method === "DELETE") {
      const body = await req.json().catch(() => ({}));
      const deviceToken = String(body.deviceToken ?? "").trim();
      if (!deviceToken) return json({ error: "deviceToken required" }, 400);
      unsubscribePush(id, deviceToken);
      return json({ ok: true });
    }

    if (sub === "name" && method === "POST") {
      const body = await req.json().catch(() => ({}));
      const r = await session.rpc.send({ type: "set_session_name", name: String(body.name ?? "") });
      return json(r);
    }
  }

  return json({ error: "not found", path }, 404);
}

/**
 * Coerce client-supplied image attachments into the shape pi-ai expects:
 * `{ type: "image", data: base64, mimeType: string }`. Drops anything
 * that doesn't have both `data` and `mimeType`. Accepts either the full
 * shape or the bare `{ data, mimeType }` form so the iOS client can stay
 * simple.
 */
function sanitizeImages(input: unknown): Array<{ type: "image"; data: string; mimeType: string }> {
  if (!Array.isArray(input)) return [];
  const out: Array<{ type: "image"; data: string; mimeType: string }> = [];
  for (const raw of input) {
    if (!raw || typeof raw !== "object") continue;
    const r = raw as Record<string, unknown>;
    const data = typeof r.data === "string" ? r.data : undefined;
    const mimeType = typeof r.mimeType === "string" ? r.mimeType
      : typeof r.media_type === "string" ? r.media_type
      : undefined;
    if (!data || !mimeType) continue;
    out.push({ type: "image", data, mimeType });
  }
  return out;
}
