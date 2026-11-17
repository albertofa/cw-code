/** Claude plan windows that limit one model family, mapped to that family as it appears in model ids. */
const MODEL_WINDOW_FAMILIES: Record<string, { family: string; label: string }> = {
  seven_day_overage_included: { family: "fable", label: "Fable" },
  seven_day_opus: { family: "opus", label: "Opus" },
  seven_day_sonnet: { family: "sonnet", label: "Sonnet" }
};

/** The model family a limit window belongs to, or null for a window that limits the whole account. */
export function limitWindowFamily(window: string | undefined): { family: string; label: string } | null {
  return (window && MODEL_WINDOW_FAMILIES[window]) || null;
}

/**
 * Whether `modelId` is the model that hit the limit: the recorded model itself, or, when the window names a
 * family, any model of that family (aliases such as `fable` and full ids such as `claude-opus-5-5` alike).
 */
export function isLimitedModel(modelId: string, limited: { model?: string; window?: string }): boolean {
  const id = modelId.trim().toLowerCase();
  if (!id) return false;
  if (limited.model && id === limited.model.trim().toLowerCase()) return true;
  const family = limitWindowFamily(limited.window)?.family;
  return family !== undefined && id.includes(family);
}
