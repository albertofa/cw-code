import type { GitStatus } from "@cw-code/contracts";

export interface GitStatusUpdate {
  sessionId: string;
  status: GitStatus;
}
