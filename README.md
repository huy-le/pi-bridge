# Pi Bridge for Pi in Pocket

**Open source bridge server for [Pi in Pocket](https://apps.apple.com/us/app/pi-in-pocket-agent-viewer/id6766181905), the iOS app for remotely controlling [Pi](https://pi.dev/) running on your computer.**

[Pi in Pocket landing page](https://pi-ios.huddee.com) · [Download on the App Store](https://apps.apple.com/us/app/pi-in-pocket-agent-viewer/id6766181905) · [Learn about Pi](https://pi.dev/) · [Set up Tailscale](https://tailscale.com/)

Pi Bridge lets your iPhone talk to your local Pi agent through a self-hosted server. Run the bridge on the same computer where you use Pi, then connect to it from Pi in Pocket over a private network such as [Tailscale](https://tailscale.com/) or a secure tunnel such as Cloudflare Tunnel.

```
Pi in Pocket iOS app  ->  Pi Bridge  ->  Pi running on your computer
```

Pi Bridge does not require an account with this project. You host it yourself and connect directly from your own phone.

## What is Pi Bridge?

Pi Bridge is a small self-hosted server that connects the Pi in Pocket iOS app to the Pi agent running on your machine.

Pi itself runs locally on your computer. iOS apps cannot directly spawn or control that local CLI process, so Pi Bridge acts as the missing link between your phone and your local Pi setup.

It can:

- Start and manage `pi --mode rpc` sessions
- Expose a local HTTP and WebSocket API for Pi in Pocket
- Stream Pi events back to the iOS app in real time
- Send prompts, steering messages, follow-ups, aborts, model changes, and other commands
- Rename live or on-disk sessions with titles persisted in Pi's session logs
- Resume existing Pi sessions from disk

## Who is this for?

This is for people who use [Pi](https://pi.dev/) on their computer and want to control or monitor it from their iPhone using [Pi in Pocket](https://apps.apple.com/us/app/pi-in-pocket-agent-viewer/id6766181905).

Typical use cases:

- Start a Pi session from your desk, continue from your phone
- Check long-running agent work while away from your computer
- Send follow-up instructions remotely
- Use your own machine, your own Pi setup, and your own network

## Privacy

**No analytics. No tracking.**

Pi Bridge and the Pi in Pocket iOS app do not collect any data.

## How it works

Pi Bridge runs beside Pi on your computer.

```
┌──────────────────────┐
│ Pi in Pocket iOS app │
└──────────┬───────────┘
           │ HTTP + WebSocket
           ▼
┌──────────────────────┐
│      Pi Bridge       │
│  self-hosted server  │
└──────────┬───────────┘
           │ stdin/stdout JSON RPC
           ▼
┌──────────────────────┐
│   pi --mode rpc      │
│ running locally      │
└──────────────────────┘
```

The iOS app talks to Pi Bridge. Pi Bridge talks to `pi --mode rpc`.

## What you need

- A computer running Pi
- [Pi](https://pi.dev/) installed and available as a CLI command
- [Bun](https://bun.sh) installed
- Pi in Pocket installed on your iPhone
- A private or authenticated way for your iPhone to reach your computer, recommended: Tailscale

## Quick start

```bash
# 1. Clone and enter the directory
git clone https://github.com/huy-le/pi-bridge.git
cd pi-bridge

# 2. Install dependencies
bun install

# 3. Start the server. This auto-generates a token on first run.
./run.sh
```

`run.sh` stores a token at:

```bash
~/.config/pi-bridge/token
```

It starts the bridge on port `7171` by default.

When the server starts, it prints:

- The bridge token
- The Pi CLI path
- The port

Use those values in Pi in Pocket to connect your iPhone to your computer.

## Connect Pi in Pocket

1. Start Pi Bridge on your computer:

   ```bash
   ./run.sh
   ```

2. Copy the bridge URL and token.

   The local URL is usually:

   ```text
   http://YOUR_COMPUTER_IP:7171
   ```

   If you use Tailscale, use your computer's Tailscale IP or MagicDNS name.

3. Make sure your iPhone can reach your computer:

   - Same Wi-Fi network, or
   - Tailscale on both devices, or
   - Cloudflare Tunnel or another authenticated tunnel

4. Open Pi in Pocket on your iPhone.

5. Enter:

   - Bridge URL
   - Bridge token

6. Tap connect.

## How to expose it securely

Pi Bridge is designed to be self-hosted. You should run it on the computer where Pi is installed.

For remote access from your iPhone, use a private or authenticated network layer.

> [!WARNING]
> Do not expose Pi Bridge directly to the public internet without a secure access layer.
> It can control a Pi agent running on your computer.
> Use Tailscale, Cloudflare Access, Cloudflare Tunnel, or another private/authenticated network layer.

Recommended options:

### Option 1: Tailscale

Use [Tailscale](https://tailscale.com/) to put your computer and iPhone on the same private network.

This is the simplest recommended setup for most users.

### Option 2: Cloudflare Tunnel

Use Cloudflare Tunnel if you want an HTTPS endpoint without directly opening a port on your home network.

For stronger protection, combine it with Cloudflare Access or another authentication layer.

### Not recommended

Do not expose Pi Bridge directly to the public internet without a secure access layer.

The bridge uses bearer-token auth, but it should still be treated as a private service because it can control a Pi agent running on your computer.

## Project status

This project is an independent open source bridge server for Pi in Pocket users. It is designed to work with [Pi](https://pi.dev/). It is not an official Pi.dev project unless stated otherwise.

## Relationship to Pi in Pocket

Pi Bridge is open source under the MIT License.

Pi in Pocket is a separate iOS app available on the App Store. The app may be distributed under separate commercial terms. The MIT license for this server does not apply to the iOS app, its branding, screenshots, icons, or App Store distribution.

## Requirements

- [Bun](https://bun.sh) runtime
- [Pi](https://pi.dev/) installed and available as a CLI command

## Configuration

All configuration is via environment variables.

| Variable | Required | Default | Description |
|---|---:|---|---|
| `PI_BRIDGE_TOKEN` | Yes | auto-generated by `run.sh` | Bearer token for auth |
| `PI_CLI` | No | `pi` | Path to the Pi CLI binary |
| `PI_BRIDGE_PORT` | No | `7171` | Port to bind |
| `PI_BRIDGE_HOST` | No | `0.0.0.0` | Host to bind |

## API overview

Pi in Pocket uses these endpoints internally. You normally do not need to call them manually, but they are documented here for transparency and for other client developers.

### Health

```http
GET /health
```

Public endpoint. No auth required. Returns bridge status.

### Sessions

```http
GET    /sessions
POST   /sessions
POST   /sessions/rename
DELETE /sessions/:id
GET    /sessions/:id/messages
GET    /sessions/:id/state
GET    /sessions/:id/models
POST   /sessions/:id/prompt
POST   /sessions/:id/steer
POST   /sessions/:id/follow_up
POST   /sessions/:id/abort
POST   /sessions/:id/model
POST   /sessions/:id/thinking
POST   /sessions/:id/compact
POST   /sessions/:id/keep-alive
POST   /sessions/:id/name
```

`POST /sessions/:id/name` renames a live session. `POST /sessions/rename`
accepts `{ "sessionPath": "...", "name": "..." }` for a disk-only session.
Both forms persist Pi-compatible `session_info` metadata, and session paths are
validated to remain inside `~/.pi/agent/sessions`.

### WebSocket event stream

```http
GET /sessions/:id/events?token=YOUR_TOKEN&sinceSeq=N
```

Upgrades to WebSocket for real-time event streaming.

`sinceSeq` is optional. It lets clients reconnect and receive only events newer than the last event they saw.

## Troubleshooting

### `PI_BRIDGE_TOKEN must be set`

Use `./run.sh` instead of running `bun run index.ts` directly. The launcher creates and exports a token automatically.

If you want to start the server manually, set the token yourself:

```bash
export PI_BRIDGE_TOKEN="$(openssl rand -hex 32)"
bun run index.ts
```

### `No pi CLI found`

Install Pi, make sure the `pi` command is available in your shell, or set `PI_CLI` manually:

```bash
export PI_CLI=/path/to/pi
./run.sh
```

### Pi Bridge starts, but Pi in Pocket cannot connect

Check:

- The bridge is running
- Your iPhone can reach the computer's IP, Tailscale IP, or tunnel URL
- The URL includes the correct scheme, host, and port, for example `http://100.x.y.z:7171`
- The token matches the one printed by `./run.sh`
- Your firewall allows inbound connections to the bridge port

### WebSocket fails or streaming does not update

Make sure your network, VPN, reverse proxy, or tunnel supports WebSocket upgrades.

If you use Cloudflare Tunnel, check that WebSocket support is enabled and that the tunnel forwards to the correct local port.

### Sessions do not appear

Pi Bridge scans Pi's local session directory:

```bash
~/.pi/agent/sessions
```

Make sure Pi has created sessions on the same computer and under the same user account that runs Pi Bridge.

## Source files

| File | Description |
|---|---|
| `index.ts` | HTTP + WebSocket server, routing, and auth |
| `manager.ts` | Session pool, event fanout, ring buffer, seq/turnId stamping, idle reaper |
| `rpc.ts` | Spawns `pi --mode rpc`, newline-delimited JSON over stdin/stdout |
| `sessions.ts` | Scans `~/.pi/agent/sessions/` for on-disk session files |
| `apns.ts` | Apple Push Notification service client using HTTP/2 token auth |
| `types.ts` | TypeScript types for the Pi RPC protocol |

## License

MIT
