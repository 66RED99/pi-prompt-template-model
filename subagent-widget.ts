import type { Theme } from "@mariozechner/pi-coding-agent";
import { Box, Container, Spacer, Text } from "@mariozechner/pi-tui";
import { getDelegatedLiveState, type DelegatedSubagentLiveState, type DelegatedSubagentTask } from "./subagent-runtime.js";

export const DELEGATED_WIDGET_KEY = "prompt-subagent-progress";

function formatDuration(ms: number): string {
	const seconds = Math.floor(ms / 1000);
	if (seconds < 60) return `${seconds}s`;
	const minutes = Math.floor(seconds / 60);
	const remaining = seconds % 60;
	return `${minutes}m${remaining}s`;
}

function formatTokens(n: number | undefined): string {
	if (!n) return "0";
	if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
	return String(n);
}

function normalizeModelLabel(model: string | undefined): string | undefined {
	if (!model) return undefined;
	return model.includes("/") ? model.split("/").pop() : model;
}

function formatToolCall(tool: string, args: string): string {
	const safeArgs = args ?? "";
	switch (tool) {
		case "bash": {
			const cmd = safeArgs.replace(/[\n\t]/g, " ").trim();
			return `$ ${cmd.length > 80 ? cmd.slice(0, 80) + "..." : cmd}`;
		}
		case "read": return `[read: ${safeArgs}]`;
		case "write": return `[write: ${safeArgs}]`;
		case "edit": return `[edit: ${safeArgs}]`;
		default: {
			const short = safeArgs.length > 60 ? safeArgs.slice(0, 60) + "..." : safeArgs;
			return `[${tool}: ${short}]`;
		}
	}
}

export function createDelegatedProgressWidget(
	requestId: string,
	agent: string,
	context: "fresh" | "fork",
	task: string,
	tasks: DelegatedSubagentTask[] | undefined,
	theme: Theme,
	model?: string,
): Container & { dispose?(): void } {
	const contextSuffix = context === "fork" ? theme.fg("warning", " [fork]") : "";
	const taskPreview = task.length > 200 ? `${task.slice(0, 200)}...` : task;
	const parallelTasks = tasks ?? [];
	const isParallel = parallelTasks.length > 0;
	const parallelModels = [...new Set(parallelTasks
		.map((task) => normalizeModelLabel(task.model))
		.filter((entry): entry is string => !!entry))];
	const requestModel = isParallel
		? (parallelModels.length === 1 ? parallelModels[0] : undefined)
		: normalizeModelLabel(model);

	const container = new Container();
	container.addChild(new Spacer(1));
	const box = new Box(1, 1, (text: string) => theme.bg("toolPendingBg", text));
	container.addChild(box);

	let lastKey = "";

	container.render = (width: number): string[] => {
		const state = getDelegatedLiveState(requestId);
		const elapsed = state ? Date.now() - state.startedAt : 0;
		const key = stateKey(state, elapsed);
		if (key !== lastKey) {
			lastKey = key;
			rebuildBox(box, agent, contextSuffix, taskPreview, parallelTasks, isParallel, state, elapsed, theme, requestModel);
		}
		return Container.prototype.render.call(container, width);
	};

	return container;
}

function stateKey(state: DelegatedSubagentLiveState | undefined, elapsed: number): string {
	if (!state) return "none";
	const elapsedBucket = Math.floor(elapsed / 1000);
	const tool = state.currentTool ?? "";
	const outputLen = state.recentOutput.length;
	const outputTail = state.recentOutput.length > 0
		? state.recentOutput[state.recentOutput.length - 1]?.slice(0, 80) ?? ""
		: "";
	const toolsLen = state.recentTools.length;
	const taskProgressKey = state.taskProgress
		.map((entry) => `${entry.index ?? ""}:${entry.agent}:${entry.status ?? ""}:${entry.currentTool ?? ""}:${entry.toolCount ?? 0}`)
		.join("|");
	return `${state.status}|${tool}|${state.toolCount}|${state.tokens}|${outputLen}:${outputTail}|${toolsLen}|${state.model ?? ""}|${taskProgressKey}|${elapsedBucket}`;
}

function rebuildBox(
	box: Box,
	agent: string,
	contextSuffix: string,
	taskPreview: string,
	parallelTasks: DelegatedSubagentTask[],
	isParallel: boolean,
	state: DelegatedSubagentLiveState | undefined,
	elapsed: number,
	theme: Theme,
	requestModel?: string,
): void {
	box.clear();

	const taskProgress = state?.taskProgress ?? [];
	const baseToolCount = state?.toolCount ?? 0;
	const baseTokens = state?.tokens ?? 0;
	const parallelToolCount = taskProgress.reduce((sum, entry) => sum + (entry.toolCount ?? 0), 0);
	const parallelTokens = taskProgress.reduce((sum, entry) => sum + (entry.tokens ?? 0), 0);
	const toolCount = isParallel && parallelToolCount > 0 ? parallelToolCount : baseToolCount;
	const tokens = isParallel && parallelTokens > 0 ? parallelTokens : baseTokens;
	const tokensLabel = formatTokens(tokens);
	const duration = formatDuration(elapsed);
	const isThinking = toolCount === 0 && tokens === 0;
	const icon = theme.fg("warning", "...");
	const modelLabel = isParallel
		? requestModel
		: normalizeModelLabel(state?.model ?? requestModel);
	const modelSuffix = modelLabel ? ` ${theme.fg("dim", modelLabel)}` : "";
	const stats = isThinking
		? `thinking, ${duration}`
		: `${toolCount} tool${toolCount === 1 ? "" : "s"}, ${tokensLabel} tok, ${duration}`;

	// Header
	if (isParallel) {
		const completedCount = taskProgress.filter((entry) => entry.status === "completed").length;
		const runningLabel = `parallel ${completedCount}/${parallelTasks.length} running`;
		box.addChild(new Text(`${icon} ${theme.fg("toolTitle", theme.bold(runningLabel))}${contextSuffix}${modelSuffix} | ${stats}`, 0, 0));
	} else {
		box.addChild(new Text(
			`${icon} ${theme.fg("toolTitle", theme.bold(agent))}${contextSuffix}${modelSuffix} | ${stats}`,
			0, 0,
		));
	}
	box.addChild(new Spacer(1));

	// Task preview
	if (!isParallel) {
		box.addChild(new Text(theme.fg("dim", `Task: ${taskPreview}`), 0, 0));
		box.addChild(new Spacer(1));
	}

	// Parallel task list
	if (isParallel) {
		for (let index = 0; index < parallelTasks.length; index++) {
			const task = parallelTasks[index]!;
			const progress =
				taskProgress.find((entry) => entry.index === index) ??
				taskProgress.find((entry) => entry.index === undefined && entry.agent === task.agent) ??
				taskProgress[index];
			const taskStatus = progress?.status ?? "pending";
			if (taskStatus === "running") {
				const runningTool = progress.currentTool ? ` ${progress.currentTool}...` : "";
				box.addChild(new Text(theme.fg("dim", `  ${task.agent}: running${runningTool}`), 0, 0));
			} else if (taskStatus === "completed") {
				const toolSuffix =
					progress?.toolCount !== undefined
						? ` (${progress.toolCount} tool${progress.toolCount === 1 ? "" : "s"})`
						: "";
				box.addChild(new Text(theme.fg("dim", `  ${task.agent}: completed${toolSuffix}`), 0, 0));
			} else if (taskStatus === "failed") {
				box.addChild(new Text(theme.fg("dim", `  ${task.agent}: failed`), 0, 0));
			} else {
				box.addChild(new Text(theme.fg("dim", `  ${task.agent}: pending`), 0, 0));
			}
		}
		return;
	}

	// Unified tool stream: completed tools (dim) then active tool (warning) at bottom.
	// When a tool finishes it moves from active → completed in place — no visual jump.
	const recentTools = state?.recentTools ?? [];
	for (const tool of recentTools) {
		box.addChild(new Text(theme.fg("dim", formatToolCall(tool.tool, tool.args)), 0, 0));
	}
	if (state?.currentTool) {
		const active = formatToolCall(state.currentTool, state.currentToolArgs ?? "");
		box.addChild(new Text(theme.fg("warning", `> ${active}`), 0, 0));
	}

	// Recent output
	if (state && state.recentOutput.length > 0) {
		if (recentTools.length > 0 || state.currentTool) {
			box.addChild(new Spacer(1));
		}
		for (const line of state.recentOutput) {
			box.addChild(new Text(theme.fg("dim", `  ${line}`), 0, 0));
		}
	}
}
