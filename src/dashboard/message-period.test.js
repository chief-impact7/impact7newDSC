import { describe, expect, it } from 'vitest';
import { kstDayRangeParams } from './message-period.js';

describe('kstDayRangeParams', () => {
    const nowMs = Date.parse('2026-07-14T03:00:00Z');

    it('returns the exact KST day range', () => {
        expect(kstDayRangeParams(0, nowMs)).toEqual({
            fromMs: Date.parse('2026-07-13T15:00:00Z'),
            toMs: Date.parse('2026-07-14T14:59:59.999Z'),
        });
        expect(kstDayRangeParams(-1, nowMs)).toEqual({
            fromMs: Date.parse('2026-07-12T15:00:00Z'),
            toMs: Date.parse('2026-07-13T14:59:59.999Z'),
        });
    });
});
