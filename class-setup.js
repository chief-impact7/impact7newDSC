import { onAuthStateChanged } from 'firebase/auth';
import {
    collection, getDocs, doc, getDoc, query, where, writeBatch, arrayUnion
} from 'firebase/firestore';
import { auth, db } from './firebase-config.js';
import { signInWithGoogle, logout } from './auth.js';
import { todayStr } from './src/shared/firestore-helpers.js';
import { auditSet, batchUpdate } from './audit.js';

// ─── State ──────────────────────────────────────────────────────────────────
let currentUser = null;
let currentStep = 1;
const TOTAL_STEPS = 5;

// 마법사 데이터
const wizardData = {
    classType: '',       // '정규' | '내신' | '자유학기' | '특강'
    classCode: '',       // 생성될 반 코드
    levelSymbol: '',
    classNumber: '',
    school: '',
    grade: '',
    naesinGroup: '',     // 'A' | 'B'
    specialName: '',
    naesinStart: '',
    naesinEnd: '',
    specialStart: '',
    specialEnd: '',
    freeStart: '',
    freeEnd: '',
    teacher: '',
    students: [],        // [{ docId, name, school, grade, status, enrollments }]
    days: [],            // ['월', '수', '금']
    schedule: {},        // { '월': '16:00', '수': '16:00' }
};

let allStudents = [];
let teachersList = [];

// ─── Auth ───────────────────────────────────────────────────────────────────
onAuthStateChanged(auth, async (user) => {
    if (user) {
        const email = user.email || '';
        if (!email.endsWith('@gw.impact7.kr') && !email.endsWith('@impact7.kr')) {
            await logout();
            showToast('허용되지 않은 계정입니다.', 'error');
            return;
        }
        currentUser = user;
        window._auditUser = email;
        document.getElementById('login-screen').style.display = 'none';
        document.getElementById('main-screen').style.display = '';
        document.getElementById('user-email').textContent = email.split('@')[0];
        await Promise.all([loadStudents(), loadTeachers()]);
    } else {
        currentUser = null;
        document.getElementById('login-screen').style.display = '';
        document.getElementById('main-screen').style.display = 'none';
    }
});

async function loadStudents() {
    const snap = await getDocs(
        query(collection(db, 'students'), where('status', 'in', ['등원예정', '재원', '실휴원', '가휴원']))
    );
    allStudents = [];
    snap.forEach(d => {
        const data = d.data();
        allStudents.push({ docId: d.id, ...data });
    });
    allStudents.sort((a, b) => (a.name || '').localeCompare(b.name || '', 'ko'));
}

async function loadTeachers() {
    const snap = await getDocs(collection(db, 'teachers'));
    teachersList = [];
    snap.forEach(d => teachersList.push({ email: d.id, ...d.data() }));
    teachersList.sort((a, b) =>
        (a.display_name || a.email).localeCompare(b.display_name || b.email, 'ko')
    );
    // 선생님 드롭다운 채우기
    const sel = document.getElementById('input-teacher');
    sel.innerHTML = '<option value="">선택</option>' +
        teachersList.map(t =>
            `<option value="${esc(t.email)}">${esc(t.email.split('@')[0])}</option>`
        ).join('');
}

// ─── Navigation ─────────────────────────────────────────────────────────────
function goToStep(step) {
    if (step < 1 || step > TOTAL_STEPS) return;
    // 현재 스텝 숨기기
    document.getElementById(`step-${currentStep}`).style.display = 'none';
    currentStep = step;
    document.getElementById(`step-${currentStep}`).style.display = '';

    // 진행 표시 업데이트
    document.querySelectorAll('.progress-step').forEach((el, i) => {
        const s = i + 1;
        el.classList.toggle('active', s === currentStep);
        el.classList.toggle('done', s < currentStep);
    });
    document.querySelectorAll('.progress-line').forEach((el, i) => {
        el.classList.toggle('done', i + 1 < currentStep);
    });

    // 버튼 업데이트
    document.getElementById('btn-back').style.display = currentStep === 1 ? 'none' : '';
    document.getElementById('btn-next').style.display = currentStep === TOTAL_STEPS ? 'none' : '';
    document.getElementById('btn-submit').style.display = currentStep === TOTAL_STEPS ? '' : 'none';

    // 스텝별 진입 처리
    if (currentStep === 2) onEnterStep2();
    if (currentStep === 3) onEnterStep3();
    if (currentStep === 5) renderSummary();
}

window.nextStep = function () {
    if (!validateStep(currentStep)) return;
    goToStep(currentStep + 1);
};

window.prevStep = function () {
    goToStep(currentStep - 1);
};

function validateStep(step) {
    if (step === 1) {
        if (!wizardData.classType) {
            showToast('반 유형을 선택하세요.', 'error');
            return false;
        }
    }
    if (step === 2) {
        if (!buildClassCode()) {
            showToast('반 이름 정보를 입력하세요.', 'error');
            return false;
        }
        wizardData.teacher = document.getElementById('input-teacher').value;
    }
    if (step === 3) {
        if (wizardData.students.length === 0) {
            showToast('학생을 1명 이상 추가하세요.', 'error');
            return false;
        }
    }
    if (step === 4) {
        if (wizardData.days.length === 0) {
            showToast('요일을 1개 이상 선택하세요.', 'error');
            return false;
        }
        // 시간 수집
        wizardData.schedule = {};
        wizardData.days.forEach(day => {
            const input = document.getElementById(`time-${day}`);
            wizardData.schedule[day] = input?.value || '16:00';
        });
    }
    return true;
}

// ─── Step 1: 반 유형 ────────────────────────────────────────────────────────
window.selectClassType = function (type) {
    wizardData.classType = type;
    document.querySelectorAll('.type-card').forEach(c => {
        c.classList.toggle('selected', c.dataset.type === type);
    });
};

// ─── Step 2: 반 이름 ────────────────────────────────────────────────────────
function onEnterStep2() {
    const t = wizardData.classType;
    document.getElementById('name-regular').style.display = (t === '정규' || t === '자유학기') ? '' : 'none';
    document.getElementById('name-naesin').style.display = t === '내신' ? '' : 'none';
    document.getElementById('name-special').style.display = t === '특강' ? '' : 'none';
    document.getElementById('free-semester-dates').style.display = t === '자유학기' ? '' : 'none';

    if (t === '내신') populateSchoolList();

    // 날짜 유효성: 종료일 >= 시작일
    setupDateValidation('input-free-start', 'input-free-end');
    setupDateValidation('input-naesin-start', 'input-naesin-end');
    setupDateValidation('input-special-start', 'input-special-end');

    // 프리뷰 업데이트 이벤트
    ['input-level', 'input-class-number'].forEach(id => {
        const el = document.getElementById(id);
        el.removeEventListener('input', updateRegularPreview);
        el.addEventListener('input', updateRegularPreview);
    });
    ['input-school', 'input-grade', 'input-naesin-group'].forEach(id => {
        const el = document.getElementById(id);
        el.removeEventListener('input', updateNaesinPreview);
        el.addEventListener('input', updateNaesinPreview);
        el.removeEventListener('change', updateNaesinPreview);
        el.addEventListener('change', updateNaesinPreview);
    });
    const specialInput = document.getElementById('input-special-name');
    specialInput.removeEventListener('input', updateSpecialPreview);
    specialInput.addEventListener('input', updateSpecialPreview);
}

const _dateHandlers = new Map();
function setupDateValidation(startId, endId) {
    const startEl = document.getElementById(startId);
    const endEl = document.getElementById(endId);
    if (!startEl || !endEl) return;
    const prev = _dateHandlers.get(startId);
    if (prev) startEl.removeEventListener('change', prev);
    const handler = () => {
        if (startEl.value) endEl.min = startEl.value;
        if (endEl.value && startEl.value && endEl.value < startEl.value) {
            endEl.value = startEl.value;
        }
    };
    _dateHandlers.set(startId, handler);
    startEl.addEventListener('change', handler);
    handler();
}

function updateRegularPreview() {
    const level = document.getElementById('input-level').value.trim();
    const num = document.getElementById('input-class-number').value.trim();
    const code = level && num ? `${level}${num}` : '';
    document.getElementById('regular-preview').textContent = code || '';
    wizardData.levelSymbol = level;
    wizardData.classNumber = num;
}

function updateNaesinPreview() {
    const school = document.getElementById('input-school').value.trim();
    const grade = document.getElementById('input-grade').value;
    const group = document.getElementById('input-naesin-group').value;
    const code = school && grade ? `${school}${grade}${group}` : '';
    document.getElementById('naesin-preview').textContent = code || '';
    wizardData.school = school;
    wizardData.grade = grade;
    wizardData.naesinGroup = group;
    wizardData.naesinStart = document.getElementById('input-naesin-start').value;
    wizardData.naesinEnd = document.getElementById('input-naesin-end').value;
}

function updateSpecialPreview() {
    const name = document.getElementById('input-special-name').value.trim();
    document.getElementById('special-preview').textContent = name || '';
    wizardData.specialName = name;
    wizardData.specialStart = document.getElementById('input-special-start').value;
    wizardData.specialEnd = document.getElementById('input-special-end').value;
}

function populateSchoolList() {
    const schools = new Set();
    allStudents.forEach(s => { if (s.school) schools.add(s.school); });
    const dl = document.getElementById('school-list');
    dl.innerHTML = [...schools].sort((a, b) => a.localeCompare(b, 'ko'))
        .map(s => `<option value="${esc(s)}">`).join('');
}

function buildClassCode() {
    const t = wizardData.classType;
    if (t === '정규' || t === '자유학기') {
        const l = document.getElementById('input-level').value.trim();
        const n = document.getElementById('input-class-number').value.trim();
        if (!l || !n) return '';
        wizardData.classCode = `${l}${n}`;
        if (t === '자유학기') {
            wizardData.freeStart = document.getElementById('input-free-start').value;
            wizardData.freeEnd = document.getElementById('input-free-end').value;
        }
        return wizardData.classCode;
    }
    if (t === '내신') {
        const s = document.getElementById('input-school').value.trim();
        const g = document.getElementById('input-grade').value;
        const grp = document.getElementById('input-naesin-group').value;
        if (!s || !g) return '';
        wizardData.classCode = `${s}${g}${grp}`;
        return wizardData.classCode;
    }
    if (t === '특강') {
        const name = document.getElementById('input-special-name').value.trim();
        if (!name) return '';
        wizardData.classCode = name;
        return wizardData.classCode;
    }
    return '';
}

// ─── Step 3: 학생 추가 ─────────────────────────────────────────────────────
function onEnterStep3() {
    renderSelectedStudents();
}

window.searchStudents = function (q) {
    const results = document.getElementById('search-results');
    q = q.trim().toLowerCase();
    if (!q) { results.innerHTML = ''; return; }

    const selectedIds = new Set(wizardData.students.map(s => s.docId));
    // 재원생 우선 정렬
    const filtered = allStudents
        .filter(s => {
            const name = (s.name || '').toLowerCase();
            const school = (s.school || '').toLowerCase();
            return name.includes(q) || school.includes(q);
        })
        .sort((a, b) => {
            const aActive = a.status === '재원' ? 0 : 1;
            const bActive = b.status === '재원' ? 0 : 1;
            return aActive - bActive || (a.name || '').localeCompare(b.name || '', 'ko');
        })
        .slice(0, 20);

    results.innerHTML = filtered.map(s => {
        const alreadySelected = selectedIds.has(s.docId);
        const meta = [s.school, s.grade ? `${s.grade}학년` : ''].filter(Boolean).join(' ');
        return `<div class="search-result-item ${alreadySelected ? 'already-selected' : ''}"
                     onclick="addStudent('${s.docId}')">
                    <div class="result-info">
                        <span class="result-name">${esc(s.name)}</span>
                        <span class="result-meta">${esc(meta)}</span>
                    </div>
                    <span class="result-status">${esc(s.status)}</span>
                </div>`;
    }).join('');
};

window.addStudent = function (docId) {
    if (wizardData.students.some(s => s.docId === docId)) return;
    const s = allStudents.find(s => s.docId === docId);
    if (!s) return;
    wizardData.students.push(s);
    renderSelectedStudents();
    // 검색 결과 갱신
    const searchInput = document.getElementById('student-search');
    if (searchInput.value) window.searchStudents(searchInput.value);
};

window.removeStudent = function (docId) {
    wizardData.students = wizardData.students.filter(s => s.docId !== docId);
    renderSelectedStudents();
    const searchInput = document.getElementById('student-search');
    if (searchInput.value) window.searchStudents(searchInput.value);
};

function renderSelectedStudents() {
    document.getElementById('selected-count').textContent = wizardData.students.length;
    const list = document.getElementById('selected-list');
    if (wizardData.students.length === 0) {
        list.innerHTML = '<div class="empty-selected">검색으로 학생을 추가하세요</div>';
        return;
    }
    list.innerHTML = wizardData.students.map(s => {
        const meta = [s.school, s.grade ? `${s.grade}학년` : ''].filter(Boolean).join(' ');
        return `<div class="selected-chip">
                    <div class="selected-chip-info">
                        <span class="selected-chip-name">${esc(s.name)}</span>
                        <span class="selected-chip-meta">${esc(meta)}</span>
                    </div>
                    <button class="remove-btn" onclick="removeStudent('${s.docId}')">
                        <span class="material-symbols-outlined" style="font-size:18px;">close</span>
                    </button>
                </div>`;
    }).join('');
}

// ─── Step 4: 요일 ───────────────────────────────────────────────────────────
window.toggleDay = function (day) {
    const idx = wizardData.days.indexOf(day);
    if (idx >= 0) wizardData.days.splice(idx, 1);
    else wizardData.days.push(day);

    // 요일 순서 정렬
    const order = ['월', '화', '수', '목', '금', '토'];
    wizardData.days.sort((a, b) => order.indexOf(a) - order.indexOf(b));

    // 칩 상태 업데이트
    document.querySelectorAll('.day-chip').forEach(c => {
        c.classList.toggle('selected', wizardData.days.includes(c.dataset.day));
    });

    // 시간 입력 렌더링
    renderTimeSettings();
};

function renderTimeSettings() {
    const container = document.getElementById('time-settings');
    container.innerHTML = wizardData.days.map(day => {
        const prev = wizardData.schedule[day] || '16:00';
        return `<div class="time-row">
                    <label>${day}</label>
                    <input type="time" id="time-${day}" value="${prev}">
                </div>`;
    }).join('');
}

// ─── Step 5: 요약 ───────────────────────────────────────────────────────────
function renderSummary() {
    const d = wizardData;
    const teacherName = d.teacher ? d.teacher.split('@')[0] : '미지정';
    const dayTimeStr = d.days.map(day => `${day} ${d.schedule[day] || ''}`).join(', ');

    let typeLabel = d.classType;
    if (d.classType === '내신' && d.naesinStart && d.naesinEnd) {
        typeLabel += ` (${d.naesinStart} ~ ${d.naesinEnd})`;
    }
    if (d.classType === '자유학기' && d.freeStart) {
        typeLabel += ` (${d.freeStart} ~ ${d.freeEnd || '미정'})`;
    }
    if (d.classType === '특강' && d.specialStart) {
        typeLabel += ` (${d.specialStart} ~ ${d.specialEnd || '미정'})`;
    }

    const card = document.getElementById('summary-card');
    card.innerHTML = `
        <div class="summary-row">
            <span class="summary-label">반 유형</span>
            <span class="summary-value">${esc(typeLabel)}</span>
        </div>
        <div class="summary-row">
            <span class="summary-label">반 코드</span>
            <span class="summary-value">${esc(d.classCode)}</span>
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

// ─── Submit ─────────────────────────────────────────────────────────────────
window.submitWizard = async function () {
    const btn = document.getElementById('btn-submit');
    btn.disabled = true;
    btn.textContent = '생성 중...';

    try {
        const d = wizardData;

        // 1. 기존 class_settings에 같은 코드가 있는지 확인
        const existingDoc = await getDoc(doc(db, 'class_settings', d.classCode));
        if (existingDoc.exists()) {
            const ok = confirm(`"${d.classCode}" 반이 이미 존재합니다. 설정을 덮어쓰시겠습니까?`);
            if (!ok) { btn.disabled = false; btn.textContent = '반 생성'; return; }
        }

        // 2. class_settings 문서 생성/업데이트
        const classSettingsData = {
            teacher: d.teacher || '',
            class_type: d.classType,
        };
        if (d.classType === '내신') {
            classSettingsData.naesin_start = d.naesinStart;
            classSettingsData.naesin_end = d.naesinEnd;
            classSettingsData.schedule = d.schedule;
        } else {
            classSettingsData.schedule = d.schedule;
        }
        await auditSet(doc(db, 'class_settings', d.classCode), classSettingsData, { merge: true });

        // 3. 학생별 enrollment 추가 (batch + arrayUnion으로 경합 방지)
        const today = todayStr();
        const batch = writeBatch(db);
        for (const student of d.students) {
            const studentRef = doc(db, 'students', student.docId);

            const newEnrollment = {
                class_type: d.classType,
                level_symbol: d.levelSymbol || '',
                class_number: d.classNumber || '',
                day: d.days,
                start_date: today,
            };

            if (d.classType === '내신') {
                newEnrollment.level_symbol = '';
                newEnrollment.class_number = '';
            }

            if (d.classType === '특강') {
                newEnrollment.level_symbol = '';
                newEnrollment.class_number = '';
                if (d.specialStart) newEnrollment.start_date = d.specialStart;
                if (d.specialEnd) newEnrollment.end_date = d.specialEnd;
            }

            batchUpdate(batch, studentRef, {
                enrollments: arrayUnion(newEnrollment),
            });
        }
        await batch.commit();

        showToast(`"${d.classCode}" 반이 생성되었습니다! (${d.students.length}명)`, 'success');

        // 3초 후 DSC 홈으로 이동
        setTimeout(() => { window.location.href = '/'; }, 2000);

    } catch (err) {
        console.error('[submitWizard]', err);
        showToast(`생성 실패: ${err.message}`, 'error');
    } finally {
        btn.disabled = false;
        btn.innerHTML = '<span class="material-symbols-outlined">check</span> 반 생성';
    }
};

// ─── Login ──────────────────────────────────────────────────────────────────
window.handleLogin = async function () {
    try {
        await signInWithGoogle();
    } catch (err) {
        showToast('로그인 실패: ' + err.message, 'error');
    }
};

window.handleLogout = async function () {
    await logout();
};

// ─── Helpers ────────────────────────────────────────────────────────────────
function esc(str) {
    const d = document.createElement('div');
    d.textContent = str ?? '';
    return d.innerHTML;
}

function showToast(msg, type = 'success') {
    const container = document.getElementById('toast-container');
    const toast = document.createElement('div');
    toast.className = `toast ${type}`;
    toast.textContent = msg;
    container.appendChild(toast);
    setTimeout(() => toast.remove(), 3000);
}
