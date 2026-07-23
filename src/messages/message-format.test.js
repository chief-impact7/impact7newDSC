import { describe, expect, it } from 'vitest';
import {
  ALIMTALK_CHAR_LIMIT,
  LMS_BYTE_LIMIT,
  alimtalkMeta,
  messageMeta,
  smsByteLen,
  splitSmsText,
} from './message-format.js';

describe('message length preflight', () => {
  it('uses the same SMS byte rules as the server', () => {
    expect(smsByteLen('A 한')).toBe(4);
    expect(smsByteLen('😀')).toBe(4);
    expect(messageMeta('a'.repeat(LMS_BYTE_LIMIT)).overLimit).toBe(false);
    expect(messageMeta('a'.repeat(LMS_BYTE_LIMIT + 1)).overLimit).toBe(true);
  });

  it('splits long text into the minimum numbered LMS-safe parts', () => {
    const parts = splitSmsText(`안내 ${'가'.repeat(1001)}`);
    expect(parts).toHaveLength(2);
    expect(parts[0]).toMatch(/^\[1\/2\] /);
    expect(parts[1]).toMatch(/^\[2\/2\] /);
    expect(parts.every((part) => smsByteLen(part) <= LMS_BYTE_LIMIT)).toBe(true);
  });

  it('preserves whitespace at split boundaries', () => {
    const source = `${'가'.repeat(990)}\n\n${'나'.repeat(20)}`;
    const parts = splitSmsText(source);
    expect(parts.map((part) => part.replace(/^\[\d+\/\d+\] /, '')).join('')).toBe(source);
  });

  it('checks both rendered Alimtalk text and fallback SMS', () => {
    expect(alimtalkMeta('가'.repeat(ALIMTALK_CHAR_LIMIT), '안내').overLimit).toBe(false);
    expect(alimtalkMeta('가'.repeat(ALIMTALK_CHAR_LIMIT + 1), '안내')).toMatchObject({
      overLimit: true,
      splitParts: 1,
    });
  });
});
