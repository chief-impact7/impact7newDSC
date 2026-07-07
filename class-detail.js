// ─── Class Detail Module ───────────────────────────────────────────────────
// daily-ops.js에서 추출한 반 관리 상세 + 타반수업 관련 함수
// Phase 3-3

import { msIcon } from './ms-icon.js';
import { doc, getDoc, getDocFromServer, writeBatch, arrayUnion, deleteField, addDoc, collection, serverTimestamp } from 'firebase/firestore';
import { db, auth } from './firebase-config.js';
import { todayStr } from './src/shared/firestore-helpers.js';
import { auditUpdate, auditDelete, batchUpdate, batchSet, READ_ONLY, normalizeImpact7Email } from './audit.js';
import { isEnrollableStatus } from '@impact7/shared/enrollment-status';
import { isSameTeacher } from '@impact7/shared/teacher-label';
import { formatDateTimeKST } from '@impact7/shared/datetime';
import { imeInputAttrs } from '@impact7/shared/ime-input';
import { state, DAY_ORDER, DEFAULT_DOMAINS, DEFAULT_TEST_SECTIONS } from './state.js';
import { esc, escAttr, showSaveIndicator, showToast } from './ui-utils.js';
import { matchesBranchFilter, enrollmentCode, getActiveEnrollments, isActiveNaesinBase } from './student-helpers.js';
import { renderAddStudentCard, createStudentSearcher } from './class-student-search.js';
import { cancelStudentPendingTasks } from './data-layer.js';
import { recordTeacherChange } from './teacher-history.js';
import { renderClassBulkMessageCard, resolveClassMembers } from './class-bulk-message.js';

// ─── deps injection ─────────────────────────────────────────────────────────
let getOverrideStudentsForClass, getOverridingOutFromClass, getClassDomains, getClassTestSections;
let getTeacherName, saveClassSettings, isInTeukangClass, getTeukangClassStudents, getRegularClassStudents;
let renderStudentDetail, renderListPanel, _isNaesinClassCode;

export function initClassDetailDeps(deps) {
    getOverrideStudentsForClass = deps.getOverrideStudentsForClass;
    getOverridingOutFromClass = deps.getOverridingOutFromClass;
    getClassDomains = deps.getClassDomains;
    getClassTestSections = deps.getClassTestSections;
    getTeacherName = deps.getTeacherName;
    saveClassSettings = deps.saveClassSettings;
    isInTeukangClass = deps.isInTeukangClass;
    getTeukangClassStudents = deps.getTeukangClassStudents;
    getRegularClassStudents = deps.getRegularClassStudents;
    renderStudentDetail = deps.renderStudentDetail;
    renderListPanel = deps.renderListPanel;
    _isNaesinClassCode = deps._isNaesinClassCode;
}

export function renderClassTempOverrideSection(classCode) {
    const overrideIn = getOverrideStudentsForClass(classCode, state.selectedDate);
    const overrideOut = getOverridingOutFromClass(classCode, state.selectedDate);

    if (overrideIn.length === 0 && overrideOut.length === 0) {
        return `
            <div class="detail-card">
                <div class="detail-card-title">
                    ${msIcon('swap_horiz', '', 'style="color:var(--warning);font-size:18px;"')}
                    임시 수업 학생
                </div>
                <div style="font-size:12px;color:var(--text-sec);padding:4px 0;">오늘 타반수업 학생 없음</div>
                <button class="btn btn-secondary btn-sm" style="margin-top:8px;" onclick="openClassTempOverrideModal('${escAttr(classCode)}')">
                    ${msIcon('add', '', 'style="font-size:14px;"')} 타반 학생 추가
                </button>
            </div>
        `;
    }

    const inHtml = overrideIn.map(o => `
        <div style="display:flex;align-items:center;gap:8px;margin-bottom:6px;padding:6px 8px;background:#e3f2fd;border-radius:6px;">
            ${msIcon('arrow_forward', '', 'style="font-size:16px;color:#1565c0;"')}
            <span style="font-size:13px;font-weight:600;">${esc(o.student_name)}</span>
            <span style="font-size:12px;color:var(--text-sec);">← ${esc(o.original_class_code)}</span>
            ${o.reason ? `<span style="font-size:11px;color:var(--text-third);">(${esc(o.reason)})</span>` : ''}
            <button class="btn btn-sm" style="margin-left:auto;color:var(--danger);padding:2px 6px;" onclick="cancelTempClassOverride('${escAttr(o.docId)}', '${escAttr(o.student_id)}')">취소</button>
        </div>
    `).join('');

    const outHtml = overrideOut.map(o => `
        <div style="display:flex;align-items:center;gap:8px;margin-bottom:6px;padding:6px 8px;background:#fff3e0;border-radius:6px;">
            ${msIcon('arrow_back', '', 'style="font-size:16px;color:#e65100;"')}
            <span style="font-size:13px;font-weight:600;">${esc(o.student_name)}</span>
            <span style="font-size:12px;color:var(--text-sec);">→ ${esc(o.target_class_code)}</span>
        </div>
    `).join('');

    return `
        <div class="detail-card">
            <div class="detail-card-title">
                ${msIcon('swap_horiz', '', 'style="color:var(--warning);font-size:18px;"')}
                임시 수업 학생
            </div>
            ${overrideIn.length > 0 ? `<div style="font-size:11px;font-weight:600;color:#1565c0;margin-bottom:4px;">들어오는 학생 (${overrideIn.length}명)</div>${inHtml}` : ''}
            ${overrideOut.length > 0 ? `<div style="font-size:11px;font-weight:600;color:#e65100;margin-bottom:4px;${overrideIn.length > 0 ? 'margin-top:8px;' : ''}">나가는 학생 (${overrideOut.length}명)</div>${outHtml}` : ''}
            <button class="btn btn-secondary btn-sm" style="margin-top:8px;" onclick="openClassTempOverrideModal('${escAttr(classCode)}')">
                ${msIcon('add', '', 'style="font-size:14px;"')} 타반 학생 추가
            </button>
        </div>
    `;
}

export function openClassTempOverrideModal(classCode) {
    // 반에 등록되지 않은 학생 검색 가능한 모달
    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay';
    overlay.setAttribute('role', 'dialog');
    overlay.setAttribute('aria-modal', 'true');
    overlay.setAttribute('aria-labelledby', 'ovr-modal-title');
    overlay.onclick = (e) => { if (e.target === overlay) overlay.remove(); };
    overlay.innerHTML = `
        <div class="modal-content">
            <div class="modal-header">
                <h3 id="ovr-modal-title">타반 학생 추가 — ${esc(classCode)}</h3>
                <button class="modal-close" aria-label="닫기" onclick="this.closest('.modal-overlay').remove()">
                    ${msIcon('close')}
                </button>
            </div>
            <div class="modal-body">
                <div class="form-field">
                    <label class="field-label" for="ovr-class-student-search">학생 검색</label>
                    <input type="text" class="field-input" id="ovr-class-student-search" placeholder="학생 이름 검색" ${imeInputAttrs('filterClassOverrideStudents()')}>
                </div>
                <div id="ovr-class-student-list" style="max-height:200px;overflow-y:auto;border:1px solid var(--border);border-radius:6px;padding:4px;"></div>
                <div class="form-field" style="margin-top:12px;">
                    <label class="field-label" for="ovr-class-date">날짜</label>
                    <input type="date" class="field-input" id="ovr-class-date" value="${state.selectedDate}">
                </div>
                <div class="form-field">
                    <label class="field-label" for="ovr-class-reason">사유 (선택)</label>
                    <input type="text" class="field-input" id="ovr-class-reason" placeholder="사유 입력">
                </div>
            </div>
            <div class="modal-footer">
                <button class="btn btn-secondary" onclick="this.closest('.modal-overlay').remove()">취소</button>
                <button class="btn btn-primary" onclick="submitClassTempOverrideFromModal('${escAttr(classCode)}')">등록</button>
            </div>
        </div>
    `;
    document.body.appendChild(overlay);
    // 초기 목록 표시
    filterClassOverrideStudents();
}

export function filterClassOverrideStudents() {
    const searchVal = (document.getElementById('ovr-class-student-search')?.value || '').trim().toLowerCase();
    const listEl = document.getElementById('ovr-class-student-list');
    if (!listEl) return;

    const filtered = state.allStudents.filter(s =>
        s.status !== '퇴원' && s.name?.toLowerCase().includes(searchVal)
    ).slice(0, 20);

    listEl.innerHTML = filtered.length === 0
        ? '<div style="padding:8px;color:var(--text-sec);font-size:12px;">검색 결과 없음</div>'
        : filtered.map(s => {
            const codes = getActiveEnrollments(s, state.selectedDate).map(e => enrollmentCode(e)).filter(Boolean).join(', ');
            return `<div class="ovr-student-option" data-id="${escAttr(s.docId)}" onclick="selectClassOverrideStudent(this)" onkeydown="if(event.key==='Enter'||event.key===' '){event.preventDefault();selectClassOverrideStudent(this);}" role="button" tabindex="0" style="padding:6px 8px;cursor:pointer;border-radius:4px;display:flex;align-items:center;gap:8px;">
                <span style="font-weight:500;">${esc(s.name)}</span>
                <span style="font-size:11px;color:var(--text-sec);">${esc(codes)}</span>
            </div>`;
        }).join('');
}

export function selectClassOverrideStudent(el) {
    document.querySelectorAll('.ovr-student-option').forEach(opt => {
        if (opt === el) {
            opt.style.background = 'var(--primary-light)';
            opt.dataset.selected = 'true';
        } else {
            opt.style.background = '';
            delete opt.dataset.selected;
        }
    });
}

export async function submitClassTempOverrideFromModal(classCode) {
    const selectedEl = document.querySelector('.ovr-student-option[data-selected="true"]');
    if (!selectedEl) { alert('학생을 선택해주세요.'); return; }
    const studentId = selectedEl.dataset.id;
    const dateVal = document.getElementById('ovr-class-date')?.value;
    const reason = document.getElementById('ovr-class-reason')?.value || '';
    if (!dateVal) { alert('날짜를 선택해주세요.'); return; }
    document.querySelector('.modal-overlay')?.remove();
    await window.createTempClassOverride(studentId, classCode, [dateVal], reason);
}

// 반 상세 패널: 출결현황/성적 탭은 학생 전용 → 반 모드에서 숨기고 daily로 강제.
// 학생 선택 시 renderStudentDetail이 다시 노출함.
export function applyClassDetailTabMode() {
    const tabsEl = document.getElementById('detail-tabs');
    if (tabsEl) {
        tabsEl.querySelectorAll('.detail-tab').forEach(t => {
            if (t.dataset.tab === 'report' || t.dataset.tab === 'score' || t.dataset.tab === 'consultation') t.style.display = 'none';
            t.classList.toggle('active', t.dataset.tab === 'daily');
            t.setAttribute('aria-selected', String(t.dataset.tab === 'daily'));
        });
    }
    state.detailTab = 'daily';
    document.getElementById('detail-cards').style.display = '';
    const reportTabEl = document.getElementById('report-tab');
    if (reportTabEl) reportTabEl.style.display = 'none';
    const scoreTabEl = document.getElementById('score-tab');
    if (scoreTabEl) scoreTabEl.style.display = 'none';
}

// ─── 반 상세 4탭 (일반/숙제/테스트/특이) ─────────────────────────────────────
export const CLASS_DETAIL_TABS = ['일반', '숙제', '테스트', '특이'];

// groups: { 일반, 숙제, 테스트, 특이 } 각 탭의 카드 HTML 문자열.
// 활성 탭 카드만 노출하고, 비면 "해당 없음" 안내를 표시(탭 바는 항상 4개 유지).
export function renderClassDetailTabbed(groups) {
    const active = CLASS_DETAIL_TABS.includes(state.classDetailTab) ? state.classDetailTab : '일반';
    const tabBar = `
        <div class="detail-tabs class-detail-subtabs" role="tablist" aria-label="반 설정 탭">
            ${CLASS_DETAIL_TABS.map(t => `<button class="detail-tab${t === active ? ' active' : ''}" role="tab" aria-selected="${t === active}" onclick="switchClassDetailTab('${t}')">${t}</button>`).join('')}
        </div>`;
    const content = (groups[active] || '').trim()
        || '<div class="detail-card"><div class="detail-card-empty">해당 없음</div></div>';
    return `${tabBar}<div class="class-detail-tab-body">${content}</div>`;
}

export function switchClassDetailTab(tab) {
    state.classDetailTab = tab;
    if (state.selectedClassCode) renderClassDetail(state.selectedClassCode);
}

// ─── 재사용 카드 빌더 (문자열 반환) ─────────────────────────────────────────
function renderClassTeacherCard(classCode) {
    const currentTeacher = state.classSettings[classCode]?.teacher || '';
    const currentSubTeacher = state.classSettings[classCode]?.sub_teacher || '';
    // 저장값이 구메일(@gw)이어도 정규화된 목록과 동일인 매칭 — @impact7/shared teacher-label 규약
    // 현재 배정자가 목록(homeroom_eligible)에서 빠지면(퇴직·비교수부) 보존 option을 강제 주입한다.
    // 안 하면 "미지정"으로 렌더 → 부담당만 수정해도 담임이 빈값으로 소실된다(H-1).
    const _preservedTeacherOption = (assigned) => {
        if (!assigned) return '';
        if (state.teachersList.some(t => isSameTeacher(t.email, assigned))) return '';
        return `<option value="${escAttr(assigned)}" selected>${esc(getTeacherName(assigned))} (목록 외)</option>`;
    };
    const teacherOptions = _preservedTeacherOption(currentTeacher) + state.teachersList.map(t => {
        const name = getTeacherName(t.email);
        return `<option value="${escAttr(t.email)}" ${isSameTeacher(t.email, currentTeacher) ? 'selected' : ''}>${esc(name)}</option>`;
    }).join('');
    const subTeacherOptions = _preservedTeacherOption(currentSubTeacher) + state.teachersList.map(t => {
        const name = getTeacherName(t.email);
        return `<option value="${escAttr(t.email)}" ${isSameTeacher(t.email, currentSubTeacher) ? 'selected' : ''}>${esc(name)}</option>`;
    }).join('');

    return `
        <div class="detail-card">
            <div class="detail-card-title">
                ${msIcon('person')}
                담당 배정
            </div>
            <div class="teacher-assign-grid">
                <div class="teacher-assign-row">
                    <label class="teacher-assign-label" for="teacher-select">담당</label>
                    <select class="field-input teacher-assign-select" id="teacher-select" onchange="saveTeacherAssign('${escAttr(classCode)}')">
                        <option value="">미지정</option>
                        ${teacherOptions}
                    </select>
                </div>
                <div class="teacher-assign-row">
                    <label class="teacher-assign-label" for="sub-teacher-select">부담당</label>
                    <select class="field-input teacher-assign-select" id="sub-teacher-select" onchange="saveTeacherAssign('${escAttr(classCode)}')">
                        <option value="">미지정</option>
                        ${subTeacherOptions}
                    </select>
                </div>
            </div>
        </div>`;
}

function renderClassDefaultTimeCard(classCode) {
    // 반 기본 시간만 설정 (학생별 개별시간은 학생 상세패널에서)
    const defaultTime = state.classSettings[classCode]?.default_time || '';
    const timeUpdatedBy = state.classSettings[classCode]?.default_time_updated_by || '';
    const timeUpdatedAt = state.classSettings[classCode]?.default_time_updated_at || '';
    const timeUpdatedLabel = timeUpdatedBy
        ? `${getTeacherName(timeUpdatedBy)} · ${formatDateTimeKST(timeUpdatedAt)}`
        : '';
    return `
        <div class="detail-card">
            <div class="detail-card-title">
                ${msIcon('schedule')}
                등원예정시간
            </div>
            <div class="arrival-bulk-row">
                <input type="time" class="arrival-time-input" aria-label="등원예정시간" value="${defaultTime}"
                    onchange="saveClassDefaultTime('${escAttr(classCode)}', this.value)">
            </div>
            <div style="font-size:11px;color:var(--text-sec);margin-top:4px;">변경 시 자동 저장${timeUpdatedLabel ? ` · 최근: ${esc(timeUpdatedLabel)}` : ''}</div>
        </div>`;
}

export function renderClassDomainCard(classCode) {
    const domains = getClassDomains(classCode);
    const domainChips = domains.map((d, i) => `
        <span class="domain-chip">
            ${esc(d)}
            <button class="domain-chip-remove" onclick="event.stopPropagation(); removeClassDomain('${escAttr(classCode)}', ${i})" title="삭제">&times;</button>
        </span>
    `).join('');
    return `
        <div class="detail-card">
            <div class="detail-card-title">
                ${msIcon('category')}
                영역숙제관리
            </div>
            <div class="domain-chips-container">${domainChips || '<span class="detail-card-empty">영역 없음</span>'}</div>
            <div class="domain-add-row">
                <input type="text" id="domain-add-input" class="field-input" placeholder="새 영역 이름" aria-label="새 영역 이름" style="flex:1;"
                    onkeydown="if(event.key==='Enter') addClassDomain('${escAttr(classCode)}')">
                <button class="btn btn-primary btn-sm" onclick="addClassDomain('${escAttr(classCode)}')">추가</button>
            </div>
            <button class="btn btn-secondary btn-sm" style="margin-top:8px;" onclick="resetClassDomains('${escAttr(classCode)}')">기본값 복원</button>
        </div>`;
}

export function renderClassTestSectionsCard(classCode) {
    const testSections = getClassTestSections(classCode);
    const sectionNames = Object.keys(testSections);
    const testSectionsHtml = sectionNames.map(secName => {
        const tests = testSections[secName] || [];
        const testChips = tests.map((t, i) => `
            <span class="domain-chip">
                ${esc(t)}
                <button class="domain-chip-remove" onclick="event.stopPropagation(); removeTestFromSection('${escAttr(classCode)}', '${escAttr(secName)}', ${i})" title="삭제">&times;</button>
            </span>
        `).join('');
        return `
            <div class="test-section">
                <div class="test-section-header">
                    <span class="test-section-name">${esc(secName)}</span>
                    <button class="domain-chip-remove" onclick="event.stopPropagation(); removeTestSection('${escAttr(classCode)}', '${escAttr(secName)}')" title="섹션 삭제">&times;</button>
                </div>
                <div class="domain-chips-container">${testChips || '<span style="font-size:12px;color:var(--text-sec);">테스트 없음</span>'}</div>
                <div class="domain-add-row">
                    <input type="text" class="field-input" data-test-section="${escAttr(secName)}" placeholder="테스트 이름" aria-label="테스트 이름" style="flex:1;"
                        onkeydown="if(event.key==='Enter') addTestToSection('${escAttr(classCode)}', '${escAttr(secName)}')">
                    <button class="btn btn-primary btn-sm" onclick="addTestToSection('${escAttr(classCode)}', '${escAttr(secName)}')">추가</button>
                </div>
                <button class="btn btn-secondary btn-sm" style="margin-top:6px;" onclick="resetTestSection('${escAttr(classCode)}', '${escAttr(secName)}')">기본값 복원</button>
            </div>
        `;
    }).join('');
    return `
        <div class="detail-card">
            <div class="detail-card-title">
                ${msIcon('quiz')}
                테스트관리
            </div>
            ${testSectionsHtml}
            <div class="domain-add-row" style="margin-top:12px;border-top:1px solid var(--border);padding-top:12px;">
                <input type="text" id="test-section-add-input" class="field-input" placeholder="새 섹션 이름" aria-label="새 섹션 이름" style="flex:1;"
                    onkeydown="if(event.key==='Enter') addTestSection('${escAttr(classCode)}')">
                <button class="btn btn-secondary btn-sm" onclick="addTestSection('${escAttr(classCode)}')">섹션 추가</button>
            </div>
            <button class="btn btn-secondary btn-sm" style="margin-top:8px;" onclick="resetTestSections('${escAttr(classCode)}')">기본값 복원</button>
        </div>`;
}

// 프로필 헤더를 반 정보로 교체 (학생 상세에서 남은 데이터 클리어)
function setClassProfileHeader(classCode, memberCount) {
    document.getElementById('profile-avatar').textContent = classCode[0] || '?';
    document.getElementById('detail-name').textContent = classCode;
    document.getElementById('profile-phones').innerHTML = '';
    document.getElementById('profile-stay-stats').innerHTML = '';
    document.getElementById('profile-tags').innerHTML = `<span class="tag">${memberCount}명</span>`;
}

export function renderClassDetail(classCode) {
    if (!classCode) {
        document.getElementById('detail-empty').style.display = '';
        document.getElementById('detail-content').style.display = 'none';
        return;
    }

    // 특강 반: naesin보다 먼저 체크 (반 이름에 한글 포함되므로 _isNaesinClassCode가 true 반환할 수 있음)
    const isTeukangClass = state.classSettings[classCode]?.class_type === '특강';
    const isFreeMode = state._classMgmtMode === 'free';

    // 내신 반: naesin.js로 위임
    if (!isTeukangClass && !isFreeMode && window.renderNaesinClassDetail && _isNaesinClassCode(classCode)) {
        window.renderNaesinClassDetail(classCode);
        return;
    }

    state.selectedStudentId = null; // 학생 선택 해제
    applyClassDetailTabMode();

    document.getElementById('detail-empty').style.display = 'none';
    document.getElementById('detail-content').style.display = '';

    // 헤더 인원수와 '단체 안내' 카드/발송 대상이 같은 로스터를 쓰도록 resolveClassMembers로 통일한다
    // (리뷰: free 모드에서 헤더=자유학기만, 발송=정규∪자유학기로 갈려 인원수·발송 대상이 어긋나던 오발송 위험).
    const classStudents = resolveClassMembers(classCode);

    setClassProfileHeader(classCode, classStudents.length);

    const cardsContainer = document.getElementById('detail-cards');
    const teacherCard = renderClassTeacherCard(classCode);

    // 특강: 영역숙제/테스트/등원예정시간 카드 없음 — 일반=담당+기간+요일/시간+학생추가, 특이=삭제
    if (isTeukangClass) {
        cardsContainer.innerHTML = renderClassDetailTabbed({
            '일반': `${teacherCard}${renderTeukangPeriodCard(classCode)}${renderClassScheduleCard(classCode)}${renderTeukangAddStudentCard(classCode)}${renderClassBulkMessageCard(classCode)}`,
            '숙제': '',
            '테스트': '',
            '특이': renderClassDeleteCard(classCode, 'teukang'),
        });
        document.getElementById('detail-panel').classList.add('mobile-visible');
        return;
    }

    const dayOrPeriodCards = isFreeMode
        ? `${renderFreeSemesterPeriodCard(classCode)}${renderClassScheduleCard(classCode)}`
        : renderRegularClassDayCard(classCode);

    cardsContainer.innerHTML = renderClassDetailTabbed({
        '일반': `${teacherCard}${dayOrPeriodCards}${renderClassDefaultTimeCard(classCode)}${renderClassBulkMessageCard(classCode)}`,
        '숙제': renderClassDomainCard(classCode),
        '테스트': renderClassTestSectionsCard(classCode),
        '특이': `${renderClassTempOverrideSection(classCode)}${renderClassDeleteCard(classCode, isFreeMode ? 'free' : 'regular')}`,
    });

    // 좁은 화면(<=1100px)에서 디테일 패널 표시 — 데스크톱에선 무해
    document.getElementById('detail-panel').classList.add('mobile-visible');
}

// ─── 소속 트리 L4 반 뷰 (읽기+단체메시지 전용) ───────────────────────────────
// 소속 트리에서 반을 클릭(학생 미선택)했을 때. 반설정 편집 UI는 없고 정보 표시와
// 단체 안내만 노출한다. renderClassDetail과 달리 탭·편집 카드를 만들지 않는다.
export function renderBranchClassDetail(classCode) {
    if (!classCode) { renderStudentDetail(null); return; }

    state.selectedStudentId = null;
    applyClassDetailTabMode();

    document.getElementById('detail-empty').style.display = 'none';
    document.getElementById('detail-content').style.display = '';

    // 반 유형별 멤버(내신·특강·자유·정규) — 단체안내 카드와 동일 해석기로 통일해
    // 헤더 인원수·학생목록·발송 대상이 어긋나지 않게 한다(리뷰 #2·#4·#5).
    const classStudents = resolveClassMembers(classCode)
        .slice()
        .sort((a, b) => (a.name || '').localeCompare(b.name || '', 'ko'));

    setClassProfileHeader(classCode, classStudents.length);

    document.getElementById('detail-cards').innerHTML =
        renderBranchClassSummaryCard(classCode)
        + renderBranchClassStudentListCard(classStudents)
        + renderClassBulkMessageCard(classCode);

    document.getElementById('detail-panel').classList.add('mobile-visible');
}

function renderBranchClassSummaryCard(classCode) {
    const cs = state.classSettings[classCode] || {};
    const daysLabel = (cs.default_days?.length ? cs.default_days : _getRegularClassDays(classCode)).join(' · ');
    const scheduleKey = _classScheduleKey(cs);
    const schedule = cs[scheduleKey] || {};
    const scheduleDays = Object.keys(schedule).sort((a, b) => DAY_ORDER.indexOf(a) - DAY_ORDER.indexOf(b));
    const scheduleRows = scheduleDays.map(day => `
        <div style="display:flex;align-items:center;gap:8px;padding:2px 0;">
            <span class="naesin-day-badge naesin-day-active" style="flex-shrink:0;">${esc(day)}</span>
            <span style="color:var(--text-sec);">${esc(schedule[day] || '')}</span>
        </div>`).join('');
    return `
        <div class="detail-card">
            <div class="detail-card-title">
                ${msIcon('info')}
                반 정보
            </div>
            <div style="font-size:13px;line-height:1.7;">
                <div>요일: ${daysLabel ? esc(daysLabel) : '<span style="color:var(--text-sec);">미설정</span>'}</div>
                <div>등원예정시간: ${cs.default_time ? esc(cs.default_time) : '<span style="color:var(--text-sec);">미설정</span>'}</div>
            </div>
            ${scheduleRows ? `<div style="margin-top:6px;">${scheduleRows}</div>` : ''}
        </div>`;
}

function renderBranchClassStudentListCard(classStudents) {
    const rows = classStudents.map(s => `
        <div class="detail-card-list-row" style="padding:6px 4px;cursor:pointer;border-bottom:1px solid var(--border);"
            onclick="selectStudent('${escAttr(s.docId)}')">
            <span style="font-weight:500;">${esc(s.name)}</span>
        </div>`).join('');
    return `
        <div class="detail-card">
            <div class="detail-card-title">
                ${msIcon('group')}
                학생 목록 (${classStudents.length}명)
            </div>
            <div>${rows || '<div class="detail-card-empty">학생 없음</div>'}</div>
        </div>`;
}

// ─── 정규반 등원 요일 카드 ──────────────────────────────────────────────────

function _getRegularClassDays(classCode) {
    const cs = state.classSettings[classCode];
    if (cs?.default_days?.length > 0) return cs.default_days;
    // class_settings에 없으면 재원 학생 enrollment에서 합집합으로 도출
    const daySet = new Set();
    state.allStudents.forEach(s => {
        if (s.status === '퇴원') return;
        (s.enrollments || []).forEach(e => {
            if (enrollmentCode(e) === classCode && (e.class_type || '정규') === '정규') {
                (e.day || []).forEach(d => daySet.add(d));
            }
        });
    });
    return DAY_ORDER.filter(d => daySet.has(d));
}

function renderRegularClassDayCard(classCode) {
    const cs = state.classSettings[classCode];
    if (cs?.class_type === '특강') return '';
    const activeDays = _getRegularClassDays(classCode);
    const dayBtns = DAY_ORDER.map(d => {
        const isActive = activeDays.includes(d);
        return `<button class="btn ${isActive ? 'btn-primary' : 'btn-secondary'} btn-sm"
            style="min-width:36px;padding:3px 8px;"
            onclick="toggleRegularClassDay('${escAttr(classCode)}', '${d}', ${!isActive})">${d}</button>`;
    }).join('');
    return `
        <div class="detail-card">
            <div class="detail-card-title">
                ${msIcon('date_range')}
                등원 요일
            </div>
            <div style="display:flex;gap:4px;flex-wrap:wrap;">${dayBtns}</div>
            <div style="font-size:11px;color:var(--text-sec);margin-top:6px;">변경 시 재원 학생 전체에 적용됩니다</div>
        </div>
    `;
}

// 반 변경을 전 학생 enrollment에 batch 전파하는 공통 메커니즘.
//   matcher(e): 이 enrollment를 바꿀지, mutate(e): 바뀐 enrollment 반환.
//   skipWithdrawn: 퇴원생 제외 여부(자유학기 기간 저장은 퇴원생도 포함 — 기존 동작 보존).
// 반환 {batch, hasOps, studentUpdates}. 커밋은 호출자가 — saveClassSettings와의 순서가
// 함수마다 다르기 때문(요일 토글은 병렬, 자유/특강 요일은 settings 먼저).
function _propagateEnrollmentChange({ matcher, mutate, skipWithdrawn = true }) {
    const batch = writeBatch(db);
    let hasOps = false;
    const studentUpdates = [];
    for (const student of state.allStudents) {
        if (skipWithdrawn && student.status === '퇴원') continue;
        let changed = false;
        const updated = (student.enrollments || []).map(e => {
            if (matcher(e)) { changed = true; return mutate(e); }
            return e;
        });
        if (!changed) continue;
        batchUpdate(batch, doc(db, 'students', student.docId), { enrollments: updated });
        studentUpdates.push({ student, enrollments: updated });
        hasOps = true;
    }
    return { batch, hasOps, studentUpdates };
}

// 낙관적 캐시 반영 — READ_ONLY 모드에선 로컬 enrollments를 건드리지 않는다.
function _applyStudentUpdates(studentUpdates) {
    if (READ_ONLY) return;
    studentUpdates.forEach(({ student, enrollments }) => { student.enrollments = enrollments; });
}

export async function toggleRegularClassDay(classCode, day, isAdd) {
    const currentDays = _getRegularClassDays(classCode);
    const newDays = isAdd
        ? DAY_ORDER.filter(d => currentDays.includes(d) || d === day)
        : currentDays.filter(d => d !== day);

    showSaveIndicator('saving');
    try {
        const { batch, hasOps, studentUpdates } = _propagateEnrollmentChange({
            matcher: e => enrollmentCode(e) === classCode && (e.class_type || '정규') === '정규',
            mutate: e => ({ ...e, day: newDays }),
        });
        await Promise.all([
            saveClassSettings(classCode, { default_days: newDays }),
            hasOps ? batch.commit() : Promise.resolve(),
        ]);
        _applyStudentUpdates(studentUpdates);
        showSaveIndicator('saved');
        renderClassDetail(classCode);
    } catch (err) {
        console.error('요일 수정 실패:', err);
        showSaveIndicator('error');
    }
}

// ─── 자유학기/특강 요일 카드 ────────────────────────────────────────────────

function _classScheduleKey(cs) {
    return cs?.free_schedule !== undefined ? 'free_schedule' : 'schedule';
}

function renderClassScheduleCard(classCode) {
    const cs = state.classSettings[classCode];
    const isFree = cs?.free_schedule !== undefined;
    if (!isFree && cs?.class_type !== '특강') return '';

    const scheduleKey = _classScheduleKey(cs);
    const schedule = cs?.[scheduleKey] || {};
    const activeDays = Object.keys(schedule).sort((a, b) => DAY_ORDER.indexOf(a) - DAY_ORDER.indexOf(b));
    const label = isFree ? '자유학기 요일/시간' : '특강 요일/시간';

    const rows = activeDays.map(day => `
        <div style="display:flex;align-items:center;gap:8px;padding:4px 0;">
            <span class="naesin-day-badge naesin-day-active" style="flex-shrink:0;">${esc(day)}</span>
            <input type="time" class="arrival-time-input" aria-label="${escAttr(day)} 수업시간" style="flex:1;"
                value="${esc(schedule[day] || '16:00')}"
                onchange="saveClassDayTime('${escAttr(classCode)}', '${escAttr(day)}', this.value)">
            <button class="icon-btn" style="width:28px;height:28px;"
                onclick="toggleClassDay('${escAttr(classCode)}', '${escAttr(day)}', false)"
                title="${esc(day)} 삭제">
                ${msIcon('close', '', 'style="font-size:16px;"')}
            </button>
        </div>
    `).join('');

    const addBtns = DAY_ORDER
        .filter(d => !activeDays.includes(d))
        .map(d => `<button class="btn btn-secondary btn-sm" style="min-width:32px;padding:2px 6px;"
            onclick="toggleClassDay('${escAttr(classCode)}', '${escAttr(d)}', true)">${esc(d)}</button>`)
        .join('');

    return `
        <div class="detail-card">
            <div class="detail-card-title">
                ${msIcon('date_range')}
                ${esc(label)}
            </div>
            <div>
                ${rows || '<div class="detail-card-empty">요일 없음</div>'}
            </div>
            ${addBtns ? `
            <div style="margin-top:8px;display:flex;flex-wrap:wrap;gap:4px;align-items:center;">
                <span style="font-size:11px;color:var(--text-sec);">요일 추가:</span>
                ${addBtns}
            </div>` : ''}
        </div>
    `;
}

export async function toggleClassDay(classCode, day, isAdd) {
    const cs = state.classSettings[classCode] || {};
    const scheduleKey = _classScheduleKey(cs);
    const classType = cs.free_schedule !== undefined ? '자유학기' : (cs.class_type || '특강');
    const schedule = { ...(cs[scheduleKey] || {}) };

    if (isAdd) {
        if (schedule[day] !== undefined) return;
        schedule[day] = '16:00';
    } else {
        delete schedule[day];
    }

    try {
        showSaveIndicator('saving');
        await saveClassSettings(classCode, { [scheduleKey]: schedule }, { replace: true });

        const newDays = Object.keys(schedule).sort((a, b) => DAY_ORDER.indexOf(a) - DAY_ORDER.indexOf(b));
        const { batch, hasOps, studentUpdates } = _propagateEnrollmentChange({
            matcher: e => enrollmentCode(e) === classCode && e.class_type === classType,
            mutate: e => ({ ...e, day: newDays }),
        });
        if (hasOps) await batch.commit();
        _applyStudentUpdates(studentUpdates);
        showSaveIndicator('saved');
        renderClassDetail(classCode);
    } catch (err) {
        console.error('요일 수정 실패:', err);
        showSaveIndicator('error');
    }
}

export async function saveClassDayTime(classCode, day, time) {
    const cs = state.classSettings[classCode] || {};
    const scheduleKey = _classScheduleKey(cs);
    const schedule = { ...(cs[scheduleKey] || {}), [day]: time };
    try {
        showSaveIndicator('saving');
        await saveClassSettings(classCode, { [scheduleKey]: schedule }, { replace: true });
        showSaveIndicator('saved');
    } catch (err) {
        console.error('시간 저장 실패:', err);
        showSaveIndicator('error');
    }
}

// ─── 특강반 기간 카드 ───────────────────────────────────────────────────────

// ─── 자유학기 기간 카드 ─────────────────────────────────────────────────────

function renderFreeSemesterPeriodCard(classCode) {
    const cs = state.classSettings[classCode] || {};
    const start = cs.free_start || '';
    const end = cs.free_end || '';
    return `
        <div class="detail-card">
            <div class="detail-card-title">
                ${msIcon('date_range')}
                자유학기 기간
            </div>
            <div style="display:flex;gap:8px;align-items:center;">
                <input type="date" class="field-input" aria-label="자유학기 시작일" value="${escAttr(start)}" style="flex:1;"
                    onchange="saveFreeSemesterPeriod('${escAttr(classCode)}', 'free_start', this.value)">
                <span style="color:var(--text-sec);">~</span>
                <input type="date" class="field-input" aria-label="자유학기 종료일" value="${escAttr(end)}" style="flex:1;"
                    onchange="saveFreeSemesterPeriod('${escAttr(classCode)}', 'free_end', this.value)">
            </div>
            <div style="font-size:11px;color:var(--text-sec);margin-top:6px;">기간이 지나면 자동으로 정규로 복귀합니다</div>
        </div>
    `;
}

export async function saveFreeSemesterPeriod(classCode, field, value) {
    showSaveIndicator('saving');
    try {
        const enrollmentField = field === 'free_start' ? 'start_date' : 'end_date';
        // 자유학기 기간 저장은 퇴원생 enrollment도 갱신한다(기존 동작 — skipWithdrawn:false).
        const { batch, hasOps, studentUpdates } = _propagateEnrollmentChange({
            matcher: e => e.class_type === '자유학기' && enrollmentCode(e) === classCode,
            mutate: e => ({ ...e, [enrollmentField]: value }),
            skipWithdrawn: false,
        });
        await Promise.all([
            saveClassSettings(classCode, { [field]: value }),
            hasOps ? batch.commit() : Promise.resolve(),
        ]);
        _applyStudentUpdates(studentUpdates);
        showSaveIndicator('saved');
        renderClassDetail(classCode);
    } catch (err) {
        console.error('자유학기 기간 저장 실패:', err);
        showSaveIndicator('error');
    }
}

function renderTeukangPeriodCard(classCode) {
    const cs = state.classSettings[classCode] || {};
    const start = cs.special_start || '';
    const end = cs.special_end || '';
    return `
        <div class="detail-card">
            <div class="detail-card-title">
                ${msIcon('date_range')}
                특강 기간
            </div>
            <div style="display:flex;gap:8px;align-items:center;">
                <input type="date" class="field-input" aria-label="특강 시작일" value="${escAttr(start)}" style="flex:1;"
                    onchange="saveTeukangPeriod('${escAttr(classCode)}', 'special_start', this.value)">
                <span style="color:var(--text-sec);">~</span>
                <input type="date" class="field-input" aria-label="특강 종료일" value="${escAttr(end)}" style="flex:1;"
                    onchange="saveTeukangPeriod('${escAttr(classCode)}', 'special_end', this.value)">
            </div>
        </div>
    `;
}

export async function saveTeukangPeriod(classCode, field, value) {
    showSaveIndicator('saving');
    try {
        await saveClassSettings(classCode, { [field]: value });
        showSaveIndicator('saved');
    } catch (err) {
        console.error('특강 기간 저장 실패:', err);
        showSaveIndicator('error');
    }
}

// ─── 반 삭제 ──────────────────────────────────────────────────────────────

export const CLASS_MODE_LABELS = Object.freeze({
    regular: '정규',
    free: '자유학기',
    naesin: '내신',
    teukang: '특강',
});

// 모드별 삭제 동작 정의. applyToStudent는 변경 발생 시 {update, before}, 아니면 null.
const _MODES = {
    free: {
        deleteClassDoc: false,
        csFieldsToDelete: ['free_schedule', 'free_start', 'free_end'],
        describe: (count) => `자유학기 ${count}명이 정규로 복귀합니다. 정규 반 코드 자체는 보존됩니다.`,
        toast: (code, count) => `자유학기 "${code}" 정리 완료 (${count}명 정규 복귀)`,
        getPeriod: (cs) => ({ start: cs?.free_start, end: cs?.free_end }),
        applyToStudent: (s, code) => {
            const original = s.enrollments || [];
            const updated = original.filter(e => !(e.class_type === '자유학기' && enrollmentCode(e) === code));
            if (updated.length === original.length) return null;
            return { update: { enrollments: updated }, before: original };
        },
    },
    teukang: {
        deleteClassDoc: true,
        describe: (count) => `특강 반에 등록된 ${count}명이 영향을 받습니다.`,
        toast: (code, count) => `특강 "${code}" 삭제 완료 (${count}명)`,
        getPeriod: (cs) => ({ start: cs?.special_start, end: cs?.special_end }),
        applyToStudent: (s, code) => {
            const original = s.enrollments || [];
            const updated = original.filter(e => !(e.class_type === '특강' && enrollmentCode(e) === code));
            if (updated.length === original.length) return null;
            const update = { enrollments: updated };
            const hasTeukang = updated.some(e => e.class_type === '특강');
            if (s.status2 === '특강' && !hasTeukang) {
                update.status2 = '';
            }
            if (updated.length === 0 && s.status !== '상담') {
                update.status = '퇴원';
            }
            return { update, before: original };
        },
    },
    regular: {
        deleteClassDoc: true,
        describe: (count) => `정규 반 삭제는 학생 ${count}명의 정규 등록을 모두 끊는 위험한 작업입니다. 진짜 삭제할 반인지 한 번 더 확인하세요.`,
        toast: (code, count) => `정규 "${code}" 삭제 완료 (${count}명 정규 enrollment 제거)`,
        getPeriod: () => null,
        applyToStudent: (s, code) => {
            const original = s.enrollments || [];
            const updated = original.filter(e =>
                !((e.class_type === '정규' || !e.class_type) && enrollmentCode(e) === code));
            if (updated.length === original.length) return null;
            return { update: { enrollments: updated }, before: original };
        },
    },
    naesin: {
        deleteClassDoc: true,
        describe: (count) => `내신 ${count}명이 정규로 복귀합니다. 학생의 정규 등록은 보존됩니다.`,
        toast: (code, count) => `내신 "${code}" 정리 완료 (${count}명 정규 복귀)`,
        getPeriod: (cs) => ({ start: cs?.naesin_start, end: cs?.naesin_end }),
        countMatch: (s, csKey) => {
            const today = todayStr();
            return (s.enrollments || []).some(e => isActiveNaesinBase(e, today) && e.naesin_class_override === csKey);
        },
        applyToStudent: (s, csKey) => {
            const today = todayStr();
            const original = s.enrollments || [];
            if (!original.some(e => isActiveNaesinBase(e, today) && e.naesin_class_override === csKey)) return null;
            const updated = original.flatMap(e => {
                if (isActiveNaesinBase(e, today) && e.naesin_class_override === csKey) {
                    const { naesin_class_override: _drop, ...rest } = e;
                    return [rest];
                }
                // 레거시 내신-타입: 이 반(csKey)에 속한 것만 정리
                if (e.class_type === '내신' && enrollmentCode(e) === csKey) return [];
                return [e];
            });
            return { update: { enrollments: updated }, before: original };
        },
    },
};

async function _logClassDeletion(classCode, mode, csBefore, affected) {
    if (READ_ONLY) {
        console.log('[READ-ONLY] history_logs CLASS_DELETE 차단:', classCode, mode, affected.length);
        return;
    }
    await addDoc(collection(db, 'history_logs'), {
        doc_id: classCode,
        change_type: 'DELETE',
        before: JSON.stringify({
            type: 'CLASS_DELETE',
            mode,
            class_settings: csBefore,
            students: affected.map(s => ({ docId: s.docId, name: s.name, enrollments: s.before })),
        }),
        after: JSON.stringify({ deleted: true, mode, affected_count: affected.length }),
        google_login_id: normalizeImpact7Email(state.currentUser?.email || 'unknown'),
        timestamp: serverTimestamp(),
    });
}

function _countAffectedStudents(classCode, mode) {
    const M = _MODES[mode];
    if (!M) return 0;
    const matcher = M.countMatch || ((s, c) => M.applyToStudent(s, c) !== null);
    return state.allStudents.filter(s => matcher(s, classCode)).length;
}

export function getClassPeriodInfo(classCode, mode) {
    const M = _MODES[mode];
    if (!M?.getPeriod) return null;
    const cs = state.classSettings[classCode] || {};
    const { start, end } = M.getPeriod(cs) || {};
    if (!start && !end) return null;
    const today = todayStr();
    const inProgress = !!(start && end && start <= today && today <= end);
    return { start: start || '', end: end || '', inProgress };
}

export async function deleteClass(classCode, mode, opts = {}) {
    const M = _MODES[mode];
    if (!M) throw new Error(`Unknown delete mode: ${mode}`);
    const { skipRender = false } = opts;
    const cs = state.classSettings[classCode] || {};

    const batch = writeBatch(db);
    const affected = [];
    const studentUpdates = [];
    for (const student of state.allStudents) {
        const result = M.applyToStudent(student, classCode);
        if (!result) continue;
        affected.push({ docId: student.docId, name: student.name, before: result.before });
        batchUpdate(batch, doc(db, 'students', student.docId), result.update);
        studentUpdates.push({ student, update: result.update });
    }

    let csOp = Promise.resolve();
    let csBefore = cs;
    if (M.deleteClassDoc) {
        csOp = auditDelete(doc(db, 'class_settings', classCode));
    } else if (M.csFieldsToDelete) {
        const csUpdate = {};
        const fieldsBefore = {};
        for (const f of M.csFieldsToDelete) {
            if (cs[f] !== undefined) {
                csUpdate[f] = deleteField();
                fieldsBefore[f] = cs[f];
            }
        }
        csBefore = fieldsBefore;
        if (Object.keys(csUpdate).length > 0) {
            csOp = auditUpdate(doc(db, 'class_settings', classCode), csUpdate);
        }
    }

    await Promise.all([csOp, affected.length > 0 ? batch.commit() : Promise.resolve()]);

    if (!READ_ONLY) {
        studentUpdates.forEach(({ student, update }) => Object.assign(student, update));
        const newlyWithdrawn = studentUpdates.filter(({ update }) => update.status === '퇴원');
        Promise.all(newlyWithdrawn.map(({ student }) => cancelStudentPendingTasks(student.docId)));
    }

    try {
        await _logClassDeletion(classCode, mode, csBefore, affected);
    } catch (err) {
        console.warn('반 삭제 이력 기록 실패:', err);
    }

    if (READ_ONLY) {
        if (!skipRender) {
            showToast(`READ-ONLY 모드: "${classCode}" 삭제가 차단되었습니다.`);
        }
        return { affected: affected.length, readOnly: true };
    }

    if (M.deleteClassDoc) {
        delete state.classSettings[classCode];
    } else if (M.csFieldsToDelete && state.classSettings[classCode]) {
        for (const f of M.csFieldsToDelete) delete state.classSettings[classCode][f];
    }

    if (!skipRender) {
        state._classMgmtMode = null;
        state.selectedClassCode = null;
        showToast(M.toast(classCode, affected.length));
        renderListPanel();
        renderStudentDetail(null);
    }
    return { affected: affected.length };
}

// targets = [{mode, code}, ...]. 차례로 deleteClass 호출 + 실패 격리 + 결과 로그.
async function _runAutoDelete(label, targets) {
    const deleted = [];
    for (const { mode, code } of targets) {
        try {
            await deleteClass(code, mode, { skipRender: true });
            deleted.push(`[${mode}] ${code}`);
        } catch (err) {
            console.error(`${label} 실패:`, mode, code, err);
        }
    }
    if (deleted.length > 0) {
        console.log(`${label}: ${deleted.length}건 (${deleted.join(', ')})`);
    }
    return deleted;
}

// 기간 만료 반(자유학기/내신/특강) 자동 정리.
// 학생 enrollment·class_settings 변경은 deleteClass → _MODES.applyToStudent에 위임.
async function _cleanupExpiredClasses() {
    const today = todayStr();
    const targets = [];
    for (const [code, cs] of Object.entries(state.classSettings)) {
        if (!cs) continue;
        if (cs.class_type === '특강' && cs.special_end && cs.special_end < today) {
            targets.push({ mode: 'teukang', code });
        } else if (cs.naesin_end && cs.naesin_end < today && cs.class_type !== '특강') {
            targets.push({ mode: 'naesin', code });
        } else if (cs.free_end && cs.free_end < today && cs.class_type !== '특강' && cs.class_type !== '내신') {
            targets.push({ mode: 'free', code });
        }
    }
    return _runAutoDelete('기간 만료 반 자동 정리', targets);
}

// 모든 유형(정규/자유학기/내신/특강)에서 학생 0명이면 자동 삭제.
// 두 가지 안전장치:
//   1) 활성 enrollment만 카운트 — end_date가 오늘 이전인 만료 enrollment는 학생으로 안 침
//   2) 미래 시작 반은 보존 — naesin_start/free_start/special_start가 today보다 미래면
//      학생들이 아직 배정되기 전이므로 0명이라도 삭제하지 않음
async function _cleanupEmptyClasses() {
    const today = todayStr();
    const isActive = (e) => !(e.end_date && e.end_date < today);
    const targets = [];

    for (const [code, cs] of Object.entries(state.classSettings)) {
        if (!cs) continue;

        if (cs.class_type === '특강') {
            if (cs.special_start && cs.special_start > today) continue;
            const has = state.allStudents.some(s =>
                (s.enrollments || []).some(e =>
                    e.class_type === '특강' && enrollmentCode(e) === code && isActive(e)
                )
            );
            if (!has) targets.push({ mode: 'teukang', code });
            continue;
        }

        if (cs.naesin_start && cs.naesin_end) {
            if (cs.naesin_start > today) continue;
            const has = state.allStudents.some(s => {
                if (s.status === '퇴원') return false;
                return (s.enrollments || []).some(e =>
                    isActiveNaesinBase(e, today) && e.class_number && e.naesin_class_override === code
                );
            });
            if (!has) targets.push({ mode: 'naesin', code });
            continue;
        }

        if (cs.free_schedule !== undefined || cs.free_start) {
            if (cs.free_start && cs.free_start > today) continue;
            const hasFree = state.allStudents.some(s =>
                (s.enrollments || []).some(e =>
                    e.class_type === '자유학기' && enrollmentCode(e) === code && isActive(e)
                )
            );
            if (!hasFree) targets.push({ mode: 'free', code });
            // 자유학기 부속만 제거하고 정규 코드는 보존 — 정규 학생 체크는 skip
            continue;
        }

        // 정규: 위 분기에 안 걸린 class_settings
        const hasReg = state.allStudents.some(s =>
            s.status !== '퇴원' && (s.enrollments || []).some(e =>
                (e.class_type === '정규' || !e.class_type) &&
                enrollmentCode(e) === code && isActive(e)
            )
        );
        if (!hasReg) targets.push({ mode: 'regular', code });
    }
    return _runAutoDelete('빈 반 자동 삭제', targets);
}

// 통합 자동 정리: 기간 만료 반 → 빈 정규반 순서로 체이닝.
// history_logs는 deleteClass 내부에서 기록됨. 동시 실행 방지를 위한 가드.
let _autoCleanupRunning = false;
export async function autoCleanupClasses() {
    if (READ_ONLY || _autoCleanupRunning) return { expired: [], empty: [] };
    if (!state.allStudents?.length) {
        console.warn('[autoCleanup] 학생 데이터 미로드 — 자동 정리 건너뜀');
        return { expired: [], empty: [] };
    }
    _autoCleanupRunning = true;
    try {
        const expired = await _cleanupExpiredClasses();
        const empty = await _cleanupEmptyClasses();
        return { expired, empty };
    } finally {
        _autoCleanupRunning = false;
    }
}

export function renderClassDeleteCard(classCode, mode) {
    const M = _MODES[mode];
    if (!M) return '';
    const count = _countAffectedStudents(classCode, mode);
    const label = CLASS_MODE_LABELS[mode] || mode;

    return `
        <div class="detail-card" style="border:1px solid #fecaca;background:#fef2f2;">
            <div class="detail-card-title" style="color:#b91c1c;">
                ${msIcon('delete_forever', '', 'style="color:#dc2626;"')}
                반 삭제
            </div>
            <div style="font-size:13px;color:#7f1d1d;line-height:1.6;margin-bottom:8px;">${esc(M.describe(count))}</div>
            <button class="btn" style="background:#dc2626;color:#fff;font-size:13px;"
                onclick="confirmDeleteClass('${escAttr(classCode)}', '${escAttr(mode)}')">
                ${msIcon('delete', '', 'style="font-size:16px;vertical-align:middle;"')}
                ${esc(label)} 반 삭제
            </button>
        </div>
    `;
}

export async function confirmDeleteClass(classCode, mode) {
    const label = CLASS_MODE_LABELS[mode] || mode;
    const count = _countAffectedStudents(classCode, mode);
    const period = getClassPeriodInfo(classCode, mode);

    if (mode === 'regular') {
        const first = confirm(`⚠️ 정규 반 "${classCode}" 삭제\n\n학생 ${count}명의 정규 등록이 모두 끊깁니다.\n진짜 삭제하시겠습니까?`);
        if (!first) return;
        const typed = prompt(`정말 삭제하려면 반 코드를 그대로 입력하세요:\n${classCode}`);
        if (typed !== classCode) {
            alert('입력이 일치하지 않아 취소되었습니다.');
            return;
        }
    } else if (period?.inProgress) {
        const first = confirm(`⚠️ ${label} 반 "${classCode}" 삭제 (현재 진행 중)\n\n기간: ${period.start} ~ ${period.end}\n영향 학생: ${count}명\n\n진행 중인 반을 삭제하면 학생들이 즉시 정규로 복귀합니다.\n진짜 삭제하시겠습니까?`);
        if (!first) return;
        const typed = prompt(`진행 중인 반입니다. 정말 삭제하려면 "삭제"를 입력하세요`);
        if (typed !== '삭제') {
            alert('입력이 일치하지 않아 취소되었습니다.');
            return;
        }
    } else {
        const periodNote = period ? `\n기간: ${period.start || '-'} ~ ${period.end || '-'}` : '';
        const ok = confirm(`${label} 반 "${classCode}" 삭제${periodNote}\n영향 학생 ${count}명. 삭제하시겠습니까?`);
        if (!ok) return;
    }

    try {
        await deleteClass(classCode, mode);
    } catch (err) {
        console.error('반 삭제 실패:', err);
        alert(`삭제 실패: ${err.message || err}`);
    }
}

// ─── 특강반 학생 추가 카드 ──────────────────────────────────────────────────

function renderTeukangAddStudentCard(classCode) {
    return renderAddStudentCard({
        key: classCode,
        idPrefix: 'teukang-add',
        searchHandlerName: 'searchTeukangAddStudent',
        footerText: '재원/등원예정/실휴원/가휴원/상담 + 퇴원/종강 학생 검색. 새 학생은 첫데이터입력으로 먼저 등록해 주세요.',
    });
}

const _teukangSearcher = createStudentSearcher({
    idPrefix: 'teukang-add',
    addHandlerName: 'addStudentToTeukang',
    getEnrolledIds: (classCode) => new Set(getTeukangClassStudents(classCode).map(s => s.docId)),
    getAllStudents: () => state.allStudents,
    allowNonEnrollable: true,
});

export function searchTeukangAddStudent(classCode, q) {
    _teukangSearcher(classCode, q);
}

function _findTeukangEnrollment(student, classCode) {
    return (student.enrollments || []).find(e =>
        e.class_type === '특강' && enrollmentCode(e) === classCode
    );
}

// 반 생성 마법사가 저장한 class_settings만 enrollment로 변환한다.
function _buildTeukangEnrollment(classCode, cs) {
    const days = Object.keys(cs.schedule || {})
        .sort((a, b) => DAY_ORDER.indexOf(a) - DAY_ORDER.indexOf(b));

    const enrollment = {
        class_type: '특강',
        level_symbol: '',
        class_number: classCode,
        day: days,
        start_date: cs.special_start || todayStr(),
    };
    if (cs.special_end) enrollment.end_date = cs.special_end;
    return enrollment;
}

export async function addStudentToTeukang(classCode, studentId) {
    let classSnap;
    try {
        classSnap = await getDocFromServer(doc(db, 'class_settings', classCode));
    } catch (err) {
        alert(`특강반 설정 확인에 실패했습니다: ${err.message}`);
        return;
    }
    if (!classSnap.exists() || classSnap.data()?.class_type !== '특강') {
        alert(`"${classCode}"는 반 생성 마법사에서 생성된 특강반이 아닙니다.\n학생을 추가할 수 없습니다.`);
        return;
    }
    const classSettings = classSnap.data();
    state.classSettings[classCode] = classSettings;

    // 로컬 캐시 우선, 없으면 Firestore에서 가져옴 (퇴원/종강 학생 처리)
    let student = state.allStudents.find(s => s.docId === studentId);
    let isFromRemote = false;
    if (!student) {
        try {
            const snap = await getDoc(doc(db, 'students', studentId));
            if (!snap.exists()) { alert('학생을 찾을 수 없습니다.'); return; }
            student = { docId: snap.id, ...snap.data() };
            isFromRemote = true;
        } catch (err) {
            alert('학생 조회 실패: ' + err.message);
            return;
        }
    }

    if (_findTeukangEnrollment(student, classCode)) {
        alert(`${student.name} 학생은 이미 ${classCode} 반에 등록되어 있습니다.`);
        return;
    }

    const newEnrollment = _buildTeukangEnrollment(classCode, classSettings);
    const prevStatus = student.status || '';
    const shouldReactivate = !isEnrollableStatus(prevStatus);
    if (shouldReactivate) {
        const ok = confirm(
            `${student.name || studentId} 학생은 현재 ${prevStatus || '상태없음'} 상태입니다.\n\n` +
            `특강 저장을 위해 상태를 '재원'으로 전환하고 이력을 남깁니다. 계속하시겠습니까?`
        );
        if (!ok) return;
    }

    showSaveIndicator('saving');
    try {
        const studentRef = doc(db, 'students', studentId);
        const update = {
            enrollments: arrayUnion(newEnrollment),
            status2: '특강',
        };
        if (shouldReactivate) {
            const actor = normalizeImpact7Email(auth.currentUser?.email || window._auditUser || 'unknown');
            update.status = '재원';
            update.status_changed_at = serverTimestamp();
            update.status_changed_by = actor;
            update.status_previous = prevStatus || null;

            const batch = writeBatch(db);
            batchUpdate(batch, studentRef, update);
            batchSet(batch, doc(collection(db, 'history_logs')), {
                doc_id: studentId,
                change_type: 'RETURN',
                before: `상태:${prevStatus}`,
                after: `상태:재원, 반:${classCode} (특강 재원전환)`,
                google_login_id: actor,
                timestamp: serverTimestamp(),
            });
            batchSet(batch, doc(collection(db, 'history_logs')), {
                doc_id: studentId,
                change_type: 'STATUS_CHANGE',
                before: JSON.stringify({ status: prevStatus }),
                after: JSON.stringify({ status: '재원' }),
                google_login_id: actor,
                timestamp: serverTimestamp(),
            });
            await batch.commit();
        } else {
            await auditUpdate(studentRef, update);
        }
        if (!READ_ONLY) {
            student.enrollments = [...(student.enrollments || []), newEnrollment];
            student.status2 = '특강';
            if (shouldReactivate) student.status = '재원';
            if (isFromRemote) {
                state.allStudents.push(student);
                state.allStudents.sort((a, b) => (a.name || '').localeCompare(b.name || '', 'ko'));
            }
        }
        showSaveIndicator('saved');
        renderClassDetail(classCode);
        renderListPanel?.();
    } catch (err) {
        console.error('특강 학생 추가 실패:', err);
        showSaveIndicator('error');
        alert('학생 추가에 실패했습니다: ' + err.message);
    }
}

// ─── Class Detail 핸들러 ────────────────────────────────────────────────────

export async function saveTeacherAssign(classCode) {
    const teacher = document.getElementById('teacher-select')?.value || '';
    const subTeacher = document.getElementById('sub-teacher-select')?.value || '';
    const prev = state.classSettings[classCode] || {};
    const prevTeacher = prev.teacher || '';
    const prevSubTeacher = prev.sub_teacher || '';
    try {
        showSaveIndicator('saving');
        await saveClassSettings(classCode, { teacher, sub_teacher: subTeacher });
        showSaveIndicator('saved');
        await recordTeacherChange(classCode, {
            class_type: prev.class_type || '',
            branch: prev.branch || '',
            teacher,
            sub_teacher: subTeacher,
            prev_teacher: prevTeacher,
            prev_sub_teacher: prevSubTeacher,
        });
    } catch (err) {
        console.error('담당 저장 실패:', err);
        showSaveIndicator('error');
    }
}

export async function addClassDomain(classCode) {
    const input = document.getElementById('domain-add-input');
    const name = input?.value.trim();
    if (!name) return;
    try {
        const domains = getClassDomains(classCode);
        if (domains.includes(name)) { alert('이미 존재하는 영역입니다.'); return; }
        domains.push(name);
        // 리뷰테스트에도 동기화 추가
        const sections = getClassTestSections(classCode);
        if (sections['리뷰테스트'] && !sections['리뷰테스트'].includes(name)) {
            sections['리뷰테스트'].push(name);
        }
        await saveClassSettings(classCode, { domains, test_sections: sections });
        input.value = '';
        renderClassDetail(classCode);
    } catch (e) {
        console.error('영역 추가 실패:', e);
        alert('영역 추가에 실패했습니다: ' + e.message);
    }
}

export async function removeClassDomain(classCode, index) {
    try {
        const domains = getClassDomains(classCode);
        if (domains.length <= 1) { alert('최소 1개의 영역이 필요합니다.'); return; }
        const removed = domains.splice(index, 1)[0];
        // 리뷰테스트에서도 동기화 삭제
        const sections = getClassTestSections(classCode);
        if (sections['리뷰테스트']) {
            const ri = sections['리뷰테스트'].indexOf(removed);
            if (ri !== -1) sections['리뷰테스트'].splice(ri, 1);
        }
        await saveClassSettings(classCode, { domains, test_sections: sections });
        renderClassDetail(classCode);
    } catch (e) {
        console.error('영역 삭제 실패:', e);
        alert('영역 삭제에 실패했습니다: ' + e.message);
    }
}

export async function resetClassDomains(classCode) {
    try {
        // 리뷰테스트도 기본 영역으로 초기화
        const sections = getClassTestSections(classCode);
        sections['리뷰테스트'] = [...DEFAULT_DOMAINS];
        await saveClassSettings(classCode, { domains: [...DEFAULT_DOMAINS], test_sections: sections });
        renderClassDetail(classCode);
    } catch (e) {
        console.error('기본값 복원 실패:', e);
        alert('기본값 복원에 실패했습니다: ' + e.message);
    }
}

export async function addTestToSection(classCode, sectionName) {
    const input = document.querySelector(`input[data-test-section="${CSS.escape(sectionName)}"]`);
    const name = input?.value.trim();
    if (!name) return;
    const sections = getClassTestSections(classCode);
    if (!sections[sectionName]) sections[sectionName] = [];
    if (sections[sectionName].includes(name)) { alert('이미 존재하는 테스트입니다.'); return; }
    sections[sectionName].push(name);
    await saveClassSettings(classCode, { test_sections: sections });
    renderClassDetail(classCode);
}

export async function removeTestFromSection(classCode, sectionName, index) {
    const sections = getClassTestSections(classCode);
    if (!sections[sectionName]) return;
    sections[sectionName].splice(index, 1);
    await saveClassSettings(classCode, { test_sections: sections });
    renderClassDetail(classCode);
}

export async function addTestSection(classCode) {
    const input = document.getElementById('test-section-add-input');
    const name = input?.value.trim();
    if (!name) return;
    const sections = getClassTestSections(classCode);
    if (sections[name] !== undefined) { alert('이미 존재하는 섹션입니다.'); return; }
    sections[name] = [];
    await saveClassSettings(classCode, { test_sections: sections });
    renderClassDetail(classCode);
}

export async function removeTestSection(classCode, sectionName) {
    const sections = getClassTestSections(classCode);
    if (Object.keys(sections).length <= 1) { alert('최소 1개의 섹션이 필요합니다.'); return; }
    delete sections[sectionName];
    await saveClassSettings(classCode, { test_sections: sections });
    renderClassDetail(classCode);
}

export async function resetTestSections(classCode) {
    await saveClassSettings(classCode, { test_sections: JSON.parse(JSON.stringify(DEFAULT_TEST_SECTIONS)) });
    renderClassDetail(classCode);
}

export async function resetTestSection(classCode, sectionName) {
    try {
        const sections = getClassTestSections(classCode);
        // 리뷰테스트는 영역숙제관리 기반, 기반학습테스트는 Vo/Id/ISC, 나머지는 빈 배열
        if (sectionName === '리뷰테스트') {
            sections[sectionName] = [...getClassDomains(classCode)];
        } else {
            sections[sectionName] = [...(DEFAULT_TEST_SECTIONS[sectionName] || [])];
        }
        await saveClassSettings(classCode, { test_sections: sections });
        renderClassDetail(classCode);
    } catch (e) {
        console.error('섹션 기본값 복원 실패:', e);
        alert('기본값 복원에 실패했습니다: ' + e.message);
    }
}

export async function saveClassDefaultTime(classCode, time) {
    if (!time) return;
    showSaveIndicator('saving');
    try {
        await saveClassSettings(classCode, {
            default_time: time,
            default_time_updated_by: state.currentUser?.email || '',
            default_time_updated_at: new Date().toISOString(),
        });
        // 서버에 실제 반영되었는지 검증 (오프라인 캐시 false-positive 방지)
        const snap = await getDocFromServer(doc(db, 'class_settings', classCode));
        const serverTime = snap.data()?.default_time;
        if (serverTime !== time) {
            throw new Error(`서버에 반영되지 않았습니다 (서버값: ${serverTime}). 로그아웃 후 다시 로그인해주세요.`);
        }
        showSaveIndicator('saved');
        renderClassDetail(classCode);
        if (state.selectedStudentId) renderStudentDetail(state.selectedStudentId);
    } catch (err) {
        console.error('반 기본 시간 저장 실패:', err);
        showSaveIndicator('error');
        alert('등원예정시간 저장에 실패했습니다: ' + err.message);
    }
}
