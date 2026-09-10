export type DriverKind = "claude" | "opencode" | "codex";

export interface Project {
  id: string;
  rootPath: string;
  name: string;
}

export interface SessionMeta {
  id: string;
  projectId: string;
  driver: DriverKind;
  title: string;
  resumeCursor: string;
  createdAt: number;
  updatedAt: number;
  model?: string;
  effort?: EffortLevel;
  variant?: string;
  permissionMode?: PermissionMode;
}

export interface TurnRequest {
  sessionId: string;
  cwd: string;
  prompt: string;
  resumeCursor?: string;
  model?: string;
  effort?: EffortLevel;
  variant?: string;
  permissionMode?: PermissionMode;
  attachments?: string[];
  allowedTools?: string[];
  maxTurns?: number;
}

export type PermissionMode = "auto" | "acceptEdits" | "bypassPermissions" | "manual" | "plan";

export type EffortLevel = "low" | "medium" | "high" | "xhigh" | "max";

export interface ComposerPrefs {
  model?: string;
  effort?: EffortLevel;
  variant?: string;
  permissionMode?: PermissionMode;
}

export interface ModelOption {
  id: string;
  label: string;
  source: "live" | "curated" | "custom";
}

export interface GitStatus {
  branch: string;
  dirtyCount: number;
  worktreeName: string;
  prNumber: number | null;
  clean: boolean;
}
