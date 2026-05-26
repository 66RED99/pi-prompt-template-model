import { existsSync } from "node:fs";
import { resolve as resolvePath } from "node:path";
import type { Model } from "@mariozechner/pi-ai";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@mariozechner/pi-coding-agent";
import type { ThinkingLevel } from "@mariozechner/pi-agent-core";
import {
	extractLineupOverrides,
	extractLoopCount,
	extractLoopFlags,
	extractSubagentOverride,
	parseCommandArgs,
	substituteArgs,
	type LineupOverrideAction,
	type SubagentOverride,
} from "./args.js";
import { generateBoomerangSummary, generateIterationSummary, didIterationMakeChanges, getIterationEntries, wasIterationAborted } from "./loop-utils.js";
import { selectModelCandidate } from "./model-selection.js";
import { notify, summarizePromptDiagnostics, diagnosticsFingerprint } from "./notifications.js";
import { preparePromptExecution, renderPromptForResolvedModel } from "./prompt-execution.js";
import {
	buildPromptCommandDescription,
	expandCwdPath,
	loadPromptsWithModel,
	type DelegationLineupSlot,
	type PromptWithModel,
} from "./prompt-loader.js";
import { executeSubagentPromptStep, type DelegatedPromptParallelResult } from "./subagent-step.js";
import { DEFAULT_SUBAGENT_NAME, PROMPT_TEMPLATE_SUBAGENT_MESSAGE_TYPE } from "./subagent-runtime.js";
import { renderDelegatedSubagentResult } from "./subagent-renderer.js";
import {
	PROMPT_TEMPLATE_DETERMINISTIC_COMPLETION_MESSAGE_TYPE,
	PROMPT_TEMPLATE_DETERMINISTIC_MESSAGE_TYPE,
	buildDeterministicPreamble,
	runDeterministicStep,
	shouldHandoffToLlm,
} from "./deterministic-step.js";
import { renderDeterministicCompletion, renderDeterministicResult } from "./deterministic-renderer.js";

interface LoopState {
	currentIteration: number;
	totalIterations: number | null;
	rotationLabel?: string;
}

interface FreshCollapse {
	targetId: string;
	task: string;
	iteration: number;
	totalIterations: number | null;
}

interface BoomerangCollapse {
	targetId: string;
	task: string;
	previousSummaries: string[];
}

interface ExecutionErrorState {
	hasError: boolean;
	error: unknown;
}

interface PromptStepResult {
	changed: boolean;
	text?: string;
}

const DEFAULT_COMPARE_REVIEWER_TASK = [
	"Review the worker variants and produce findings only.",
	"Required output:",
	"1. Summarize concrete strengths with patch/diff evidence, including worktree change summaries when present.",
	"2. Call out concrete correctness risks and regression risks.",
	"3. Extract cherry-pick ideas from non-winning variants.",
	"4. Do not rank variants or select a winner.",
	"5. Do not include manual apply commands.",
].join("\n");

const DEFAULT_COMPARE_FINAL_APPLIER_TASK = [
	"Apply the final implementation directly in the current repo.",
	"Required output:",
	"1. Pick the best single variant or synthesize/cherry-pick across variants.",
	"2. Apply changes directly on the current branch.",
	"3. Keep edits minimal and focused on the implementation task.",
	"4. Run obvious relevant verification when practical.",
	"5. Report changed files and verification commands run.",
].join("\n");

export default function promptModelExtension(pi: ExtensionAPI) {
	let prompts = new Map<string, PromptWithModel>();
	let previousModel: Model<any> | undefined;
	let previousThinking: ThinkingLevel | undefined;
	let runtimeModel: Model<any> | undefined;
	let loopState: LoopState | null = null;
	let freshCollapse: FreshCollapse | null = null;
	let boomerangCollapse: BoomerangCollapse | null = null;
	let accumulatedSummaries: string[] = [];
	let lastDiagnostics = "";
	const UNLIMITED_LOOP_CAP = 999;

	function sameModel(a: Model<any> | undefined, b: Model<any> | undefined): boolean {
		if (!a || !b) return a === b;
		return a.provider === b.provider && a.id === b.id;
	}

	function getCurrentModel(ctx: Pick<ExtensionContext, "model">): Model<any> | undefined {
		return runtimeModel ?? ctx.model;
	}

	pi.registerMessageRenderer(PROMPT_TEMPLATE_SUBAGENT_MESSAGE_TYPE, renderDelegatedSubagentResult);
	pi.registerMessageRenderer(PROMPT_TEMPLATE_DETERMINISTIC_MESSAGE_TYPE, renderDeterministicResult);
	pi.registerMessageRenderer(PROMPT_TEMPLATE_DETERMINISTIC_COMPLETION_MESSAGE_TYPE, renderDeterministicCompletion);

	function registerPromptCommand(name: string) {
		pi.registerCommand(name, {
			description: buildPromptCommandDescription(prompts.get(name)!),
			handler: async (args, ctx) => {
				await runPromptCommand(name, args, ctx);
			},
		});
	}

	function refreshPrompts(cwd: string, ctx?: ExtensionContext) {
		const result = loadPromptsWithModel(cwd);
		prompts = result.prompts;

		for (const name of prompts.keys()) {
			registerPromptCommand(name);
		}

		const summary = summarizePromptDiagnostics(result.diagnostics);
		const fingerprint = diagnosticsFingerprint(result.diagnostics);
		if (summary && fingerprint !== lastDiagnostics) {
			notify(ctx, summary, "warning");
		}
		lastDiagnostics = fingerprint;
	}

	async function waitForTurnStart(ctx: ExtensionContext) {
		while (ctx.isIdle()) {
			await new Promise((resolve) => setTimeout(resolve, 10));
		}
	}

	function shouldDelegatePrompt(prompt: PromptWithModel, override?: SubagentOverride): boolean {
		return prompt.subagent !== undefined || override?.enabled === true;
	}

	async function executePromptStep(
		prompt: PromptWithModel,
		args: string[],
		ctx: ExtensionCommandContext,
		currentModel: Model<any> | undefined,
		override?: SubagentOverride,
		inheritedModel?: Model<any>,
		taskPreamble?: string,
		loopContext?: string,
	): Promise<PromptStepResult | "aborted"> {
		let deterministicPreamble: string | undefined;
		if (prompt.deterministic) {
			try {
				const deterministicResult = await runDeterministicStep(prompt, prompt.deterministic, ctx.cwd);
				const deterministicPreambleText = buildDeterministicPreamble(deterministicResult);
				pi.sendMessage({
					customType: PROMPT_TEMPLATE_DETERMINISTIC_MESSAGE_TYPE,
					content: deterministicPreambleText,
					display: true,
					details: deterministicResult,
				});
				if (!shouldHandoffToLlm(prompt.deterministic, deterministicResult)) {
					pi.sendMessage({
						customType: PROMPT_TEMPLATE_DETERMINISTIC_COMPLETION_MESSAGE_TYPE,
						content: `[Deterministic complete: ${prompt.name}]`,
						display: true,
						details: {
							promptName: prompt.name,
							exitCode: deterministicResult.exitCode,
							timedOut: deterministicResult.timedOut,
							status: deterministicResult.exitCode === 0 ? "succeeded" : "failed",
						},
					});
					return { changed: false };
				}
				deterministicPreamble = deterministicPreambleText;
			} catch (error) {
				notify(ctx, `Deterministic step failed: ${error instanceof Error ? error.message : String(error)}`, "error");
				return "aborted";
			}
		}

		const combinedTaskPreamble = [taskPreamble, deterministicPreamble].filter(Boolean).join("\n\n");

		if (shouldDelegatePrompt(prompt, override)) {
			try {
				const delegated =
					prompt.parallel && prompt.parallel > 1
						? await executeSubagentPromptStep({
							pi,
							ctx,
							currentModel,
							override,
							signal: ctx.signal,
							inheritedModel,
							taskPreamble: combinedTaskPreamble || undefined,
							parallel: Array.from({ length: prompt.parallel }, (_, index) => ({
								prompt,
								args,
								taskPrefix: `[Parallel subagent ${index + 1}/${prompt.parallel}]`,
							})),
							worktree: prompt.worktree === true,
						})
						: await executeSubagentPromptStep({
							pi,
							prompt,
							args,
							ctx,
							currentModel,
							override,
							signal: ctx.signal,
							inheritedModel,
							taskPreamble: combinedTaskPreamble || undefined,
						});
				if (!delegated) {
					notify(ctx, `Prompt \`${prompt.name}\` is not configured for delegated execution.`, "error");
					return "aborted";
				}
				return { changed: delegated.changed, text: delegated.text };
			} catch (error) {
				notify(ctx, error instanceof Error ? error.message : String(error), "error");
				return { changed: false };
			}
		}

		const prepared =
			inheritedModel === undefined
				? await preparePromptExecution(prompt, args, currentModel, ctx.modelRegistry)
				: await preparePromptExecution(prompt, args, currentModel, ctx.modelRegistry, { inheritedModel });
		if (!prepared) {
			notify(ctx, `No available model from: ${prompt.models.join(", ")}`, "error");
			return "aborted";
		}
		if ("message" in prepared) {
			if (prepared.warning) notify(ctx, prepared.warning, "warning");
			notify(ctx, prepared.message, "error");
			return "aborted";
		}
		if (prepared.warning) {
			notify(ctx, prepared.warning, "warning");
		}

		if (!prepared.selectedModel.alreadyActive) {
			const switched = await pi.setModel(prepared.selectedModel.model);
			if (!switched) {
				notify(ctx, `Failed to switch to model ${prepared.selectedModel.model.provider}/${prepared.selectedModel.model.id}`, "error");
				return "aborted";
			}
			runtimeModel = prepared.selectedModel.model;
		}

		if (prompt.thinking) {
			pi.setThinkingLevel(prompt.thinking);
		}

		const startId = ctx.sessionManager.getLeafId();
		const effectiveContent = combinedTaskPreamble
			? `${combinedTaskPreamble}\n\n${prepared.content}`
			: prepared.content;
		const content = loopContext ? `[${loopContext}]\n\n${effectiveContent}` : effectiveContent;
		pi.sendUserMessage(content);
		await waitForTurnStart(ctx);
		await ctx.waitForIdle();

		const entries = getIterationEntries(ctx, startId);
		if (wasIterationAborted(entries)) return "aborted";
		return { changed: didIterationMakeChanges(entries) };
	}

	async function restoreSessionState(
		ctx: ExtensionContext,
		originalModel: Model<any> | undefined,
		originalThinking: ThinkingLevel | undefined,
		currentModel?: Model<any>,
		currentThinking?: ThinkingLevel,
	) {
		const restoredParts: string[] = [];
		const shouldRestoreThinking =
			originalThinking !== undefined && (currentThinking === undefined || currentThinking !== originalThinking);

		if (originalModel && !sameModel(originalModel, currentModel)) {
			const restoredModel = await pi.setModel(originalModel);
			if (restoredModel) {
				runtimeModel = originalModel;
				restoredParts.push(originalModel.id);
			} else {
				notify(ctx, `Failed to restore model ${originalModel.provider}/${originalModel.id}`, "error");
			}
		}
		if (shouldRestoreThinking) {
			restoredParts.push(`thinking:${originalThinking}`);
			pi.setThinkingLevel(originalThinking);
		}
		if (restoredParts.length > 0) {
			notify(ctx, `Restored to ${restoredParts.join(", ")}`, "info");
		}
	}

	async function restoreAfterExecution(
		ctx: ExtensionContext,
		shouldRestore: boolean,
		originalModel: Model<any> | undefined,
		originalThinking: ThinkingLevel | undefined,
		currentModel: Model<any> | undefined,
		currentThinking: ThinkingLevel | undefined,
		errorState: ExecutionErrorState,
		phase: string,
	): Promise<ExecutionErrorState> {
		if (!shouldRestore) return errorState;

		try {
			await restoreSessionState(ctx, originalModel, originalThinking, currentModel, currentThinking);
		} catch (error) {
			if (errorState.hasError) {
				notify(
					ctx,
					`Failed to restore session state after ${phase} error: ${error instanceof Error ? error.message : String(error)}`,
					"error",
				);
				return errorState;
			}
			return { hasError: true, error };
		}

		return errorState;
	}

	function notifyLoopCompletion(
		ctx: ExtensionContext,
		completedIterations: number,
		totalIterations: number | null,
		effectiveMax: number,
		converged: boolean,
		requireMultipleIterations: boolean,
	) {
		if (converged) {
			const convergedLabel = totalIterations !== null ? `${completedIterations}/${totalIterations}` : `${completedIterations}`;
			notify(ctx, `Loop converged at ${convergedLabel} (no changes)`, "info");
			return;
		}

		if (completedIterations === 0) return;
		if (requireMultipleIterations && effectiveMax <= 1) return;

		if (totalIterations !== null) {
			notify(ctx, `Loop finished: ${completedIterations}/${totalIterations} iterations`, "info");
			return;
		}
		if (completedIterations === effectiveMax) {
			notify(ctx, `Loop finished: ${completedIterations} iterations (cap reached)`, "info");
			return;
		}
		notify(ctx, `Loop finished: ${completedIterations} iterations`, "info");
	}

	function updateLoopStatus(ctx: ExtensionContext) {
		if (!ctx.hasUI) return;
		if (loopState) {
			const suffix = loopState.rotationLabel ? ` · ${loopState.rotationLabel}` : "";
			const label =
				loopState.totalIterations !== null
					? `loop ${loopState.currentIteration}/${loopState.totalIterations}${suffix}`
					: `loop ${loopState.currentIteration}${suffix}`;
			ctx.ui.setStatus("prompt-loop", ctx.ui.theme.fg("warning", label));
		} else {
			ctx.ui.setStatus("prompt-loop", undefined);
		}
	}

	function cloneLineup(slots: DelegationLineupSlot[] | undefined): DelegationLineupSlot[] | undefined {
		return slots?.map((slot) => ({ ...slot }));
	}

	function expandLineupCounts(slots: DelegationLineupSlot[]): DelegationLineupSlot[] {
		const expanded: DelegationLineupSlot[] = [];
		for (const slot of slots) {
			const { count, ...concreteSlot } = slot;
			for (let index = 0; index < (count ?? 1); index++) {
				expanded.push({ ...concreteSlot });
			}
		}
		return expanded;
	}

	function applyLineupActions(
		defaultSlots: DelegationLineupSlot[] | undefined,
		actions: LineupOverrideAction[],
		target: "workers" | "reviewers",
	): DelegationLineupSlot[] | undefined {
		let lineup = cloneLineup(defaultSlots);
		for (const action of actions) {
			if (action.target !== target) continue;
			const incoming = action.slots.map((slot) => ({ ...slot }));
			lineup = action.mode === "replace" ? incoming : [...(lineup ?? []), ...incoming];
		}
		return lineup;
	}

	function applyFinalApplierAction(
		defaultSlot: DelegationLineupSlot | undefined,
		actions: LineupOverrideAction[],
	): DelegationLineupSlot | undefined {
		let slot = defaultSlot ? { ...defaultSlot } : undefined;
		for (const action of actions) {
			if (action.target !== "finalApplier") continue;
			slot = action.slots[0] ? { ...action.slots[0] } : undefined;
		}
		return slot;
	}

	async function resolveCompareBaseModel(
		prompt: PromptWithModel,
		currentModel: Model<any> | undefined,
		ctx: ExtensionCommandContext,
		modelOverride?: string,
	): Promise<Model<any> | undefined> {
		const requestedModels = modelOverride ? [modelOverride] : prompt.models;
		if (requestedModels.length > 0) {
			const selected = await selectModelCandidate(requestedModels, currentModel, ctx.modelRegistry);
			if (!selected) {
				notify(ctx, `No available model from: ${requestedModels.join(", ")}`, "error");
				return undefined;
			}
			return selected.model;
		}
		if (currentModel) return currentModel;
		notify(ctx, `Prompt \`${prompt.name}\` requires an active model or a runtime --model override.`, "error");
		return undefined;
	}

	function resolveCompareCwd(raw: string, ctx: ExtensionCommandContext): string {
		return expandCwdPath(raw) ?? resolvePath(ctx.cwd, raw);
	}

	function normalizeLineupCwds(
		slots: DelegationLineupSlot[],
		defaultCwd: string,
		ctx: ExtensionCommandContext,
	): DelegationLineupSlot[] | undefined {
		const normalized: DelegationLineupSlot[] = [];
		for (const slot of slots) {
			const slotCwd = slot.cwd ? resolveCompareCwd(slot.cwd, ctx) : defaultCwd;
			if (!existsSync(slotCwd)) {
				notify(ctx, `cwd directory does not exist: ${slotCwd}`, "error");
				return undefined;
			}
			normalized.push({
				...slot,
				cwd: slotCwd,
			});
		}
		return normalized;
	}

	function formatCompareSlotLabel(slot: DelegationLineupSlot, fallbackAgent: string): string {
		return slot.model ? `${fallbackAgent}, ${slot.model}` : fallbackAgent;
	}

	function renderComparePhaseResults(
		label: string,
		entries: Array<{ index: number; slot: DelegationLineupSlot; result: DelegatedPromptParallelResult }>,
	): string {
		return entries
			.map(({ index, slot, result }) => {
				const body = result.text || "(no assistant text)";
				return `=== ${label} ${index + 1} (${formatCompareSlotLabel(slot, result.agent)}) ===\n${body}`;
			})
			.join("\n\n");
	}

	function formatPhaseFailureSummary(
		label: string,
		entries: Array<{ index: number; slot: DelegationLineupSlot; result: DelegatedPromptParallelResult }>,
	): string | undefined {
		if (entries.length === 0) return undefined;
		return [
			`[${label} failures]`,
			...entries.map(({ index, slot, result }) =>
				`- ${label} ${index + 1} (${formatCompareSlotLabel(slot, result.agent)}): ${result.errorText || "unknown delegated error"}`,
			),
		].join("\n");
	}

	function extractSuccessfulWorktreeChanges(aggregateText: string | undefined, successfulIndexes: number[]): string | undefined {
		if (!aggregateText) return undefined;
		const marker = "=== Worktree Changes ===";
		const markerIndex = aggregateText.indexOf(marker);
		if (markerIndex < 0) return undefined;
		const worktreeText = aggregateText.slice(markerIndex + marker.length).trim();
		if (!worktreeText) return undefined;
		const successfulTaskNumbers = new Set(successfulIndexes.map((index) => index + 1));
		const sections = worktreeText
			.split(/\n(?=--- Task \d+ \()/)
			.map((section) => section.trim())
			.filter(Boolean)
			.filter((section) => {
				const match = section.match(/^--- Task (\d+) \(/);
				return match ? successfulTaskNumbers.has(parseInt(match[1]!, 10)) : false;
			});
		if (sections.length === 0) return undefined;
		return `${marker}\n\n${sections.join("\n\n")}`;
	}

	function buildReviewerPreamble(sharedTask: string, workerAggregation: string, workerFailureSummary?: string): string {
		return [
			"[Original implementation task]",
			sharedTask,
			"",
			"[Worker outputs and worktree summaries]",
			workerAggregation,
			...(workerFailureSummary ? ["", workerFailureSummary] : []),
		].join("\n");
	}

	function buildFinalApplierPreamble(
		sharedTask: string,
		workerAggregation: string,
		workerFailureSummary?: string,
		reviewerAggregation?: string,
		reviewerFailureSummary?: string,
	): string {
		return [
			"[Original implementation task]",
			sharedTask,
			"",
			"[Worker outputs and worktree summaries]",
			workerAggregation,
			...(workerFailureSummary ? ["", workerFailureSummary] : []),
			"",
			"[Reviewer findings]",
			reviewerAggregation ?? "All reviewer runs failed. Synthesize directly from the worker variants.",
			...(reviewerFailureSummary ? ["", reviewerFailureSummary] : []),
			"",
			"[Final apply instructions]",
			"Pick one winner or synthesize/cherry-pick from multiple variants, apply the final patch directly in the current repo, keep edits minimal, run obvious relevant verification when practical, and report changed files plus verification run.",
		].join("\n");
	}

	function buildLineupSlotTask(
		baseTask: string,
		slot: DelegationLineupSlot,
		taskArgs: string[],
	): string {
		const effectiveBaseTask = slot.task ? substituteArgs(slot.task, taskArgs) : baseTask;
		if (!slot.taskSuffix) return effectiveBaseTask;
		return `${effectiveBaseTask}\n\n${substituteArgs(slot.taskSuffix, taskArgs)}`;
	}

	function buildComparePrompt(
		base: PromptWithModel,
		options: {
			name: string;
			agent: string;
			task: string;
			model?: string;
			cwd: string;
			inheritContext?: boolean;
		},
	): PromptWithModel {
		return {
			...base,
			name: options.name,
			content: options.task,
			models: options.model ? [options.model] : [],
			parallel: undefined,
			worktree: undefined,
			subagent: options.agent,
			inheritContext: options.inheritContext ? true : undefined,
			cwd: options.cwd,
			workers: undefined,
			reviewers: undefined,
			finalApplier: undefined,
		};
	}

	async function runComparePrompt(
		name: string,
		prompt: PromptWithModel,
		args: string,
		ctx: ExtensionCommandContext,
		currentModel: Model<any> | undefined,
		runtime: { cwd?: string; model?: string; subagentOverride?: SubagentOverride; fork?: boolean },
	) {
		if (runtime.subagentOverride) {
			notify(ctx, `--subagent is not supported for compare prompts (ignored)`, "warning");
		}
		if (runtime.fork) {
			notify(ctx, `--fork is not supported for compare prompts (ignored)`, "warning");
		}

		const lineupExtraction = extractLineupOverrides(args);
		if (lineupExtraction.errors.length > 0) {
			for (const error of lineupExtraction.errors) {
				notify(ctx, error, "error");
			}
			return;
		}

		let taskArgs = parseCommandArgs(lineupExtraction.args);
		let compareCwd = runtime.cwd ?? prompt.cwd ?? ctx.cwd;
		if (name === "parallel-patch-compare-at-path") {
			if (taskArgs.length === 0) {
				notify(ctx, "parallel-patch-compare-at-path requires a repo path as the first argument.", "error");
				return;
			}
			if (runtime.cwd) {
				notify(ctx, "--cwd is ignored for parallel-patch-compare-at-path (using first positional path).", "warning");
			}
			compareCwd = resolveCompareCwd(taskArgs[0]!, ctx);
			taskArgs = taskArgs.slice(1);
			if (taskArgs.length === 0) {
				notify(ctx, "parallel-patch-compare-at-path requires an implementation task after the repo path.", "error");
				return;
			}
		}

		if (!existsSync(compareCwd)) {
			notify(ctx, `cwd directory does not exist: ${compareCwd}`, "error");
			return;
		}

		const baseModel = await resolveCompareBaseModel(prompt, currentModel, ctx, runtime.model);
		if (!baseModel) return;

		const rendered = renderPromptForResolvedModel(prompt, taskArgs, baseModel);
		if (rendered.warning) notify(ctx, rendered.warning, "warning");
		if (rendered.empty || !rendered.content) {
			notify(ctx, rendered.empty ?? `Prompt \`${prompt.name}\` rendered to an empty message.`, "error");
			return;
		}
		const sharedTask = rendered.content;

		const requestedWorkers = applyLineupActions(prompt.workers, lineupExtraction.actions, "workers") ?? [];
		const requestedReviewers = applyLineupActions(prompt.reviewers, lineupExtraction.actions, "reviewers") ?? [];
		const requestedFinalApplier = applyFinalApplierAction(prompt.finalApplier, lineupExtraction.actions);
		if (requestedFinalApplier && prompt.worktree !== true) {
			notify(ctx, "Compare prompts with finalApplier require worktree: true.", "error");
			return;
		}

		const workerSlots = expandLineupCounts(
			requestedWorkers.length > 0
				? requestedWorkers
				: [{ agent: DEFAULT_SUBAGENT_NAME }],
		);
		const reviewerSlots = expandLineupCounts(
			requestedReviewers.length > 0
				? requestedReviewers
				: [{ agent: "reviewer" }],
		);

		const normalizedWorkers = normalizeLineupCwds(workerSlots, compareCwd, ctx);
		if (!normalizedWorkers) return;
		const normalizedReviewers = normalizeLineupCwds(reviewerSlots, compareCwd, ctx);
		if (!normalizedReviewers) return;
		const normalizedFinalApplier = requestedFinalApplier
			? {
				...requestedFinalApplier,
				cwd: compareCwd,
			}
			: undefined;

		if (prompt.worktree === true) {
			const uniqueWorkerCwds = new Set(normalizedWorkers.map((slot) => slot.cwd));
			if (uniqueWorkerCwds.size > 1) {
				notify(ctx, "worktree compare runs require all worker slots to use the same cwd.", "error");
				return;
			}
		}

		try {
			const workerResult = await executeSubagentPromptStep({
				pi,
				ctx,
				currentModel: baseModel,
				signal: ctx.signal,
				worktree: prompt.worktree === true,
				allowPartialFailures: true,
				parallel: normalizedWorkers.map((slot, index) => ({
					prompt: buildComparePrompt(prompt, {
						name: `${prompt.name}-worker-${index + 1}`,
						agent: slot.agent,
						task: buildLineupSlotTask(sharedTask, slot, taskArgs),
						model: slot.model,
						cwd: slot.cwd!,
						inheritContext: true,
					}),
					args: [],
				})),
			});
			const workerPairs = (workerResult?.parallelResults ?? []).map((result, index) => ({
				index,
				slot: normalizedWorkers[index]!,
				result,
			}));
			if (workerPairs.length === 0) return;
			const successfulWorkers = workerPairs.filter((entry) => !entry.result.isError);
			const failedWorkers = workerPairs.filter((entry) => entry.result.isError);
			if (successfulWorkers.length === 0) {
				notify(ctx, `Compare worker phase failed: all worker slots failed.`, "error");
				return;
			}
			const successfulWorkerText = [
				renderComparePhaseResults("Worker", successfulWorkers),
				extractSuccessfulWorktreeChanges(workerResult.text, successfulWorkers.map((entry) => entry.index)),
			]
				.filter((value): value is string => Boolean(value))
				.join("\n\n");
			const workerFailureSummary = formatPhaseFailureSummary("Worker", failedWorkers);

			const reviewerPreamble = buildReviewerPreamble(sharedTask, successfulWorkerText, workerFailureSummary);
			const reviewerResult = await executeSubagentPromptStep({
				pi,
				ctx,
				currentModel: baseModel,
				signal: ctx.signal,
				taskPreamble: reviewerPreamble,
				allowPartialFailures: true,
				parallel: normalizedReviewers.map((slot, index) => ({
					prompt: buildComparePrompt(prompt, {
						name: `${prompt.name}-reviewer-${index + 1}`,
						agent: slot.agent,
						task: buildLineupSlotTask(DEFAULT_COMPARE_REVIEWER_TASK, slot, taskArgs),
						model: slot.model,
						cwd: slot.cwd!,
						inheritContext: false,
					}),
					args: [],
				})),
			});
			const reviewerPairs = (reviewerResult?.parallelResults ?? []).map((result, index) => ({
				index,
				slot: normalizedReviewers[index]!,
				result,
			}));
			if (reviewerPairs.length === 0) return;
			const successfulReviewers = reviewerPairs.filter((entry) => !entry.result.isError);
			const failedReviewers = reviewerPairs.filter((entry) => entry.result.isError);
			const successfulReviewerText = successfulReviewers.length > 0
				? renderComparePhaseResults("Reviewer", successfulReviewers)
				: undefined;
			const reviewerFailureSummary = formatPhaseFailureSummary("Reviewer", failedReviewers);

			if (!normalizedFinalApplier) {
				if (!successfulReviewerText) {
					notify(ctx, `Compare reviewer phase failed: all reviewer slots failed.`, "error");
					return;
				}
				const finalText = reviewerFailureSummary
					? `${successfulReviewerText}\n\n${reviewerFailureSummary}`
					: successfulReviewerText;
				pi.sendUserMessage(`[Compare review complete: ${name}]\n\n${finalText}`);
				await waitForTurnStart(ctx);
				await ctx.waitForIdle();
				return;
			}

			const finalResult = await executeSubagentPromptStep({
				pi,
				ctx,
				currentModel: baseModel,
				signal: ctx.signal,
				taskPreamble: buildFinalApplierPreamble(
					sharedTask,
					successfulWorkerText,
					workerFailureSummary,
					successfulReviewerText,
					reviewerFailureSummary,
				),
				prompt: buildComparePrompt(prompt, {
					name: `${prompt.name}-final-applier`,
					agent: normalizedFinalApplier.agent,
					task: buildLineupSlotTask(DEFAULT_COMPARE_FINAL_APPLIER_TASK, normalizedFinalApplier, taskArgs),
					model: normalizedFinalApplier.model,
					cwd: compareCwd,
					inheritContext: false,
				}),
				args: [],
			});
			if (!finalResult?.text) return;
			pi.sendUserMessage(`[Compare apply complete: ${name}]\n\n${finalResult.text}`);
			await waitForTurnStart(ctx);
			await ctx.waitForIdle();
		} catch (error) {
			notify(ctx, error instanceof Error ? error.message : String(error), "error");
		}
	}

	async function collapseBoomerangPrompt(
		ctx: ExtensionContext,
		name: string,
		targetId: string | null,
		previousSummaries: string[] = [],
	) {
		if (!targetId) {
			notify(ctx, `Cannot boomerang prompt \`${name}\`: no session entry to return to.`, "warning");
			return;
		}

		boomerangCollapse = { targetId, task: name, previousSummaries };
		try {
			(globalThis as typeof globalThis & { __boomerangCollapseInProgress?: boolean }).__boomerangCollapseInProgress = true;
			const result = await ctx.navigateTree(targetId, { summarize: true });
			if (result.cancelled) notify(ctx, `Boomerang cancelled for prompt \`${name}\``, "warning");
		} finally {
			(globalThis as typeof globalThis & { __boomerangCollapseInProgress?: boolean }).__boomerangCollapseInProgress = false;
			boomerangCollapse = null;
		}
	}

	async function runPromptLoop(
		name: string,
		cleanedArgs: string,
		totalIterations: number | null,
		freshFlag: boolean,
		converge: boolean,
		ctx: ExtensionCommandContext,
		subagentOverride?: SubagentOverride,
		cwdOverride?: string,
		promptOverrides?: Partial<Pick<PromptWithModel, "models" | "inheritContext">>,
	) {
		refreshPrompts(ctx.cwd, ctx);
		const initialPrompt = prompts.get(name);
		if (!initialPrompt) {
			notify(ctx, `Prompt "${name}" no longer exists`, "error");
			return;
		}

		const savedModel = getCurrentModel(ctx);
		const savedThinking = pi.getThinkingLevel();
		let currentModel = savedModel;
		let currentThinking = savedThinking;
		const shouldRestore = initialPrompt.restore;
		const useFresh = freshFlag || initialPrompt.fresh === true;
		const shouldBoomerang = initialPrompt.boomerang === true;
		const effectiveMax = totalIterations ?? UNLIMITED_LOOP_CAP;
		const isUnlimited = totalIterations === null;
		const useConverge = converge && initialPrompt.converge !== false;
		const anchorId = useFresh || shouldBoomerang ? ctx.sessionManager.getLeafId() : null;

		loopState = { currentIteration: 1, totalIterations };
		accumulatedSummaries = [];
		updateLoopStatus(ctx);
		let completedIterations = 0;
		let converged = false;
		let loopErrorState: ExecutionErrorState = { hasError: false, error: undefined };
		let lastDelegatedText: string | undefined;
		let loopAborted = false;
		let boomerangPreviousSummaries: string[] = [];

		try {
			for (let i = 0; i < effectiveMax; i++) {
				loopState.currentIteration = i + 1;
				const iterationLabel = totalIterations !== null ? `${i + 1}/${totalIterations}` : `${i + 1}`;

				refreshPrompts(ctx.cwd, ctx);
				const prompt = prompts.get(name);
				if (!prompt) {
					notify(ctx, `Prompt "${name}" no longer exists`, "error");
					loopAborted = true;
					break;
				}
				const effectivePrompt = { ...prompt, ...(cwdOverride ? { cwd: cwdOverride } : {}), ...promptOverrides };
				let iterationPrompt = effectivePrompt;
				loopState!.rotationLabel = undefined;
				if (effectivePrompt.rotate && effectivePrompt.models.length > 1) {
					const rotationIndex = i % effectivePrompt.models.length;
					const rotatedThinking = effectivePrompt.thinkingLevels
						? effectivePrompt.thinkingLevels[rotationIndex]
						: effectivePrompt.thinking;
					iterationPrompt = {
						...effectivePrompt,
						models: [effectivePrompt.models[rotationIndex]],
						thinking: rotatedThinking,
					};
					const shortModel = effectivePrompt.models[rotationIndex].split("/").pop() || effectivePrompt.models[rotationIndex];
					const thinkingLabel = rotatedThinking ? ` ${rotatedThinking}` : "";
					loopState!.rotationLabel = `${shortModel}${thinkingLabel}`;
				}
				updateLoopStatus(ctx);
				const rotationSuffix = loopState!.rotationLabel ? ` [${loopState!.rotationLabel}]` : "";
				notify(ctx, `Loop ${iterationLabel}: ${name}${rotationSuffix}`, "info");

				const loopContext = loopState!.rotationLabel
					? `Loop ${iterationLabel} · ${loopState!.rotationLabel}`
					: `Loop ${iterationLabel}`;
				const iterationStartId = ctx.sessionManager.getLeafId();
				const stepResult = await executePromptStep(
					iterationPrompt,
					parseCommandArgs(cleanedArgs),
					ctx,
					currentModel,
					subagentOverride,
					undefined,
					undefined,
					loopContext,
				);
				if (stepResult === "aborted") {
					loopAborted = true;
					break;
				}
				const delegatedStep = shouldDelegatePrompt(iterationPrompt, subagentOverride);
				if (delegatedStep) {
					lastDelegatedText = stepResult.text;
				}

				currentModel = getCurrentModel(ctx);
				currentThinking = pi.getThinkingLevel();
				completedIterations++;

				const iterationChanged = delegatedStep
					? stepResult.changed
					: didIterationMakeChanges(getIterationEntries(ctx, iterationStartId));
				if (useConverge && (isUnlimited || effectiveMax > 1) && !iterationChanged) {
					converged = true;
					break;
				}

				if (useFresh && anchorId && i < effectiveMax - 1) {
					freshCollapse = { targetId: anchorId, task: name, iteration: i + 1, totalIterations };
					const result = await ctx.navigateTree(anchorId, { summarize: true });
					freshCollapse = null;
					if (result.cancelled) {
						loopAborted = true;
						notify(ctx, "Loop cancelled", "warning");
						break;
					}
				}
			}
		} catch (error) {
			loopErrorState = { hasError: true, error };
		} finally {
			loopErrorState = await restoreAfterExecution(
				ctx,
				shouldRestore,
				savedModel,
				savedThinking,
				getCurrentModel(ctx),
				pi.getThinkingLevel(),
				loopErrorState,
				"loop",
			);

			boomerangPreviousSummaries = accumulatedSummaries;
			loopState = null;
			freshCollapse = null;
			boomerangCollapse = null;
			accumulatedSummaries = [];
			updateLoopStatus(ctx);

			if (!loopErrorState.hasError) {
				notifyLoopCompletion(ctx, completedIterations, totalIterations, effectiveMax, converged, false);
			}
		}

		if (lastDelegatedText && !loopErrorState.hasError && !loopAborted) {
			const label = converged
				? `Delegated loop converged after ${completedIterations} iteration(s): ${name}`
				: `Delegated loop completed ${completedIterations} iteration(s): ${name}`;
			pi.sendUserMessage(`[${label}]\n\n${lastDelegatedText}`);
			await waitForTurnStart(ctx);
			await ctx.waitForIdle();
		}

		if (!loopErrorState.hasError && !loopAborted && shouldBoomerang) {
			await collapseBoomerangPrompt(ctx, name, anchorId, boomerangPreviousSummaries);
		}

		if (loopErrorState.hasError) {
			throw loopErrorState.error;
		}
	}


	async function runPromptCommand(name: string, args: string, ctx: ExtensionCommandContext) {
		refreshPrompts(ctx.cwd, ctx);
		const prompt = prompts.get(name);
		if (!prompt) {
			notify(ctx, `Prompt "${name}" no longer exists`, "error");
			return;
		}

		const subagent = extractSubagentOverride(args);
		const runtimeCwd = subagent.cwd ? expandCwdPath(subagent.cwd) : undefined;
		if (subagent.cwd && !runtimeCwd) {
			notify(ctx, `Invalid --cwd path: must be absolute`, "error");
			return;
		}
		const argsWithoutSubagent = subagent.args;
		if (prompt.deterministic) {
			if (subagent.override || subagent.fork) {
				notify(ctx, `Deterministic prompts do not support runtime --subagent/--fork in v1`, "error");
				return;
			}
			if (extractLoopCount(argsWithoutSubagent)) {
				notify(ctx, `Deterministic prompts do not support runtime --loop in v1`, "error");
				return;
			}
		}

		const hasCompareLineup = prompt.workers !== undefined || prompt.reviewers !== undefined || prompt.finalApplier !== undefined;
		if (hasCompareLineup) {
			await runComparePrompt(
				name,
				prompt,
				argsWithoutSubagent,
				ctx,
				getCurrentModel(ctx),
				{
					cwd: runtimeCwd,
					model: subagent.model,
					subagentOverride: subagent.override,
					fork: subagent.fork,
				},
			);
			return;
		}

		const promptOverrides: Partial<Pick<PromptWithModel, "models" | "inheritContext">> = {
			...(subagent.model ? { models: [subagent.model] } : {}),
			...(subagent.fork ? { inheritContext: true } : {}),
		};

		const loop = extractLoopCount(argsWithoutSubagent);
		if (loop) {
			await runPromptLoop(name, loop.args, loop.loopCount, loop.fresh, loop.converge, ctx, subagent.override, runtimeCwd, promptOverrides);
			return;
		}

		if (prompt.loop !== undefined) {
			const flags = extractLoopFlags(argsWithoutSubagent);
			await runPromptLoop(name, flags.args, prompt.loop, flags.fresh, flags.converge, ctx, subagent.override, runtimeCwd, promptOverrides);
			return;
		}

		const effectivePrompt = {
			...prompt,
			...(runtimeCwd ? {
				cwd: runtimeCwd,
				...(prompt.deterministic ? { deterministic: { ...prompt.deterministic, cwd: runtimeCwd } } : {}),
			} : {}),
			...promptOverrides,
		};
		const savedModel = getCurrentModel(ctx);
		const savedThinking = pi.getThinkingLevel();
		const boomerangTargetId = effectivePrompt.boomerang ? ctx.sessionManager.getLeafId() : null;
		const stepResult = await executePromptStep(
			effectivePrompt,
			parseCommandArgs(argsWithoutSubagent),
			ctx,
			savedModel,
			subagent.override,
		);
		if (stepResult === "aborted") return;
		if (shouldDelegatePrompt(effectivePrompt, subagent.override) && stepResult.text) {
			pi.sendUserMessage(`[Delegated result: ${name}]\n\n${stepResult.text}`);
			await waitForTurnStart(ctx);
			await ctx.waitForIdle();
		}

		if (!shouldDelegatePrompt(effectivePrompt, subagent.override) && prompt.restore) {
			const currentModel = getCurrentModel(ctx);
			const currentThinking = pi.getThinkingLevel();
			const needsModelRestore = savedModel && currentModel && !sameModel(savedModel, currentModel);
			const needsThinkingRestore = effectivePrompt.thinking && effectivePrompt.thinking !== savedThinking;
			if (needsModelRestore || needsThinkingRestore) {
				await restoreSessionState(
					ctx,
					needsModelRestore ? savedModel : undefined,
					needsThinkingRestore ? savedThinking : undefined,
					currentModel,
					currentThinking,
				);
			}
		}

		if (effectivePrompt.boomerang) {
			await collapseBoomerangPrompt(ctx, name, boomerangTargetId);
		}
	}

	function resetSessionScopedState(ctx: ExtensionContext) {
		previousModel = undefined;
		previousThinking = undefined;
		runtimeModel = ctx.model;
		boomerangCollapse = null;
		refreshPrompts(ctx.cwd, ctx);
	}

	pi.on("session_start", async (_event, ctx) => {
		resetSessionScopedState(ctx);
	});

	pi.on("model_select", async (event) => {
		runtimeModel = event.model;
	});

	pi.on("agent_end", async (_event, ctx) => {
		if (loopState) return;

		runtimeModel = ctx.model;

		const restoreModel = previousModel;
		const restoreThinking = previousThinking;
		previousModel = undefined;
		previousThinking = undefined;

		if (restoreModel || restoreThinking !== undefined) {
			await restoreSessionState(ctx, restoreModel, restoreThinking, getCurrentModel(ctx), pi.getThinkingLevel());
		}
	});

	pi.on("session_before_tree", async (event) => {
		if (boomerangCollapse && event.preparation.targetId === boomerangCollapse.targetId) {
			const summary = generateBoomerangSummary(event.preparation.entriesToSummarize, boomerangCollapse.task);
			return {
				summary: {
					summary: [...boomerangCollapse.previousSummaries, summary].join("\n\n---\n\n"),
				},
			};
		}

		if (!freshCollapse) return;
		if (event.preparation.targetId !== freshCollapse.targetId) return;

		const summary = generateIterationSummary(
			event.preparation.entriesToSummarize,
			freshCollapse.task,
			freshCollapse.iteration,
			freshCollapse.totalIterations,
		);
		accumulatedSummaries.push(summary);

		return {
			summary: {
				summary: accumulatedSummaries.join("\n\n---\n\n"),
			},
		};
	});

	refreshPrompts(process.cwd());
}
