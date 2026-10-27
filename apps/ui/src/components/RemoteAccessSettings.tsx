import { useCallback, useEffect, useState, type FormEvent } from "react";
import type { DeviceInfo } from "@cw-code/contracts";
import { isLoopbackHost, pairingLink } from "@cw-code/shared/serverAddress";
import { useDevicesStore, viewerIsOwner, watchDevices } from "../stores/devicesStore.js";
import { useSettingsDraftStore } from "../stores/settingsDraftStore.js";
import { useConfirm } from "./ConfirmDialog.js";
import { errorMessage } from "./errorMessage.js";
import { PairDeviceDialog } from "./PairDeviceDialog.js";
import { relativeTime } from "./prDetailModel.js";
import { SettingsGroup, SettingsPageHead, SettingsRow } from "./SettingsLayout.js";

const UNREACHABLE_NOTICE =
  "Other devices can't reach this server yet. Set up Tailscale Serve or a reverse proxy (docs/operations/hosting.md) and enter its address above.";
const NO_ADDRESS_NOTICE = "Enter the server address above to get a pairing link.";

interface Pairing {
  name: string;
  token: string;
  link: string | null;
  notice: string | null;
}

function pageOrigin(): string | null {
  const { protocol, origin } = window.location;
  return protocol === "http:" || protocol === "https:" ? origin : null;
}

function pairingTarget(publicUrl: string, bindHost: string): { base: string | null; notice: string | null } {
  if (publicUrl) return { base: publicUrl, notice: null };
  const base = pageOrigin();
  if (base) return { base, notice: null };
  return { base: null, notice: isLoopbackHost(bindHost || "127.0.0.1") ? UNREACHABLE_NOTICE : NO_ADDRESS_NOTICE };
}

function DeviceRow({ device, now, canRevoke, onRevoke }: { device: DeviceInfo; now: number; canRevoke: boolean; onRevoke: (device: DeviceInfo) => void }) {
  const lastSeen = device.lastSeenAt === null ? "never" : relativeTime(device.lastSeenAt, now);
  return (
    <li className="sp-list-row">
      <div className="sp-list-main">
        <b>
          {device.name} {device.current && <span className="sp-tag custom">this device</span>}{" "}
          {device.connected && <span className="sp-tag">connected</span>}
        </b>
        <span className="sp-mono">
          Created {relativeTime(device.createdAt, now)} · last seen {lastSeen}
        </span>
      </div>
      {canRevoke && (
        <button type="button" className="btn sp-btn-sm" onClick={() => onRevoke(device)}>
          Revoke
        </button>
      )}
    </li>
  );
}

export function RemoteAccessSettings() {
  const draft = useSettingsDraftStore((s) => s.draft);
  const saved = useSettingsDraftStore((s) => s.saved);
  const set = useSettingsDraftStore((s) => s.set);
  const devices = useDevicesStore((s) => s.devices);
  const loadError = useDevicesStore((s) => s.error);
  const createDevice = useDevicesStore((s) => s.create);
  const revokeDevice = useDevicesStore((s) => s.revoke);
  const { confirm, dialog: confirmDialog } = useConfirm();
  const [name, setName] = useState("");
  const [creating, setCreating] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [pairing, setPairing] = useState<Pairing | null>(null);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => watchDevices(), []);

  useEffect(() => {
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 60_000);
    return () => window.clearInterval(timer);
  }, [devices]);

  const closePairing = useCallback(() => setPairing(null), []);

  if (!draft) return null;
  const owner = viewerIsOwner(devices);
  const canManage = owner === true;

  const pair = async (e: FormEvent) => {
    e.preventDefault();
    const trimmed = name.trim();
    if (!trimmed) return;
    setCreating(true);
    setActionError(null);
    try {
      const result = await createDevice(trimmed);
      const target = pairingTarget(saved?.serverPublicUrl ?? "", saved?.serverBindHost ?? "");
      setPairing({
        name: result.device.name,
        token: result.token,
        link: target.base ? pairingLink(target.base, result.token) : null,
        notice: target.notice
      });
      setName("");
    } catch (err) {
      setActionError(errorMessage(err) || "Could not pair the device");
    } finally {
      setCreating(false);
    }
  };

  const revoke = async (device: DeviceInfo) => {
    const ok = await confirm({
      title: `Revoke ${device.name}?`,
      message: device.current
        ? "This is the device you're using. This window will disconnect and must sign in again with another token."
        : "The device is disconnected and its token stops working.",
      confirmLabel: "Revoke",
      danger: true
    });
    if (!ok) return;
    setActionError(null);
    try {
      await revokeDevice(device.id);
    } catch (err) {
      setActionError(errorMessage(err) || "Could not revoke the device");
    }
  };

  return (
    <>
      <SettingsPageHead title="Remote access" description="Pair other devices and choose how they reach this server." />
      {owner === false && <p className="sp-hint">Only the computer that runs the server can change these settings or manage devices.</p>}

      <SettingsGroup title="Server">
        <SettingsRow label="Server address" hint="The address other devices use, e.g. your Tailscale or reverse-proxy URL." htmlFor="sp-public-url">
          <input
            id="sp-public-url"
            className="field sp-mono-field"
            type="url"
            placeholder="https://my-machine.tailnet.ts.net"
            value={draft.serverPublicUrl}
            disabled={!canManage}
            onChange={(e) => set({ serverPublicUrl: e.target.value })}
          />
        </SettingsRow>
        <SettingsRow
          label="Bind host"
          hint="Applies after the server restarts. Empty listens on 127.0.0.1; a non-loopback host needs a paired device first."
          htmlFor="sp-bind-host"
        >
          <input
            id="sp-bind-host"
            className="field sp-mono-field"
            type="text"
            placeholder="127.0.0.1"
            value={draft.serverBindHost}
            disabled={!canManage}
            onChange={(e) => set({ serverBindHost: e.target.value })}
          />
        </SettingsRow>
      </SettingsGroup>

      <SettingsGroup title="Paired devices">
        {devices === null && !loadError && <p className="sp-hint">Loading devices…</p>}
        {loadError && (
          <div className="settings-error" role="alert">
            {loadError}
          </div>
        )}
        {devices !== null && devices.length === 0 && <p className="sp-hint">No devices are paired yet.</p>}
        {devices !== null && devices.length > 0 && (
          <ul className="sp-list">
            {devices.map((device) => (
              <DeviceRow key={device.id} device={device} now={now} canRevoke={canManage} onRevoke={(d) => void revoke(d)} />
            ))}
          </ul>
        )}
        {canManage && (
          <form className="sp-inline-confirm" onSubmit={(e) => void pair(e)}>
            <input
              className="field"
              type="text"
              placeholder="Device name, e.g. Work laptop"
              aria-label="Device name"
              maxLength={64}
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
            <button type="submit" className="btn btn-primary" disabled={creating || name.trim() === ""}>
              {creating ? "Pairing…" : "Pair a device"}
            </button>
          </form>
        )}
        {actionError && (
          <div className="settings-error" role="alert">
            {actionError}
          </div>
        )}
      </SettingsGroup>
      {pairing && <PairDeviceDialog deviceName={pairing.name} token={pairing.token} link={pairing.link} notice={pairing.notice} onClose={closePairing} />}
      {confirmDialog}
    </>
  );
}
