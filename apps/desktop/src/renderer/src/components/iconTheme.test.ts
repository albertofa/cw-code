import { describe, expect, it } from "bun:test";
import manifest from "material-icon-theme/dist/material-icons.json";
import { iconFileName, resolveIconName, type IconManifest } from "./iconTheme.js";

const theme = manifest as unknown as IconManifest;
const file = (name: string) => resolveIconName(theme, name, false, false, false);
const folder = (name: string, expanded = false) => resolveIconName(theme, name, true, expanded, false);

describe("resolveIconName", () => {
  it("maps languages to their VS Code Material icons", () => {
    expect(file("loader.ts")).toBe("typescript");
    expect(file("index.tsx")).toBe("react_ts");
    expect(file("main.js")).toBe("javascript");
    expect(file("DynamoDbService.cs")).toBe("csharp");
    expect(file("style.css")).toBe("css");
  });

  it("prefers the longest compound extension", () => {
    expect(file("Home.stories.tsx")).toBe("storybook");
    expect(file("types.d.ts")).toBe("typescript-def");
    expect(file("api.test.ts")).toBe("test-ts");
  });

  it("matches well-known file names case-insensitively", () => {
    expect(file("package.json")).toBe("nodejs");
    expect(file("Dockerfile")).toBe("docker");
    expect(file("router.tsx")).toBe("routing");
  });

  it("falls back to the generic file icon", () => {
    expect(file("LICENSE.unknownext")).toBe(theme.file);
  });

  it("maps folder names with open and closed variants", () => {
    expect(folder("components")).toBe("folder-components");
    expect(folder("components", true)).toBe("folder-components-open");
    expect(folder("Services")).toBe("folder-controller");
    expect(folder("whatever")).toBe(theme.folder);
    expect(folder("whatever", true)).toBe(theme.folderExpanded);
  });
});

describe("iconFileName", () => {
  it("resolves icon ids to the shipped svg file names", () => {
    expect(iconFileName(theme, "typescript")).toBe("typescript");
    expect(iconFileName(theme, "folder-components-open")).toBe("folder-components-open");
    expect(iconFileName(theme, "missing-icon-id")).toBeNull();
  });
});
