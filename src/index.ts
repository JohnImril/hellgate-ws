import { GameRoom } from "./room";
import { GameDirectory } from "./directory";
import { encodeServerInfo, sniffLobbyAction } from "./packet";

export { GameRoom, GameDirectory };

type Env = {
	GAME_ROOM: DurableObjectNamespace;
	GAME_DIRECTORY: DurableObjectNamespace;
};

const MAX_PENDING_MESSAGES = 256;
const MAX_PENDING_BYTES = 14 * 1024 * 1024;
const MAX_PENDING_UNKNOWN_MESSAGES = 32;
const MAX_PENDING_UNKNOWN_BYTES = 1 * 1024 * 1024;
const CONNECT_TIMEOUT_MS = 15000;

function isWsUpgrade(req: Request) {
	const upgrade = req.headers.get("Upgrade");
	return upgrade && upgrade.toLowerCase() === "websocket";
}

export default {
	async fetch(req: Request, env: Env): Promise<Response> {
		const url = new URL(req.url);

		if (url.pathname !== "/websocket" && url.pathname !== "/ws")
			return new Response("Not found", { status: 404 });
		if (!isWsUpgrade(req))
			return new Response("Expected websocket", { status: 426 });

		const pair = new WebSocketPair();
		const clientWs = pair[0];
		const serverWs = pair[1];
		serverWs.accept();

		serverWs.send(encodeServerInfo(1));

		let clientVersion: number | undefined;
		let doWs: WebSocket | null = null;
		let roomName: string | null = null;

		const pending: Array<ArrayBuffer> = [];
		let pendingBytes = 0;
		let pendingUnknownMessages = 0;
		let pendingUnknownBytes = 0;
		let closed = false;
		let overflowLogged = false;
		let timeoutId: ReturnType<typeof setTimeout> | null = null;

		const closeAll = (code = 1000, reason = "bye") => {
			if (closed) return;
			closed = true;
			pending.length = 0;
			pendingBytes = 0;
			pendingUnknownMessages = 0;
			pendingUnknownBytes = 0;
			if (timeoutId) {
				clearTimeout(timeoutId);
				timeoutId = null;
			}
			try {
				serverWs.close(code, reason);
			} catch {}
			try {
				doWs?.close(code, reason);
			} catch {}
		};

		const startConnectTimeout = () => {
			if (timeoutId) return;
			timeoutId = setTimeout(() => {
				timeoutId = null;
				if (!doWs) {
					console.warn("[ws-gateway] connect timeout", {
						roomName,
						pendingMessages: pending.length,
						pendingBytes,
					});
					closeAll(1011, "connect timeout");
				}
			}, CONNECT_TIMEOUT_MS);
		};

		const handleOverflow = (reason: string) => {
			if (!overflowLogged) {
				overflowLogged = true;
				console.warn("[ws-gateway] pending overflow", {
					reason,
					roomName,
					pendingMessages: pending.length,
					pendingBytes,
					pendingUnknownMessages,
					pendingUnknownBytes,
				});
			}
			closeAll(1009, "pending overflow");
		};

		const enqueuePending = (buf: ArrayBuffer, unknown = false) => {
			pending.push(buf);
			pendingBytes += buf.byteLength;
			if (unknown) {
				pendingUnknownMessages += 1;
				pendingUnknownBytes += buf.byteLength;
			}
			if (
				pending.length > MAX_PENDING_MESSAGES ||
				pendingBytes > MAX_PENDING_BYTES
			) {
				handleOverflow("pending limits exceeded");
				return false;
			}
			if (
				pendingUnknownMessages > MAX_PENDING_UNKNOWN_MESSAGES ||
				pendingUnknownBytes > MAX_PENDING_UNKNOWN_BYTES
			) {
				console.warn("[ws-gateway] unknown packet limit exceeded", {
					roomName,
					pendingUnknownMessages,
					pendingUnknownBytes,
				});
				closeAll(1002, "invalid packet");
				return false;
			}
			return true;
		};

		const pumpToDO = (buf: ArrayBuffer) => {
			if (!doWs) {
				enqueuePending(buf);
				return;
			}
			try {
				doWs.send(buf);
			} catch {
				closeAll(1011, "do send failed");
			}
		};

		const attachBridge = async (
			name: string,
			firstPacketToForward: ArrayBuffer
		) => {
			if (doWs) return;
			roomName = name;

			const roomId = env.GAME_ROOM.idFromName(name);
			const stub = env.GAME_ROOM.get(roomId);

			const doResp = await stub.fetch("https://do/ws", {
				headers: { Upgrade: "websocket" },
			});

			const ws = (doResp as any).webSocket as WebSocket | undefined;
			if (!ws) {
				pending.length = 0;
				pendingBytes = 0;
				pendingUnknownMessages = 0;
				pendingUnknownBytes = 0;
				closeAll(1011, "failed to create do ws");
				return;
			}

			doWs = ws;
			doWs.accept();
			if (timeoutId) {
				clearTimeout(timeoutId);
				timeoutId = null;
			}

			doWs.addEventListener("message", (ev) => {
				if (typeof ev.data === "string") return;
				try {
					serverWs.send(ev.data as ArrayBuffer);
				} catch {
					closeAll(1011, "client send failed");
				}
			});

			doWs.addEventListener("close", () => closeAll(1000, "room closed"));
			doWs.addEventListener("error", () => closeAll(1011, "room error"));

			for (const b of pending.splice(0, pending.length)) {
				pendingBytes -= b.byteLength;
				try {
					doWs.send(b);
				} catch {
					closeAll(1011, "do send failed");
					return;
				}
			}
			pendingBytes = 0;
			pendingUnknownMessages = 0;
			pendingUnknownBytes = 0;

			try {
				doWs.send(firstPacketToForward);
			} catch {
				closeAll(1011, "do send failed");
			}
		};

		const answerGameList = async () => {
			const dirId = env.GAME_DIRECTORY.idFromName("directory");
			const dir = env.GAME_DIRECTORY.get(dirId);
			const resp = await dir.fetch("https://do/list.bin");
			const bin = await resp.arrayBuffer();
			try {
				serverWs.send(bin);
			} catch {
				closeAll(1011, "client send failed");
			}
		};

		serverWs.addEventListener("message", async (ev) => {
			if (typeof ev.data === "string") return;
			const buf = ev.data as ArrayBuffer;
			startConnectTimeout();

			if (doWs) {
				pumpToDO(buf);
				return;
			}

			const sniff = sniffLobbyAction(buf);
			if (!sniff) {
				enqueuePending(buf, true);
				return;
			}

			if (sniff.wantsGameList) {
				await answerGameList();
				return;
			}

			if (sniff.clientInfoVersion !== undefined) {
				clientVersion = sniff.clientInfoVersion;
			}

			if (sniff.create?.name) {
				await attachBridge(sniff.create.name, buf);
				return;
			}
			if (sniff.join?.name) {
				await attachBridge(sniff.join.name, buf);
				return;
			}

			enqueuePending(buf);
		});

		serverWs.addEventListener("close", () =>
			closeAll(1000, "client closed")
		);
		serverWs.addEventListener("error", () =>
			closeAll(1011, "client error")
		);

		return new Response(null, { status: 101, webSocket: clientWs } as any);
	},
};
