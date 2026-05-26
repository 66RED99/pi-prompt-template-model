import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildPromptCommandDescription, loadPromptsWithModel, RESERVED_COMMAND_NAMES } from "../prompt-loader.js";

async function withTempHome(run: (root: string) => Promise<void> | void) {
	const root = mkdtempSync(join(tmpdir(), "pi-prompt-loader-current-"));
	const previousHome = process.env.HOME;
	process.env.HOME = root;
	try {
		await run(root);
	} finally {
		process.env.HOME = previousHome;
		rmSync(root, { recursive: true, force: true });
	}
}

test("loadPromptsWithModel loads supported prompt templates", async () => {
	await withTempHome(async (root) => {
		const cwd = join(root, "project");
		mkdirSync(join(cwd, ".pi", "prompts"), { recursive: true });
		writeFileSync(
			join(cwd, ".pi", "prompts", "review.md"),
			'---\nmodel: anthropic/claude-sonnet-4-20250514\ndescription: "Review code"\nloop: 2\nsubagent: scout\nparallel: 3\nworktree: true\n---\nPlease review $@',
		);

		const result = loadPromptsWithModel(cwd);
		const prompt = result.prompts.get("review");
		assert.ok(prompt);
		assert.equal(prompt.description, "Review code");
		assert.deepEqual(prompt.models, ["anthropic/claude-sonnet-4-20250514"]);
		assert.equal(prompt.loop, 2);
		assert.equal(prompt.subagent, "scout");
		assert.equal(prompt.parallel, 3);
		assert.equal(prompt.worktree, true);
		assert.match(buildPromptCommandDescription(prompt), /Review code/);
		assert.equal(result.diagnostics.length, 0);
	});
});

test("loadPromptsWithModel skips unsupported chain and skill templates with diagnostics", async () => {
	await withTempHome(async (root) => {
		const cwd = join(root, "project");
		mkdirSync(join(cwd, ".pi", "prompts"), { recursive: true });
		writeFileSync(join(cwd, ".pi", "prompts", "old-chain.md"), '---\nchain: analyze -> fix\n---\nignored');
		writeFileSync(join(cwd, ".pi", "prompts", "old-skill.md"), '---\nskill: tmux\n---\nignored');

		const result = loadPromptsWithModel(cwd);
		assert.equal(result.prompts.has("old-chain"), false);
		assert.equal(result.prompts.has("old-skill"), false);
		const messages = result.diagnostics.map((item) => item.message).join("\n");
		assert.match(messages, /field "chain" is no longer supported/i);
		assert.match(messages, /field "skill" is no longer supported/i);
	});
});

test("reserved command names still include prompt-tool and exclude chain-prompts", () => {
	assert.equal(RESERVED_COMMAND_NAMES.has("prompt-tool"), true);
	assert.equal(RESERVED_COMMAND_NAMES.has("chain-prompts"), false);
});
