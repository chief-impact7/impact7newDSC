import { describe, it, expect } from 'vitest';
import { filterStudents } from './bulk-select.js';

// S: 기본 학생 픽스처. level/grade는 normalizeRealLevelGrade가 사용하는 실제 필드명.
const S = (over) => ({ name: '홍길동', status: '재원', level: '중등', grade: '1', ...over });

describe('filterStudents', () => {
  it('filters by grade set (studentGradeKey)', () => {
    const list = [S({ name: 'A', level: '중등', grade: '3' }), S({ name: 'B', level: '중등', grade: '2' })];
    const out = filterStudents(list, { grades: new Set(['중3']) });
    expect(out.map((s) => s.name)).toEqual(['A']);
  });

  it('filters by search query (name)', () => {
    const list = [S({ name: '김철수' }), S({ name: '이영희' })];
    const out = filterStudents(list, { q: '철수' });
    expect(out.map((s) => s.name)).toEqual(['김철수']);
  });

  it('returns all when no criteria', () => {
    const list = [S(), S({ name: 'B' })];
    expect(filterStudents(list, {})).toHaveLength(2);
  });
});
