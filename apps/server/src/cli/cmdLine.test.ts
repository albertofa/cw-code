import { describe, expect, it } from "bun:test";
import { batchCommandLine, cmdSwitchLine, quoteBatchArg } from "./cmdLine.js";

describe("quoteBatchArg", () => {
  it("keeps a command separator inside one escaped argument", () => {
    expect(quoteBatchArg("opus&whoami")).toBe('^^^"opus^^^&whoami^^^"');
  });

  it("escapes spaces so a spaced path stays one argument", () => {
    expect(quoteBatchArg("C:\\Users\\John Smith\\plugin")).toBe('^^^"C:\\Users\\John^^^ Smith\\plugin^^^"');
  });

  it("escapes embedded quotes and the backslashes before them", () => {
    expect(quoteBatchArg('a\\"b')).toBe('^^^"a\\\\\\^^^"b^^^"');
  });

  it("doubles trailing backslashes so they do not escape the closing quote", () => {
    expect(quoteBatchArg("dir\\")).toBe('^^^"dir\\\\^^^"');
  });

  it("escapes every other cmd.exe metacharacter", () => {
    expect(quoteBatchArg("%PATH%|<>()^!")).toBe('^^^"^^^%PATH^^^%^^^|^^^<^^^>^^^(^^^)^^^^^^^!^^^"');
  });

  it("quotes an empty argument", () => {
    expect(quoteBatchArg("")).toBe('^^^"^^^"');
  });
});

describe("batchCommandLine", () => {
  it("quotes the batch file and escapes each argument", () => {
    expect(batchCommandLine("C:\\npm dir\\claude.cmd", ["--model", "opus&whoami"])).toBe(
      '"C:\\npm dir\\claude.cmd" ^^^"--model^^^" ^^^"opus^^^&whoami^^^"'
    );
  });

  it("runs the batch file alone when there are no arguments", () => {
    expect(batchCommandLine("C:\\bin\\claude.cmd", [])).toBe('"C:\\bin\\claude.cmd"');
  });
});

describe("cmdSwitchLine", () => {
  it("wraps the command line for cmd.exe /s", () => {
    expect(cmdSwitchLine("/c", "C:\\bin\\claude.cmd", ["-p"])).toBe('/s /c ""C:\\bin\\claude.cmd" ^^^"-p^^^""');
  });
});
