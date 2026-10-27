import { describe, expect, test } from "bun:test";
import { parseServerArgs } from "./args.js";

describe("parseServerArgs", () => {
  test("applies defaults", () => {
    expect(parseServerArgs([])).toEqual({ host: null, port: 0, parentPid: null, legacyUserData: [], allowOrigins: [], launcherId: null, uiDir: null });
  });

  test("parses each flag", () => {
    expect(parseServerArgs(["--host", "0.0.0.0", "--port", "8080", "--parent-pid", "4321", "--legacy-user-data", "/old"])).toEqual({
      host: "0.0.0.0",
      port: 8080,
      parentPid: 4321,
      legacyUserData: ["/old"],
      allowOrigins: [],
      launcherId: null,
      uiDir: null,
    });
  });

  test("accepts the --flag=value form", () => {
    expect(parseServerArgs(["--host=::1", "--port=65535", "--parent-pid=7", "--legacy-user-data=/a=b"])).toEqual({
      host: "::1",
      port: 65535,
      parentPid: 7,
      legacyUserData: ["/a=b"],
      allowOrigins: [],
      launcherId: null,
      uiDir: null,
    });
  });

  test("collects repeated legacy directories in order", () => {
    expect(parseServerArgs(["--legacy-user-data", "/one", "--legacy-user-data=/two"]).legacyUserData).toEqual(["/one", "/two"]);
  });

  test("collects repeated allowed origins in order", () => {
    expect(parseServerArgs(["--allow-origin", "http://localhost:5173", "--allow-origin=https://cw.example"]).allowOrigins).toEqual([
      "http://localhost:5173",
      "https://cw.example",
    ]);
  });

  test("parses the launcher id and the UI directory in both forms", () => {
    expect(parseServerArgs(["--launcher-id", "abc-123", "--ui-dir", "/srv/ui"])).toMatchObject({ launcherId: "abc-123", uiDir: "/srv/ui" });
    expect(parseServerArgs(["--launcher-id=abc-123", "--ui-dir=/srv/ui=dist"])).toMatchObject({ launcherId: "abc-123", uiDir: "/srv/ui=dist" });
  });

  test("rejects missing launcher id and UI directory values", () => {
    expect(() => parseServerArgs(["--launcher-id"])).toThrow("missing value for --launcher-id");
    expect(() => parseServerArgs(["--ui-dir="])).toThrow("missing value for --ui-dir");
  });

  test("rejects unknown flags", () => {
    expect(() => parseServerArgs(["--nope"])).toThrow("unknown flag: --nope");
    expect(() => parseServerArgs(["positional"])).toThrow("unknown flag: positional");
  });

  test.each([
    ["--port", "-1"],
    ["--port", "65536"],
    ["--port", "abc"],
    ["--port", "1.5"],
    ["--parent-pid", "0"],
    ["--parent-pid", "x"],
  ])("rejects %s %s", (flag, value) => {
    expect(() => parseServerArgs([flag!, value!])).toThrow(`invalid value for ${flag}`);
    expect(() => parseServerArgs([`${flag}=${value}`])).toThrow(`invalid value for ${flag}`);
  });

  test("rejects missing values", () => {
    expect(() => parseServerArgs(["--host"])).toThrow("missing value for --host");
    expect(() => parseServerArgs(["--port="])).toThrow("missing value for --port");
  });
});
