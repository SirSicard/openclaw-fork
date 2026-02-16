/**
 * workflow_run — Multi-agent workflow orchestration tool.
 *
 * Provides structured patterns (sequential, parallel, dag) on top of
 * the existing sessions_spawn infrastructure.  Each step spawns a
 * sub-agent, collects its result, and feeds it forward according to
 * the chosen pattern.
 *
 * Design constraints:
 *  - Reuses callGateway("agent") + the subagent registry, exactly like
 *    sessions_spawn.
 *  - Checkpoint file written after each step so workflows survive
 *    crashes / compaction.
 *  - Respects maxSpawnDepth and maxChildrenPerAgent from config.
 */

import { Type, type Static } from "@sinclair/typebox";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import type { GatewayMessageChannel } from "../../utils/message-channel.js";
import type { AnyAgentTool } from "./common.js";
import { loadConfig } from "../../config/config.js";
import { callGateway } from "../../gateway/call.js";
import { normalizeAgentId, parseAgentSessionKey } from "../../routing/session-key.js";
import { normalizeDeliveryContext } from "../../utils/delivery-context.js";
import { AGENT_LANE_SUBAGENT } from "../lanes.js";
import { resolveDefaultModelForAgent } from "../model-selection.js";
import { buildSubagentSystemPrompt } from "../subagent-announce.js";
import { getSubagentDepthFromSessionStore } from "../subagent-depth.js";
import { countActiveRunsForSession, registerSubagentRun } from "../subagent-registry.js";
import { jsonResult, readStringParam } from "./common.js";
import {
  resolveInternalSessionKey,
  resolveMainSessionAlias,
} from "./sessions-helpers.js";
import { resolveWorkspaceRoot } from "../workspace-dir.js";

/* ------------------------------------------------------------------ */
/*  Schema                                                            */
/* ------------------------------------------------------------------ */

const WorkflowStepSchema = Type.Object({
  name: Type.String(),
  task: Type.String(),
  model: Type.Optional(Type.String()),
  thinking: Type.Optional(Type.String()),
  dependsOn: Type.Optional(Type.Array(Type.String())),
  timeoutSeconds: Type.Optional(Type.Number({ minimum: 0 })),
});

const WorkflowToolSchema = Type.Object({
  pattern: Type.Union([
    Type.Literal("sequential"),
    Type.Literal("parallel"),
    Type.Literal("dag"),
  ]),
  steps: Type.Array(WorkflowStepSchema),
  /** How to combine parallel results: concatenate (default) or merge */
  merge: Type.Optional(
    Type.Union([Type.Literal("concatenate"), Type.Literal("merge")]),
  ),
  /** Pass accumulated context from prior steps into each task prompt */
  passContext: Type.Optional(Type.Boolean()),
  /** Optional label for the whole workflow */
  label: Type.Optional(Type.String()),
  /** Resume from checkpoint if it exists */
  resume: Type.Optional(Type.Boolean()),
});

type WorkflowStep = Static<typeof WorkflowStepSchema>;

/* ------------------------------------------------------------------ */
/*  Checkpoint helpers                                                */
/* ------------------------------------------------------------------ */

interface WorkflowCheckpoint {
  workflowId: string;
  pattern: string;
  steps: string[];
  completed: Record<string, { result: string; durationMs: number }>;
  failed: Record<string, { error: string }>;
  status: "in_progress" | "done" | "failed";
  startedAt: number;
  updatedAt: number;
}

async function loadCheckpoint(
  checkpointPath: string,
): Promise<WorkflowCheckpoint | null> {
  try {
    const raw = await fs.readFile(checkpointPath, "utf-8");
    return JSON.parse(raw) as WorkflowCheckpoint;
  } catch {
    return null;
  }
}

async function saveCheckpoint(
  checkpointPath: string,
  checkpoint: WorkflowCheckpoint,
): Promise<void> {
  checkpoint.updatedAt = Date.now();
  await fs.mkdir(path.dirname(checkpointPath), { recursive: true });
  await fs.writeFile(checkpointPath, JSON.stringify(checkpoint, null, 2));
}

/* ------------------------------------------------------------------ */
/*  Step execution                                                    */
/* ------------------------------------------------------------------ */

/**
 * Spawn a single sub-agent step and wait for its result.
 *
 * Unlike sessions_spawn (fire-and-forget), we poll for the assistant
 * reply so we can chain steps.
 */
async function executeStep(opts: {
  step: WorkflowStep;
  contextText: string;
  requesterSessionKey: string;
  requesterOrigin?: ReturnType<typeof normalizeDeliveryContext>;
  callerDepth: number;
  maxSpawnDepth: number;
  agentId: string;
  cfg: ReturnType<typeof loadConfig>;
}): Promise<{ result: string; durationMs: number }> {
  const { step, contextText, requesterSessionKey, requesterOrigin, callerDepth, agentId, cfg } =
    opts;

  const childSessionKey = `agent:${agentId}:workflow:${crypto.randomUUID()}`;
  const childDepth = callerDepth + 1;

  // Build the task prompt, injecting context from prior steps
  let fullTask = step.task;
  if (contextText) {
    fullTask = `## Context from prior workflow steps\n\n${contextText}\n\n---\n\n## Your task\n\n${step.task}`;
  }

  // Resolve model
  const resolvedModel =
    step.model ??
    (() => {
      const dm = resolveDefaultModelForAgent({ cfg, agentId });
      return `${dm.provider}/${dm.model}`;
    })();

  // Patch session depth
  await callGateway({
    method: "sessions.patch",
    params: { key: childSessionKey, spawnDepth: childDepth },
    timeoutMs: 10_000,
  });

  // Patch model if specified
  if (resolvedModel) {
    try {
      await callGateway({
        method: "sessions.patch",
        params: { key: childSessionKey, model: resolvedModel },
        timeoutMs: 10_000,
      });
    } catch {
      // Non-fatal — proceed with default model
    }
  }

  // Build system prompt
  const childSystemPrompt = buildSubagentSystemPrompt({
    requesterSessionKey,
    requesterOrigin,
    childSessionKey,
    label: step.name,
    task: fullTask,
    childDepth,
    maxSpawnDepth: opts.maxSpawnDepth,
  });

  const idem = crypto.randomUUID();
  const startMs = Date.now();

  // Spawn the agent run (deliver: false — we'll read the reply ourselves)
  const response = await callGateway<{ runId: string }>({
    method: "agent",
    params: {
      message: fullTask,
      sessionKey: childSessionKey,
      channel: requesterOrigin?.channel,
      to: requesterOrigin?.to ?? undefined,
      accountId: requesterOrigin?.accountId ?? undefined,
      idempotencyKey: idem,
      deliver: false,
      lane: AGENT_LANE_SUBAGENT,
      extraSystemPrompt: childSystemPrompt,
      thinking: step.thinking,
      timeout: step.timeoutSeconds ?? 600,
      label: step.name,
      spawnedBy: requesterSessionKey,
    },
    // Long timeout — agent runs can take minutes
    timeoutMs: (step.timeoutSeconds ?? 600) * 1000 + 30_000,
  });

  const runId = response?.runId ?? idem;

  // Register in the subagent registry so it shows up in sessions_list etc.
  registerSubagentRun({
    runId,
    childSessionKey,
    requesterSessionKey,
    requesterOrigin,
    requesterDisplayKey: requesterSessionKey,
    task: fullTask,
    cleanup: "delete",
    label: step.name,
    model: resolvedModel,
    runTimeoutSeconds: step.timeoutSeconds ?? 600,
  });

  // Now we need to wait for the run to complete and read its reply.
  // Poll sessions.history for the assistant reply.
  const maxPollMs = (step.timeoutSeconds ?? 600) * 1000;
  const pollIntervalMs = 3_000;
  const deadline = Date.now() + maxPollMs;

  let result = "";
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));

    try {
      const history = await callGateway<{
        messages?: Array<{ role: string; content?: string; text?: string }>;
      }>({
        method: "sessions.history",
        params: { key: childSessionKey, limit: 5 },
        timeoutMs: 10_000,
      });

      const messages = history?.messages ?? [];
      // Find the last assistant message
      for (let i = messages.length - 1; i >= 0; i--) {
        const msg = messages[i];
        if (msg.role === "assistant") {
          result = msg.content ?? msg.text ?? "";
          break;
        }
      }

      if (result) break;
    } catch {
      // Transient error — keep polling
    }
  }

  if (!result) {
    throw new Error(`Step "${step.name}" timed out after ${maxPollMs / 1000}s with no result`);
  }

  const durationMs = Date.now() - startMs;
  return { result, durationMs };
}

/* ------------------------------------------------------------------ */
/*  Pattern executors                                                 */
/* ------------------------------------------------------------------ */

async function executeSequential(
  steps: WorkflowStep[],
  passContext: boolean,
  checkpoint: WorkflowCheckpoint,
  checkpointPath: string,
  execOpts: Omit<Parameters<typeof executeStep>[0], "step" | "contextText">,
): Promise<WorkflowCheckpoint> {
  let contextParts: string[] = [];

  // Restore context from already-completed steps
  for (const step of steps) {
    if (checkpoint.completed[step.name]) {
      contextParts.push(
        `### ${step.name}\n${checkpoint.completed[step.name].result}`,
      );
    }
  }

  for (const step of steps) {
    if (checkpoint.completed[step.name]) continue;

    const contextText = passContext ? contextParts.join("\n\n") : "";
    try {
      const { result, durationMs } = await executeStep({
        ...execOpts,
        step,
        contextText,
      });
      checkpoint.completed[step.name] = { result, durationMs };
      contextParts.push(`### ${step.name}\n${result}`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      checkpoint.failed[step.name] = { error: msg };
      checkpoint.status = "failed";
      await saveCheckpoint(checkpointPath, checkpoint);
      return checkpoint;
    }
    await saveCheckpoint(checkpointPath, checkpoint);
  }

  checkpoint.status = "done";
  await saveCheckpoint(checkpointPath, checkpoint);
  return checkpoint;
}

async function executeParallel(
  steps: WorkflowStep[],
  checkpoint: WorkflowCheckpoint,
  checkpointPath: string,
  execOpts: Omit<Parameters<typeof executeStep>[0], "step" | "contextText">,
): Promise<WorkflowCheckpoint> {
  const pending = steps.filter((s) => !checkpoint.completed[s.name]);

  const results = await Promise.allSettled(
    pending.map((step) =>
      executeStep({ ...execOpts, step, contextText: "" }).then((r) => ({
        name: step.name,
        ...r,
      })),
    ),
  );

  for (let i = 0; i < results.length; i++) {
    const r = results[i];
    const stepName = pending[i].name;
    if (r.status === "fulfilled") {
      checkpoint.completed[stepName] = {
        result: r.value.result,
        durationMs: r.value.durationMs,
      };
    } else {
      checkpoint.failed[stepName] = {
        error: r.reason instanceof Error ? r.reason.message : String(r.reason),
      };
    }
  }

  checkpoint.status = Object.keys(checkpoint.failed).length > 0 ? "failed" : "done";
  await saveCheckpoint(checkpointPath, checkpoint);
  return checkpoint;
}

async function executeDag(
  steps: WorkflowStep[],
  passContext: boolean,
  checkpoint: WorkflowCheckpoint,
  checkpointPath: string,
  execOpts: Omit<Parameters<typeof executeStep>[0], "step" | "contextText">,
): Promise<WorkflowCheckpoint> {
  const stepMap = new Map(steps.map((s) => [s.name, s]));

  // Topological execution — run steps whose deps are all completed
  const maxIterations = steps.length;
  for (let iter = 0; iter < maxIterations; iter++) {
    const ready = steps.filter((s) => {
      if (checkpoint.completed[s.name] || checkpoint.failed[s.name]) return false;
      const deps = s.dependsOn ?? [];
      return deps.every((d) => checkpoint.completed[d]);
    });

    if (ready.length === 0) {
      // Either all done, or stuck due to failed/missing deps
      break;
    }

    // Run all ready steps in parallel
    const results = await Promise.allSettled(
      ready.map((step) => {
        // Build context from dependencies
        const deps = step.dependsOn ?? [];
        const contextText = passContext
          ? deps
              .map((d) => `### ${d}\n${checkpoint.completed[d]?.result ?? ""}`)
              .join("\n\n")
          : "";
        return executeStep({ ...execOpts, step, contextText }).then((r) => ({
          name: step.name,
          ...r,
        }));
      }),
    );

    for (let i = 0; i < results.length; i++) {
      const r = results[i];
      const stepName = ready[i].name;
      if (r.status === "fulfilled") {
        checkpoint.completed[stepName] = {
          result: r.value.result,
          durationMs: r.value.durationMs,
        };
      } else {
        checkpoint.failed[stepName] = {
          error:
            r.reason instanceof Error ? r.reason.message : String(r.reason),
        };
      }
    }

    await saveCheckpoint(checkpointPath, checkpoint);
  }

  const allProcessed =
    Object.keys(checkpoint.completed).length +
      Object.keys(checkpoint.failed).length ===
    steps.length;
  checkpoint.status = allProcessed
    ? Object.keys(checkpoint.failed).length > 0
      ? "failed"
      : "done"
    : "failed"; // stuck = failed
  await saveCheckpoint(checkpointPath, checkpoint);
  return checkpoint;
}

/* ------------------------------------------------------------------ */
/*  Tool factory                                                      */
/* ------------------------------------------------------------------ */

export function createWorkflowTool(opts?: {
  agentSessionKey?: string;
  agentChannel?: GatewayMessageChannel;
  agentAccountId?: string;
  agentTo?: string;
  agentThreadId?: string | number;
  sandboxed?: boolean;
  requesterAgentIdOverride?: string;
}): AnyAgentTool {
  return {
    label: "Workflow",
    name: "workflow_run",
    description: `Run a multi-agent workflow with structured orchestration patterns.

Patterns:
- **sequential**: Steps run one after another. Each step can receive context from all prior steps (passContext: true).
- **parallel**: All steps run concurrently. Results are collected and returned together.
- **dag**: Steps run based on dependency graph (dependsOn). Steps with met dependencies run in parallel.

Each step spawns a sub-agent session. Results are checkpointed to disk for crash recovery.
Use resume: true to continue a previously failed workflow.`,
    parameters: WorkflowToolSchema,
    execute: async (_toolCallId, args) => {
      const params = args as Record<string, unknown>;
      const pattern = readStringParam(params, "pattern", { required: true }) as
        | "sequential"
        | "parallel"
        | "dag";
      const steps = (params.steps ?? []) as WorkflowStep[];
      const passContext = params.passContext === true;
      const merge = readStringParam(params, "merge") ?? "concatenate";
      const label = readStringParam(params, "label") ?? `workflow-${Date.now()}`;
      const resume = params.resume === true;

      if (!steps.length) {
        return jsonResult({ status: "error", error: "No steps provided" });
      }

      // Validate step names are unique
      const names = new Set<string>();
      for (const s of steps) {
        if (names.has(s.name)) {
          return jsonResult({
            status: "error",
            error: `Duplicate step name: "${s.name}"`,
          });
        }
        names.add(s.name);
      }

      // Validate DAG dependencies
      if (pattern === "dag") {
        for (const s of steps) {
          for (const dep of s.dependsOn ?? []) {
            if (!names.has(dep)) {
              return jsonResult({
                status: "error",
                error: `Step "${s.name}" depends on unknown step "${dep}"`,
              });
            }
          }
        }
      }

      // Depth + children checks
      const cfg = loadConfig();
      const { mainKey, alias } = resolveMainSessionAlias(cfg);
      const requesterSessionKey = opts?.agentSessionKey;
      const requesterInternalKey = requesterSessionKey
        ? resolveInternalSessionKey({
            key: requesterSessionKey,
            alias,
            mainKey,
          })
        : alias;

      const callerDepth = getSubagentDepthFromSessionStore(requesterInternalKey, { cfg });
      const maxSpawnDepth = cfg.agents?.defaults?.subagents?.maxSpawnDepth ?? 1;
      if (callerDepth >= maxSpawnDepth) {
        return jsonResult({
          status: "forbidden",
          error: `Workflow blocked: current depth ${callerDepth} >= maxSpawnDepth ${maxSpawnDepth}`,
        });
      }

      const maxChildren = cfg.agents?.defaults?.subagents?.maxChildrenPerAgent ?? 5;
      const activeChildren = countActiveRunsForSession(requesterInternalKey);
      if (activeChildren + steps.length > maxChildren + activeChildren) {
        // Allow it if total won't exceed — steps run and complete, freeing slots.
        // For parallel, all run at once. Check feasibility.
        if (pattern === "parallel" && steps.length > maxChildren) {
          return jsonResult({
            status: "forbidden",
            error: `Parallel workflow has ${steps.length} steps but maxChildrenPerAgent is ${maxChildren}`,
          });
        }
      }

      const requesterAgentId = normalizeAgentId(
        opts?.requesterAgentIdOverride ??
          parseAgentSessionKey(requesterInternalKey)?.agentId,
      );

      const requesterOrigin = normalizeDeliveryContext({
        channel: opts?.agentChannel,
        accountId: opts?.agentAccountId,
        to: opts?.agentTo,
        threadId: opts?.agentThreadId,
      });

      // Checkpoint path
      const workspaceDir = resolveWorkspaceRoot();
      const workflowId = label.replace(/[^a-zA-Z0-9_-]/g, "_");
      const checkpointPath = path.join(
        workspaceDir,
        "checkpoints",
        `workflow-${workflowId}.json`,
      );

      // Load or create checkpoint
      let checkpoint: WorkflowCheckpoint;
      const existing = resume ? await loadCheckpoint(checkpointPath) : null;
      if (existing && existing.steps.join(",") === steps.map((s) => s.name).join(",")) {
        checkpoint = existing;
        checkpoint.status = "in_progress";
      } else {
        checkpoint = {
          workflowId,
          pattern,
          steps: steps.map((s) => s.name),
          completed: {},
          failed: {},
          status: "in_progress",
          startedAt: Date.now(),
          updatedAt: Date.now(),
        };
      }

      await saveCheckpoint(checkpointPath, checkpoint);

      const execOpts = {
        requesterSessionKey: requesterInternalKey,
        requesterOrigin,
        callerDepth,
        maxSpawnDepth,
        agentId: requesterAgentId,
        cfg,
      };

      try {
        switch (pattern) {
          case "sequential":
            checkpoint = await executeSequential(
              steps,
              passContext,
              checkpoint,
              checkpointPath,
              execOpts,
            );
            break;
          case "parallel":
            checkpoint = await executeParallel(
              steps,
              checkpoint,
              checkpointPath,
              execOpts,
            );
            break;
          case "dag":
            checkpoint = await executeDag(
              steps,
              passContext,
              checkpoint,
              checkpointPath,
              execOpts,
            );
            break;
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        checkpoint.status = "failed";
        checkpoint.failed["_workflow"] = { error: msg };
        await saveCheckpoint(checkpointPath, checkpoint);
        return jsonResult({
          status: "error",
          error: msg,
          checkpoint: checkpointPath,
          completed: Object.keys(checkpoint.completed),
          failed: checkpoint.failed,
        });
      }

      // Build result summary
      const totalDuration = Object.values(checkpoint.completed).reduce(
        (sum, c) => sum + c.durationMs,
        0,
      );

      const stepResults =
        merge === "merge"
          ? Object.fromEntries(
              Object.entries(checkpoint.completed).map(([k, v]) => [k, v.result]),
            )
          : Object.entries(checkpoint.completed)
              .map(([k, v]) => `## ${k}\n\n${v.result}`)
              .join("\n\n---\n\n");

      // Cleanup checkpoint on success
      if (checkpoint.status === "done") {
        try {
          await fs.unlink(checkpointPath);
        } catch {
          // ignore
        }
      }

      return jsonResult({
        status: checkpoint.status,
        pattern,
        stepsCompleted: Object.keys(checkpoint.completed).length,
        stepsFailed: Object.keys(checkpoint.failed).length,
        totalSteps: steps.length,
        totalDurationMs: totalDuration,
        results: stepResults,
        ...(Object.keys(checkpoint.failed).length > 0
          ? { failures: checkpoint.failed }
          : {}),
        ...(checkpoint.status !== "done"
          ? { checkpoint: checkpointPath }
          : {}),
      });
    },
  };
}
