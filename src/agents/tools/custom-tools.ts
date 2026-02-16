/**
 * custom-tools — Runtime tool registration from config.
 *
 * Allows users to define tools in config.yaml without writing TypeScript:
 *
 *   tools:
 *     custom:
 *       - name: company_lookup
 *         description: Look up company info by name
 *         endpoint: http://localhost:8001/api/company
 *         method: POST
 *         parameters:
 *           company_name: { type: string, required: true, description: Name to search }
 *
 *       - name: crm_search
 *         description: Search CRM contacts
 *         script: python tools/crm-search.py
 *         parameters:
 *           query: { type: string, description: Search query }
 *
 * Two execution modes:
 *  - **endpoint**: HTTP request (GET/POST/PUT/DELETE)
 *  - **script**: Shell command execution (stdout = result)
 */

import { Type, type TObject, type TProperties } from "@sinclair/typebox";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { AnyAgentTool } from "./common.js";
import { jsonResult, readStringParam } from "./common.js";

const execFileAsync = promisify(execFile);

/* ------------------------------------------------------------------ */
/*  Config types                                                      */
/* ------------------------------------------------------------------ */

import type {
  CustomToolDefinition as CustomToolConfig,
  CustomToolParameterConfig,
} from "../../config/types.tools.js";

export type { CustomToolConfig };

/* ------------------------------------------------------------------ */
/*  Schema builder                                                    */
/* ------------------------------------------------------------------ */

function buildParameterSchema(
  params: Record<string, CustomToolParameterConfig> | undefined,
): TObject {
  if (!params || Object.keys(params).length === 0) {
    return Type.Object({});
  }

  const properties: TProperties = {};
  for (const [key, cfg] of Object.entries(params)) {
    const typeMap = {
      string: Type.String,
      number: Type.Number,
      boolean: Type.Boolean,
    } as const;
    const typeFn = typeMap[cfg.type ?? "string"] ?? Type.String;

    if (cfg.required) {
      properties[key] = typeFn({ description: cfg.description });
    } else {
      properties[key] = Type.Optional(typeFn({ description: cfg.description }));
    }
  }

  return Type.Object(properties);
}

/* ------------------------------------------------------------------ */
/*  HTTP executor                                                     */
/* ------------------------------------------------------------------ */

async function executeHttpTool(
  cfg: CustomToolConfig,
  params: Record<string, unknown>,
): Promise<string> {
  const method = cfg.method ?? "POST";
  const url = new URL(cfg.endpoint!);

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    ...cfg.headers,
  };

  const fetchOptions: RequestInit = {
    method,
    headers,
    signal: AbortSignal.timeout((cfg.timeoutSeconds ?? 30) * 1000),
  };

  if (method === "GET") {
    // Params as query string
    for (const [key, value] of Object.entries(params)) {
      if (value !== undefined && value !== null) {
        url.searchParams.set(key, String(value));
      }
    }
  } else {
    fetchOptions.body = JSON.stringify(params);
  }

  const response = await fetch(url.toString(), fetchOptions);
  const text = await response.text();

  if (!response.ok) {
    throw new Error(
      `HTTP ${response.status} ${response.statusText}: ${text.slice(0, 500)}`,
    );
  }

  return text;
}

/* ------------------------------------------------------------------ */
/*  Script executor                                                   */
/* ------------------------------------------------------------------ */

async function executeScriptTool(
  cfg: CustomToolConfig,
  params: Record<string, unknown>,
): Promise<string> {
  const parts = cfg.script!.split(/\s+/);
  const command = parts[0];
  const baseArgs = parts.slice(1);

  // Pass params as --key=value args
  const paramArgs: string[] = [];
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null) {
      paramArgs.push(`--${key}=${String(value)}`);
    }
  }

  const timeoutMs = (cfg.timeoutSeconds ?? 30) * 1000;

  try {
    const { stdout, stderr } = await execFileAsync(
      command,
      [...baseArgs, ...paramArgs],
      {
        timeout: timeoutMs,
        maxBuffer: 1024 * 1024, // 1MB
        env: {
          ...process.env,
          // Pass params as env vars too (TOOL_PARAM_<KEY>)
          ...Object.fromEntries(
            Object.entries(params)
              .filter(([, v]) => v !== undefined && v !== null)
              .map(([k, v]) => [`TOOL_PARAM_${k.toUpperCase()}`, String(v)]),
          ),
        },
      },
    );

    if (stderr && !stdout) {
      return stderr;
    }
    return stdout || "(no output)";
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`Script execution failed: ${msg}`);
  }
}

/* ------------------------------------------------------------------ */
/*  Tool factory                                                      */
/* ------------------------------------------------------------------ */

function createSingleCustomTool(cfg: CustomToolConfig): AnyAgentTool {
  const schema = buildParameterSchema(cfg.parameters);

  return {
    label: cfg.label ?? "Custom",
    name: cfg.name,
    description: cfg.description,
    parameters: schema,
    execute: async (_toolCallId, args) => {
      const params = (args ?? {}) as Record<string, unknown>;

      // Apply defaults
      if (cfg.parameters) {
        for (const [key, paramCfg] of Object.entries(cfg.parameters)) {
          if (params[key] === undefined && paramCfg.default !== undefined) {
            params[key] = paramCfg.default;
          }
        }
      }

      try {
        let result: string;
        if (cfg.endpoint) {
          result = await executeHttpTool(cfg, params);
        } else if (cfg.script) {
          result = await executeScriptTool(cfg, params);
        } else {
          return jsonResult({
            status: "error",
            error: "Custom tool must have either 'endpoint' or 'script' configured",
          });
        }

        // Try to parse as JSON for structured result
        try {
          const parsed = JSON.parse(result);
          return jsonResult(parsed);
        } catch {
          // Return as plain text
          return jsonResult({ status: "ok", output: result });
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return jsonResult({ status: "error", error: msg });
      }
    },
  };
}

/**
 * Create custom tools from config.
 *
 * Reads `tools.custom[]` from the config and returns tool instances.
 * Skips tools with names that conflict with existing tools.
 */
export function createCustomTools(options?: {
  customToolConfigs?: CustomToolConfig[];
  existingToolNames?: Set<string>;
}): AnyAgentTool[] {
  const configs = options?.customToolConfigs ?? [];
  const existing = options?.existingToolNames ?? new Set();
  const tools: AnyAgentTool[] = [];

  for (const cfg of configs) {
    if (!cfg.name || !cfg.description) {
      continue;
    }
    if (existing.has(cfg.name)) {
      // Don't override built-in tools
      continue;
    }
    if (!cfg.endpoint && !cfg.script) {
      continue;
    }

    tools.push(createSingleCustomTool(cfg));
  }

  return tools;
}
