import type { ModelMeta, ModelOption } from "@cw-code/contracts";
import { labelForModel } from "../opencodeModels.js";

function asRecord(value: unknown): Record<string, unknown> | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function asString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function nonNegative(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function stringList(value: unknown): string[] | undefined {
  const list = Array.isArray(value) ? value.filter((v): v is string => typeof v === "string" && v.length > 0) : [];
  return list.length > 0 ? list : undefined;
}

function metaOf(model: Record<string, unknown>): ModelMeta | undefined {
  const capabilities = asRecord(model["capabilities"]) ?? {};
  const tier = asRecord(Array.isArray(model["cost"]) ? model["cost"][0] : undefined) ?? {};
  const input = stringList(capabilities["input"]);
  const flags = [
    capabilities["reasoning"] === true ? "Reasoning" : "",
    capabilities["tools"] === true ? "Tool calling" : "",
    input?.some((kind) => kind !== "text") ? "Attachments" : ""
  ].filter(Boolean);
  const meta: ModelMeta = {
    costInputPerM: nonNegative(tier["input"]),
    costOutputPerM: nonNegative(tier["output"]),
    capabilities: flags.length > 0 ? flags : undefined,
    input,
    output: stringList(capabilities["output"])
  };
  const defined = Object.fromEntries(Object.entries(meta).filter(([, value]) => value !== undefined)) as ModelMeta;
  return Object.keys(defined).length > 0 ? defined : undefined;
}

export function mapV2Models(payload: unknown): ModelOption[] {
  const data = asRecord(payload)?.["data"];
  const out: ModelOption[] = [];
  const seen = new Set<string>();
  for (const entry of Array.isArray(data) ? data : []) {
    const model = asRecord(entry);
    if (!model || model["enabled"] === false) continue;
    const providerID = asString(model["providerID"]);
    const modelID = asString(model["id"]);
    if (!providerID || !modelID) continue;
    const id = `${providerID}/${modelID}`;
    if (seen.has(id)) continue;
    seen.add(id);
    const variants = (Array.isArray(model["variants"]) ? model["variants"] : [])
      .map((variant) => asString(asRecord(variant)?.["id"]))
      .filter((variant) => variant.length > 0);
    const context = nonNegative(asRecord(model["limit"])?.["context"]);
    const meta = metaOf(model);
    out.push({
      id,
      label: asString(model["name"]) || labelForModel(id),
      source: "live",
      variants,
      ...(context ? { contextWindow: context } : {}),
      ...(meta ? { meta } : {})
    });
  }
  return out.sort((a, b) => a.id.localeCompare(b.id));
}
