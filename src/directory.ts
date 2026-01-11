import { encodeGameList } from "./packet";

type GameInfo = {
	name: string;
	type: number;
	slotsUsed: number;
	slotsTotal: number;
	updatedAt: number;
};

type Env = {};

export class GameDirectory implements DurableObject {
	private state: DurableObjectState;
	private games = new Map<string, GameInfo>();

	private loaded = false;
	private loading: Promise<void> | null = null;

	constructor(state: DurableObjectState, _env: Env) {
		this.state = state;
	}

	private async ensureLoaded() {
		if (this.loaded) return;
		if (this.loading) return this.loading;

		this.loading = (async () => {
			const stored =
				(await this.state.storage.get<[string, GameInfo][]>("games")) ??
				[];
			this.games = new Map(stored);
			this.loaded = true;
			this.loading = null;
		})();

		return this.loading;
	}

	private async persist() {
		await this.state.storage.put("games", Array.from(this.games.entries()));
	}

	async fetch(req: Request): Promise<Response> {
		await this.ensureLoaded();

		const url = new URL(req.url);

		if (req.method === "POST" && url.pathname === "/upsert") {
			const body = (await req.json()) as GameInfo;
			if (!body?.name) return new Response("bad", { status: 400 });
			this.games.set(body.name, { ...body, updatedAt: Date.now() });
			await this.persist();
			return new Response("ok");
		}

		if (req.method === "POST" && url.pathname === "/remove") {
			const { name } = (await req.json()) as { name: string };
			if (!name) return new Response("bad", { status: 400 });
			this.games.delete(name);
			await this.persist();
			return new Response("ok");
		}

		if (req.method === "GET" && url.pathname === "/list.bin") {
			const list = Array.from(this.games.values())
				.sort((a, b) => b.updatedAt - a.updatedAt)
				.map((g) => ({ type: g.type ?? 0, name: g.name }));

			const bin = encodeGameList(list);
			return new Response(bin, {
				headers: {
					"content-type": "application/octet-stream",
					"cache-control": "no-store",
				},
			});
		}

		return new Response("Not found", { status: 404 });
	}
}
