// studentFullLabel(shared)과 동일 기준으로 [학교, 학교+학부글자, 풀라벨] 검색어 생성.
// 예: (신목, 중등, 2) → ['신목', '신목중', '신목중2']
//     졸업생(고졸+1)    → ['대일', '대일고', '대일고(졸업+1)']
import { studentFullLabel, normalizeRealLevelGrade, SCHOOL_FIELD } from '@impact7/shared/student-label';

const LEVEL_SHORT = { '초등': '초', '중등': '중', '고등': '고' };

export function schoolSearchTerms(student) {
    if (!student) return [];
    const full = studentFullLabel(student);
    const { level, graduated } = normalizeRealLevelGrade(student);
    const predLevel = graduated ? '고등' : level;
    const lv = LEVEL_SHORT[predLevel] || '';
    const rawSchool = student[SCHOOL_FIELD[predLevel]] || '';
    if (!rawSchool) return [full].filter(Boolean);

    // full에서 학년/졸업 꼬리를 제거해 '학교+학부글자' 단계를 복원한다.
    const schoolWithLevel = full.replace(/\d+$/, '').replace(/\(졸업\+\d+\)$/, '');
    const school = lv && schoolWithLevel.endsWith(lv)
        ? schoolWithLevel.slice(0, -lv.length)
        : schoolWithLevel;

    return [school, schoolWithLevel, full].filter(Boolean);
}
