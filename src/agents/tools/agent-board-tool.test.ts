import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";

const MOCK_WORKSPACE = "/tmp/test-workspace-board";

vi.mock("../workspace-dir.js", () => ({
  resolveWorkspaceRoot: () => MOCK_WORKSPACE,
}));

import { createAgentBoardTool } from "./agent-board-tool.js";

describe("agent_board tool", () => {
  const tool = createAgentBoardTool();
  const boardDir = path.join(MOCK_WORKSPACE, ".agent-boards");

  beforeEach(async () => {
    await fs.mkdir(boardDir, { recursive: true });
  });

  afterEach(async () => {
    try {
      await fs.rm(MOCK_WORKSPACE, { recursive: true, force: true });
    } catch {
      // ignore
    }
  });

  it("lists empty boards", async () => {
    const result = await tool.execute("call-1", { action: "list" });
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.status).toBe("ok");
    expect(parsed.boards).toEqual([]);
  });

  it("posts and reads messages", async () => {
    await tool.execute("call-1", {
      action: "post",
      board: "test-board",
      from: "agent-a",
      message: "Hello from A",
    });

    await tool.execute("call-2", {
      action: "post",
      board: "test-board",
      from: "agent-b",
      message: "Hello from B",
    });

    const result = await tool.execute("call-3", {
      action: "read",
      board: "test-board",
    });
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.status).toBe("ok");
    expect(parsed.count).toBe(2);
    expect(parsed.messages[0].from).toBe("agent-a");
    expect(parsed.messages[1].from).toBe("agent-b");
  });

  it("filters by since timestamp", async () => {
    await tool.execute("call-1", {
      action: "post",
      board: "timed",
      from: "a",
      message: "old",
    });

    const midpoint = new Date().toISOString();
    // Small delay to ensure timestamp difference
    await new Promise((r) => setTimeout(r, 10));

    await tool.execute("call-2", {
      action: "post",
      board: "timed",
      from: "b",
      message: "new",
    });

    const result = await tool.execute("call-3", {
      action: "read",
      board: "timed",
      since: midpoint,
    });
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.count).toBe(1);
    expect(parsed.messages[0].from).toBe("b");
  });

  it("clears a board", async () => {
    await tool.execute("call-1", {
      action: "post",
      board: "to-clear",
      from: "a",
      message: "test",
    });

    const clearResult = await tool.execute("call-2", {
      action: "clear",
      board: "to-clear",
    });
    expect(JSON.parse(clearResult.content[0].text).status).toBe("cleared");

    const readResult = await tool.execute("call-3", {
      action: "read",
      board: "to-clear",
    });
    expect(JSON.parse(readResult.content[0].text).count).toBe(0);
  });

  it("lists boards after posting", async () => {
    await tool.execute("call-1", {
      action: "post",
      board: "board-alpha",
      from: "a",
      message: "test",
    });
    await tool.execute("call-2", {
      action: "post",
      board: "board-beta",
      from: "b",
      message: "test",
    });

    const result = await tool.execute("call-3", { action: "list" });
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.boards).toContain("board-alpha");
    expect(parsed.boards).toContain("board-beta");
  });
});
