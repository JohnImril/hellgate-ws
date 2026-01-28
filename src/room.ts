import {
	PacketCode,
	RejectionReason,
	decodeTopLevel,
	encodeJoinAccept,
	encodeJoinReject,
	encodeConnect,
	encodeDisconnect,
	encodePacket,
	MAX_FRAME_BYTES,
} from "./packet";

type Env = {
	GAME_DIRECTORY: DurableObjectNamespace;
};

type Player = {
	id: number;
	ws: WebSocket;
	cookie?: number;
	clientVersion?: number;
};

type RoomState = {
	name: string;
	password: string;
	difficulty: number;
	seed: number;
	createdAt: number;
	type: number; // TODO
	version: number;
};

const MAX_PLAYERS = 4;
const MAX_INVALID_PACKETS = 2;
const MAX_MESSAGES_PER_WINDOW = 512;
const RATE_WINDOW_MS = 15000;
const ROOM_NAME_RE = /^[A-Za-z0-9_-]{1,32}$/;

function isValidRoomName(name: string) {
	return ROOM_NAME_RE.test(name);
}

export class GameRoom implements DurableObject {
	private state: DurableObjectState;
	private env: Env;

	private room?: RoomState;
	private slots: Array<Player | null> = Array.from(
		{ length: MAX_PLAYERS },
		() => null
	);
	private bySocket = new Map<WebSocket, Player>();
	private lastActivity = Date.now();
	private invalidCounts = new Map<WebSocket, number>();
	private rateState = new Map<WebSocket, { windowStart: number; count: number }>();
	private floodLogged = new Set<WebSocket>();

	constructor(state: DurableObjectState, env: Env) {
		this.state = state;
		this.env = env;
	}

	async fetch(req: Request): Promise<Response> {
		const url = new URL(req.url);

		if (url.pathname === "/ws") {
			const upgrade = req.headers.get("Upgrade");
			if (!upgrade || upgrade.toLowerCase() !== "websocket") {
				return new Response("Expected websocket", { status: 426 });
			}

			const pair = new WebSocketPair();
			const client = pair[0];
			const server = pair[1];
			server.accept();

			this.attach(server);

			return new Response(null, {
				status: 101,
				webSocket: client,
			} as any);
		}

		return new Response("Not found", { status: 404 });
	}

	private closeReason = new Map<WebSocket, number>();

	private attach(ws: WebSocket) {
		this.lastActivity = Date.now();

		ws.addEventListener("message", (ev) => {
			if (typeof ev.data === "string") return;
			this.lastActivity = Date.now();
			const buf = ev.data as ArrayBuffer;
			if (buf.byteLength > MAX_FRAME_BYTES) {
				this.closeReason.set(ws, 0);
				try {
					ws.close(1009, "frame too large");
				} catch {}
				return;
			}
			this.onBinary(ws, buf);
		});

		ws.addEventListener("close", () => {
			const reason = this.closeReason.get(ws) ?? 3;
			this.closeReason.delete(ws);
			this.invalidCounts.delete(ws);
			this.rateState.delete(ws);
			this.floodLogged.delete(ws);
			this.onSocketClose(ws, reason);
		});

		ws.addEventListener("error", () => {
			const reason = this.closeReason.get(ws) ?? 0;
			this.closeReason.delete(ws);
			this.invalidCounts.delete(ws);
			this.rateState.delete(ws);
			this.floodLogged.delete(ws);
			this.onSocketClose(ws, reason);
		});

		this.bySocket.set(ws, { id: -1 as any, ws });
	}

	private allocSlot(): number | null {
		for (let i = 0; i < MAX_PLAYERS; i++) if (!this.slots[i]) return i;
		return null;
	}

	private async upsertDirectory() {
		if (!this.room) return;
		const dirId = this.env.GAME_DIRECTORY.idFromName("directory");
		const dir = this.env.GAME_DIRECTORY.get(dirId);

		const slotsUsed = this.slots.filter(Boolean).length;

		await dir.fetch("https://do/upsert", {
			method: "POST",
			body: JSON.stringify({
				name: this.room.name,
				type: this.room.type,
				slotsUsed,
				slotsTotal: MAX_PLAYERS,
				updatedAt: Date.now(),
			}),
			headers: { "content-type": "application/json" },
		});
	}

	private async removeFromDirectory(name: string) {
		const dirId = this.env.GAME_DIRECTORY.idFromName("directory");
		const dir = this.env.GAME_DIRECTORY.get(dirId);
		await dir.fetch("https://do/remove", {
			method: "POST",
			body: JSON.stringify({ name }),
			headers: { "content-type": "application/json" },
		});
	}

	private onBinary(ws: WebSocket, buf: ArrayBuffer) {
		const packets = decodeTopLevel(buf);
		if (!packets) {
			const invalid = (this.invalidCounts.get(ws) ?? 0) + 1;
			this.invalidCounts.set(ws, invalid);
			if (invalid > MAX_INVALID_PACKETS) {
				this.closeReason.set(ws, 0);
				try {
					ws.close(1002, "invalid packet");
				} catch {}
			}
			return;
		}

		const now = Date.now();
		const rate = this.rateState.get(ws);
		if (!rate || now - rate.windowStart > RATE_WINDOW_MS) {
			this.rateState.set(ws, { windowStart: now, count: packets.length });
		} else {
			rate.count += packets.length;
			if (rate.count > MAX_MESSAGES_PER_WINDOW) {
				if (!this.floodLogged.has(ws)) {
					this.floodLogged.add(ws);
					console.warn("[room] flood detected", {
						count: rate.count,
						windowMs: RATE_WINDOW_MS,
					});
				}
				this.closeReason.set(ws, 0);
				try {
					ws.close(1008, "flood");
				} catch {}
				return;
			}
		}

		for (const pkt of packets) {
			switch (pkt.code) {
				case PacketCode.ClientInfo: {
					const p = this.bySocket.get(ws);
					if (p) p.clientVersion = (pkt as any).version;
					break;
				}

				case PacketCode.CreateGame:
					void this.onCreateGame(ws, pkt as any);
					break;

				case PacketCode.JoinGame:
					void this.onJoinGame(ws, pkt as any);
					break;

				case PacketCode.LeaveGame:
					this.onLeave(ws);
					break;

				case PacketCode.DropPlayer:
					this.onDrop(ws, pkt as any);
					break;

				case PacketCode.Message:
					this.onMessage(ws, pkt as any);
					break;

				case PacketCode.Turn:
					this.onTurn(ws, pkt as any);
					break;

				default:
					break;
			}
		}
	}

	private alreadyJoined(ws: WebSocket) {
		const p = this.bySocket.get(ws);
		return !!p && p.id >= 0;
	}

	private async onCreateGame(
		ws: WebSocket,
		pkt: {
			cookie: number;
			name: string;
			password: string;
			difficulty: number;
		}
	) {
		if (!isValidRoomName(pkt.name ?? "")) {
			this.closeReason.set(ws, 0);
			try {
				ws.close(1002, "invalid name");
			} catch {}
			return;
		}

		if (this.alreadyJoined(ws)) {
			ws.send(
				encodeJoinReject(
					pkt.cookie,
					RejectionReason.JOIN_ALREADY_IN_GAME
				)
			);
			return;
		}

		const hostVersion = this.bySocket.get(ws)?.clientVersion;
		if (hostVersion === undefined) {
			ws.send(
				encodeJoinReject(
					pkt.cookie,
					RejectionReason.JOIN_VERSION_MISMATCH
				)
			);
			return;
		}

		if (this.room) {
			ws.send(
				encodeJoinReject(pkt.cookie, RejectionReason.CREATE_GAME_EXISTS)
			);
			return;
		}

		const slot = this.allocSlot();
		if (slot === null) {
			ws.send(
				encodeJoinReject(pkt.cookie, RejectionReason.JOIN_GAME_FULL)
			);
			return;
		}

		this.room = {
			name: pkt.name,
			password: pkt.password ?? "",
			difficulty: pkt.difficulty >>> 0 || 0,
			seed: (Math.random() * 0xffffffff) >>> 0,
			createdAt: Date.now(),
			type: 0, // TODO
			version: hostVersion >>> 0,
		};

		const player: Player = {
			id: slot,
			ws,
			cookie: pkt.cookie,
			clientVersion: hostVersion,
		};

		this.bySocket.set(ws, player);
		this.slots[slot] = player;

		ws.send(
			encodeJoinAccept(
				pkt.cookie,
				slot,
				this.room.seed,
				this.room.difficulty
			)
		);
		this.broadcast(encodeConnect(slot));

		await this.upsertDirectory();
	}

	private async onJoinGame(
		ws: WebSocket,
		pkt: { cookie: number; name: string; password: string }
	) {
		if (!isValidRoomName(pkt.name ?? "")) {
			this.closeReason.set(ws, 0);
			try {
				ws.close(1002, "invalid name");
			} catch {}
			return;
		}

		if (this.alreadyJoined(ws)) {
			ws.send(
				encodeJoinReject(
					pkt.cookie,
					RejectionReason.JOIN_ALREADY_IN_GAME
				)
			);
			return;
		}

		if (!this.room) {
			ws.send(
				encodeJoinReject(
					pkt.cookie,
					RejectionReason.JOIN_GAME_NOT_FOUND
				)
			);
			return;
		}

		if (pkt.name !== this.room.name) {
			ws.send(
				encodeJoinReject(
					pkt.cookie,
					RejectionReason.JOIN_GAME_NOT_FOUND
				)
			);
			return;
		}

		if ((this.room.password ?? "") !== (pkt.password ?? "")) {
			ws.send(
				encodeJoinReject(
					pkt.cookie,
					RejectionReason.JOIN_INCORRECT_PASSWORD
				)
			);
			return;
		}

		const joinerVersion = this.bySocket.get(ws)?.clientVersion;
		if (
			joinerVersion === undefined ||
			joinerVersion >>> 0 !== this.room.version >>> 0
		) {
			ws.send(
				encodeJoinReject(
					pkt.cookie,
					RejectionReason.JOIN_VERSION_MISMATCH
				)
			);
			return;
		}

		const slot = this.allocSlot();
		if (slot === null) {
			ws.send(
				encodeJoinReject(pkt.cookie, RejectionReason.JOIN_GAME_FULL)
			);
			return;
		}

		const player: Player = {
			id: slot,
			ws,
			cookie: pkt.cookie,
			clientVersion: joinerVersion,
		};

		this.bySocket.set(ws, player);
		this.slots[slot] = player;

		ws.send(
			encodeJoinAccept(
				pkt.cookie,
				slot,
				this.room.seed,
				this.room.difficulty
			)
		);
		this.broadcast(encodeConnect(slot));

		await this.upsertDirectory();
	}

	private onLeave(ws: WebSocket) {
		const p = this.bySocket.get(ws);
		if (p && p.id === 0) {
			this.closeRoomAndKickAll(3);
			return;
		}

		this.closeReason.set(ws, 3);
		try {
			ws.close(1000, "leave");
		} catch {}
	}

	private onDrop(ws: WebSocket, pkt: { id: number; reason: number }) {
		const sender = this.bySocket.get(ws);
		if (!sender || sender.id !== 0) {
			this.closeReason.set(ws, 0);
			try {
				ws.close(1008, "not host");
			} catch {}
			return;
		}

		const id = pkt.id & 0xff;
		const reason = pkt.reason >>> 0;

		if (id === 0) {
			this.closeRoomAndKickAll(reason);
			return;
		}

		const target = this.slots[id];
		if (!target) return;

		this.closeReason.set(target.ws, reason);
		try {
			target.ws.close(1000, "dropped");
		} catch {}
	}

	private onMessage(ws: WebSocket, pkt: { id: number; payload: Uint8Array }) {
		const sender = this.bySocket.get(ws);
		if (!sender || sender.id < 0) return;

		const targetId = pkt.id & 0xff;

		if (targetId === 0xff) {
			for (const p of this.bySocket.values()) {
				if (p.ws === ws) continue;
				if (p.id < 0) continue;
				try {
					p.ws.send(
						encodePacket({
							code: PacketCode.Message,
							id: sender.id,
							payload: pkt.payload,
						})
					);
				} catch {}
			}
			return;
		}

		const target = this.slots[targetId];
		if (!target) return;

		try {
			target.ws.send(
				encodePacket({
					code: PacketCode.Message,
					id: sender.id,
					payload: pkt.payload,
				})
			);
		} catch {}
	}

	private onTurn(ws: WebSocket, pkt: { turn: number }) {
		const sender = this.bySocket.get(ws);
		if (!sender || sender.id < 0) return;

		const buf = encodePacket({
			code: PacketCode.Turn,
			id: sender.id,
			turn: pkt.turn >>> 0,
		});

		for (const p of this.bySocket.values()) {
			if (p.ws === ws) continue;
			if (p.id < 0) continue;
			try {
				p.ws.send(buf);
			} catch {}
		}
	}

	private onSocketClose(ws: WebSocket, reason: number) {
		const p = this.bySocket.get(ws);
		if (!p) return;

		this.bySocket.delete(ws);

		if (p.id === 0) {
			this.closeRoomAndKickAll(reason >>> 0);
			return;
		}

		if (p.id >= 0 && p.id < MAX_PLAYERS && this.slots[p.id]?.ws === ws) {
			this.slots[p.id] = null;
			this.broadcast(encodeDisconnect(p.id, reason >>> 0));
		}

		const still = this.slots.some(Boolean);
		if (!still && this.room) {
			const name = this.room.name;
			this.room = undefined;
			void this.removeFromDirectory(name);
		} else {
			void this.upsertDirectory();
		}
	}

	private closeRoomAndKickAll(reason: number) {
		const r = reason >>> 0;

		const activeIds: number[] = [];
		for (let i = 0; i < MAX_PLAYERS; i++) {
			if (this.slots[i]) activeIds.push(i);
		}

		for (const id of activeIds) {
			this.broadcast(encodeDisconnect(id, r));
		}

		for (const p of this.bySocket.values()) {
			this.closeReason.set(p.ws, r);
			try {
				p.ws.close(1000, "room closed");
			} catch {}
		}

		if (this.room) {
			const name = this.room.name;
			this.room = undefined;
			void this.removeFromDirectory(name);
		}

		this.bySocket.clear();
		this.slots = Array.from({ length: MAX_PLAYERS }, () => null);
	}

	private broadcast(buf: ArrayBuffer) {
		for (const p of this.bySocket.values()) {
			if (p.id < 0) continue;
			try {
				p.ws.send(buf);
			} catch {}
		}
	}
}
