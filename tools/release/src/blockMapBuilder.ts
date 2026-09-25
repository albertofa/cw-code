import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import type { BlockMapBuilder } from "./rehash.ts";

export interface ElectronBuilderBlockMap {
  build: BlockMapBuilder;
  appBuilderLibVersion: string;
  electronBuilderVersion: string;
}

type RawBuildBlockMap = (inFile: string, compressionFormat: "gzip", outFile: string) => Promise<unknown>;

function readVersion(packageJsonPath: string): string {
  const parsed = JSON.parse(readFileSync(packageJsonPath, "utf8")) as { version?: unknown };
  if (typeof parsed.version !== "string") throw new Error(`${packageJsonPath} has no string "version" field`);
  return parsed.version;
}

function toDigest(value: unknown): { sha512: string; size: number } {
  if (typeof value !== "object" || value === null) throw new Error("buildBlockMap returned a non-object result");
  const { sha512, size } = value as { sha512?: unknown; size?: unknown };
  if (typeof sha512 !== "string" || typeof size !== "number") {
    throw new Error("buildBlockMap result is missing string sha512 or numeric size");
  }
  return { sha512, size };
}

export function loadElectronBuilderBlockMap(desktopPackageJson: string): ElectronBuilderBlockMap {
  const fromDesktop = createRequire(desktopPackageJson);
  const electronBuilderPackageJson = fromDesktop.resolve("electron-builder/package.json");
  const fromElectronBuilder = createRequire(electronBuilderPackageJson);
  const appBuilderLibPackageJson = fromElectronBuilder.resolve("app-builder-lib/package.json");
  const moduleValue: unknown = fromElectronBuilder(join(dirname(appBuilderLibPackageJson), "out/targets/blockmap/blockmap.js"));
  const candidate = (moduleValue as { buildBlockMap?: unknown } | null)?.buildBlockMap;
  if (typeof candidate !== "function") {
    throw new Error(`app-builder-lib at ${dirname(appBuilderLibPackageJson)} does not export buildBlockMap`);
  }
  const buildBlockMap = candidate as RawBuildBlockMap;
  return {
    build: async (installerPath, blockMapPath) => toDigest(await buildBlockMap(installerPath, "gzip", blockMapPath)),
    appBuilderLibVersion: readVersion(appBuilderLibPackageJson),
    electronBuilderVersion: readVersion(electronBuilderPackageJson)
  };
}
