// ─── 섹션 정의 (app.js SECTIONS 구조와 동일) ───

export const SECTIONS = [
    {
        key: 'attendance', label: '출결', cssClass: 'sec-attendance',
        fields: [
            { key: 'attendance', label: '출결', type: 'select', options: ['', '출석', '결석', '지각', '조퇴'] },
            { key: 'attendance_time', label: '시간', type: 'time' },
            { key: 'attendance_reason', label: '사유', type: 'text', wide: true },
        ]
    },
    {
        key: 'homework', label: '숙제', cssClass: 'sec-homework',
        fields: [
            { key: 'hw_reading', label: '독해', type: 'ox' },
            { key: 'hw_grammar', label: '문법', type: 'ox' },
            { key: 'hw_practice', label: '실전', type: 'ox' },
            { key: 'hw_listening', label: '청해', type: 'ox' },
            { key: 'hw_extra', label: '추가', type: 'ox' },
            { key: 'hw_vocab', label: '어휘', type: 'ox' },
            { key: 'hw_idiom', label: '숙어', type: 'ox' },
            { key: 'hw_verb3', label: '3단', type: 'ox' },
        ]
    },
    {
        key: 'review_test', label: '리뷰테스트', cssClass: 'sec-review-test',
        fields: [
            { key: 'test_reading', label: '독해', type: 'text' },
            { key: 'test_grammar', label: '문법', type: 'text' },
            { key: 'test_practice', label: '실전', type: 'text' },
            { key: 'test_listening', label: '청해', type: 'text' },
        ]
    },
    {
        key: 'isc', label: 'ISC', cssClass: 'sec-isc',
        fields: [
            { key: 'isc', label: 'ISC', type: 'text' },
        ]
    },
    {
        key: 'review', label: '부실 숙제 보완', cssClass: 'sec-review',
        fields: [
            { key: 'review_reading', label: '독해', type: 'ox' },
            { key: 'review_grammar', label: '문법', type: 'ox' },
            { key: 'review_practice', label: '실전', type: 'ox' },
            { key: 'review_listening', label: '청해', type: 'ox' },
            { key: 'review_extra', label: '추가', type: 'ox' },
            { key: 'review_vocab', label: '어휘', type: 'ox' },
            { key: 'review_idiom', label: '숙어', type: 'ox' },
            { key: 'review_verb3', label: '3단', type: 'ox' },
        ]
    },
    {
        key: 'retest', label: '재시', cssClass: 'sec-retest',
        fields: [
            { key: 'retest_isc', label: 'ISC', type: 'text' },
            { key: 'retest_reading', label: '독해', type: 'text' },
            { key: 'retest_grammar', label: '문법', type: 'text' },
            { key: 'retest_practice', label: '실전', type: 'text' },
            { key: 'retest_listening', label: '청해', type: 'text' },
            { key: 'retest_grading', label: '채점', type: 'text' },
        ]
    },
    {
        key: 'next_hw', label: '다음 숙제', cssClass: 'sec-next-hw',
        fields: [
            { key: 'next_listening', label: '청해', type: 'text', wide: true },
            { key: 'next_summary', label: '요약', type: 'text', wide: true },
            { key: 'next_reading', label: '독해', type: 'text', wide: true },
            { key: 'next_grammar', label: '문법', type: 'text', wide: true },
            { key: 'next_practice', label: '실전', type: 'text', wide: true },
            { key: 'next_listening2', label: '청해2', type: 'text', wide: true },
            { key: 'next_extra', label: '추가', type: 'text', wide: true },
        ]
    },
    {
        key: 'notes', label: '전달사항', cssClass: 'sec-notes',
        fields: [
            { key: 'note_class_to_study', label: '강의실→학습실', type: 'text', wide: true },
            { key: 'note_to_parent', label: '학원→부모님', type: 'text', wide: true },
        ]
    },
    {
        key: 'absent', label: '결석생 대응', cssClass: 'sec-absent',
        fields: [
            { key: 'absent_handler', label: '담당', type: 'text' },
            { key: 'absent_consultation', label: '상담내용', type: 'text', wide: true },
        ]
    },
    {
        key: 'lms', label: 'LMS', cssClass: 'sec-lms',
        fields: [
            { key: 'lms_content', label: '내용', type: 'text', wide: true },
        ]
    },
];

// ─── 대시보드 컴포넌트용 필드 배열 ───

export const HW_FIELDS = [
    { key: 'hw_reading', label: '독해' },
    { key: 'hw_grammar', label: '문법' },
    { key: 'hw_practice', label: '실전' },
    { key: 'hw_listening', label: '청해' },
    { key: 'hw_extra', label: '추가' },
    { key: 'hw_vocab', label: '어휘' },
    { key: 'hw_idiom', label: '숙어' },
    { key: 'hw_verb3', label: '3단' },
];

export const TEST_FIELDS = [
    { key: 'test_reading', label: '독해' },
    { key: 'test_grammar', label: '문법' },
    { key: 'test_practice', label: '실전' },
    { key: 'test_listening', label: '청해' },
];

export const RETEST_FIELDS = [
    { key: 'retest_isc', label: 'ISC' },
    { key: 'retest_reading', label: '독해' },
    { key: 'retest_grammar', label: '문법' },
    { key: 'retest_practice', label: '실전' },
    { key: 'retest_listening', label: '청해' },
    { key: 'retest_grading', label: '채점' },
];

export const NEXT_HW_FIELDS = [
    { key: 'next_listening', label: '청해' },
    { key: 'next_summary', label: '요약' },
    { key: 'next_reading', label: '독해' },
    { key: 'next_grammar', label: '문법' },
    { key: 'next_practice', label: '실전' },
    { key: 'next_listening2', label: '청해2' },
    { key: 'next_extra', label: '추가' },
];
