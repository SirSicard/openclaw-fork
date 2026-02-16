/**
 * agent_board — Inter-agent communication via a file-based message board.
 *
 * Agents can post messages to named boards and read messages from them.
 * This enables coordination between sub-agents in a workflow without
 * needing direct inter-session messaging.
 *
 * Boards are stored as JSONL files in `<workspace>/.agent-boards/`.
 * Each line is a message with timestamp, sender, and content.
 */

import { Type } from "@sinclair/typebox";
import fs from "node:fs/promises";
import path from "node:path";
import type { AnyAgentTool } from "./common.js";
import { jsonResult, readStringParam, readNumberParam } from "./common.js";
import { resolveWorkspaceRoot } from "../workspace-dir.js";

/* ------------------------------------------------------------------ */
/*  Types                                                             */
/* ------------------------------------------------------------------ */

interface BoardMessage {
  id: string;
  board: string;
  from: string;
  message: string;
  timestamp: number;
  tags?: string[];
}

/* ------------------------------------------------------------------ */
/*  Schema                                                            */
/* ------------------------------------------------------------------ */

const AgentBoardToolSchema = Type.Object({
  action: Type.Union([
    Type.Literal("post"),
    Type.Literal("read"),
    Type.Literal("list"),
    Type.Literal("clear"),
  ]),
  board: Type.Optional(Type.String()),
  message: Type.Optional(Type.String()),
  from: Type.Optional(Type.String()),
  tags: Type.Optional(Type.Array(Type.String())),
  /** For read: only messages after this ISO timestamp */
  since: Type.Optional(Type.String()),
  /** For read: max messages to return (default 50) */
  limit: Type.Optional(Type.Number({ minimum: 1 })),
});

/* ------------------------------------------------------------------ */
/*  Helpers                                                           */
/* ------------------------------------------------------------------ */

function boardDir(): string {
  return path.join(resolveWorkspaceRoot(), ".agent-boards");
}

function boardPath(board: string): string {
  const safe = board.replace(/[^a-zA-Z0-9_-]/g, "_");
  return path.join(boardDir(), `${safe}.jsonl`);
}

async function ensureBoardDir(): Promise<void> {
  await fs.mkdir(boardDir(), { recursive: true });
}

async function readBoard(board: string): Promise<BoardMessage[]> {
  try {
    const raw = await fs.readFile(boardPath(board), "utf-8");
    return raw
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        try {
          return JSON.parse(line) as BoardMessage;
        } catch {
          return null;
        }
      })
      .filter((m): m is BoardMessage => m !== null);
  } catch {
    return [];
  }
}

async function appendToBoard(
  board: string,
  msg: BoardMessage,
): Promise<void> {
  await ensureBoardDir();
  await fs.appendFile(boardPath(board), JSON.stringify(msg) + "\n");
}

/* ------------------------------------------------------------------ */
/*  Tool factory                                                      */
/* ------------------------------------------------------------------ */

export function createAgentBoardTool(): AnyAgentTool {
  return {
    label: "Agent Board",
    name: "agent_board",
    description: `Inter-agent message board for coordination between sub-agents.

Actions:
- **post**: Post a message to a named board.
- **read**: Read messages from a board (optionally filtered by 'since' timestamp).
- **list**: List all active boards.
- **clear**: Delete a board.

Boards persist across sessions. Use for multi-agent coordination within workflows.`,
    parameters: AgentBoardToolSchema,
    execute: async (_toolCallId, args) => {
      const params = args as Record<string, unknown>;
      const action = readStringParam(params, "action", { required: true });

      switch (action) {
        case "post": {
          const board = readStringParam(params, "board", { required: true });
          const message = readStringParam(params, "message", { required: true });
          const from = readStringParam(params, "from") ?? "anonymous";
          const tags = Array.isArray(params.tags)
            ? (params.tags as string[]).filter((t) => typeof t === "string")
            : undefined;

          const msg: BoardMessage = {
            id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
            board,
            from,
            message,
            timestamp: Date.now(),
            ...(tags?.length ? { tags } : {}),
          };

          await appendToBoard(board, msg);
          return jsonResult({ status: "posted", id: msg.id, board });
        }

        case "read": {
          const board = readStringParam(params, "board", { required: true });
          const sinceStr = readStringParam(params, "since");
          const limit = readNumberParam(params, "limit", { integer: true }) ?? 50;

          let messages = await readBoard(board);

          if (sinceStr) {
            if (sinceStr === "last_read") {
              // Return all messages — caller manages their own cursor
            } else {
              const sinceMs = new Date(sinceStr).getTime();
              if (!Number.isNaN(sinceMs)) {
                messages = messages.filter((m) => m.timestamp > sinceMs);
              }
            }
          }

          // Return latest N
          messages = messages.slice(-limit);

          return jsonResult({
            status: "ok",
            board,
            count: messages.length,
            messages: messages.map((m) => ({
              id: m.id,
              from: m.from,
              message: m.message,
              timestamp: new Date(m.timestamp).toISOString(),
              ...(m.tags?.length ? { tags: m.tags } : {}),
            })),
          });
        }

        case "list": {
          try {
            const dir = boardDir();
            const files = await fs.readdir(dir);
            const boards = files
              .filter((f) => f.endsWith(".jsonl"))
              .map((f) => f.replace(".jsonl", ""));
            return jsonResult({ status: "ok", boards });
          } catch {
            return jsonResult({ status: "ok", boards: [] });
          }
        }

        case "clear": {
          const board = readStringParam(params, "board", { required: true });
          try {
            await fs.unlink(boardPath(board));
            return jsonResult({ status: "cleared", board });
          } catch {
            return jsonResult({ status: "ok", board, note: "Board did not exist" });
          }
        }

        default:
          return jsonResult({
            status: "error",
            error: `Unknown action: ${action}`,
          });
      }
    },
  };
}
