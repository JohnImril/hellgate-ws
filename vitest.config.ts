import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

export default defineConfig({
	plugins: [
		cloudflareTest({
			wrangler: { configPath: "./wrangler.toml" },
		}),
	],
	test: {
		fileParallelism: false,
		isolate: false,
		maxWorkers: 1,
	},
});
