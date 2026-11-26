/** Claude plan windows that limit one model family, mapped to that family as it appears in model ids. */
const MODEL_WINDOW_FAMILIES: Record<string, { family: string; label: string }> = {
  // Despite the generic name, Claude Code labels this window "Fable limit" (its `bve` label map) and a real
  // Fable weekly limit arrived as `usage_limit_reached` with it. Revisit if the CLI reports it for another model.
  seven_day_overage_included: { family: "fable", label: "Fable" },
  seven_day_opus: { family: "opus", label: "Opus" },
  seven_day_sonnet: { family: "sonnet", label: "Sonnet" }
};

/**
 * Claude plan windows that limit one model family rather than the whole account. The Claude driver marks a
 * limit in one of these as `scope: "model"`, so this is the single list for both that and the picker.
 */
export const MODEL_LIMIT_WINDOWS: ReadonlySet<string> = new Set(Object.keys(MODEL_WINDOW_FAMILIES));

/** A model id without its context suffix (`claude-opus-5-5[1m]` → `claude-opus-5-5`), lowercased. */
function baseModelId(modelId: string): string {
  return modelId.trim().toLowerCase().replace(/\[[^\]]*\]$/, "");
}

/** The model family a limit window belongs to, or null for a window that limits the whole account. */
export function limitWindowFamily(window: string | undefined): { family: string; label: string } | null {
  return (window && MODEL_WINDOW_FAMILIES[window]) || null;
}

/**
 * Whether `modelId` is the model that hit the limit: the recorded model itself, or, when the window names a
 * family, any model of that family (aliases such as `fable` and full ids such as `claude-opus-5-5` alike).
 */
export function isLimitedModel(modelId: string, limited: { model?: string; window?: string }): boolean {
  const id = baseModelId(modelId);
  if (!id) return false;
  if (limited.model && id === baseModelId(limited.model)) return true;
  const family = limitWindowFamily(limited.window)?.family;
  return family !== undefined && id.includes(family);
}
