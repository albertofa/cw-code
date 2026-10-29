import type { UsageBalance } from "../cw.js";
import { formatMoney } from "./usageFormat.js";

export function UsageBalanceRow({ balance }: { balance: UsageBalance }) {
  const hasAmounts = balance.enabled && balance.usedMinor !== undefined && balance.limitMinor !== undefined;
  const usedMinor = balance.usedMinor ?? 0;
  const limitMinor = balance.limitMinor ?? 0;
  const percent = hasAmounts ? Math.min(100, Math.max(0, (usedMinor / Math.max(1, limitMinor)) * 100)) : 0;
  return (
    <div className="usage-balance">
      <div className="usage-kv">
        <span>{balance.label}</span>
        {balance.enabled && <span className="usage-tag info">On</span>}
        <span className="usage-v">
          {hasAmounts
            ? `${formatMoney(usedMinor, balance.currency)} / ${formatMoney(limitMinor, balance.currency)}`
            : (balance.detail ?? (balance.enabled ? "—" : "Disabled"))}
        </span>
      </div>
      {hasAmounts && (
        <div className="usage-track thin">
          <i style={{ width: `${percent}%` }} />
        </div>
      )}
    </div>
  );
}
