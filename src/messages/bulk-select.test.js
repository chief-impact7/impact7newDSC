import { describe, it, expect } from 'vitest';
import { filterStaff, filterStudents } from './bulk-select.js';

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

  it('filters by search query (class code via allClassCodes)', () => {
    const list = [
      S({ name: 'A', enrollments: [{ level_symbol: 'PA', class_number: '101' }] }),
      S({ name: 'B', enrollments: [{ level_symbol: 'PA', class_number: '202' }] }),
    ];
    const out = filterStudents(list, { q: 'pa101' });
    expect(out.map((s) => s.name)).toEqual(['A']);
  });

  it('filters by classCode against all enrollments (학생 객체가 아닌 enrollments 기준)', () => {
    const list = [
      S({ name: 'A', enrollments: [{ level_symbol: 'PA', class_number: '101' }, { level_symbol: 'NA', class_number: '202' }] }),
      S({ name: 'B', enrollments: [{ level_symbol: 'PA', class_number: '303' }] }),
    ];
    // 두 번째 enrollment 코드로도 매칭돼야 한다(학생 객체엔 level_symbol/class_number가 없음).
    const out = filterStudents(list, { classCode: 'NA202' });
    expect(out.map((s) => s.name)).toEqual(['A']);
  });

  it('비원생은 상담·퇴원·종강을 모두 포함한다', () => {
    const list = ['등원예정', '재원', '실휴원', '가휴원', '상담', '퇴원', '종강']
      .map((status) => S({ name: status, status }));
    expect(filterStudents(list, { status: 'non' }).map((s) => s.status))
      .toEqual(['상담', '퇴원', '종강']);
  });

  it('returns all when no criteria', () => {
    const list = [S(), S({ name: 'B' })];
    expect(filterStudents(list, {})).toHaveLength(2);
  });
});

describe('filterStaff', () => {
  const staff = [
    { id: 'a', name: '김재직', status: 'active', department: '교수', affiliation: '2단지', phoneAvailable: true },
    { id: 'b', name: '박휴직', status: 'inactive', department: '행정', affiliation: '10단지', phoneAvailable: false },
    { id: 'c', name: '이퇴직', status: 'terminated', department: '교수', affiliation: '2단지', phoneAvailable: true },
  ];

  it('재직·휴직·퇴직 상태로 필터링한다', () => {
    expect(filterStaff(staff, { status: 'active' }).map((s) => s.id)).toEqual(['a']);
    expect(filterStaff(staff, { status: 'inactive' }).map((s) => s.id)).toEqual(['b']);
    expect(filterStaff(staff, { status: 'terminated' }).map((s) => s.id)).toEqual(['c']);
  });

  it('이름·부서·소속을 검색하고 부서 필터와 전체 상태를 지원한다', () => {
    expect(filterStaff(staff, { status: 'all', q: '행정' }).map((s) => s.id)).toEqual(['b']);
    expect(filterStaff(staff, { status: 'all', q: '2단지' }).map((s) => s.id)).toEqual(['a', 'c']);
    expect(filterStaff(staff, { status: 'all', department: '교수' }).map((s) => s.id)).toEqual(['a', 'c']);
  });
});
