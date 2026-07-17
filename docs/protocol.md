# Binary protocol specification

All integer fields are unsigned little-endian. Every top-level frame begins with
a one-byte packet code. Strings use a one-byte byte-length followed by bytes.
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
| 0x21 | GameList | request/response | empty request; response is u16 count then u32 type + string |
| 0x22 | CreateGame | client -> server | u32 cookie, string name, string password, u32 difficulty |
| 0x23 | JoinGame | client -> server | u32 cookie, string name, string password |
| 0x24 | LeaveGame | client -> server | empty |
| 0x31 | ClientInfo | client -> server | u32 version |
| 0x32 | ServerInfo | server -> client | u32 version |

Limits are part of the contract: frames and message payloads are at most 1 MiB,
strings at most 255 bytes, and a batch at most 256 packets with no nested batch.
The canonical compatibility vectors live in protocol/fixtures/v1.json and are
copied unchanged into diablo_web. Tests in both repositories consume them; when
the wire format changes, update both copies in the same change.

