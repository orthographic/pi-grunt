import { randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import type { AgentSession, CreateAgentSessionOptions, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
	createAgentSession,
	DefaultResourceLoader,
	defineTool,
	ModelRuntime,
	SessionManager,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

export const GRUNT_PROFILE_NAMES = ["worker", "scout", "implementer", "verifier"] as const;
export type GruntProfileName = typeof GRUNT_PROFILE_NAMES[number];
export type GruntThinking = "low" | "high";
export type GruntRunStatus = "running" | "completed" | "failed" | "timed_out" | "cancelled";

export type GruntUsage = {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: number;
	turns: number;
};

export type GruntProgress = {
	currentTool?: string;
	currentToolArgs?: string;
	durationMs: number;
	tokens: number;
	toolCount: number;
	turns: number;
	recentOutput: string[];
};

export type GruntRunSnapshot = {
	runId: string;
	profile: GruntProfileName;
	status: GruntRunStatus;
	agent: "grunt-worker";
	model?: string;
	thinking: GruntThinking;
	cwd: string;
	startedAt: number;
	updatedAt: number;
	completedAt?: number;
	error?: string;
	finalOutput?: string;
	sessionFile?: string;
	usage: GruntUsage;
	progress: GruntProgress;
};

export type GruntRunResponse = GruntRunSnapshot & {
	result?: { kind: "text"; text: string };
};

export type GruntSupervisorRequest = {
	runId: string;
	reason: "need_decision" | "interview_request" | "progress_update";
	message: string;
};

export type GruntSupervisor = (request: GruntSupervisorRequest) => Promise<string | undefined>;
export type GruntProgressHandler = (text: string) => void;

export type GruntRunOptions = {
	ctx: ExtensionContext;
	task: string;
	model: string;
	thinking: GruntThinking;
	profile?: GruntProfileName;
	timeoutMs?: number;
	signal?: AbortSignal;
	onProgress?: GruntProgressHandler;
	onSupervisorRequest?: GruntSupervisor;
	resumeRunId?: string;
};

type SessionFactory = (options: CreateAgentSessionOptions) => ReturnType<typeof createAgentSession>;

type ActiveRun = GruntRunSnapshot & {
	session?: AgentSession;
	abort?: (reason: "timed_out" | "cancelled") => void;
};

const WORKER_TOOLS = ["read", "grep", "find", "ls", "bash", "edit", "write", "contact_supervisor"] as const;
const PROFILE_FILES: Record<GruntProfileName, string> = {
	worker: "grunt-worker.md",
	scout: "grunt-scout.md",
	implementer: "grunt-implementer.md",
	verifier: "grunt-verifier.md",
};
const PROFILE_TOOLS: Record<GruntProfileName, readonly string[]> = {
	worker: WORKER_TOOLS,
	scout: ["read", "grep", "find", "ls", "contact_supervisor"],
	implementer: WORKER_TOOLS,
	verifier: ["read", "grep", "find", "ls", "bash", "contact_supervisor"],
};
const RUN_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MAX_RECENT_OUTPUT = 10;
const MAX_TOOL_ARGS = 240;

const ContactSupervisorParams = Type.Object({
	reason: Type.Union([
		Type.Literal("need_decision"),
		Type.Literal("interview_request"),
		Type.Literal("progress_update"),
	]),
	message: Type.String({ minLength: 1 }),
});

function agentDir(): string {
	return process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent");
}

function runRoot(dir: string): string {
	return join(dir, "grunt-runs");
}

function runDir(dir: string, runId: string): string {
	return join(runRoot(dir), runId);
}

function metadataPath(dir: string, runId: string): string {
	return join(runDir(dir, runId), "metadata.json");
}

function assertRunId(runId: string): void {
	if (!RUN_ID_PATTERN.test(runId)) throw new Error(`Invalid Grunt run id: ${runId}`);
}

function isGruntProfile(value: unknown): value is GruntProfileName {
	return typeof value === "string" && (GRUNT_PROFILE_NAMES as readonly string[]).includes(value);
}

function normalizeProfile(value: unknown): GruntProfileName {
	if (value === undefined) return "worker";
	if (!isGruntProfile(value)) throw new Error(`Unknown Grunt profile: ${String(value)}`);
	return value;
}

/** Return the body of a Markdown agent profile, excluding YAML frontmatter. */
export function workerPromptFromProfile(markdown: string): string {
	if (!markdown.startsWith("---")) return markdown.trim();
	const end = markdown.indexOf("\n---", 3);
	if (end < 0) return markdown.trim();
	return markdown.slice(end + "\n---".length).trim();
}

function textFromContent(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content.flatMap((part) => {
		if (!part || typeof part !== "object") return [];
		const value = part as { type?: unknown; text?: unknown };
		return value.type === "text" && typeof value.text === "string" ? [value.text] : [];
	}).join("");
}

function finalAssistantText(messages: readonly unknown[]): string {
	for (let index = messages.length - 1; index >= 0; index -= 1) {
		const message = messages[index] as { role?: unknown; content?: unknown } | undefined;
		if (message?.role === "assistant") {
			const text = textFromContent(message.content);
			if (text.trim()) return text;
		}
	}
	return "";
}

function addUsage(target: GruntUsage, usage: unknown): void {
	if (!usage || typeof usage !== "object") return;
	const value = usage as {
		input?: unknown;
		output?: unknown;
		cacheRead?: unknown;
		cacheWrite?: unknown;
		cost?: { total?: unknown };
	};
	const number = (candidate: unknown) => typeof candidate === "number" && Number.isFinite(candidate) ? candidate : 0;
	target.input += number(value.input);
	target.output += number(value.output);
	target.cacheRead += number(value.cacheRead);
	target.cacheWrite += number(value.cacheWrite);
	target.cost += number(value.cost?.total);
}

function boundedArgs(args: unknown): string | undefined {
	if (args === undefined) return undefined;
	let text: string;
	try {
		text = JSON.stringify(args);
	} catch {
		text = String(args);
	}
	return text.length > MAX_TOOL_ARGS ? `${text.slice(0, MAX_TOOL_ARGS)}…` : text;
}

function appendRecentOutput(progress: GruntProgress, text: string): void {
	const lines = text.split("\n").map((line) => line.trim()).filter(Boolean);
	if (!lines.length) return;
	progress.recentOutput.push(...lines.slice(-MAX_RECENT_OUTPUT));
	if (progress.recentOutput.length > MAX_RECENT_OUTPUT) {
		progress.recentOutput.splice(0, progress.recentOutput.length - MAX_RECENT_OUTPUT);
	}
}

function emptyUsage(): GruntUsage {
	return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 };
}

function emptyProgress(): GruntProgress {
	return { durationMs: 0, tokens: 0, toolCount: 0, turns: 0, recentOutput: [] };
}

function displayProgress(snapshot: GruntRunSnapshot): string {
	const parts = [
		snapshot.progress.currentTool,
		`${Math.floor(snapshot.progress.durationMs / 1000)}s`,
		`${snapshot.progress.tokens} tokens`,
		`${snapshot.progress.toolCount} tools`,
	].filter(Boolean);
	return `Grunt: ${parts.join(" · ")}`;
}

function modelParts(modelId: string): { provider: string; id: string } {
	const separator = modelId.indexOf("/");
	if (separator <= 0 || separator === modelId.length - 1) {
		throw new Error(`Grunt model must use provider/model form: ${modelId}`);
	}
	return { provider: modelId.slice(0, separator), id: modelId.slice(separator + 1) };
}

async function readWorkerPrompt(path: string): Promise<string> {
	const prompt = workerPromptFromProfile(await readFile(path, "utf8"));
	if (!prompt) throw new Error(`Grunt worker profile is empty: ${path}`);
	return prompt;
}

async function writeSnapshot(path: string, snapshot: GruntRunSnapshot): Promise<void> {
	await mkdir(dirname(path), { recursive: true, mode: 0o700 });
	await writeFile(path, `${JSON.stringify(snapshot, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
}

function snapshotForPersistence(run: ActiveRun): GruntRunSnapshot {
	return {
		runId: run.runId,
		profile: run.profile,
		status: run.status,
		agent: run.agent,
		...(run.model ? { model: run.model } : {}),
		thinking: run.thinking,
		cwd: run.cwd,
		startedAt: run.startedAt,
		updatedAt: run.updatedAt,
		...(run.completedAt ? { completedAt: run.completedAt } : {}),
		...(run.error ? { error: run.error } : {}),
		...(run.finalOutput ? { finalOutput: run.finalOutput } : {}),
		...(run.sessionFile ? { sessionFile: run.sessionFile } : {}),
		usage: { ...run.usage },
		progress: { ...run.progress, recentOutput: [...run.progress.recentOutput] },
	};
}

export class GruntRunner {
	private readonly runs = new Map<string, ActiveRun>();
	private readonly createSession: SessionFactory;
	private readonly configuredAgentDir: string;
	private readonly agentsDir: string;
	private readonly workerProfilePath: string;

	constructor(options: {
		agentDir?: string;
		agentsDir?: string;
		workerProfilePath?: string;
		createSession?: SessionFactory;
	} = {}) {
		this.configuredAgentDir = options.agentDir ?? agentDir();
		this.agentsDir = options.agentsDir ?? join(this.configuredAgentDir, "agents");
		this.workerProfilePath = options.workerProfilePath ?? join(this.agentsDir, "grunt-worker.md");
		this.createSession = options.createSession ?? createAgentSession;
	}

	async run(options: GruntRunOptions): Promise<GruntRunResponse> {
		const runId = options.resumeRunId ?? randomUUID();
		assertRunId(runId);
		if (this.runs.get(runId)?.status === "running") {
			throw new Error(`Grunt run '${runId}' is already running.`);
		}

		const existing = options.resumeRunId ? await this.loadSnapshot(runId) : undefined;
		if (options.resumeRunId && !existing) throw new Error(`Grunt run '${runId}' was not found.`);
		const selectedProfile = normalizeProfile(options.profile ?? existing?.profile);
		const record: ActiveRun = {
			...(existing ?? {
				runId,
				profile: selectedProfile,
				status: "running",
				agent: "grunt-worker",
				model: options.model,
				thinking: options.thinking,
				cwd: options.ctx.cwd,
				startedAt: Date.now(),
				updatedAt: Date.now(),
				usage: emptyUsage(),
				progress: emptyProgress(),
			}),
			status: "running",
			profile: selectedProfile,
			model: options.model,
			thinking: options.thinking,
			cwd: options.ctx.cwd,
			startedAt: Date.now(),
			updatedAt: Date.now(),
			completedAt: undefined,
			error: undefined,
			finalOutput: undefined,
			usage: emptyUsage(),
			progress: emptyProgress(),
		};
		this.runs.set(runId, record);
		await mkdir(runDir(this.configuredAgentDir, runId), { recursive: true, mode: 0o700 });
		await this.persist(record);

		let provider: string;
		let id: string;
		try {
			({ provider, id } = modelParts(options.model));
		} catch (error) {
			record.status = "failed";
			record.error = error instanceof Error ? error.message : String(error);
			record.completedAt = Date.now();
			record.updatedAt = record.completedAt;
			await this.persist(record);
			return this.response(record);
		}
		const parentModel = options.ctx.modelRegistry.find(provider, id);
		if (!parentModel) {
			record.status = "failed";
			record.error = `Grunt model is not available: ${options.model}`;
			record.completedAt = Date.now();
			record.updatedAt = record.completedAt;
			await this.persist(record);
			return this.response(record);
		}

		let session: AgentSession;
		try {
			const modelRuntime = await ModelRuntime.create({
				authPath: join(this.configuredAgentDir, "auth.json"),
				modelsPath: join(this.configuredAgentDir, "models.json"),
				refreshOnCreate: false,
			});
			const nativeProvider = options.ctx.modelRegistry.getRegisteredNativeProvider(provider);
			if (nativeProvider) modelRuntime.registerNativeProvider(nativeProvider);
			else {
				const providerConfig = options.ctx.modelRegistry.getRegisteredProviderConfig(provider);
				if (providerConfig) modelRuntime.registerProvider(provider, providerConfig);
			}

			const sessionDir = runDir(this.configuredAgentDir, runId);
			const existingSessionFile = existing?.sessionFile ? resolve(existing.sessionFile) : undefined;
			if (existingSessionFile) {
				const sessionRelativePath = relative(resolve(sessionDir), existingSessionFile);
				if (!sessionRelativePath || sessionRelativePath.startsWith("..") || isAbsolute(sessionRelativePath)) {
					throw new Error(`Grunt session file is outside its run directory: ${existingSessionFile}`);
				}
			}
			const sessionManager = existingSessionFile
				? SessionManager.open(existingSessionFile, sessionDir, options.ctx.cwd)
				: SessionManager.create(options.ctx.cwd, sessionDir);
			const workerPrompt = await readWorkerPrompt(
				selectedProfile === "worker"
					? this.workerProfilePath
					: join(this.agentsDir, PROFILE_FILES[selectedProfile]),
			);
			const supervisor = options.onSupervisorRequest;
			const contactSupervisor = defineTool({
				name: "contact_supervisor",
				label: "Contact supervisor",
				description: "Ask the primary session for a blocking decision or clarification.",
				parameters: ContactSupervisorParams,
				execute: async (_toolCallId, params) => {
					const reply = supervisor
						? await supervisor({ runId, reason: params.reason, message: params.message })
						: undefined;
					return {
						content: [{
							type: "text" as const,
							text: reply?.trim() || "No supervisor reply was available. Record the blocker and stop rather than guessing.",
						}],
						details: {},
					};
				},
			});
			const resourceLoader = new DefaultResourceLoader({
				cwd: options.ctx.cwd,
				agentDir: this.configuredAgentDir,
				noExtensions: true,
				noSkills: true,
				noPromptTemplates: true,
				noThemes: true,
				noContextFiles: true,
				systemPrompt: workerPrompt,
			});
			await resourceLoader.reload();

			const created = await this.createSession({
				cwd: options.ctx.cwd,
				agentDir: this.configuredAgentDir,
				modelRuntime,
				model: parentModel,
				thinkingLevel: options.thinking,
				tools: [...PROFILE_TOOLS[selectedProfile]],
				customTools: [contactSupervisor],
				resourceLoader,
				sessionManager,
			});
			session = created.session;
		} catch (error) {
			record.status = "failed";
			record.error = error instanceof Error ? error.message : String(error);
			record.completedAt = Date.now();
			record.updatedAt = record.completedAt;
			await this.persist(record);
			return this.response(record);
		}

		record.session = session;
		record.sessionFile = session.sessionFile;
		this.emitProgress(record, options.onProgress);
		await this.persist(record);
		let persistQueue = Promise.resolve();
		const queuePersist = () => {
			persistQueue = persistQueue.then(() => this.persist(record)).catch(() => undefined);
			return persistQueue;
		};

		let abortReason: "timed_out" | "cancelled" | undefined;
		let abortPromise: Promise<void> | undefined;
		const requestAbort = (reason: "timed_out" | "cancelled") => {
			if (abortReason) return;
			abortReason = reason;
			record.status = reason;
			record.error ??= reason === "timed_out" ? `Grunt timed out after ${options.timeoutMs}ms.` : "Grunt run cancelled.";
			record.updatedAt = Date.now();
			this.emitProgress(record, options.onProgress);
			abortPromise = session.abort().catch((error) => {
				record.error ??= error instanceof Error ? error.message : String(error);
			});
		};
		record.abort = requestAbort;

		let timeout: NodeJS.Timeout | undefined;
		const onAbort = () => requestAbort("cancelled");
		if (options.signal?.aborted) requestAbort("cancelled");
		else options.signal?.addEventListener("abort", onAbort, { once: true });
		if (options.timeoutMs !== undefined) {
			if (!Number.isSafeInteger(options.timeoutMs) || options.timeoutMs < 1) {
				requestAbort("timed_out");
			} else {
				timeout = setTimeout(() => requestAbort("timed_out"), options.timeoutMs);
			}
		}

		const unsubscribe = session.subscribe((event) => {
			const value = event as { type?: string; message?: unknown; toolName?: unknown; args?: unknown };
			const now = Date.now();
			record.updatedAt = now;
			record.progress.durationMs = now - record.startedAt;
			if (value.type === "tool_execution_start" && typeof value.toolName === "string") {
				record.progress.currentTool = value.toolName;
				record.progress.currentToolArgs = boundedArgs(value.args);
				record.progress.toolCount += 1;
			} else if (value.type === "tool_execution_end") {
				delete record.progress.currentTool;
				delete record.progress.currentToolArgs;
			} else if (value.type === "message_end" && value.message && typeof value.message === "object") {
				const message = value.message as {
					role?: unknown;
					content?: unknown;
					usage?: unknown;
					model?: unknown;
					stopReason?: unknown;
					errorMessage?: unknown;
				};
				if (message.role === "assistant") {
					record.usage.turns += 1;
					record.progress.turns = record.usage.turns;
					addUsage(record.usage, message.usage);
					record.progress.tokens = record.usage.input + record.usage.output + record.usage.cacheRead + record.usage.cacheWrite;
					if (typeof message.model === "string") record.model = message.model;
					const text = textFromContent(message.content);
					appendRecentOutput(record.progress, text);
				}
			}
			if (value.type === "agent_end" || value.type === "agent_settled" || value.type === "tool_execution_start" || value.type === "tool_execution_end" || value.type === "message_end") {
				this.emitProgress(record, options.onProgress);
				void queuePersist();
			}
		});

		try {
			if (!abortReason) await session.prompt(options.task);
			if (abortPromise) await abortPromise;
		} catch (error) {
			if (!abortReason) {
				record.status = "failed";
				record.error = error instanceof Error ? error.message : String(error);
			}
		} finally {
			if (timeout) clearTimeout(timeout);
			options.signal?.removeEventListener("abort", onAbort);
			unsubscribe();
		}

		if (abortReason) {
			record.status = abortReason;
		} else if (record.status === "running") {
			const lastAssistant = [...session.messages].reverse().find((message) => message.role === "assistant") as { stopReason?: string; errorMessage?: string } | undefined;
			if (record.error || lastAssistant?.stopReason === "error" || lastAssistant?.errorMessage) {
				record.status = "failed";
				record.error ??= lastAssistant?.errorMessage ?? "Worker assistant stopped with an error.";
			} else {
				record.status = "completed";
			}
		}
		record.finalOutput = finalAssistantText(session.messages);
		record.completedAt = Date.now();
		record.updatedAt = record.completedAt;
		record.sessionFile = session.sessionFile ?? record.sessionFile;
		delete record.abort;
		delete record.session;
		session.dispose();
		await persistQueue;
		await this.persist(record);
		return this.response(record);
	}

	async resume(options: Omit<GruntRunOptions, "resumeRunId" | "model" | "thinking"> & { runId: string; model?: string; thinking?: GruntThinking }): Promise<GruntRunResponse> {
		assertRunId(options.runId);
		const snapshot = this.runs.get(options.runId) ?? await this.loadSnapshot(options.runId);
		if (!snapshot) throw new Error(`Grunt run '${options.runId}' was not found.`);
		if (snapshot.status === "running") throw new Error(`Grunt run '${options.runId}' is already running.`);
		const model = options.model ?? snapshot.model;
		if (!model) throw new Error(`Grunt run '${options.runId}' has no recorded model.`);
		return this.run({
			...options,
			model,
			profile: options.profile ?? snapshot.profile,
			thinking: options.thinking ?? snapshot.thinking,
			resumeRunId: options.runId,
		});
	}

	async status(runId?: string): Promise<GruntRunSnapshot[]> {
		if (runId) {
			assertRunId(runId);
			const active = this.runs.get(runId);
			if (active) return [snapshotForPersistence(active)];
			const snapshot = await this.loadSnapshot(runId);
			return snapshot ? [snapshot] : [];
		}
		const snapshots = new Map<string, GruntRunSnapshot>();
		for (const run of this.runs.values()) snapshots.set(run.runId, snapshotForPersistence(run));
		try {
			// ponytail: O(n) run-dir scan; add an index if retained runs make status slow.
			const entries = await readdir(runRoot(this.configuredAgentDir), { withFileTypes: true });
			for (const entry of entries) {
				if (!entry.isDirectory() || !RUN_ID_PATTERN.test(entry.name) || snapshots.has(entry.name)) continue;
				const snapshot = await this.loadSnapshot(entry.name);
				if (snapshot) snapshots.set(snapshot.runId, snapshot);
			}
		} catch {
			// A missing run root is the normal empty state.
		}
		return [...snapshots.values()].sort((left, right) => right.updatedAt - left.updatedAt);
	}

	async cancel(runId: string): Promise<void> {
		assertRunId(runId);
		const run = this.runs.get(runId);
		if (!run?.abort) throw new Error(`Grunt run '${runId}' is not active in this Pi session.`);
		run.abort("cancelled");
	}

	async steer(runId: string, message: string): Promise<void> {
		assertRunId(runId);
		const run = this.runs.get(runId);
		if (!run?.session || !run.session.isStreaming) throw new Error(`Grunt run '${runId}' is not actively streaming; use resume instead.`);
		await run.session.steer(message);
	}

	private async loadSnapshot(runId: string): Promise<GruntRunSnapshot | undefined> {
		assertRunId(runId);
		try {
			const value = JSON.parse(await readFile(metadataPath(this.configuredAgentDir, runId), "utf8")) as GruntRunSnapshot & { profile?: unknown };
			if (value.runId !== runId || value.agent !== "grunt-worker") return undefined;
			const profile = normalizeProfile(value.profile);
			if (value.status === "running") {
				return {
					...value,
					profile,
					status: "failed",
					error: value.error ?? "The Pi process ended before this Grunt run settled.",
					completedAt: value.completedAt ?? value.updatedAt,
				};
			}
			return { ...value, profile };
		} catch {
			return undefined;
		}
	}

	private async persist(run: ActiveRun): Promise<void> {
		await writeSnapshot(metadataPath(this.configuredAgentDir, run.runId), snapshotForPersistence(run));
	}

	private emitProgress(run: ActiveRun, onProgress: GruntProgressHandler | undefined): void {
		onProgress?.(displayProgress(run));
	}

	private response(run: ActiveRun | GruntRunSnapshot): GruntRunResponse {
		const snapshot = "session" in run ? snapshotForPersistence(run) : run;
		return {
			...snapshot,
			...(snapshot.status === "completed" && snapshot.finalOutput !== undefined
				? { result: { kind: "text", text: snapshot.finalOutput } }
				: {}),
		};
	}
}

export function createDefaultGruntRunner(options: { agentDir?: string; agentsDir?: string } = {}): GruntRunner {
	return new GruntRunner(options);
}
