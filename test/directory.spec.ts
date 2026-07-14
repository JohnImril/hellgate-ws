import { env } from "cloudflare:workers";
import { abortAllDurableObjects, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { PacketCode } from "../src/packet";

type StoredGame = {
	name: string;
	type: number;
	slotsUsed: number;
	slotsTotal: number;
	updatedAt: number;
};

function directory(name: string) {
	return env.GAME_DIRECTORY.get(env.GAME_DIRECTORY.idFromName(name));
}

async function readList(stub: DurableObjectStub): Promise<Array<{ type: number; name: string }>> {
	const response = await stub.fetch("https://do/list.bin");
	expect(response.status).toBe(200);
	expect(response.headers.get("content-type")).toBe("application/octet-stream");
	expect(response.headers.get("cache-control")).toBe("no-store");

	const view = new DataView(await response.arrayBuffer());
	expect(view.getUint8(0)).toBe(PacketCode.GameList);
	const count = view.getUint16(1, true);
	let offset = 3;
	const games: Array<{ type: number; name: string }> = [];
	for (let i = 0; i < count; i++) {
		const type = view.getUint32(offset, true);
		offset += 4;
		const length = view.getUint8(offset++);
		const data = new Uint8Array(view.buffer, view.byteOffset + offset, length);
		offset += length;
		games.push({
			type,
			name: String.fromCharCode(...data),
		});
	}
	expect(offset).toBe(view.byteLength);
	return games;
}

describe("GameDirectory", () => {
	it("upserts, lists, and removes games", async () => {
		const stub = directory("directory-crud");
		const upsert = await stub.fetch("https://do/upsert", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				name: "arena",
				type: 3,
				slotsUsed: 1,
				slotsTotal: 4,
				updatedAt: 0,
			}),
		});
		expect(upsert.status).toBe(200);
		expect(await readList(stub)).toEqual([{ type: 3, name: "arena" }]);

		const remove = await stub.fetch("https://do/remove", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ name: "arena" }),
		});
		expect(remove.status).toBe(200);
		expect(await readList(stub)).toEqual([]);
	});

	it("sorts games by most recent update", async () => {
		const stub = directory("directory-sort");
		const stored: Array<[string, StoredGame]> = [
			[
				"old",
				{
					name: "old",
					type: 1,
					slotsUsed: 1,
					slotsTotal: 4,
					updatedAt: 10,
				},
			],
			[
				"new",
				{
					name: "new",
					type: 2,
					slotsUsed: 2,
					slotsTotal: 4,
					updatedAt: 20,
				},
			],
		];
		await runInDurableObject(stub, async (_instance, state) => {
			await state.storage.put("games", stored);
		});
		expect(await readList(stub)).toEqual([
			{ type: 2, name: "new" },
			{ type: 1, name: "old" },
		]);
	});

	it("restores persisted games after eviction", async () => {
		const stub = directory("directory-eviction");
		await stub.fetch("https://do/upsert", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				name: "persisted",
				type: 4,
				slotsUsed: 1,
				slotsTotal: 4,
				updatedAt: 0,
			}),
		});
		await abortAllDurableObjects();
		expect(await readList(directory("directory-eviction"))).toEqual([
			{ type: 4, name: "persisted" },
		]);
	});

	it("rejects incomplete mutations and unknown routes", async () => {
		const stub = directory("directory-invalid");
		const badUpsert = await stub.fetch("https://do/upsert", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ type: 1 }),
		});
		expect(badUpsert.status).toBe(400);

		const badRemove = await stub.fetch("https://do/remove", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({}),
		});
		expect(badRemove.status).toBe(400);

		const missing = await stub.fetch("https://do/missing");
		expect(missing.status).toBe(404);
	});
});
