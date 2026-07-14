import { describe, expect, it } from "vitest";
import {
	MAX_BATCH_COUNT,
	MAX_MESSAGE_BYTES,
	PacketCode,
	RejectionReason,
	decodeTopLevel,
	encodeConnect,
	encodeDisconnect,
	encodeGameList,
	encodeJoinAccept,
	encodeJoinReject,
	encodePacket,
	encodeServerInfo,
	sniffLobbyAction,
} from "../src/packet";

function bytes(buffer: ArrayBuffer): number[] {
	return Array.from(new Uint8Array(buffer));
}

function buffer(values: number[]): ArrayBuffer {
	return new Uint8Array(values).buffer;
}

describe("binary protocol", () => {
	it("encodes and decodes ServerInfo in little-endian order", () => {
		const encoded = encodeServerInfo(0x12345678);
		expect(bytes(encoded)).toEqual([PacketCode.ServerInfo, 0x78, 0x56, 0x34, 0x12]);
		expect(decodeTopLevel(encoded)).toEqual([
			{ code: PacketCode.ServerInfo, version: 0x12345678 },
		]);
	});

	it("round-trips ClientInfo", () => {
		const encoded = encodePacket({ code: PacketCode.ClientInfo, version: 7 });
		expect(decodeTopLevel(encoded)).toEqual([
			{ code: PacketCode.ClientInfo, version: 7 },
		]);
	});

	it("round-trips CreateGame", () => {
		const encoded = encodePacket({
			code: PacketCode.CreateGame,
			cookie: 0x12345678,
			name: "room",
			password: "pw",
			difficulty: 3,
		});
		expect(decodeTopLevel(encoded)).toEqual([
			{
				code: PacketCode.CreateGame,
				cookie: 0x12345678,
				name: "room",
				password: "pw",
				difficulty: 3,
			},
		]);
	});

	it("round-trips JoinGame and LeaveGame", () => {
		const join = encodePacket({
			code: PacketCode.JoinGame,
			cookie: 9,
			name: "room",
			password: "secret",
		});
		expect(decodeTopLevel(join)).toEqual([
			{
				code: PacketCode.JoinGame,
				cookie: 9,
				name: "room",
				password: "secret",
			},
		]);

		const leave = encodePacket({ code: PacketCode.LeaveGame });
		expect(decodeTopLevel(leave)).toEqual([{ code: PacketCode.LeaveGame }]);
	});

	it("round-trips join responses", () => {
		const accepted = encodeJoinAccept(17, 2, 0x10203040, 4);
		expect(decodeTopLevel(accepted)).toEqual([
			{
				code: PacketCode.JoinAccept,
				cookie: 17,
				index: 2,
				seed: 0x10203040,
				difficulty: 4,
			},
		]);

		const rejected = encodeJoinReject(
			17,
			RejectionReason.JOIN_INCORRECT_PASSWORD
		);
		expect(decodeTopLevel(rejected)).toEqual([
			{
				code: PacketCode.JoinReject,
				cookie: 17,
				reason: RejectionReason.JOIN_INCORRECT_PASSWORD,
			},
		]);
	});

	it("round-trips connection packets", () => {
		expect(decodeTopLevel(encodeConnect(3))).toEqual([
			{ code: PacketCode.Connect, id: 3 },
		]);
		expect(decodeTopLevel(encodeDisconnect(2, 0x10203040))).toEqual([
			{ code: PacketCode.Disconnect, id: 2, reason: 0x10203040 },
		]);
		const dropped = encodePacket({
			code: PacketCode.DropPlayer,
			id: 1,
			reason: 8,
		});
		expect(decodeTopLevel(dropped)).toEqual([
			{ code: PacketCode.DropPlayer, id: 1, reason: 8 },
		]);
	});

	it("round-trips message payloads", () => {
		const encoded = encodePacket({
			code: PacketCode.Message,
			id: 0xff,
			payload: new Uint8Array([0, 1, 127, 255]),
		});
		const decoded = decodeTopLevel(encoded);
		expect(decoded).toHaveLength(1);
		expect(decoded?.[0]).toMatchObject({ code: PacketCode.Message, id: 0xff });
		expect(Array.from((decoded?.[0] as { payload: Uint8Array }).payload)).toEqual([
			0, 1, 127, 255,
		]);
	});

	it("uses distinct client and server Turn layouts", () => {
		const inbound = encodePacket({ code: PacketCode.Turn, turn: 0x12345678 });
		expect(bytes(inbound)).toEqual([PacketCode.Turn, 0x78, 0x56, 0x34, 0x12]);
		expect(decodeTopLevel(inbound)).toEqual([
			{ code: PacketCode.Turn, turn: 0x12345678 },
		]);

		const outbound = encodePacket({
			code: PacketCode.Turn,
			id: 2,
			turn: 0x12345678,
		});
		expect(bytes(outbound)).toEqual([
			PacketCode.Turn,
			2,
			0x78,
			0x56,
			0x34,
			0x12,
		]);
	});

	it("encodes a GameList response deterministically", () => {
		expect(
			bytes(
				encodeGameList([
					{ type: 2, name: "a" },
					{ type: 0x12345678, name: "bc" },
				])
			)
		).toEqual([
			PacketCode.GameList,
			2,
			0,
			2,
			0,
			0,
			0,
			1,
			97,
			0x78,
			0x56,
			0x34,
			0x12,
			2,
			98,
			99,
		]);
	});

	it("flattens a batch", () => {
		const batch = buffer([
			PacketCode.Batch,
			2,
			0,
			PacketCode.ClientInfo,
			1,
			0,
			0,
			0,
			PacketCode.LeaveGame,
		]);
		expect(decodeTopLevel(batch)).toEqual([
			{ code: PacketCode.ClientInfo, version: 1 },
			{ code: PacketCode.LeaveGame },
		]);
	});

	it("rejects nested batches and oversized batch counts", () => {
		expect(
			decodeTopLevel(
				buffer([
					PacketCode.Batch,
					1,
					0,
					PacketCode.Batch,
					0,
					0,
				])
			)
		).toBeNull();
		expect(
			decodeTopLevel(
				buffer([
					PacketCode.Batch,
					(MAX_BATCH_COUNT + 1) & 0xff,
					(MAX_BATCH_COUNT + 1) >>> 8,
				])
			)
		).toBeNull();
	});

	const malformedPackets: Array<[number[]]> = [
		[[]],
		[[0xff]],
		[[PacketCode.ClientInfo]],
		[[PacketCode.ClientInfo, 1, 2, 3]],
		[[PacketCode.Message, 1, 4, 0, 0, 0, 1, 2]],
		[[PacketCode.JoinAccept, 1, 0, 0, 0, 1, 2, 3, 4, 5, 6, 7]],
	];

	it.each(malformedPackets)("rejects malformed packet %#", (value) => {
		expect(decodeTopLevel(buffer(value))).toBeNull();
	});

	it("rejects trailing bytes after a packet", () => {
		expect(
			decodeTopLevel(buffer([PacketCode.LeaveGame, PacketCode.LeaveGame]))
		).toBeNull();
	});

	it("rejects strings that cannot fit in the wire length field", () => {
		expect(() =>
			encodePacket({
				code: PacketCode.JoinGame,
				cookie: 1,
				name: "r",
				password: "x".repeat(256),
			})
		).toThrow(/string/i);
	});

	it("rejects message payloads above the protocol limit", () => {
		expect(() =>
			encodePacket({
				code: PacketCode.Message,
				id: 1,
				payload: new Uint8Array(MAX_MESSAGE_BYTES + 1),
			})
		).toThrow(/message/i);
	});

	it("sniffs a batched lobby action", () => {
		const name = "arena";
		const create = bytes(
			encodePacket({
				code: PacketCode.CreateGame,
				cookie: 22,
				name,
				password: "pw",
				difficulty: 1,
			})
		);
		const batch = buffer([
			PacketCode.Batch,
			2,
			0,
			PacketCode.ClientInfo,
			7,
			0,
			0,
			0,
			...create,
		]);
		expect(sniffLobbyAction(batch)).toEqual({
			clientInfoVersion: 7,
			create: { cookie: 22, name },
		});
	});
});
