/**
 * ESPN sends dates as epoch milliseconds, but leagues with no trade deadline
 * (common in basketball) omit tradeSettings.deadlineDate or send a value that
 * isn't a valid date. `new Date(x).toISOString()` throws a RangeError
 * ("Invalid time value") on those, so convert defensively.
 */
export function safeIso(value: unknown): string | undefined {
  if (value === null || value === undefined || value === "") return undefined;
  const ms = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(ms) || ms <= 0) return undefined;
  const d = new Date(ms);
  return Number.isNaN(d.getTime()) ? undefined : d.toISOString();
}
