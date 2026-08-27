import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES, formatSize, truncateHead } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { preferenceJson, selectableModelIds } from "./grunt-model-preference.mjs";
import {
  createDefaultGruntRunner,
  type GruntProfileName,
  type GruntRunResponse,
  type GruntSupervisorRequest,
  type GruntThinking,
} from "./grunt-runner.ts";

const preferencePath = join(process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent"), "grunt-model.json");
// Agents ship with this package; run state + auth/models stay in the user's agent dir.
const gruntRunner = createDefaultGruntRunner({
  agentsDir: join(dirname(fileURLToPath(import.meta.url)), "agents"),
});
let previousExclusiveGrunt = Promise.resolve();
let sharedGruntBatch = Promise.resolve();

function choices(ctx: ExtensionContext) {
  return selectableModelIds(ctx.scopedModels, ctx.modelRegistry.getAvailable());
}

// Return the persisted worker model unconditionally. A saved choice is honored even
// if it is missing from the current session's available set; grunt-runner validates
// real availability and errors clearly if the model is genuinely gone. Filtering here
// allowed a persisted model to silently fall back to a different default (e.g. Flash).
async function preferredModel(): Promise<string | undefined> {
  try {
    const model = JSON.parse(await readFile(preferencePath, "utf8")).model;
    return typeof model === "string" && model.includes("/") ? model : undefined;
  } catch {
    return undefined;
  }
}

async function selectModel(ctx: ExtensionContext) {
  const models = choices(ctx);
  if (!models.length) throw new Error("No selectable models are available for Grunt.");
  const current = await preferredModel();
  // ui.select has no default-index/label support, so put the current model first
  // (the picker defaults to the top of the list) and name it in the title.
  const ordered = current && models.includes(current)
    ? [current, ...models.filter((m) => m !== current)]
    : models;
  const model = await ctx.ui.select(
    current ? `Select Grunt worker model (current: ${current})` : "Select Grunt worker model",
    ordered,
  );
  if (!model) return undefined;
  await mkdir(dirname(preferencePath), { recursive: true });
  await writeFile(preferencePath, preferenceJson(model));
  return model;
}

async function ensureModel(ctx: ExtensionContext) {
  const saved = await preferredModel();
  if (saved) return saved;
  if (!ctx.hasUI) return undefined;
  return selectModel(ctx);
}

async function supervisorReply(ctx: ExtensionContext, request: GruntSupervisorRequest): Promise<string | undefined> {
  const prefix = `Grunt worker ${request.runId.slice(0, 8)} asks (${request.reason})`;
  if (request.reason === "progress_update") {
    if (ctx.hasUI) ctx.ui.notify(`${prefix}: ${request.message}`, "info");
    return "Acknowledged. Continue the assigned packet.";
  }
  // Defer decisions to the primary agent instead of blocking on a modal that pressures
  // the user into an immediate reply. Returning undefined makes the worker see "no
  // supervisor reply", record a blocker, and stop rather than guess. The primary agent
  // (or user) then replies with /grunt-answer, which resumes the run with the decision.
  if (ctx.hasUI) {
    ctx.ui.notify(
      `${prefix}:\n${truncateHead(request.message, { maxLines: 12, maxBytes: 2000 }).content}\n\nReply with /grunt-answer ${request.runId.slice(0, 8)} <decision>.`,
      "warning",
    );
  }
  return undefined;
}

async function runGrunt(
  ctx: ExtensionContext,
  task: string,
  model: string,
  profile: GruntProfileName,
  thinking: GruntThinking,
  timeoutMs: number | undefined,
  signal: AbortSignal | undefined,
  onProgress: ((text: string) => void) | undefined,
): Promise<GruntRunResponse> {
  return gruntRunner.run({
    ctx,
    task,
    model,
    profile,
    thinking,
    timeoutMs,
    signal,
    onProgress,
    onSupervisorRequest: (request) => supervisorReply(ctx, request),
  });
}

export function enqueueGrunt<T>(profile: GruntProfileName, run: () => Promise<T>): Promise<T> {
  if (profile === "scout") {
    const result = previousExclusiveGrunt.then(run, run);
    sharedGruntBatch = Promise.all([
      sharedGruntBatch,
      result.then(() => undefined, () => undefined),
    ]).then(() => undefined);
    return result;
  }

  // ponytail: only pure scout runs share a checkout phase; parallel writes need per-run worktrees.
  const result = Promise.all([previousExclusiveGrunt, sharedGruntBatch]).then(run, run);
  previousExclusiveGrunt = result.then(() => undefined, () => undefined);
  sharedGruntBatch = Promise.resolve();
  return result;
}

function splitRunCommand(args: string): { runId: string; rest: string } | undefined {
  const value = args.trim();
  if (!value) return undefined;
  const separator = value.search(/\s/);
  return separator < 0
    ? { runId: value, rest: "" }
    : { runId: value.slice(0, separator), rest: value.slice(separator).trim() };
}

function formatRunStatus(run: GruntRunResponse): string {
  const progress = run.progress;
  const activity = [
    progress.currentTool,
    `${progress.toolCount} tools`,
    `${progress.tokens} tokens`,
  ].filter(Boolean).join(" · ");
  return [
    `${run.runId} ${run.status}`,
    `profile=${run.profile}`,
    run.model ? `model=${run.model}` : undefined,
    activity || undefined,
    run.error,
  ].filter(Boolean).join(" — ");
}

const GruntControlParams = Type.Object({
  action: Type.Union([
    Type.Literal("status"),
    Type.Literal("cancel"),
    Type.Literal("steer"),
    Type.Literal("resume"),
  ]),
  runId: Type.Optional(Type.String({ description: "Exact Grunt run id for cancel, steer, or resume." })),
  message: Type.Optional(Type.String({ description: "Steering message." })),
  task: Type.Optional(Type.String({ description: "Follow-up packet for resume." })),
  profile: Type.Optional(Type.Union([
    Type.Literal("worker"),
    Type.Literal("scout"),
    Type.Literal("implementer"),
    Type.Literal("verifier"),
  ], { description: "Profile override for a resume; otherwise the run's original profile is retained." })),
  effort: Type.Optional(Type.Union([
    Type.Literal("low"),
    Type.Literal("high"),
  ])),
}, { additionalProperties: false });

export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: "grunt",
    label: "Grunt",
    description: [
      "Delegate a bounded repository task to the configured Grunt worker.",
      "Use for bounded scouting, implementation, tests, and focused validation.",
      "Profiles: scout (read-only discovery; scout runs may overlap), implementer (authorized edits), verifier (read-only tests/review), worker (legacy mixed access).",
      "Implementer, verifier, and worker runs are serialized because they share the checkout; keep architecture, product decisions, scope approval, and final review in the parent session.",
      "Pass a compact packet with GOAL, SCOPE, AUTHORITY, INPUTS, CONSTRAINTS, VALIDATION, and OUTPUT.",
      "Use timeoutMs only when the task has a known upper bound; it stops the run but cannot roll back edits.",
      `Output is truncated to ${DEFAULT_MAX_LINES} lines or ${formatSize(DEFAULT_MAX_BYTES)} (whichever is hit first).`,
    ].join(" "),
    promptSnippet: "Delegate bounded repository exploration, implementation, or tests to Grunt.",
    promptGuidelines: [
      "Use grunt for bounded repository work; keep architectural decisions and final validation in the parent session.",
    ],
    parameters: Type.Object({
      task: Type.String({ description: "A bounded Grunt packet describing the task and its scope." }),
      profile: Type.Optional(Type.Union([
        Type.Literal("worker"),
        Type.Literal("scout"),
        Type.Literal("implementer"),
        Type.Literal("verifier"),
      ], { description: "Worker specialization. Defaults to worker; choose scout for discovery, implementer for edits, verifier for tests/review." })),
      effort: Type.Optional(Type.Union([
        Type.Literal("low"),
        Type.Literal("high"),
      ], { description: "Worker reasoning effort. Defaults to low." })),
      timeoutMs: Type.Optional(Type.Integer({
        minimum: 1,
        description: "Optional maximum runtime in milliseconds. This stops the run but cannot roll back edits.",
      })),
    }, { additionalProperties: false }),
    async execute(_toolCallId, params, signal, onUpdate, ctx) {
      const thinking = params.effort ?? "low";
      const profile = params.profile ?? "worker";
      const run = async () => {
        const model = await ensureModel(ctx);
        if (!model) throw new Error("No Grunt model is selected. Run /grunt-swap interactively.");
        const response = await runGrunt(
          ctx,
          params.task,
          model,
          profile,
          thinking,
          params.timeoutMs,
          signal,
          (text) => onUpdate?.({ content: [{ type: "text", text }], details: {} }),
        );
        if (response.status !== "completed") {
          throw new Error(`Grunt ${response.status}: ${response.error ?? "worker failed"}`);
        }
        if (response.result?.kind !== "text") {
          throw new Error("Grunt completed without a text handoff.");
        }

        // Bound model-visible output to Pi's standard truncation policy.
        const truncation = truncateHead(response.result.text, {
          maxLines: DEFAULT_MAX_LINES,
          maxBytes: DEFAULT_MAX_BYTES,
        });

        let text = truncation.content;
        if (truncation.truncated) {
          const omittedLines = truncation.totalLines - truncation.outputLines;
          const omittedBytes = truncation.totalBytes - truncation.outputBytes;
          text += [
            "",
            "",
            "⚠️  Output truncated.",
            `Showing ${truncation.outputLines} of ${truncation.totalLines} lines`,
            `(${formatSize(truncation.outputBytes)} of ${formatSize(truncation.totalBytes)}).`,
            `${omittedLines} lines (${formatSize(omittedBytes)}) omitted.`,
          ].join("\n");
        }

        const usage = response.usage && {
          input: response.usage.input,
          output: response.usage.output,
          cacheRead: response.usage.cacheRead,
          cacheWrite: response.usage.cacheWrite,
          totalTokens: response.usage.input + response.usage.output + response.usage.cacheRead + response.usage.cacheWrite,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: response.usage.cost },
        };

        return {
          content: [{ type: "text" as const, text }],
          usage,
          details: {
            agent: response.agent,
            profile: response.profile,
            model: response.model ?? model,
            thinking: response.thinking ?? thinking,
            runId: response.runId,
            status: response.status,
            sessionFile: response.sessionFile,
            progress: response.progress,
            usage: response.usage,
          },
        };
      };
      return enqueueGrunt(profile, run);
    },
  });

  pi.registerTool({
    name: "grunt_control",
    label: "Grunt control",
    description: "Inspect or control a standalone Grunt run without launching a duplicate packet.",
    parameters: GruntControlParams,
    async execute(_toolCallId, params, signal, onUpdate, ctx) {
      if (params.action === "status") {
        const runs = await gruntRunner.status(params.runId);
        return {
          content: [{ type: "text" as const, text: runs.length ? runs.map(formatRunStatus).join("\n") : "No Grunt runs found." }],
          details: { action: params.action, runs },
        };
      }
      if (!params.runId) throw new Error(`grunt_control action '${params.action}' requires runId.`);
      if (params.action === "cancel") {
        await gruntRunner.cancel(params.runId);
        return { content: [{ type: "text" as const, text: `Cancelled Grunt run ${params.runId}.` }], details: { action: params.action, runId: params.runId } };
      }
      if (params.action === "steer") {
        if (!params.message) throw new Error("grunt_control steer requires message.");
        await gruntRunner.steer(params.runId, params.message);
        return { content: [{ type: "text" as const, text: `Steering queued for Grunt run ${params.runId}.` }], details: { action: params.action, runId: params.runId } };
      }
      if (!params.task) throw new Error("grunt_control resume requires task.");
      const response = await enqueueGrunt(params.profile === "scout" ? "scout" : "worker", () => gruntRunner.resume({
        runId: params.runId!,
        task: params.task!,
        ctx,
        ...(params.profile ? { profile: params.profile } : {}),
        ...(params.effort ? { thinking: params.effort } : {}),
        signal,
        onProgress: (text) => onUpdate?.({ content: [{ type: "text", text }], details: {} }),
        onSupervisorRequest: (request) => supervisorReply(ctx, request),
      }));
      return {
        content: [{ type: "text" as const, text: response.finalOutput ?? response.error ?? `Grunt ${response.status}.` }],
        isError: response.status !== "completed",
        details: { action: params.action, runId: response.runId, profile: response.profile, status: response.status, sessionFile: response.sessionFile, usage: response.usage },
      };
    },
  });

  pi.registerCommand("grunt-swap", {
    description: "Choose and save the model used by /skill:grunt.",
    handler: async (_args, ctx) => {
      if (!ctx.hasUI) {
        ctx.ui.notify("/grunt-swap requires an interactive session.", "warning");
        return;
      }
      const model = await selectModel(ctx);
      if (model) ctx.ui.notify(`Grunt model set to ${model}.`, "info");
    },
  });

  pi.registerCommand("grunt-status", {
    description: "Show standalone Grunt run status.",
    handler: async (args, ctx) => {
      try {
        const runs = await gruntRunner.status(args.trim() || undefined);
        ctx.ui.notify(runs.length ? runs.map(formatRunStatus).join("\n") : "No Grunt runs found.", "info");
      } catch (error) {
        ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
      }
    },
  });

  pi.registerCommand("grunt-cancel", {
    description: "Cancel an active Grunt run by id.",
    handler: async (args, ctx) => {
      const parsed = splitRunCommand(args);
      if (!parsed) {
        ctx.ui.notify("Usage: /grunt-cancel <runId>", "warning");
        return;
      }
      try {
        await gruntRunner.cancel(parsed.runId);
        ctx.ui.notify(`Cancelled Grunt run ${parsed.runId}.`, "info");
      } catch (error) {
        ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
      }
    },
  });

  pi.registerCommand("grunt-steer", {
    description: "Steer an actively streaming Grunt run.",
    handler: async (args, ctx) => {
      const parsed = splitRunCommand(args);
      if (!parsed?.rest) {
        ctx.ui.notify("Usage: /grunt-steer <runId> <message>", "warning");
        return;
      }
      try {
        await gruntRunner.steer(parsed.runId, parsed.rest);
        ctx.ui.notify(`Steering queued for Grunt run ${parsed.runId}.`, "info");
      } catch (error) {
        ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
      }
    },
  });

  pi.registerCommand("grunt-resume", {
    description: "Resume a persisted Grunt run with a follow-up packet.",
    handler: async (args, ctx) => {
      const parsed = splitRunCommand(args);
      if (!parsed?.rest) {
        ctx.ui.notify("Usage: /grunt-resume <runId> <follow-up packet>", "warning");
        return;
      }
      try {
        ctx.ui.setStatus("grunt", `Resuming ${parsed.runId}…`);
        const response = await enqueueGrunt("worker", () => gruntRunner.resume({
          runId: parsed.runId,
          task: parsed.rest,
          ctx,
          signal: ctx.signal,
          onProgress: (text) => ctx.ui.setStatus("grunt", text),
          onSupervisorRequest: (request) => supervisorReply(ctx, request),
        }));
        ctx.ui.notify(response.status === "completed"
          ? `Grunt resumed: ${response.finalOutput || "(no output)"}`
          : `Grunt ${response.status}: ${response.error ?? "worker failed"}`,
        response.status === "completed" ? "info" : "error");
      } catch (error) {
        ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
      } finally {
        ctx.ui.setStatus("grunt", undefined);
      }
    },
  });

  pi.registerCommand("grunt-answer", {
    description: "Reply to a Grunt worker decision request; resumes the run with the decision.",
    handler: async (args, ctx) => {
      const parsed = splitRunCommand(args);
      if (!parsed?.rest) {
        ctx.ui.notify("Usage: /grunt-answer <runId> <decision>", "warning");
        return;
      }
      try {
        ctx.ui.setStatus("grunt", `Resuming ${parsed.runId}…`);
        const response = await enqueueGrunt("worker", () => gruntRunner.resume({
          runId: parsed.runId,
          task: `Decision from the supervisor: "${parsed.rest.trim()}". Incorporate it and continue the assigned packet.`,
          ctx,
          signal: ctx.signal,
          onProgress: (text) => ctx.ui.setStatus("grunt", text),
          onSupervisorRequest: (request) => supervisorReply(ctx, request),
        }));
        ctx.ui.notify(response.status === "completed"
          ? `Grunt answered: ${response.finalOutput || "(no output)"}`
          : `Grunt ${response.status}: ${response.error ?? "worker failed"}`,
        response.status === "completed" ? "info" : "error");
      } catch (error) {
        ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
      } finally {
        ctx.ui.setStatus("grunt", undefined);
      }
    },
  });
}
