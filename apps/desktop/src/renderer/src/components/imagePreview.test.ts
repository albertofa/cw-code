import { describe, expect, it } from "vitest";
import { splitImageMentions } from "./imagePreview.js";

describe("splitImageMentions", () => {
  it("returns a single text segment when there are no image mentions", () => {
    expect(splitImageMentions("hello\nworld")).toEqual([{ kind: "text", value: "hello\nworld" }]);
    expect(splitImageMentions("")).toEqual([{ kind: "text", value: "" }]);
  });

  it("splits image mention lines into image segments", () => {
    const segments = splitImageMentions("What is on this image\n@.cw/pastes/cw-paste-x.png\nthen more");
    expect(segments).toEqual([
      { kind: "text", value: "What is on this image" },
      { kind: "image", path: ".cw/pastes/cw-paste-x.png" },
      { kind: "text", value: "then more" }
    ]);
  });

  it("handles multiple images and keeps non-image mentions as text", () => {
    const segments = splitImageMentions("@a.png\n@b.webp\n@file.ts");
    expect(segments).toEqual([
      { kind: "image", path: "a.png" },
      { kind: "image", path: "b.webp" },
      { kind: "text", value: "@file.ts" }
    ]);
  });

  it("does not treat image paths embedded mid-line as mentions", () => {
    expect(splitImageMentions("see @shot.png below")).toEqual([
      { kind: "text", value: "see @shot.png below" }
    ]);
  });
});
