import { sanitizedChildEnv } from "../../shellEnvironment.js";

/** Entrypoint the Claude CLI reports for processes cw-code spawns headlessly. */
export const CLAUDE_ENTRYPOINT = "cw-code";

/**
 * Env for a headless Claude CLI process cw-code starts. Always sets `CLAUDE_CODE_ENTRYPOINT`, so the CLI
 * reports cw-code instead of `sdk-cli` or a value inherited from a parent Claude Code session.
 */
export function claudeChildEnv(env: NodeJS.ProcessEnv, platform: NodeJS.Platform): NodeJS.ProcessEnv {
  return { ...sanitizedChildEnv(env, platform), CLAUDE_CODE_ENTRYPOINT: CLAUDE_ENTRYPOINT };
}
