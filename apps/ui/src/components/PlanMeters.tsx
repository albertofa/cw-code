import type { AccountUsageOk } from "../cw.js";
import { UsageBalanceRow } from "./UsageBalanceRow.js";
import { UsageMeter } from "./UsageMeter.js";

export function PlanMeters({ state }: { state: AccountUsageOk }) {
  return (
    <>
      <div className="usage-meters">
        {state.windows.map((w) => (
          <UsageMeter key={w.id} window={w} />
        ))}
      </div>
      {state.balances.map((b) => (
        <UsageBalanceRow key={b.id} balance={b} />
      ))}
    </>
  );
}
