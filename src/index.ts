import { GameRoom } from "./room";
import { GameDirectory } from "./directory";
import { encodeServerInfo, sniffLobbyAction } from "./packet";

export { GameRoom, GameDirectory };

type Env = {
	GAME_ROOM: DurableObjectNamespace;
	GAME_DIRECTORY: DurableObjectNamespace;
};

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
		let closed = false;

		const closeAll = (code = 1000, reason = "bye") => {
			if (closed) return;
			closed = true;
			try {
				serverWs.close(code, reason);
			} catch {}
			try {
				doWs?.close(code, reason);
			} catch {}
		};

		const pumpToDO = (buf: ArrayBuffer) => {
			if (!doWs) {
				pending.push(buf);
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
				closeAll(1011, "failed to create do ws");
				return;
			}

			doWs = ws;
			doWs.accept();

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
				try {
					doWs.send(b);
				} catch {
					closeAll(1011, "do send failed");
					return;
				}
			}

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

			if (doWs) {
				pumpToDO(buf);
				return;
			}

			const sniff = sniffLobbyAction(buf);
			if (!sniff) {
				pending.push(buf);
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

			pending.push(buf);
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
