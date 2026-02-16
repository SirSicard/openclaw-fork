/**
 * knowledge_store — Structured key-value knowledge base.
 *
 * SQLite-backed JSON store for structured data that's more reliable
 * than memory search for things like contacts, project metadata, facts.
 *
 * Usage:
 *   knowledge_store({ action: "set", category: "contacts", key: "sean", data: {...} })
 *   knowledge_store({ action: "get", category: "contacts", key: "sean" })
 *   knowledge_store({ action: "query", category: "contacts", filter: { company: "Swinkels" } })
 *   knowledge_store({ action: "delete", category: "contacts", key: "sean" })
 *   knowledge_store({ action: "list", category: "contacts" })
 *   knowledge_store({ action: "categories" })
 */

import { Type } from "@sinclair/typebox";
import fs from "node:fs/promises";
import path from "node:path";
import type { AnyAgentTool } from "./common.js";
import { jsonResult, readStringParam, readNumberParam } from "./common.js";
import { resolveWorkspaceRoot } from "../workspace-dir.js";

/* ------------------------------------------------------------------ */
/*  Simple JSON file store (no SQLite dependency needed)              */
/* ------------------------------------------------------------------ */

interface StoreData {
  [category: string]: {
    [key: string]: {
      data: unknown;
      createdAt: number;
      updatedAt: number;
      tags?: string[];
    };
  };
}

function storePath(): string {
  return path.join(resolveWorkspaceRoot(), ".knowledge-store.json");
}

async function loadStore(): Promise<StoreData> {
  try {
    const raw = await fs.readFile(storePath(), "utf-8");
    return JSON.parse(raw) as StoreData;
  } catch {
    return {};
  }
}

async function saveStore(store: StoreData): Promise<void> {
  await fs.writeFile(storePath(), JSON.stringify(store, null, 2));
}

/* ------------------------------------------------------------------ */
/*  Schema                                                            */
/* ------------------------------------------------------------------ */

const KnowledgeStoreSchema = Type.Object({
  action: Type.Union([
    Type.Literal("set"),
    Type.Literal("get"),
    Type.Literal("delete"),
    Type.Literal("list"),
    Type.Literal("query"),
    Type.Literal("categories"),
  ]),
  category: Type.Optional(Type.String()),
  key: Type.Optional(Type.String()),
  data: Type.Optional(Type.Unknown()),
  tags: Type.Optional(Type.Array(Type.String())),
  /** For query: simple key-value filter on the data object */
  filter: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
  /** Max results for list/query (default: 50) */
  limit: Type.Optional(Type.Number({ minimum: 1 })),
});

/* ------------------------------------------------------------------ */
/*  Tool factory                                                      */
/* ------------------------------------------------------------------ */

export function createKnowledgeStoreTool(): AnyAgentTool {
  return {
    label: "Knowledge Store",
    name: "knowledge_store",
    description: `Structured key-value knowledge base for reliable storage of contacts, projects, facts, and other structured data.

Actions:
- **set**: Store/update a value (requires category, key, data).
- **get**: Retrieve a value (requires category, key).
- **delete**: Remove a value (requires category, key).
- **list**: List all keys in a category (optional limit).
- **query**: Search within a category by matching data fields (requires category, filter).
- **categories**: List all categories.

More reliable than memory search for structured/factual data.`,
    parameters: KnowledgeStoreSchema,
    execute: async (_toolCallId, args) => {
      const params = args as Record<string, unknown>;
      const action = readStringParam(params, "action", { required: true });

      switch (action) {
        case "set": {
          const category = readStringParam(params, "category", { required: true });
          const key = readStringParam(params, "key", { required: true });
          const data = params.data;
          const tags = Array.isArray(params.tags)
            ? (params.tags as string[]).filter((t) => typeof t === "string")
            : undefined;

          if (data === undefined) {
            return jsonResult({ status: "error", error: "data is required for set" });
          }

          const store = await loadStore();
          if (!store[category]) store[category] = {};

          const existing = store[category][key];
          store[category][key] = {
            data,
            createdAt: existing?.createdAt ?? Date.now(),
            updatedAt: Date.now(),
            ...(tags?.length ? { tags } : {}),
          };

          await saveStore(store);
          return jsonResult({
            status: existing ? "updated" : "created",
            category,
            key,
          });
        }

        case "get": {
          const category = readStringParam(params, "category", { required: true });
          const key = readStringParam(params, "key", { required: true });

          const store = await loadStore();
          const entry = store[category]?.[key];

          if (!entry) {
            return jsonResult({ status: "not_found", category, key });
          }

          return jsonResult({
            status: "ok",
            category,
            key,
            data: entry.data,
            createdAt: new Date(entry.createdAt).toISOString(),
            updatedAt: new Date(entry.updatedAt).toISOString(),
            ...(entry.tags?.length ? { tags: entry.tags } : {}),
          });
        }

        case "delete": {
          const category = readStringParam(params, "category", { required: true });
          const key = readStringParam(params, "key", { required: true });

          const store = await loadStore();
          if (!store[category]?.[key]) {
            return jsonResult({ status: "not_found", category, key });
          }

          delete store[category][key];
          if (Object.keys(store[category]).length === 0) {
            delete store[category];
          }
          await saveStore(store);
          return jsonResult({ status: "deleted", category, key });
        }

        case "list": {
          const category = readStringParam(params, "category", { required: true });
          const limit = readNumberParam(params, "limit", { integer: true }) ?? 50;

          const store = await loadStore();
          const entries = store[category] ?? {};
          const keys = Object.keys(entries).slice(0, limit);

          return jsonResult({
            status: "ok",
            category,
            count: Object.keys(entries).length,
            keys: keys.map((k) => ({
              key: k,
              updatedAt: new Date(entries[k].updatedAt).toISOString(),
              ...(entries[k].tags?.length ? { tags: entries[k].tags } : {}),
            })),
          });
        }

        case "query": {
          const category = readStringParam(params, "category", { required: true });
          const filter = params.filter as Record<string, unknown> | undefined;
          const limit = readNumberParam(params, "limit", { integer: true }) ?? 50;

          if (!filter || Object.keys(filter).length === 0) {
            return jsonResult({ status: "error", error: "filter is required for query" });
          }

          const store = await loadStore();
          const entries = store[category] ?? {};
          const results: Array<{ key: string; data: unknown }> = [];

          for (const [key, entry] of Object.entries(entries)) {
            const data = entry.data as Record<string, unknown> | undefined;
            if (!data || typeof data !== "object") continue;

            const matches = Object.entries(filter).every(([fk, fv]) => {
              const val = data[fk];
              if (typeof fv === "string") {
                return (
                  String(val).toLowerCase().includes(fv.toLowerCase())
                );
              }
              return val === fv;
            });

            if (matches) {
              results.push({ key, data: entry.data });
              if (results.length >= limit) break;
            }
          }

          return jsonResult({
            status: "ok",
            category,
            count: results.length,
            results,
          });
        }

        case "categories": {
          const store = await loadStore();
          const categories = Object.entries(store).map(([name, entries]) => ({
            name,
            count: Object.keys(entries).length,
          }));
          return jsonResult({ status: "ok", categories });
        }

        default:
          return jsonResult({ status: "error", error: `Unknown action: ${action}` });
      }
    },
  };
}
