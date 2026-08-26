// Minimal mirror of the pi RPC protocol types we need.
// Full definitions live in pi-mono/packages/coding-agent/src/modes/rpc/rpc-types.ts
// We intentionally don't import from pi-mono so the bridge stays decoupled.

export type RpcCommand =
  | { id?: string; type: "prompt"; message: string; images?: unknown[] }
  | { id?: string; type: "steer"; message: string; images?: unknown[] }
  | { id?: string; type: "follow_up"; message: string; images?: unknown[] }
  | { id?: string; type: "abort" }
  | { id?: string; type: "new_session"; parentSession?: string }
  | { id?: string; type: "get_state" }
  | { id?: string; type: "set_model"; provider: string; modelId: string }
  | { id?: string; type: "cycle_model" }
  | { id?: string; type: "get_available_models" }
  | { id?: string; type: "set_thinking_level"; level: string }
  | { id?: string; type: "compact"; customInstructions?: string }
  | { id?: string; type: "get_session_stats" }
  | { id?: string; type: "switch_session"; sessionPath: string }
  | { id?: string; type: "get_messages" }
  | { id?: string; type: "set_session_name"; name: string }
  | { id?: string; type: "get_commands" };

export interface RpcResponse {
  id?: string;
  type: "response";
  command: string;
  success: boolean;
  data?: unknown;
  error?: string;
}

export interface AgentEvent {
  type: string;
  /**
   * Monotonic per-session sequence number stamped by the bridge. Used by
   * clients to dedup replayed events and to request replay from a known
   * point on reconnect.
   */
  seq?: number;
  /**
   * UUID stamped on events belonging to a single agent turn. Clients use
   * this to reject stale message_update events that arrive after a turn
   * has ended, preventing stuck streaming spinners.
   */
  turnId?: string;
  [k: string]: unknown;
}

export interface SessionSummary {
  sessionId: string;
  cwd: string;
  sessionPath: string;
  name?: string;
  timestamp: string;
  mtime: number;
  messageCount?: number;
  lastUserText?: string;
  lastMessageText?: string;
  /**
   * Concatenated user message texts (newest-weighted, capped) so clients
   * can filter sessions by anything the user typed, not just the last
   * message. See SEARCH_TEXT_MAX in sessions.ts.
   */
  searchText?: string;
}
