import { describe, expect, it } from "vitest";
import { insertDictation } from "./dictationText.js";

describe("insertDictation", () => {
  it("fills an empty draft", () => {
    expect(insertDictation("", "olá mundo", 0, 0)).toEqual({ value: "olá mundo", caret: 9 });
  });

  it("appends after existing text with a single space", () => {
    expect(insertDictation("corrige o bug", "no login", 13, 13)).toEqual({ value: "corrige o bug no login", caret: 22 });
  });

  it("does not double a space that is already there", () => {
    expect(insertDictation("corrige ", "o bug", 8, 8).value).toBe("corrige o bug");
  });

  it("inserts in the middle and keeps the words after it apart", () => {
    const result = insertDictation("abre o arquivo", "novo", 7, 7);
    expect(result.value).toBe("abre o novo arquivo");
    expect(result.caret).toBe("abre o novo ".length);
  });

  it("replaces the selected text", () => {
    expect(insertDictation("troca isto aqui", "aquilo", 6, 11).value).toBe("troca aquilo aqui");
  });

  it("ignores blank transcripts", () => {
    expect(insertDictation("texto", "   \n", 5, 5)).toEqual({ value: "texto", caret: 5 });
  });

  it("clamps a stale selection to the draft", () => {
    expect(insertDictation("abc", "d", 99, 120)).toEqual({ value: "abc d", caret: 5 });
  });
});
