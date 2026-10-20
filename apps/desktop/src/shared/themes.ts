import type { CustomTheme, ThemeBase } from "@cw-code/contracts";

export const BUILTIN_THEME_IDS = ["dark", "light", "system"] as const;
export const MAX_CUSTOM_THEMES = 50;
export const THEME_NAME_MAX_LENGTH = 60;
export const UNTITLED_THEME_NAME = "Untitled theme";

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
  "on-accent": "#ffffff",
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
  "shadow-pill": "0 6px 18px -6px rgba(0, 0, 0, 0.6)",
  "project-gray": "#99a1af",
  "project-red": "#ff6467",
  "project-orange": "#ff8904",
  "project-amber": "#ffb900",
  "project-yellow": "#fdc700",
  "project-lime": "#9ae600",
  "project-green": "#05df72",
  "project-emerald": "#00d492",
  "project-teal": "#00d5be",
  "project-cyan": "#00d3f2",
  "project-sky": "#00bcff",
  "project-blue": "#51a2ff",
  "project-indigo": "#7c86ff",
  "project-violet": "#a684ff",
  "project-purple": "#c27aff",
  "project-fuchsia": "#ed6aff",
  "project-pink": "#fb64b6",
  "project-rose": "#ff637e"
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
  muted: "#4c5160",
  faint: "#5b606f",
  claude: "#b95835",
  "claude-soft": "rgba(200, 96, 58, 0.12)",
  opencode: "#115f9e",
  "opencode-soft": "rgba(26, 127, 208, 0.12)",
  codex: "#6c53bd",
  "codex-soft": "rgba(123, 95, 214, 0.12)",
  violet: "#6146d6",
  "violet-strong": "#5136c4",
  "violet-ink": "#583dcb",
  "violet-soft": "rgba(97, 70, 214, 0.12)",
  "violet-line": "rgba(97, 70, 214, 0.35)",
  success: "#226d2e",
  warning: "#7c4f00",
  "on-success": "#ffffff",
  "on-warning": "#ffffff",
  danger: "#a52c22",
  accent: "#255abc",
  "accent-ink": "#2050b3",
  "danger-ink": "#a7291f",
  "accent-fill": "#2a64cf",
  "danger-fill": "#c8372b",
  "success-fill": "#277a35",
  "neutral-fill": "#6b7080",
  "draft-fill": "#6b7080",
  "merged-fill": "#7b5fd6",
  "surface-inset": "rgba(16, 20, 32, 0.04)",
  update: "#08657a",
  babysit: "#4c6f0c",
  "on-babysit": "#ffffff",
  merged: "#6c53bd",
  "on-accent": "#ffffff",
  skill: "#b04ec8",
  "chip-fill": "rgba(16, 20, 32, 0.04)",
  "chip-fill-hover": "rgba(16, 20, 32, 0.07)",
  "shadow-float": "0 16px 40px rgba(20, 24, 40, 0.14)",
  "md-link": "#2050b3",
  "md-strong": "#0f1219",
  driver: "#6b6f7b",
  "driver-soft": "rgba(107, 111, 123, 0.12)",
  "scrollbar-thumb": "rgba(16, 20, 32, 0.14)",
  "scrollbar-thumb-hover": "rgba(16, 20, 32, 0.22)",
  "terminal-bg": "#ffffff",
  "terminal-fg": "#1a1d26",
  "terminal-selection": "#d9d3f7",
  "win-close": "#e81123",
  "preview-canvas": "#ffffff",
  "on-avatar": "#fdfcfc",
  ring: "#1a1d26",
  "control-ink": "#6b7080",
  "control-bg": "#eceef3",
  "control-bg-hover": "#e3e6ec",
  "control-ring": "#8a8f9c",
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
  "new-ink": "#2050b3",
  "diff-add-bg": "#e3f3e5",
  "diff-add-ink": "#1f6b2a",
  "diff-del-bg": "#fbe6e3",
  "diff-del-ink": "#a3271d",
  "diff-hunk-bg": "#e6edfb",
  "diff-hunk-ink": "#2050b3",
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
  "shadow-pill": "0 6px 18px -6px rgba(20, 24, 40, 0.2)",
  "project-gray": "#364153",
  "project-red": "#9f0712",
  "project-orange": "#9f2d00",
  "project-amber": "#973c00",
  "project-yellow": "#864900",
  "project-lime": "#3d6300",
  "project-green": "#016630",
  "project-emerald": "#006045",
  "project-teal": "#005f5a",
  "project-cyan": "#005f78",
  "project-sky": "#00598a",
  "project-blue": "#193cb8",
  "project-indigo": "#432dd7",
  "project-violet": "#5d0ec0",
  "project-purple": "#6e11b0",
  "project-fuchsia": "#8a0194",
  "project-pink": "#a3004c",
  "project-rose": "#a50036"
};

export const THEME_PALETTES: Record<ThemeBase, Record<string, string>> = {
  dark: DARK_PALETTE,
  light: LIGHT_PALETTE
};

export function isHexColor(value: unknown): value is string {
  return typeof value === "string" && HEX_COLOR.test(value);
}

export const PROJECT_HUES = [
  "gray",
  "red",
  "orange",
  "amber",
  "yellow",
  "lime",
  "green",
  "emerald",
  "teal",
  "cyan",
  "sky",
  "blue",
  "indigo",
  "violet",
  "purple",
  "fuchsia",
  "pink",
  "rose"
] as const;

const NON_THEME_COLOR_TOKENS = new Set(["win-close", "preview-canvas", "on-avatar", ...PROJECT_HUES.map((hue) => `project-${hue}`)]);

export const THEME_COLOR_TOKENS: readonly string[] = Object.keys(DARK_PALETTE).filter(
  (token) =>
    !NON_THEME_COLOR_TOKENS.has(token) && isHexColor(DARK_PALETTE[token]) && isHexColor(LIGHT_PALETTE[token])
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

function surface(seeds: Seeds, textWeight: number): string {
  return mixHex(seeds.text, seeds.bg, textWeight);
}

function violetInk(seeds: Seeds): string {
  return mixHex(seeds.violet, seeds.text, 0.6);
}

function accentInk(seeds: Seeds): string {
  return mixHex(seeds.accent, seeds.text, 0.75);
}

function violetBlend(seeds: Seeds): string {
  return mixHex(seeds.violet, seeds.text, 0.65);
}

type DeriveColor = (seeds: Seeds, base: ThemeBase) => string;

const DERIVED_RULES: Readonly<Record<string, DeriveColor>> = {
  panel: (s) => s.bg,
  editor: (s) => surface(s, 0.02),
  "panel-head": (s) => surface(s, 0.03),
  "bg-deep": (s) => surface(s, 0.01),
  tool: (s) => surface(s, 0.025),
  overlay: (s) => surface(s, 0.07),
  "user-msg": (s) => mixHex(s.violet, surface(s, 0.05), 0.08),
  hover: (s) => surface(s, 0.04),
  raised: (s) => surface(s, 0.08),
  "terminal-bg": (s) => surface(s, 0.03),
  "menu-surface": (s) => surface(s, 0.07),
  "tooltip-bg": (s) => surface(s, 0.1),
  "table-row-hover": (s) => surface(s, 0.06),
  "bar-row-hover": (s) => surface(s, 0.08),
  "modal-bar": (s) => surface(s, 0.08),
  "control-bg": (s) => surface(s, 0.08),
  "control-bg-hover": (s) => surface(s, 0.13),
  "row-selected": (s) => surface(s, 0.1),
  "tag-fill": (s) => surface(s, 0.1),
  "switch-track": (s) => surface(s, 0.1),
  "chart-grid": (s) => surface(s, 0.11),
  "avatar-bot": (s) => surface(s, 0.15),
  "switch-ring": (s) => surface(s, 0.22),
  "control-ring": (s) => surface(s, 0.33),
  scrim: (s) => s.bg,
  "surface-inset": (s) => mixHex(s.bg, BLACK, 0.7),
  "border-soft": (s) => mixHex(s.border, s.bg, 0.6),
  "border-strong": (s) => mixHex(s.text, s.border, 0.15),
  line: (s) => mixHex(s.border, s.bg, 0.7),
  dim: (s) => mixHex(s.text, s.muted, 0.5),
  faint: (s) => mixHex(s.muted, s.bg, 0.75),
  "md-strong": (s, base) => mixHex(s.text, base === "dark" ? WHITE : BLACK, 0.5),
  "control-ink": (s) => mixHex(s.muted, s.bg, 0.9),
  "terminal-fg": (s) => mixHex(s.text, s.bg, 0.85),
  ring: (s) => s.text,
  hair: (s) => s.text,
  "chip-fill": (s) => s.text,
  "chip-fill-hover": (s) => s.text,
  "scrollbar-thumb": (s) => s.text,
  "scrollbar-thumb-hover": (s) => s.text,
  "violet-strong": (s) => mixHex(s.violet, BLACK, 0.85),
  "violet-ink": violetInk,
  "violet-soft": (s) => s.violet,
  "violet-line": violetInk,
  "terminal-selection": (s) => mixHex(s.violet, s.bg, 0.3),
  merged: violetBlend,
  "merged-fill": (s) => mixHex(s.violet, s.text, 0.85),
  codex: violetBlend,
  "codex-soft": violetBlend,
  "accent-ink": accentInk,
  "accent-fill": (s) => mixHex(s.accent, BLACK, 0.8),
  "md-link": accentInk,
  "new-ink": accentInk,
  "diff-hunk-bg": (s) => mixHex(s.accent, s.bg, 0.2),
  "diff-hunk-ink": accentInk,
  "success-fill": (s) => mixHex(s.success, BLACK, 0.8),
  "diff-add-bg": (s) => mixHex(s.success, s.bg, 0.2),
  "diff-add-ink": (s) => mixHex(s.success, s.text, 0.6),
  "danger-ink": (s) => mixHex(s.danger, s.text, 0.75),
  "danger-fill": (s) => mixHex(s.danger, BLACK, 0.8),
  "diff-del-bg": (s) => mixHex(s.danger, s.bg, 0.2),
  "diff-del-ink": (s) => mixHex(s.danger, s.text, 0.75),
  "composer-card": (s) => s.card
};

const RGBA_COLOR = /^rgba\((\d{1,3}), (\d{1,3}), (\d{1,3}), ([\d.]+)\)$/;

interface PaletteColor {
  rgb: readonly number[];
  alpha: string | null;
}

function parsePaletteColor(value: string): PaletteColor {
  if (isHexColor(value)) {
    return { rgb: channels(value), alpha: null };
  }
  const match = RGBA_COLOR.exec(value);
  if (!match) {
    throw new RangeError(`Unsupported palette color: ${value}`);
  }
  return { rgb: [Number(match[1]), Number(match[2]), Number(match[3])], alpha: match[4] };
}

function formatPaletteColor({ rgb, alpha }: PaletteColor): string {
  return alpha === null ? `#${rgb.map(channelHex).join("")}` : `rgba(${rgb.join(", ")}, ${alpha})`;
}

function clampChannel(value: number): number {
  return Math.min(255, Math.max(0, value));
}

function shiftColor(baseValue: string, from: string, to: string): string {
  const baseColor = parsePaletteColor(baseValue);
  const start = channels(from);
  const end = channels(to);
  const rgb = baseColor.rgb.map((channel, index) => clampChannel(channel + end[index] - start[index]));
  return formatPaletteColor({ rgb, alpha: baseColor.alpha });
}

function seedsOf(tokens: Record<string, string>): Seeds {
  return Object.fromEntries(CURATED_THEME_TOKENS.map(({ token }) => [token, tokens[token]])) as Seeds;
}

const BASE_SEEDS: Record<ThemeBase, Seeds> = {
  dark: seedsOf(DARK_PALETTE),
  light: seedsOf(LIGHT_PALETTE)
};

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

  for (const [token, value] of overrides) {
    if (CURATED_SEED_TOKENS.has(token)) {
      tokens[token] = value;
    }
  }

  const seeds = seedsOf(tokens);
  for (const [token, derive] of Object.entries(DERIVED_RULES)) {
    tokens[token] = shiftColor(palette[token], derive(BASE_SEEDS[base], base), derive(seeds, base));
  }

  for (const [token, value] of overrides) {
    if (!CURATED_SEED_TOKENS.has(token)) {
      tokens[token] = value;
    }
  }

  return tokens;
}

export const BUNDLED_THEMES: readonly CustomTheme[] = [
  {
    id: "claude",
    name: "Claude",
    base: "light",
    colors: {
      gutter: "#e8e6dc",
      line: "#e3e0d5",
      editor: "#ffffff",
      "panel-head": "#f5f4ed",
      bg: "#faf9f5",
      tool: "#f5f4ed",
      "bg-deep": "#f0eee6",
      card: "#ffffff",
      overlay: "#ffffff",
      "user-msg": "#f0eee6",
      hover: "#efede4",
      raised: "#e9e6db",
      border: "#ddd9ce",
      "border-soft": "#e8e5da",
      "border-strong": "#c4c0b3",
      text: "#141413",
      dim: "#3d3d3a",
      muted: "#545350",
      faint: "#5f5e59",
      claude: "#b75632",
      opencode: "#1a5e9c",
      codex: "#6f4fc9",
      violet: "#a34d30",
      "violet-strong": "#8c4229",
      "violet-ink": "#904528",
      success: "#286b2b",
      warning: "#7f5000",
      danger: "#a43125",
      accent: "#1f5ecf",
      "accent-ink": "#2153ab",
      "danger-ink": "#a8281c",
      "accent-fill": "#3168ce",
      "danger-fill": "#c0392b",
      "success-fill": "#357e39",
      "neutral-fill": "#706f69",
      "draft-fill": "#706f69",
      "merged-fill": "#7a63c4",
      update: "#12697a",
      babysit: "#547a0d",
      merged: "#6f4fc9",
      skill: "#9a3fb0",
      "md-link": "#2153ab",
      "md-strong": "#141413",
      driver: "#6f6e68",
      "terminal-bg": "#faf9f5",
      "terminal-fg": "#141413",
      "terminal-selection": "#f0d3c6",
      "control-ink": "#7b7a73",
      "control-bg": "#efede4",
      "control-bg-hover": "#e6e3d8",
      "control-ring": "#a9a597",
      "switch-track": "#e3e0d5",
      "switch-ring": "#b8b4a6",
      "menu-surface": "#ffffff",
      "tooltip-bg": "#ffffff",
      "modal-bar": "#f0eee6",
      "row-selected": "#efede4",
      "table-row-hover": "#f0eee6",
      "bar-row-hover": "#f0eee6",
      "tag-fill": "#e9e7de",
      "chart-grid": "#e0ddd2",
      "avatar-bot": "#dcd9ce",
      "new-ink": "#2153ab",
      "diff-add-bg": "#e3f1e1",
      "diff-add-ink": "#1f6b2a",
      "diff-del-bg": "#fbe3e0",
      "diff-del-ink": "#a43125",
      "diff-hunk-bg": "#e4ecf8",
      "diff-hunk-ink": "#2153ab"
    }
  }
];

export function bundledTheme(themeId: string): CustomTheme | undefined {
  return BUNDLED_THEMES.find((theme) => theme.id === themeId);
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
  const custom = bundledTheme(themeId) ?? customThemes.find((theme) => theme.id === themeId);
  if (custom) {
    const base: ThemeBase = custom.base === "light" ? "light" : "dark";
    return { base, tokens: deriveThemeTokens(base, custom.colors) };
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
