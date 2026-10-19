import type { CustomTheme, ThemeBase } from "@cw-code/contracts";

export const BUILTIN_THEME_IDS = ["dark", "light", "system"] as const;

type SeedToken =
  | "gutter"
  | "bg"
  | "card"
  | "border"
  | "text"
  | "muted"
  | "violet"
  | "accent"
  | "success"
  | "warning"
  | "danger";

type Seeds = Record<SeedToken, string>;

const BLACK = "#000000";
const WHITE = "#ffffff";
const HEX_COLOR = /^#[0-9a-f]{6}$/i;

const DARK_PALETTE: Record<string, string> = {
  gutter: "#080a0f",
  line: "#222630",
  editor: "#101219",
  "panel-head": "#12141c",
  bg: "#151820",
  panel: "#151820",
  tool: "#181b24",
  "bg-deep": "#151922",
  card: "#1b202b",
  overlay: "#1f2330",
  "user-msg": "#232735",
  hover: "#1d2029",
  raised: "#262a36",
  border: "#303440",
  "border-soft": "#252a36",
  "border-strong": "#40465a",
  hair: "rgba(255, 255, 255, 0.05)",
  text: "#e9eaf0",
  dim: "#bdc0cc",
  muted: "#a4a8b5",
  faint: "#8f939f",
  claude: "#e8835a",
  "claude-soft": "rgba(232, 131, 90, 0.14)",
  opencode: "#5ab8ff",
  "opencode-soft": "rgba(90, 184, 255, 0.14)",
  codex: "#b49cff",
  "codex-soft": "rgba(180, 156, 255, 0.14)",
  violet: "#795cec",
  "violet-strong": "#6146d6",
  "violet-ink": "#a18cff",
  "violet-soft": "rgba(121, 92, 236, 0.2)",
  "violet-line": "rgba(161, 140, 255, 0.45)",
  success: "#59a659",
  warning: "#e8b44f",
  "on-success": "#07130b",
  "on-warning": "#201b10",
  danger: "#e17166",
  accent: "#5d90f7",
  "accent-ink": "#7fa7f9",
  "danger-ink": "#e78f86",
  "accent-fill": "#4572cc",
  "danger-fill": "#b8594f",
  "success-fill": "#468246",
  "neutral-fill": "#707582",
  "draft-fill": "#5f6476",
  "merged-fill": "#7b6baf",
  "surface-inset": "rgba(0, 0, 0, 0.3)",
  update: "#56c2d6",
  babysit: "#b5d84b",
  "on-babysit": "#17200a",
  merged: "#b49cff",
  "on-accent": "#fff",
  skill: "#d58ae6",
  "chip-fill": "rgba(255, 255, 255, 0.045)",
  "chip-fill-hover": "rgba(255, 255, 255, 0.08)",
  "shadow-float": "0 16px 40px rgba(0, 0, 0, 0.55)",
  "md-link": "#7fa8f8",
  "md-strong": "#f4f4f8",
  driver: "#9a9898",
  "driver-soft": "rgba(154, 152, 152, 0.12)",
  "scrollbar-thumb": "rgba(255, 255, 255, 0.08)",
  "scrollbar-thumb-hover": "rgba(255, 255, 255, 0.12)",
  "terminal-bg": "#1e1f22",
  "terminal-fg": "#bcbec4",
  "terminal-selection": "#214184",
  sunken: "#151922",
  "win-close": "#e81123",
  "preview-canvas": "#ffffff",
  "on-avatar": "#fdfcfc",
  ring: "#ffffff",
  "control-ink": "#9da1a8",
  "control-bg": "#262931",
  "control-bg-hover": "#313338",
  "control-ring": "#5d6378",
  "switch-track": "#2a2e3b",
  "switch-ring": "#4a4f62",
  "menu-surface": "#24262d",
  "tooltip-bg": "#2b2d33",
  "modal-bar": "#26282e",
  "row-selected": "#292c31",
  "table-row-hover": "#222327",
  "bar-row-hover": "#26282d",
  "tag-fill": "#2a2c31",
  "chart-grid": "#2d2f34",
  "avatar-bot": "#3a3d44",
  "new-ink": "#a9c5ff",
  "diff-add-bg": "#2c3b2e",
  "diff-add-ink": "#9ccb9c",
  "diff-del-bg": "#3d2b2d",
  "diff-del-ink": "#e17166",
  "diff-hunk-bg": "#2b3440",
  "diff-hunk-ink": "#7aa5f8",
  "composer-card": "rgba(160, 170, 225, 0.06)",
  "glow-working": "rgba(22, 217, 179, 0.7)",
  "glow-input": "rgba(59, 130, 246, 0.7)",
  scrim: "rgba(20, 21, 23, 0.92)",
  "scrim-strong": "rgba(0, 0, 0, 0.85)",
  backdrop: "rgba(0, 0, 0, 0.55)",
  "backdrop-strong": "rgba(0, 0, 0, 0.6)",
  "shadow-menu": "0 16px 40px rgba(0, 0, 0, 0.5)",
  "shadow-ctx-menu": "0 8px 24px rgba(0, 0, 0, 0.5)",
  "shadow-tooltip": "0 8px 24px rgba(0, 0, 0, 0.4)",
  "shadow-popover": "0 18px 44px rgba(0, 0, 0, 0.6)",
  "shadow-picker": "0 18px 44px rgba(2, 5, 12, 0.62)",
  "shadow-ghost": "0 12px 32px rgba(0, 0, 0, 0.55)",
  "shadow-card": "0 12px 32px rgba(0, 0, 0, 0.45)",
  "shadow-dialog": "0 28px 90px rgba(0, 0, 0, 0.62)",
  "shadow-composer": "0 18px 40px -20px rgba(0, 0, 0, 0.7)",
  "shadow-pill": "0 6px 18px -6px rgba(0, 0, 0, 0.6)"
};

const LIGHT_PALETTE: Record<string, string> = {
  gutter: "#e9ebf1",
  line: "#dcdfe7",
  editor: "#ffffff",
  "panel-head": "#f1f2f6",
  bg: "#f6f7fa",
  panel: "#f6f7fa",
  tool: "#eff1f5",
  "bg-deep": "#eef0f4",
  card: "#ffffff",
  overlay: "#ffffff",
  "user-msg": "#ecebf8",
  hover: "#eceef3",
  raised: "#e6e8ee",
  border: "#d6d9e2",
  "border-soft": "#e3e5ec",
  "border-strong": "#b9bdca",
  hair: "rgba(16, 20, 32, 0.06)",
  text: "#1a1d26",
  dim: "#353946",
  muted: "#5c6170",
  faint: "#7a7f8c",
  claude: "#c8603a",
  "claude-soft": "rgba(200, 96, 58, 0.12)",
  opencode: "#1a7fd0",
  "opencode-soft": "rgba(26, 127, 208, 0.12)",
  codex: "#7b5fd6",
  "codex-soft": "rgba(123, 95, 214, 0.12)",
  violet: "#6146d6",
  "violet-strong": "#5136c4",
  "violet-ink": "#5a3fd0",
  "violet-soft": "rgba(97, 70, 214, 0.12)",
  "violet-line": "rgba(97, 70, 214, 0.35)",
  success: "#2f8a3e",
  warning: "#a86b00",
  "on-success": "#ffffff",
  "on-warning": "#ffffff",
  danger: "#c8372b",
  accent: "#2f6fe0",
  "accent-ink": "#2459c4",
  "danger-ink": "#b42d22",
  "accent-fill": "#2f6fe0",
  "danger-fill": "#c8372b",
  "success-fill": "#2f8a3e",
  "neutral-fill": "#8a8f9c",
  "draft-fill": "#8a8f9c",
  "merged-fill": "#7b5fd6",
  "surface-inset": "rgba(16, 20, 32, 0.04)",
  update: "#0f8aa3",
  babysit: "#5f8a12",
  "on-babysit": "#ffffff",
  merged: "#7b5fd6",
  "on-accent": "#fff",
  skill: "#b04ec8",
  "chip-fill": "rgba(16, 20, 32, 0.04)",
  "chip-fill-hover": "rgba(16, 20, 32, 0.07)",
  "shadow-float": "0 16px 40px rgba(20, 24, 40, 0.14)",
  "md-link": "#2459c4",
  "md-strong": "#0f1219",
  driver: "#6b6f7b",
  "driver-soft": "rgba(107, 111, 123, 0.12)",
  "scrollbar-thumb": "rgba(16, 20, 32, 0.14)",
  "scrollbar-thumb-hover": "rgba(16, 20, 32, 0.22)",
  "terminal-bg": "#ffffff",
  "terminal-fg": "#1a1d26",
  "terminal-selection": "#d9d3f7",
  sunken: "#eef0f4",
  "win-close": "#e81123",
  "preview-canvas": "#ffffff",
  "on-avatar": "#fdfcfc",
  ring: "#1a1d26",
  "control-ink": "#6b7080",
  "control-bg": "#eceef3",
  "control-bg-hover": "#e3e6ec",
  "control-ring": "#a3a8b6",
  "switch-track": "#e3e5ec",
  "switch-ring": "#b9bdca",
  "menu-surface": "#ffffff",
  "tooltip-bg": "#ffffff",
  "modal-bar": "#f1f2f6",
  "row-selected": "#e8eaf0",
  "table-row-hover": "#f1f2f6",
  "bar-row-hover": "#eceef3",
  "tag-fill": "#e9ebf0",
  "chart-grid": "#e3e5ec",
  "avatar-bot": "#dcdfe7",
  "new-ink": "#2459c4",
  "diff-add-bg": "#e3f3e5",
  "diff-add-ink": "#1f6b2a",
  "diff-del-bg": "#fbe6e3",
  "diff-del-ink": "#a3271d",
  "diff-hunk-bg": "#e6edfb",
  "diff-hunk-ink": "#2459c4",
  "composer-card": "#ffffff",
  "glow-working": "rgba(15, 160, 130, 0.45)",
  "glow-input": "rgba(47, 111, 224, 0.4)",
  scrim: "rgba(246, 247, 250, 0.92)",
  "scrim-strong": "rgba(255, 255, 255, 0.94)",
  backdrop: "rgba(20, 24, 40, 0.28)",
  "backdrop-strong": "rgba(20, 24, 40, 0.32)",
  "shadow-menu": "0 12px 32px rgba(20, 24, 40, 0.14)",
  "shadow-ctx-menu": "0 6px 18px rgba(20, 24, 40, 0.14)",
  "shadow-tooltip": "0 6px 18px rgba(20, 24, 40, 0.12)",
  "shadow-popover": "0 14px 36px rgba(20, 24, 40, 0.16)",
  "shadow-picker": "0 14px 36px rgba(20, 24, 40, 0.16)",
  "shadow-ghost": "0 12px 32px rgba(20, 24, 40, 0.16)",
  "shadow-card": "0 10px 28px rgba(20, 24, 40, 0.12)",
  "shadow-dialog": "0 24px 64px rgba(20, 24, 40, 0.2)",
  "shadow-composer": "0 18px 40px -20px rgba(20, 24, 40, 0.22)",
  "shadow-pill": "0 6px 18px -6px rgba(20, 24, 40, 0.2)"
};

export const THEME_PALETTES: Record<ThemeBase, Record<string, string>> = {
  dark: DARK_PALETTE,
  light: LIGHT_PALETTE
};

export function isHexColor(value: unknown): value is string {
  return typeof value === "string" && HEX_COLOR.test(value);
}

export const THEME_COLOR_TOKENS: readonly string[] = Object.keys(DARK_PALETTE).filter(
  (token) => isHexColor(DARK_PALETTE[token]) && isHexColor(LIGHT_PALETTE[token])
);

export const CURATED_THEME_TOKENS: readonly { token: string; label: string }[] = [
  { token: "gutter", label: "Window" },
  { token: "bg", label: "Background" },
  { token: "card", label: "Surface" },
  { token: "border", label: "Border" },
  { token: "text", label: "Text" },
  { token: "muted", label: "Muted text" },
  { token: "violet", label: "Primary accent" },
  { token: "accent", label: "Link accent" },
  { token: "success", label: "Success" },
  { token: "warning", label: "Warning" },
  { token: "danger", label: "Danger" }
];

function channels(hex: string): [number, number, number] {
  if (!isHexColor(hex)) {
    throw new RangeError(`Invalid hex color: ${hex}`);
  }
  return [
    Number.parseInt(hex.slice(1, 3), 16),
    Number.parseInt(hex.slice(3, 5), 16),
    Number.parseInt(hex.slice(5, 7), 16)
  ];
}

function channelHex(value: number): string {
  return value.toString(16).padStart(2, "0");
}

export function mixHex(a: string, b: string, weightOfA: number): string {
  const weight = Math.min(1, Math.max(0, weightOfA));
  const first = channels(a);
  const second = channels(b);
  const mixed = first.map((channel, index) => Math.round(channel * weight + second[index] * (1 - weight)));
  return `#${mixed.map(channelHex).join("")}`;
}

export function withAlpha(hex: string, alpha: number): string {
  const [red, green, blue] = channels(hex);
  return `rgba(${red}, ${green}, ${blue}, ${Number(alpha.toFixed(3))})`;
}

const INSET_ALPHA: Record<ThemeBase, number> = { dark: 0.3, light: 0.04 };

function surface(seeds: Seeds, textWeight: number): string {
  return mixHex(seeds.text, seeds.bg, textWeight);
}

function violetInk(seeds: Seeds): string {
  return mixHex(seeds.violet, seeds.text, 0.6);
}

function accentInk(seeds: Seeds): string {
  return mixHex(seeds.accent, seeds.text, 0.75);
}

interface DerivedRule {
  token: string;
  seeds: readonly SeedToken[];
  compute: (seeds: Seeds, base: ThemeBase) => string;
}

const DERIVED_RULES: readonly DerivedRule[] = [
  { token: "panel", seeds: ["bg"], compute: (s) => s.bg },
  { token: "editor", seeds: ["bg"], compute: (s) => surface(s, 0.02) },
  { token: "panel-head", seeds: ["bg"], compute: (s) => surface(s, 0.03) },
  { token: "bg-deep", seeds: ["bg"], compute: (s) => surface(s, 0.01) },
  { token: "sunken", seeds: ["bg"], compute: (s) => surface(s, 0.01) },
  { token: "tool", seeds: ["bg"], compute: (s) => surface(s, 0.025) },
  { token: "overlay", seeds: ["bg"], compute: (s) => surface(s, 0.07) },
  { token: "user-msg", seeds: ["bg"], compute: (s) => mixHex(s.violet, surface(s, 0.05), 0.08) },
  { token: "hover", seeds: ["bg"], compute: (s) => surface(s, 0.04) },
  { token: "raised", seeds: ["bg"], compute: (s) => surface(s, 0.08) },
  { token: "terminal-bg", seeds: ["bg"], compute: (s) => surface(s, 0.03) },
  { token: "menu-surface", seeds: ["bg"], compute: (s) => surface(s, 0.07) },
  { token: "tooltip-bg", seeds: ["bg"], compute: (s) => surface(s, 0.1) },
  { token: "table-row-hover", seeds: ["bg"], compute: (s) => surface(s, 0.06) },
  { token: "bar-row-hover", seeds: ["bg"], compute: (s) => surface(s, 0.08) },
  { token: "modal-bar", seeds: ["bg"], compute: (s) => surface(s, 0.08) },
  { token: "control-bg", seeds: ["bg"], compute: (s) => surface(s, 0.08) },
  { token: "control-bg-hover", seeds: ["bg"], compute: (s) => surface(s, 0.13) },
  { token: "row-selected", seeds: ["bg"], compute: (s) => surface(s, 0.1) },
  { token: "tag-fill", seeds: ["bg"], compute: (s) => surface(s, 0.1) },
  { token: "switch-track", seeds: ["bg"], compute: (s) => surface(s, 0.1) },
  { token: "chart-grid", seeds: ["bg"], compute: (s) => surface(s, 0.11) },
  { token: "avatar-bot", seeds: ["bg"], compute: (s) => surface(s, 0.15) },
  { token: "switch-ring", seeds: ["bg"], compute: (s) => surface(s, 0.22) },
  { token: "control-ring", seeds: ["bg"], compute: (s) => surface(s, 0.33) },
  { token: "scrim", seeds: ["bg"], compute: (s) => withAlpha(s.bg, 0.92) },
  {
    token: "surface-inset",
    seeds: ["bg"],
    compute: (s, base) => withAlpha(mixHex(s.bg, BLACK, 0.7), INSET_ALPHA[base])
  },
  { token: "border-soft", seeds: ["border"], compute: (s) => mixHex(s.border, s.bg, 0.6) },
  { token: "border-strong", seeds: ["border"], compute: (s) => mixHex(s.text, s.border, 0.15) },
  { token: "line", seeds: ["border"], compute: (s) => mixHex(s.border, s.bg, 0.7) },
  { token: "dim", seeds: ["text", "muted"], compute: (s) => mixHex(s.text, s.muted, 0.5) },
  { token: "faint", seeds: ["muted", "bg"], compute: (s) => mixHex(s.muted, s.bg, 0.75) },
  {
    token: "md-strong",
    seeds: ["text"],
    compute: (s, base) => mixHex(s.text, base === "dark" ? WHITE : BLACK, 0.5)
  },
  { token: "control-ink", seeds: ["muted"], compute: (s) => mixHex(s.muted, s.bg, 0.9) },
  { token: "terminal-fg", seeds: ["text"], compute: (s) => mixHex(s.text, s.bg, 0.85) },
  { token: "ring", seeds: ["text"], compute: (s) => s.text },
  { token: "hair", seeds: ["text"], compute: (s) => withAlpha(s.text, 0.05) },
  { token: "chip-fill", seeds: ["text"], compute: (s) => withAlpha(s.text, 0.045) },
  { token: "chip-fill-hover", seeds: ["text"], compute: (s) => withAlpha(s.text, 0.075) },
  { token: "scrollbar-thumb", seeds: ["text"], compute: (s) => withAlpha(s.text, 0.12) },
  { token: "scrollbar-thumb-hover", seeds: ["text"], compute: (s) => withAlpha(s.text, 0.18) },
  { token: "violet-strong", seeds: ["violet"], compute: (s) => mixHex(s.violet, BLACK, 0.85) },
  { token: "violet-ink", seeds: ["violet"], compute: violetInk },
  { token: "violet-soft", seeds: ["violet"], compute: (s) => withAlpha(s.violet, 0.16) },
  { token: "violet-line", seeds: ["violet"], compute: (s) => withAlpha(violetInk(s), 0.4) },
  { token: "terminal-selection", seeds: ["violet"], compute: (s) => mixHex(s.violet, s.bg, 0.3) },
  { token: "merged", seeds: ["violet"], compute: (s) => mixHex(s.violet, s.text, 0.65) },
  { token: "merged-fill", seeds: ["violet"], compute: (s) => mixHex(s.violet, s.text, 0.85) },
  { token: "codex", seeds: ["violet"], compute: (s) => mixHex(s.violet, s.text, 0.65) },
  { token: "accent-ink", seeds: ["accent"], compute: accentInk },
  { token: "accent-fill", seeds: ["accent"], compute: (s) => mixHex(s.accent, BLACK, 0.8) },
  { token: "md-link", seeds: ["accent"], compute: accentInk },
  { token: "new-ink", seeds: ["accent"], compute: accentInk },
  { token: "diff-hunk-bg", seeds: ["accent", "bg"], compute: (s) => mixHex(s.accent, s.bg, 0.2) },
  { token: "diff-hunk-ink", seeds: ["accent"], compute: accentInk },
  { token: "success-fill", seeds: ["success"], compute: (s) => mixHex(s.success, BLACK, 0.8) },
  { token: "diff-add-bg", seeds: ["success", "bg"], compute: (s) => mixHex(s.success, s.bg, 0.2) },
  { token: "diff-add-ink", seeds: ["success"], compute: (s) => mixHex(s.success, s.text, 0.6) },
  { token: "danger-ink", seeds: ["danger"], compute: (s) => mixHex(s.danger, s.text, 0.75) },
  { token: "danger-fill", seeds: ["danger"], compute: (s) => mixHex(s.danger, BLACK, 0.8) },
  { token: "diff-del-bg", seeds: ["danger", "bg"], compute: (s) => mixHex(s.danger, s.bg, 0.2) },
  { token: "diff-del-ink", seeds: ["danger"], compute: (s) => mixHex(s.danger, s.text, 0.75) }
];

const CURATED_SEED_TOKENS = new Set<string>(CURATED_THEME_TOKENS.map((entry) => entry.token));
const COLOR_TOKEN_SET = new Set<string>(THEME_COLOR_TOKENS);

function validOverrides(colors: Record<string, string>): Map<string, string> {
  const overrides = new Map<string, string>();
  for (const [token, value] of Object.entries(colors)) {
    if (COLOR_TOKEN_SET.has(token) && isHexColor(value)) {
      overrides.set(token, value.toLowerCase());
    }
  }
  return overrides;
}

export function deriveThemeTokens(base: ThemeBase, colors: Record<string, string>): Record<string, string> {
  const palette = THEME_PALETTES[base];
  const tokens: Record<string, string> = { ...palette };
  const overrides = validOverrides(colors);
  const overriddenSeeds = new Set<string>();

  for (const [token, value] of overrides) {
    if (CURATED_SEED_TOKENS.has(token)) {
      tokens[token] = value;
      overriddenSeeds.add(token);
    }
  }

  const seeds = Object.fromEntries(
    CURATED_THEME_TOKENS.map(({ token }) => [token, tokens[token]])
  ) as Seeds;

  for (const rule of DERIVED_RULES) {
    if (rule.seeds.some((seed) => overriddenSeeds.has(seed))) {
      tokens[rule.token] = rule.compute(seeds, base);
    }
  }

  for (const [token, value] of overrides) {
    if (!CURATED_SEED_TOKENS.has(token)) {
      tokens[token] = value;
    }
  }

  return tokens;
}

export interface ActiveTheme {
  base: ThemeBase;
  tokens: Record<string, string> | null;
}

export function resolveActiveTheme(
  themeId: string,
  customThemes: readonly CustomTheme[],
  systemPrefersLight: boolean
): ActiveTheme {
  if (themeId === "dark" || themeId === "light") {
    return { base: themeId, tokens: null };
  }
  if (themeId === "system") {
    return { base: systemPrefersLight ? "light" : "dark", tokens: null };
  }
  const custom = customThemes.find((theme) => theme.id === themeId);
  if (custom) {
    return { base: custom.base, tokens: deriveThemeTokens(custom.base, custom.colors) };
  }
  return { base: "dark", tokens: null };
}

export function windowBackgroundColor(
  themeId: string,
  customThemes: readonly CustomTheme[],
  systemPrefersLight: boolean
): string {
  const { base, tokens } = resolveActiveTheme(themeId, customThemes, systemPrefersLight);
  return tokens?.gutter ?? THEME_PALETTES[base].gutter;
}
