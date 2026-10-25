import { assertPasteImageSize } from "@cw-code/shared/protocol";
import { filesTopic } from "@cw-code/shared/topics";
import { readFileSync, statSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";
import type { ServerApp } from "../app/ServerApp.js";
import { IMAGE_MAX_BYTES, imageExtMime, resolveFileTarget } from "../fs/FileService.js";
import { configuredGitBinary } from "../fs/GitService.js";
import { moveToTrash } from "../fs/trash.js";
import { gitBaseline, listWorkspaceFiles, searchText } from "../fs/workspaceQueries.js";
import { attachmentsDir } from "../paths/appPaths.js";
import type { Router } from "../transport/Router.js";
import { assertString, handle, parseArgs, parseList, parseOptionalNumber, parseString, parseTextSearchQuery } from "./shared.js";

const MAX_WATCHED_PATHS = 2_000;

function isInsideAttachmentsDir(target: string): boolean {
  let base = resolve(attachmentsDir());
  let abs = resolve(target);
  if (process.platform === "win32") {
    base = base.toLowerCase();
    abs = abs.toLowerCase();
  }
  const rel = relative(base, abs);
  if (rel === "" || rel === ".") return true;
  if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) return false;
  return true;
}

function readAttachmentImage(path: string): { mime: string; base64: string } {
  const ext = path.split(".").pop() ?? "";
  const mime = imageExtMime(ext);
  if (!mime) throw new Error(`not an image: ${path}`);
  let status: ReturnType<typeof statSync>;
  try {
    status = statSync(path);
  } catch {
    throw new Error(`file not found: ${path}`);
  }
  if (!status.isFile()) throw new Error(`not a file: ${path}`);
  if (status.size > IMAGE_MAX_BYTES) throw new Error(`image too large to preview: ${path}`);
  try {
    return { mime, base64: readFileSync(path).toString("base64") };
  } catch {
    throw new Error(`file not found: ${path}`);
  }
}

export function registerFileHandlers(router: Router, app: ServerApp): void {
  const services = () => app.requireServices();
  const gitBinary = (): string => configuredGitBinary(services().sessions.getSettings());
  const fsRoot = (args: Record<string, unknown>): Promise<string> =>
    services().sessions.ensureWorktree(parseString(args.sessionId, "sessionId"));

  handle<{ sessionId: string; path: string }>(router, "fs.readFile", (args) => {
    const { sessions, files } = services();
    return sessions.ensureWorktree(args.sessionId).then((root) => files.readFile(root, args.path));
  });
  handle<{ path: string }>(router, "fs.readOutsideFile", (args) => services().files.readOutsideFile(args.path));
  handle<{ sessionId: string }>(router, "fs.listFiles", (args) => {
    const { sessions, files } = services();
    return sessions.ensureWorktree(args.sessionId).then((root) => files.listFiles(root));
  });
  handle<{ projectId: string }>(router, "fs.listProjectFiles", (args) => {
    const { sessions, files } = services();
    return files.listFiles(sessions.rootForProject(args.projectId));
  });
  handle<{ sessionId: string; dir?: string }>(router, "fs.listDir", (args) => {
    const { sessions, files } = services();
    return sessions.ensureWorktree(args.sessionId).then((root) => files.listDir(root, args.dir ?? ""));
  });
  handle(router, "fs.readFileInfo", async (raw) => {
    const args = parseArgs(raw, "fs.readFileInfo");
    const path = parseString(args.path, "path");
    return services().files.readFileInfo(await fsRoot(args), path);
  });
  handle(router, "fs.writeFileGuarded", async (raw) => {
    const args = parseArgs(raw, "fs.writeFileGuarded");
    const path = parseString(args.path, "path");
    const content = parseString(args.content, "content");
    const expectedMtimeMs = parseOptionalNumber(args.expectedMtimeMs, "expectedMtimeMs");
    return services().files.writeFileGuarded(await fsRoot(args), path, content, expectedMtimeMs);
  });
  handle(router, "fs.createFile", async (raw) => {
    const args = parseArgs(raw, "fs.createFile");
    const path = parseString(args.path, "path");
    await services().files.createFile(await fsRoot(args), path);
  });
  handle(router, "fs.createDir", async (raw) => {
    const args = parseArgs(raw, "fs.createDir");
    const path = parseString(args.path, "path");
    await services().files.createDir(await fsRoot(args), path);
  });
  handle(router, "fs.renamePath", async (raw) => {
    const args = parseArgs(raw, "fs.renamePath");
    const from = parseString(args.from, "from");
    const to = parseString(args.to, "to");
    await services().files.renamePath(await fsRoot(args), from, to);
  });
  handle(router, "fs.trashPath", async (raw) => {
    const args = parseArgs(raw, "fs.trashPath");
    const path = parseString(args.path, "path");
    await moveToTrash(services().files.resolveEntry(await fsRoot(args), path));
  });
  handle(router, "fs.resolvePath", async (raw) => {
    const args = parseArgs(raw, "fs.resolvePath");
    const path = parseString(args.path, "path");
    return resolveFileTarget(await fsRoot(args), path);
  });
  handle(router, "fs.workspaceRoot", (raw) => fsRoot(parseArgs(raw, "fs.workspaceRoot")));
  handle(router, "fs.listWorkspaceFiles", async (raw) => {
    const root = await fsRoot(parseArgs(raw, "fs.listWorkspaceFiles"));
    return listWorkspaceFiles(gitBinary(), root, () => services().files.listFiles(root));
  });
  handle(router, "fs.gitBaseline", async (raw) => {
    const args = parseArgs(raw, "fs.gitBaseline");
    const root = await fsRoot(args);
    const abs = services().files.resolveEntry(root, parseString(args.path, "path"));
    return gitBaseline(gitBinary(), root, relative(root, abs).split(sep).join("/"));
  });
  handle(router, "fs.searchText", async (raw) => {
    const args = parseArgs(raw, "fs.searchText");
    const query = parseTextSearchQuery(args.query);
    return searchText(gitBinary(), await fsRoot(args), query);
  });
  handle(router, "fs.setWatchedPaths", (raw, ctx) => {
    const args = parseArgs(raw, "fs.setWatchedPaths");
    const sessionId = parseString(args.sessionId, "sessionId");
    const paths = parseList<string>(args.paths, MAX_WATCHED_PATHS, "paths", assertString);
    services();
    app.clientInputs.setPaths(ctx.clientId, sessionId, paths);
    if (app.topics.isSubscribed(ctx.clientId, filesTopic(sessionId))) app.applyWatchedFiles(sessionId);
  });
  handle<{ projectId: string; mime: string; base64: string }>(router, "fs.savePasteImage", (args) => {
    const data = Buffer.from(parseString(args.base64, "base64"), "base64");
    assertPasteImageSize(data.byteLength);
    const { sessions, files } = services();
    return files.savePasteImage(sessions.rootForProject(args.projectId), args.mime, data);
  });
  handle<{ sessionId?: string; projectId?: string; path: string }>(router, "fs.readImage", async (args) => {
    if (typeof args.path === "string" && isAbsolute(args.path) && isInsideAttachmentsDir(args.path)) return readAttachmentImage(args.path);
    const { sessions, files } = services();
    const roots: string[] = [];
    if (args.sessionId) {
      try {
        roots.push(await sessions.ensureWorktree(args.sessionId));
      } catch (err) {
        const message = (err as Error).message;
        if (message.includes("unknown session")) {
          console.warn(`readImage: unknown session ${args.sessionId}`);
        } else {
          console.warn(`readImage: worktree recovery failed for ${args.sessionId}: ${message}`);
        }
      }
    }
    if (args.projectId) roots.push(sessions.rootForProject(args.projectId));
    let lastError: Error | null = null;
    for (const root of roots) {
      try {
        return files.readImage(root, args.path);
      } catch (err) {
        lastError = err as Error;
      }
    }
    throw lastError ?? new Error("no root available to read image");
  });
}
