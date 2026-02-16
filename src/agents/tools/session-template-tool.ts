/**
 * session_template — Apply pre-configured session templates.
 *
 * Templates are defined in config:
 *
 *   sessions:
 *     templates:
 *       coding:
 *         model: opus
 *         thinking: high
 *         systemPrompt: "You are a senior engineer..."
 *       research:
 *         model: sonnet
 *         systemPrompt: "You are a research analyst..."
 *
 * When spawning a sub-agent or configuring a session, the agent can
 * reference a template by name to apply its settings.
 */

import { Type } from "@sinclair/typebox";
import type { AnyAgentTool } from "./common.js";
import { jsonResult, readStringParam } from "./common.js";
import { loadConfig } from "../../config/config.js";
import { callGateway } from "../../gateway/call.js";

/* ------------------------------------------------------------------ */
/*  Config types                                                      */
/* ------------------------------------------------------------------ */

export type SessionTemplateConfig = {
  model?: string;
  thinking?: string;
  systemPrompt?: string;
  description?: string;
};

/* ------------------------------------------------------------------ */
/*  Schema                                                            */
/* ------------------------------------------------------------------ */

const SessionTemplateToolSchema = Type.Object({
  action: Type.Union([
    Type.Literal("list"),
    Type.Literal("apply"),
  ]),
  /** Template name (for apply action) */
  template: Type.Optional(Type.String()),
  /** Session key to apply template to (default: current session) */
  sessionKey: Type.Optional(Type.String()),
});

/* ------------------------------------------------------------------ */
/*  Tool factory                                                      */
/* ------------------------------------------------------------------ */

export function createSessionTemplateTool(opts?: {
  agentSessionKey?: string;
}): AnyAgentTool {
  return {
    label: "Session Templates",
    name: "session_template",
    description: `Manage and apply pre-configured session templates.

Actions:
- **list**: Show all available templates with their settings.
- **apply**: Apply a template's model/thinking/prompt settings to a session.

Templates are defined in config under sessions.templates.`,
    parameters: SessionTemplateToolSchema,
    execute: async (_toolCallId, args) => {
      const params = args as Record<string, unknown>;
      const action = readStringParam(params, "action", { required: true });
      const cfg = loadConfig();

      // Templates live at session.templates in config
      const templates =
        (cfg.session as Record<string, unknown> | undefined)?.templates as
          | Record<string, SessionTemplateConfig>
          | undefined;

      switch (action) {
        case "list": {
          if (!templates || Object.keys(templates).length === 0) {
            return jsonResult({
              status: "ok",
              templates: [],
              note: "No templates defined. Add them under session.templates in config.",
            });
          }

          const list = Object.entries(templates).map(([name, tmpl]) => ({
            name,
            model: tmpl.model,
            thinking: tmpl.thinking,
            description: tmpl.description,
            hasSystemPrompt: !!tmpl.systemPrompt,
          }));

          return jsonResult({ status: "ok", templates: list });
        }

        case "apply": {
          const templateName = readStringParam(params, "template", { required: true });
          const sessionKey =
            readStringParam(params, "sessionKey") ?? opts?.agentSessionKey;

          if (!templates || !templates[templateName]) {
            return jsonResult({
              status: "error",
              error: `Template "${templateName}" not found`,
              available: templates ? Object.keys(templates) : [],
            });
          }

          const tmpl = templates[templateName];
          const applied: string[] = [];

          if (sessionKey && tmpl.model) {
            try {
              await callGateway({
                method: "sessions.patch",
                params: { key: sessionKey, model: tmpl.model },
                timeoutMs: 10_000,
              });
              applied.push(`model: ${tmpl.model}`);
            } catch (err) {
              return jsonResult({
                status: "error",
                error: `Failed to apply model: ${err instanceof Error ? err.message : String(err)}`,
              });
            }
          }

          if (sessionKey && tmpl.thinking) {
            try {
              await callGateway({
                method: "sessions.patch",
                params: {
                  key: sessionKey,
                  thinkingLevel: tmpl.thinking === "off" ? null : tmpl.thinking,
                },
                timeoutMs: 10_000,
              });
              applied.push(`thinking: ${tmpl.thinking}`);
            } catch {
              // Non-fatal
            }
          }

          return jsonResult({
            status: "applied",
            template: templateName,
            sessionKey,
            applied,
            systemPrompt: tmpl.systemPrompt
              ? "(system prompt available — inject via extraSystemPrompt when spawning)"
              : undefined,
          });
        }

        default:
          return jsonResult({ status: "error", error: `Unknown action: ${action}` });
      }
    },
  };
}
