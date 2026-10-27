import { create } from "zustand";
import type { DeviceCreateResult, DeviceInfo } from "@cw-code/contracts";
import { APP_TOPIC } from "@cw-code/shared/topics";
import { errorMessage } from "../components/errorMessage.js";
import { acquireTopic, onConnectionEpoch } from "../server/topics.js";

interface DevicesState {
  devices: DeviceInfo[] | null;
  error: string | null;
  load: () => Promise<void>;
  apply: (devices: DeviceInfo[]) => void;
  create: (name: string) => Promise<DeviceCreateResult>;
  revoke: (id: string) => Promise<void>;
}

let changeSeq = 0;

export const useDevicesStore = create<DevicesState>((set, get) => ({
  devices: null,
  error: null,
  load: async () => {
    const startedAt = changeSeq;
    try {
      const devices = await window.cw.devices.list();
      if (startedAt === changeSeq) get().apply(devices);
    } catch (err) {
      if (startedAt === changeSeq) set({ error: errorMessage(err) || "Could not load paired devices" });
    }
  },
  apply: (devices) => {
    changeSeq += 1;
    set({ devices, error: null });
  },
  create: async (name) => {
    const result = await window.cw.devices.create(name);
    const devices = get().devices ?? [];
    if (!devices.some((device) => device.id === result.device.id)) get().apply([...devices, result.device]);
    return result;
  },
  revoke: async (id) => {
    await window.cw.devices.revoke(id);
    get().apply((get().devices ?? []).filter((device) => device.id !== id));
  }
}));

export function watchDevices(): () => void {
  const { load, apply } = useDevicesStore.getState();
  const release = acquireTopic(APP_TOPIC);
  const offChanged = window.cw.onDevicesChanged(apply);
  const offEpoch = onConnectionEpoch(() => void load());
  void load();
  return () => {
    offEpoch();
    offChanged();
    release();
  };
}

export function viewerIsOwner(devices: DeviceInfo[] | null): boolean | null {
  return devices === null ? null : !devices.some((device) => device.current);
}
