export interface Project {
  id: string;
  rootPath: string;
  name: string;
}

export type DriverName = "claude" | "opencode" | "codex";

export interface Session {
  id: string;
  projectId: string;
  driver: DriverName;
  title: string;
  resumeCursor: string;
  createdAt: number;
  updatedAt: number;
}

export interface HistoryMessage {
  id: string;
  role: "user" | "assistant" | "tool" | "system";
  text: string;
  turnId: string;
  toolName?: string;
  isError?: boolean;
  timestamp?: number;
  subagentModel?: string;
  subagentTools?: SubagentToolSummary;
  parentToolCallId?: string;
}

export interface SubagentToolActivity {
  id: string;
  name: string;
  input: unknown;
  timestamp?: number;
  completedAt?: number;
  output?: string;
  isError?: boolean;
}

export interface SubagentToolSummary {
  total: number;
  items: SubagentToolActivity[];
  effort?: string;
  totalTokens?: number;
}

export type ApprovalDecision = "accept" | "acceptForSession" | "decline" | "cancel";

export type ApprovalKind = "command" | "fileChange" | "permissions";

export interface ApprovalRequest {
  requestId: string;
  kind: ApprovalKind;
  title: string;
  reason?: string;
  details?: string;
  decisions: ApprovalDecision[];
}

export interface QuestionOption {
  label: string;
  description?: string;
}

export interface QuestionInfo {
  question: string;
  header?: string;
  options: QuestionOption[];
  multiSelect: boolean;
  allowCustom: boolean;
}

export interface QuestionRequest {
  requestId: string;
  turnId: string;
  questions: QuestionInfo[];
}

export type TurnEvent =
  | { type: "assistant.delta"; turnId: string; text: string }
  | {
      type: "tool.call";
      turnId: string;
      toolCallId: string;
      name: string;
      input: unknown;
      parentToolCallId?: string;
    }
  | { type: "tool.result"; turnId: string; toolCallId: string; output: string; isError: boolean }
  | { type: "approval.request"; turnId: string; request: ApprovalRequest }
  | { type: "approval.resolved"; turnId: string; requestId: string }
  | { type: "question.request"; turnId: string; request: QuestionRequest }
  | {
      type: "question.resolved";
      turnId: string;
      requestId: string;
      answers: Record<string, string> | null;
    }
  | {
      type: "turn.done";
      turnId: string;
      sessionId: string;
      resumeCursor: string;
      resultText: string;
      inputTokens: number;
      outputTokens: number;
      costUsd: number;
      numTurns: number;
      isError: boolean;
    }
  | { type: "turn.error"; turnId: string; message: string };

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

export interface CustomModel {
  id: string;
  name: string;
}

export interface AppSettings {
  claudeBinaryPath: string;
  opencodeBinaryPath: string;
  codexBinaryPath: string;
  claudeExtraArgs: string;
  opencodeExtraArgs: string;
  codexExtraArgs: string;
  claudeDefaultModel: string;
  claudeEnabledModels: string[];
  claudeCustomModel: CustomModel;
}

export type SettingsPatch = Partial<AppSettings>;

export interface CwApi {
  checkVersions(): Promise<Array<{
    binary: DriverName;
    binaryPath: string;
    minimum: string;
    actual: string | null;
    available: boolean;
    error: string | null;
    ok: boolean;
  }>>;
  isDev: boolean;
  openHarnessTrace(): Promise<{ ok: boolean; path?: string; error?: string }>;
  listProjects(): Promise<Project[]>;
  addProject(rootPath: string): Promise<Project>;
  listSessions(projectId: string): Promise<Session[]>;
  listDiscovered(projectId: string): Promise<Session[]>;
  importSession(projectId: string, driver: DriverName, resumeCursor: string, title: string): Promise<Session>;
  createSession(projectId: string, driver: DriverName): Promise<Session>;
  renameSession(sessionId: string, title: string): Promise<void>;
  getHistory(sessionId: string): Promise<HistoryMessage[]>;
  startTurn(sessionId: string, prompt: string, opts?: { prefs?: ComposerPrefs; attachments?: string[] }): Promise<string>;
  interrupt(turnId: string): Promise<void>;
  respondApproval(requestId: string, decision: ApprovalDecision): Promise<void>;
  respondQuestion(requestId: string, answers: Record<string, string>): Promise<void>;
  listModels(sessionId: string): Promise<ModelOption[]>;
  listModelsFor(projectId: string, driver: DriverName): Promise<ModelOption[]>;
  getComposer(sessionId: string): Promise<ComposerPrefs>;
  setComposer(sessionId: string, prefs: ComposerPrefs): Promise<ComposerPrefs>;
  getSettings(): Promise<AppSettings>;
  setSettings(patch: SettingsPatch): Promise<AppSettings>;
  getGitStatus(sessionId: string): Promise<GitStatus>;
  onTurnEvent(cb: (msg: { sessionId: string; event: TurnEvent }) => void): () => void;
  readFile(sessionId: string, path: string): Promise<string>;
  readOutsideFile(path: string): Promise<string>;
  saveFile(sessionId: string, path: string, content: string): Promise<void>;
  listFiles(sessionId: string): Promise<string[]>;
  listProjectFiles(projectId: string): Promise<string[]>;
  savePasteImage(projectId: string, mime: string, data: Uint8Array): Promise<string>;
  turnDiff(sessionId: string, since: number): Promise<string>;
  openPty(sessionId: string, kind: DriverName | "shell"): Promise<string>;
  writePty(ptyId: string, data: string): void;
  resizePty(ptyId: string, cols: number, rows: number): void;
  killPty(ptyId: string): void;
  onPtyData(cb: (msg: { ptyId: string; data: string }) => void): () => void;
  minimizeWindow(): void;
  toggleMaximizeWindow(): void;
  closeWindow(): void;
  isWindowMaximized(): Promise<boolean>;
  onWindowMaximized(cb: (maximized: boolean) => void): () => void;
  zoomIn(): void;
  zoomOut(): void;
  zoomReset(): void;
  getTerminalFont(): Promise<string | null>;
  pickProjectDir(): Promise<string | null>;
  openPath(path: string): Promise<void>;
  openHtml(name: string, html: string): Promise<void>;
}

declare global {
  interface Window {
    cw: CwApi;
  }
}
