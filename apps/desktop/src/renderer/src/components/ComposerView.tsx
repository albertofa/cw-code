import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from "react";
import {
  ArrowUp,
  AtSign,
  Image,
  Lock,
  LockOpen,
  Paperclip,
  Pencil,
  Slash,
  Square,
  Terminal,
  X,
  Zap
} from "lucide-react";
import type { CommandInvocation, CommandOption } from "@cw-code/contracts";
import type { ComposerPrefs, DriverName, EffortLevel, ModelOption, PermissionMode, PermissionOption } from "../cw.js";
import { firstDisplayedModelId, getLastModel, setLastModel } from "./lastModel.js";
import { DriverIcon } from "./DriverIcon.js";
import { MenuSelect, type MenuOption } from "./MenuSelect.js";
import { ImageThumb } from "./ImageThumb.js";
import { displayImagePath, type ImageTarget } from "./imagePreview.js";
import { useAppStore } from "../stores/appStore.js";
import { useConfirm } from "./ConfirmDialog.js";
import { useNotifs } from "./Notifications.js";
import { SlashMenu, slashOptionId, type SlashMenuItem } from "./SlashMenu.js";
import { commandDisplay, filterCommands, mergeCommands, parseSlashInput, rankByQuery } from "./slashCommands.js";
import { harnessLabel } from "./toolTabs.js";
import { ipcErrorMessage } from "./ipcError.js";

export interface ComposerBackend {
  imageTarget: ImageTarget;
  prefs: ComposerPrefs;
  busy: boolean;
  loadModels(): Promise<ModelOption[]>;
  loadPermissions(): Promise<PermissionOption[]>;
  loadFiles(): Promise<string[]>;
  loadCommands(): Promise<CommandOption[]>;
  savePrefs(prefs: ComposerPrefs): void;
  send(body: string, attachments: string[], command?: CommandInvocation): Promise<void>;
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

const EFFORTS: Array<{ id: EffortLevel; label: string }> = [
  { id: "minimal", label: "Minimal" },
  { id: "low", label: "Low" },
  { id: "medium", label: "Medium" },
  { id: "high", label: "High" },
  { id: "xhigh", label: "XHigh" },
  { id: "max", label: "Max" }
];

const EFFORT_RANK: EffortLevel[] = ["minimal", "low", "medium", "high", "xhigh", "max"];

function effortOptionsFor(driver: DriverName, models: ModelOption[], modelId?: string): Array<{ id: EffortLevel; label: string }> {
  if (driver !== "opencode") return EFFORTS;
  if (!modelId) return EFFORTS;
  const model = models.find((m) => m.id === modelId) ?? models.find((m) => m.id.toLowerCase() === modelId.toLowerCase());
  if (!model || model.variants === undefined) return EFFORTS;
  if (model.variants.length === 0) return EFFORTS.filter((e) => e.id === "high");
  const available = new Set(model.variants.map((v) => v.toLowerCase()));
  return EFFORTS.filter((e) => available.has(e.id) || (e.id === "medium" && available.has("balanced")));
}

function fallbackEffort(current: EffortLevel, available: Array<{ id: EffortLevel; label: string }>): EffortLevel {
  if (available.some((o) => o.id === current)) return current;
  const want = EFFORT_RANK.indexOf(current);
  const below = available.filter((o) => EFFORT_RANK.indexOf(o.id) <= want).sort((a, b) => EFFORT_RANK.indexOf(b.id) - EFFORT_RANK.indexOf(a.id));
  if (below.length > 0) return below[0].id;
  return available[0].id;
}

const FALLBACK_PERMISSIONS: PermissionOption[] = [
  { id: "manual", label: "Supervised", description: "Ask before commands and file changes.", native: true },
  { id: "acceptEdits", label: "Auto-accept edits", description: "Auto-approve edits, ask before other actions.", native: true },
  { id: "auto", label: "Auto", description: "Supported providers approve routine actions; others still ask.", native: true },
  { id: "bypassPermissions", label: "Full Access", description: "Allow commands and edits without prompts.", native: false }
];

function permissionIconFor(id: PermissionMode): ReactNode {
  if (id === "manual") return <Lock size={15} />;
  if (id === "acceptEdits") return <Pencil size={15} />;
  if (id === "bypassPermissions") return <LockOpen size={15} />;
  return <Zap size={15} />;
}

function EffortIcon({ size = 15 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 20 20" fill="none" aria-hidden="true">
      <path d="M3 9h14M7 5.5v6M13 9v5.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  );
}

const IMAGE_EXTS = new Set(["png", "jpg", "jpeg", "webp", "gif"]);

function groupModelsByProvider(models: ModelOption[]): MenuOption[] {
  const groups = new Map<string, ModelOption[]>();
  for (const m of models) {
    const slash = m.id.indexOf("/");
    const provider = slash >= 0 ? m.id.slice(0, slash) : "other";
    const list = groups.get(provider) ?? [];
    list.push(m);
    groups.set(provider, list);
  }
  const out: MenuOption[] = [];
  for (const [provider, list] of [...groups.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    out.push({ id: `__sep:${provider}`, label: provider, separator: true });
    for (const m of list) out.push({ id: m.id, label: m.label, hint: m.id });
  }
  return out;
}

function isImage(path: string): boolean {
  const ext = path.split(".").pop()?.toLowerCase() ?? "";
  return IMAGE_EXTS.has(ext);
}

export function ComposerView({
  backend,
  driver,
  resetKey,
  modelsRefreshKey = 0,
  resetStaleModel = false,
  recipePrefix,
  usageSlot,
  footer,
  blockedReason
}: {
  backend: ComposerBackend;
  driver: DriverName;
  resetKey: string;
  modelsRefreshKey?: number;
  resetStaleModel?: boolean;
  recipePrefix?: ReactNode;
  usageSlot?: ReactNode;
  footer?: ReactNode;
  blockedReason?: string;
}) {
  const { prefs, busy } = backend;
  const backendRef = useRef(backend);
  backendRef.current = backend;
  const imageTarget = backend.imageTarget;
  const [draft, setDraft] = useState("");
  const [attachments, setAttachments] = useState<string[]>([]);
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
  const homeDir = useAppStore((s) => s.homeDir);
  const home = homeDir ?? undefined;
  const composerRef = useRef<HTMLTextAreaElement | null>(null);
  const slashListId = useId();
  const { confirm, dialog: confirmDialog } = useConfirm();
  const [inputFocused, setInputFocused] = useState(false);
  const [driverCommands, setDriverCommands] = useState<CommandOption[] | null>(null);
  const [commandsLoading, setCommandsLoading] = useState(false);
  const [commandsError, setCommandsError] = useState<string | null>(null);
  const [slashDismissed, setSlashDismissed] = useState<string | null>(null);
  const [slashIndex, setSlashIndex] = useState(0);
  const commandsRef = useRef<{ key: string; promise: Promise<CommandsResult>; failed: boolean } | null>(null);
  const commandsKey = `${driver}\n${resetKey}`;
  const commandsKeyRef = useRef(commandsKey);
  commandsKeyRef.current = commandsKey;
  const mountedRef = useRef(true);
  const commandAvailability = {
    newSession: backend.newSession !== undefined,
    rename: backend.rename !== undefined,
    terminal: backend.openTerminal !== undefined
  };

  const autosizeComposer = () => {
    const el = composerRef.current;
    if (!el) return;
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
  };

  useLayoutEffect(() => {
    autosizeComposer();
  }, [draft, resetKey]);

  useEffect(() => {
    const onResize = () => autosizeComposer();
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  useEffect(() => {
    if (backendRef.current.busy) return;
    const frame = requestAnimationFrame(() => {
      try {
        composerRef.current?.focus({ preventScroll: true });
      } catch {
      }
    });
    return () => cancelAnimationFrame(frame);
  }, [resetKey]);

  useEffect(() => {
    setAttachments([]);
    setDraft("");
    setPasteError(null);
    setShowCustom(false);
    setCustomModel("");
    setAddOpen(false);
    setPickerOpen(false);
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
        if (!prefs.model) {
          const last = getLastModel(driver);
          const next = (last && list.some((m) => m.id === last) ? last : undefined) ?? firstDisplayedModelId(driver, list);
          if (next) backendRef.current.savePrefs({ model: next });
          setShowCustom(false);
        } else if (list.some((m) => m.id === prefs.model)) {
          setLastModel(driver, prefs.model);
          setShowCustom(false);
        } else if (resetStaleModel && list.length > 0) {
          const last = getLastModel(driver);
          const next = (last && list.some((m) => m.id === last) ? last : undefined) ?? firstDisplayedModelId(driver, list);
          if (next) backendRef.current.savePrefs({ model: next });
          setShowCustom(false);
        } else {
          setCustomModel(prefs.model);
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
  }, [resetKey, driver, prefs.model, modelsRefreshKey]);

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
  }, [resetKey, driver, modelsRefreshKey]);

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

  const modelValue = showCustom ? "__custom" : (prefs.model ?? "");
  const modelDisplay = showCustom
    ? customModel.trim() || "Custom"
    : (models.find((m) => m.id === prefs.model)?.label ?? "Select model");
  const effortOptions = useMemo(
    () => effortOptionsFor(driver, models, showCustom ? undefined : prefs.model),
    [driver, models, showCustom, prefs.model]
  );
  const effectiveEffort = prefs.effort ?? "medium";
  const effortDisplay = EFFORTS.find((o) => o.id === effectiveEffort)?.label ?? "Medium";

  useEffect(() => {
    if (driver !== "opencode" || showCustom) return;
    if (effortOptions.some((o) => o.id === effectiveEffort)) return;
    backendRef.current.savePrefs({ effort: fallbackEffort(effectiveEffort, effortOptions) });
  }, [driver, showCustom, models, prefs.model, effectiveEffort, effortOptions]);
  useEffect(() => {
    if (!prefs.model || showCustom) return;
    if (!models.some((m) => m.id === prefs.model)) return;
    setLastModel(driver, prefs.model);
  }, [driver, prefs.model, models, showCustom]);
  const permissions = permissionOptions ?? FALLBACK_PERMISSIONS;
  const effectivePermission = prefs.permissionMode ?? "auto";
  const permissionDisplay = permissions.find((o) => o.id === effectivePermission)?.label ?? "Auto";
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

  const clearComposer = () => {
    setDraft("");
    setAttachments([]);
    setPasteError(null);
  };

  const warn = (title: string, message?: string) => {
    useNotifs.getState().push({ kind: "warning", title, message });
  };

  const notifyError = (title: string, err: unknown) => {
    useNotifs.getState().push({ kind: "error", title, message: ipcErrorMessage(err) });
  };

  const focusComposer = () => {
    requestAnimationFrame(() => composerRef.current?.focus({ preventScroll: true }));
  };

  const tagAttachments = (body: string) =>
    attachments.length > 0 ? `${body}${body ? "\n" : ""}${attachments.map((a) => `@${a}`).join("\n")}` : body;

  const applyModel = (value: string) => {
    const wanted = value.toLowerCase();
    const match =
      models.find((m) => m.id === value) ??
      models.find((m) => m.id.toLowerCase() === wanted || m.label.toLowerCase() === wanted);
    if (!match && models.length > 0) {
      warn(`Unknown model: ${value}`, "Pick one from the list, or use Custom… in the model menu.");
      return;
    }
    const id = match?.id ?? value;
    if (match) {
      setShowCustom(false);
      setLastModel(driver, id);
    } else {
      setCustomModel(id);
      setShowCustom(true);
    }
    backendRef.current.savePrefs({ model: id });
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

  const completeCommand = (command: CommandOption) => {
    setDraft(`/${command.name} `);
    focusComposer();
  };

  const runAppCommand = (command: CommandOption, args: string, key: string) => {
    const b = backendRef.current;
    if (command.name === "new" || command.name === "clear") {
      setDraft("");
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
    setSending(true);
    try {
      await b.send(commandDisplay(command.name, args), [], { name: command.name, args });
      if (isCurrent(key)) clearComposer();
    } catch (err) {
      notifyError("Could not send", err);
    } finally {
      setSending(false);
    }
  };

  const sendPlain = (body: string, key: string = commandsKey) => {
    setSending(true);
    void backendRef.current
      .send(tagAttachments(body), attachments)
      .then(() => {
        if (isCurrent(key)) clearComposer();
      })
      .catch((err: unknown) => notifyError("Could not send", err))
      .finally(() => setSending(false));
  };

  const sendSlash = async (body: string): Promise<void> => {
    const key = commandsKey;
    const immediate = parseSlashInput(body, commandList);
    if (immediate) return runCommand(immediate.command, immediate.args, key);
    if (driverCommands !== null) {
      sendPlain(body, key);
      return;
    }
    setSending(true);
    const result = await ensureCommands().finally(() => setSending(false));
    if (!isCurrent(key)) return;
    if (!result.ok) {
      warn("Command list unavailable", `Sent as a regular message: ${result.error}`);
      sendPlain(body, key);
      return;
    }
    const parsed = parseSlashInput(body, mergeCommands(driver, result.list, commandAvailability));
    if (parsed) return runCommand(parsed.command, parsed.args, key);
    sendPlain(body, key);
  };

  const send = () => {
    const body = draft.trim();
    if ((!body && attachments.length === 0) || busy || sending || blockedReason) return;
    if (body.startsWith("/")) {
      void sendSlash(body);
      return;
    }
    sendPlain(body);
  };

  const slashName = SLASH_NAME.exec(draft);
  const slashArg = SLASH_ARG.exec(draft);
  const slashOpen = inputFocused && !busy && !sending && (slashName !== null || slashArg !== null) && slashDismissed !== draft;
  const slashNameOpen = slashOpen && slashName !== null;

  useEffect(() => {
    if (slashNameOpen) void ensureCommands(true);
  }, [slashNameOpen, commandsKey]);

  useEffect(() => {
    setSlashIndex(0);
  }, [draft]);

  const slashEntries: SlashEntry[] = [];
  const argCommand = slashArg ? commandList.find((c) => c.name === slashArg[1]) : undefined;
  const modelArgMode = slashArg?.[1] === "model";
  let argOverflow = false;
  if (slashOpen && slashArg && argCommand) {
    const options = modelArgMode
      ? rankByQuery(models, slashArg[2], (m) => [m.id, m.label]).map((m) => ({
          id: m.id,
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
  const slashMenuLabel = slashArg ? (modelArgMode ? "Models" : "Effort levels") : "Commands";
  const slashError = slashNameOpen
    ? commandsError && `Commands failed to load: ${commandsError}`
    : modelArgMode && modelsError
      ? `Model list failed: ${modelsError}`
      : null;
  const slashEmpty = slashArg
    ? modelArgMode && models.length === 0
      ? "No models available."
      : "No matches."
    : "No matching commands.";
  const pendingArgs = SLASH_PENDING_ARGS.exec(draft);
  const argHint = pendingArgs ? commandList.find((c) => c.name === pendingArgs[1])?.argumentHint : undefined;

  const handleSlashKey = (e: ReactKeyboardEvent<HTMLTextAreaElement>): boolean => {
    if (!slashOpen) return false;
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      setSlashDismissed(draft);
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
    <div className="composer composer-recipe">
      {slashOpen && (
        <SlashMenu
          id={slashListId}
          label={slashMenuLabel}
          items={slashEntries}
          activeIndex={slashActive}
          loading={slashNameOpen && commandsLoading}
          error={slashError || null}
          emptyText={slashEmpty}
          moreText={argOverflow ? "Keep typing to narrow down" : undefined}
          onHover={setSlashIndex}
          onPick={(index) => slashEntries[index]?.accept()}
        />
      )}
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
          <textarea
            ref={composerRef}
            value={draft}
            onChange={(e) => {
              const next = e.target.value;
              setDraft(next);
              if (!next.startsWith("/")) setSlashDismissed(null);
            }}
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
            placeholder={blockedReason ?? "Ask cw-code — @ files, / commands, $ skills"}
            className="composer-input"
            rows={3}
            disabled={busy || sending || blockedReason !== undefined}
            role="combobox"
            aria-expanded={slashOpen}
            aria-autocomplete="list"
            aria-controls={slashOpen ? slashListId : undefined}
            aria-activedescendant={slashOpen && slashActive >= 0 ? slashOptionId(slashListId, slashActive) : undefined}
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
          <MenuSelect
            label="Model"
            icon={<DriverIcon driver={driver} size={15} />}
            title={modelsError ? `Model list failed: ${modelsError}` : "Model"}
            value={modelValue}
            display={modelDisplay}
            isSet={showCustom || !!prefs.model}
            searchable
            searchPlaceholder="Filter models…"
            options={[
              ...(driver === "opencode"
                ? groupModelsByProvider(models)
                : models.map((m) => ({ id: m.id, label: m.label, hint: m.id }))),
              { id: "__custom", label: "Custom…" }
            ]}
            onPick={(v) => {
              if (v === "__custom") {
                setShowCustom(true);
                return;
              }
              setShowCustom(false);
              if (v) setLastModel(driver, v);
              backend.savePrefs({ model: v || undefined });
            }}
          />
        </div>
        {showCustom && (
          <input
            className="field composer-custom"
            placeholder="provider/model or alias"
            aria-label="Custom model"
            value={customModel}
            onChange={(e) => setCustomModel(e.target.value)}
            onBlur={() => {
              const v = customModel.trim();
              if (v) backend.savePrefs({ model: v });
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter") (e.target as HTMLInputElement).blur();
              if (e.key === "Escape") setShowCustom(false);
            }}
          />
        )}
        <div className="recipe-control">
          <MenuSelect
            label="Effort"
            icon={<EffortIcon />}
            title="Effort"
            value={prefs.effort ?? "medium"}
            display={effortDisplay}
            isSet={(prefs.effort ?? "medium") !== "medium"}
            options={effortOptions.map((o) => ({ id: o.id, label: o.label }))}
            onPick={(v) => backend.savePrefs({ effort: v as EffortLevel })}
          />
        </div>
        <div className="recipe-control">
          <MenuSelect
            label="Permission"
            icon={permissionIcon}
            title={permissionsError ? `Permission list failed: ${permissionsError}` : "Permission"}
            value={effectivePermission}
            display={permissionDisplay}
            isSet={effectivePermission !== "auto"}
            options={permissions.map((o) => ({ id: o.id, label: o.label, description: o.description, icon: permissionIconFor(o.id) }))}
            onPick={(v) => backend.savePrefs({ permissionMode: v as PermissionMode })}
          />
        </div>
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
            <Paperclip size={17} />
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
        {usageSlot}
        {busy ? (
          <button
            type="button"
            className="composer-action composer-stop"
            onClick={() => backend.interrupt()}
            title="Stop response"
            aria-label="Stop response"
          >
            <Square size={14} fill="currentColor" />
          </button>
        ) : (
          <button
            type="button"
            className="composer-action composer-send"
            onClick={send}
            disabled={sending || blockedReason !== undefined || (!draft.trim() && attachments.length === 0)}
            title={blockedReason ?? "Send"}
            aria-label="Send"
          >
            <ArrowUp size={18} />
          </button>
        )}
      </div>
    </div>
    {footer}
    {confirmDialog}
    </>
  );
}
