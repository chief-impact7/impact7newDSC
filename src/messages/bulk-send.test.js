import { describe, expect, it } from 'vitest';
import {
  audienceMaxMessages,
  buildAudienceRequest,
  buildAudienceRequests,
  completedTargetKeys,
  estimateAudienceMessages,
  groupSelectedTargets,
  invalidVariablesForGroups,
} from './bulk-send.js';

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

it('학생·교직원·직접 번호를 선택 상태대로 묶고 실제 메시지 수를 계산한다', () => {
  const groups = groupSelectedTargets([
    { audience: 'student', target: { id: 's1' }, on: true },
    { audience: 'staff', target: { id: 't1' }, on: true },
    { audience: 'direct', target: { id: '01011112222' }, on: true },
    { audience: 'student', target: { id: 's2' }, on: false },
  ]);
  expect(groups).toEqual({ student: ['s1'], staff: ['t1'], direct: ['01011112222'] });
  expect(estimateAudienceMessages(groups, ['student', 'parent_1'])).toBe(4);
});

it('혼합 대상은 기존 API별 요청으로 분리하고 요청 ID를 고정한다', () => {
  const requests = buildAudienceRequests({
    groups: { student: ['s1'], staff: ['t1'], direct: ['01011112222'] },
    recipientFields: ['parent_1'],
    content: '안내',
    kind: 'info',
    consentConfirmed: false,
    requestId: 'mixed-1',
    scheduledAt: '',
    mmsImage: null,
  });
  expect(requests.map(({ call }) => call)).toEqual(['bulk', 'bulk', 'direct']);
  expect(requests.map(({ payload }) => payload.requestId)).toEqual([
    'mixed-1-student', 'mixed-1-staff', 'mixed-1-direct',
  ]);
  expect(requests[2].payload.recipients).toBe('01011112222');
});

it('교직원·직접번호와 함께 쓸 수 없는 치환 변수를 구분한다', () => {
  expect(invalidVariablesForGroups(
    { student: ['s1'], staff: ['t1'], direct: [] },
    '%이름 %학교 %학년 %반',
  )).toEqual(['%학교', '%학년', '%반']);
  expect(invalidVariablesForGroups(
    { student: ['s1'], staff: [], direct: ['01011112222'] },
    '%이름 %학교',
  )).toEqual(['%이름', '%학교']);
});

it('부분 성공 시 성공한 요청의 대상 키만 반환한다', () => {
  const requests = [{ audience: 'student' }, { audience: 'staff' }, { audience: 'direct' }];
  const results = [
    { status: 'fulfilled', value: {} },
    { status: 'rejected', reason: new Error('failed') },
    { status: 'fulfilled', value: {} },
  ];
  expect(completedTargetKeys(requests, results, {
    student: ['s1'], staff: ['t1'], direct: ['01011112222'],
  })).toEqual(['student:s1', 'direct:01011112222']);
});
