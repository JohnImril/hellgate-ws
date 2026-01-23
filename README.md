# hellgate-ws

A real-time multiplayer backend built on **Cloudflare Workers** and **Durable Objects**.

This project implements a lightweight WebSocket gateway, lobby directory, and room-based multiplayer server with a custom binary protocol.
Originally designed for a Diablo-like game, but architecturally generic and reusable.

---

## Features

- WebSocket gateway on Cloudflare Workers
- Room-based multiplayer using Durable Objects
- Central lobby / game directory
- Custom binary protocol (no JSON over WS)
- Deterministic room state and slot-based players
- Zero external runtime dependencies
- Stateless edge entry + stateful rooms

---

## Durable Objects

### GameDirectory

- Stores active game metadata
- Updated on room create / join / leave
- Provides binary `GameList` response

### GameRoom

- One instance per game room
- Handles:
  - create / join / leave
  - player slots
  - message routing
  - turn synchronization
- Automatically cleans itself up when empty

---

## Protocol

The server uses a **binary protocol** optimized for real-time traffic.

Supported packet types:

- ServerInfo / ClientInfo
- GameList
- CreateGame / JoinGame / LeaveGame
- JoinAccept / JoinReject
- Connect / Disconnect / DropPlayer
- Message (player-to-player or broadcast)
- Turn synchronization

The protocol supports batching and versioning.

---

## Running Your Own Server

If you want to use `hellgate-ws` as a backend for your own game or application, you need to deploy it under **your own Cloudflare account**.  

This project is designed to run on **Cloudflare Workers with Durable Objects**.

### Prerequisites

You need:

- A Cloudflare account  
- Node.js 18+  
- Wrangler CLI  

Install Wrangler:

```bash
npm install -g wrangler
```

Login into Cloudflare:

```bash
wrangler login
```

---

## Setup

Clone the repository:

```bash
git clone https://github.com/JohnImril/hellgate-ws.git
cd hellgate-ws
npm install
```

The project already contains a ready-to-use `wrangler.toml`:

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

You usually **do not need to change anything** here unless:

- you want a different worker name  
- you want to run multiple environments (dev / prod)

---

## Local Development

Run locally:

```bash
npm run dev
```

The server will be available at:

```
ws://127.0.0.1:8787/ws
```

You can now point your client to this URL and test multiplayer locally.

---

## Deployment

Deploy to your Cloudflare account:

```bash
npm run deploy
```

After deployment, Wrangler will print your public Worker URL, for example:

```
https://hellgate-ws.yourname.workers.dev
```

Your WebSocket endpoint will be:

```
wss://hellgate-ws.yourname.workers.dev/ws
```

This is the URL your game client should use.

---

## Connecting a Client

Your game client must open a WebSocket connection to:

```ts
const ws = new WebSocket("wss://<your-worker>.workers.dev/ws");
```

From that point, the protocol flow is:

1. Server sends `ServerInfo`
2. Client responds with `ClientInfo`
3. Client may request:
   - `GameList`
   - `CreateGame`
   - `JoinGame`
4. The server routes the connection into a `GameRoom` Durable Object

Each room is a **separate stateful process** managed by Cloudflare.

---

## Client Configuration (VITE_WS_URL)

Frontend projects are expected to configure the WebSocket endpoint at **build time**.

Typical client code:

```ts
const WS_URL = import.meta.env.VITE_WS_URL ?? "ws://127.0.0.1:8787/ws";
```

This means:

- In local development, the fallback URL is used.
- In production, the value must be provided at build time.

### Local

```bash
VITE_WS_URL=ws://127.0.0.1:8787/ws npm run dev
```

### GitHub Pages / CI

1. Go to your repository → Settings → Secrets and variables → Actions  
2. Add a secret:

```
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

After that, every deploy will bake the correct server address into the client bundle.

---

## Project Status

This is an **experimental / hobby project**.

Not production-hardened:

- No authentication
- No rate limiting
- No persistence beyond in-memory room state

These are intentional tradeoffs for clarity and experimentation.

You are expected to extend this project for production use.

---

## License

MIT License.

You are free to use, modify, and redistribute this project, including for commercial purposes.
