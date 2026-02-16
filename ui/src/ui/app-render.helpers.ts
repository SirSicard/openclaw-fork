import { html } from "lit";
import { repeat } from "lit/directives/repeat.js";
import type { AppViewState } from "./app-view-state.ts";
import type { ThemeTransitionContext } from "./theme-transition.ts";
import type { ThemeMode } from "./theme.ts";
import type { SessionsListResult } from "./types.ts";
import { refreshChat } from "./app-chat.ts";
import { syncUrlWithSessionKey } from "./app-settings.ts";
import { OpenClawApp } from "./app.ts";
import { ChatState, loadChatHistory } from "./controllers/chat.ts";
import { icons } from "./icons.ts";
import { iconForTab, pathForTab, titleForTab, type Tab } from "./navigation.ts";
import { THEMES } from "./theme.ts";

type SessionDefaultsSnapshot = {
  mainSessionKey?: string;
  mainKey?: string;
};

function resolveSidebarChatSessionKey(state: AppViewState): string {
  const snapshot = state.hello?.snapshot as
    | { sessionDefaults?: SessionDefaultsSnapshot }
    | undefined;
  const mainSessionKey = snapshot?.sessionDefaults?.mainSessionKey?.trim();
  if (mainSessionKey) {
    return mainSessionKey;
  }
  const mainKey = snapshot?.sessionDefaults?.mainKey?.trim();
  if (mainKey) {
    return mainKey;
  }
  return "main";
}

function resetChatStateForSessionSwitch(state: AppViewState, sessionKey: string) {
  state.sessionKey = sessionKey;
  state.chatMessage = "";
  state.chatStream = null;
  (state as unknown as OpenClawApp).chatStreamStartedAt = null;
  state.chatRunId = null;
  (state as unknown as OpenClawApp).resetToolStream();
  (state as unknown as OpenClawApp).resetChatScroll();
  state.applySettings({
    ...state.settings,
    sessionKey,
    lastActiveSessionKey: sessionKey,
  });
}

export function renderTab(state: AppViewState, tab: Tab) {
  const href = pathForTab(tab, state.basePath);
  return html`
    <a
      href=${href}
      class="nav-item ${state.tab === tab ? "active" : ""}"
      @click=${(event: MouseEvent) => {
        if (
          event.defaultPrevented ||
          event.button !== 0 ||
          event.metaKey ||
          event.ctrlKey ||
          event.shiftKey ||
          event.altKey
        ) {
          return;
        }
        event.preventDefault();
        if (tab === "chat") {
          const mainSessionKey = resolveSidebarChatSessionKey(state);
          if (state.sessionKey !== mainSessionKey) {
            resetChatStateForSessionSwitch(state, mainSessionKey);
            void state.loadAssistantIdentity();
          }
        }
        state.setTab(tab);
      }}
      title=${titleForTab(tab)}
    >
      <span class="nav-item__icon" aria-hidden="true">${icons[iconForTab(tab)]}</span>
      <span class="nav-item__text">${titleForTab(tab)}</span>
    </a>
  `;
}

export function renderChatControls(state: AppViewState) {
  const mainSessionKey = resolveMainSessionKey(state.hello, state.sessionsResult);
  const sessionOptions = resolveSessionOptions(
    state.sessionKey,
    state.sessionsResult,
    mainSessionKey,
  );
  const disableThinkingToggle = state.onboarding;
  const disableFocusToggle = state.onboarding;
  const showThinking = state.onboarding ? false : state.settings.chatShowThinking;
  const focusActive = state.onboarding ? true : state.settings.chatFocusMode;
  // Refresh icon
  const refreshIcon = html`
    <svg
      width="18"
      height="18"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width="2"
      stroke-linecap="round"
      stroke-linejoin="round"
    >
      <path d="M21 12a9 9 0 1 1-9-9c2.52 0 4.93 1 6.74 2.74L21 8"></path>
      <path d="M21 3v5h-5"></path>
    </svg>
  `;
  const focusIcon = html`
    <svg
      width="18"
      height="18"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width="2"
      stroke-linecap="round"
      stroke-linejoin="round"
    >
      <path d="M4 7V4h3"></path>
      <path d="M20 7V4h-3"></path>
      <path d="M4 17v3h3"></path>
      <path d="M20 17v3h-3"></path>
      <circle cx="12" cy="12" r="3"></circle>
    </svg>
  `;
  return html`
    <div class="chat-controls">
      <label class="field chat-controls__session">
        <select
          .value=${state.sessionKey}
          ?disabled=${!state.connected}
          @change=${(e: Event) => {
            const next = (e.target as HTMLSelectElement).value;
            state.sessionKey = next;
            state.chatMessage = "";
            state.chatStream = null;
            (state as unknown as OpenClawApp).chatStreamStartedAt = null;
            state.chatRunId = null;
            (state as unknown as OpenClawApp).resetToolStream();
            (state as unknown as OpenClawApp).resetChatScroll();
            state.applySettings({
              ...state.settings,
              sessionKey: next,
              lastActiveSessionKey: next,
            });
            void state.loadAssistantIdentity();
            syncUrlWithSessionKey(
              state as unknown as Parameters<typeof syncUrlWithSessionKey>[0],
              next,
              true,
            );
            void loadChatHistory(state as unknown as ChatState);
          }}
        >
          ${repeat(
            sessionOptions,
            (entry) => entry.key,
            (entry) =>
              html`<option value=${entry.key} title=${entry.key}>
                ${entry.displayName ?? entry.key}
              </option>`,
          )}
        </select>
      </label>
      <button
        class="btn btn--sm btn--icon"
        ?disabled=${state.chatLoading || !state.connected}
        @click=${async () => {
          const app = state as unknown as OpenClawApp;
          app.chatManualRefreshInFlight = true;
          app.chatNewMessagesBelow = false;
          await app.updateComplete;
          app.resetToolStream();
          try {
            await refreshChat(state as unknown as Parameters<typeof refreshChat>[0], {
              scheduleScroll: false,
            });
            app.scrollToBottom({ smooth: true });
          } finally {
            requestAnimationFrame(() => {
              app.chatManualRefreshInFlight = false;
              app.chatNewMessagesBelow = false;
            });
          }
        }}
        title="Refresh chat data"
      >
        ${refreshIcon}
      </button>
      <span class="chat-controls__separator">|</span>
      <button
        class="btn btn--sm btn--icon ${showThinking ? "active" : ""}"
        ?disabled=${disableThinkingToggle}
        @click=${() => {
          if (disableThinkingToggle) {
            return;
          }
          state.applySettings({
            ...state.settings,
            chatShowThinking: !state.settings.chatShowThinking,
          });
        }}
        aria-pressed=${showThinking}
        title=${
          disableThinkingToggle
            ? "Disabled during onboarding"
            : "Toggle assistant thinking/working output"
        }
      >
        ${icons.brain}
      </button>
      <button
        class="btn btn--sm btn--icon ${focusActive ? "active" : ""}"
        ?disabled=${disableFocusToggle}
        @click=${() => {
          if (disableFocusToggle) {
            return;
          }
          state.applySettings({
            ...state.settings,
            chatFocusMode: !state.settings.chatFocusMode,
          });
        }}
        aria-pressed=${focusActive}
        title=${
          disableFocusToggle
            ? "Disabled during onboarding"
            : "Toggle focus mode (hide sidebar + page header)"
        }
      >
        ${focusIcon}
      </button>
    </div>
  `;
}

function resolveMainSessionKey(
  hello: AppViewState["hello"],
  sessions: SessionsListResult | null,
): string | null {
  const snapshot = hello?.snapshot as { sessionDefaults?: SessionDefaultsSnapshot } | undefined;
  const mainSessionKey = snapshot?.sessionDefaults?.mainSessionKey?.trim();
  if (mainSessionKey) {
    return mainSessionKey;
  }
  const mainKey = snapshot?.sessionDefaults?.mainKey?.trim();
  if (mainKey) {
    return mainKey;
  }
  if (sessions?.sessions?.some((row) => row.key === "main")) {
    return "main";
  }
  return null;
}

/* ── Channel display labels ────────────────────────────── */
const CHANNEL_LABELS: Record<string, string> = {
  bluebubbles: "iMessage",
  telegram: "Telegram",
  discord: "Discord",
  signal: "Signal",
  slack: "Slack",
  whatsapp: "WhatsApp",
  matrix: "Matrix",
  email: "Email",
  sms: "SMS",
};

const KNOWN_CHANNEL_KEYS = Object.keys(CHANNEL_LABELS);

/** Parsed type / context extracted from a session key. */
export type SessionKeyInfo = {
  /** Prefix for typed sessions (Subagent:/Cron:). Empty for others. */
  prefix: string;
  /** Human-readable fallback when no label / displayName is available. */
  fallbackName: string;
};

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/**
 * Parse a session key to extract type information and a human-readable
 * fallback display name.  Exported for testing.
 */
export function parseSessionKey(key: string): SessionKeyInfo {
  // ── Main session ─────────────────────────────────
  if (key === "main" || key === "agent:main:main") {
    return { prefix: "", fallbackName: "Main Session" };
  }

  // ── Subagent ─────────────────────────────────────
  if (key.includes(":subagent:")) {
    return { prefix: "Subagent:", fallbackName: "Subagent:" };
  }

  // ── Cron job ─────────────────────────────────────
  if (key.includes(":cron:")) {
    return { prefix: "Cron:", fallbackName: "Cron Job:" };
  }

  // ── Direct chat  (agent:<x>:<channel>:direct:<id>) ──
  const directMatch = key.match(/^agent:[^:]+:([^:]+):direct:(.+)$/);
  if (directMatch) {
    const channel = directMatch[1];
    const identifier = directMatch[2];
    const channelLabel = CHANNEL_LABELS[channel] ?? capitalize(channel);
    return { prefix: "", fallbackName: `${channelLabel} · ${identifier}` };
  }

  // ── Group chat  (agent:<x>:<channel>:group:<id>) ────
  const groupMatch = key.match(/^agent:[^:]+:([^:]+):group:(.+)$/);
  if (groupMatch) {
    const channel = groupMatch[1];
    const channelLabel = CHANNEL_LABELS[channel] ?? capitalize(channel);
    return { prefix: "", fallbackName: `${channelLabel} Group` };
  }

  // ── Channel-prefixed legacy keys (e.g. "bluebubbles:g-…") ──
  for (const ch of KNOWN_CHANNEL_KEYS) {
    if (key === ch || key.startsWith(`${ch}:`)) {
      return { prefix: "", fallbackName: `${CHANNEL_LABELS[ch]} Session` };
    }
  }

  // ── Unknown — return key as-is ───────────────────
  return { prefix: "", fallbackName: key };
}

export function resolveSessionDisplayName(
  key: string,
  row?: SessionsListResult["sessions"][number],
): string {
  const label = row?.label?.trim() || "";
  const displayName = row?.displayName?.trim() || "";
  const { prefix, fallbackName } = parseSessionKey(key);

  if (label && label !== key) {
    return prefix ? `${prefix} ${label}` : label;
  }
  if (displayName && displayName !== key) {
    return prefix ? `${prefix} ${displayName}` : displayName;
  }
  return fallbackName;
}

function resolveSessionOptions(
  sessionKey: string,
  sessions: SessionsListResult | null,
  mainSessionKey?: string | null,
) {
  const seen = new Set<string>();
  const options: Array<{ key: string; displayName?: string }> = [];

  const resolvedMain = mainSessionKey && sessions?.sessions?.find((s) => s.key === mainSessionKey);
  const resolvedCurrent = sessions?.sessions?.find((s) => s.key === sessionKey);

  // Add main session key first
  if (mainSessionKey) {
    seen.add(mainSessionKey);
    options.push({
      key: mainSessionKey,
      displayName: resolveSessionDisplayName(mainSessionKey, resolvedMain || undefined),
    });
  }

  // Add current session key next
  if (!seen.has(sessionKey)) {
    seen.add(sessionKey);
    options.push({
      key: sessionKey,
      displayName: resolveSessionDisplayName(sessionKey, resolvedCurrent),
    });
  }

  // Add sessions from the result
  if (sessions?.sessions) {
    for (const s of sessions.sessions) {
      if (!seen.has(s.key)) {
        seen.add(s.key);
        options.push({
          key: s.key,
          displayName: resolveSessionDisplayName(s.key, s),
        });
      }
    }
  }

  return options;
}

// Theme picker state management (inline)
let themePickerOpen = false;
let themePickerCloseHandler: ((e: MouseEvent) => void) | null = null;

export function renderThemeToggle(state: AppViewState) {
  const currentTheme = THEMES.find((t) => t.id === state.theme);
  const currentName = currentTheme?.name ?? "Theme";
  const currentAccent = currentTheme?.accent ?? "#ff5c5c";

  const toggleDropdown = (event: MouseEvent) => {
    event.stopPropagation();
    themePickerOpen = !themePickerOpen;

    if (themePickerOpen) {
      // Add click-outside handler
      themePickerCloseHandler = (e: MouseEvent) => {
        const target = e.target as HTMLElement;
        if (!target.closest(".theme-picker")) {
          themePickerOpen = false;
          if (themePickerCloseHandler) {
            document.removeEventListener("click", themePickerCloseHandler);
            themePickerCloseHandler = null;
          }
          (state as unknown as OpenClawApp).requestUpdate();
        }
      };
      setTimeout(() => {
        if (themePickerCloseHandler) {
          document.addEventListener("click", themePickerCloseHandler);
        }
      }, 0);

      // Add Escape key handler
      const escapeHandler = (e: KeyboardEvent) => {
        if (e.key === "Escape") {
          themePickerOpen = false;
          if (themePickerCloseHandler) {
            document.removeEventListener("click", themePickerCloseHandler);
            themePickerCloseHandler = null;
          }
          document.removeEventListener("keydown", escapeHandler);
          (state as unknown as OpenClawApp).requestUpdate();
        }
      };
      document.addEventListener("keydown", escapeHandler);
    } else {
      if (themePickerCloseHandler) {
        document.removeEventListener("click", themePickerCloseHandler);
        themePickerCloseHandler = null;
      }
    }

    (state as unknown as OpenClawApp).requestUpdate();
  };

  const applyTheme = (next: ThemeMode) => (event: MouseEvent) => {
    event.stopPropagation();
    const element = event.currentTarget as HTMLElement;
    const context: ThemeTransitionContext = { element };
    if (event.clientX || event.clientY) {
      context.pointerClientX = event.clientX;
      context.pointerClientY = event.clientY;
    }
    state.setTheme(next, context);

    // Close dropdown
    themePickerOpen = false;
    if (themePickerCloseHandler) {
      document.removeEventListener("click", themePickerCloseHandler);
      themePickerCloseHandler = null;
    }
  };

  const autoThemes = THEMES.filter((t) => t.group === "auto");
  const darkThemes = THEMES.filter((t) => t.group === "dark");
  const lightThemes = THEMES.filter((t) => t.group === "light");

  return html`
    <div class="theme-picker">
      <button
        class="theme-picker__trigger"
        @click=${toggleDropdown}
        aria-expanded=${themePickerOpen}
        aria-label="Select theme"
      >
        <span
          class="theme-picker__dot"
          style="background-color: ${currentAccent};"
          aria-hidden="true"
        ></span>
        <span class="theme-picker__trigger-text">${currentName}</span>
        <svg
          class="theme-picker__chevron"
          width="16"
          height="16"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          stroke-width="2"
          stroke-linecap="round"
          stroke-linejoin="round"
          aria-hidden="true"
        >
          <polyline points="6 9 12 15 18 9"></polyline>
        </svg>
      </button>
      
      ${
        themePickerOpen
          ? html`
            <div class="theme-picker__dropdown">
              ${
                autoThemes.length > 0
                  ? html`
                    <div class="theme-picker__group">
                      <div class="theme-picker__group-label">Auto</div>
                      ${repeat(
                        autoThemes,
                        (theme) => theme.id,
                        (theme) => html`
                          <button
                            class="theme-picker__item ${state.theme === theme.id ? "active" : ""}"
                            @click=${applyTheme(theme.id)}
                          >
                            <span
                              class="theme-picker__dot"
                              style="background-color: ${theme.accent ?? "transparent"};"
                              aria-hidden="true"
                            ></span>
                            <span class="theme-picker__item-name">${theme.name}</span>
                            ${
                              state.theme === theme.id
                                ? html`
                                    <span class="theme-picker__check" aria-label="Selected">✓</span>
                                  `
                                : ""
                            }
                          </button>
                        `,
                      )}
                    </div>
                  `
                  : ""
              }
              
              ${
                darkThemes.length > 0
                  ? html`
                    <div class="theme-picker__group">
                      <div class="theme-picker__group-label">Dark</div>
                      ${repeat(
                        darkThemes,
                        (theme) => theme.id,
                        (theme) => html`
                          <button
                            class="theme-picker__item ${state.theme === theme.id ? "active" : ""}"
                            @click=${applyTheme(theme.id)}
                          >
                            <span
                              class="theme-picker__dot"
                              style="background-color: ${theme.accent ?? "transparent"};"
                              aria-hidden="true"
                            ></span>
                            <span class="theme-picker__item-name">${theme.name}</span>
                            ${
                              state.theme === theme.id
                                ? html`
                                    <span class="theme-picker__check" aria-label="Selected">✓</span>
                                  `
                                : ""
                            }
                          </button>
                        `,
                      )}
                    </div>
                  `
                  : ""
              }
              
              ${
                lightThemes.length > 0
                  ? html`
                    <div class="theme-picker__group">
                      <div class="theme-picker__group-label">Light</div>
                      ${repeat(
                        lightThemes,
                        (theme) => theme.id,
                        (theme) => html`
                          <button
                            class="theme-picker__item ${state.theme === theme.id ? "active" : ""}"
                            @click=${applyTheme(theme.id)}
                          >
                            <span
                              class="theme-picker__dot"
                              style="background-color: ${theme.accent ?? "transparent"};"
                              aria-hidden="true"
                            ></span>
                            <span class="theme-picker__item-name">${theme.name}</span>
                            ${
                              state.theme === theme.id
                                ? html`
                                    <span class="theme-picker__check" aria-label="Selected">✓</span>
                                  `
                                : ""
                            }
                          </button>
                        `,
                      )}
                    </div>
                  `
                  : ""
              }
            </div>
          `
          : ""
      }
    </div>
  `;
}
