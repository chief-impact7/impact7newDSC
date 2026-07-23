// ─── 반생성마법사 공유 상태 ──────────────────────────────────────────────────
// class-setup.js / class-setup-planner.js가 공유하는 가변 상태와 횡단 헬퍼.
// state.js의 가변 객체 export 패턴을 따른다 (ES Module let 재할당 불가 → 객체/배열로 감싸 in-place mutate).
import { esc } from './ui-utils.js';

// 인원현황 권한 — class-setup.js가 로그인 시 채움 (all=전체 집계, classCounts=반별 인원)
export const popPerms = { all: false, classCounts: false };

// 마법사 데이터 — 단일 진실 원천
export const wizardData = {
    classType: '',       // '정규' | '내신' | '자유학기' | '특강' | '기타'
    feeType: '',         // 특강 전용: '유료' | '무료'
    classCode: '',       // 생성될 반 코드
    levelSymbol: '',
    classNumber: '',
    school: '',
    grade: '',
    naesinBranch: '',
    naesinLevel: '',
    naesinGroup: '',
    specialName: '',
    otherName: '',
    naesinStart: '',
    naesinEnd: '',
    specialStart: '',
    specialEnd: '',
    otherStart: '',
    otherEnd: '',
    freeStart: '',
    freeEnd: '',
    teacher: '',
    students: [],        // [{ docId, name, school, grade, status, enrollments }]
    days: [],            // ['월', '수', '금']
    defaultTime: '',     // 정규반 공통 등원시간
    defaultTimeEdited: false,
    schedule: {},        // { '월': '16:00', '수': '16:00' }
};

// 로컬 상태 배열 — 재할당 대신 in-place mutate(length=0 / push / sort)로 공유 참조 유지
export const allStudents = [];
export const teachersList = [];

// class-setup 전용 2-arg 토스트 (msg, type) — ui-utils.js의 단일-arg showToast와 시그니처가 다르다.
// error/success 색 구분을 위해 `toast ${type}` 클래스를 붙이고 #toast-container를 사용한다.
export function showToast(msg, type = 'success') {
    const container = document.getElementById('toast-container');
    const toast = document.createElement('div');
    toast.className = `toast ${type}`;
    toast.textContent = msg;
    container.appendChild(toast);
    setTimeout(() => toast.remove(), 3000);
}

// ─── 미리보기 (횡단 허브) ─────────────────────────────────────────────────────
export function renderSummary() {
    const card = document.getElementById('summary-card');
    if (!card) return;
    const d = wizardData;
    const teacherName = d.teacher ? (teachersList.find(t => t.email === d.teacher)?.name || d.teacher) : '미지정';
    const timeForDay = day => d.classType === '정규' ? d.defaultTime : (d.schedule[day] || '');
    const dayTimeStr = d.days.length
        ? d.days.map(day => `${day} ${timeForDay(day)}`).join(', ')
        : '미선택';

    let typeLabel = d.classType || '미선택';
    if (d.classType === '내신' && d.naesinStart && d.naesinEnd) {
        typeLabel += ` (${d.naesinStart} ~ ${d.naesinEnd})`;
    }
    if (d.classType === '자유학기' && d.freeStart) {
        typeLabel += ` (${d.freeStart} ~ ${d.freeEnd || '미정'})`;
    }
    if (d.classType === '특강' && d.specialStart) {
        typeLabel += ` (${d.specialStart} ~ ${d.specialEnd || '미정'})`;
    }
    if (d.classType === '기타' && d.otherStart) {
        typeLabel += ` (${d.otherStart} ~ ${d.otherEnd || '무기한'})`;
    }

    card.innerHTML = `
        <div class="summary-row">
            <span class="summary-label">반 유형</span>
            <span class="summary-value">${esc(typeLabel)}</span>
        </div>
        <div class="summary-row">
            <span class="summary-label">반 코드</span>
            <span class="summary-value">${esc(d.classCode || '미입력')}</span>
        </div>
        <div class="summary-row">
            <span class="summary-label">담당</span>
            <span class="summary-value">${esc(teacherName)}</span>
        </div>
        <div class="summary-row">
            <span class="summary-label">요일/시간</span>
            <span class="summary-value">${esc(dayTimeStr)}</span>
        </div>
        <div class="summary-row">
            <span class="summary-label">학생 (${d.students.length}명)</span>
            <div class="summary-students-list">
                ${d.students.map(s => `<span class="summary-student-tag">${esc(s.name)}</span>`).join('')}
            </div>
        </div>
    `;
}
