import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildConsultationPayload } from './consultation-payload.js';

const base = {
  studentId: 's1', studentName: '홍길동', className: '고1A',
  teacherId: 'uid1', teacherName: 'kim',
  date: '2026-05-20', target: '학생', method: '대면',
  consultationType: '정기', text: '  메모 내용  ',
};

test('필드 매핑 + text trim', () => {
  const p = buildConsultationPayload(base);
  assert.equal(p.student_id, 's1');
  assert.equal(p.student_name, '홍길동');
  assert.equal(p.class_name, '고1A');
  assert.equal(p.teacher_id, 'uid1');
  assert.equal(p.teacher_name, 'kim');
  assert.equal(p.date, '2026-05-20');
  assert.equal(p.target, '학생');
  assert.equal(p.method, '대면');
  assert.equal(p.consultation_type, '정기');
  assert.equal(p.text, '메모 내용');
});

test('신규 필드가 모두 포함된다 (rules 필수 + 신규 3)', () => {
  const p = buildConsultationPayload(base);
  for (const k of ['student_id', 'teacher_id', 'date', 'consultation_type', 'text']) {
    assert.ok(k in p, `${k} 누락`);
  }
  for (const k of ['target', 'method', 'class_name']) {
    assert.ok(k in p, `신규 ${k} 누락`);
  }
});

test('className 비어도 키는 존재 (빈 문자열)', () => {
  const p = buildConsultationPayload({ ...base, className: '' });
  assert.equal(p.class_name, '');
});
