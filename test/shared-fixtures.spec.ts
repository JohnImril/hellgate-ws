import { describe, expect, it } from "vitest";
import { decodeTopLevel } from "../src/packet";
import fixtureJson from "../protocol/fixtures/v1.json";

type Vector = { name: string; direction: string; hex: string };
const fixture = fixtureJson as { vectors: Vector[] };

function fromHex(hex: string): Uint8Array {
	const bytes = new Uint8Array(hex.length / 2);
	for (let index = 0; index < bytes.length; index += 1) {
		bytes[index] = Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16);
	}
	return bytes;
}

describe("shared client/server protocol fixtures", () => {
	it.each(fixture.vectors)("$name", ({ hex }) => {
		const bytes = fromHex(hex);
		expect(bytes.byteLength).toBeGreaterThan(0);
	});

	it.each(fixture.vectors.filter(({ direction }) => direction !== "server-to-client"))(
		"decodes inbound $name",
		({ hex }) => {
			const bytes = fromHex(hex);
			const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
			expect(decodeTopLevel(buffer)).not.toBeNull();
		}
	);
});
