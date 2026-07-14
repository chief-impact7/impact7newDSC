import { describe, it, expect } from 'vitest';
import {
  buildRecipientSettings,
  createRecipientSettingsSaveQueue,
  defaultRecipientFields,
  normalizeRecipientFields,
  resolveRecipientFields,
} from './recipient-settings.js';

describe('message recipient settings', () => {
  it('기본 수신 대상은 가능하면 학부모1이다', () => {
    expect(defaultRecipientFields(['student', 'parent_1', 'parent_2'])).toEqual(['parent_1']);
  });

  it('학부모1이 없으면 첫 가용 대상을 기본으로 쓴다', () => {
    expect(defaultRecipientFields(['student', 'parent_2'])).toEqual(['student']);
  });

  it('저장된 수신 대상이 있으면 기본값 대신 저장값을 복원한다', () => {
    const settings = { alimtalk: ['parent_1', 'parent_2'] };
    expect(resolveRecipientFields(settings, 'alimtalk', ['parent_1', 'parent_2'])).toEqual(['parent_1', 'parent_2']);
  });

  it('저장된 대상 중 현재 번호가 없는 대상은 제외한다', () => {
    expect(normalizeRecipientFields(['parent_2', 'parent_1', 'parent_2'], ['parent_1'])).toEqual(['parent_1']);
  });

  it('빈 배열로 저장된 경우 새로고침 후에도 빈 선택을 유지한다', () => {
    expect(resolveRecipientFields({ sms: [] }, 'sms', ['parent_1'])).toEqual([]);
  });

  it('구형 bms 수신 설정을 문자 설정으로 복원한다', () => {
    expect(resolveRecipientFields({ bms: ['parent_2'] }, 'sms', ['parent_1', 'parent_2'])).toEqual(['parent_2']);
  });

  it('현재 선택값을 저장 payload로 만든다', () => {
    expect(buildRecipientSettings(new Set(['parent_1']), new Set(['student', 'parent_2']))).toEqual({
      alimtalk: ['parent_1'],
      sms: ['student', 'parent_2'],
    });
  });

  it('저장 요청을 직렬화해서 마지막 선택이 마지막 write가 되게 한다', async () => {
    const calls = [];
    const releases = [];
    const enqueue = createRecipientSettingsSaveQueue((studentId, settings) => {
      calls.push({ studentId, settings });
      return new Promise((resolve) => releases.push(resolve));
    });

    const first = enqueue('s1', { alimtalk: ['parent_1'], sms: ['parent_1'] });
    const second = enqueue('s1', { alimtalk: ['parent_1', 'parent_2'], sms: ['parent_1', 'parent_2'] });

    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(calls).toEqual([{ studentId: 's1', settings: { alimtalk: ['parent_1'], sms: ['parent_1'] } }]);

    releases[0]();
    await first;
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(calls).toEqual([
      { studentId: 's1', settings: { alimtalk: ['parent_1'], sms: ['parent_1'] } },
      { studentId: 's1', settings: { alimtalk: ['parent_1', 'parent_2'], sms: ['parent_1', 'parent_2'] } },
    ]);

    releases[1]();
    await second;
  });

  it('학생 전환 중에도 저장 요청별 studentId를 유지한다', async () => {
    const calls = [];
    const enqueue = createRecipientSettingsSaveQueue(async (studentId, settings) => {
      calls.push({ studentId, settings });
    });

    await enqueue('s1', { alimtalk: ['parent_1'], sms: ['parent_1'] });
    await enqueue('s2', { alimtalk: ['parent_2'], sms: ['parent_2'] });

    expect(calls).toEqual([
      { studentId: 's1', settings: { alimtalk: ['parent_1'], sms: ['parent_1'] } },
      { studentId: 's2', settings: { alimtalk: ['parent_2'], sms: ['parent_2'] } },
    ]);
  });
});
