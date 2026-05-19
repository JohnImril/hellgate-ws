# hellgate-ws

`hellgate-ws` is a compact real-time multiplayer backend built on Cloudflare Workers and Durable Objects. It provides the missing server-side multiplayer layer for a Diablo-like browser/WASM game: WebSocket gateway, lobby directory, room-based sessions, player slots, message routing, turn synchronization, and a custom binary protocol.

The original browser/WASM projects did not include a working online multiplayer backend. `hellgate-ws` was created from scratch to fill that gap using a limited available API and binary protocol surface. It is not a generic WebSocket example: it is a compact server-side multiplayer foundation for running online sessions in a Diablo-like browser game.

## Overview

This repository contains the server-side multiplayer backend only. It does not include a full game client. It is intended to be used as a separate multiplayer service that a compatible browser/WASM client can connect to.

Implemented pieces:

- WebSocket gateway on Cloudflare Workers
- Stateful game rooms using Durable Objects
- Lobby / game directory using a separate Durable Object
- Custom binary protocol instead of JSON over WebSocket
- Create, join, leave, host drop, message routing, and turn synchronization flow
- Slot-based rooms with up to 4 players
- Zero external runtime dependencies
- TypeScript source with Wrangler deployment configuration

The implementation is intentionally compact, but it is not a placeholder or a generic demo. It implements the missing multiplayer layer that the original browser/WASM projects did not provide. The core online flow is present: clients can discover games, create rooms, join rooms, exchange routed messages, and synchronize turns through Durable Object backed sessions.

## Why This Exists

The browser/WASM client had enough protocol surface to communicate multiplayer-related data, but there was no ready-made backend that actually implemented lobby discovery, room lifecycle, player slots, message routing, or turn synchronization.

`hellgate-ws` was built from scratch to provide that missing infrastructure. It uses the available API and binary protocol surface as the boundary between the client/WASM side and a custom Cloudflare-based multiplayer backend.

Most of the server-side behavior - lobby management, room lifecycle, player ownership, routing, and synchronization - had to be designed outside of the original client code.

## Architecture

The architecture is split into a stateless edge entrypoint and stateful Durable Objects. The Worker accepts WebSocket connections and performs the initial protocol handshake. `GameDirectory` tracks active rooms and serves the lobby list. `GameRoom` owns one multiplayer session and handles players, slots, room lifecycle, message routing, leave/drop events, and turn synchronization.

- `src/index.ts` contains the Cloudflare Worker entrypoint. It accepts WebSocket connections, performs the initial protocol handling, answers lobby list requests, and forwards room traffic to the correct `GameRoom`.
- `src/directory.ts` contains `GameDirectory`, a Durable Object that stores active game metadata and serves the lobby list.
- `src/room.ts` contains `GameRoom`, a Durable Object where one instance owns one multiplayer session.
- `src/packet.ts` contains packet codes, binary encoding/decoding helpers, batching support, versioning fields, and protocol limits.

Cloudflare bindings and Durable Object migrations are configured in `wrangler.toml`.

## Connection Flow

1. Client opens a WebSocket connection to `/ws` or `/websocket`.
2. Server sends `ServerInfo`.
3. Client responds with `ClientInfo`.
4. Client requests `GameList`, `CreateGame`, or `JoinGame`.
5. The gateway either returns lobby data or forwards the WebSocket connection to a `GameRoom` Durable Object.
6. The room handles player state, routing, leave/drop events, and turn synchronization.

## Durable Objects

### GameDirectory

`GameDirectory` is the lobby directory.

It currently:

- stores active game metadata in Durable Object storage;
- supports room metadata upsert;
- supports room removal;
- returns a binary `GameList` response sorted by recent updates.

The directory is intentionally small. More robust stale-room cleanup and TTL behavior should be added before production use.

### GameRoom

`GameRoom` owns a single multiplayer room.

It currently handles:

- creating a room;
- joining an existing room;
- leaving a room;
- host-initiated player drop;
- player slot allocation;
- message forwarding to one player or broadcast targets;
- turn synchronization;
- directory updates when room membership changes.

Rooms support up to 4 players. Slot `0` is treated as the host in the current implementation.

## Binary Protocol

The server uses a custom binary protocol for WebSocket traffic. It avoids JSON framing and keeps packets small for real-time traffic. The protocol is built around the limited multiplayer API / binary surface available to the browser/WASM runtime, with the server providing the missing lobby and room behavior behind that surface.

Supported packet categories include:

- `ServerInfo` / `ClientInfo`
- `GameList`
- `CreateGame` / `JoinGame` / `LeaveGame`
- `JoinAccept` / `JoinReject`
- `Connect` / `Disconnect` / `DropPlayer`
- `Message`
- `Turn`
- batched packets

The protocol implementation includes versioning fields and limits for frame size, string size, message size, batch depth, batch count, and total packet count.

Some codec behavior is currently server-oriented. For example, `GameList` decoding is minimal because the server only needs to recognize the request, while the encoded response contains the list payload. Turn packet encode/decode behavior should also be documented or normalized before treating `src/packet.ts` as a general shared client/server protocol package.

## Runtime Guards

The project includes basic runtime safeguards:

- maximum WebSocket frame size;
- string and message payload size limits;
- maximum packet count per batch;
- batch depth and batch count limits;
- pending queue limits in the gateway before a room connection is attached;
- invalid packet limits inside rooms;
- basic room-level message rate limiting;
- shared room name validation.

Basic message rate limiting exists, but this is not a comprehensive production-grade anti-abuse system.

## Running Your Own Server

To use `hellgate-ws` as a backend for your own game or application, deploy it under your own Cloudflare account.

This project is designed to run on Cloudflare Workers with Durable Objects.

## Prerequisites

You need:

- a Cloudflare account;
- Node.js 22+;
- Wrangler CLI.

Install Wrangler:

```bash
npm install -g wrangler
```

Log in to Cloudflare:

```bash
wrangler login
```

## Setup

Clone the repository:

```bash
git clone https://github.com/JohnImril/hellgate-ws.git
cd hellgate-ws
npm install
```

The project contains a ready-to-use `wrangler.toml`:

```toml
name = "hellgate-ws"
main = "src/index.ts"
compatibility_date = "2026-01-08"

[durable_objects]
bindings = [
  { name = "GAME_ROOM", class_name = "GameRoom" },
  { name = "GAME_DIRECTORY", class_name = "GameDirectory" }
]

[[migrations]]
tag = "v1"
new_sqlite_classes = ["GameRoom", "GameDirectory"]
```

You usually do not need to change this unless you want a different Worker name or separate environments.

## Local Development

Run locally:

```bash
npm run dev
```

The server will be available at:

```text
ws://127.0.0.1:8787/ws
```

You can point a compatible client to this URL and test multiplayer locally.

Type checking is available after dependencies are installed:

```bash
npm run types
```

There is no test script yet.

## Deployment

Deploy to your Cloudflare account:

```bash
npm run deploy
```

After deployment, Wrangler will print your public Worker URL, for example:

```text
https://hellgate-ws.yourname.workers.dev
```

Your WebSocket endpoint will be:

```text
wss://hellgate-ws.yourname.workers.dev/ws
```

This is the URL your game client should use.

## Connecting a Client

Your game client must open a WebSocket connection to:

```ts
const ws = new WebSocket("wss://<your-worker>.workers.dev/ws");
```

The gateway also accepts `/websocket` for compatibility:

```ts
const ws = new WebSocket("wss://<your-worker>.workers.dev/websocket");
```

From that point, the protocol flow is:

1. Server sends `ServerInfo`.
2. Client responds with `ClientInfo`.
3. Client may request `GameList`, `CreateGame`, or `JoinGame`.
4. The server returns lobby data or routes the connection into a `GameRoom` Durable Object.

Each room is a separate stateful process managed by Cloudflare.

## Client Configuration

Frontend projects are expected to configure the WebSocket endpoint at build time.

Typical Vite client code:

```ts
const WS_URL = import.meta.env.VITE_WS_URL ?? "ws://127.0.0.1:8787/ws";
```

This means:

- in local development, the fallback URL is used;
- in production, the value should be provided at build time.

### Local

```bash
VITE_WS_URL=ws://127.0.0.1:8787/ws npm run dev
```

### GitHub Pages / CI

1. Go to your repository Settings -> Secrets and variables -> Actions.
2. Add a secret:

```text
Name: VITE_WS_URL
Value: wss://<your-worker>.workers.dev/ws
```

3. Pass it into the build step:

```yaml
- name: Build project
  run: npm run build
  env:
    VITE_WS_URL: ${{ secrets.VITE_WS_URL }}
```

After that, each deploy can bake the correct server address into the client bundle.

## Project Status

`hellgate-ws` is a working compact multiplayer backend foundation with the core online flow already implemented: WebSocket gateway, lobby directory, room lifecycle, player slots, message routing, and turn synchronization.

The project is suitable as a real working base for multiplayer experimentation and further hardening. It is not production-hardened yet. Before using it in production, add tests, CI type checking, authentication, stricter protocol validation, stale room cleanup, and stronger abuse protection.

## Known Limitations

- No authentication is implemented.
- No production-grade authorization or identity model is implemented.
- Basic message rate limiting exists, but there is no comprehensive anti-abuse layer.
- There is no test suite yet.
- There is no test script yet.
- Binary protocol behavior needs dedicated tests.
- Binary protocol validation should be stricter.
- Protocol layout needs more complete documentation.
- Lobby stale entry cleanup / TTL behavior should be improved.
- Durable Object storage may keep stale game entries if a room fails to remove itself from the directory.
- There is no long-term persistence beyond the current room and directory model.
- Some protocol codec behavior is currently server-oriented and should be documented before reuse as a shared client/server protocol package.
- Room type metadata is still marked as internal TODO.
- Room activity tracking exists but is not yet used for cleanup.

## Roadmap

- [x] WebSocket gateway on Cloudflare Workers
- [x] Durable Object based game rooms
- [x] Lobby / game directory
- [x] Binary protocol
- [x] Create / join / leave flow
- [x] Player slots
- [x] Message routing
- [x] Turn synchronization
- [x] Basic runtime limits
- [ ] Protocol unit tests
- [ ] CI type checking
- [ ] Full binary protocol documentation
- [ ] Stale lobby entry cleanup / TTL
- [ ] Authentication / identity layer
- [ ] Stronger authorization rules
- [ ] Production-grade abuse protection
- [ ] Observability / structured logs / metrics
- [ ] Example browser client integration

## License

MIT License.

You are free to use, modify, and redistribute this project, including for commercial purposes.
