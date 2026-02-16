export type ThemeMode =
  | "system"
  | "dark"
  | "light"
  | "dracula"
  | "tokyo-night"
  | "one-dark"
  | "catppuccin-mocha"
  | "gruvbox"
  | "nord"
  | "alucard"
  | "tokyo-night-light"
  | "github-light"
  | "catppuccin-latte"
  | "atom-light"
  | "solarized-light";

export type ThemeGroup = "auto" | "dark" | "light";

export type ThemeMetadata = {
  id: ThemeMode;
  name: string;
  group: ThemeGroup;
  accent?: string;
};

export const THEMES: readonly ThemeMetadata[] = [
  { id: "system", name: "System", group: "auto" },
  { id: "dark", name: "OpenClaw Dark", group: "dark", accent: "#ff5c5c" },
  { id: "light", name: "OpenClaw Light", group: "light", accent: "#dc2626" },
  { id: "dracula", name: "Dracula", group: "dark", accent: "#ff79c6" },
  { id: "tokyo-night", name: "Tokyo Night", group: "dark", accent: "#7aa2f7" },
  { id: "one-dark", name: "One Dark Pro", group: "dark", accent: "#61afef" },
  { id: "catppuccin-mocha", name: "Catppuccin Mocha", group: "dark", accent: "#cba6f7" },
  { id: "gruvbox", name: "Gruvbox", group: "dark", accent: "#fe8019" },
  { id: "nord", name: "Nord", group: "dark", accent: "#88c0d0" },
  { id: "alucard", name: "Alucard", group: "light", accent: "#a3144d" },
  { id: "tokyo-night-light", name: "Tokyo Night Light", group: "light", accent: "#2959aa" },
  { id: "github-light", name: "GitHub Light", group: "light", accent: "#0969da" },
  { id: "catppuccin-latte", name: "Catppuccin Latte", group: "light", accent: "#8839ef" },
  { id: "atom-light", name: "Atom One Light", group: "light", accent: "#4078f2" },
  { id: "solarized-light", name: "Solarized Light", group: "light", accent: "#268bd2" },
] as const;

function getSystemTheme(): "light" | "dark" {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") {
    return "dark";
  }
  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

export function resolveTheme(mode: ThemeMode): string {
  if (mode === "system") {
    return getSystemTheme();
  }
  return mode;
}
