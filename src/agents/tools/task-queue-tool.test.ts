import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs/promises";

const MOCK_WORKSPACE = "/tmp/test-workspace-queue";

vi.mock("../workspace-dir.js", () => ({
  resolveWorkspaceRoot: () => MOCK_WORKSPACE,
}));

import { createTaskQueueTool } from "./task-queue-tool.js";

describe("task_queue tool", () => {
  const tool = createTaskQueueTool();

  beforeEach(async () => {
    await fs.mkdir(MOCK_WORKSPACE, { recursive: true });
  });

  afterEach(async () => {
    try {
      await fs.rm(MOCK_WORKSPACE, { recursive: true, force: true });
    } catch {
      // ignore
    }
  });

  function parse(result: { content: Array<{ text: string }> }) {
    return JSON.parse(result.content[0].text);
  }

  it("stats on empty queue", async () => {
    const result = parse(await tool.execute("c1", { action: "stats" }));
    expect(result.total).toBe(0);
    expect(result.pending).toBe(0);
  });

  it("add and claim a task", async () => {
    const addResult = parse(
      await tool.execute("c1", { action: "add", task: "Process batch" }),
    );
    expect(addResult.status).toBe("added");
    expect(addResult.id).toBeTruthy();

    const claimResult = parse(await tool.execute("c2", { action: "claim" }));
    expect(claimResult.status).toBe("claimed");
    expect(claimResult.task).toBe("Process batch");
  });

  it("claim returns empty when no pending", async () => {
    const result = parse(await tool.execute("c1", { action: "claim" }));
    expect(result.status).toBe("empty");
  });

  it("complete a task", async () => {
    parse(await tool.execute("c1", { action: "add", task: "Do thing" }));
    const claimed = parse(await tool.execute("c2", { action: "claim" }));

    const completed = parse(
      await tool.execute("c3", {
        action: "complete",
        id: claimed.id,
        result: { output: "done!" },
      }),
    );
    expect(completed.status).toBe("completed");

    const stats = parse(await tool.execute("c4", { action: "stats" }));
    expect(stats.done).toBe(1);
    expect(stats.pending).toBe(0);
  });

  it("fail with auto-retry", async () => {
    parse(
      await tool.execute("c1", {
        action: "add",
        task: "Flaky task",
        maxRetries: 3,
      }),
    );
    const claimed = parse(await tool.execute("c2", { action: "claim" }));

    // First failure → auto retry
    const fail1 = parse(
      await tool.execute("c3", {
        action: "fail",
        id: claimed.id,
        error: "timeout",
      }),
    );
    expect(fail1.status).toBe("retrying");
    expect(fail1.retries).toBe(1);

    // Task should be pending again
    const stats = parse(await tool.execute("c4", { action: "stats" }));
    expect(stats.pending).toBe(1);
  });

  it("fail permanently after maxRetries", async () => {
    parse(
      await tool.execute("c1", {
        action: "add",
        task: "Always fails",
        maxRetries: 2,
      }),
    );

    // Claim and fail once → auto-retry (retries 1 < maxRetries 2)
    let claimed = parse(await tool.execute("c2", { action: "claim" }));
    const fail1 = parse(
      await tool.execute("c3", { action: "fail", id: claimed.id, error: "err" }),
    );
    expect(fail1.status).toBe("retrying");

    // Claim again and fail → auto-retry (retries 2 < maxRetries 2 is false → permanent)
    claimed = parse(await tool.execute("c4", { action: "claim" }));
    const fail = parse(
      await tool.execute("c5", { action: "fail", id: claimed.id, error: "err2" }),
    );
    expect(fail.status).toBe("failed");

    const stats = parse(await tool.execute("c6", { action: "stats" }));
    expect(stats.failed).toBe(1);
    expect(stats.pending).toBe(0);
  });

  it("priority ordering: high before normal before low", async () => {
    parse(await tool.execute("c1", { action: "add", task: "low", priority: "low" }));
    parse(await tool.execute("c2", { action: "add", task: "high", priority: "high" }));
    parse(await tool.execute("c3", { action: "add", task: "normal", priority: "normal" }));

    const first = parse(await tool.execute("c4", { action: "claim" }));
    expect(first.task).toBe("high");

    const second = parse(await tool.execute("c5", { action: "claim" }));
    expect(second.task).toBe("normal");

    const third = parse(await tool.execute("c6", { action: "claim" }));
    expect(third.task).toBe("low");
  });

  it("list with status filter", async () => {
    parse(await tool.execute("c1", { action: "add", task: "a" }));
    parse(await tool.execute("c2", { action: "add", task: "b" }));
    const claimed = parse(await tool.execute("c3", { action: "claim" }));
    parse(await tool.execute("c4", { action: "complete", id: claimed.id }));

    const pending = parse(
      await tool.execute("c5", { action: "list", status: "pending" }),
    );
    expect(pending.count).toBe(1);

    const done = parse(
      await tool.execute("c6", { action: "list", status: "done" }),
    );
    expect(done.count).toBe(1);
  });

  it("clear removes old completed tasks", async () => {
    parse(await tool.execute("c1", { action: "add", task: "t" }));
    const claimed = parse(await tool.execute("c2", { action: "claim" }));
    parse(await tool.execute("c3", { action: "complete", id: claimed.id }));

    // Clear with 0 hours = clear everything completed
    const cleared = parse(
      await tool.execute("c4", { action: "clear", olderThanHours: 0 }),
    );
    expect(cleared.removed).toBe(1);
  });

  it("retry resets a failed task to pending", async () => {
    parse(await tool.execute("c1", { action: "add", task: "retry me", maxRetries: 0 }));
    const claimed = parse(await tool.execute("c2", { action: "claim" }));
    parse(await tool.execute("c3", { action: "fail", id: claimed.id, error: "oops" }));

    // Manual retry
    const retried = parse(await tool.execute("c4", { action: "retry", id: claimed.id }));
    expect(retried.status).toBe("reset_to_pending");

    const stats = parse(await tool.execute("c5", { action: "stats" }));
    expect(stats.pending).toBe(1);
    expect(stats.failed).toBe(0);
  });
});
