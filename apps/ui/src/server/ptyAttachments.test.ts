import { describe, expect, it } from "bun:test";
import { createPtyAttachments, type PtyOpenResult } from "./ptyAttachments.js";

const PTY_ID = "sess_a:shell";

const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

function harness() {
  const wire: string[] = [];
  const resolvers: Array<() => void> = [];
  const attachments = createPtyAttachments((ptyId) => wire.push(`detach ${ptyId}`));
  const open = (): Promise<PtyOpenResult> =>
    attachments.open(() => {
      wire.push("open");
      return new Promise<PtyOpenResult>((resolve) => {
        resolvers.push(() => resolve({ ptyId: PTY_ID, token: "pty-1", replay: "" }));
      });
    });
  const resolveNext = async (): Promise<void> => {
    resolvers.shift()?.();
    await tick();
  };
  return { attachments, wire, open, resolveNext };
}

describe("createPtyAttachments", () => {
  it("sends the detach before a reopen in the same tick", async () => {
    const { attachments, wire, open, resolveNext } = harness();
    const first = open();
    await resolveNext();
    await first;
    attachments.detach(PTY_ID);
    const second = open();
    await resolveNext();
    await second;
    await tick();
    expect(wire).toEqual(["open", `detach ${PTY_ID}`, "open"]);
  });

  it("keeps the attachment when a StrictMode remount's first open resolves after its cleanup", async () => {
    const { attachments, wire, open, resolveNext } = harness();
    const first = open();
    const second = open();
    await resolveNext();
    attachments.detach((await first).ptyId);
    await resolveNext();
    await second;
    await tick();
    expect(wire).toEqual(["open", "open"]);
  });

  it("defers a detach while an open is in flight and sends it once nothing holds the terminal", async () => {
    const { attachments, wire, open, resolveNext } = harness();
    const first = open();
    await resolveNext();
    await first;
    const pending = open().then((result) => attachments.detach(result.ptyId));
    attachments.detach(PTY_ID);
    expect(wire).toEqual(["open", "open"]);
    await resolveNext();
    await pending;
    await tick();
    expect(wire).toEqual(["open", "open", `detach ${PTY_ID}`]);
  });

  it("keeps one hold across a reattach so a single detach releases the terminal", async () => {
    const { attachments, wire, open, resolveNext } = harness();
    const first = open();
    await resolveNext();
    await first;
    const reattached = await attachments.reattach(async () => {
      wire.push("reattach");
      return { ptyId: PTY_ID, token: "pty-1", replay: "again" };
    });
    expect(reattached?.replay).toBe("again");
    attachments.detach(PTY_ID);
    await tick();
    expect(wire).toEqual(["open", "reattach", `detach ${PTY_ID}`]);
  });

  it("defers a detach until an in-flight reattach settles", async () => {
    const { attachments, wire, open, resolveNext } = harness();
    const first = open();
    await resolveNext();
    await first;
    let finish: (result: PtyOpenResult | null) => void = () => {};
    const reattached = attachments.reattach(
      () =>
        new Promise<PtyOpenResult | null>((resolve) => {
          finish = resolve;
        })
    );
    attachments.detach(PTY_ID);
    expect(wire).toEqual(["open"]);
    finish(null);
    expect(await reattached).toBeNull();
    await tick();
    expect(wire).toEqual(["open", `detach ${PTY_ID}`]);
  });
});
