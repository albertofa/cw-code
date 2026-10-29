import { describe, expect, test } from "bun:test";
import type { ClientKind } from "@cw-code/contracts";
import { eventAudience } from "./eventAudience.js";

function receivers(channel: string): ClientKind[] {
  const accept = eventAudience(channel);
  const kinds: ClientKind[] = ["desktop-ui", "desktop-shell", "web", "mcp"];
  return kinds.filter((client) => !accept || accept({ clientId: "c", client, auth: { kind: "owner" } }));
}

describe("eventAudience", () => {
  test.each([["settings.changed"], ["shutdown.changed"], ["startup.changed"], ["app.notice"]])("sends %s to every client", (channel) => {
    expect(receivers(channel)).toEqual(["desktop-ui", "desktop-shell", "web"]);
  });

  test.each([["pty.data"], ["shutdown.expired"], ["fs.changed"]])("keeps %s away from the desktop shell", (channel) => {
    expect(receivers(channel)).toEqual(["desktop-ui", "web"]);
  });
});
