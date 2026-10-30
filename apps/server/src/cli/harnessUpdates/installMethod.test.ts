import { describe, expect, it } from "bun:test";
import type { DriverKind } from "@cw-code/contracts";
import { resolveInstallPlan } from "./installMethod.js";
import type { InstallPlanInput } from "./installMethod.js";

const PACKAGES: Record<DriverKind, string> = {
  claude: "@anthropic-ai/claude-code",
  codex: "@openai/codex",
  opencode: "opencode-ai"
};

function win(binary: DriverKind, execPath: string, overrides: Partial<InstallPlanInput> = {}): InstallPlanInput {
  return {
    binary,
    execPath,
    realPath: execPath,
    platform: "win32",
    homeDir: "C:\\Users\\Alberto",
    env: { LOCALAPPDATA: "C:\\Users\\Alberto\\AppData\\Local" },
    packageName: PACKAGES[binary],
    exists: () => false,
    ...overrides
  };
}

function posix(binary: DriverKind, execPath: string, overrides: Partial<InstallPlanInput> = {}): InstallPlanInput {
  return {
    binary,
    execPath,
    realPath: execPath,
    platform: "linux",
    homeDir: "/home/dev",
    env: {},
    packageName: PACKAGES[binary],
    exists: () => false,
    ...overrides
  };
}

describe("resolveInstallPlan winget and mise", () => {
  it("marks WinGet links and packages as manual", () => {
    const links = resolveInstallPlan(win("codex", "C:\\Users\\Alberto\\AppData\\Local\\Microsoft\\WinGet\\Links\\codex.exe"));
    expect(links).toEqual({ method: "winget", command: null, display: "winget upgrade OpenAI.Codex", lockKey: null });
    const packages = resolveInstallPlan(
      win("opencode", "C:\\Users\\Alberto\\AppData\\Local\\Microsoft\\WinGet\\Packages\\SST.opencode_x\\opencode.exe")
    );
    expect(packages.display).toBe("winget upgrade SST.opencode");
    const claude = resolveInstallPlan(win("claude", "C:\\Users\\a\\WinGet\\Packages\\Anthropic.ClaudeCode\\claude.exe"));
    expect(claude.display).toBe("winget upgrade Anthropic.ClaudeCode");
  });

  it("marks mise installs and shims as manual", () => {
    const install = resolveInstallPlan(
      posix("codex", "/home/dev/.local/share/mise/installs/node/22.1.0/bin/codex")
    );
    expect(install).toEqual({ method: "mise", command: null, display: "mise upgrade", lockKey: null });
    expect(resolveInstallPlan(posix("claude", "/home/dev/.local/share/mise/shims/claude")).method).toBe("mise");
  });
});

describe("resolveInstallPlan native", () => {
  it("detects claude native on Windows and runs its own updater", () => {
    const plan = resolveInstallPlan(win("claude", "C:\\Users\\Alberto\\.local\\bin\\claude.exe"));
    expect(plan).toEqual({
      method: "native",
      command: { file: "C:\\Users\\Alberto\\.local\\bin\\claude.exe", args: ["update"] },
      display: "C:\\Users\\Alberto\\.local\\bin\\claude.exe update",
      lockKey: "claude-native"
    });
  });

  it("detects claude native on posix, including the versioned symlink target", () => {
    const plan = resolveInstallPlan(
      posix("claude", "/home/dev/.local/bin/claude", { realPath: "/home/dev/.local/share/claude/versions/2.1.3" })
    );
    expect(plan.method).toBe("native");
    expect(plan.command).toEqual({ file: "/home/dev/.local/bin/claude", args: ["update"] });
  });

  it("detects opencode native and uses upgrade", () => {
    const plan = resolveInstallPlan(posix("opencode", "/home/dev/.opencode/bin/opencode"));
    expect(plan.command).toEqual({ file: "/home/dev/.opencode/bin/opencode", args: ["upgrade"] });
    expect(plan.lockKey).toBe("opencode-native");
  });

  it("detects codex standalone", () => {
    const plan = resolveInstallPlan(posix("codex", "/home/dev/.codex/packages/standalone/releases/1/bin/codex"));
    expect(plan.method).toBe("native");
    expect(plan.lockKey).toBe("codex-native");
  });

  it("quotes a file path with spaces in the display", () => {
    const spaced = resolveInstallPlan(
      win("claude", "C:\\Users\\Al B\\.local\\bin\\claude.exe", { homeDir: "C:\\Users\\Al B" })
    );
    expect(spaced.display).toBe('"C:\\Users\\Al B\\.local\\bin\\claude.exe" update');
  });

  it("does not treat another claude in ~/.local/bin subfolders as native", () => {
    const plan = resolveInstallPlan(posix("claude", "/home/dev/.local/bin/other/claude"));
    expect(plan.method).toBe("unknown");
  });
});

describe("resolveInstallPlan bun", () => {
  it("detects the bun global bin and install dir", () => {
    const bin = resolveInstallPlan(posix("codex", "/home/dev/.bun/bin/codex"));
    expect(bin).toEqual({
      method: "bun",
      command: { file: "bun", args: ["add", "-g", "@openai/codex@latest"] },
      display: "bun add -g @openai/codex@latest",
      lockKey: "bun-global"
    });
    const dir = resolveInstallPlan(
      posix("claude", "/x/claude", { realPath: "/home/dev/.bun/install/global/node_modules/@anthropic-ai/claude-code/cli.js" })
    );
    expect(dir.method).toBe("bun");
  });
});

describe("resolveInstallPlan pnpm", () => {
  it("matches both pnpm and pnpm\\bin under LOCALAPPDATA on Windows", () => {
    const direct = resolveInstallPlan(win("opencode", "C:\\Users\\Alberto\\AppData\\Local\\pnpm\\opencode.cmd"));
    expect(direct.method).toBe("pnpm");
    const bin = resolveInstallPlan(
      win("opencode", "C:\\Users\\Alberto\\AppData\\Local\\pnpm\\bin\\opencode", { packageName: "@opencode/cli" })
    );
    expect(bin).toEqual({
      method: "pnpm",
      command: { file: "pnpm", args: ["add", "-g", "@opencode/cli@latest"] },
      display: "pnpm add -g @opencode/cli@latest",
      lockKey: "pnpm-global"
    });
  });

  it("falls back to the home AppData path when LOCALAPPDATA is missing", () => {
    const plan = resolveInstallPlan(win("codex", "c:\\users\\alberto\\appdata\\local\\pnpm\\codex.cmd", { env: {} }));
    expect(plan.method).toBe("pnpm");
  });

  it("matches posix and macOS pnpm homes and PNPM_HOME", () => {
    expect(resolveInstallPlan(posix("codex", "/home/dev/.local/share/pnpm/codex")).method).toBe("pnpm");
    expect(
      resolveInstallPlan(posix("codex", "/Users/dev/Library/pnpm/codex", { homeDir: "/Users/dev", platform: "darwin" })).method
    ).toBe("pnpm");
    expect(resolveInstallPlan(posix("codex", "/opt/pn/codex", { env: { PNPM_HOME: "/opt/pn" } })).method).toBe("pnpm");
  });

  it("matches a realPath under .pnpm inside a pnpm home", () => {
    const plan = resolveInstallPlan(
      posix("claude", "/usr/bin/claude", {
        realPath: "/home/dev/.local/share/pnpm/global/5/.pnpm/@anthropic-ai+claude-code@2.1.3/node_modules/@anthropic-ai/claude-code/cli.js"
      })
    );
    expect(plan.method).toBe("pnpm");
  });
});

describe("resolveInstallPlan npm", () => {
  it("detects the nvm4w layout for codex.cmd via the package manifest", () => {
    const manifest = "C:\\nvm4w\\nodejs\\node_modules\\@openai\\codex\\package.json";
    const plan = resolveInstallPlan(win("codex", "C:\\nvm4w\\nodejs\\codex.cmd", { exists: (path) => path === manifest }));
    expect(plan).toEqual({
      method: "npm",
      command: { file: "npm", args: ["install", "-g", "--prefix", "C:\\nvm4w\\nodejs", "@openai/codex@latest"] },
      display: "npm install -g --prefix C:\\nvm4w\\nodejs @openai/codex@latest",
      lockKey: "npm-global:c:\\nvm4w\\nodejs"
    });
  });

  it("detects the nvm4w layout for opencode v2", () => {
    const manifest = "C:\\nvm4w\\nodejs\\node_modules\\@opencode\\cli\\package.json";
    const plan = resolveInstallPlan(
      win("opencode", "C:\\nvm4w\\nodejs\\opencode.cmd", { packageName: "@opencode/cli", exists: (path) => path === manifest })
    );
    expect(plan.method).toBe("npm");
    expect(plan.command?.args).toEqual(["install", "-g", "--prefix", "C:\\nvm4w\\nodejs", "@opencode/cli@latest"]);
  });

  it("falls to unknown on Windows when the manifest is absent", () => {
    const plan = resolveInstallPlan(win("codex", "C:\\nvm4w\\nodejs\\codex.cmd"));
    expect(plan).toEqual({ method: "unknown", command: null, display: "codex update", lockKey: null });
  });

  it("derives the prefix from lib/node_modules on posix", () => {
    const plan = resolveInstallPlan(
      posix("claude", "/usr/local/bin/claude", {
        realPath: "/usr/local/lib/node_modules/@anthropic-ai/claude-code/cli.js"
      })
    );
    expect(plan).toEqual({
      method: "npm",
      command: { file: "npm", args: ["install", "-g", "--prefix", "/usr/local", "@anthropic-ai/claude-code@latest"] },
      display: "npm install -g --prefix /usr/local @anthropic-ai/claude-code@latest",
      lockKey: "npm-global:/usr/local"
    });
  });

  it("keeps the prefix case on posix and lowercases only the Windows lock key", () => {
    const plan = resolveInstallPlan(
      posix("codex", "/opt/Node/bin/codex", { realPath: "/opt/Node/lib/node_modules/@openai/codex/bin/codex.js" })
    );
    expect(plan.lockKey).toBe("npm-global:/opt/Node");
  });
});

describe("resolveInstallPlan homebrew", () => {
  it("upgrades a formula from the Cellar", () => {
    const plan = resolveInstallPlan(
      posix("codex", "/opt/homebrew/bin/codex", { realPath: "/opt/homebrew/Cellar/codex/0.153.4/bin/codex", platform: "darwin" })
    );
    expect(plan).toEqual({
      method: "homebrew",
      command: { file: "brew", args: ["upgrade", "codex"] },
      display: "brew upgrade codex",
      lockKey: "homebrew"
    });
  });

  it("upgrades a cask from the Caskroom", () => {
    const plan = resolveInstallPlan(
      posix("claude", "/opt/homebrew/bin/claude", {
        realPath: "/opt/homebrew/Caskroom/claude-code/2.1.3/claude",
        platform: "darwin"
      })
    );
    expect(plan.command).toEqual({ file: "brew", args: ["upgrade", "--cask", "claude-code"] });
  });
});

describe("resolveInstallPlan fallbacks", () => {
  it("suggests npm for other node_modules locations without a command", () => {
    const plan = resolveInstallPlan(posix("codex", "/srv/app/node_modules/.bin/codex"));
    expect(plan).toEqual({ method: "unknown", command: null, display: "npm install -g @openai/codex@latest", lockKey: null });
  });

  it("shows the CLI's own updater otherwise", () => {
    expect(resolveInstallPlan(posix("claude", "/weird/claude")).display).toBe("claude update");
    expect(resolveInstallPlan(posix("opencode", "/weird/opencode")).display).toBe("opencode upgrade");
  });

  it("gives winget precedence over everything else", () => {
    const plan = resolveInstallPlan(
      win("claude", "C:\\Users\\Alberto\\.local\\bin\\claude.exe", {
        realPath: "C:\\Users\\Alberto\\AppData\\Local\\Microsoft\\WinGet\\Packages\\x\\claude.exe"
      })
    );
    expect(plan.method).toBe("winget");
  });
});
