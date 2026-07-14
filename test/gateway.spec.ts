import { exports } from "cloudflare:workers";
import { afterEach, describe, expect, it } from "vitest";
import {
	MAX_FRAME_BYTES,
	PacketCode,
	RejectionReason,
	decodeTopLevel,
	encodePacket,
} from "../src/packet";

type Inbox = {
	next(timeoutMs?: number): Promise<ArrayBuffer>;
};

const sockets = new Set<WebSocket>();

function roomName(prefix: string): string {
	return `${prefix}-${crypto.randomUUID().slice(0, 8)}`;
}

function toArrayBuffer(data: ArrayBuffer | ArrayBufferView): ArrayBuffer {
	if (data instanceof ArrayBuffer) return data;
	return data.buffer.slice(
		data.byteOffset,
		data.byteOffset + data.byteLength
	) as ArrayBuffer;
}

function createInbox(ws: WebSocket): Inbox {
	const queued: ArrayBuffer[] = [];
	const waiting: Array<(value: ArrayBuffer) => void> = [];
	ws.addEventListener("message", (event) => {
		if (typeof event.data === "string") return;
		const data = toArrayBuffer(event.data);
		const resolve = waiting.shift();
		if (resolve) resolve(data);
		else queued.push(data);
	});
	return {
		next(timeoutMs = 2000) {
			const value = queued.shift();
			if (value) return Promise.resolve(value);
			return new Promise<ArrayBuffer>((resolve, reject) => {
				const timeout = setTimeout(
					() => reject(new Error("timed out waiting for WebSocket message")),
					timeoutMs
				);
				waiting.push((data) => {
					clearTimeout(timeout);
					resolve(data);
				});
			});
		},
	};
}

async function openClient(path = "/ws"): Promise<{ ws: WebSocket; inbox: Inbox }> {
	const response = await exports.default.fetch(`https://example.com${path}`, {
		headers: { Upgrade: "websocket" },
	});
	expect(response.status).toBe(101);
	const ws = response.webSocket;
	expect(ws).not.toBeNull();
	if (!ws) throw new Error("missing WebSocket on upgrade response");
	const inbox = createInbox(ws);
	ws.accept();
	sockets.add(ws);
	return { ws, inbox };
}

async function nextPacket(inbox: Inbox, code?: PacketCode) {
	for (let i = 0; i < 8; i++) {
		const decoded = decodeTopLevel(await inbox.next());
		if (!decoded || decoded.length !== 1) continue;
		if (code === undefined || decoded[0].code === code) return decoded[0];
	}
	throw new Error(`packet ${String(code)} was not received`);
}

async function expectHandshake(inbox: Inbox) {
	expect(await nextPacket(inbox, PacketCode.ServerInfo)).toEqual({
		code: PacketCode.ServerInfo,
		version: 1,
	});
}

async function createRoom(
	name: string,
	password = "",
	version = 1
): Promise<{ ws: WebSocket; inbox: Inbox; index: number }> {
	const client = await openClient();
	await expectHandshake(client.inbox);
	client.ws.send(encodePacket({ code: PacketCode.ClientInfo, version }));
	client.ws.send(
		encodePacket({
			code: PacketCode.CreateGame,
			cookie: 10,
			name,
			password,
			difficulty: 2,
		})
	);
	const accepted = await nextPacket(client.inbox, PacketCode.JoinAccept);
	expect(accepted).toMatchObject({
		code: PacketCode.JoinAccept,
		cookie: 10,
		index: 0,
		difficulty: 2,
	});
	await nextPacket(client.inbox, PacketCode.Connect);
	return { ...client, index: 0 };
}

async function joinRoom(
	name: string,
	password = "",
	version = 1,
	cookie = 20
): Promise<{ ws: WebSocket; inbox: Inbox; packet: Awaited<ReturnType<typeof nextPacket>> }> {
	const client = await openClient();
	await expectHandshake(client.inbox);
	client.ws.send(encodePacket({ code: PacketCode.ClientInfo, version }));
	client.ws.send(
		encodePacket({
			code: PacketCode.JoinGame,
			cookie,
			name,
			password,
		})
	);
	const packet = await nextPacket(client.inbox);
	return { ...client, packet };
}

function waitForClose(ws: WebSocket): Promise<CloseEvent> {
	return new Promise((resolve, reject) => {
		const timeout = setTimeout(
			() => reject(new Error("timed out waiting for WebSocket close")),
			2000
		);
		ws.addEventListener("close", (event) => {
			clearTimeout(timeout);
			resolve(event);
		});
	});
}

afterEach(() => {
	for (const ws of sockets) {
		try {
			ws.close(1000, "test complete");
		} catch {}
	}
	sockets.clear();
});

describe("WebSocket gateway and GameRoom", () => {
	it("rejects unknown paths and non-upgrade requests", async () => {
		const missing = await exports.default.fetch("https://example.com/missing");
		expect(missing.status).toBe(404);
		expect(await missing.text()).toBe("Not found");

		const noUpgrade = await exports.default.fetch("https://example.com/ws");
		expect(noUpgrade.status).toBe(426);
		expect(await noUpgrade.text()).toBe("Expected websocket");
	});

	it("accepts both gateway paths and sends ServerInfo", async () => {
		for (const path of ["/ws", "/websocket"]) {
			const { inbox } = await openClient(path);
			await expectHandshake(inbox);
		}
	});

	it("creates a room, joins it, and routes direct and broadcast messages", async () => {
		const room = roomName("routing");
		const host = await createRoom(room, "pw", 7);
		const guest = await joinRoom(room, "pw", 7);
		expect(guest.packet).toMatchObject({
			code: PacketCode.JoinAccept,
			cookie: 20,
			index: 1,
		});
		await nextPacket(guest.inbox, PacketCode.Connect);
		expect(await nextPacket(host.inbox, PacketCode.Connect)).toEqual({
			code: PacketCode.Connect,
			id: 1,
		});

		guest.ws.send(
			encodePacket({
				code: PacketCode.Message,
				id: 0,
				payload: new Uint8Array([1, 2, 3]),
			})
		);
		const direct = await nextPacket(host.inbox, PacketCode.Message);
		expect(direct).toMatchObject({ code: PacketCode.Message, id: 1 });
		expect(Array.from((direct as { payload: Uint8Array }).payload)).toEqual([
			1, 2, 3,
		]);

		host.ws.send(
			encodePacket({
				code: PacketCode.Message,
				id: 0xff,
				payload: new Uint8Array([9, 8]),
			})
		);
		const broadcast = await nextPacket(guest.inbox, PacketCode.Message);
		expect(broadcast).toMatchObject({ code: PacketCode.Message, id: 0 });
		expect(Array.from((broadcast as { payload: Uint8Array }).payload)).toEqual([
			9, 8,
		]);
	});

	it("serializes bridge creation when create packets arrive concurrently", async () => {
		const room = roomName("race");
		const client = await openClient();
		await expectHandshake(client.inbox);
		client.ws.send(encodePacket({ code: PacketCode.ClientInfo, version: 1 }));
		const create = encodePacket({
			code: PacketCode.CreateGame,
			cookie: 60,
			name: room,
			password: "",
			difficulty: 1,
		});
		client.ws.send(create);
		client.ws.send(create);

		expect(await nextPacket(client.inbox, PacketCode.JoinAccept)).toMatchObject({
			cookie: 60,
			index: 0,
		});
		await nextPacket(client.inbox, PacketCode.Connect);
		expect(await nextPacket(client.inbox, PacketCode.JoinReject)).toEqual({
			code: PacketCode.JoinReject,
			cookie: 60,
			reason: RejectionReason.JOIN_ALREADY_IN_GAME,
		});
	});

	it("forwards turn updates with the sender id", async () => {
		const room = roomName("turn");
		const host = await createRoom(room);
		const guest = await joinRoom(room);
		expect(guest.packet.code).toBe(PacketCode.JoinAccept);
		await nextPacket(guest.inbox, PacketCode.Connect);
		await nextPacket(host.inbox, PacketCode.Connect);

		host.ws.send(encodePacket({ code: PacketCode.Turn, turn: 0x12345678 }));
		expect(Array.from(new Uint8Array(await guest.inbox.next()))).toEqual([
			PacketCode.Turn,
			0,
			0x78,
			0x56,
			0x34,
			0x12,
		]);
	});

	it("rejects incorrect passwords and protocol versions", async () => {
		const room = roomName("reject");
		await createRoom(room, "secret", 3);

		const wrongPassword = await joinRoom(room, "wrong", 3, 31);
		expect(wrongPassword.packet).toEqual({
			code: PacketCode.JoinReject,
			cookie: 31,
			reason: RejectionReason.JOIN_INCORRECT_PASSWORD,
		});

		const wrongVersion = await joinRoom(room, "secret", 4, 32);
		expect(wrongVersion.packet).toEqual({
			code: PacketCode.JoinReject,
			cookie: 32,
			reason: RejectionReason.JOIN_VERSION_MISMATCH,
		});
	});

	it("rejects a fifth player when the room is full", async () => {
		const room = roomName("full");
		const host = await createRoom(room);
		for (let i = 1; i < 4; i++) {
			const guest = await joinRoom(room, "", 1, 40 + i);
			expect(guest.packet).toMatchObject({
				code: PacketCode.JoinAccept,
				index: i,
			});
			await nextPacket(guest.inbox, PacketCode.Connect);
			await nextPacket(host.inbox, PacketCode.Connect);
		}

		const rejected = await joinRoom(room, "", 1, 50);
		expect(rejected.packet).toEqual({
			code: PacketCode.JoinReject,
			cookie: 50,
			reason: RejectionReason.JOIN_GAME_FULL,
		});
	});

	it("notifies remaining players when a guest leaves", async () => {
		const room = roomName("leave");
		const host = await createRoom(room);
		const guest = await joinRoom(room);
		expect(guest.packet.code).toBe(PacketCode.JoinAccept);
		await nextPacket(guest.inbox, PacketCode.Connect);
		await nextPacket(host.inbox, PacketCode.Connect);

		guest.ws.send(encodePacket({ code: PacketCode.LeaveGame }));
		expect(await nextPacket(host.inbox, PacketCode.Disconnect)).toEqual({
			code: PacketCode.Disconnect,
			id: 1,
			reason: 3,
		});
	});

	it("allows only the host to drop another player", async () => {
		const room = roomName("drop");
		const host = await createRoom(room);
		const guest = await joinRoom(room);
		expect(guest.packet.code).toBe(PacketCode.JoinAccept);
		await nextPacket(guest.inbox, PacketCode.Connect);
		await nextPacket(host.inbox, PacketCode.Connect);

		const unauthorizedClose = waitForClose(guest.ws);
		guest.ws.send(
			encodePacket({ code: PacketCode.DropPlayer, id: 0, reason: 9 })
		);
		expect((await unauthorizedClose).code).toBe(1000);
		expect(await nextPacket(host.inbox, PacketCode.Disconnect)).toEqual({
			code: PacketCode.Disconnect,
			id: 1,
			reason: 0,
		});

		const replacement = await joinRoom(room);
		expect(replacement.packet).toMatchObject({
			code: PacketCode.JoinAccept,
			index: 1,
		});
		await nextPacket(replacement.inbox, PacketCode.Connect);
		await nextPacket(host.inbox, PacketCode.Connect);

		const droppedClose = waitForClose(replacement.ws);
		host.ws.send(
			encodePacket({ code: PacketCode.DropPlayer, id: 1, reason: 12 })
		);
		expect((await droppedClose).code).toBe(1000);
		expect(await nextPacket(host.inbox, PacketCode.Disconnect)).toEqual({
			code: PacketCode.Disconnect,
			id: 1,
			reason: 12,
		});
	});

	it("closes invalid and oversized clients with protocol-specific codes", async () => {
		const invalid = await openClient();
		await expectHandshake(invalid.inbox);
		const invalidClose = waitForClose(invalid.ws);
		invalid.ws.send(new Uint8Array([0xff]).buffer);
		expect((await invalidClose).code).toBe(1002);

		const oversized = await openClient();
		await expectHandshake(oversized.inbox);
		const oversizedClose = waitForClose(oversized.ws);
		oversized.ws.send(new Uint8Array(MAX_FRAME_BYTES + 1).buffer);
		expect((await oversizedClose).code).toBe(1009);
	});

	it("returns active rooms through the lobby endpoint", async () => {
		const room = roomName("lobby");
		await createRoom(room);
		await scheduler.wait(10);

		const lobby = await openClient();
		await expectHandshake(lobby.inbox);
		lobby.ws.send(new Uint8Array([PacketCode.GameList]).buffer);
		const view = new DataView(await lobby.inbox.next());
		expect(view.getUint8(0)).toBe(PacketCode.GameList);
		const count = view.getUint16(1, true);
		let offset = 3;
		const names: string[] = [];
		for (let i = 0; i < count; i++) {
			offset += 4;
			const length = view.getUint8(offset++);
			const value = new Uint8Array(
				view.buffer,
				view.byteOffset + offset,
				length
			);
			offset += length;
			names.push(String.fromCharCode(...value));
		}
		expect(names).toContain(room);
	});
});
