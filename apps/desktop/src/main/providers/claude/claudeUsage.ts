import type { ContextUsage, TokenCounts, TurnModelUsage } from "@cw-code/contracts";

export type ClaudeModelUsageSnapshot = Record<string, TokenCounts & { costUsd: number }>;

interface ClaudeResultModelUsage {
  inputTokens?: unknown;
  outputTokens?: unknown;
  cacheReadInputTokens?: unknown;
  cacheCreationInputTokens?: unknown;
  thinkingTokens?: unknown;
  costUSD?: unknown;
  contextWindow?: unknown;
}

interface ClaudeResultUsageIteration {
  input_tokens?: unknown;
  output_tokens?: unknown;
  cache_read_input_tokens?: unknown;
  cache_creation_input_tokens?: unknown;
}

interface ClaudeResultShape {
  modelUsage?: unknown;
  usage?: { iterations?: ClaudeResultUsageIteration[] };
}

function num(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function snapshotOf(entry: unknown): TokenCounts & { costUsd: number } {
  const record = entry !== null && typeof entry === "object" ? (entry as ClaudeResultModelUsage) : {};
  return {
    inputTokens: num(record.inputTokens),
    cacheReadTokens: num(record.cacheReadInputTokens),
    cacheWriteTokens: num(record.cacheCreationInputTokens),
    outputTokens: num(record.outputTokens),
    reasoningTokens: num(record.thinkingTokens),
    costUsd: num(record.costUSD)
  };
}

function contextWindowOf(entry: unknown): number | undefined {
  if (entry === null || typeof entry !== "object") return undefined;
  const window = (entry as ClaudeResultModelUsage).contextWindow;
  return typeof window === "number" && Number.isFinite(window) ? window : undefined;
}

function isZeroDelta(delta: TokenCounts): boolean {
  return (
    delta.inputTokens === 0 &&
    delta.cacheReadTokens === 0 &&
    delta.cacheWriteTokens === 0 &&
    delta.outputTokens === 0 &&
    delta.reasoningTokens === 0
  );
}

function modelReset(current: TokenCounts & { costUsd: number }, previous: (TokenCounts & { costUsd: number }) | undefined): boolean {
  if (!previous) return false;
  return (
    current.inputTokens < previous.inputTokens ||
    current.cacheReadTokens < previous.cacheReadTokens ||
    current.cacheWriteTokens < previous.cacheWriteTokens ||
    current.outputTokens < previous.outputTokens ||
    current.reasoningTokens < previous.reasoningTokens ||
    current.costUsd < previous.costUsd
  );
}

function matchesMainModel(key: string, mainModel: string): boolean {
  return key === mainModel || key.startsWith(mainModel) || mainModel.startsWith(key);
}

function mainModelWindowTokens(modelUsage: Record<string, unknown>, mainModel: string | undefined): number | undefined {
  if (!mainModel) return undefined;
  const matchKey = Object.keys(modelUsage).find((key) => matchesMainModel(key, mainModel));
  return matchKey !== undefined ? contextWindowOf(modelUsage[matchKey]) : undefined;
}

export function claudeTurnUsage(
  prev: ClaudeModelUsageSnapshot,
  result: unknown,
  mainModel?: string
): { usage: TurnModelUsage[]; context?: ContextUsage; next: ClaudeModelUsageSnapshot } {
  const shape = (result !== null && typeof result === "object" ? result : {}) as ClaudeResultShape;
  const rawModelUsage = shape.modelUsage;
  const hasModelUsage = rawModelUsage !== null && typeof rawModelUsage === "object" && !Array.isArray(rawModelUsage);
  if (!hasModelUsage) return { usage: [], next: prev };

  const modelUsage = rawModelUsage as Record<string, unknown>;
  const next: ClaudeModelUsageSnapshot = {};
  const usage: TurnModelUsage[] = [];
  let largestOutputWindowTokens: number | undefined;
  let largestOutputDelta = -Infinity;

  for (const [model, entry] of Object.entries(modelUsage)) {
    const current = snapshotOf(entry);
    next[model] = current;
    const previous = prev[model];
    const reset = modelReset(current, previous);
    const delta: TokenCounts = reset
      ? {
          inputTokens: current.inputTokens,
          cacheReadTokens: current.cacheReadTokens,
          cacheWriteTokens: current.cacheWriteTokens,
          outputTokens: current.outputTokens,
          reasoningTokens: current.reasoningTokens
        }
      : {
          inputTokens: current.inputTokens - (previous?.inputTokens ?? 0),
          cacheReadTokens: current.cacheReadTokens - (previous?.cacheReadTokens ?? 0),
          cacheWriteTokens: current.cacheWriteTokens - (previous?.cacheWriteTokens ?? 0),
          outputTokens: current.outputTokens - (previous?.outputTokens ?? 0),
          reasoningTokens: current.reasoningTokens - (previous?.reasoningTokens ?? 0)
        };
    if (isZeroDelta(delta)) continue;
    const costUsd = reset ? current.costUsd : current.costUsd - (previous?.costUsd ?? 0);
    usage.push({ model, ...delta, costUsd });
    if (delta.outputTokens > largestOutputDelta) {
      largestOutputDelta = delta.outputTokens;
      largestOutputWindowTokens = contextWindowOf(entry);
    }
  }

  const windowTokens = mainModelWindowTokens(modelUsage, mainModel) ?? largestOutputWindowTokens;

  const iterations = shape.usage?.iterations;
  const lastIteration = Array.isArray(iterations) ? iterations[iterations.length - 1] : undefined;
  const usedTokens = lastIteration
    ? num(lastIteration.input_tokens) +
      num(lastIteration.cache_read_input_tokens) +
      num(lastIteration.cache_creation_input_tokens) +
      num(lastIteration.output_tokens)
    : undefined;

  const context: ContextUsage | undefined =
    usedTokens !== undefined && windowTokens !== undefined ? { usedTokens, windowTokens } : undefined;

  return { usage, ...(context ? { context } : {}), next };
}
