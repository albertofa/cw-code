import type { DriverKind, Project, SessionMeta } from "./session.js";

/** A session recorded by a harness CLI, independent of cw-code metadata. */
export interface NativeSession {
  driver: DriverKind;
  resumeCursor: string;
  title: string;
  cwd: string;
  createdAt: number;
  updatedAt: number;
  gitBranch?: string;
  gitRemote?: string;
  /** The harness records cw-code as the session's originator. */
  createdByCwCode?: boolean;
}

export interface ImportableSession extends NativeSession {
  /** Existing project that receives the session, at `projectRoot`. */
  projectId?: string;
  projectName: string;
  /** Folder whose project receives the session; the main checkout when `cwd` is a linked worktree. */
  projectRoot: string;
  /** `owner/name` of the folder's Git remote, when known. */
  repository?: string;
}

export interface ImportSessionRequest {
  driver: DriverKind;
  resumeCursor: string;
}

export interface ImportSessionResult {
  project: Project;
  session: SessionMeta;
}
