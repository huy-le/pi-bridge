#!/usr/bin/env bash
# Convenience launcher for the pi-bridge server.
# - Reads token from ~/.config/pi-bridge/token (creates one if missing)
# - Picks PI_CLI from the first available of: $PI_CLI, pi, pi-test.sh in ~/Documents/Projects/OSS/pi-mono
# - Lets you override the Pi session directory with PI_SESSIONS_ROOT (for example ~/.omp/agent/sessions)
set -euo pipefail

here="$(cd "$(dirname "$0")" && pwd)"
cd "$here"

token_dir="${XDG_CONFIG_HOME:-$HOME/.config}/pi-bridge"
token_file="$token_dir/token"
mkdir -p "$token_dir"
if [[ ! -f "$token_file" ]]; then
  openssl rand -hex 16 >"$token_file"
  chmod 600 "$token_file"
  echo "Generated token at $token_file"
fi

export PI_BRIDGE_TOKEN="$(cat "$token_file")"

# Optional APNs config: source ~/.config/pi-bridge/apns.env if present so
# the bridge can fire push notifications on agent_end. The file should
# export APNS_KEY_PATH, APNS_KEY_ID, APNS_TEAM_ID, APNS_BUNDLE_ID,
# APNS_ENV. Without it, push is a silent no-op.
apns_env="$token_dir/apns.env"
if [[ -f "$apns_env" ]]; then
  set -a
  # shellcheck disable=SC1090
  source "$apns_env"
  set +a
fi

if [[ -z "${PI_CLI:-}" ]]; then
  if command -v pi >/dev/null 2>&1; then
    export PI_CLI="$(command -v pi)"
  else
    echo "No pi CLI found. Set PI_CLI=/path/to/pi" >&2
    exit 1
  fi
fi

echo "Token : $PI_BRIDGE_TOKEN"
echo "PI_CLI: $PI_CLI"
echo "Sessions: ${PI_SESSIONS_ROOT:-~/.pi/agent/sessions}"
echo "Port  : ${PI_BRIDGE_PORT:-7171}"
echo

bun install --silent >/dev/null 2>&1 || true
exec bun run index.ts
