/**
 * task_queue — Persistent task queue for batch operations.
 *
 * JSON file-backed queue that survives restarts. Tasks can be added,
 * claimed, completed, failed, and retried. Integrates with cron or
 * heartbeat for processing.
 *
 * Storage: <workspace>/.task-queue.json
 */

import { Type } from "@sinclair/typebox";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import type { AnyAgentTool } from "./common.js";
import { jsonResult, readStringParam, readNumberParam } from "./common.js";
import { resolveWorkspaceRoot } from "../workspace-dir.js";

/* ------------------------------------------------------------------ */
/*  Types                                                             */
/* ------------------------------------------------------------------ */

type TaskStatus = "pending" | "claimed" | "done" | "failed";

interface TaskRecord {
  id: string;
  task: string;
  data?: unknown;
  priority: "low" | "normal" | "high";
  status: TaskStatus;
  retries: number;
  maxRetries: number;
  createdAt: number;
  updatedAt: number;
  claimedAt?: number;
  completedAt?: number;
  result?: unknown;
  error?: string;
  tags?: string[];
}

interface QueueData {
  tasks: TaskRecord[];
}

/* ------------------------------------------------------------------ */
/*  Storage                                                           */
/* ------------------------------------------------------------------ */

function queuePath(): string {
  return path.join(resolveWorkspaceRoot(), ".task-queue.json");
}

async function loadQueue(): Promise<QueueData> {
  try {
    const raw = await fs.readFile(queuePath(), "utf-8");
    return JSON.parse(raw) as QueueData;
  } catch {
    return { tasks: [] };
  }
}

async function saveQueue(queue: QueueData): Promise<void> {
  await fs.writeFile(queuePath(), JSON.stringify(queue, null, 2));
}

/* ------------------------------------------------------------------ */
/*  Schema                                                            */
/* ------------------------------------------------------------------ */

const TaskQueueSchema = Type.Object({
  action: Type.Union([
    Type.Literal("add"),
    Type.Literal("claim"),
    Type.Literal("complete"),
    Type.Literal("fail"),
    Type.Literal("list"),
    Type.Literal("retry"),
    Type.Literal("clear"),
    Type.Literal("stats"),
  ]),
  /** Task description (for add) */
  task: Type.Optional(Type.String()),
  /** Arbitrary task data (for add) */
  data: Type.Optional(Type.Unknown()),
  /** Task ID (for complete/fail/retry) */
  id: Type.Optional(Type.String()),
  /** Priority (for add, default: normal) */
  priority: Type.Optional(
    Type.Union([Type.Literal("low"), Type.Literal("normal"), Type.Literal("high")]),
  ),
  /** Max retries (for add, default: 3) */
  maxRetries: Type.Optional(Type.Number({ minimum: 0 })),
  /** Tags for filtering */
  tags: Type.Optional(Type.Array(Type.String())),
  /** Result data (for complete) */
  result: Type.Optional(Type.Unknown()),
  /** Error message (for fail) */
  error: Type.Optional(Type.String()),
  /** Status filter (for list) */
  status: Type.Optional(Type.String()),
  /** Max results (for list, default: 50) */
  limit: Type.Optional(Type.Number({ minimum: 1 })),
  /** Clear completed/failed older than N hours */
  olderThanHours: Type.Optional(Type.Number({ minimum: 0 })),
});

/* ------------------------------------------------------------------ */
/*  Tool factory                                                      */
/* ------------------------------------------------------------------ */

export function createTaskQueueTool(): AnyAgentTool {
  return {
    label: "Task Queue",
    name: "task_queue",
    description: `Persistent task queue for batch processing that survives restarts.

Actions:
- **add**: Add a task (requires task description, optional data/priority/tags/maxRetries).
- **claim**: Claim the next pending task (highest priority first). Returns the task to work on.
- **complete**: Mark a claimed task as done (requires id, optional result).
- **fail**: Mark a claimed task as failed (requires id, optional error). Auto-retries if under maxRetries.
- **retry**: Reset a failed task back to pending (requires id).
- **list**: List tasks (optional status filter and limit).
- **clear**: Remove completed/failed tasks (optional olderThanHours).
- **stats**: Get queue statistics.`,
    parameters: TaskQueueSchema,
    execute: async (_toolCallId, args) => {
      const params = args as Record<string, unknown>;
      const action = readStringParam(params, "action", { required: true });

      switch (action) {
        case "add": {
          const task = readStringParam(params, "task", { required: true });
          const priority = (readStringParam(params, "priority") ?? "normal") as
            | "low"
            | "normal"
            | "high";
          const maxRetries =
            readNumberParam(params, "maxRetries", { integer: true }) ?? 3;
          const tags = Array.isArray(params.tags)
            ? (params.tags as string[]).filter((t) => typeof t === "string")
            : undefined;

          const record: TaskRecord = {
            id: crypto.randomUUID().slice(0, 8),
            task,
            data: params.data,
            priority,
            status: "pending",
            retries: 0,
            maxRetries,
            createdAt: Date.now(),
            updatedAt: Date.now(),
            ...(tags?.length ? { tags } : {}),
          };

          const queue = await loadQueue();
          queue.tasks.push(record);
          await saveQueue(queue);

          return jsonResult({ status: "added", id: record.id, task: record.task });
        }

        case "claim": {
          const queue = await loadQueue();
          const priorityOrder = { high: 0, normal: 1, low: 2 };

          const pending = queue.tasks
            .filter((t) => t.status === "pending")
            .sort(
              (a, b) =>
                priorityOrder[a.priority] - priorityOrder[b.priority] ||
                a.createdAt - b.createdAt,
            );

          if (pending.length === 0) {
            return jsonResult({ status: "empty", message: "No pending tasks" });
          }

          const task = pending[0];
          task.status = "claimed";
          task.claimedAt = Date.now();
          task.updatedAt = Date.now();
          await saveQueue(queue);

          return jsonResult({
            status: "claimed",
            id: task.id,
            task: task.task,
            data: task.data,
            priority: task.priority,
            retries: task.retries,
            ...(task.tags?.length ? { tags: task.tags } : {}),
          });
        }

        case "complete": {
          const id = readStringParam(params, "id", { required: true });
          const queue = await loadQueue();
          const task = queue.tasks.find((t) => t.id === id);

          if (!task) return jsonResult({ status: "not_found", id });

          task.status = "done";
          task.completedAt = Date.now();
          task.updatedAt = Date.now();
          task.result = params.result;
          await saveQueue(queue);

          return jsonResult({ status: "completed", id });
        }

        case "fail": {
          const id = readStringParam(params, "id", { required: true });
          const error = readStringParam(params, "error") ?? "Unknown error";
          const queue = await loadQueue();
          const task = queue.tasks.find((t) => t.id === id);

          if (!task) return jsonResult({ status: "not_found", id });

          task.retries += 1;
          task.error = error;
          task.updatedAt = Date.now();

          if (task.retries < task.maxRetries) {
            // Auto-retry: set back to pending
            task.status = "pending";
            task.claimedAt = undefined;
            await saveQueue(queue);
            return jsonResult({
              status: "retrying",
              id,
              retries: task.retries,
              maxRetries: task.maxRetries,
            });
          }

          task.status = "failed";
          await saveQueue(queue);
          return jsonResult({
            status: "failed",
            id,
            retries: task.retries,
            error,
          });
        }

        case "retry": {
          const id = readStringParam(params, "id", { required: true });
          const queue = await loadQueue();
          const task = queue.tasks.find((t) => t.id === id);

          if (!task) return jsonResult({ status: "not_found", id });

          task.status = "pending";
          task.claimedAt = undefined;
          task.error = undefined;
          task.updatedAt = Date.now();
          await saveQueue(queue);

          return jsonResult({ status: "reset_to_pending", id });
        }

        case "list": {
          const statusFilter = readStringParam(params, "status");
          const limit = readNumberParam(params, "limit", { integer: true }) ?? 50;

          const queue = await loadQueue();
          let tasks = queue.tasks;

          if (statusFilter) {
            tasks = tasks.filter((t) => t.status === statusFilter);
          }

          tasks = tasks.slice(-limit);

          return jsonResult({
            status: "ok",
            count: tasks.length,
            tasks: tasks.map((t) => ({
              id: t.id,
              task: t.task,
              status: t.status,
              priority: t.priority,
              retries: t.retries,
              createdAt: new Date(t.createdAt).toISOString(),
              ...(t.error ? { error: t.error } : {}),
              ...(t.tags?.length ? { tags: t.tags } : {}),
            })),
          });
        }

        case "clear": {
          const olderThanHours =
            readNumberParam(params, "olderThanHours") ?? 24;
          const cutoff = Date.now() - olderThanHours * 60 * 60 * 1000;

          const queue = await loadQueue();
          const before = queue.tasks.length;
          queue.tasks = queue.tasks.filter(
            (t) =>
              t.status === "pending" ||
              t.status === "claimed" ||
              t.updatedAt > cutoff,
          );
          const removed = before - queue.tasks.length;
          await saveQueue(queue);

          return jsonResult({ status: "cleared", removed, remaining: queue.tasks.length });
        }

        case "stats": {
          const queue = await loadQueue();
          const counts = { pending: 0, claimed: 0, done: 0, failed: 0 };
          for (const t of queue.tasks) {
            counts[t.status] = (counts[t.status] ?? 0) + 1;
          }

          return jsonResult({
            status: "ok",
            total: queue.tasks.length,
            ...counts,
          });
        }

        default:
          return jsonResult({ status: "error", error: `Unknown action: ${action}` });
      }
    },
  };
}
