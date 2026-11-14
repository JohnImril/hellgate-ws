# hellgate-ws - Diablo Web multiplayer backend

A TypeScript WebSocket server for [Diablo Web](https://github.com/JohnImril/diablo_web), built on
Cloudflare Workers and Durable Objects. It provides a lobby, rooms for up to four players, message routing,
and turn forwarding over the game's binary protocol. No external runtime dependencies.

**[Play Diablo Web](https://johnimril.github.io/diablo_web/)** ·
**[Connect a client](docs/client.md)** · **[Protocol reference](docs/protocol.md)**

This repository contains the server, not the game engine or game data. The backend was built to implement
the multiplayer protocol exposed by the browser/WASM client. Online play is experimental.

## Quick Start

Use Node.js 24 (the CI version; Wrangler requires Node.js 22+) and npm. Wrangler is a local development
dependency, so a global installation is unnecessary.

```bash
git clone https://github.com/JohnImril/hellgate-ws.git
cd hellgate-ws
npm ci
npm run dev
```

The local WebSocket endpoint is `ws://127.0.0.1:8787/ws`. Follow the
[client guide](docs/client.md#local-development) to run Diablo Web against it.
Opening this endpoint as a normal web page returns HTTP 426; it requires a WebSocket upgrade.

## Deployment

You need a Cloudflare account with Workers and Durable Objects available.

```bash
npx wrangler login
npm run deploy
```

[wrangler.toml](wrangler.toml) defines the Worker name, the `GAME_ROOM` / `GAME_DIRECTORY` bindings,
and the initial SQLite Durable Object migration. Change the name for your own deployment if needed;
preserve existing migration history when updating a deployed service.

Wrangler prints the Worker URL. Append `/ws` and use `wss://`, for example
`wss://hellgate-ws.yourname.workers.dev/ws`. `/websocket` is also accepted.
The root URL returns HTTP 404; this service does not serve a website.

Set this endpoint as `VITE_WS_URL` when building the frontend. The
[production client instructions](docs/client.md#production) cover GitHub Pages and custom hosting.

## Architecture

| File | Responsibility |
| --- | --- |
| [src/index.ts](src/index.ts) | WebSocket gateway, handshake, lobby queries, and room bridge |
| [src/directory.ts](src/directory.ts) | Persisted lobby metadata, listing, upsert, and removal |
| [src/room.ts](src/room.ts) | In-memory session, four player slots, join/leave/drop, and packet routing |
| [src/packet.ts](src/packet.ts) | Binary codecs, rejection codes, and packet limits |

The gateway sends `ServerInfo`; the client sends `ClientInfo`, then requests a lobby list or creates/joins
a room. Each room is a Durable Object; slot 0 is the host. Host departure closes the room.
The server relays game messages and turns; it does not simulate the game or store player saves.
See the [protocol reference](docs/protocol.md) for field layouts, ordering, limits, and lifecycle details.

## Validation

```bash
npm run types
npm test
```

CI runs both commands. Tests cover protocol validation, directory persistence, the WebSocket gateway,
room lifecycle, routing, rejection paths, and runtime limits in the Cloudflare Workers runtime.

Six shared [binary fixtures](protocol/fixtures/v1.json) also exist in Diablo Web. They check basic codec
compatibility, not complete browser/WASM gameplay. Keep the copies identical when changing the protocol.
The server codec is directional: it decodes client requests and encodes server responses; it is not a
general symmetric client/server codec.

## Status and Limitations

Implemented: lobby discovery, create/join/leave, host-initiated drop, four-player slots, message/turn
forwarding, size/batch/queue limits, invalid-packet handling, and basic room rate limiting.

Remaining work:

- Authentication and an identity model; a room password is not account authentication.
- Stronger authorization, protocol validation, and abuse protection.
- Stale lobby cleanup / TTL: directory metadata persists, but room session state does not survive a restart.
- Full WASM gameplay compatibility tests and broader binary fixtures.
- Structured operational metrics; current diagnostics are limited.
- Room type metadata (`type = 0`); activity tracking is not yet used for cleanup.

This is a foundation for multiplayer experimentation, not a production-hardened service.
For connection failures, see [troubleshooting](docs/client.md#troubleshooting).

## License

[MIT](LICENSE). This license covers this backend; it does not grant rights to Diablo game data or
change the separate licensing status of the browser client and inherited engine artifacts.
