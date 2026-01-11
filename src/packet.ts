export enum PacketCode {
	Batch = 0x00,
	Message = 0x01,
	Turn = 0x02,
	DropPlayer = 0x03,

	JoinAccept = 0x12,
	Connect = 0x13,
	Disconnect = 0x14,
	JoinReject = 0x15,

	GameList = 0x21,
	CreateGame = 0x22,
	JoinGame = 0x23,
	LeaveGame = 0x24,

	ClientInfo = 0x31,
	ServerInfo = 0x32,
}

export enum RejectionReason {
	JOIN_SUCCESS = 0x00,
	JOIN_ALREADY_IN_GAME = 0x01,
	JOIN_GAME_NOT_FOUND = 0x02,
	JOIN_INCORRECT_PASSWORD = 0x03,
	JOIN_VERSION_MISMATCH = 0x04,
	JOIN_GAME_FULL = 0x05,
	CREATE_GAME_EXISTS = 0x06,
}

export type DecodedPacket =
	| { code: PacketCode.ServerInfo; version: number }
	| { code: PacketCode.ClientInfo; version: number }
	| {
			code: PacketCode.GameList;
			games?: Array<{ type: number; name: string }>;
	  }
	| {
			code: PacketCode.CreateGame;
			cookie: number;
			name: string;
			password: string;
			difficulty: number;
	  }
	| {
			code: PacketCode.JoinGame;
			cookie: number;
			name: string;
			password: string;
	  }
	| { code: PacketCode.LeaveGame }
	| {
			code: PacketCode.JoinAccept;
			cookie: number;
			index: number;
			seed: number;
			difficulty: number;
	  }
	| { code: PacketCode.JoinReject; cookie: number; reason: number }
	| { code: PacketCode.Connect; id: number }
	| { code: PacketCode.Disconnect; id: number; reason: number }
	| { code: PacketCode.DropPlayer; id: number; reason: number }
	| { code: PacketCode.Message; id: number; payload: Uint8Array }
	| { code: PacketCode.Turn; turn: number; id?: number }
	| { code: number; [k: string]: any };

function u8(view: DataView, o: number) {
	return view.getUint8(o);
}
function u16(view: DataView, o: number) {
	return view.getUint16(o, true);
}
function u32(view: DataView, o: number) {
	return view.getUint32(o, true);
}

function pushU8(out: number[], v: number) {
	out.push(v & 0xff);
}
function pushU16LE(out: number[], v: number) {
	out.push(v & 0xff, (v >>> 8) & 0xff);
}
function pushU32LE(out: number[], v: number) {
	out.push(v & 0xff, (v >>> 8) & 0xff, (v >>> 16) & 0xff, (v >>> 24) & 0xff);
}

function readString(
	view: DataView,
	o: number
): { value: string; next: number } {
	const len = u8(view, o);
	o += 1;
	const bytes = new Uint8Array(view.buffer, view.byteOffset + o, len);
	o += len;
	let s = "";
	for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
	return { value: s, next: o };
}

function writeString(out: number[], s: string) {
	const bytes = new Uint8Array(s.length);
	for (let i = 0; i < s.length; i++) bytes[i] = s.charCodeAt(i) & 0xff;
	pushU8(out, bytes.length);
	for (const b of bytes) out.push(b);
}

function readBytes(
	view: DataView,
	o: number
): { value: Uint8Array; next: number } {
	const len = u32(view, o);
	o += 4;
	const bytes = new Uint8Array(view.buffer, view.byteOffset + o, len);
	o += len;
	return { value: new Uint8Array(bytes), next: o };
}

function writeBytes(out: number[], b: Uint8Array) {
	pushU32LE(out, b.length);
	for (const x of b) out.push(x);
}

function decodeSingle(
	view: DataView,
	offset: number
): { pkt: DecodedPacket; next: number } | null {
	const code = u8(view, offset);
	offset += 1;

	switch (code) {
		case PacketCode.ClientInfo: {
			const version = u32(view, offset);
			offset += 4;
			return { pkt: { code, version }, next: offset };
		}

		case PacketCode.ServerInfo: {
			const version = u32(view, offset);
			offset += 4;
			return { pkt: { code, version }, next: offset };
		}

		case PacketCode.GameList: {
			return { pkt: { code }, next: offset };
		}

		case PacketCode.CreateGame: {
			const cookie = u32(view, offset);
			offset += 4;
			const n1 = readString(view, offset);
			offset = n1.next;
			const n2 = readString(view, offset);
			offset = n2.next;
			const difficulty = u32(view, offset);
			offset += 4;
			return {
				pkt: {
					code,
					cookie,
					name: n1.value,
					password: n2.value,
					difficulty,
				},
				next: offset,
			};
		}

		case PacketCode.JoinGame: {
			const cookie = u32(view, offset);
			offset += 4;
			const n1 = readString(view, offset);
			offset = n1.next;
			const n2 = readString(view, offset);
			offset = n2.next;
			return {
				pkt: { code, cookie, name: n1.value, password: n2.value },
				next: offset,
			};
		}

		case PacketCode.LeaveGame:
			return { pkt: { code }, next: offset };

		case PacketCode.JoinAccept: {
			const cookie = u32(view, offset);
			offset += 4;
			const index = u8(view, offset);
			offset += 1;
			const seed = u32(view, offset);
			offset += 4;
			const difficulty = u32(view, offset);
			offset += 4;
			return {
				pkt: { code, cookie, index, seed, difficulty },
				next: offset,
			};
		}

		case PacketCode.JoinReject: {
			const cookie = u32(view, offset);
			offset += 4;
			const reason = u8(view, offset);
			offset += 1;
			return { pkt: { code, cookie, reason }, next: offset };
		}

		case PacketCode.Connect: {
			const id = u8(view, offset);
			offset += 1;
			return { pkt: { code, id }, next: offset };
		}

		case PacketCode.Disconnect: {
			const id = u8(view, offset);
			offset += 1;
			const reason = u32(view, offset);
			offset += 4;
			return { pkt: { code, id, reason }, next: offset };
		}

		case PacketCode.DropPlayer: {
			const id = u8(view, offset);
			offset += 1;
			const reason = u32(view, offset);
			offset += 4;
			return { pkt: { code, id, reason }, next: offset };
		}

		case PacketCode.Message: {
			const id = u8(view, offset);
			offset += 1;
			const b = readBytes(view, offset);
			offset = b.next;
			return { pkt: { code, id, payload: b.value }, next: offset };
		}

		case PacketCode.Turn: {
			if (offset + 4 > view.byteLength) return null;
			const turn = u32(view, offset);
			offset += 4;
			return { pkt: { code, turn }, next: offset };
		}

		default:
			return null;
	}
}

function decodeFromOffsetFlat(
	view: DataView,
	offset: number
): { pkts: DecodedPacket[]; next: number } | null {
	const code = u8(view, offset);

	if (code !== PacketCode.Batch) {
		const one = decodeSingle(view, offset);
		if (!one) return null;
		return { pkts: [one.pkt], next: one.next };
	}

	offset += 1;
	if (offset + 2 > view.byteLength) return null;
	const count = u16(view, offset);
	offset += 2;

	const out: DecodedPacket[] = [];
	for (let i = 0; i < count; i++) {
		const r = decodeFromOffsetFlat(view, offset);
		if (!r) return null;
		out.push(...r.pkts);
		offset = r.next;
	}
	return { pkts: out, next: offset };
}

export function decodeTopLevel(buf: ArrayBuffer): DecodedPacket[] | null {
	const view = new DataView(buf);
	if (view.byteLength < 1) return null;
	const r = decodeFromOffsetFlat(view, 0);
	return r ? r.pkts : null;
}

export function encodeServerInfo(version = 1): ArrayBuffer {
	return encodePacket({ code: PacketCode.ServerInfo, version });
}

export function encodeGameList(
	games: Array<{ type: number; name: string }>
): ArrayBuffer {
	return encodePacket({ code: PacketCode.GameList, games });
}

export function encodeJoinAccept(
	cookie: number,
	index: number,
	seed: number,
	difficulty: number
): ArrayBuffer {
	return encodePacket({
		code: PacketCode.JoinAccept,
		cookie,
		index,
		seed,
		difficulty,
	});
}

export function encodeJoinReject(cookie: number, reason: number): ArrayBuffer {
	return encodePacket({ code: PacketCode.JoinReject, cookie, reason });
}

export function encodeConnect(id: number): ArrayBuffer {
	return encodePacket({ code: PacketCode.Connect, id });
}

export function encodeDisconnect(id: number, reason: number): ArrayBuffer {
	return encodePacket({ code: PacketCode.Disconnect, id, reason });
}

export function encodePacket(pkt: DecodedPacket): ArrayBuffer {
	const out: number[] = [];
	pushU8(out, (pkt as any).code);

	switch ((pkt as any).code) {
		case PacketCode.ServerInfo:
		case PacketCode.ClientInfo:
			pushU32LE(out, (pkt as any).version >>> 0);
			break;

		case PacketCode.GameList: {
			const games = (pkt as any).games ?? [];
			pushU16LE(out, games.length);
			for (const g of games) {
				pushU32LE(out, (g.type ?? 0) >>> 0);
				writeString(out, String(g.name ?? ""));
			}
			break;
		}

		case PacketCode.JoinAccept:
			pushU32LE(out, (pkt as any).cookie >>> 0);
			pushU8(out, (pkt as any).index & 0xff);
			pushU32LE(out, (pkt as any).seed >>> 0);
			pushU32LE(out, (pkt as any).difficulty >>> 0);
			break;

		case PacketCode.JoinReject:
			pushU32LE(out, (pkt as any).cookie >>> 0);
			pushU8(out, (pkt as any).reason & 0xff);
			break;

		case PacketCode.Connect:
			pushU8(out, (pkt as any).id & 0xff);
			break;

		case PacketCode.Disconnect:
			pushU8(out, (pkt as any).id & 0xff);
			pushU32LE(out, (pkt as any).reason >>> 0);
			break;

		case PacketCode.DropPlayer:
			pushU8(out, (pkt as any).id & 0xff);
			pushU32LE(out, (pkt as any).reason >>> 0);
			break;

		case PacketCode.Message:
			pushU8(out, (pkt as any).id & 0xff);
			writeBytes(out, (pkt as any).payload ?? new Uint8Array());
			break;

		case PacketCode.Turn: {
			if ((pkt as any).id !== undefined)
				pushU8(out, (pkt as any).id & 0xff);
			pushU32LE(out, (pkt as any).turn >>> 0);
			break;
		}

		case PacketCode.LeaveGame:
			break;

		case PacketCode.CreateGame:
			pushU32LE(out, (pkt as any).cookie >>> 0);
			writeString(out, (pkt as any).name ?? "");
			writeString(out, (pkt as any).password ?? "");
			pushU32LE(out, (pkt as any).difficulty >>> 0);
			break;

		case PacketCode.JoinGame:
			pushU32LE(out, (pkt as any).cookie >>> 0);
			writeString(out, (pkt as any).name ?? "");
			writeString(out, (pkt as any).password ?? "");
			break;

		default:
			break;
	}

	return new Uint8Array(out).buffer;
}

export function sniffLobbyAction(buf: ArrayBuffer): {
	clientInfoVersion?: number;
	wantsGameList?: boolean;
	create?: { cookie: number; name: string };
	join?: { cookie: number; name: string };
} | null {
	const pkts = decodeTopLevel(buf);
	if (!pkts) return null;

	const out: any = {};
	for (const p of pkts) {
		if (p.code === PacketCode.ClientInfo)
			out.clientInfoVersion = (p as any).version;
		if (p.code === PacketCode.GameList) out.wantsGameList = true;
		if (p.code === PacketCode.CreateGame)
			out.create = { cookie: (p as any).cookie, name: (p as any).name };
		if (p.code === PacketCode.JoinGame)
			out.join = { cookie: (p as any).cookie, name: (p as any).name };
	}
	return out;
}
