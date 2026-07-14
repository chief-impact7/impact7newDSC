const KST_OFFSET_MS = 9 * 3600 * 1000;
const DAY_MS = 24 * 3600 * 1000;

export function kstDayStartMs(offsetDays = 0, nowMs = Date.now()) {
    const shifted = new Date(nowMs + KST_OFFSET_MS);
    return Date.UTC(shifted.getUTCFullYear(), shifted.getUTCMonth(), shifted.getUTCDate() + offsetDays) - KST_OFFSET_MS;
}

export function kstDayRangeParams(offsetDays = 0, nowMs = Date.now()) {
    const fromMs = kstDayStartMs(offsetDays, nowMs);
    return { fromMs, toMs: fromMs + DAY_MS - 1 };
}

export function kstMonthStartMs(nowMs = Date.now()) {
    const shifted = new Date(nowMs + KST_OFFSET_MS);
    return Date.UTC(shifted.getUTCFullYear(), shifted.getUTCMonth(), 1) - KST_OFFSET_MS;
}

export function dateInputToKstMs(value, endOfDay) {
    if (!value) return null;
    const [y, m, d] = value.split('-').map(Number);
    const startMs = Date.UTC(y, m - 1, d) - KST_OFFSET_MS;
    return endOfDay ? startMs + DAY_MS - 1 : startMs;
}
