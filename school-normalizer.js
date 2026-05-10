const LEVEL_SUFFIXES = {
    '초등': [
        { suffix: '초등학교', safe: true },
        { suffix: '초등', safe: true },
        { suffix: '초교', safe: true },
        { suffix: '초', safe: false },
    ],
    '중등': [
        { suffix: '중학교', safe: true },
        { suffix: '중등', safe: true },
        { suffix: '중', safe: false },
    ],
    '고등': [
        { suffix: '고등학교', safe: true },
        { suffix: '고등', safe: true },
        { suffix: '고교', safe: true },
        { suffix: '고', safe: false },
    ],
};

export function cleanSchoolName(school) {
    return String(school || '').trim().replace(/\s+/g, ' ');
}

export function levelShortName(level) {
    if (level === '초등') return '초';
    if (level === '중등') return '중';
    if (level === '고등') return '고';
    return level || '';
}

export function collectKnownSchoolNames(students = []) {
    return new Set(students.map(s => cleanSchoolName(s.school)).filter(Boolean));
}

export function normalizeStudentSchools(students = [], knownStudents = []) {
    const knownSchools = collectKnownSchoolNames([...knownStudents, ...students]);
    for (const student of students) {
        student.school = normalizeSchoolName(student.school, student.level, knownSchools);
    }
}

export function normalizeSchoolName(school, level, knownSchools = new Set()) {
    const value = cleanSchoolName(school);
    const suffixes = LEVEL_SUFFIXES[level] || [];
    for (const { suffix, safe } of suffixes) {
        if (!value.endsWith(suffix) || value.length <= suffix.length) continue;
        const base = value.slice(0, -suffix.length).trim();
        if (safe || knownSchools.has(base)) return base;
    }
    return value;
}

export function schoolSearchTerms(student) {
    const school = cleanSchoolName(student?.school);
    const levelShort = levelShortName(student?.level);
    const grade = student?.grade ? String(student.grade).replace(/[^0-9]/g, '') : '';
    return [
        school,
        school && levelShort ? `${school}${levelShort}` : '',
        school && levelShort && grade ? `${school}${levelShort}${grade}` : '',
    ].filter(Boolean);
}
