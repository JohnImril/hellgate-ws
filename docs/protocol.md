# Binary protocol specification

This describes the current WebSocket contract, not a general-purpose symmetric codec.
See [client setup](client.md) for the browser integration and [src/packet.ts](../src/packet.ts) for the codec.

## Wire Format

All integer fields are unsigned little-endian. Each binary WebSocket frame contains one packet or one
batch, beginning with a one-byte code; trailing bytes are rejected. Text frames are ignored.
Strings use a one-byte byte-length followed by bytes. The codec maps each byte to one character and
writes the low eight bits of each character; it is not UTF-8. Use ASCII for interoperable names/passwords.
Binary message payloads use a four-byte length followed by payload bytes.

| Code | Packet | Direction | Payload |
| ---: | --- | --- | --- |
| 0x00 | Batch | both | u16 count, then nested packets |
| 0x01 | Message | both | u8 player id, u32 length, bytes |
| 0x02 | Turn | client -> server | u32 turn |
| 0x02 | Turn | server -> client | u8 player id, u32 turn |
| 0x03 | DropPlayer | client -> server | u8 player id, u32 reason |
| 0x12 | JoinAccept | server -> client | u32 cookie, u8 index, u32 seed, u32 difficulty |
| 0x13 | Connect | server -> client | u8 player id |
| 0x14 | Disconnect | server -> client | u8 player id, u32 reason |
| 0x15 | JoinReject | server -> client | u32 cookie, u8 reason |
| 0x21 | GameList | request/response | empty request; response is u16 count, then count entries of u32 type + string name |
| 0x22 | CreateGame | client -> server | u32 cookie, string name, string password, u32 difficulty |
| 0x23 | JoinGame | client -> server | u32 cookie, string name, string password |
| 0x24 | LeaveGame | client -> server | empty |
| 0x31 | ClientInfo | client -> server | u32 version |
| 0x32 | ServerInfo | server -> client | u32 version |

## Session and Routing

1. Connect to `/ws` or `/websocket`; the server sends `ServerInfo` with protocol version `1`.
2. Send `ClientInfo` with your client/game compatibility version. It must be present before create/join;
   joiners must match the host's value. This is separate from the server protocol version.
3. Optionally request `GameList`, then send `CreateGame` or `JoinGame`. Send handshake and lobby requests
   as separate frames: the gateway handles `GameList` before other actions in the same batch.
4. Match `JoinAccept` / `JoinReject` to your request using the echoed `cookie`. A successful create assigns
   slot `0`; joiners receive an available slot in `1..3`. `seed` and `difficulty` come from the host's room.
5. Once attached, a socket stays bound to that room. Open a new connection to switch rooms or return to
   gateway lobby discovery, including after a failed join attempt.

Room names are case-sensitive and match `[A-Za-z0-9_-]{1,32}`. Password matching is exact.
Directory entries are sorted by most recent update. Their `type` is currently `0`; the wire list does not
include occupancy, password status, or a guarantee that a persisted entry still has a live room.

- Client `Message.id` is the destination slot; `0xff` broadcasts to all other joined players. Server
  `Message.id` identifies the sender. Invalid destinations are ignored; payloads are opaque to the server.
- `Turn` forwards the client's value to other joined players with the sender id added. The server does not
  run the simulation, validate game rules, or wait for a complete set of player turns.
- `Connect` announces a new slot to all joined clients, including the new client. It is not a roster snapshot.
- Guest leave/disconnect frees the slot and broadcasts `Disconnect`. Host leave/disconnect closes the entire
  room and removes its directory entry. No host migration or automatic session resume is implemented.
- Only slot `0` may send `DropPlayer`; dropping slot `0` closes the room. Protocol disconnect reasons are
  u32 values, distinct from WebSocket close codes. Ordinary leave/close uses `3`; errors can use `0`;
  an explicit host drop forwards the supplied reason.

## Join Rejection Codes

| Value | Meaning |
| ---: | --- |
| 0x00 | Reserved success constant; success uses `JoinAccept` |
| 0x01 | Already joined a game |
| 0x02 | Game not found |
| 0x03 | Incorrect password |
| 0x04 | Missing or incompatible client version |
| 0x05 | All four player slots are occupied |
| 0x06 | A room with this name already exists |

## Limits and Connection Errors

Frames are at most 1 MiB **including packet headers**. The message payload constant is also 1 MiB,
so a standalone `Message` can carry at most 1 MiB minus its six-byte header. Strings are at most 255 bytes.
A batch has at most 256 packets and cannot contain another batch.

The gateway allows 15 seconds from the first binary message until room attachment. Pending traffic is
bounded to 256 messages / 14 MiB; unclassified pending traffic additionally has a 32-message / 1 MiB limit.
Rooms allow 512 decoded packets per 15-second window per connection; the third invalid packet closes it.

| WebSocket code | Typical cause |
| ---: | --- |
| 1000 | Normal leave, room closure, or closed bridge |
| 1002 | Malformed packet or invalid room-side name |
| 1008 | Invalid gateway room name, rate limit, or non-host drop attempt |
| 1009 | Oversized frame or pending queue overflow |
| 1011 | Room attachment timeout or bridge failure |

The gateway can translate a room-side close into `1000` / `room closed`; inspect server logs when
the external close code is less specific. These guards do not constitute authentication or full abuse protection.

## Compatibility Checks

The six canonical vectors in [protocol/fixtures/v1.json](../protocol/fixtures/v1.json) are copied unchanged
into Diablo Web. They cover ClientInfo, ServerInfo, an empty GameList request, both Turn directions, and
Message. Coordinate updates in both repositories when changing the wire format.

Client tests parse all six vectors; backend tests decode the inbound ones. They do not assert complete
WASM gameplay or cover every packet. The backend decoder treats `GameList` as a request and `Turn` as
client-to-server, while its encoder writes responses. Do not round-trip server responses through that decoder.
