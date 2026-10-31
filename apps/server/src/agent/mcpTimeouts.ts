import { WAIT_MAX_MS } from "../mcp/cwTools.js";

const BUN_MAX_IDLE_TIMEOUT_SECONDS = 255;
export const MCP_IDLE_TIMEOUT_SECONDS = Math.min(BUN_MAX_IDLE_TIMEOUT_SECONDS, Math.ceil(WAIT_MAX_MS / 1000) + 15);
