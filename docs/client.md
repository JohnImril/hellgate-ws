# Connect Diablo Web to hellgate-ws

Use [Diablo Web](https://github.com/JohnImril/diablo_web) as the browser client. This guide covers the
**WebSocket (Server)** option; **WebRTC (Direct)** uses a separate connection path.
The server and client are independently deployed. Setting a frontend URL does not deploy a server.

## Local Development

1. In the server checkout, run `npm ci`, then `npm run dev`. Leave it running.
2. In another terminal, prepare the frontend:

   ```bash
   git clone https://github.com/JohnImril/diablo_web.git
   cd diablo_web
   npm ci
   ```

3. Create `.env.local` in **diablo_web**, next to its `package.json`:

   ```dotenv
   VITE_WS_URL=ws://127.0.0.1:8787/ws
   ```

4. Run `npm run dev` in that frontend terminal and open the URL Vite prints, normally
   `http://localhost:5173/diablo_web/`. Restart Vite after changing `.env.local`.

The explicit setting documents which server you are using; localhost development also defaults to this
endpoint. Test two players in separate browser profiles or browsers. Two tabs in the same profile on the
same origin cannot both own Diablo Web's save storage. Never clear saves to work around that lock.

## Production

Deploy hellgate-ws using the [server instructions](../README.md#deployment). Set the frontend's
`VITE_WS_URL` to the resulting `wss://<worker>.workers.dev/ws` endpoint **before** `npm run build`.
An HTTPS page cannot use a plain `ws://` endpoint. The endpoint is public configuration embedded in the bundle.

For Diablo Web's existing GitHub Pages workflow, set the frontend repository Actions secret `VITE_WS_URL`;
the workflow already passes it to the build. Run a deployment after changing the secret.
For another build system, use an environment variable or the frontend `.env.local` file above with a `wss://` URL.
Changing an environment variable after uploading `dist/` does not change that bundle.

Single-player and the demo do not need this endpoint. A missing production endpoint is reported when
the player selects WebSocket multiplayer. See the client's
[deployment guide](https://github.com/JohnImril/diablo_web/blob/main/docs/DEPLOYMENT.md) for hosting paths and PWA updates.

## Two-Player Check

1. Open the same frontend build on both devices/profiles. Start the same game-data mode on both;
   use your own legal `DIABDAT.MPQ` for the full game. Cross-mode compatibility is not established.
2. Choose **Multi Player → WebSocket (Server)** on each, then create or select a multiplayer character.
3. On the first client, choose **Create Game** and enter a room name such as `tristram-1`.
   Room names are case-sensitive, 1–32 characters, using only letters A–Z/a–z, digits, `_`, or `-`.
4. On the second client, choose **Join Game** and enter exactly the same room name.
5. Verify that both players appear in the same session and can see each other move. Then leave with
   the guest and check that the host remains connected. Leaving with the host closes the room for everyone.

Rooms have at most four slots. Matching client builds matter: a joining client's reported version must
equal the host's. These are manual acceptance steps, not a claim of automated end-to-end gameplay coverage.

## Troubleshooting

| Symptom | Check |
| --- | --- |
| HTTP 404 at the Worker root | Expected: use `/ws` or `/websocket` with a WebSocket client. |
| HTTP 426 in a browser tab | Expected for a normal HTTP request; the route requires a WebSocket upgrade. |
| Missing `VITE_WS_URL` | Configure the **frontend**, rebuild/redeploy, and let its PWA update on the start screen. |
| Insecure URL or mixed content | Use `wss://` on HTTPS hosting. Use the local Vite dev server for `ws://` testing. |
| Connection refused | Keep Wrangler running; on a second device, `127.0.0.1` means that device, not your server. Use an HTTPS client and deployed WSS server for device testing. |
| `Game already open` | Close the owning game tab/app, or use a different browser profile for the second player. |
| Room not found / version mismatch / full | Check the exact name, active host, matching client build, and four-player limit. |
| `connect timeout` | The gateway currently allows 15 seconds from the first binary message to room attachment. Reconnect and create/join promptly. |
| Invalid room name | Use only the name characters and length listed above. |

For a custom client, set `socket.binaryType = "arraybuffer"` and implement the binary handshake and
directional packet layouts in [protocol.md](protocol.md). JSON messages are not the game protocol.
For a report, include client/server revisions, game-data mode, browser, and the connection error;
do not attach retail game archives or private save files.
