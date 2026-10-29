# Hosting cw-code for other devices

A cw-code server can be used from a browser on another device, or from another desktop app
through a remote connection profile. This page covers exposing the server, pairing a device and
what the browser cannot do. The server and shell behaviour is in `AGENTS.md`; quitting and the
background server are in [shutdown.md](shutdown.md).

## What the server exposes

One listener serves everything on the same port:

| Path | What |
| --- | --- |
| `/ws` | the WebSocket every client uses |
| `/api/info` | `{ app, version, protocol }`, no authentication; used to detect version mismatches |
| `/api/stop` | `POST` with the owner token as `Authorization: Bearer`; stops the server |
| anything else | the built web UI as static files (`GET`/`HEAD` only; unknown paths are 404) |

The UI directory is `--ui-dir`, else the `ui/` folder next to the compiled server, else
`apps/ui/dist` when running from source. With none of them the server still works for the
desktop app and `/` answers 404 with a hint to build the UI (`bun --filter @cw-code/ui build`).

There is no built-in TLS: the server speaks plain `http`/`ws`. Put it behind something that
terminates TLS, or keep it on a private network.

## Binding

By default the server listens on `127.0.0.1`. To reach it from another device, set the
bind host (Settings, Remote access; owner only; applies after the server restarts) to the
address to listen on, or `--host` on the command line. A non-loopback host is only accepted
once at least one device token exists, so create a device token first (the desktop app on the server machine can, while bound to
`127.0.0.1`) and then widen the bind. If a non-loopback host from settings cannot be used, the server falls back to
`127.0.0.1`, logs it and tells the shell.

Set "Server address" in the same settings page to the URL other devices use (for example
`https://cw.example.ts.net`). Pairing links are built from it.

## Recommended setups

**Tailscale Serve.** Keep the bind on `127.0.0.1` and let Tailscale terminate TLS and forward:

```sh
tailscale serve --bg http://127.0.0.1:<port>
```

Set the server address to the `https://<machine>.<tailnet>.ts.net` URL it prints. Only devices
on the tailnet reach it. The server does not need a non-loopback bind.

**Reverse proxy (nginx, Caddy).** The server accepts a WebSocket only when its `Origin` is
absent, `file://`, same-origin with the request `Host`, or listed with `--allow-origin`. So the
proxy must pass the original `Host` through and allow the WebSocket upgrade.

nginx:

```nginx
location / {
    proxy_pass http://127.0.0.1:<port>;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
}
```

Caddy keeps the `Host` header and upgrades WebSockets by default:

```caddyfile
cw.example.com {
    reverse_proxy 127.0.0.1:<port>
}
```

If the proxy rewrites `Host` (for example `proxy_set_header Host 127.0.0.1`), every browser
connection is rejected as a cross-origin request; fix the proxy, or list the public origin with
`--allow-origin https://cw.example.com`. Rejected origins are written to the server's stderr and
crash log.

The page's CSP allows `connect-src` to the `Host` the page was loaded from (`ws://` and
`wss://`), so the address in the browser must be the one the proxy forwards.

## Pairing a device

A device token gives full remote control of the machine (terminals, files, sessions), the same
as a shell login. Pair only devices you control, and revoke ones you stop using.

1. On the machine that runs the server, open Settings, Remote access and enter the device's
   name. Only the owner (the desktop app on that machine) can create or revoke devices.
2. The dialog shows the token once, and a pairing link `<server address>/#token=<token>` when
   an address is known (a configured server address, or the page address when opened in a
   browser).
3. Open the link on the new device, or open the server address and paste the token or the
   link on the sign-in screen. The browser removes the token from the address bar and keeps it
   in `localStorage`; it stays signed in across reloads.
4. A desktop app can use the same token: add a remote profile with the server address and the
   token in the connections panel, test it, and switch. The token is stored encrypted when the
   OS offers encryption (otherwise base64-encoded; the panel shows which).

Revoking a device in Settings closes its open connections at once; the browser returns to the
sign-in screen. "Sign out" in a browser forgets the token on that device only.

## Browser limitations

The web UI is the same app as the desktop one with the shell-only and local-only actions
removed.

- No Reveal in file manager, Open folder, data folder or harness trace actions; the server's
  files are not on the browser's machine.
- No native folder picker: choosing a project folder uses a browser that lists the server's
  directories.
- Browsers reserve some shortcuts (for example Ctrl/Cmd+T, W, N, and Ctrl+Tab); those
  never reach the page, so use the in-app equivalents.
- No tray, attention badge or zoom control from the shell; the tab title shows attention.
- Unsaved editor buffers belong to that browser tab; closing the tab warns before discarding.
- Stopping the server is not offered; that is done on the server machine.

## Background server and installs

With "keep server running" on, closing the desktop window leaves `cw-code-server` running
from the install directory. Before installing or uninstalling cw-code by hand, use "Stop
server and quit" from the tray icon. The in-app updater does this itself. Other devices lose
their connection while the server is stopped and reconnect when it is back.
