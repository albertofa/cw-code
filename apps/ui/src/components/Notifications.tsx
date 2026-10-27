import { create } from "zustand";
import { X } from "lucide-react";

export interface NotifAction {
  label: string;
  primary?: boolean;
  onClick: () => void;
}

export type NotifKind = "info" | "success" | "warning" | "error";

export interface Notif {
  id: string;
  kind: NotifKind;
  title: string;
  message?: string;
  sticky?: boolean;
  actions?: NotifAction[];
}

interface NotifState {
  notifs: Notif[];
  upsert: (n: Notif) => void;
  push: (n: Omit<Notif, "id"> & { id?: string }) => string;
  dismiss: (id: string) => void;
  clear: () => void;
}

let seq = 0;
const TRANSIENT_MS = 6000;
const MAX_STACK = 4;

export const useNotifs = create<NotifState>((set, get) => ({
  notifs: [],

  upsert: (n) => {
    const list = get().notifs;
    if (list.some((x) => x.id === n.id)) {
      set({ notifs: list.map((x) => (x.id === n.id ? n : x)) });
    } else {
      set({ notifs: [...list.slice(-(MAX_STACK - 1)), n] });
    }
  },

  push: (n) => {
    const id = n.id ?? `notif-${++seq}`;
    get().upsert({ ...n, id });
    if (!n.sticky) {
      window.setTimeout(() => get().dismiss(id), TRANSIENT_MS);
    }
    return id;
  },

  dismiss: (id) => set({ notifs: get().notifs.filter((x) => x.id !== id) }),

  clear: () => set({ notifs: [] })
}));

export function Notifications() {
  const notifs = useNotifs((s) => s.notifs);
  const dismiss = useNotifs((s) => s.dismiss);
  if (notifs.length === 0) return null;

  return (
    <div className="notifs" role="status" aria-live="polite">
      {notifs.map((n) => (
        <div key={n.id} className={`notif ${n.kind}`}>
          <div className="notif-head">
            <span className="notif-title">{n.title}</span>
            <button className="icon-btn" aria-label="Dismiss notification" onClick={() => dismiss(n.id)}>
              <X aria-hidden="true" size={15} />
            </button>
          </div>
          {n.message && <div className="notif-msg">{n.message}</div>}
          {n.actions && n.actions.length > 0 && (
            <div className="notif-actions">
              {n.actions.map((a) => (
                <button key={a.label} className={`btn${a.primary ? " btn-primary" : ""}`} onClick={a.onClick}>
                  {a.label}
                </button>
              ))}
            </div>
          )}
        </div>
      ))}
    </div>
  );
}
