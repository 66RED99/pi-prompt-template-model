import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import promptModelExtension from "../index.js";
import {
	PROMPT_TEMPLATE_SUBAGENT_REQUEST_EVENT,
	PROMPT_TEMPLATE_SUBAGENT_RESPONSE_EVENT,
	PROMPT_TEMPLATE_SUBAGENT_STARTED_EVENT,
} from "../subagent-runtime.js";

const MODEL_ID = "claude-sonnet-4-20250514";
const ACTIVE_MODEL = { provider: "anthropic", id: MODEL_ID };

interface FakeCommand {
	description: string;
	handler: (args: string, ctx: any) => Promise<void>;
}

interface FakeTool {
	name: string;
	execute: (id: string, params: Record<string, unknown>) => Promise<any>;
}

class FakePi {
	commands = new Map<string, FakeCommand>();
	tools = new Map<string, FakeTool>();
	hooks = new Map<string, Array<(event: any, ctx: any) => Promise<any> | any>>();
	bus = new Map<string, Array<(data: unknown) => void>>();
	events = {
		emit: (channel: string, data: unknown) => {
			for (const handler of this.bus.get(channel) ?? []) {
				handler(data);
			}
		},
		on: (channel: string, handler: (data: unknown) => void) => {
			const handlers = this.bus.get(channel) ?? [];
			handlers.push(handler);
			this.bus.set(channel, handlers);
			return () => {
				const current = this.bus.get(channel) ?? [];
				this.bus.set(channel, current.filter((candidate) => candidate !== handler));
			};
		},
	};
	skillCommands: Array<{ name: string; source: "skill"; sourceInfo: { path: string } }> = [];
	userMessages: string[] = [];
	setModelCalls: string[] = [];
	thinkingCalls: string[] = [];
	currentModel = ACTIVE_MODEL;
	private thinking = "medium";

	registerMessageRenderer() {}

	registerCommand(name: string, command: FakeCommand) {
		this.commands.set(name, command);
	}

	registerTool(tool: FakeTool) {
		this.tools.set(tool.name, tool);
	}

	getCommands() {
		return this.skillCommands;
	}

	on(event: string, handler: (event: any, ctx: any) => Promise<any> | any) {
		const handlers = this.hooks.get(event) ?? [];
		handlers.push(handler);
		this.hooks.set(event, handlers);
	}

	async emit(event: string, payload: any, ctx: any) {
		for (const handler of this.hooks.get(event) ?? []) {
			await handler(payload, ctx);
		}
	}

	async emitWithResult(event: string, payload: any, ctx: any) {
		let combined: Record<string, unknown> | undefined;
		for (const handler of this.hooks.get(event) ?? []) {
			const result = await handler(payload, ctx);
			if (!result || typeof result !== "object") continue;
			combined = { ...(combined ?? {}), ...(result as Record<string, unknown>) };
		}
		return combined;
	}

	async setModel(model: { provider: string; id: string }) {
		this.setModelCalls.push(`${model.provider}/${model.id}`);
		this.currentModel = model;
		return true;
	}

	getThinkingLevel() {
		return this.thinking;
	}

	setThinkingLevel(level: string) {
		this.thinking = level;
		this.thinkingCalls.push(level);
	}

	sendUserMessage(content: string) {
		this.userMessages.push(content);
	}

	sendMessage(_message?: any) {}
}

function stripLoopPrefix(msg: string): string {
	return msg.replace(/^\[.*?\]\n\n/, "");
}

async function withTempHome(run: (root: string) => Promise<void>) {
	const root = mkdtempSync(join(tmpdir(), "pi-prompt-template-model-"));
	const previousHome = process.env.HOME;
	process.env.HOME = root;
	try {
		await run(root);
	} finally {
		process.env.HOME = previousHome;
		rmSync(root, { recursive: true, force: true });
	}
}

function createContext(
	cwd: string,
	pi: FakePi,
	models: Array<{ provider: string; id: string }> = [ACTIVE_MODEL],
	options?: { branchEntries?: () => any[]; waitForIdle?: () => Promise<void> },
) {
	let navigateCount = 0;
	const notifications: string[] = [];
	const modelRegistry = {
		find(provider: string, modelId: string) {
			return models.find((model) => model.provider === provider && model.id === modelId);
		},
		getAll() {
			return models;
		},
		getAvailable() {
			return models;
		},
			async getApiKeyAndHeaders() {
				return { ok: true, apiKey: "token" };
			},
		isUsingOAuth() {
			return false;
		},
	};

	const ctx = {
		cwd,
		get model() {
			return pi.currentModel;
		},
		modelRegistry,
		hasUI: true,
		ui: {
			notify(message: string) {
				notifications.push(message);
			},
			setStatus() {},
			theme: {
				fg(_token: string, text: string) {
					return text;
				},
			},
		},
		isIdle() {
			return false;
		},
		async waitForIdle() {
			if (options?.waitForIdle) {
				await options.waitForIdle();
			}
		},
		sessionManager: {
			getLeafId() {
				return "root";
			},
			getBranch() {
				return options?.branchEntries ? options.branchEntries() : [];
			},
		},
		async navigateTree() {
			navigateCount++;
			return { cancelled: false };
		},
	};

	return {
		ctx,
		getNavigateCount: () => navigateCount,
		getNotifications: () => notifications,
	};
}

function createBranchingContext(
	cwd: string,
	pi: FakePi,
	models: Array<{ provider: string; id: string }> = [ACTIVE_MODEL],
	initialEntries: any[] = [{ id: "root", type: "message", message: { role: "user", content: [{ type: "text", text: "start" }] } }],
) {
	const branch = [...initialEntries];
	const notifications: string[] = [];
	let navigateCount = 0;
	let entryCounter = 0;
	const queuedAssistantEntries: Array<Array<{ type: string; [key: string]: unknown }>> = [];
	const nextId = (prefix: string) => `${prefix}-${++entryCounter}`;

	const modelRegistry = {
		find(provider: string, modelId: string) {
			return models.find((model) => model.provider === provider && model.id === modelId);
		},
		getAll() {
			return models;
		},
		getAvailable() {
			return models;
		},
			async getApiKeyAndHeaders() {
				return { ok: true, apiKey: "token" };
			},
		isUsingOAuth() {
			return false;
		},
	};

	pi.sendUserMessage = (content: string) => {
		pi.userMessages.push(content);
		branch.push({
			id: nextId("user"),
			type: "message",
			message: {
				role: "user",
				content: [{ type: "text", text: content }],
			},
		});
	};

	pi.sendMessage = (message: any) => {
		branch.push({
			id: nextId("custom"),
			type: "custom_message",
			customType: message.customType,
			content: message.content,
			display: message.display,
			details: message.details,
		});
	};

	const ctx = {
		cwd,
		get model() {
			return pi.currentModel;
		},
		modelRegistry,
		hasUI: false,
		ui: {
			notify(message: string) {
				notifications.push(message);
			},
			setStatus() {},
			theme: {
				fg(_token: string, text: string) {
					return text;
				},
			},
		},
		isIdle() {
			return false;
		},
		async waitForIdle() {
			const nextAssistant = queuedAssistantEntries.shift();
			if (!nextAssistant) return;
			branch.push({
				id: nextId("assistant"),
				type: "message",
				message: {
					role: "assistant",
					content: nextAssistant,
				},
			});
		},
		sessionManager: {
			getLeafId() {
				return branch[branch.length - 1]?.id ?? null;
			},
			getBranch() {
				return branch;
			},
		},
		async navigateTree() {
			navigateCount++;
			return { cancelled: false };
		},
	};

	return {
		ctx,
		branch,
		queueAssistantText(text: string) {
			queuedAssistantEntries.push([{ type: "text", text }]);
		},
		queueAssistantContent(content: Array<{ type: string; [key: string]: unknown }>) {
			queuedAssistantEntries.push(content);
		},
		getNavigateCount: () => navigateCount,
		getNotifications: () => notifications,
	};
}

async function withSubagentRuntime(root: string, run: () => Promise<void>) {
	const runtimeRoot = join(root, "runtime-subagent");
	mkdirSync(runtimeRoot, { recursive: true });
	writeFileSync(
		join(runtimeRoot, "agents.js"),
		"export function discoverAgents(){ return { agents: [{ name: 'delegate' }, { name: 'reviewer' }, { name: 'worker' }] }; }",
	);
	const previousRuntime = process.env.PI_SUBAGENT_RUNTIME_ROOT;
	process.env.PI_SUBAGENT_RUNTIME_ROOT = runtimeRoot;
	try {
		await run();
	} finally {
		if (previousRuntime === undefined) delete process.env.PI_SUBAGENT_RUNTIME_ROOT;
		else process.env.PI_SUBAGENT_RUNTIME_ROOT = previousRuntime;
	}
}

test("bare --loop with --no-converge respects no-converge and converges only on default", async () => {
	await withTempHome(async (root) => {
		const cwd = join(root, "project");
		mkdirSync(join(cwd, ".pi", "prompts"), { recursive: true });
		writeFileSync(join(cwd, ".pi", "prompts", "deslop.md"), `---\nmodel: ${MODEL_ID}\n---\nARGS:$@`);

		const pi = new FakePi();
		promptModelExtension(pi as never);
		const { ctx, getNotifications } = createContext(cwd, pi);
		await pi.emit("session_start", {}, ctx);

		const deslop = pi.commands.get("deslop");
		assert.ok(deslop);
		// bare --loop without --no-converge: converges on first no-change iteration
		await deslop.handler("task --loop", ctx);

		assert.deepEqual(pi.userMessages.map(stripLoopPrefix), ["ARGS:task"]);
		assert.match(getNotifications().join("\n"), /Loop converged at 1 \(no changes\)/);
	});
});

test("bounded --loop N runs requested iterations when no-converge is set", async () => {
	await withTempHome(async (root) => {
		const cwd = join(root, "project");
		mkdirSync(join(cwd, ".pi", "prompts"), { recursive: true });
		writeFileSync(join(cwd, ".pi", "prompts", "deslop.md"), `---\nmodel: ${MODEL_ID}\n---\nARGS:$@`);

		const pi = new FakePi();
		promptModelExtension(pi as never);
		const { ctx, getNotifications } = createContext(cwd, pi);
		await pi.emit("session_start", {}, ctx);

		const deslop = pi.commands.get("deslop");
		assert.ok(deslop);
		await deslop.handler("task --loop 3 --no-converge", ctx);

		assert.deepEqual(pi.userMessages.map(stripLoopPrefix), ["ARGS:task", "ARGS:task", "ARGS:task"]);
		assert.ok(pi.userMessages[0].startsWith("[Loop 1/3]"));
		assert.ok(pi.userMessages[1].startsWith("[Loop 2/3]"));
		assert.ok(pi.userMessages[2].startsWith("[Loop 3/3]"));
		assert.match(getNotifications().join("\n"), /Loop finished: 3\/3 iterations/);
	});
});

test("loop rotation cycles models across iterations", async () => {
	await withTempHome(async (root) => {
		const cwd = join(root, "project");
		mkdirSync(join(cwd, ".pi", "prompts"), { recursive: true });
		writeFileSync(
			join(cwd, ".pi", "prompts", "rotate-models.md"),
			"---\nmodel: anthropic/rotate-one, anthropic/rotate-two, anthropic/rotate-three\nloop: 6\nconverge: false\nrotate: true\nrestore: false\n---\nROTATE",
		);

		const baseModel = { provider: "anthropic", id: "base-model" };
		const rotateOne = { provider: "anthropic", id: "rotate-one" };
		const rotateTwo = { provider: "anthropic", id: "rotate-two" };
		const rotateThree = { provider: "anthropic", id: "rotate-three" };
		const models = [baseModel, rotateOne, rotateTwo, rotateThree];

		const pi = new FakePi();
		pi.currentModel = baseModel;
		promptModelExtension(pi as never);
		const { ctx } = createContext(cwd, pi, models);
		await pi.emit("session_start", {}, ctx);

		const rotateModels = pi.commands.get("rotate-models");
		assert.ok(rotateModels);
		await rotateModels.handler("", ctx);

		assert.deepEqual(pi.setModelCalls, [
			"anthropic/rotate-one",
			"anthropic/rotate-two",
			"anthropic/rotate-three",
			"anthropic/rotate-one",
			"anthropic/rotate-two",
			"anthropic/rotate-three",
		]);
	});
});

test("loop rotation cycles comma-separated thinking levels across iterations", async () => {
	await withTempHome(async (root) => {
		const cwd = join(root, "project");
		mkdirSync(join(cwd, ".pi", "prompts"), { recursive: true });
		writeFileSync(
			join(cwd, ".pi", "prompts", "rotate-thinking.md"),
			"---\nmodel: anthropic/rotate-one, anthropic/rotate-two, anthropic/rotate-three\nthinking: high, xhigh, off\nloop: 6\nconverge: false\nrotate: true\nrestore: false\n---\nROTATE",
		);

		const baseModel = { provider: "anthropic", id: "base-model" };
		const rotateOne = { provider: "anthropic", id: "rotate-one" };
		const rotateTwo = { provider: "anthropic", id: "rotate-two" };
		const rotateThree = { provider: "anthropic", id: "rotate-three" };
		const models = [baseModel, rotateOne, rotateTwo, rotateThree];

		const pi = new FakePi();
		pi.currentModel = baseModel;
		promptModelExtension(pi as never);
		const { ctx } = createContext(cwd, pi, models);
		await pi.emit("session_start", {}, ctx);

		const rotateThinking = pi.commands.get("rotate-thinking");
		assert.ok(rotateThinking);
		await rotateThinking.handler("", ctx);

		assert.deepEqual(pi.thinkingCalls, ["high", "xhigh", "off", "high", "xhigh", "off"]);
	});
});

test("loop rotation still converges early when an iteration makes no changes", async () => {
	await withTempHome(async (root) => {
		const cwd = join(root, "project");
		mkdirSync(join(cwd, ".pi", "prompts"), { recursive: true });
		writeFileSync(
			join(cwd, ".pi", "prompts", "rotate-converge.md"),
			"---\nmodel: anthropic/rotate-one, anthropic/rotate-two, anthropic/rotate-three\nloop: 6\nrotate: true\nrestore: false\n---\nROTATE",
		);

		const baseModel = { provider: "anthropic", id: "base-model" };
		const rotateOne = { provider: "anthropic", id: "rotate-one" };
		const rotateTwo = { provider: "anthropic", id: "rotate-two" };
		const rotateThree = { provider: "anthropic", id: "rotate-three" };
		const models = [baseModel, rotateOne, rotateTwo, rotateThree];
		const changedBranchEntries = () =>
			pi.userMessages.length <= 1
				? [
					{ id: "root", type: "message", message: { role: "user", content: [{ type: "text", text: "start" }] } },
					{
						id: "write-1",
						type: "message",
						message: {
							role: "assistant",
							content: [{ type: "toolCall", name: "write", arguments: { path: "src/file.ts" } }],
						},
					},
				]
				: [{ id: "root", type: "message", message: { role: "user", content: [{ type: "text", text: "start" }] } }];

		const pi = new FakePi();
		pi.currentModel = baseModel;
		promptModelExtension(pi as never);
		const { ctx, getNotifications } = createContext(cwd, pi, models, { branchEntries: changedBranchEntries });
		await pi.emit("session_start", {}, ctx);

		const rotateConverge = pi.commands.get("rotate-converge");
		assert.ok(rotateConverge);
		await rotateConverge.handler("", ctx);

		assert.equal(pi.userMessages.length, 2);
		assert.match(getNotifications().join("\n"), /Loop converged at 2\/6 \(no changes\)/);
	});
});

test("loop rotation is a no-op for single-model prompts", async () => {
	await withTempHome(async (root) => {
		const cwd = join(root, "project");
		mkdirSync(join(cwd, ".pi", "prompts"), { recursive: true });
		writeFileSync(
			join(cwd, ".pi", "prompts", "rotate-single.md"),
			"---\nmodel: anthropic/rotate-one\nloop: 3\nconverge: false\nrotate: true\nrestore: false\n---\nROTATE",
		);

		const baseModel = { provider: "anthropic", id: "base-model" };
		const rotateOne = { provider: "anthropic", id: "rotate-one" };
		const models = [baseModel, rotateOne];

		const pi = new FakePi();
		pi.currentModel = baseModel;
		promptModelExtension(pi as never);
		const { ctx } = createContext(cwd, pi, models);
		await pi.emit("session_start", {}, ctx);

		const rotateSingle = pi.commands.get("rotate-single");
		assert.ok(rotateSingle);
		await rotateSingle.handler("", ctx);

		assert.deepEqual(pi.setModelCalls, ["anthropic/rotate-one"]);
		assert.equal(pi.userMessages.length, 3);
	});
});

test("loop notifications include the rotation label", async () => {
	await withTempHome(async (root) => {
		const cwd = join(root, "project");
		mkdirSync(join(cwd, ".pi", "prompts"), { recursive: true });
		writeFileSync(
			join(cwd, ".pi", "prompts", "rotate-notify.md"),
			"---\nmodel: anthropic/rotate-one, anthropic/rotate-two\nthinking: high, xhigh\nloop: 2\nconverge: false\nrotate: true\nrestore: false\n---\nROTATE",
		);

		const baseModel = { provider: "anthropic", id: "base-model" };
		const rotateOne = { provider: "anthropic", id: "rotate-one" };
		const rotateTwo = { provider: "anthropic", id: "rotate-two" };
		const models = [baseModel, rotateOne, rotateTwo];

		const pi = new FakePi();
		pi.currentModel = baseModel;
		promptModelExtension(pi as never);
		const { ctx, getNotifications } = createContext(cwd, pi, models);
		await pi.emit("session_start", {}, ctx);

		const rotateNotify = pi.commands.get("rotate-notify");
		assert.ok(rotateNotify);
		await rotateNotify.handler("", ctx);

		const notifications = getNotifications().join("\n");
		assert.match(notifications, /Loop 1\/2: rotate-notify \[rotate-one high\]/);
		assert.match(notifications, /Loop 2\/2: rotate-notify \[rotate-two xhigh\]/);
	});
});

test("loop prompts without rotation keep fallback model semantics", async () => {
	await withTempHome(async (root) => {
		const cwd = join(root, "project");
		mkdirSync(join(cwd, ".pi", "prompts"), { recursive: true });
		writeFileSync(
			join(cwd, ".pi", "prompts", "fallback-loop.md"),
			"---\nmodel: anthropic/fallback-one, anthropic/fallback-two\nloop: 2\nconverge: false\nrestore: false\n---\nFALLBACK",
		);

		const baseModel = { provider: "anthropic", id: "base-model" };
		const fallbackOne = { provider: "anthropic", id: "fallback-one" };
		const fallbackTwo = { provider: "anthropic", id: "fallback-two" };
		const models = [baseModel, fallbackOne, fallbackTwo];

		const pi = new FakePi();
		pi.currentModel = baseModel;
		promptModelExtension(pi as never);
		const { ctx } = createContext(cwd, pi, models);
		await pi.emit("session_start", {}, ctx);

		const fallbackLoop = pi.commands.get("fallback-loop");
		assert.ok(fallbackLoop);
		await fallbackLoop.handler("", ctx);

		assert.deepEqual(pi.setModelCalls, ["anthropic/fallback-one"]);
	});
});

test("bare --loop stops at unlimited cap when each iteration makes changes", async () => {
	await withTempHome(async (root) => {
		const cwd = join(root, "project");
		mkdirSync(join(cwd, ".pi", "prompts"), { recursive: true });
		writeFileSync(join(cwd, ".pi", "prompts", "deslop.md"), `---\nmodel: ${MODEL_ID}\n---\nARGS:$@`);

		const changedBranchEntries = () => [
			{ id: "root", type: "message", message: { role: "user", content: [{ type: "text", text: "start" }] } },
			{
				id: "write-1",
				type: "message",
				message: {
					role: "assistant",
					content: [{ type: "toolCall", name: "write", arguments: { path: "src/file.ts" } }],
				},
			},
		];

		const pi = new FakePi();
		promptModelExtension(pi as never);
		const { ctx, getNotifications } = createContext(cwd, pi, [ACTIVE_MODEL], { branchEntries: changedBranchEntries });
		await pi.emit("session_start", {}, ctx);

		const deslop = pi.commands.get("deslop");
		assert.ok(deslop);
		await deslop.handler("task --loop", ctx);

		assert.equal(pi.userMessages.length, 999);
		assert.match(getNotifications().join("\n"), /Loop finished: 999 iterations \(cap reached\)/);
	});
});

test("frontmatter loop executes without --loop and strips loop flags", async () => {
	await withTempHome(async (root) => {
		const cwd = join(root, "project");
		mkdirSync(join(cwd, ".pi", "prompts"), { recursive: true });
		writeFileSync(join(cwd, ".pi", "prompts", "deslop.md"), `---\nmodel: ${MODEL_ID}\nloop: 3\n---\nARGS:$@`);

		const pi = new FakePi();
		promptModelExtension(pi as never);
		const { ctx, getNavigateCount } = createContext(cwd, pi);
		await pi.emit("session_start", {}, ctx);

		const deslop = pi.commands.get("deslop");
		assert.ok(deslop);
		await deslop.handler("task --fresh --no-converge", ctx);

		assert.deepEqual(pi.userMessages.map(stripLoopPrefix), ["ARGS:task", "ARGS:task", "ARGS:task"]);
		assert.equal(getNavigateCount(), 2);
	});
});

test("frontmatter loop: unlimited runs until convergence by default", async () => {
	await withTempHome(async (root) => {
		const cwd = join(root, "project");
		mkdirSync(join(cwd, ".pi", "prompts"), { recursive: true });
		writeFileSync(join(cwd, ".pi", "prompts", "deslop.md"), `---\nmodel: ${MODEL_ID}\nloop: unlimited\n---\nARGS:$@`);

		const pi = new FakePi();
		promptModelExtension(pi as never);
		const { ctx, getNotifications } = createContext(cwd, pi);
		await pi.emit("session_start", {}, ctx);

		const deslop = pi.commands.get("deslop");
		assert.ok(deslop);
		await deslop.handler("task", ctx);

		assert.deepEqual(pi.userMessages.map(stripLoopPrefix), ["ARGS:task"]);
		assert.match(getNotifications().join("\n"), /Loop converged at 1 \(no changes\)/);
	});
});

test("frontmatter loop: true is equivalent to loop: unlimited", async () => {
	await withTempHome(async (root) => {
		const cwd = join(root, "project");
		mkdirSync(join(cwd, ".pi", "prompts"), { recursive: true });
		writeFileSync(join(cwd, ".pi", "prompts", "deslop.md"), `---\nmodel: ${MODEL_ID}\nloop: true\n---\nARGS:$@`);

		const pi = new FakePi();
		promptModelExtension(pi as never);
		const { ctx, getNotifications } = createContext(cwd, pi);
		await pi.emit("session_start", {}, ctx);

		const deslop = pi.commands.get("deslop");
		assert.ok(deslop);
		await deslop.handler("task", ctx);

		assert.deepEqual(pi.userMessages.map(stripLoopPrefix), ["ARGS:task"]);
		assert.match(getNotifications().join("\n"), /Loop converged at 1 \(no changes\)/);
	});
});

test("frontmatter loop: unlimited with converge: false runs to cap", async () => {
	await withTempHome(async (root) => {
		const cwd = join(root, "project");
		mkdirSync(join(cwd, ".pi", "prompts"), { recursive: true });
		writeFileSync(join(cwd, ".pi", "prompts", "deslop.md"), `---\nmodel: ${MODEL_ID}\nloop: unlimited\nconverge: false\n---\nARGS:$@`);

		const changedBranchEntries = () => [
			{ id: "root", type: "message", message: { role: "user", content: [{ type: "text", text: "start" }] } },
			{
				id: "write-1",
				type: "message",
				message: {
					role: "assistant",
					content: [{ type: "toolCall", name: "write", arguments: { path: "src/file.ts" } }],
				},
			},
		];

		const pi = new FakePi();
		promptModelExtension(pi as never);
		const { ctx, getNotifications } = createContext(cwd, pi, [ACTIVE_MODEL], { branchEntries: changedBranchEntries });
		await pi.emit("session_start", {}, ctx);

		const deslop = pi.commands.get("deslop");
		assert.ok(deslop);
		await deslop.handler("task", ctx);

		assert.equal(pi.userMessages.length, 999);
		assert.match(getNotifications().join("\n"), /Loop finished: 999 iterations \(cap reached\)/);
	});
});

test("frontmatter loop: unlimited shows iteration count without total in status", async () => {
	await withTempHome(async (root) => {
		const cwd = join(root, "project");
		mkdirSync(join(cwd, ".pi", "prompts"), { recursive: true });
		writeFileSync(join(cwd, ".pi", "prompts", "deslop.md"), `---\nmodel: ${MODEL_ID}\nloop: unlimited\nconverge: false\n---\nARGS:$@`);

		const pi = new FakePi();
		promptModelExtension(pi as never);
		const { ctx, getNotifications } = createContext(cwd, pi);
		await pi.emit("session_start", {}, ctx);

		const deslop = pi.commands.get("deslop");
		assert.ok(deslop);
		await deslop.handler("task", ctx);

		const notifications = getNotifications().join("\n");
		assert.match(notifications, /Loop 1: deslop/);
		assert.doesNotMatch(notifications, /Loop 1\/\d+/);
	});
});

test("CLI --loop overrides frontmatter loop and strips repeated loop flags", async () => {
	await withTempHome(async (root) => {
		const cwd = join(root, "project");
		mkdirSync(join(cwd, ".pi", "prompts"), { recursive: true });
		writeFileSync(join(cwd, ".pi", "prompts", "deslop.md"), `---\nmodel: ${MODEL_ID}\nloop: 5\n---\nARGS:$@`);

		const pi = new FakePi();
		promptModelExtension(pi as never);
		const { ctx, getNavigateCount } = createContext(cwd, pi);
		await pi.emit("session_start", {}, ctx);

		const deslop = pi.commands.get("deslop");
		assert.ok(deslop);
		await deslop.handler("task --loop 2 --fresh --fresh --no-converge --no-converge", ctx);

		assert.deepEqual(pi.userMessages.map(stripLoopPrefix), ["ARGS:task", "ARGS:task"]);
		assert.equal(getNavigateCount(), 1);
	});
});

test("prompt loop does not report completion when execution throws mid-run", async () => {
	await withTempHome(async (root) => {
		const cwd = join(root, "project");
		mkdirSync(join(cwd, ".pi", "prompts"), { recursive: true });
		writeFileSync(join(cwd, ".pi", "prompts", "deslop.md"), `---\nmodel: ${MODEL_ID}\nloop: 2\nconverge: false\n---\nTASK:$@`);

		let idleCalls = 0;
		const pi = new FakePi();
		promptModelExtension(pi as never);
		const { ctx, getNotifications } = createContext(cwd, pi, [ACTIVE_MODEL], {
			waitForIdle: async () => {
				idleCalls++;
				if (idleCalls === 2) throw new Error("mid-loop-crash");
			},
		});
		await pi.emit("session_start", {}, ctx);

		const deslop = pi.commands.get("deslop");
		assert.ok(deslop);
		await assert.rejects(deslop.handler("", ctx), /mid-loop-crash/);
		assert.doesNotMatch(getNotifications().join("\n"), /Loop finished|Loop converged/i);
	});
});

test("prompt loop preserves falsy thrown errors and suppresses completion", async () => {
	await withTempHome(async (root) => {
		const cwd = join(root, "project");
		mkdirSync(join(cwd, ".pi", "prompts"), { recursive: true });
		writeFileSync(join(cwd, ".pi", "prompts", "deslop.md"), `---\nmodel: ${MODEL_ID}\nloop: 2\nconverge: false\n---\nTASK:$@`);

		let idleCalls = 0;
		const pi = new FakePi();
		promptModelExtension(pi as never);
		const { ctx, getNotifications } = createContext(cwd, pi, [ACTIVE_MODEL], {
			waitForIdle: async () => {
				idleCalls++;
				if (idleCalls === 2) throw 0;
			},
		});
		await pi.emit("session_start", {}, ctx);

		const deslop = pi.commands.get("deslop");
		assert.ok(deslop);
		await assert.rejects(deslop.handler("", ctx), (error) => error === 0);
		assert.doesNotMatch(getNotifications().join("\n"), /Loop finished|Loop converged/i);
	});
});

test("loop restore uses runtime model state even when command context model is stale", async () => {
	await withTempHome(async (root) => {
		const cwd = join(root, "project");
		mkdirSync(join(cwd, ".pi", "prompts"), { recursive: true });
		writeFileSync(join(cwd, ".pi", "prompts", "deslop.md"), "---\nmodel: anthropic/target-model\n---\nARGS:$@");

		const baseModel = { provider: "anthropic", id: "base-model" };
		const targetModel = { provider: "anthropic", id: "target-model" };
		const models = [baseModel, targetModel];

		const pi = new FakePi();
		pi.currentModel = baseModel;
		promptModelExtension(pi as never);
		const { ctx } = createContext(cwd, pi, models);
		await pi.emit("session_start", {}, ctx);

		const staleCtx = { ...ctx, model: baseModel };
		const deslop = pi.commands.get("deslop");
		assert.ok(deslop);
		await deslop.handler("task --loop 1", staleCtx);
		assert.deepEqual(pi.currentModel, baseModel);
		assert.deepEqual(pi.setModelCalls, ["anthropic/target-model", "anthropic/base-model"]);
	});
});

test("boomerang frontmatter collapses a prompt-template-model command after execution", async () => {
	await withTempHome(async (root) => {
		const cwd = join(root, "project");
		mkdirSync(join(cwd, ".pi", "prompts"), { recursive: true });
		writeFileSync(join(cwd, ".pi", "prompts", "double-check.md"), '---\ndescription: "review"\nboomerang: true\n---\nCHECK:$@');

		const pi = new FakePi();
		promptModelExtension(pi as never);
		const branching = createBranchingContext(cwd, pi, [ACTIVE_MODEL]);
		let collapseSummary = "";
		let navigateCount = 0;
		let flagDuringNavigation: boolean | undefined;
		branching.ctx.navigateTree = async (targetId: string) => {
			navigateCount++;
			flagDuringNavigation = (globalThis as typeof globalThis & { __boomerangCollapseInProgress?: boolean }).__boomerangCollapseInProgress;
			const result = await pi.emitWithResult(
				"session_before_tree",
				{
					preparation: {
						targetId,
						entriesToSummarize: branching.branch.slice(1),
					},
				},
				branching.ctx,
			);
			collapseSummary = String((result?.summary as { summary?: string } | undefined)?.summary ?? "");
			return { cancelled: false };
		};
		branching.queueAssistantText("Fixed 1 issue.");
		await pi.emit("session_start", {}, branching.ctx);

		const doubleCheck = pi.commands.get("double-check");
		assert.ok(doubleCheck);
		await doubleCheck.handler("src/index.ts", branching.ctx);

		assert.deepEqual(pi.userMessages, ["CHECK:src/index.ts"]);
		assert.equal(navigateCount, 1);
		assert.equal(flagDuringNavigation, true);
		assert.equal((globalThis as typeof globalThis & { __boomerangCollapseInProgress?: boolean }).__boomerangCollapseInProgress, false);
		assert.match(collapseSummary, /^\[Boomerang\]/);
		assert.match(collapseSummary, /Task: "double-check"/);
		assert.match(collapseSummary, /Outcome: Fixed 1 issue\./);
	});
});

test("boomerang frontmatter still collapses when the prompt is looped", async () => {
	await withTempHome(async (root) => {
		const cwd = join(root, "project");
		mkdirSync(join(cwd, ".pi", "prompts"), { recursive: true });
		writeFileSync(join(cwd, ".pi", "prompts", "double-check.md"), '---\nboomerang: true\n---\nCHECK:$@');

		const pi = new FakePi();
		promptModelExtension(pi as never);
		const branching = createBranchingContext(cwd, pi, [ACTIVE_MODEL]);
		let collapseSummary = "";
		let navigateCount = 0;
		branching.ctx.navigateTree = async (targetId: string) => {
			navigateCount++;
			const result = await pi.emitWithResult(
				"session_before_tree",
				{
					preparation: {
						targetId,
						entriesToSummarize: branching.branch.slice(1),
					},
				},
				branching.ctx,
			);
			collapseSummary = String((result?.summary as { summary?: string } | undefined)?.summary ?? "");
			return { cancelled: false };
		};
		branching.queueAssistantText("First pass fixed one issue.");
		branching.queueAssistantText("Second pass found no more issues.");
		await pi.emit("session_start", {}, branching.ctx);

		const doubleCheck = pi.commands.get("double-check");
		assert.ok(doubleCheck);
		await doubleCheck.handler("src/index.ts --loop 2 --no-converge", branching.ctx);

		assert.deepEqual(pi.userMessages, ["[Loop 1/2]\n\nCHECK:src/index.ts", "[Loop 2/2]\n\nCHECK:src/index.ts"]);
		assert.equal(navigateCount, 1);
		assert.match(collapseSummary, /^\[Boomerang\]/);
		assert.match(collapseSummary, /Outcome: Second pass found no more issues\./);
	});
});

test("fresh loop summaries are preserved when a looped boomerang collapses", async () => {
	await withTempHome(async (root) => {
		const cwd = join(root, "project");
		mkdirSync(join(cwd, ".pi", "prompts"), { recursive: true });
		writeFileSync(join(cwd, ".pi", "prompts", "double-check.md"), '---\nboomerang: true\n---\nCHECK:$@');

		const pi = new FakePi();
		promptModelExtension(pi as never);
		const branching = createBranchingContext(cwd, pi, [ACTIVE_MODEL]);
		const collapseSummaries: string[] = [];
		branching.ctx.navigateTree = async (targetId: string) => {
			const result = await pi.emitWithResult(
				"session_before_tree",
				{
					preparation: {
						targetId,
						entriesToSummarize: branching.branch.slice(1),
					},
				},
				branching.ctx,
			);
			collapseSummaries.push(String((result?.summary as { summary?: string } | undefined)?.summary ?? ""));
			return { cancelled: false };
		};
		branching.queueAssistantText("First pass fixed one issue.");
		branching.queueAssistantText("Second pass found no more issues.");
		await pi.emit("session_start", {}, branching.ctx);

		const doubleCheck = pi.commands.get("double-check");
		assert.ok(doubleCheck);
		await doubleCheck.handler("src/index.ts --loop 2 --fresh --no-converge", branching.ctx);

		assert.equal(collapseSummaries.length, 2);
		assert.match(collapseSummaries[0]!, /^\[Loop iteration 1\/2\]/);
		assert.match(collapseSummaries[1]!, /^\[Loop iteration 1\/2\]/);
		assert.match(collapseSummaries[1]!, /---\n\n\[Boomerang\]/);
	});
});

test("model-less prompt uses tracked runtime model even when command context model is stale", async () => {
	await withTempHome(async (root) => {
		const cwd = join(root, "project");
		mkdirSync(join(cwd, ".pi", "prompts"), { recursive: true });
		writeFileSync(join(cwd, ".pi", "prompts", "double-check.md"), '---\ndescription: "dc"\n---\n<if-model is="anthropic/target-model">TARGET<else>BASE</if-model>');

		const baseModel = { provider: "anthropic", id: "base-model" };
		const targetModel = { provider: "anthropic", id: "target-model" };
		const models = [baseModel, targetModel];

		const pi = new FakePi();
		pi.currentModel = baseModel;
		promptModelExtension(pi as never);
		const { ctx } = createContext(cwd, pi, models);
		await pi.emit("session_start", {}, ctx);

		pi.currentModel = targetModel;
		await pi.emit("model_select", { model: targetModel, previousModel: baseModel, source: "set" }, ctx);

		const staleCtx = { ...ctx, model: baseModel };
		const doubleCheck = pi.commands.get("double-check");
		assert.ok(doubleCheck);
		await doubleCheck.handler("", staleCtx);

		assert.deepEqual(pi.userMessages, ["TARGET"]);
		assert.deepEqual(pi.setModelCalls, []);
	});
});

test("session switch clears pending restore state", async () => {
	await withTempHome(async (root) => {
		const cwd = join(root, "project");
		mkdirSync(join(cwd, ".pi", "prompts"), { recursive: true });
		writeFileSync(join(cwd, ".pi", "prompts", "deslop.md"), "---\nmodel: anthropic/target-model\nrestore: true\n---\nTASK:$@");

		const baseModel = { provider: "anthropic", id: "base-model" };
		const targetModel = { provider: "anthropic", id: "target-model" };
		const models = [baseModel, targetModel];

		const pi = new FakePi();
		pi.currentModel = baseModel;
		promptModelExtension(pi as never);
		const { ctx } = createContext(cwd, pi, models);
		await pi.emit("session_start", {}, ctx);

		const deslop = pi.commands.get("deslop");
		assert.ok(deslop);
		await deslop.handler("demo", ctx);
		assert.deepEqual(pi.setModelCalls, ["anthropic/target-model", "anthropic/base-model"]);
			await pi.emit("session_start", { reason: "resume" }, ctx);
		await pi.emit("agent_end", {}, ctx);
		assert.deepEqual(pi.setModelCalls, ["anthropic/target-model", "anthropic/base-model"]);
	});
});

test("--model flag overrides prompt model for single execution", async () => {
	await withTempHome(async (root) => {
		const cwd = join(root, "project");
		mkdirSync(join(cwd, ".pi", "prompts"), { recursive: true });
		writeFileSync(join(cwd, ".pi", "prompts", "review.md"), `---\nmodel: ${MODEL_ID}\n---\nreview code`);

		const overrideModel = { provider: "anthropic", id: "claude-opus-4-6" };
		const pi = new FakePi();
		promptModelExtension(pi as never);
		const { ctx } = createContext(cwd, pi, [ACTIVE_MODEL, overrideModel]);
		await pi.emit("session_start", {}, ctx);

		const command = pi.commands.get("review");
		assert.ok(command);
		await command.handler("--model=anthropic/claude-opus-4-6", ctx);

		assert.deepEqual(pi.setModelCalls, ["anthropic/claude-opus-4-6", "anthropic/claude-sonnet-4-20250514"]);
		assert.deepEqual(pi.userMessages, ["review code"]);
	});
});

test("--model flag overrides prompt model in loop iterations", async () => {
	await withTempHome(async (root) => {
		const cwd = join(root, "project");
		mkdirSync(join(cwd, ".pi", "prompts"), { recursive: true });
		writeFileSync(
			join(cwd, ".pi", "prompts", "fix.md"),
			`---\nmodel: ${MODEL_ID}\nloop: 2\nconverge: false\n---\nfix bugs`,
		);

		const overrideModel = { provider: "openai", id: "gpt-5.4" };
		const pi = new FakePi();
		promptModelExtension(pi as never);
		const { ctx } = createContext(cwd, pi, [ACTIVE_MODEL, overrideModel]);
		await pi.emit("session_start", {}, ctx);

		const command = pi.commands.get("fix");
		assert.ok(command);
		await command.handler("--model=openai/gpt-5.4", ctx);

		assert.equal(pi.setModelCalls[0], "openai/gpt-5.4");
		assert.equal(pi.userMessages.length, 2);
	});
});

test("--fork flag implies --subagent and sets inheritContext", async () => {
	await withTempHome(async (root) => {
		const cwd = join(root, "project");
		mkdirSync(join(cwd, ".pi", "prompts"), { recursive: true });
		writeFileSync(join(cwd, ".pi", "prompts", "check.md"), `---\nmodel: ${MODEL_ID}\n---\ncheck code`);

		const pi = new FakePi();
		promptModelExtension(pi as never);
		const { ctx, getNotifications } = createContext(cwd, pi);
		await pi.emit("session_start", {}, ctx);

		const command = pi.commands.get("check");
		assert.ok(command);
		await command.handler("--fork", ctx);

		assert.equal(pi.userMessages.length, 0, "should not execute inline (delegation path taken)");
		const notifications = getNotifications().join("\n");
		assert.ok(notifications.length > 0, "should have attempted delegation");
	});
});

test("delegated single run injects result as user message", async () => {
	await withTempHome(async (root) => {
		await withSubagentRuntime(root, async () => {
			const cwd = join(root, "project");
			mkdirSync(join(cwd, ".pi", "prompts"), { recursive: true });
			writeFileSync(join(cwd, ".pi", "prompts", "simplify.md"), `---\nmodel: ${MODEL_ID}\nsubagent: true\n---\nSINGLE`);

			const pi = new FakePi();
			promptModelExtension(pi as never);
			const { ctx } = createBranchingContext(cwd, pi);
			await pi.emit("session_start", {}, ctx);

			pi.events.on(PROMPT_TEMPLATE_SUBAGENT_REQUEST_EVENT, (payload) => {
				const request = payload as any;
				pi.events.emit(PROMPT_TEMPLATE_SUBAGENT_STARTED_EVENT, { requestId: request.requestId });
				pi.events.emit(PROMPT_TEMPLATE_SUBAGENT_RESPONSE_EVENT, {
					...request,
					messages: [{ role: "assistant", content: [{ type: "text", text: "single delegated result" }] }],
					isError: false,
				});
			});

			await pi.commands.get("simplify")!.handler("", ctx);

			assert.deepEqual(pi.userMessages, ["[Delegated result: simplify]\n\nsingle delegated result"]);
		});
	});
});

test("delegated loop injects last iteration result as user message", async () => {
	await withTempHome(async (root) => {
		await withSubagentRuntime(root, async () => {
			const cwd = join(root, "project");
			mkdirSync(join(cwd, ".pi", "prompts"), { recursive: true });
			writeFileSync(join(cwd, ".pi", "prompts", "simplify.md"), `---\nmodel: ${MODEL_ID}\nsubagent: true\n---\nLOOP`);

			const pi = new FakePi();
			promptModelExtension(pi as never);
			const { ctx } = createBranchingContext(cwd, pi);
			await pi.emit("session_start", {}, ctx);

			let delegatedCall = 0;
			pi.events.on(PROMPT_TEMPLATE_SUBAGENT_REQUEST_EVENT, (payload) => {
				const request = payload as any;
				delegatedCall++;
				pi.events.emit(PROMPT_TEMPLATE_SUBAGENT_STARTED_EVENT, { requestId: request.requestId });
				pi.events.emit(PROMPT_TEMPLATE_SUBAGENT_RESPONSE_EVENT, {
					...request,
					messages: [{ role: "assistant", content: [{ type: "text", text: `delegated loop ${delegatedCall}` }] }],
					isError: false,
				});
			});

			await pi.commands.get("simplify")!.handler("--loop 3 --no-converge", ctx);

			assert.deepEqual(
				pi.userMessages,
				["[Delegated loop completed 3 iteration(s): simplify]\n\ndelegated loop 3"],
			);
		});
	});
});

test("delegated loop error after prior success does not inject stale delegated text", async () => {
	await withTempHome(async (root) => {
		await withSubagentRuntime(root, async () => {
			const cwd = join(root, "project");
			mkdirSync(join(cwd, ".pi", "prompts"), { recursive: true });
			writeFileSync(join(cwd, ".pi", "prompts", "loop-error.md"), `---\nmodel: ${MODEL_ID}\nsubagent: true\n---\nLOOP_ERROR`);

			const pi = new FakePi();
			promptModelExtension(pi as never);
			const { ctx } = createBranchingContext(cwd, pi);
			await pi.emit("session_start", {}, ctx);

			let delegatedCall = 0;
			pi.events.on(PROMPT_TEMPLATE_SUBAGENT_REQUEST_EVENT, (payload) => {
				const request = payload as any;
				delegatedCall++;
				pi.events.emit(PROMPT_TEMPLATE_SUBAGENT_STARTED_EVENT, { requestId: request.requestId });
				if (delegatedCall === 1) {
					pi.events.emit(PROMPT_TEMPLATE_SUBAGENT_RESPONSE_EVENT, {
						...request,
						messages: [{ role: "assistant", content: [{ type: "text", text: "loop delegated success" }] }],
						isError: false,
					});
					return;
				}
				pi.events.emit(PROMPT_TEMPLATE_SUBAGENT_RESPONSE_EVENT, {
					...request,
					messages: [],
					isError: true,
					errorText: "delegated loop failure",
				});
			});

			await pi.commands.get("loop-error")!.handler("--loop 2 --no-converge", ctx);

			assert.equal(delegatedCall, 2);
			assert.equal(pi.userMessages.length, 0);
		});
	});
});

test("delegated loop convergence still triggers and injects after convergence evaluation", async () => {
	await withTempHome(async (root) => {
		await withSubagentRuntime(root, async () => {
			const cwd = join(root, "project");
			mkdirSync(join(cwd, ".pi", "prompts"), { recursive: true });
			writeFileSync(join(cwd, ".pi", "prompts", "simplify.md"), `---\nmodel: ${MODEL_ID}\nsubagent: true\n---\nCONVERGE`);

			const pi = new FakePi();
			promptModelExtension(pi as never);
			const { ctx } = createBranchingContext(cwd, pi);
			await pi.emit("session_start", {}, ctx);

			let delegatedCall = 0;
			pi.events.on(PROMPT_TEMPLATE_SUBAGENT_REQUEST_EVENT, (payload) => {
				const request = payload as any;
				delegatedCall++;
				pi.events.emit(PROMPT_TEMPLATE_SUBAGENT_STARTED_EVENT, { requestId: request.requestId });
				pi.events.emit(PROMPT_TEMPLATE_SUBAGENT_RESPONSE_EVENT, {
					...request,
					messages: [{ role: "assistant", content: [{ type: "text", text: "stable delegated result" }] }],
					isError: false,
				});
			});

			await pi.commands.get("simplify")!.handler("--loop 5", ctx);

			assert.equal(delegatedCall, 1);
			assert.deepEqual(
				pi.userMessages,
				["[Delegated loop converged after 1 iteration(s): simplify]\n\nstable delegated result"],
			);
		});
	});
});

function parallelResponse(request: any) {
	const tasks = request.tasks ?? [{ agent: request.agent }];
	return {
		...request,
		parallelResults: tasks.map((t: any) => ({
			agent: t.agent ?? "delegate",
			messages: [{ role: "assistant", content: [{ type: "text", text: "done" }] }],
			isError: false,
		})),
		isError: false,
	};
}

function singleResponse(request: any) {
	return {
		...request,
		messages: [{ role: "assistant", content: [{ type: "text", text: "done" }] }],
		isError: false,
	};
}

