import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import promptModelExtension from "../index.js";

const MODEL = { provider: "anthropic", id: "claude-sonnet-4-20250514" };

interface FakeCommand {
	description: string;
	handler: (args: string, ctx: any) => Promise<void>;
}

class FakePi {
	commands = new Map<string, FakeCommand>();
	tools = new Map<string, any>();
	hooks = new Map<string, Array<(event: any, ctx: any) => Promise<any> | any>>();

	registerMessageRenderer() {}
	registerCommand(name: string, command: FakeCommand) { this.commands.set(name, command); }
	registerTool(tool: any) { this.tools.set(tool.name, tool); }
	getCommands() { return []; }
	on(event: string, handler: (event: any, ctx: any) => Promise<any> | any) {
		const handlers = this.hooks.get(event) ?? [];
		handlers.push(handler);
		this.hooks.set(event, handlers);
	}
	async emit(event: string, payload: any, ctx: any) {
		for (const handler of this.hooks.get(event) ?? []) await handler(payload, ctx);
	}
	async setModel() { return true; }
	getThinkingLevel() { return "medium" as const; }
	setThinkingLevel() {}
	sendUserMessage() {}
	sendMessage() {}
}

async function withTempHome(run: (root: string) => Promise<void>) {
	const root = mkdtempSync(join(tmpdir(), "pi-prompt-index-commands-"));
	const previousHome = process.env.HOME;
	process.env.HOME = root;
	try {
		await run(root);
	} finally {
		process.env.HOME = previousHome;
		rmSync(root, { recursive: true, force: true });
	}
}

function createContext(cwd: string) {
	let customCalls = 0;
	const ctx = {
		cwd,
		model: MODEL,
		modelRegistry: {
			find(provider: string, id: string) {
				return provider === MODEL.provider && id === MODEL.id ? MODEL : undefined;
			},
			getAll() { return [MODEL]; },
			getAvailable() { return [MODEL]; },
			async getApiKeyAndHeaders() { return { ok: true, apiKey: "token" }; },
			isUsingOAuth() { return false; },
		},
		hasUI: true,
		ui: {
			notify() {},
			setStatus() {},
			theme: { fg(_token: string, text: string) { return text; }, bold(text: string) { return text; } },
			custom(_factory: any) {
				customCalls += 1;
				return Promise.resolve(undefined);
			},
		},
		isIdle() { return false; },
		async waitForIdle() {},
		sessionManager: {
			getLeafId() { return "root"; },
			getBranch() { return []; },
		},
		async navigateTree() { return { cancelled: false }; },
	};
	return { ctx, getCustomCalls: () => customCalls };
}

test("extension registers dynamic prompt commands and removes chain-prompts", async () => {
	await withTempHome(async (root) => {
		const cwd = join(root, "project");
		mkdirSync(join(cwd, ".pi", "prompts"), { recursive: true });
		writeFileSync(join(cwd, ".pi", "prompts", "review.md"), "---\nmodel: anthropic/claude-sonnet-4-20250514\n---\nReview $@");

		const pi = new FakePi();
		const { ctx } = createContext(cwd);
		promptModelExtension(pi as never);
		await pi.emit("session_start", {}, ctx);

		assert.ok(pi.commands.get("review"));
		assert.equal(pi.commands.has("chain-prompts"), false);
		assert.equal(pi.commands.has("prompt-tool"), false);
	});
});
