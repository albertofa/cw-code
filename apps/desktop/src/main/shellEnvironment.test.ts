import { describe, expect, it } from "bun:test";
import { mergeLoginEnv, parseMarkedEnv, sanitizedChildEnv } from "./shellEnvironment.js";

const MARKER = "__MARK__";

function wrap(body: string): string {
  return `motd noise\n${MARKER}_START\n${body}\n${MARKER}_END\ntrailing`;
}

describe("parseMarkedEnv", () => {
  it("parses KEY=VALUE lines between the markers and ignores surrounding output", () => {
    expect(parseMarkedEnv(wrap("PATH=/a:/b\nHOME=/home/me\nEMPTY="), MARKER)).toEqual({
      PATH: "/a:/b",
      HOME: "/home/me",
      EMPTY: ""
    });
  });

  it("keeps equals signs inside values", () => {
    expect(parseMarkedEnv(wrap("LS_COLORS=di=01;34:ln=01;36"), MARKER)).toEqual({ LS_COLORS: "di=01;34:ln=01;36" });
  });

  it("joins continuation lines of multi-line values", () => {
    expect(parseMarkedEnv(wrap("A=first\nsecond\nB=1"), MARKER)).toEqual({ A: "first\nsecond", B: "1" });
  });

  it("handles CRLF output", () => {
    expect(parseMarkedEnv(wrap("A=1\r\nB=2").replace(/\n/g, "\r\n"), MARKER)).toEqual({ A: "1", B: "2" });
  });

  it("returns null when a marker is missing", () => {
    expect(parseMarkedEnv("PATH=/a", MARKER)).toBeNull();
    expect(parseMarkedEnv(`${MARKER}_START\nPATH=/a`, MARKER)).toBeNull();
    expect(parseMarkedEnv(`PATH=/a\n${MARKER}_END`, MARKER)).toBeNull();
  });

  it("returns an empty record for empty marked output", () => {
    expect(parseMarkedEnv(`${MARKER}_START\n${MARKER}_END`, MARKER)).toEqual({});
  });
});

describe("mergeLoginEnv", () => {
  it("puts login PATH entries first, then current entries not already present", () => {
    const merged = mergeLoginEnv({ PATH: "/usr/bin:/bin:/extra" }, { PATH: "/home/me/.local/bin:/usr/bin" });
    expect(merged.PATH).toBe("/home/me/.local/bin:/usr/bin:/bin:/extra");
  });

  it("uses the login PATH when the current one is missing", () => {
    expect(mergeLoginEnv({}, { PATH: "/a:/b" }).PATH).toBe("/a:/b");
  });

  it("keeps the current PATH when the login shell reports none", () => {
    expect(mergeLoginEnv({ PATH: "/usr/bin" }, {}).PATH).toBe("/usr/bin");
  });

  it("copies session variables only when missing", () => {
    const merged = mergeLoginEnv(
      { SSH_AUTH_SOCK: "/current/agent", XDG_DATA_HOME: "" },
      {
        SSH_AUTH_SOCK: "/login/agent",
        DBUS_SESSION_BUS_ADDRESS: "unix:path=/run/user/1000/bus",
        XDG_DATA_HOME: "/home/me/.local/share",
        XDG_RUNTIME_DIR: "/run/user/1000",
        WAYLAND_DISPLAY: "wayland-0",
        SSL_CERT_FILE: "/etc/ssl/cert.pem",
        SSL_CERT_DIR: "/etc/ssl/certs",
        NODE_EXTRA_CA_CERTS: "/etc/ssl/extra.pem"
      }
    );
    expect(merged).toMatchObject({
      SSH_AUTH_SOCK: "/current/agent",
      DBUS_SESSION_BUS_ADDRESS: "unix:path=/run/user/1000/bus",
      XDG_DATA_HOME: "/home/me/.local/share",
      XDG_RUNTIME_DIR: "/run/user/1000",
      WAYLAND_DISPLAY: "wayland-0",
      SSL_CERT_FILE: "/etc/ssl/cert.pem",
      SSL_CERT_DIR: "/etc/ssl/certs",
      NODE_EXTRA_CA_CERTS: "/etc/ssl/extra.pem"
    });
  });

  it("copies proxy variables in both cases only when missing", () => {
    const merged = mergeLoginEnv(
      { https_proxy: "http://current:3128" },
      {
        HTTP_PROXY: "http://login:3128",
        https_proxy: "http://login:3128",
        NO_PROXY: "localhost",
        no_proxy: "localhost",
        ALL_PROXY: "socks5://login:1080"
      }
    );
    expect(merged).toMatchObject({
      HTTP_PROXY: "http://login:3128",
      https_proxy: "http://current:3128",
      NO_PROXY: "localhost",
      no_proxy: "localhost",
      ALL_PROXY: "socks5://login:1080"
    });
  });

  it("ignores other login variables and does not mutate the input", () => {
    const current = { PATH: "/usr/bin", HOME: "/home/me" };
    const merged = mergeLoginEnv(current, { PATH: "/a", HOME: "/other", EDITOR: "vim" });
    expect(merged.HOME).toBe("/home/me");
    expect(merged.EDITOR).toBeUndefined();
    expect(current).toEqual({ PATH: "/usr/bin", HOME: "/home/me" });
  });
});

describe("sanitizedChildEnv", () => {
  const appImageEnv: NodeJS.ProcessEnv = {
    APPIMAGE: "/home/me/cw-code.AppImage",
    APPDIR: "/tmp/.mount_cw-abc",
    ARGV0: "cw-code",
    OWD: "/home/me",
    CHROME_DESKTOP: "cw-code.desktop",
    HOME: "/home/me",
    PATH: "/tmp/.mount_cw-abc/usr/bin:/usr/bin:/tmp/.mount_cw-abc:/bin",
    LD_LIBRARY_PATH: "/tmp/.mount_cw-abc/usr/lib:/opt/lib",
    XDG_DATA_DIRS: "/tmp/.mount_cw-abc/usr/share:/usr/share",
    GSETTINGS_SCHEMA_DIR: "/tmp/.mount_cw-abc/usr/share/glib-2.0/schemas"
  };

  it("removes AppImage markers and mount entries on linux", () => {
    expect(sanitizedChildEnv(appImageEnv, "linux")).toEqual({
      HOME: "/home/me",
      PATH: "/usr/bin:/bin",
      LD_LIBRARY_PATH: "/opt/lib",
      XDG_DATA_DIRS: "/usr/share"
    });
  });

  it("does not treat sibling directories sharing the prefix as mount entries", () => {
    const env = sanitizedChildEnv(
      { APPIMAGE: "/x.AppImage", APPDIR: "/tmp/.mount_cw", PATH: "/tmp/.mount_cw2/bin:/tmp/.mount_cw/bin" },
      "linux"
    );
    expect(env.PATH).toBe("/tmp/.mount_cw2/bin");
  });

  it("tolerates a trailing slash on APPDIR", () => {
    const env = { APPIMAGE: "/x.AppImage", APPDIR: "/tmp/.mount_cw/", PATH: "/tmp/.mount_cw/bin:/usr/bin" };
    expect(sanitizedChildEnv(env, "linux").PATH).toBe("/usr/bin");
  });

  it("keeps path entries under APPDIR when APPIMAGE is not set", () => {
    const env = sanitizedChildEnv({ APPDIR: "/opt/app", PATH: "/opt/app/bin:/usr/bin" }, "linux");
    expect(env.PATH).toBe("/opt/app/bin:/usr/bin");
    expect(env.APPDIR).toBeUndefined();
  });

  it("leaves linux environments without AppImage markers unchanged", () => {
    const env = { HOME: "/home/me", PATH: "/usr/bin" };
    expect(sanitizedChildEnv(env, "linux")).toEqual(env);
  });

  it("returns an unchanged copy on other platforms", () => {
    for (const platform of ["darwin", "win32"] as const) {
      const result = sanitizedChildEnv(appImageEnv, platform);
      expect(result).toEqual(appImageEnv);
      expect(result).not.toBe(appImageEnv);
    }
  });
});
