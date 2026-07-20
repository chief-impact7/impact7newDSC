import { msIcon } from './ms-icon.js';
import { onAuthStateChanged } from 'firebase/auth';
import {
    collection, getDocs, getDocsFromCache, doc, getDoc, writeBatch, arrayUnion, deleteField, serverTimestamp
} from 'firebase/firestore';
import { auth, db } from './firebase-config.js';
import { ENROLLABLE_STATUSES, isEnrollableStatus } from '@impact7/shared/enrollment-status';
import { signInWithGoogle, logout } from './auth.js';
import { fetchPopulationPerms } from './population-perms.js';
import {
    currentSchool,
    studentGrade,
    studentLevel,
    todayStr,
    studentShortLabel,
    ACTIVE_STUDENT_STATUSES
} from './src/shared/firestore-helpers.js';
import { LEVEL_SHORT, state, DAY_ORDER } from './state.js';
import { buildNaesinCsKey, isActiveNaesinBase } from './student-helpers.js';
import { schoolSearchTerms } from './school-normalizer.js';
import { batchSet, batchUpdate, normalizeImpact7Email } from './audit.js';
import { recordTeacherChange } from './teacher-history.js';
import { staffLabel } from '@impact7/shared/staff-label';
import { teacherDisplayName } from '@impact7/shared/teacher-label';
import {
    buildClassTimeFields,
    buildReactivationCleanupFields,
    buildReactivationHistoryBefore,
    hasActiveRegularClass,
    resolveRegularDefaultTime,
} from './class-setup-enrollment.js';
import { esc } from './ui-utils.js';
import {
    wizardData,
    allStudents,
    teachersList,
    showToast,
    renderSummary,
    popPerms,
} from './class-setup-state.js';
import { initPlanner } from './class-setup-planner.js';

const CLASS_TYPE_LABELS = {
    '정규': '정규반',
    '내신': '내신반',
    '자유학기': '자유학기반',
    '특강': '특강',
};

function setStepTitle(id, suffix) {
    const el = document.getElementById(id);
    if (!el) return;
    const label = CLASS_TYPE_LABELS[wizardData.classType] || '반';
    el.textContent = `${label} ${suffix}`;
}

// ─── State ──────────────────────────────────────────────────────────────────
let currentUser = null;
let currentStep = 1;
const TOTAL_STEPS = 2;


// ─── Auth ───────────────────────────────────────────────────────────────────
onAuthStateChanged(auth, async (user) => {
    if (user) {
        const email = user.email || '';
        if (!email.endsWith('@impact7.kr') && !email.endsWith('@gw.impact7.kr')) {
            await logout();
            showToast('허용되지 않은 계정입니다.', 'error');
            return;
        }
        currentUser = user;
        window._auditUser = normalizeImpact7Email(email);
        document.getElementById('login-screen').style.display = 'none';
        document.getElementById('boot-splash')?.remove();
        document.getElementById('main-screen').style.display = '';
        document.getElementById('user-email').textContent = staffLabel(email);
        await Promise.all([
            loadStudents(),
            loadTeachers(),
            fetchPopulationPerms(user.uid).then(p => Object.assign(popPerms, p)),
        ]);
        bindStudentEventDelegation();
        // 학생 로드 도중 step 2 진입(정규 카드 빠르게 클릭)했을 수 있음 — 빈 데이터로 그려진
        // 정규반 분석/학생 추가 패널을 재렌더해 채워준다.
        if (currentStep === 2) onEnterStep2();
    } else {
        currentUser = null;
        Object.assign(popPerms, { all: false, classCounts: false });
        document.getElementById('boot-splash')?.remove();
        document.getElementById('login-screen').style.display = '';
        document.getElementById('main-screen').style.display = 'none';
    }
});

function _applyStudentDocs(snap) {
    allStudents.length = 0;
    snap.forEach(d => {
        const data = d.data();
        allStudents.push({ docId: d.id, ...data });
    });
    allStudents.sort((a, b) => (a.name || '').localeCompare(b.name || '', 'ko'));
}

async function loadStudents() {
    const col = collection(db, 'students');
    try {
        const cached = await getDocsFromCache(col);
        if (cached.size > 0) _applyStudentDocs(cached);
    } catch { /* 캐시 없음 */ }
    const snap = await getDocs(col);
    _applyStudentDocs(snap);
}

// 담임 표시 규약(@impact7/shared teacher-label): 이메일 로컬파트 첫 글자 대문자 ('edward@…' → 'Edward')
const teacherLabelOf = (email) => teacherDisplayName(staffLabel(email)) || staffLabel(email);

async function loadTeachers() {
    // 담당 목록·표시이름의 정본은 HR 인사(staff_directory 미러) — 재직 교수만 후보.
    const snap = await getDocs(collection(db, 'staff_directory'));
    teachersList.length = 0;
    snap.forEach(d => {
        const data = d.data();
        if (data.department !== '교수' || data.assignable !== true) return;
        const email = String(data.email || '').trim().toLowerCase();
        if (!email) return;
        const name = (typeof data.english_name === 'string' && data.english_name.trim())
            ? data.english_name.trim() : teacherLabelOf(email);
        teachersList.push({ email, name });
    });
    teachersList.sort((a, b) => a.name.localeCompare(b.name, 'ko'));
    // 선생님 드롭다운 채우기
    const sel = document.getElementById('input-teacher');
    sel.innerHTML = '<option value="">선택</option>' +
        teachersList.map(t => `<option value="${esc(t.email)}">${esc(t.name)}</option>`).join('');
}

// ─── Navigation ─────────────────────────────────────────────────────────────
function goToStep(step) {
    if (step < 1 || step > TOTAL_STEPS) return;
    document.getElementById(`step-${currentStep}`).style.display = 'none';
    currentStep = step;
    document.getElementById(`step-${currentStep}`).style.display = '';

    document.querySelectorAll('.progress-step').forEach((el, i) => {
        const s = i + 1;
        el.classList.toggle('active', s === currentStep);
        el.classList.toggle('done', s < currentStep);
    });
    document.querySelectorAll('.progress-line').forEach((el, i) => {
        el.classList.toggle('done', i + 1 < currentStep);
    });

    document.getElementById('btn-back').style.display = currentStep === 1 ? 'none' : '';
    document.getElementById('btn-submit').style.display = currentStep === TOTAL_STEPS ? '' : 'none';

    if (currentStep === 2) onEnterStep2();
}

window.prevStep = function () {
    goToStep(currentStep - 1);
};

// DOM에서 wizardData로 모든 form 데이터를 한 번에 끌어모은다 (부수효과 전용).
function collectFormData() {
    buildClassCode();
    wizardData.teacher = document.getElementById('input-teacher').value;
    if (wizardData.classType === '정규') {
        wizardData.defaultTime = document.getElementById('time-default')?.value || '16:00';
        wizardData.schedule = {};
        return;
    }
    wizardData.schedule = Object.fromEntries(
        wizardData.days.map(day => [
            day,
            document.getElementById(`time-${day}`)?.value || '16:00',
        ])
    );
}

// wizardData만 검사하는 순수 검증기 (부수효과 없음).
function validateForm() {
    if (!wizardData.classCode) {
        showToast('반 이름 정보를 입력하세요.', 'error');
        return false;
    }
    // class_type ↔ 반 코드 정합성 가드:
    // 정규/자유학기는 레벨(level_symbol)과 반 번호(class_number)가 모두 명시되어야 한다.
    // 한쪽만 입력된 채 등록되면 정채리 케이스처럼 "정규인데 반 미지정" placeholder가 생긴다.
    if (wizardData.classType === '정규' || wizardData.classType === '자유학기') {
        if (!wizardData.levelSymbol || !wizardData.classNumber) {
            showToast(`${wizardData.classType} 반은 레벨과 반 번호를 모두 입력해야 합니다.`, 'error');
            return false;
        }
    }
    if (wizardData.classType === '특강' && !wizardData.feeType) {
        showToast('유료/무료를 선택하세요.', 'error');
        return false;
    }
    if (wizardData.students.length === 0) {
        showToast('학생을 1명 이상 추가하세요.', 'error');
        return false;
    }
    if (wizardData.days.length === 0) {
        showToast('요일을 1개 이상 선택하세요.', 'error');
        return false;
    }
    return true;
}

// ─── Step 1: 반 유형 ────────────────────────────────────────────────────────
// 카드 클릭 시 type 저장 → 자동으로 Step 2 진행. 서로 다른 type으로 전환 시 stale 데이터 reset.
window.chooseClassTypeAndAdvance = function (type) {
    if (wizardData.classType && wizardData.classType !== type) {
        resetWizardForTypeChange();
    }
    wizardData.classType = type;
    document.querySelectorAll('.type-card').forEach(c => {
        c.classList.toggle('selected', c.dataset.type === type);
    });
    goToStep(2);
};

// 타입 전환 시 stale 데이터 누적을 막기 위해 type 외 모든 wizardData 필드와
// 관련 DOM(input value, day-chip/fee-btn .selected)을 초기화한다.
// classType 자체는 호출자가 직후에 새 값으로 덮어쓴다.
function resetWizardForTypeChange() {
    Object.assign(wizardData, {
        feeType: '', classCode: '',
        levelSymbol: '', classNumber: '',
        school: '', grade: '',
        naesinBranch: '', naesinLevel: '', naesinGroup: '',
        specialName: '',
        naesinStart: '', naesinEnd: '',
        specialStart: '', specialEnd: '',
        freeStart: '', freeEnd: '',
        teacher: '',
        students: [], days: [], defaultTime: '', defaultTimeEdited: false, schedule: {},
    });

    [
        'input-level', 'input-class-number',
        'input-free-start', 'input-free-end',
        'input-naesin-branch', 'input-naesin-level',
        'input-school', 'input-grade', 'input-naesin-group',
        'input-naesin-start', 'input-naesin-end',
        'input-special-name', 'input-special-start', 'input-special-end',
        'input-teacher',
    ].forEach(id => {
        const el = document.getElementById(id);
        if (el) el.value = '';
    });

    document.querySelectorAll('.day-chip').forEach(c => c.classList.remove('selected'));
    document.querySelectorAll('.fee-type-btn').forEach(c => c.classList.remove('selected'));

    ['regular-preview', 'naesin-preview', 'special-preview'].forEach(id => {
        const el = document.getElementById(id);
        if (el) el.textContent = '';
    });
}

// ─── Step 2: 반 이름 ────────────────────────────────────────────────────────
function onEnterStep2() {
    const t = wizardData.classType;
    toggleNameForms(t);
    refreshStepTitles();
    togglePlannerPanel(t);

    renderSelectedStudents();
    renderTimeSettings();
    renderSummary();

    bindDateValidations();
    bindPreviewListeners();
    syncPreviewFromDom(t);
    restoreFeeButtonState(t);
}

function toggleNameForms(t) {
    document.getElementById('name-regular').style.display = (t === '정규' || t === '자유학기') ? '' : 'none';
    document.getElementById('name-naesin').style.display = t === '내신' ? '' : 'none';
    document.getElementById('name-special').style.display = t === '특강' ? '' : 'none';
    document.getElementById('free-semester-dates').style.display = t === '자유학기' ? '' : 'none';
}

function refreshStepTitles() {
    setStepTitle('step-2-title', '상세 설정');
    setStepTitle('section-title-name', '이름');
    setStepTitle('section-title-students', '학생 추가');
}

function togglePlannerPanel(t) {
    const showPlanner = (t === '내신' || t === '정규' || t === '자유학기');
    const mode = (t === '내신') ? '내신' : '정규';
    const body = document.getElementById('step-2-body');
    const planner = document.getElementById('planner-panel');
    if (planner) planner.style.display = showPlanner ? '' : 'none';
    if (body) body.classList.toggle('with-planner', showPlanner);
    if (!showPlanner) return;

    // 모드별 헤더 + 필터 가시성
    const titleEl = document.getElementById('planner-title');
    const subtitleEl = document.getElementById('planner-subtitle');
    if (titleEl) titleEl.textContent = (mode === '내신') ? '내신반 계획' : '정규반 분석';
    if (subtitleEl) subtitleEl.textContent = (mode === '내신')
        ? '재원생을 학교/학부/학년/요일로 분류해 보여줍니다.'
        : '재원생을 정규반(예: I102)별로 묶고 소속/학부로 필터합니다.';
    const showNaesinOnly = (mode === '내신');
    ['planner-filter-school', 'planner-filter-grade', 'planner-filter-day'].forEach(id => {
        const el = document.getElementById(id);
        if (el && el.parentElement) el.parentElement.style.display = showNaesinOnly ? '' : 'none';
    });
    // 다운로드 버튼은 정규/자유학기/내신 모두에서 노출
    const downloads = document.getElementById('planner-download-actions');
    if (downloads) downloads.style.display = '';

    initPlanner(mode);
    if (mode === '내신') populateSchoolList();
}

function bindDateValidations() {
    setupDateValidation('input-free-start', 'input-free-end');
    setupDateValidation('input-naesin-start', 'input-naesin-end');
    setupDateValidation('input-special-start', 'input-special-end');
}

// 동일 element-event 조합에 핸들러를 안전하게 재바인딩(중복 등록 방지).
function rebind(ids, events, handler) {
    (Array.isArray(ids) ? ids : [ids]).forEach(id => {
        const el = document.getElementById(id);
        if (!el) return;
        (Array.isArray(events) ? events : [events]).forEach(ev => {
            el.removeEventListener(ev, handler);
            el.addEventListener(ev, handler);
        });
    });
}

function bindPreviewListeners() {
    rebind(
        ['input-level', 'input-class-number', 'input-free-start', 'input-free-end'],
        ['input', 'change'], updateRegularPreview);
    rebind(
        ['input-naesin-branch', 'input-naesin-level', 'input-school', 'input-grade',
         'input-naesin-group', 'input-naesin-start', 'input-naesin-end'],
        ['input', 'change'], updateNaesinPreview);
    rebind(
        ['input-special-name', 'input-special-start', 'input-special-end'],
        ['input', 'change'], updateSpecialPreview);
    rebind('input-teacher', 'change', updateTeacherPreview);
}

// step 재진입 시 DOM 값을 wizardData로 강제 동기화하고 미리보기 갱신
function syncPreviewFromDom(t) {
    if (t === '정규' || t === '자유학기') updateRegularPreview();
    else if (t === '내신') updateNaesinPreview();
    else if (t === '특강') updateSpecialPreview();
    updateTeacherPreview();
}

function restoreFeeButtonState(t) {
    if (t !== '특강') return;
    document.querySelectorAll('.fee-type-btn').forEach(b => {
        const isSelected = b.dataset.fee === wizardData.feeType;
        b.classList.toggle('selected', isSelected);
        b.setAttribute('aria-pressed', String(isSelected));
    });
}

function updateTeacherPreview() {
    wizardData.teacher = document.getElementById('input-teacher').value;
    renderSummary();
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
    document.getElementById('regular-preview').textContent = code;
    wizardData.levelSymbol = level;
    wizardData.classNumber = num;
    wizardData.classCode = code;
    if (wizardData.classType === '자유학기') {
        wizardData.freeStart = document.getElementById('input-free-start').value;
        wizardData.freeEnd = document.getElementById('input-free-end').value;
    }
    renderSummary();
}

function updateNaesinPreview() {
    const code = buildClassCode();
    document.getElementById('naesin-preview').textContent = code || '';
    wizardData.naesinStart = document.getElementById('input-naesin-start').value;
    wizardData.naesinEnd = document.getElementById('input-naesin-end').value;
    populateSchoolList();
    renderSummary();
}

function updateSpecialPreview() {
    const name = document.getElementById('input-special-name').value.trim();
    document.getElementById('special-preview').textContent = name;
    wizardData.specialName = name;
    wizardData.specialStart = document.getElementById('input-special-start').value;
    wizardData.specialEnd = document.getElementById('input-special-end').value;
    wizardData.classCode = name;
    renderSummary();
}

window.selectFeeType = function (type) {
    wizardData.feeType = type;
    document.querySelectorAll('.fee-type-btn').forEach(b => {
        const isSelected = b.dataset.fee === type;
        b.classList.toggle('selected', isSelected);
        b.setAttribute('aria-pressed', String(isSelected));
    });
    renderSummary();
};

function populateSchoolList() {
    const selectedShort = document.getElementById('input-naesin-level')?.value || '';
    const schools = new Set();
    allStudents.forEach(s => {
        const school = (currentSchool(s) || '').trim();
        if (s.status !== '재원' || !school) return;
        if (selectedShort && LEVEL_SHORT[studentLevel(s)] !== selectedShort) return;
        schools.add(school);
    });
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
        const br = document.getElementById('input-naesin-branch').value;
        const lv = document.getElementById('input-naesin-level').value;
        const s = document.getElementById('input-school').value.trim();
        const g = document.getElementById('input-grade').value;
        const grp = document.getElementById('input-naesin-group').value;
        if (!br || !lv || !s || !g || !grp) return '';
        wizardData.naesinBranch = br;
        wizardData.naesinLevel = lv;
        wizardData.school = s;
        wizardData.grade = g;
        wizardData.naesinGroup = grp;
        wizardData.classCode = buildNaesinCsKey({ branch: br, school: s, level: lv, grade: g, group: grp });
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

// ─── 학생 추가 (Step 2 - students-section) ─────────────────────────────────
/** 전화번호 뒷 4자리 표시 (parent_phone_1 우선, 없으면 student_phone) */
function phoneSuffix(s) {
    const ph = s.parent_phone_1 || s.student_phone || '';
    const digits = ph.replace(/\D/g, '');
    if (digits.length < 4) return '';
    return ` (${digits.slice(-4)})`;
}

let _searchTimer = null;
window.searchStudents = function (q) {
    clearTimeout(_searchTimer);
    _searchTimer = setTimeout(() => _doSearchStudents(q), 250);
};

function _doSearchStudents(q) {
    const results = document.getElementById('search-results');
    q = q.trim().toLowerCase();
    if (!q) { results.innerHTML = ''; return; }

    const selectedIds = new Set(wizardData.students.map(s => s.docId));
    const isSpecial = wizardData.classType === '특강';

    // 특강: 모든 상태 허용하되 저장 시 재원 전환 확인.
    // 기타 반 유형: 공유 계약상 enrollment 보유 가능한 상태만 허용.
    const filtered = allStudents
        .filter(s => {
            if (!isSpecial) {
                if (!isEnrollableStatus(s.status)) return false;
                // 반배정(enrollment ≥1) 안 된 학생(상담생 등) 제외 — 첫 반배정은 DB에서 (수업이력 로그 남기기 위함)
                const hasClass = (s.enrollments || []).some(e => e && (e.level_symbol || e.class_number));
                if (!hasClass) return false;
            }
            const name = (s.name || '').toLowerCase();
            const schoolTerms = schoolSearchTerms(s).map(t => t.toLowerCase());
            const codeMatches = (s.enrollments || []).some(e =>
                `${e.level_symbol || ''}${e.class_number || ''}`.toLowerCase().includes(q)
            );
            return name.includes(q) || schoolTerms.some(t => t.includes(q)) || codeMatches;
        })
        .sort((a, b) => {
            // 활성 학생 우선 → 이름순
            const aActive = ACTIVE_STUDENT_STATUSES.has(a.status) ? 0 : 1;
            const bActive = ACTIVE_STUDENT_STATUSES.has(b.status) ? 0 : 1;
            return aActive - bActive || (a.name || '').localeCompare(b.name || '', 'ko');
        })
        .slice(0, 20);

    const html = filtered.map(s => {
        const alreadySelected = selectedIds.has(s.docId);
        const isInactive = !ACTIVE_STUDENT_STATUSES.has(s.status);
        return `<div class="search-result-item ${alreadySelected ? 'already-selected' : ''}"
                     data-doc-id="${esc(s.docId)}"
                     role="button" tabindex="${alreadySelected ? -1 : 0}" aria-disabled="${alreadySelected}">
                    <div class="result-info">
                        <span class="result-name">${esc(s.name)}</span>
                        <span class="result-meta">${esc(studentShortLabel(s))}${phoneSuffix(s)}</span>
                    </div>
                    <span class="result-status ${isInactive ? 'withdrawn' : ''}">${esc(s.status)}</span>
                </div>`;
    }).join('');

    results.innerHTML = html || '<div class="empty-selected">검색 결과 없음</div>';
}

// 검색 결과 / 선택 chip은 docId가 임의 ID일 수 있어 onclick 인라인을 피하고
// 컨테이너 단위 이벤트 위임으로 처리한다 (JS 문자열 인젝션 차단).
function bindStudentEventDelegation() {
    const results = document.getElementById('search-results');
    if (results && !results.dataset.delegated) {
        results.addEventListener('click', e => {
            const item = e.target.closest('.search-result-item[data-doc-id]');
            if (item) window.addStudent(item.dataset.docId);
        });
        results.addEventListener('keydown', e => {
            if (e.key === 'Enter' || e.key === ' ') {
                const item = e.target.closest('.search-result-item[data-doc-id]');
                if (item) { e.preventDefault(); window.addStudent(item.dataset.docId); }
            }
        });
        results.dataset.delegated = '1';
    }
    const list = document.getElementById('selected-list');
    if (list && !list.dataset.delegated) {
        list.addEventListener('click', e => {
            const btn = e.target.closest('.remove-btn[data-doc-id]');
            if (btn) window.removeStudent(btn.dataset.docId);
        });
        list.dataset.delegated = '1';
    }
}

window.addStudent = function (docId) {
    if (wizardData.students.some(s => s.docId === docId)) return;
    const found = allStudents.find(s => s.docId === docId);
    if (!found) return;

    if (
        (wizardData.classType === '내신' || wizardData.classType === '자유학기')
        && !isEnrollableStatus(found.status)
    ) {
        alert(`${found.name} 학생은 현재 "${found.status || '상태없음'}" 상태입니다.\n${wizardData.classType}반 등록은 ${[...ENROLLABLE_STATUSES].join('·')} 학생만 가능합니다.`);
        return;
    }

    if (wizardData.classType === '정규') {
        const classCode = buildClassCode();
        if (classCode && hasActiveRegularClass(found.enrollments, classCode, todayStr())) {
            showToast(`${found.name} 학생은 이미 ${classCode} 정규반에 등록되어 있습니다.`, 'error');
            return;
        }
    }

    if (wizardData.classType === '내신') {
        const checks = [
            ['학교', wizardData.school, currentSchool(found) || ''],
            ['과정', wizardData.naesinLevel, LEVEL_SHORT[studentLevel(found)] || ''],
            ['학년', String(wizardData.grade), studentGrade(found)],
        ];
        for (const [label, expected, actual] of checks) {
            if (expected !== actual) {
                showToast(`${label} 불일치: 마법사(${expected}) ↔ 학생(${actual || '미지정'})`, 'error');
                return;
            }
        }
    }

    // 자유학기제는 중학교 한정 운영 → 중등이 아니면 추가 차단
    if (wizardData.classType === '자유학기' && studentLevel(found) !== '중등') {
        showToast(`자유학기는 중학생만 추가 가능합니다 (학부: ${studentLevel(found) || '미지정'})`, 'error');
        return;
    }

    wizardData.students.push(found);
    renderSelectedStudents();
    refreshSearchAfterMutation();
};

window.removeStudent = function (docId) {
    const idx = wizardData.students.findIndex(s => s.docId === docId);
    if (idx !== -1) wizardData.students.splice(idx, 1);
    renderSelectedStudents();
    refreshSearchAfterMutation();
};

// 학생 추가/제거 직후엔 즉시 재검색하되 pending debounce를 취소해 중복 렌더 방지.
function refreshSearchAfterMutation() {
    const searchInput = document.getElementById('student-search');
    if (!searchInput?.value) return;
    clearTimeout(_searchTimer);
    _doSearchStudents(searchInput.value);
}

function renderSelectedStudents() {
    document.getElementById('selected-count').textContent = wizardData.students.length;
    const list = document.getElementById('selected-list');
    if (wizardData.students.length === 0) {
        list.innerHTML = '<div class="empty-selected">검색으로 학생을 추가하세요</div>';
    } else {
        list.innerHTML = wizardData.students.map(s => {
            const meta = studentShortLabel(s);
            return `<div class="selected-chip">
                        <div class="selected-chip-info">
                            <span class="selected-chip-name">${esc(s.name)}</span>
                            <span class="selected-chip-meta">${esc(meta)}</span>
                        </div>
                        <button class="remove-btn" type="button" data-doc-id="${esc(s.docId)}" aria-label="${esc(s.name)} 제거">
                            ${msIcon('close', '', 'style="font-size:18px;"')}
                        </button>
                    </div>`;
        }).join('');
    }
    renderSummary();
}

// ─── 요일 / 시간 (Step 2 - days-section) ────────────────────────────────────
window.toggleDay = function (day) {
    const idx = wizardData.days.indexOf(day);
    if (idx >= 0) wizardData.days.splice(idx, 1);
    else wizardData.days.push(day);

    wizardData.days.sort((a, b) => DAY_ORDER.indexOf(a) - DAY_ORDER.indexOf(b));

    document.querySelectorAll('.day-chip').forEach(c => {
        const isSelected = wizardData.days.includes(c.dataset.day);
        c.classList.toggle('selected', isSelected);
        c.setAttribute('aria-pressed', String(isSelected));
    });

    renderTimeSettings();
};

function renderTimeSettings() {
    const container = document.getElementById('time-settings');
    if (wizardData.classType === '정규') {
        wizardData.defaultTime ||= '16:00';
        container.innerHTML = `<div class="time-row">
                    <label for="time-default">공통</label>
                    <input type="time" id="time-default" value="${wizardData.defaultTime}" oninput="syncTimeFromInputs()">
                </div>`;
        renderSummary();
        return;
    }
    container.innerHTML = wizardData.days.map(day => {
        const time = wizardData.schedule[day] || '16:00';
        wizardData.schedule[day] = time;
        return `<div class="time-row">
                    <label for="time-${day}">${day}</label>
                    <input type="time" id="time-${day}" value="${time}" oninput="syncTimeFromInputs()">
                </div>`;
    }).join('');
    renderSummary();
}

window.syncTimeFromInputs = function () {
    if (wizardData.classType === '정규') {
        wizardData.defaultTime = document.getElementById('time-default')?.value || '16:00';
        wizardData.defaultTimeEdited = true;
        renderSummary();
        return;
    }
    wizardData.days.forEach(day => {
        const input = document.getElementById(`time-${day}`);
        if (input) wizardData.schedule[day] = input.value || '16:00';
    });
    renderSummary();
};

// ─── Submit ─────────────────────────────────────────────────────────────────
window.submitWizard = async function () {
    collectFormData();
    if (!validateForm()) return;
    const btn = document.getElementById('btn-submit');
    btn.disabled = true;
    btn.textContent = '생성 중...';

    try {
        const d = wizardData;
        if (d.classType === '내신' || d.classType === '자유학기') {
            const rejected = d.students.filter(student => !isEnrollableStatus(student.status));
            if (rejected.length) {
                alert(
                    `${d.classType}반을 생성할 수 없습니다.\n\n` +
                    `등록 가능 상태: ${[...ENROLLABLE_STATUSES].join('·')}\n` +
                    `대상 오류: ${rejected.map(s => `${s.name || s.docId} (${s.status || '상태없음'})`).join(', ')}`
                );
                return;
            }
        }

        // 1. 기존 class_settings에 같은 코드가 있는지 확인
        const existingDoc = await getDoc(doc(db, 'class_settings', d.classCode));
        const existingSettings = existingDoc.exists() ? existingDoc.data() : {};
        if (existingDoc.exists()) {
            // 내신 기간 변경 시 학생 enrollment.end_date 자동 sync 안내
            // (Cloud Function onClassSettingsNaesinPeriodChanged가 처리하지만 사용자에게 명시 인지시킴)
            const ex = existingSettings;
            let periodNote = '';
            if (d.classType === '내신' && ex.class_type === '내신' &&
                (ex.naesin_start !== d.naesinStart || ex.naesin_end !== d.naesinEnd)) {
                periodNote = `\n\n주의: 내신 기간이 [${ex.naesin_start || '?'} ~ ${ex.naesin_end || '?'}] → [${d.naesinStart} ~ ${d.naesinEnd}]로 변경됩니다.\n이 반에 매핑된 학생들의 내신 enrollment.end_date도 자동 sync됩니다 (Cloud Function).`;
            }
            const ok = confirm(`"${d.classCode}" 반이 이미 존재합니다. 설정을 덮어쓰시겠습니까?${periodNote}`);
            if (!ok) { btn.disabled = false; btn.textContent = '반 생성'; return; }
        }

        // 2. class_settings 데이터 준비 (commit은 batch에서 한번에)
        const classSettingsData = {
            teacher: d.teacher || '',
            ...buildClassTimeFields(
                d.classType,
                d.days,
                d.schedule,
                resolveRegularDefaultTime(
                    d.defaultTime,
                    d.defaultTimeEdited,
                    existingSettings.default_time,
                ),
            ),
        };
        if (d.classType === '내신') {
            classSettingsData.class_type = '내신';
            classSettingsData.naesin_start = d.naesinStart;
            classSettingsData.naesin_end = d.naesinEnd;
        } else if (d.classType === '자유학기') {
            if (d.freeStart) classSettingsData.free_start = d.freeStart;
            if (d.freeEnd) classSettingsData.free_end = d.freeEnd;
        } else {
            classSettingsData.class_type = d.classType;
            if (d.classType === '특강') {
                if (d.feeType) classSettingsData.fee_type = d.feeType;
                if (d.specialStart) classSettingsData.special_start = d.specialStart;
                if (d.specialEnd) classSettingsData.special_end = d.specialEnd;
            }
        }

        // 3. 학생별 enrollment 추가 (batch + arrayUnion으로 경합 방지)
        const today = todayStr();

        // 내신/자유학기는 정규 enrollment 기준 임시 전환이므로 학생 doc을 먼저 읽는다.
        // 정규도 같은 학생의 옛 정규 enrollment를 자동 종료해야 하므로 미리 읽는다.
        // 직렬 await 대신 한 번에 병렬로 받아 RTT를 학생 수만큼이 아닌 1번으로 줄인다.
        const enrollmentsByDocId = new Map();
        if (d.classType === '내신' || d.classType === '자유학기' || d.classType === '정규') {
            const snaps = await Promise.all(
                d.students.map(s => getDoc(doc(db, 'students', s.docId)))
            );
            snaps.forEach(snap => {
                enrollmentsByDocId.set(snap.id, snap.data()?.enrollments || []);
            });
        }

        // ── 가드: 내신 기간 중 정규/자유학기 추가 시 override 없음 경고 ──────────
        // 내신은 모두 '정규 + naesin_class_override'로 파생 표시된다. 내신 기간 중인
        // 학생을 정규/자유학기 모드로 추가하면 override가 안 박혀 내신이 안 잡힌다
        // (silvia가 김시헌을 내신 기간 중 정규 HS201로 추가한 사고). 내신 모드는
        // override를 박는 정상 경로라 가드 불필요.
        if (d.classType === '정규' || d.classType === '자유학기') {
            const naesinStudents = [];
            for (const student of d.students) {
                if (!isEnrollableStatus(student.status)) continue;
                const existing = enrollmentsByDocId.get(student.docId) || [];
                // 이미 naesin_class_override가 있는 활성 enrollment를 직접 찾아 csKey로 사용.
                const naesinEnroll = existing.find(e => isActiveNaesinBase(e, today) && e.naesin_class_override);
                if (!naesinEnroll) continue;
                const csKey = naesinEnroll.naesin_class_override;
                // class-setup 진입점은 state.classSettings를 채우지 않으므로 필요한 키만 읽어 주입.
                if (!state.classSettings[csKey]) {
                    const csSnap = await getDoc(doc(db, 'class_settings', csKey));
                    state.classSettings[csKey] = csSnap.exists() ? csSnap.data() : {};
                }
                const cs = state.classSettings[csKey];
                if (cs?.naesin_start && cs?.naesin_end && cs.naesin_start <= today && cs.naesin_end >= today) {
                    naesinStudents.push(student.name || student.docId);
                }
            }
            if (naesinStudents.length) {
                const ok = confirm(`다음 학생은 현재 내신 기간입니다: ${naesinStudents.join(', ')}. 정규로만 추가하면 내신이 안 잡힙니다. 내신 반생성마법사로 배정하세요.\n그래도 계속하시겠습니까?`);
                if (!ok) { btn.disabled = false; btn.innerHTML = msIcon('check') + ' 반 생성'; return; }
            }
        }

        // class_settings + 학생 enrollment를 한 batch에 묶어 부분 실패 시 데이터 불일치를 방지.
        const batch = writeBatch(db);
        batchSet(batch, doc(db, 'class_settings', d.classCode), classSettingsData, { merge: true });

        // 반생성마법사 수업이력 로그 — DB의 UPDATE 로그와 동일 필드/형식으로 기록.
        // 공유 분류기(@impact7/shared)가 before/after를 파싱해 전반/수업추가로 분류한다.
        const _logActor = normalizeImpact7Email(currentUser?.email || auth.currentUser?.email || 'unknown');
        const _pushFormationLog = (b, docId, before, after) => {
            batchSet(b, doc(collection(db, 'history_logs')), {
                doc_id: docId,
                change_type: 'UPDATE',
                before,
                after,
                google_login_id: _logActor,
                timestamp: serverTimestamp(),
            });
        };
        const _pushStatusChangeLog = (b, docId, student, afterStatus, afterText) => {
            const beforeStatus = student.status || '';
            batchSet(b, doc(collection(db, 'history_logs')), {
                doc_id: docId,
                change_type: 'RETURN',
                before: `상태:${beforeStatus || ''}`,
                after: afterText,
                google_login_id: _logActor,
                timestamp: serverTimestamp(),
            });
            batchSet(b, doc(collection(db, 'history_logs')), {
                doc_id: docId,
                change_type: 'STATUS_CHANGE',
                before: JSON.stringify(buildReactivationHistoryBefore(student)),
                after: JSON.stringify({ status: afterStatus }),
                google_login_id: _logActor,
                timestamp: serverTimestamp(),
            });
        };
        const _specialReactivations = d.classType === '특강'
            ? d.students.filter(student => !isEnrollableStatus(student.status))
            : [];
        if (_specialReactivations.length) {
            const ok = confirm(
                `다음 학생은 현재 재원 상태가 아닙니다:\n${_specialReactivations.map(s => `${s.name || s.docId} (${s.status || '상태없음'})`).join(', ')}\n\n` +
                `특강 저장을 위해 상태를 '재원'으로 전환하고 이력을 남깁니다. 계속하시겠습니까?`
            );
            if (!ok) {
                btn.disabled = false;
                btn.innerHTML = msIcon('check') + ' 반 생성';
                return;
            }
        }
        const _duplicateStudents = [];
        for (const student of d.students) {
            if (d.classType !== '특강' && !isEnrollableStatus(student.status)) {
                throw new Error(`${student.name || student.docId} 학생의 상태(${student.status || '상태없음'})로는 반을 등록할 수 없습니다.`);
            }
            const studentRef = doc(db, 'students', student.docId);
            let studentUpdate = null;
            const existing = enrollmentsByDocId.get(student.docId) || [];

            if (d.classType === '정규' && hasActiveRegularClass(existing, d.classCode, today)) {
                _duplicateStudents.push(student.name || student.docId);
                continue;
            }

            // 특강 수강생은 모두 status2: '특강' 설정
            if (d.classType === '특강') {
                studentUpdate = { status2: '특강' };
                if (!isEnrollableStatus(student.status)) {
                    studentUpdate.status = '재원';
                    studentUpdate.status_changed_at = serverTimestamp();
                    studentUpdate.status_changed_by = _logActor;
                    studentUpdate.status_previous = student.status || null;
                    Object.assign(studentUpdate, buildReactivationCleanupFields(deleteField()));
                    _pushStatusChangeLog(
                        batch,
                        student.docId,
                        student,
                        '재원',
                        `상태:재원, 반:${d.classCode} (특강 재원전환)`
                    );
                    student.status = '재원';
                }
            }

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
                if (d.naesinStart) newEnrollment.start_date = d.naesinStart;
                if (d.naesinEnd) newEnrollment.end_date = d.naesinEnd;
            }

            if (d.classType === '자유학기') {
                if (d.freeStart) newEnrollment.start_date = d.freeStart;
                if (d.freeEnd) newEnrollment.end_date = d.freeEnd;
            }

            if (d.classType === '특강') {
                newEnrollment.level_symbol = '';
                newEnrollment.class_number = d.classCode; // 반 이름 = 코드 (예: '수요특강')
                if (d.specialStart) newEnrollment.start_date = d.specialStart;
                if (d.specialEnd) newEnrollment.end_date = d.specialEnd;
            }

            // 안전망 가드: class_type ↔ 반 코드 정합성 (정채리 케이스 같은 빈 placeholder 차단).
            // validateForm/buildClassCode를 우회해 여기 도달하는 경로가 생기더라도 마지막에서 throw.
            const _hasCode = !!(newEnrollment.level_symbol || newEnrollment.class_number);
            if ((d.classType === '정규' || d.classType === '자유학기') && (!newEnrollment.level_symbol || !newEnrollment.class_number)) {
                throw new Error(`${d.classType} 반 등록에 level_symbol과 class_number가 모두 필요합니다.`);
            }
            if (d.classType === '특강' && !newEnrollment.class_number) {
                throw new Error('특강 반 등록에 class_number(반 이름)가 필요합니다.');
            }
            if (d.classType === '내신' && _hasCode) {
                throw new Error('내신 enrollment는 level_symbol/class_number를 비워야 합니다 (csKey 별도 관리).');
            }

            if (d.classType === '내신') {
                // 정규/자유학기 enrollment에 naesin_class_override 박아 명시 매핑.
                // arrayUnion으로는 기존 element 수정 불가 → 전체 enrollments 다시 쓰기.
                const hasRegular = existing.some(e => isActiveNaesinBase(e));
                if (!hasRegular) throw new Error(`${student.name} 학생은 활성 정규/자유학기 등록(종료 안 됨·요일 있음)이 없어 내신반에 추가할 수 없습니다. 정규반을 먼저 정상 등록하세요.`);
                const updated = existing.map(e =>
                    isActiveNaesinBase(e)
                        ? { ...e, naesin_class_override: d.classCode }
                        : e
                );
                batchUpdate(batch, studentRef, { enrollments: updated });
                _pushFormationLog(batch, student.docId, '—', `추가: ${d.classCode} (내신) 누적`);
            } else if (d.classType === '자유학기') {
                const hasRegular = existing.some(e => isActiveNaesinBase(e));
                if (!hasRegular) throw new Error(`${student.name} 학생은 활성 정규반 등록(종료 안 됨·요일 있음)이 없어 자유학기반에 추가할 수 없습니다.`);
                const updated = existing.filter(e =>
                    !(e.class_type === '자유학기' && `${e.level_symbol || ''}${e.class_number || ''}` === d.classCode)
                );
                updated.push(newEnrollment);
                batchUpdate(batch, studentRef, { enrollments: updated });
                _pushFormationLog(batch, student.docId, '—', `추가: ${d.classCode} (자유학기) 누적`);
            } else if (d.classType === '정규') {
                // 정규는 end_date를 박지 않는다 — 정규 종료는 status(퇴원/종강)로만.
                // 활성 정규가 정확히 1개면 in-place로 반 변경(코드·요일·시작일 갱신, override/semester 보존).
                // 0개면 새 정규 추가. 2개 이상이면 어느 반을 대체할지 모호하므로 임의 반을
                // 덮어써 소리 없이 제거하지 않고(M-2) 새 enrollment로 추가한다(소실 < 가시적 중복).
                const activeRegs = existing.filter(e => e.class_type === '정규' && !e.end_date);
                const oldReg = activeRegs.length === 1 ? activeRegs[0] : null;
                const oldCode = oldReg ? `${oldReg.level_symbol || ''}${oldReg.class_number || ''}` : '';
                const newCode = d.classCode;
                const updated = oldReg
                    ? existing.map(e => e === oldReg
                        ? { ...e,
                            level_symbol: newEnrollment.level_symbol,
                            class_number: newEnrollment.class_number,
                            day: newEnrollment.day,
                            start_date: newEnrollment.start_date }
                        : e)
                    : [...existing, newEnrollment];
                batchUpdate(batch, studentRef, { enrollments: updated });
                // 수업이력 로그 — DB와 동일 형식으로 공유 분류기가 전반/수업추가로 인식
                if (oldCode && oldCode !== newCode) {
                    _pushFormationLog(batch, student.docId,
                        `상태:${student.status || ''}, 반:${oldCode}`,
                        `상태:${student.status || ''}, 반:${newCode}`);
                } else if (!oldCode) {
                    // '추가:'+'누적' 토큰은 @impact7/shared history-classifier의 수업추가 시그니처 — 빼면 이력에서 숨김
                    _pushFormationLog(batch, student.docId, '—',
                        `추가: ${newCode} (정규), 총 ${updated.length}개 누적`);
                }
            } else {
                batchUpdate(batch, studentRef, {
                    ...(studentUpdate || {}),
                    enrollments: arrayUnion(newEnrollment),
                });
                _pushFormationLog(batch, student.docId, '—', `추가: ${d.classCode} (특강) 누적`);
            }
        }
        await batch.commit();

        if (_duplicateStudents.length) {
            alert(`이미 ${d.classCode} 정규반에 등록된 학생은 중복 추가하지 않았습니다:\n${_duplicateStudents.join(', ')}`);
        }

        // 반 생성 시 첫 강사 배정을 이력에 기록 (prev=''=신규). class_settings 저장(commit) 성공 후.
        if (d.teacher) {
            await recordTeacherChange(d.classCode, {
                class_type: d.classType || '',
                branch: d.classType === '내신' ? (d.naesinBranch || '') : '',
                teacher: d.teacher,
                sub_teacher: '',
                prev_teacher: '',
                prev_sub_teacher: '',
            });
        }

        showToast(`"${d.classCode}" 반이 생성되었습니다! (${d.students.length - _duplicateStudents.length}명)`, 'success');

        // 3초 후 DSC 홈으로 이동
        setTimeout(() => { window.location.href = './'; }, 2000);

    } catch (err) {
        console.error('[submitWizard]', err);
        showToast(`생성 실패: ${err.message}`, 'error');
    } finally {
        btn.disabled = false;
        btn.innerHTML = msIcon('check') + ' 반 생성';
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
