import { create } from "zustand";
import type { DeviceCreateResult, DeviceInfo } from "@cw-code/contracts";
import { APP_TOPIC } from "@cw-code/shared/topics";
import { errorMessage } from "../components/errorMessage.js";
import { acquireTopic } from "../server/topics.js";

interface DevicesState {
  devices: DeviceInfo[] | null;
  error: string | null;
  load: () => Promise<void>;
  apply: (devices: DeviceInfo[]) => void;
  create: (name: string) => Promise<DeviceCreateResult>;
  revoke: (id: string) => Promise<void>;
}

export const useDevicesStore = create<DevicesState>((set, get) => ({
  devices: null,
  error: null,
  load: async () => {
    try {
      get().apply(await window.cw.devices.list());
    } catch (err) {
      set({ error: errorMessage(err) || "Could not load paired devices" });
    }
  },
  apply: (devices) => set({ devices, error: null }),
  create: async (name) => {
    const result = await window.cw.devices.create(name);
    const devices = get().devices ?? [];
    if (!devices.some((device) => device.id === result.device.id)) set({ devices: [...devices, result.device] });
    return result;
  },
  revoke: async (id) => {
    await window.cw.devices.revoke(id);
    set({ devices: (get().devices ?? []).filter((device) => device.id !== id) });
  }
}));

export function watchDevices(): () => void {
  const release = acquireTopic(APP_TOPIC);
  const off = window.cw.onDevicesChanged((devices) => useDevicesStore.getState().apply(devices));
  void useDevicesStore.getState().load();
  return () => {
    off();
    release();
  };
}

export function viewerIsOwner(devices: DeviceInfo[] | null): boolean | null {
  return devices === null ? null : !devices.some((device) => device.current);
}
