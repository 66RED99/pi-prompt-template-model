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

const MODEL = { provider: "anthropic", id: "claude-sonnet-4-20250514" };

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
			for (const handler of this.bus.get(channel) ?? []) handler(data);
		},
		on: (channel: string, handler: (data: unknown) => void) => {
			const handlers = this.bus.get(channel) ?? [];
			handlers.push(handler);
			this.bus.set(channel, handlers);
			return () => {
				const current = this.bus.get(channel) ?? [];
				this.bus.set(channel, current.filter((entry) => entry !== handler));
			};
		},
	};
	currentModel = MODEL;
	setModelCalls: string[] = [];
	userMessages: string[] = [];
	customMessages: any[] = [];

	registerMessageRenderer() {}
	registerCommand(name: string, command: FakeCommand) { this.commands.set(name, command); }
	registerTool(tool: FakeTool) { this.tools.set(tool.name, tool); }
	getCommands() { return []; }
	on(event: string, handler: (event: any, ctx: any) => Promise<any> | any) {
		const handlers = this.hooks.get(event) ?? [];
		handlers.push(handler);
		this.hooks.set(event, handlers);
	}
	async emit(event: string, payload: any, ctx: any) {
		for (const handler of this.hooks.get(event) ?? []) await handler(payload, ctx);
	}
	async setModel(model: { provider: string; id: string }) {
		this.setModelCalls.push(`${model.provider}/${model.id}`);
		this.currentModel = model;
		return true;
	}
	getThinkingLevel() { return "medium" as const; }
	setThinkingLevel() {}
	sendUserMessage(content: string) { this.userMessages.push(content); }
	sendMessage(message: any) { this.customMessages.push(message); }
}

function withTempHome(run: (root: string) => Promise<void>) {
	const root = mkdtempSync(join(tmpdir(), "pi-prompt-subagent-index-"));
	const prevHome = process.env.HOME;
	process.env.HOME = root;
	const runtimeRoot = join(root, "runtime-subagent");
	mkdirSync(runtimeRoot, { recursive: true });
	writeFileSync(join(runtimeRoot, "agents.js"), "export function discoverAgents(){ return { agents: [{ name: 'delegate' }, { name: 'reviewer' }, { name: 'worker' }] }; }");
	const prevRuntime = process.env.PI_SUBAGENT_RUNTIME_ROOT;
	process.env.PI_SUBAGENT_RUNTIME_ROOT = runtimeRoot;
	return run(root).finally(() => {
		if (prevHome === undefined) delete process.env.HOME;
		else process.env.HOME = prevHome;
		if (prevRuntime === undefined) delete process.env.PI_SUBAGENT_RUNTIME_ROOT;
		else process.env.PI_SUBAGENT_RUNTIME_ROOT = prevRuntime;
		rmSync(root, { recursive: true, force: true });
	});
}

function createContext(cwd: string, pi: FakePi) {
	const branch: any[] = [{ id: "root", type: "message", message: { role: "user", content: [{ type: "text", text: "start" }] } }];
	let entryCount = 0;
	const nextId = (prefix: string) => `${prefix}-${++entryCount}`;
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
		pi.customMessages.push(message);
		branch.push({
			id: nextId("custom"),
			type: "custom_message",
			customType: message.customType,
			content: message.content,
			display: message.display,
			details: message.details,
		});
	};

	return {
		ctx: {
			cwd,
			hasUI: false,
			model: MODEL,
			modelRegistry: {
				find(provider: string, id: string) {
					return provider === MODEL.provider && id === MODEL.id ? MODEL : undefined;
				},
				getAll() { return [MODEL]; },
				getAvailable() { return [MODEL]; },
				async getApiKey() { return "token"; },
				isUsingOAuth() { return false; },
			},
			ui: {
				notify() {},
				onTerminalInput() { return () => {}; },
				setStatus() {},
				setWorkingMessage() {},
				theme: { fg(_token: string, text: string) { return text; } },
			},
			isIdle() { return false; },
			async waitForIdle() {},
			sessionManager: {
				getLeafId() { return branch[branch.length - 1]?.id ?? "root"; },
				getBranch() { return branch; },
			},
			async navigateTree() { return { cancelled: false }; },
		},
		branch,
	};
}

function respondWithDelegatedResult(pi: FakePi, setup?: (request: any) => void) {
	pi.events.on(PROMPT_TEMPLATE_SUBAGENT_REQUEST_EVENT, (payload) => {
		const request = payload as any;
		setup?.(request);
		pi.events.emit(PROMPT_TEMPLATE_SUBAGENT_STARTED_EVENT, { requestId: request.requestId });
		pi.events.emit(PROMPT_TEMPLATE_SUBAGENT_RESPONSE_EVENT, {
			...request,
			messages: [
				{
					role: "assistant",
					content: [
						{ type: "toolCall", id: "1", name: "write", arguments: { path: "src/file.ts" } },
						{ type: "text", text: "Done" },
					],
				},
			],
			isError: false,
		});
	});
}

test("delegated prompt uses event bus and does not switch parent model", async () => {
	await withTempHome(async (root) => {
		const cwd = join(root, "project");
		mkdirSync(join(cwd, ".pi", "prompts"), { recursive: true });
		writeFileSync(join(cwd, ".pi", "prompts", "simplify.md"), "---\nmodel: anthropic/claude-sonnet-4-20250514\nsubagent: true\n---\nwork");

		const pi = new FakePi();
		const { ctx } = createContext(cwd, pi);
		promptModelExtension(pi as never);
		await pi.emit("session_start", {}, ctx);
		respondWithDelegatedResult(pi, (request) => {
			assert.equal(request.agent, "delegate");
			assert.equal(request.context, "fresh");
		});

		await pi.commands.get("simplify")!.handler("", ctx);
		assert.deepEqual(pi.setModelCalls, []);
		assert.equal(pi.customMessages.length, 1);
	});
});

test("runtime --subagent override takes precedence", async () => {
	await withTempHome(async (root) => {
		const cwd = join(root, "project");
		mkdirSync(join(cwd, ".pi", "prompts"), { recursive: true });
		writeFileSync(join(cwd, ".pi", "prompts", "simplify.md"), "---\nmodel: anthropic/claude-sonnet-4-20250514\nsubagent: worker\n---\nwork");

		const pi = new FakePi();
		const { ctx } = createContext(cwd, pi);
		promptModelExtension(pi as never);
		await pi.emit("session_start", {}, ctx);
		respondWithDelegatedResult(pi, (request) => {
			assert.equal(request.agent, "reviewer");
		});

		await pi.commands.get("simplify")!.handler("--subagent:reviewer", ctx);
	});
});

test("inheritContext delegated prompts request fork context", async () => {
	await withTempHome(async (root) => {
		const cwd = join(root, "project");
		mkdirSync(join(cwd, ".pi", "prompts"), { recursive: true });
		writeFileSync(
			join(cwd, ".pi", "prompts", "simplify.md"),
			"---\nmodel: anthropic/claude-sonnet-4-20250514\nsubagent: true\ninheritContext: true\n---\nwork",
		);

		const pi = new FakePi();
		const { ctx } = createContext(cwd, pi);
		promptModelExtension(pi as never);
		await pi.emit("session_start", {}, ctx);
		respondWithDelegatedResult(pi, (request) => {
			assert.equal(request.context, "fork");
		});

		await pi.commands.get("simplify")!.handler("", ctx);
	});
});

test("delegated loops converge from delegated write/no-write changes", async () => {
	await withTempHome(async (root) => {
		const cwd = join(root, "project");
		mkdirSync(join(cwd, ".pi", "prompts"), { recursive: true });
		writeFileSync(join(cwd, ".pi", "prompts", "simplify.md"), "---\nmodel: anthropic/claude-sonnet-4-20250514\nsubagent: true\n---\nwork");

		const pi = new FakePi();
		const { ctx } = createContext(cwd, pi);
		promptModelExtension(pi as never);
		await pi.emit("session_start", {}, ctx);

		let call = 0;
		pi.events.on(PROMPT_TEMPLATE_SUBAGENT_REQUEST_EVENT, (payload) => {
			const request = payload as any;
			call++;
			pi.events.emit(PROMPT_TEMPLATE_SUBAGENT_STARTED_EVENT, { requestId: request.requestId });
			pi.events.emit(PROMPT_TEMPLATE_SUBAGENT_RESPONSE_EVENT, {
				...request,
				messages: [
					{
						role: "assistant",
						content: call === 1
							? [{ type: "toolCall", id: "1", name: "write", arguments: { path: "src/a.ts" } }, { type: "text", text: "changed" }]
							: [{ type: "text", text: "no changes" }],
					},
				],
				isError: false,
			});
		});

		await pi.commands.get("simplify")!.handler("--loop 5", ctx);
		assert.equal(call, 2);
	});
});

test("queued run-prompt executes delegated commands", async () => {
	await withTempHome(async (root) => {
		const cwd = join(root, "project");
		mkdirSync(join(cwd, ".pi", "prompts"), { recursive: true });
		writeFileSync(join(cwd, ".pi", "prompts", "simplify.md"), "---\nmodel: anthropic/claude-sonnet-4-20250514\nsubagent: true\n---\nwork");

		const pi = new FakePi();
		const { ctx } = createContext(cwd, pi);
		promptModelExtension(pi as never);
		await pi.emit("session_start", {}, ctx);
		respondWithDelegatedResult(pi);

		await pi.commands.get("prompt-tool")!.handler("on", ctx);
		await pi.tools.get("run-prompt")!.execute("tool-1", { command: "simplify" });
		await pi.emit("agent_end", {}, ctx);

		assert.equal(pi.customMessages.length, 1);
	});
});

test("parallel chain step delegates with tasks payload", async () => {
	await withTempHome(async (root) => {
		const cwd = join(root, "project");
		mkdirSync(join(cwd, ".pi", "prompts"), { recursive: true });
		writeFileSync(join(cwd, ".pi", "prompts", "pipeline.md"), '---\nchain: "parallel(scan-fe, scan-be)"\n---\nignored');
		writeFileSync(join(cwd, ".pi", "prompts", "scan-fe.md"), "---\nmodel: anthropic/claude-sonnet-4-20250514\nsubagent: delegate\n---\nscan fe");
		writeFileSync(join(cwd, ".pi", "prompts", "scan-be.md"), "---\nmodel: anthropic/claude-sonnet-4-20250514\nsubagent: reviewer\n---\nscan be");

		const pi = new FakePi();
		const { ctx } = createContext(cwd, pi);
		promptModelExtension(pi as never);
		await pi.emit("session_start", {}, ctx);

		let requestTasks: Array<{ agent: string; task: string; model?: string }> | undefined;
		pi.events.on(PROMPT_TEMPLATE_SUBAGENT_REQUEST_EVENT, (payload) => {
			const request = payload as any;
			requestTasks = request.tasks;
			pi.events.emit(PROMPT_TEMPLATE_SUBAGENT_STARTED_EVENT, { requestId: request.requestId });
			pi.events.emit(PROMPT_TEMPLATE_SUBAGENT_RESPONSE_EVENT, {
				...request,
				messages: [],
				parallelResults: [
					{
						agent: "delegate",
						messages: [{ role: "assistant", content: [{ type: "text", text: "fe done" }] }],
						isError: false,
					},
					{
						agent: "reviewer",
						messages: [{ role: "assistant", content: [{ type: "text", text: "be done" }] }],
						isError: false,
					},
				],
				isError: false,
			});
		});

		const pipeline = pi.commands.get("pipeline");
		assert.ok(pipeline);
		await pipeline.handler("", ctx);

		assert.equal(Array.isArray(requestTasks), true);
		assert.equal(requestTasks?.length, 2);
		assert.equal(requestTasks?.[0]?.agent, "delegate");
		assert.equal(requestTasks?.[1]?.agent, "reviewer");
		assert.equal(pi.customMessages.length, 1);
		assert.equal(pi.userMessages.length, 1);
		assert.equal(
			pi.userMessages[0],
			"[Delegated chain complete: parallel(scan-fe, scan-be)]\n\n=== Task 1: delegate ===\nfe done\n\n=== Task 2: reviewer ===\nbe done",
		);
	});
});

test("parallel chain task failure aborts remaining chain steps", async () => {
	await withTempHome(async (root) => {
		const cwd = join(root, "project");
		mkdirSync(join(cwd, ".pi", "prompts"), { recursive: true });
		writeFileSync(join(cwd, ".pi", "prompts", "pipeline.md"), '---\nchain: "parallel(scan-fe, scan-be) -> review"\n---\nignored');
		writeFileSync(join(cwd, ".pi", "prompts", "scan-fe.md"), "---\nmodel: anthropic/claude-sonnet-4-20250514\nsubagent: true\n---\nscan fe");
		writeFileSync(join(cwd, ".pi", "prompts", "scan-be.md"), "---\nmodel: anthropic/claude-sonnet-4-20250514\nsubagent: true\n---\nscan be");
		writeFileSync(join(cwd, ".pi", "prompts", "review.md"), "---\nmodel: anthropic/claude-sonnet-4-20250514\n---\nreview");

		const pi = new FakePi();
		const { ctx } = createContext(cwd, pi);
		promptModelExtension(pi as never);
		await pi.emit("session_start", {}, ctx);

		let requestCount = 0;
		pi.events.on(PROMPT_TEMPLATE_SUBAGENT_REQUEST_EVENT, (payload) => {
			const request = payload as any;
			requestCount++;
			pi.events.emit(PROMPT_TEMPLATE_SUBAGENT_STARTED_EVENT, { requestId: request.requestId });
			pi.events.emit(PROMPT_TEMPLATE_SUBAGENT_RESPONSE_EVENT, {
				...request,
				messages: [],
				parallelResults: [
					{ agent: "delegate", messages: [], isError: true, errorText: "scan failed" },
					{ agent: "delegate", messages: [], isError: false },
				],
				isError: false,
			});
		});

		const pipeline = pi.commands.get("pipeline");
		assert.ok(pipeline);
		await pipeline.handler("", ctx);

		assert.equal(requestCount, 1);
		assert.equal(pi.userMessages.length, 0);
		assert.equal(pi.customMessages.length, 0);
	});
});

test("successful parallel step continues to next sequential step", async () => {
	await withTempHome(async (root) => {
		const cwd = join(root, "project");
		mkdirSync(join(cwd, ".pi", "prompts"), { recursive: true });
		writeFileSync(join(cwd, ".pi", "prompts", "pipeline.md"), '---\nchain: "parallel(scan-fe, scan-be) -> review"\n---\nignored');
		writeFileSync(join(cwd, ".pi", "prompts", "scan-fe.md"), "---\nmodel: anthropic/claude-sonnet-4-20250514\nsubagent: true\n---\nscan fe");
		writeFileSync(join(cwd, ".pi", "prompts", "scan-be.md"), "---\nmodel: anthropic/claude-sonnet-4-20250514\nsubagent: true\n---\nscan be");
		writeFileSync(join(cwd, ".pi", "prompts", "review.md"), "---\nmodel: anthropic/claude-sonnet-4-20250514\n---\nreview findings");

		const pi = new FakePi();
		const { ctx } = createContext(cwd, pi);
		promptModelExtension(pi as never);
		await pi.emit("session_start", {}, ctx);

		pi.events.on(PROMPT_TEMPLATE_SUBAGENT_REQUEST_EVENT, (payload) => {
			const request = payload as any;
			pi.events.emit(PROMPT_TEMPLATE_SUBAGENT_STARTED_EVENT, { requestId: request.requestId });
			pi.events.emit(PROMPT_TEMPLATE_SUBAGENT_RESPONSE_EVENT, {
				...request,
				messages: [],
				parallelResults: [
					{ agent: "delegate", messages: [{ role: "assistant", content: [{ type: "text", text: "fe done" }] }], isError: false },
					{ agent: "delegate", messages: [{ role: "assistant", content: [{ type: "text", text: "be done" }] }], isError: false },
				],
				isError: false,
			});
		});

		const pipeline = pi.commands.get("pipeline");
		assert.ok(pipeline);
		await pipeline.handler("", ctx);

		assert.equal(pi.customMessages.length, 1);
		assert.equal(pi.userMessages.length, 2);
		assert.equal(pi.userMessages[0], "review findings");
		assert.equal(
			pi.userMessages[1],
			"[Delegated chain complete: parallel(scan-fe, scan-be) -> review]\n\n=== Task 1: delegate ===\nfe done\n\n=== Task 2: delegate ===\nbe done",
		);
	});
});

test("parallel delegated step summaries are passed to the next delegated sequential step", async () => {
	await withTempHome(async (root) => {
		const cwd = join(root, "project");
		mkdirSync(join(cwd, ".pi", "prompts"), { recursive: true });
		writeFileSync(join(cwd, ".pi", "prompts", "pipeline.md"), '---\nchain: "parallel(scan-fe, scan-be) -> review"\nchainContext: summary\n---\nignored');
		writeFileSync(join(cwd, ".pi", "prompts", "scan-fe.md"), "---\nmodel: anthropic/claude-sonnet-4-20250514\nsubagent: true\n---\nscan fe");
		writeFileSync(join(cwd, ".pi", "prompts", "scan-be.md"), "---\nmodel: anthropic/claude-sonnet-4-20250514\nsubagent: true\n---\nscan be");
		writeFileSync(join(cwd, ".pi", "prompts", "review.md"), "---\nmodel: anthropic/claude-sonnet-4-20250514\nsubagent: true\n---\nreview findings");

		const pi = new FakePi();
		const { ctx } = createContext(cwd, pi);
		promptModelExtension(pi as never);
		await pi.emit("session_start", {}, ctx);

		const delegatedTasks: string[] = [];
		pi.events.on(PROMPT_TEMPLATE_SUBAGENT_REQUEST_EVENT, (payload) => {
			const request = payload as any;
			delegatedTasks.push(request.task);
			pi.events.emit(PROMPT_TEMPLATE_SUBAGENT_STARTED_EVENT, { requestId: request.requestId });
			if (request.tasks) {
				pi.events.emit(PROMPT_TEMPLATE_SUBAGENT_RESPONSE_EVENT, {
					...request,
					messages: [],
					parallelResults: [
						{ agent: "delegate", messages: [{ role: "assistant", content: [{ type: "text", text: "fe done" }] }], isError: false },
						{ agent: "delegate", messages: [{ role: "assistant", content: [{ type: "text", text: "be done" }] }], isError: false },
					],
					isError: false,
				});
				return;
			}
			pi.events.emit(PROMPT_TEMPLATE_SUBAGENT_RESPONSE_EVENT, {
				...request,
				messages: [{ role: "assistant", content: [{ type: "text", text: "review done" }] }],
				isError: false,
			});
		});

		await pi.commands.get("pipeline")!.handler("", ctx);
		assert.equal(delegatedTasks.length, 2);
		assert.match(delegatedTasks[1] ?? "", /^\[Previous chain steps\]\n\nStep 1 — parallel\(scan-fe, scan-be\):/);
	});
});

test("chain-prompts CLI command handles parallel() syntax", async () => {
	await withTempHome(async (root) => {
		const cwd = join(root, "project");
		mkdirSync(join(cwd, ".pi", "prompts"), { recursive: true });
		writeFileSync(join(cwd, ".pi", "prompts", "scan-fe.md"), "---\nmodel: anthropic/claude-sonnet-4-20250514\nsubagent: true\n---\nscan fe");
		writeFileSync(join(cwd, ".pi", "prompts", "scan-be.md"), "---\nmodel: anthropic/claude-sonnet-4-20250514\nsubagent: true\n---\nscan be");

		const pi = new FakePi();
		const { ctx } = createContext(cwd, pi);
		promptModelExtension(pi as never);
		await pi.emit("session_start", {}, ctx);

		let requestTasks: Array<{ agent: string; task: string }> | undefined;
		pi.events.on(PROMPT_TEMPLATE_SUBAGENT_REQUEST_EVENT, (payload) => {
			const request = payload as any;
			requestTasks = request.tasks;
			pi.events.emit(PROMPT_TEMPLATE_SUBAGENT_STARTED_EVENT, { requestId: request.requestId });
			pi.events.emit(PROMPT_TEMPLATE_SUBAGENT_RESPONSE_EVENT, {
				...request,
				messages: [],
				parallelResults: [
					{ agent: "delegate", messages: [{ role: "assistant", content: [{ type: "text", text: "fe" }] }], isError: false },
					{ agent: "delegate", messages: [{ role: "assistant", content: [{ type: "text", text: "be" }] }], isError: false },
				],
				isError: false,
			});
		});

		const chainPrompts = pi.commands.get("chain-prompts");
		assert.ok(chainPrompts);
		await chainPrompts.handler("parallel(scan-fe, scan-be)", ctx);

		assert.equal(Array.isArray(requestTasks), true);
		assert.equal(requestTasks?.length, 2);
		assert.equal(pi.customMessages.length, 1);
	});
});
