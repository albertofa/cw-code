import { create } from "zustand";
import type { AccountUsageSnapshot, DriverName, UsageLedgerQuery, UsageLedgerRow } from "../cw.js";
import { ipcErrorMessage } from "../components/ipcError.js";

interface UsageState {
  accountByDriver: Partial<Record<DriverName, AccountUsageSnapshot>>;
  accountLoading: Partial<Record<DriverName, boolean>>;
  accountError: Partial<Record<DriverName, string>>;
  accountFetchedAt: number | null;
  ledgerRows: UsageLedgerRow[];
  ledgerError: string | null;
  sessionRowsById: Record<string, UsageLedgerRow[]>;
  sessionLoading: Record<string, boolean>;
  sessionError: Record<string, string>;
  refreshAccount(drivers: DriverName[], force?: boolean): Promise<void>;
  loadLedger(query: UsageLedgerQuery): Promise<void>;
  ensureSessionRows(sessionId: string): Promise<void>;
}

let ledgerRequestSeq = 0;

export const useUsageStore = create<UsageState>((set, get) => ({
  accountByDriver: {},
  accountLoading: {},
  accountError: {},
  accountFetchedAt: null,
  ledgerRows: [],
  ledgerError: null,
  sessionRowsById: {},
  sessionLoading: {},
  sessionError: {},

  async refreshAccount(drivers: DriverName[], force = false) {
    const loading = { ...get().accountLoading };
    for (const driver of drivers) loading[driver] = true;
    set({ accountLoading: loading });
    try {
      const snapshots = await window.cw.getAccountUsage(drivers, force);
      const accountByDriver = { ...get().accountByDriver };
      const accountError = { ...get().accountError };
      for (const snapshot of snapshots) {
        accountByDriver[snapshot.driver] = snapshot;
        delete accountError[snapshot.driver];
      }
      const nextLoading = { ...get().accountLoading };
      for (const driver of drivers) delete nextLoading[driver];
      set({
        accountByDriver,
        accountError,
        accountLoading: nextLoading,
        accountFetchedAt: Date.now()
      });
    } catch (err) {
      const message = ipcErrorMessage(err);
      const accountError = { ...get().accountError };
      const nextLoading = { ...get().accountLoading };
      for (const driver of drivers) {
        accountError[driver] = message;
        delete nextLoading[driver];
      }
      set({ accountError, accountLoading: nextLoading });
    }
  },

  async loadLedger(query: UsageLedgerQuery) {
    const requestId = ++ledgerRequestSeq;
    try {
      const rows = await window.cw.getUsageLedger(query);
      if (requestId !== ledgerRequestSeq) return;
      set({ ledgerRows: rows, ledgerError: null });
    } catch (err) {
      if (requestId !== ledgerRequestSeq) return;
      set({ ledgerError: ipcErrorMessage(err) });
    }
  },

  async ensureSessionRows(sessionId: string) {
    if (get().sessionLoading[sessionId]) return;
    const sessionError = { ...get().sessionError };
    delete sessionError[sessionId];
    set({ sessionLoading: { ...get().sessionLoading, [sessionId]: true }, sessionError });
    try {
      const rows = await window.cw.getUsageLedger({ sessionId });
      set({
        sessionRowsById: { ...get().sessionRowsById, [sessionId]: rows },
        sessionLoading: { ...get().sessionLoading, [sessionId]: false }
      });
    } catch (err) {
      set({
        sessionLoading: { ...get().sessionLoading, [sessionId]: false },
        sessionError: { ...get().sessionError, [sessionId]: ipcErrorMessage(err) }
      });
    }
  }
}));
