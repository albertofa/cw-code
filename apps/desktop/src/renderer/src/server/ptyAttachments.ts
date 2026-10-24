export interface PtyOpenResult {
  ptyId: string;
  token: string;
  replay: string;
}

export interface PtyAttachments {
  open(request: () => Promise<PtyOpenResult>): Promise<PtyOpenResult>;
  detach(ptyId: string): void;
}

export function createPtyAttachments(sendDetach: (ptyId: string) => void): PtyAttachments {
  const counts = new Map<string, number>();
  const opening = new Set<Promise<PtyOpenResult>>();
  const deferred = new Set<string>();

  const openingSettled = async (): Promise<void> => {
    while (opening.size > 0) await Promise.allSettled([...opening]);
  };

  return {
    open(request) {
      const pending = request().then((result) => {
        counts.set(result.ptyId, (counts.get(result.ptyId) ?? 0) + 1);
        return result;
      });
      opening.add(pending);
      const forget = () => opening.delete(pending);
      pending.then(forget, forget);
      return pending;
    },
    detach(ptyId) {
      const count = (counts.get(ptyId) ?? 0) - 1;
      if (count > 0) {
        counts.set(ptyId, count);
        return;
      }
      counts.delete(ptyId);
      if (opening.size === 0) {
        deferred.delete(ptyId);
        sendDetach(ptyId);
        return;
      }
      if (deferred.has(ptyId)) return;
      deferred.add(ptyId);
      void openingSettled().then(() => {
        if (!deferred.delete(ptyId)) return;
        if (!counts.has(ptyId)) sendDetach(ptyId);
      });
    }
  };
}
