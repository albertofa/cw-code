import { describe, expect, spyOn, test } from "bun:test";
import { isValidTopic } from "@cw-code/shared/topics";
import { eventTopic } from "./eventTopics.js";

describe("eventTopic", () => {
  test.each([
    ["turn.event", { sessionId: "sess_a", event: {} }, "session/sess_a"],
    ["composer.changed", { sessionId: "sess_a", prefs: {} }, "session/sess_a"],
    ["session.title", { sessionId: "sess_a", title: "t" }, "sidebar"],
    ["git.statusChanged", { sessionId: "sess_a", status: {} }, "git/sess_a"],
    ["fs.changed", { sessionId: "sess_a", dirs: [] }, "files/sess_a"],
    ["session.updated", { id: "sess_a" }, "sidebar"],
    ["projects.changed", { id: "proj_a" }, "sidebar"],
    ["prs.tracked", [], "prs"],
    ["github.runsChanged", [], "github/runs"],
    ["github.ciActivity", {}, "github/runs"],
    ["skills.changed", { skills: [] }, "app"],
    ["devices.changed", [], "app"],
    ["pty.data", { ptyId: "sess_a:shell", data: "x" }, "pty/sess_a:shell"],
    ["pty.exit", { ptyId: "sess_a:shell", token: "pty-1", exitCode: 0 }, "pty/sess_a:shell"]
  ])("routes %s to its topic", (channel, payload, topic) => {
    expect(eventTopic(channel, payload)).toBe(topic);
  });

  test.each([
    ["shutdown.expired"],
    ["settings.changed"],
    ["startup.changed"],
    ["shutdown.changed"],
    ["app.notice"]
  ])("broadcasts %s", (channel) => {
    expect(eventTopic(channel, {})).toBeNull();
  });

  test.each([
    ["turn.event", { sessionId: "", event: {} }],
    ["turn.event", { event: {} }],
    ["composer.changed", null],
    ["pty.data", { data: "x" }]
  ])("gives %s with a missing id a topic nobody can subscribe to", (channel, payload) => {
    const topic = eventTopic(channel, payload);
    expect(topic).not.toBeNull();
    expect(isValidTopic(topic)).toBe(false);
  });

  test("broadcasts an unknown channel and warns once", () => {
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    try {
      expect(eventTopic("mystery.changed", {})).toBeNull();
      expect(eventTopic("mystery.changed", {})).toBeNull();
      expect(warn).toHaveBeenCalledTimes(1);
    } finally {
      warn.mockRestore();
    }
  });
});
