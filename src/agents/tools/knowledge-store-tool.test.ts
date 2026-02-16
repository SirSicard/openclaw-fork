import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs/promises";

const MOCK_WORKSPACE = "/tmp/test-workspace-knowledge";

vi.mock("../workspace-dir.js", () => ({
  resolveWorkspaceRoot: () => MOCK_WORKSPACE,
}));

import { createKnowledgeStoreTool } from "./knowledge-store-tool.js";

describe("knowledge_store tool", () => {
  const tool = createKnowledgeStoreTool();

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

  it("returns empty categories initially", async () => {
    const result = await tool.execute("call-1", { action: "categories" });
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.status).toBe("ok");
    expect(parsed.categories).toEqual([]);
  });

  it("set and get a value", async () => {
    await tool.execute("call-1", {
      action: "set",
      category: "contacts",
      key: "sean",
      data: { name: "Sean Durkan", company: "Swinkels" },
    });

    const result = await tool.execute("call-2", {
      action: "get",
      category: "contacts",
      key: "sean",
    });
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.status).toBe("ok");
    expect(parsed.data.name).toBe("Sean Durkan");
    expect(parsed.data.company).toBe("Swinkels");
  });

  it("returns not_found for missing keys", async () => {
    const result = await tool.execute("call-1", {
      action: "get",
      category: "contacts",
      key: "nonexistent",
    });
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.status).toBe("not_found");
  });

  it("updates existing values and preserves createdAt", async () => {
    await tool.execute("call-1", {
      action: "set",
      category: "contacts",
      key: "sean",
      data: { name: "Sean" },
    });

    const first = JSON.parse(
      (await tool.execute("call-2", { action: "get", category: "contacts", key: "sean" }))
        .content[0].text,
    );

    await new Promise((r) => setTimeout(r, 10));

    await tool.execute("call-3", {
      action: "set",
      category: "contacts",
      key: "sean",
      data: { name: "Sean Durkan", updated: true },
    });

    const second = JSON.parse(
      (await tool.execute("call-4", { action: "get", category: "contacts", key: "sean" }))
        .content[0].text,
    );

    expect(second.data.updated).toBe(true);
    expect(second.createdAt).toBe(first.createdAt);
    expect(second.updatedAt).not.toBe(first.updatedAt);
  });

  it("deletes a value", async () => {
    await tool.execute("call-1", {
      action: "set",
      category: "contacts",
      key: "temp",
      data: { name: "Temp" },
    });

    const deleteResult = await tool.execute("call-2", {
      action: "delete",
      category: "contacts",
      key: "temp",
    });
    expect(JSON.parse(deleteResult.content[0].text).status).toBe("deleted");

    const getResult = await tool.execute("call-3", {
      action: "get",
      category: "contacts",
      key: "temp",
    });
    expect(JSON.parse(getResult.content[0].text).status).toBe("not_found");
  });

  it("lists keys in a category", async () => {
    await tool.execute("c1", { action: "set", category: "projects", key: "a", data: {} });
    await tool.execute("c2", { action: "set", category: "projects", key: "b", data: {} });
    await tool.execute("c3", { action: "set", category: "projects", key: "c", data: {} });

    const result = await tool.execute("c4", { action: "list", category: "projects" });
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.count).toBe(3);
    expect(parsed.keys.map((k: { key: string }) => k.key)).toEqual(["a", "b", "c"]);
  });

  it("queries by filter", async () => {
    await tool.execute("c1", {
      action: "set", category: "contacts", key: "sean",
      data: { name: "Sean", company: "Swinkels" },
    });
    await tool.execute("c2", {
      action: "set", category: "contacts", key: "marcus",
      data: { name: "Marcus", company: "AITappers" },
    });
    await tool.execute("c3", {
      action: "set", category: "contacts", key: "dawson",
      data: { name: "Dawson", company: "AIA" },
    });

    const result = await tool.execute("c4", {
      action: "query",
      category: "contacts",
      filter: { company: "Swinkels" },
    });
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.count).toBe(1);
    expect(parsed.results[0].key).toBe("sean");
  });

  it("query does partial string matching", async () => {
    await tool.execute("c1", {
      action: "set", category: "contacts", key: "sean",
      data: { name: "Sean Durkan", role: "Client" },
    });

    const result = await tool.execute("c2", {
      action: "query",
      category: "contacts",
      filter: { name: "durkan" },
    });
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.count).toBe(1);
  });

  it("categories lists all with counts", async () => {
    await tool.execute("c1", { action: "set", category: "contacts", key: "a", data: {} });
    await tool.execute("c2", { action: "set", category: "contacts", key: "b", data: {} });
    await tool.execute("c3", { action: "set", category: "projects", key: "x", data: {} });

    const result = await tool.execute("c4", { action: "categories" });
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.categories).toEqual(
      expect.arrayContaining([
        { name: "contacts", count: 2 },
        { name: "projects", count: 1 },
      ]),
    );
  });
});
