import { describe, expect, it } from 'vitest';
import { audienceMaxMessages, buildAudienceRequest } from './bulk-send.js';

const common = {
  ids: ['a'],
  recipientFields: ['parent_1'],
  content: '안내',
  kind: 'info',
  requestId: 'req-1',
};

describe('buildAudienceRequest', () => {
  it('학생 정보성·홍보성 발송 API를 구분한다', () => {
    expect(buildAudienceRequest({ ...common, audience: 'student' })).toMatchObject({
      call: 'bulk', payload: { studentIds: ['a'], recipientField: 'parent_1' },
    });
    expect(buildAudienceRequest({ ...common, audience: 'student', kind: 'promo' })).toMatchObject({
      call: 'promo', payload: { studentIds: ['a'], targeting: 'M' },
    });
  });

  it('교직원은 staffIds로 기존 대량 API를 호출한다', () => {
    expect(buildAudienceRequest({ ...common, audience: 'staff' })).toMatchObject({
      call: 'bulk', payload: { staffIds: ['a'] },
    });
  });

  it('직접번호는 동의·예약·MMS를 직접발송 API 계약으로 전달한다', () => {
    expect(buildAudienceRequest({
      ...common,
      audience: 'direct',
      directRecipients: '010-1111-2222',
      kind: 'promo',
      consentConfirmed: true,
      scheduledAt: '2026-07-17 10:00:00',
      mmsImage: { name: 'a.jpg' },
    })).toEqual({
      call: 'direct',
      payload: {
        recipients: '010-1111-2222',
        text: '안내',
        messageKind: 'promo',
        consentConfirmed: true,
        requestId: 'req-1',
        scheduledAt: '2026-07-17 10:00:00',
        mmsImage: { name: 'a.jpg' },
      },
    });
  });
});

it('직접번호는 100명, DB 대상은 10,000건 제한을 유지한다', () => {
  expect(audienceMaxMessages('direct')).toBe(100);
  expect(audienceMaxMessages('student')).toBe(10000);
  expect(audienceMaxMessages('staff')).toBe(10000);
});
