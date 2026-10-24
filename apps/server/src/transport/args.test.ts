import { describe, expect, test } from "bun:test";
import { parseServerArgs } from "./args.js";

describe("parseServerArgs", () => {
  test("applies defaults", () => {
    expect(parseServerArgs([])).toEqual({ host: "127.0.0.1", port: 0, parentPid: null, legacyUserData: [] });
  });

  test("parses each flag", () => {
    expect(parseServerArgs(["--host", "0.0.0.0", "--port", "8080", "--parent-pid", "4321", "--legacy-user-data", "/old"])).toEqual({
      host: "0.0.0.0",
      port: 8080,
      parentPid: 4321,
      legacyUserData: ["/old"],
    });
  });

  test("accepts the --flag=value form", () => {
    expect(parseServerArgs(["--host=::1", "--port=65535", "--parent-pid=7", "--legacy-user-data=/a=b"])).toEqual({
      host: "::1",
      port: 65535,
      parentPid: 7,
      legacyUserData: ["/a=b"],
    });
  });

  test("collects repeated legacy directories in order", () => {
    expect(parseServerArgs(["--legacy-user-data", "/one", "--legacy-user-data=/two"]).legacyUserData).toEqual(["/one", "/two"]);
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
