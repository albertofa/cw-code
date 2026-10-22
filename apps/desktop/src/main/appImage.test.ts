import { describe, expect, it } from "bun:test";
import { resolveAppImageRelaunch } from "./appImage.js";

const mounted = "/tmp/.mount_cw-codeAbC123/cw-code-bin";
const env = { APPIMAGE: "/home/u/cw-code.AppImage", APPDIR: "/tmp/.mount_cw-codeAbC123" };

describe("resolveAppImageRelaunch", () => {
  it("relaunches the AppImage file with the original arguments", () => {
    expect(resolveAppImageRelaunch(env, mounted, [mounted, "--flag", "x"])).toEqual({
      execPath: "/home/u/cw-code.AppImage",
      args: ["--flag", "x"]
    });
  });

  it("returns null outside an AppImage", () => {
    expect(resolveAppImageRelaunch({}, mounted, [mounted])).toBeNull();
    expect(resolveAppImageRelaunch({ APPIMAGE: env.APPIMAGE }, mounted, [mounted])).toBeNull();
    expect(resolveAppImageRelaunch({ APPDIR: env.APPDIR }, mounted, [mounted])).toBeNull();
  });

  it("returns null when the executable is not inside APPDIR", () => {
    expect(resolveAppImageRelaunch(env, "/opt/cw-code/cw-code-bin", ["/opt/cw-code/cw-code-bin"])).toBeNull();
    expect(resolveAppImageRelaunch(env, "/tmp/.mount_cw-codeAbC123-other/bin", [])).toBeNull();
  });
});
