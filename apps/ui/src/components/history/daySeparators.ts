export interface DayBucket {
  label: string;
  start: number;
}

const monthFormat = new Intl.DateTimeFormat("en-US", { month: "long", year: "numeric" });

function startOfDay(ms: number): number {
  const date = new Date(ms);
  date.setHours(0, 0, 0, 0);
  return date.getTime();
}

function shiftDays(dayStart: number, days: number): number {
  const date = new Date(dayStart);
  date.setDate(date.getDate() + days);
  return date.getTime();
}

function startOfMonth(ms: number): number {
  const date = new Date(ms);
  return new Date(date.getFullYear(), date.getMonth(), 1).getTime();
}

export function dayBucket(now: number, ts: number): DayBucket {
  const today = startOfDay(now);
  if (ts >= today) return { label: "Today", start: today };
  const yesterday = shiftDays(today, -1);
  if (ts >= yesterday) return { label: "Yesterday", start: yesterday };
  const daysSinceMonday = (new Date(today).getDay() + 6) % 7;
  const thisWeek = shiftDays(today, -daysSinceMonday);
  if (ts >= thisWeek) return { label: "Earlier this week", start: thisWeek };
  const lastWeek = shiftDays(thisWeek, -7);
  if (ts >= lastWeek) return { label: "Last week", start: lastWeek };
  const thisMonth = startOfMonth(today);
  if (ts >= thisMonth) return { label: "Earlier this month", start: thisMonth };
  const month = startOfMonth(ts);
  return { label: monthFormat.format(month), start: month };
}

export function dayLabels(now: number, times: readonly (number | null)[]): (string | null)[] {
  let current: DayBucket | null = null;
  return times.map((ts) => {
    if (ts === null) return null;
    const bucket = dayBucket(now, ts);
    if (current === null || bucket.start < current.start) current = bucket;
    return current.label;
  });
}
