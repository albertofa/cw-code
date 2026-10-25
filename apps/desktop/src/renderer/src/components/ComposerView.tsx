import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from "react";
import { createPortal } from "react-dom";
import {
  ArrowUp,
  AtSign,
  Image,
  Lock,
  LockOpen,
  Pencil,
  Plus,
  Package,
  Slash,
  Square,
  Terminal,
  X,
  Zap
} from "lucide-react";
import type { CommandOption } from "@cw-code/contracts";
import type { AppSettings, ComposerPrefs, DriverName, ModelOption, PermissionMode, PermissionOption } from "../cw.js";
import { clearComposerDraft, loadComposerDraft, saveComposerDraft } from "./composerDrafts.js";
import { getRecentModels, pushRecentModel } from "./lastModel.js";
import { EffortMenu } from "./EffortMenu.js";
import { MenuSelect } from "./MenuSelect.js";
import { ModelPicker } from "./ModelPicker.js";
import {
  effortOptionsFor,
  FALLBACK_PERMISSIONS,
  fallbackEffort,
  hasContextSuffix,
  pickInitialModel,
  stripContextSuffix,
  withContextSuffix
} from "./modelMenus.js";
import { BranchSendChoice } from "./BranchMismatchNotice.js";
import { ImageThumb } from "./ImageThumb.js";
import { displayImagePath, type ImageTarget } from "./imagePreview.js";
import { NewSessionRefusedError, useAppStore, type ComposerSendOptions } from "../stores/appStore.js";
import { useConfirm, type ConfirmRequest } from "./ConfirmDialog.js";
import { useNotifs } from "./Notifications.js";
import { SlashMenu, slashOptionId, type SlashMenuItem } from "./SlashMenu.js";
import {
  commandDisplay,
  filterCommands,
  filterSkills,
  mergeCommands,
  parseSlashInput,
  rankByQuery,
  skillCommands
} from "./slashCommands.js";
import {
  detectSkillTrigger,
  findSkillMentions,
  hasSkillCandidate,
  insertSkillMention,
  insertSkillTrigger,
  skillMentionNames
} from "@cw-code/shared/skillMentions";
import { skillSegments } from "./skillSegments.js";
import { parseBranchMismatchError, type BranchMismatch } from "./sessionBranch.js";
import { harnessLabel } from "./toolTabs.js";
import { ipcErrorMessage } from "./ipcError.js";
import { useThreadVisible } from "./threadVisibility.js";

export interface BranchGuard {
  mismatch: BranchMismatch | null;
  switchBranch(): Promise<void>;
  acceptFolderHead(): Promise<string | null>;
  refreshMismatch(): Promise<BranchMismatch | null>;
}

type HeldSend = (acceptFolderHead?: string) => void;

export interface ComposerBackend {
  imageTarget: ImageTarget;
  branchGuard?: BranchGuard;
  prefs: ComposerPrefs;
  busy: boolean;
  effectivePermissionMode?: string;
  loadModels(): Promise<ModelOption[]>;
  loadPermissions(): Promise<PermissionOption[]>;
  loadFiles(): Promise<string[]>;
  loadCommands(): Promise<CommandOption[]>;
  savePrefs(prefs: ComposerPrefs): void;
  send(body: string, attachments: string[], opts?: ComposerSendOptions & { acceptFolderHead?: string }): Promise<void>;
  restore?: { confirm: ConfirmRequest | null; run(): Promise<void> };
  newSession?(): void;
  rename?(title: string): Promise<void>;
  openTerminal?(): void;
  savePasteImage(mime: string, data: Uint8Array): Promise<string>;
  interrupt(): void;
}

type SlashEntry = SlashMenuItem & { accept: () => void; complete: () => void };

type CommandsResult = { ok: true; list: CommandOption[] } | { ok: false; error: string };

const MAX_ARG_COMPLETIONS = 50;

const SLASH_NAME = /^\/(\S*)$/;
const SLASH_ARG = /^\/(model|effort)\s+(\S*)$/;
const SLASH_PENDING_ARGS = /^\/(\S+) +$/;

function permissionIconFor(id: PermissionMode): ReactNode {
  if (id === "manual") return <Lock size={15} />;
  if (id === "acceptEdits") return <Pencil size={15} />;
  if (id === "bypassPermissions") return <LockOpen size={15} />;
  return <Zap size={15} />;
}

const IMAGE_EXTS = new Set(["png", "jpg", "jpeg", "webp", "gif"]);

function isImage(path: string): boolean {
  const ext = path.split(".").pop()?.toLowerCase() ?? "";
  return IMAGE_EXTS.has(ext);
}

export function ComposerView({
  backend,
  driver,
  resetKey,
  settings = null,
  resetStaleModel = false,
  recipePrefix,
  usageSlot,
  top,
  blockedReason
}: {
  backend: ComposerBackend;
  driver: DriverName;
  resetKey: string;
  settings?: AppSettings | null;
  resetStaleModel?: boolean;
  recipePrefix?: ReactNode;
  usageSlot?: ReactNode;
  top?: ReactNode;
  blockedReason?: string;
}) {
  const { prefs, busy } = backend;
  const settingsKey = useMemo(() => JSON.stringify(settings), [settings]);
  const backendRef = useRef(backend);
  backendRef.current = backend;
  const imageTarget = backend.imageTarget;
  const [draft, setDraft] = useState(() => loadComposerDraft(resetKey)?.text ?? "");
  const [caret, setCaret] = useState<number | null>(() => loadComposerDraft(resetKey)?.text.length ?? 0);
  const [attachments, setAttachments] = useState<string[]>(() => loadComposerDraft(resetKey)?.attachments ?? []);
  const draftRef = useRef(draft);
  draftRef.current = draft;
  const attachmentsRef = useRef(attachments);
  attachmentsRef.current = attachments;
  const [pasteError, setPasteError] = useState<string | null>(null);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [addOpen, setAddOpen] = useState(false);
  const [filter, setFilter] = useState("");
  const [files, setFiles] = useState<string[]>([]);
  const [filesLoading, setFilesLoading] = useState(false);
  const [models, setModels] = useState<ModelOption[]>([]);
  const [modelsError, setModelsError] = useState<string | null>(null);
  const [permissionOptions, setPermissionOptions] = useState<PermissionOption[] | null>(null);
  const [permissionsError, setPermissionsError] = useState<string | null>(null);
  const [customModel, setCustomModel] = useState("");
  const [showCustom, setShowCustom] = useState(false);
  const [sending, setSending] = useState(false);
  const [choiceOpen, setChoiceOpen] = useState(false);
  const [choiceBusy, setChoiceBusy] = useState(false);
  const [choiceError, setChoiceError] = useState<string | null>(null);
  const pendingSendRef = useRef<HeldSend | null>(null);
  const choiceGenerationRef = useRef(0);
  const homeDir = useAppStore((s) => s.homeDir);
  const defaultModelId = useAppStore((s) => s.defaultModelByDriver[driver]);
  const saveDefaultModel = useAppStore((s) => s.saveDefaultModel);
  const home = homeDir ?? undefined;
  const composerRef = useRef<HTMLTextAreaElement | null>(null);
  const customInputRef = useRef<HTMLInputElement | null>(null);
  const mirrorRef = useRef<HTMLDivElement | null>(null);
  const baseModelId = driver === "claude" ? stripContextSuffix(prefs.model ?? "") : (prefs.model ?? "");
  const oneMContext = driver === "claude" && hasContextSuffix(prefs.model ?? "");
  const slashListId = useId();
  const { confirm, dialog: confirmDialog } = useConfirm();
  const [inputFocused, setInputFocused] = useState(false);
  const [driverCommands, setDriverCommands] = useState<CommandOption[] | null>(null);
  const [commandsLoading, setCommandsLoading] = useState(false);
  const [commandsError, setCommandsError] = useState<string | null>(null);
  const [slashDismissed, setSlashDismissed] = useState<string | null>(null);
  const [slashIndex, setSlashIndex] = useState(0);
  const [skillDismissed, setSkillDismissed] = useState<number | null>(null);
  const commandsRef = useRef<{ key: string; promise: Promise<CommandsResult>; failed: boolean } | null>(null);
  const commandsKey = `${driver}\n${resetKey}`;
  const commandsKeyRef = useRef(commandsKey);
  commandsKeyRef.current = commandsKey;
  const mountedRef = useRef(true);
  const visible = useThreadVisible();
  const commandAvailability = {
    newSession: backend.newSession !== undefined,
    rename: backend.rename !== undefined,
    terminal: backend.openTerminal !== undefined
  };

  const syncMirror = () => {
    const el = composerRef.current;
    const mirror = mirrorRef.current;
    if (!el || !mirror) return;
    mirror.style.width = `${el.clientWidth}px`;
    mirror.scrollTop = el.scrollTop;
  };

  const autosizeComposer = () => {
    const el = composerRef.current;
    if (!el || el.getClientRects().length === 0) return;
    let lineHeight = 22.5;
    try {
      const parsed = Number.parseFloat(window.getComputedStyle(el).lineHeight);
      if (Number.isFinite(parsed) && parsed > 0) lineHeight = parsed;
    } catch {
    }
    const max = Math.round(lineHeight * 8);
    el.style.height = "auto";
    const next = Math.min(el.scrollHeight, max);
    el.style.height = `${next}px`;
    el.style.overflowY = el.scrollHeight > max ? "auto" : "hidden";
    syncMirror();
  };

  useLayoutEffect(() => {
    autosizeComposer();
  }, [draft, resetKey, visible]);

  useEffect(() => {
    const onResize = () => autosizeComposer();
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  useEffect(() => {
    if (!visible || backendRef.current.busy) return;
    const frame = requestAnimationFrame(() => {
      try {
        composerRef.current?.focus({ preventScroll: true });
      } catch {
      }
    });
    return () => cancelAnimationFrame(frame);
  }, [resetKey, visible]);

  useEffect(() => {
    const saved = loadComposerDraft(resetKey);
    setAttachments(saved?.attachments ?? []);
    setDraft(saved?.text ?? "");
    setCaret(saved?.text.length ?? 0);
    setPasteError(null);
    setShowCustom(false);
    setCustomModel("");
    setAddOpen(false);
    setPickerOpen(false);
    invalidateBranchChoice();
    // Leaving this composer (another session, or the view unmounting) keeps what was written for when you come back.
    return () => saveComposerDraft(resetKey, draftRef.current, attachmentsRef.current);
  }, [resetKey]);

  useEffect(() => {
    setShowCustom(false);
    setCustomModel("");
  }, [driver]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const isCurrent = (key: string) => mountedRef.current && commandsKeyRef.current === key;

  useEffect(() => {
    commandsRef.current = null;
    setDriverCommands(null);
    setCommandsLoading(false);
    setCommandsError(null);
    setSlashDismissed(null);
    setSkillDismissed(null);
  }, [commandsKey]);

  const ensureCommands = (retryFailed = false): Promise<CommandsResult> => {
    const current = commandsRef.current;
    if (current?.key === commandsKey && !(retryFailed && current.failed)) return current.promise;
    setCommandsLoading(true);
    setCommandsError(null);
    const entry: { key: string; promise: Promise<CommandsResult>; failed: boolean } = {
      key: commandsKey,
      promise: Promise.resolve()
        .then(() => backendRef.current.loadCommands())
        .then(
          (list) => {
            if (commandsRef.current === entry) {
              setDriverCommands(list);
              setCommandsLoading(false);
            }
            return { ok: true as const, list };
          },
          (err: unknown) => {
            const error = ipcErrorMessage(err);
            if (commandsRef.current === entry) {
              entry.failed = true;
              setCommandsError(error);
              setCommandsLoading(false);
            }
            return { ok: false as const, error };
          }
        ),
      failed: false
    };
    commandsRef.current = entry;
    return entry.promise;
  };

  useEffect(() => {
    let cancelled = false;
    setModelsError(null);
    backendRef.current
      .loadModels()
      .then((list) => {
        if (cancelled) return;
        setModels(list);
        const initialModel = () =>
          pickInitialModel(list, useAppStore.getState().defaultModelByDriver[driver], getRecentModels(driver));
        if (!prefs.model) {
          const next = initialModel();
          if (next) backendRef.current.savePrefs({ model: next });
          setShowCustom(false);
        } else if (list.some((m) => m.id === baseModelId)) {
          setShowCustom(false);
        } else if (resetStaleModel && list.length > 0) {
          const next = initialModel();
          if (next) backendRef.current.savePrefs({ model: next });
          setShowCustom(false);
        } else {
          setCustomModel(baseModelId);
          setShowCustom(true);
        }
      })
      .catch((err) => {
        if (cancelled) return;
        setModels([]);
        setModelsError(err instanceof Error ? err.message : "model list failed");
      });
    return () => {
      cancelled = true;
    };
  }, [resetKey, driver, prefs.model, settingsKey]);

  useEffect(() => {
    let cancelled = false;
    setPermissionsError(null);
    Promise.resolve()
      .then(() => backendRef.current.loadPermissions())
      .then((list) => {
        if (cancelled) return;
        setPermissionOptions(list.length > 0 ? list : FALLBACK_PERMISSIONS);
      })
      .catch((err) => {
        if (cancelled) return;
        setPermissionOptions(FALLBACK_PERMISSIONS);
        setPermissionsError(err instanceof Error ? err.message : "permission list failed");
      });
    return () => {
      cancelled = true;
    };
  }, [resetKey, driver, settingsKey]);

  useEffect(() => {
    if (!pickerOpen) return;
    setFilesLoading(true);
    backendRef.current
      .loadFiles()
      .then((list) => setFiles(list))
      .catch(() => setFiles([]))
      .finally(() => setFilesLoading(false));
  }, [pickerOpen, resetKey]);

  const filtered = useMemo(() => {
    const q = filter.toLowerCase();
    const list = q ? files.filter((f) => f.toLowerCase().includes(q)) : files;
    return list.slice(0, 50);
  }, [files, filter]);

  const addAttachment = (rel: string) => {
    setAttachments((prev) => (prev.includes(rel) ? prev : [...prev, rel]));
  };

  const pasteFiles = async (clipboard: DataTransfer): Promise<void> => {
    const fromItems = Array.from(clipboard.items)
      .filter((i) => i.kind === "file" && i.type.startsWith("image/"))
      .map((i) => i.getAsFile())
      .filter((f): f is File => f !== null);
    const pasted = fromItems.length > 0 ? fromItems : Array.from(clipboard.files).filter((f) => f.type.startsWith("image/"));
    for (const file of pasted) {
      try {
        const data = new Uint8Array(await file.arrayBuffer());
        const rel = await backendRef.current.savePasteImage(file.type, data);
        addAttachment(rel);
        setPasteError(null);
      } catch (err) {
        setPasteError((err as Error).message || "paste failed");
      }
    }
  };

  const openFilePicker = () => {
    setAddOpen(false);
    setPickerOpen(true);
  };

  const recentModels = useMemo(() => getRecentModels(driver), [driver, models, prefs.model]);
  const modelDisplay = showCustom
    ? customModel.trim() || "Custom"
    : (models.find((m) => m.id === baseModelId)?.label ?? "Select model");
  const effortOptions = useMemo(
    () => effortOptionsFor(driver, models, showCustom ? undefined : baseModelId),
    [driver, models, showCustom, baseModelId]
  );
  const effectiveEffort = prefs.effort ?? "medium";

  useEffect(() => {
    if (driver !== "opencode" || showCustom) return;
    if (effortOptions.some((o) => o.id === effectiveEffort)) return;
    const next = fallbackEffort(effectiveEffort, effortOptions);
    if (next !== effectiveEffort) backendRef.current.savePrefs({ effort: next });
  }, [driver, showCustom, models, prefs.model, effectiveEffort, effortOptions]);
  const permissions = permissionOptions ?? FALLBACK_PERMISSIONS;
  const effectivePermission = prefs.permissionMode ?? "auto";
  const permissionDisplay = permissions.find((o) => o.id === effectivePermission)?.label ?? "Auto";
  const reportedPermission = backend.effectivePermissionMode?.trim() ?? "";
  const showReportedPermission =
    driver === "claude" && reportedPermission !== "" && reportedPermission !== effectivePermission;
  const permissionIcon = permissionIconFor(
    permissions.some((o) => o.id === effectivePermission) ? effectivePermission : "auto"
  );

  useEffect(() => {
    if (!permissionOptions || permissionOptions.length === 0) return;
    if (permissionOptions.some((o) => o.id === effectivePermission)) return;
    backendRef.current.savePrefs({ permissionMode: permissionOptions[0].id });
  }, [permissionOptions, effectivePermission]);

  const commandList = useMemo(
    () => mergeCommands(driver, driverCommands ?? [], commandAvailability),
    [driver, driverCommands, commandAvailability.newSession, commandAvailability.rename, commandAvailability.terminal]
  );
  const skillList = useMemo(() => skillCommands(commandList), [commandList]);
  const draftMentions = useMemo(
    () => findSkillMentions(draft, new Set(skillList.map((skill) => skill.name))),
    [draft, skillList]
  );
  const highlightMentions = draftMentions.length > 0;

  useLayoutEffect(() => {
    syncMirror();
  }, [highlightMentions]);

  const clearComposer = () => {
    // The refs feed the unmount save; a command that swaps this composer out (/new, /clear)
    // never renders the cleared state, so drop them here instead of waiting for a commit.
    draftRef.current = "";
    attachmentsRef.current = [];
    setDraft("");
    setCaret(0);
    setAttachments([]);
    setPasteError(null);
  };

  const warn = (title: string, message?: string) => {
    useNotifs.getState().push({ kind: "warning", title, message });
  };

  const notifyError = (title: string, err: unknown) => {
    useNotifs.getState().push({ kind: "error", title, message: ipcErrorMessage(err) });
  };

  const notifySendError = (err: unknown) => {
    if (err instanceof NewSessionRefusedError) return;
    notifyError("Could not send", err);
  };

  const focusComposer = () => {
    requestAnimationFrame(() => composerRef.current?.focus({ preventScroll: true }));
  };

  const tagAttachments = (body: string) =>
    attachments.length > 0 ? `${body}${body ? "\n" : ""}${attachments.map((a) => `@${a}`).join("\n")}` : body;

  const commitModel = (id: string) => {
    pushRecentModel(driver, id);
    backendRef.current.savePrefs({ model: id });
  };

  const commitCustomModel = (value: string) => {
    commitModel(oneMContext ? withContextSuffix(value, true) : value);
  };

  const applyModel = (value: string) => {
    const oneM = driver === "claude" && hasContextSuffix(value);
    const base = driver === "claude" ? stripContextSuffix(value) : value;
    const wanted = base.toLowerCase();
    const match =
      models.find((m) => m.id === base) ??
      models.find((m) => m.id.toLowerCase() === wanted || m.label.toLowerCase() === wanted);
    if (!match && models.length > 0) {
      warn(`Unknown model: ${base}`, "Pick one from the list, or use Custom… in the model menu.");
      return;
    }
    const id = match?.id ?? base;
    if (match) {
      setShowCustom(false);
    } else {
      setCustomModel(id);
      setShowCustom(true);
    }
    commitModel(oneM ? withContextSuffix(id, true) : id);
    setDraft("");
  };

  const applyEffort = (value: string) => {
    const wanted = value.toLowerCase();
    const match = effortOptions.find((o) => o.id === wanted || o.label.toLowerCase() === wanted);
    if (!match) {
      warn(`Unknown effort level: ${value}`, `Available: ${effortOptions.map((o) => o.id).join(", ")}`);
      return;
    }
    backendRef.current.savePrefs({ effort: match.id });
    setDraft("");
  };

  const pickModel = (id: string) => {
    setShowCustom(false);
    commitModel(id);
  };

  const openCustomModel = () => {
    setShowCustom(true);
    requestAnimationFrame(() => customInputRef.current?.focus());
  };

  const useCustomModel = (value: string) => {
    setCustomModel(value);
    setShowCustom(true);
    commitCustomModel(value);
  };

  const changeDefaultModel = (id: string) => {
    saveDefaultModel(driver, id).catch((err: unknown) => notifyError("Could not save default model", err));
  };

  const changeContextWindow = (oneM: boolean) => {
    if (!prefs.model) return;
    commitModel(withContextSuffix(prefs.model, oneM));
  };

  const completeCommand = (command: CommandOption) => {
    setDraft(`/${command.name} `);
    focusComposer();
  };

  const runAppCommand = (command: CommandOption, args: string, key: string) => {
    const b = backendRef.current;
    if (command.name === "new" || command.name === "clear") {
      clearComposer();
      b.newSession?.();
      return;
    }
    if (!args) {
      completeCommand(command);
      return;
    }
    if (command.name === "model") {
      applyModel(args);
    } else if (command.name === "effort") {
      applyEffort(args);
    } else if (command.name === "rename" && b.rename) {
      void b.rename(args).then(
        () => {
          if (isCurrent(key)) setDraft("");
          else clearComposerDraft(resetKey);
        },
        (err: unknown) => notifyError("Rename failed", err)
      );
    }
  };

  const runCommand = async (command: CommandOption, args: string, key: string = commandsKey): Promise<void> => {
    if (attachments.length > 0) {
      warn(`Attachments can't be sent with /${command.name}`, "Remove them or send a regular message.");
      return;
    }
    if (command.confirm) {
      const ok = await confirm({ title: `Run /${command.name}?`, message: command.confirm, confirmLabel: "Run" });
      if (!ok || !isCurrent(key)) return;
    }
    const b = backendRef.current;
    if (command.dispatch === "app") {
      runAppCommand(command, args, key);
      return;
    }
    if (command.dispatch === "terminal" && b.openTerminal) {
      b.openTerminal();
      useNotifs.getState().push({
        kind: "info",
        title: `Run /${command.name} in the ${harnessLabel(driver)} terminal`,
        message: "This command only works in the interactive CLI."
      });
      setDraft("");
      return;
    }
    if (holdForBranchChoice((accept) => void dispatchCommand(command, args, key, accept))) return;
    await dispatchCommand(command, args, key);
  };

  const dispatchCommand = async (command: CommandOption, args: string, key: string, accept?: string): Promise<void> => {
    setSending(true);
    try {
      await backendRef.current.send(commandDisplay(command.name, args), [], {
        command: { name: command.name, args },
        ...(accept ? { acceptFolderHead: accept } : {})
      });
      if (isCurrent(key)) clearComposer();
      else clearComposerDraft(resetKey);
    } catch (err) {
      await handleSendFailure(err, key, (next) => void dispatchCommand(command, args, key, next));
    } finally {
      setSending(false);
      if (isCurrent(key)) focusComposer();
    }
  };

  const sendPlain = (body: string, key: string, skills: string[] = []) => {
    if (holdForBranchChoice((accept) => dispatchPlain(body, key, skills, accept))) return;
    dispatchPlain(body, key, skills);
  };

  const dispatchPlain = (body: string, key: string, skills: string[], accept?: string) => {
    setSending(true);
    void backendRef.current
      .send(tagAttachments(body), attachments, {
        ...(skills.length > 0 ? { skills } : {}),
        ...(accept ? { acceptFolderHead: accept } : {})
      })
      .then(() => {
        if (isCurrent(key)) clearComposer();
        else clearComposerDraft(resetKey);
      })
      .catch((err: unknown) => handleSendFailure(err, key, (next) => dispatchPlain(body, key, skills, next)))
      .finally(() => {
        setSending(false);
        if (isCurrent(key)) focusComposer();
      });
  };

  const mentionedSkills = (body: string, list: CommandOption[]): string[] =>
    skillMentionNames(body, new Set(skillCommands(list).map((skill) => skill.name)));

  const sendMessage = async (body: string): Promise<void> => {
    const key = commandsKey;
    const slash = body.startsWith("/");
    if (slash) {
      const immediate = parseSlashInput(body, commandList);
      if (immediate) return runCommand(immediate.command, immediate.args, key);
    }
    const needsList = driverCommands === null && (slash || hasSkillCandidate(body));
    if (!needsList) {
      sendPlain(body, key, mentionedSkills(body, commandList));
      return;
    }
    setSending(true);
    const result = await ensureCommands().finally(() => setSending(false));
    if (!isCurrent(key)) {
      warn("Message not sent", "The session changed while its command list was loading.");
      return;
    }
    if (!result.ok) {
      warn(
        slash ? "Command list unavailable" : "Skill list unavailable",
        `${slash ? "Sent as a regular message" : "Sent without skill mentions"}: ${result.error}`
      );
      sendPlain(body, key);
      return;
    }
    const list = mergeCommands(driver, result.list, commandAvailability);
    const parsed = slash ? parseSlashInput(body, list) : null;
    if (parsed) return runCommand(parsed.command, parsed.args, key);
    sendPlain(body, key, mentionedSkills(body, list));
  };

  const send = () => {
    const body = draft.trim();
    if ((!body && attachments.length === 0) || busy || sending || blockedReason) return;
    const restore = backendRef.current.restore;
    if (!restore) {
      void sendMessage(body);
      return;
    }
    void restoreThenSend(restore, body);
  };

  const restoreThenSend = async (restore: NonNullable<ComposerBackend["restore"]>, body: string): Promise<void> => {
    const key = commandsKey;
    if (restore.confirm && !(await confirm(restore.confirm))) return;
    if (!isCurrent(key)) return;
    setSending(true);
    try {
      await restore.run();
    } catch (err) {
      notifyError("Restore failed", err);
      return;
    } finally {
      setSending(false);
    }
    if (isCurrent(key)) await sendMessage(body);
  };

  const openBranchChoice = (action: HeldSend) => {
    pendingSendRef.current = action;
    setChoiceError(null);
    setChoiceOpen(true);
  };

  const holdForBranchChoice = (action: HeldSend): boolean => {
    if (!backendRef.current.branchGuard?.mismatch) return false;
    openBranchChoice(action);
    return true;
  };

  const hideBranchChoice = () => {
    pendingSendRef.current = null;
    setChoiceOpen(false);
    setChoiceError(null);
  };

  const invalidateBranchChoice = () => {
    choiceGenerationRef.current += 1;
    pendingSendRef.current = null;
    setChoiceOpen(false);
    setChoiceError(null);
  };

  const handleSendFailure = async (err: unknown, key: string, retry: HeldSend): Promise<void> => {
    const guard = backendRef.current.branchGuard;
    if (guard && isCurrent(key) && parseBranchMismatchError(ipcErrorMessage(err))) {
      const fresh = await guard.refreshMismatch().catch(() => null);
      if (fresh && isCurrent(key)) {
        openBranchChoice(retry);
        return;
      }
    }
    notifySendError(err);
  };

  const resolveBranchChoice = async (choice: "switch" | "here"): Promise<void> => {
    const guard = backendRef.current.branchGuard;
    if (!guard) return;
    const action = pendingSendRef.current;
    const generation = choiceGenerationRef.current;
    const switchTarget = guard.mismatch?.sessionBranch;
    setChoiceBusy(true);
    setChoiceError(null);
    let accept: string | undefined;
    try {
      if (choice === "switch") {
        await guard.switchBranch();
      } else {
        const head = await guard.acceptFolderHead();
        if (head === null) throw new Error("Could not read the project's current git state.");
        accept = head;
      }
    } catch (err) {
      const message = ipcErrorMessage(err);
      setChoiceError(choice === "switch" && switchTarget ? `Could not switch to ${switchTarget}: ${message}` : message);
      setChoiceBusy(false);
      return;
    }
    setChoiceBusy(false);
    if (!action || choiceGenerationRef.current !== generation) return;
    hideBranchChoice();
    if (backendRef.current.busy) {
      warn("A turn is still running", "Your message was not sent. Send it again when the turn finishes.");
      return;
    }
    action(accept);
  };

  const cancelBranchChoice = () => {
    invalidateBranchChoice();
    focusComposer();
  };

  const branchMismatch = backend.branchGuard?.mismatch ?? null;
  const hasBranchMismatch = branchMismatch !== null;

  useEffect(() => {
    if (!hasBranchMismatch) hideBranchChoice();
  }, [hasBranchMismatch]);

  useEffect(() => {
    invalidateBranchChoice();
  }, [draft, attachments]);

  const slashName = SLASH_NAME.exec(draft);
  const slashArg = SLASH_ARG.exec(draft);
  const slashOpen = inputFocused && !busy && !sending && (slashName !== null || slashArg !== null) && slashDismissed !== draft;
  const slashNameOpen = slashOpen && slashName !== null;
  const skillTrigger = caret === null || slashName !== null || slashArg !== null ? null : detectSkillTrigger(draft, caret);
  const skillTriggerStart = skillTrigger?.start ?? null;
  const skillMatches = skillTrigger ? filterSkills(skillList, skillTrigger.query) : [];
  const skillsSettled = driverCommands !== null && !commandsLoading && !commandsError;
  const skillOpen =
    inputFocused &&
    !busy &&
    !sending &&
    skillTrigger !== null &&
    skillDismissed !== skillTrigger.start &&
    !(skillsSettled && skillTrigger.query !== "" && skillMatches.length === 0);
  const menuOpen = slashOpen || skillOpen;
  const skillTypedOut = skillOpen && skillTrigger !== null && skillMatches.some((skill) => skill.name === skillTrigger.query);
  const wantsCommands = slashNameOpen || (inputFocused && skillTriggerStart !== null);

  useEffect(() => {
    if (wantsCommands) void ensureCommands(true);
  }, [wantsCommands, commandsKey]);

  useEffect(() => {
    setSkillDismissed((dismissed) => (dismissed === skillTriggerStart ? dismissed : null));
  }, [skillTriggerStart]);

  useEffect(() => {
    setSlashIndex(0);
  }, [draft, skillTriggerStart]);

  const syncCaret = (el: HTMLTextAreaElement) => {
    setCaret(el.selectionStart === el.selectionEnd ? el.selectionStart : null);
  };

  const placeCaret = (next: { text: string; caret: number }) => {
    setDraft(next.text);
    setCaret(next.caret);
    requestAnimationFrame(() => {
      const el = composerRef.current;
      if (!el) return;
      el.focus({ preventScroll: true });
      el.setSelectionRange(next.caret, next.caret);
    });
  };

  const pickSkill = (name: string) => {
    if (skillTrigger) placeCaret(insertSkillMention(draft, skillTrigger, name));
  };

  const openSkills = () => {
    setAddOpen(false);
    setSkillDismissed(null);
    placeCaret(insertSkillTrigger(draft, caret ?? draft.length));
  };

  const slashEntries: SlashEntry[] = [];
  const argCommand = slashArg ? commandList.find((c) => c.name === slashArg[1]) : undefined;
  const modelArgMode = slashArg?.[1] === "model";
  let argOverflow = false;
  if (slashOpen && slashArg && argCommand) {
    const modelQuery = driver === "claude" ? stripContextSuffix(slashArg[2]) : slashArg[2];
    const modelSuffix = driver === "claude" && hasContextSuffix(slashArg[2]) ? "[1m]" : "";
    const options = modelArgMode
      ? rankByQuery(models, modelQuery, (m) => [m.id, m.label]).map((m) => ({
          id: `${m.id}${modelSuffix}`,
          label: m.label,
          hint: m.label === m.id ? undefined : m.id
        }))
      : rankByQuery(effortOptions, slashArg[2], (o) => [o.id, o.label]).map((o) => ({ id: o.id, label: o.label, hint: o.id }));
    argOverflow = options.length > MAX_ARG_COMPLETIONS;
    for (const o of options.slice(0, MAX_ARG_COMPLETIONS)) {
      slashEntries.push({
        key: o.id,
        label: o.label,
        hint: o.hint,
        accept: () => void runCommand(argCommand, o.id),
        complete: () => setDraft(`/${argCommand.name} ${o.id}`)
      });
    }
  } else if (skillOpen) {
    for (const skill of skillMatches) {
      slashEntries.push({
        key: skill.name,
        label: `$${skill.name}`,
        description: skill.description || undefined,
        accept: () => pickSkill(skill.name),
        complete: () => pickSkill(skill.name)
      });
    }
  } else if (slashNameOpen && slashName) {
    for (const c of filterCommands(commandList, slashName[1])) {
      slashEntries.push({
        key: c.name,
        label: `/${c.name}`,
        description: c.description || undefined,
        hint: c.argumentHint,
        accept: () => {
          if (c.argumentHint) completeCommand(c);
          else void runCommand(c, "");
        },
        complete: () => completeCommand(c)
      });
    }
  }
  const slashActive = slashEntries.length > 0 ? Math.min(slashIndex, slashEntries.length - 1) : -1;
  const slashMenuLabel = skillOpen ? "Skills" : slashArg ? (modelArgMode ? "Models" : "Effort levels") : "Commands";
  const slashError = skillOpen
    ? commandsError && `Skills failed to load: ${commandsError}`
    : slashNameOpen
      ? commandsError && `Commands failed to load: ${commandsError}`
      : modelArgMode && modelsError
        ? `Model list failed: ${modelsError}`
        : null;
  const slashEmpty = skillOpen
    ? skillList.length === 0
      ? `No skills available for ${harnessLabel(driver)}.`
      : "No matching skills."
    : slashArg
      ? modelArgMode && models.length === 0
        ? "No models available."
        : "No matches."
      : "No matching commands.";
  const pendingArgs = SLASH_PENDING_ARGS.exec(draft);
  const argHint = pendingArgs ? commandList.find((c) => c.name === pendingArgs[1])?.argumentHint : undefined;

  const handleSlashKey = (e: ReactKeyboardEvent<HTMLTextAreaElement>): boolean => {
    if (!menuOpen) return false;
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      if (skillOpen) setSkillDismissed(skillTriggerStart);
      else setSlashDismissed(draft);
      return true;
    }
    if (slashActive < 0) return false;
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      const step = e.key === "ArrowDown" ? 1 : -1;
      setSlashIndex((slashActive + step + slashEntries.length) % slashEntries.length);
      return true;
    }
    if ((e.key === "Tab" || e.key === "Enter") && !e.shiftKey) {
      if (e.key === "Enter" && skillTypedOut) return false;
      e.preventDefault();
      const entry = slashEntries[slashActive];
      const query = slashArg ? slashArg[2] : (slashName?.[1] ?? "");
      if (e.key === "Tab" || query === "") entry.complete();
      else entry.accept();
      return true;
    }
    return false;
  };

  const commandsRowDisabled = draft.trim() !== "" && !draft.startsWith("/");
  const openCommands = () => {
    if (commandsRowDisabled) return;
    setAddOpen(false);
    if (!draft.startsWith("/")) setDraft("/");
    setSlashDismissed(null);
    focusComposer();
  };

  return (
    <>
    <div className={`composer composer-recipe${busy ? " composer-busy" : ""}`}>
      {menuOpen && (
        <SlashMenu
          id={slashListId}
          label={slashMenuLabel}
          items={slashEntries}
          activeIndex={slashActive}
          loading={(slashNameOpen || skillOpen) && commandsLoading}
          loadingText={skillOpen ? "Loading skills…" : "Loading commands…"}
          error={slashError || null}
          emptyText={slashEmpty}
          moreText={argOverflow ? "Keep typing to narrow down" : undefined}
          onHover={setSlashIndex}
          onPick={(index) => slashEntries[index]?.accept()}
        />
      )}
      {top && <div className="composer-top">{top}</div>}
      {choiceOpen && branchMismatch && backend.branchGuard && (
        <BranchSendChoice
          mismatch={branchMismatch}
          busy={choiceBusy}
          switchDisabled={busy}
          error={choiceError}
          onSwitchAndSend={() => void resolveBranchChoice("switch")}
          onSendHere={() => void resolveBranchChoice("here")}
          onCancel={cancelBranchChoice}
        />
      )}
      <div className="composer-card">
        {attachments.length > 0 && (
          <div className="attach-chips">
            {attachments.map((a) => (
              <span key={a} className="chip" title={displayImagePath(a, home)}>
                {isImage(a) ? (
                  <ImageThumb target={imageTarget} path={a} className="chip-thumb" />
                ) : (
                  <>
                    <span aria-hidden>@</span>
                    <span className="chip-name">{displayImagePath(a, home)}</span>
                  </>
                )}
                <button
                  className="chip-x"
                  aria-label={`Remove ${a}`}
                  onClick={() => setAttachments((prev) => prev.filter((x) => x !== a))}
                >
                  <X aria-hidden="true" size={14} />
                </button>
              </span>
            ))}
          </div>
        )}
        <div className="composer-writing">
          <div className="composer-input-wrap">
            {highlightMentions && (
              <div ref={mirrorRef} className="composer-mirror" aria-hidden="true">
                {skillSegments(draft, draftMentions).map((part, i) =>
                  part.kind === "skill" ? (
                    <span key={i} className="composer-mention">
                      {part.raw}
                    </span>
                  ) : (
                    part.value
                  )
                )}
                {"​"}
              </div>
            )}
            <textarea
              ref={composerRef}
              value={draft}
              onChange={(e) => {
                const next = e.target.value;
                setDraft(next);
                syncCaret(e.target);
                if (!next.startsWith("/")) setSlashDismissed(null);
              }}
              onSelect={(e) => syncCaret(e.currentTarget)}
              onScroll={syncMirror}
              onFocus={() => setInputFocused(true)}
              onBlur={() => setInputFocused(false)}
              onKeyDown={(e) => {
                if (handleSlashKey(e)) return;
                if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "u") {
                  e.preventDefault();
                  setPickerOpen(false);
                  setAddOpen((v) => !v);
                  return;
                }
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  send();
                }
              }}
              onPaste={(e) => {
                void pasteFiles(e.clipboardData);
              }}
              placeholder={blockedReason ?? (busy ? "Agent is working — keep writing, you can send when it finishes" : "Ask cw-code — @ files, / commands, $ skills")}
              className={`composer-input${highlightMentions ? " has-mentions" : ""}`}
              rows={3}
              disabled={sending || blockedReason !== undefined}
              role="combobox"
              aria-expanded={menuOpen}
              aria-autocomplete="list"
              aria-controls={menuOpen ? slashListId : undefined}
              aria-activedescendant={menuOpen && slashActive >= 0 ? slashOptionId(slashListId, slashActive) : undefined}
            />
            {argHint && (
              <div className="composer-arg-hint" aria-hidden="true">
                <span className="composer-arg-hint-pad">{draft}</span>
                {argHint}
              </div>
            )}
          </div>
        </div>
        {pasteError && (
          <div className="composer-paste-error" role="alert">
            {pasteError}
          </div>
        )}
        <div className="composer-card-foot">
          <div className="menu composer-add">
            <button
              className="icon-btn composer-attach"
              title="Add attachment (Ctrl+U)"
              aria-label="Add attachment"
              aria-haspopup="menu"
              aria-expanded={addOpen}
              onClick={() => {
                setPickerOpen(false);
                setAddOpen((v) => !v);
              }}
            >
              <Plus size={16} />
            </button>
            {addOpen && (
              <>
                <div className="menu-backdrop" onClick={() => setAddOpen(false)} />
                <div
                  className="menu-panel"
                  role="menu"
                  aria-label="Add attachment"
                  onKeyDown={(e) => {
                    if (e.key === "Escape") setAddOpen(false);
                  }}
                >
                  <div className="menu-row" role="menuitem" title="Attach project files or images as @mentions" onClick={openFilePicker}>
                    <span className="menu-icon">
                      <Image size={14} />
                    </span>
                    <span className="menu-text">
                      <span className="name">Images and files</span>
                    </span>
                    <span className="menu-hint">Ctrl+U</span>
                  </div>
                  <div className="menu-row" role="menuitem" title="Attach project files as @mentions" onClick={openFilePicker}>
                    <span className="menu-icon">
                      <AtSign size={14} />
                    </span>
                    <span className="menu-text">
                      <span className="name">Context</span>
                    </span>
                    <span className="menu-hint">@</span>
                  </div>
                  <div
                    className={`menu-row${commandsRowDisabled ? " disabled" : ""}`}
                    role="menuitem"
                    aria-disabled={commandsRowDisabled || undefined}
                    title={commandsRowDisabled ? "Clear the draft to pick a command" : "Run a slash command"}
                    onClick={openCommands}
                  >
                    <span className="menu-icon">
                      <Slash size={14} />
                    </span>
                    <span className="menu-text">
                      <span className="name">Commands</span>
                    </span>
                    <span className="menu-hint">/</span>
                  </div>
                  <div className="menu-row" role="menuitem" title="Mention a skill anywhere in the message" onClick={openSkills}>
                    <span className="menu-icon">
                      <Package size={14} />
                    </span>
                    <span className="menu-text">
                      <span className="name">Skills</span>
                    </span>
                    <span className="menu-hint">$</span>
                  </div>
                  <div className="menu-row disabled" role="menuitem" aria-disabled="true" title="Shell commands are not supported yet">
                    <span className="menu-icon">
                      <Terminal size={14} />
                    </span>
                    <span className="menu-text">
                      <span className="name">Shell command</span>
                    </span>
                    <span className="menu-hint">!</span>
                  </div>
                </div>
              </>
            )}
          </div>
          {blockedReason === undefined && (
            <span className="composer-hint">{busy ? "Send unlocks when the agent finishes" : "Shift+Enter for a new line"}</span>
          )}
          <button
            type="button"
            className="composer-action composer-send"
            onClick={send}
            disabled={busy || sending || blockedReason !== undefined || (!draft.trim() && attachments.length === 0)}
            title={busy ? "Locked while the agent is working" : (blockedReason ?? "Send")}
            aria-label="Send"
          >
            <ArrowUp size={16} strokeWidth={2.25} />
          </button>
          {busy && (
            <button
              type="button"
              className="composer-action composer-stop"
              onClick={() => backend.interrupt()}
              title="Stop response"
              aria-label="Stop response"
            >
              <Square size={13} fill="currentColor" />
            </button>
          )}
        </div>
      </div>
      {pickerOpen && (
        <div className="attach-picker">
          <input
            className="field"
            placeholder="Filter files…"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            autoFocus
          />
          <div className="attach-list">
            {filesLoading && <div className="side-empty">Loading files…</div>}
            {!filesLoading && filtered.length === 0 && <div className="side-empty">No files match.</div>}
            {filtered.map((f) => (
              <div
                key={f}
                className="file-row"
                onClick={() => {
                  addAttachment(f);
                  setPickerOpen(false);
                  setFilter("");
                }}
                title={f}
              >
                {isImage(f) ? <Image aria-hidden="true" size={14} /> : "@ "}
                {f}
              </div>
            ))}
          </div>
        </div>
      )}
      <div className="composer-recipe-row">
        {recipePrefix}
        <div className="recipe-control recipe-model" title={driver}>
          <ModelPicker
            driver={driver}
            models={models}
            currentId={showCustom ? "" : baseModelId}
            display={modelDisplay}
            isSet={showCustom || !!prefs.model}
            title={modelsError ? `Model list failed: ${modelsError}` : "Model"}
            error={modelsError}
            defaultId={defaultModelId}
            recents={recentModels}
            onPick={pickModel}
            onCustom={openCustomModel}
            onUseCustom={useCustomModel}
            onDefaultChange={changeDefaultModel}
          />
        </div>
        {showCustom && (
          <input
            ref={customInputRef}
            className="field composer-custom"
            placeholder={driver === "opencode" ? "provider/model or alias" : "model ID or alias"}
            aria-label="Custom model"
            value={customModel}
            onChange={(e) => setCustomModel(e.target.value)}
            onBlur={() => {
              const v = customModel.trim();
              if (v) commitCustomModel(v);
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter") (e.target as HTMLInputElement).blur();
              if (e.key === "Escape") setShowCustom(false);
            }}
          />
        )}
        <div className="recipe-control">
          <EffortMenu
            driver={driver}
            modelLabel={modelDisplay}
            options={effortOptions}
            effort={effectiveEffort}
            oneM={driver === "claude" ? oneMContext : null}
            oneMDisabledReason={prefs.model ? undefined : "Pick a model first"}
            onEffort={(effort) => backend.savePrefs({ effort })}
            onContext={changeContextWindow}
          />
        </div>
        <div className="recipe-control">
          <MenuSelect
            label="Permission"
            icon={permissionIcon}
            title={
              permissionsError
                ? `Permission list failed: ${permissionsError}`
                : showReportedPermission
                  ? `${harnessLabel(driver)} CLI is running in ${reportedPermission} mode; cw-code answers its permission requests in the background.`
                  : "Permission"
            }
            value={effectivePermission}
            display={permissionDisplay}
            isSet={effectivePermission !== "auto"}
            options={permissions.map((o) => ({ id: o.id, label: o.label, description: o.description, icon: permissionIconFor(o.id) }))}
            onPick={(v) => backend.savePrefs({ permissionMode: v as PermissionMode })}
          />
        </div>
        <span className="composer-recipe-spacer" />
        {usageSlot}
      </div>
    </div>
    {confirmDialog && createPortal(confirmDialog, document.body)}
    </>
  );
}
