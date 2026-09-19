import { describe, expect, it } from "vitest";
import { displayImagePath, splitImageMentions } from "./imagePreview.js";

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

  it("splits absolute central attachment mention lines into image segments", () => {
    const segments = splitImageMentions(
      "look\n@/home/tester/.cw-code/userdata/attachments/cw-paste-x.png\n@C:\\Users\\tester\\.cw-code\\userdata\\attachments\\cw-paste-y.png"
    );
    expect(segments).toEqual([
      { kind: "text", value: "look" },
      { kind: "image", path: "/home/tester/.cw-code/userdata/attachments/cw-paste-x.png" },
      { kind: "image", path: "C:\\Users\\tester\\.cw-code\\userdata\\attachments\\cw-paste-y.png" }
    ]);
  });
});

describe("displayImagePath", () => {
  it("shortens paths inside the home dir", () => {
    expect(displayImagePath("/home/tester/.cw-code/userdata/attachments/a.png", "/home/tester")).toBe(
      "~/.cw-code/userdata/attachments/a.png"
    );
    expect(
      displayImagePath("C:\\Users\\tester\\.cw-code\\userdata\\attachments\\a.png", "C:\\Users\\tester")
    ).toBe("~/.cw-code/userdata/attachments/a.png");
  });

  it("leaves other paths and missing home dirs unchanged", () => {
    expect(displayImagePath("/other/place/a.png", "/home/tester")).toBe("/other/place/a.png");
    expect(displayImagePath("/home/tester/a.png")).toBe("/home/tester/a.png");
  });
});
