// 학생 상세의 [상담] 탭 렌더링 + 입력 저장 + 조회.
// data-layer.js 의 상담 헬퍼를 활용.

import {
  addConsultation,
  updateConsultationTitle,
  getStudentSummary,
  getStudentBriefing,
  generateStudentReportAi,
  searchStudentConsultations,
  listStudentPins,
  pinConsultation,
  unpinConsultation,
} from './data-layer.js';
import {
  filterConsultationsByKeyword,
  defaultSearchRange, consultationTitleFallback, sortConsultationsForHistory,
} from './consultation-filter.js';
import { buildConsultationPayload } from './consultation-payload.js';
import { generateConsultationTitle } from './consultation-ai.js';
import { enrollmentCode } from './student-helpers.js';
import { PAST_STUDENT_STATUSES } from './src/shared/firestore-helpers.js';
import { formatDateTimeKST } from '@impact7/shared/datetime';
import { esc } from './ui-utils.js';

let _deps = {};
let _activeSubtab = 'input';  // 'input' | 'search'
let _generatingAiFor = null;
const _aiCollapsed = { summary: false, briefing: false };
export function initConsultationCardDeps(deps) {
  // deps: { getStudent(id) → {name, ...}, getCurrentTeacher() → {id, name}, toast(msg, type), readonly: bool }
  _deps = deps;
}

const TYPES = ['정기', '휴원', '퇴원', '복귀', '학부모요청', '기타'];

const TARGETS = ['학생', '학부모'];
const METHODS = ['전화', '문자', '대면', '기타'];

// 상담 반명: 내신은 정규의 일시적 오버라이드일 뿐이므로 무시하고,
// 상담일 기준 활성인 정규·특강 등 원본 반코드를 그대로 노출한다.
// (getActiveEnrollments는 내신 활성 시 정규를 내신으로 치환해 코드가 비어버릴 수 있음)
function consultClassCodes(student, dateStr) {
  const today = dateStr || new Date().toISOString().slice(0, 10);
  const validDate = (d) => d && /^\d{4}-/.test(d);
  const codes = (student?.enrollments || [])
    .filter(e => {
      if (e.class_type === '내신') return false;
      if (validDate(e.start_date) && e.start_date > today) return false;
      if (validDate(e.end_date) && e.end_date < today) return false;
      return true;
    })
    .map(e => enrollmentCode(e))
    .filter(Boolean);
  return [...new Set(codes)];
}

function renderInputForm(studentId, readonly) {
  const today = new Date().toISOString().slice(0, 10);
  const dis = readonly ? 'disabled' : '';
  const student = _deps.getStudent?.(studentId) || {};
  const className = consultClassCodes(student, today).join(', ');
  const typeOpts = TYPES.map(t => `<option value="${t}">${t}</option>`).join('');
  const methodOpts = METHODS.map(m => `<option value="${m}">${m}</option>`).join('');
  const targetRadios = TARGETS.map((t, i) =>
    `<label class="consult-radio"><input type="radio" name="consult-target" value="${t}" ${i === 0 ? 'checked' : ''} ${dis}> ${t}</label>`
  ).join('');
  return `
    <div class="card consultation-input ${readonly ? 'readonly' : ''}">
      <h4>이번 상담 입력</h4>
      <div class="consult-form-grid">
        <div class="consult-row">
          <div class="consult-field consult-field-inline">
            <span class="consult-field-label">반명</span>
            <span class="consult-field-value" id="consult-class-name">${esc(className || '-')}</span>
          </div>
          <div class="consult-field consult-field-inline">
            <span class="consult-field-label">대상</span>
            <div class="consult-radio-group">${targetRadios}</div>
          </div>
        </div>
        <div class="consult-row">
          <div class="consult-field">
            <label for="consult-date">상담일</label>
            <input type="date" id="consult-date" value="${today}" onchange="onConsultDateChange('${esc(studentId)}')" ${dis}>
          </div>
          <div class="consult-field">
            <label for="consult-method">형태</label>
            <select id="consult-method" ${dis}>${methodOpts}</select>
          </div>
          <div class="consult-field">
            <label for="consult-type">유형</label>
            <select id="consult-type" ${dis}>${typeOpts}</select>
          </div>
        </div>
      </div>
      <div class="consult-field">
        <label for="consult-text">상담 메모</label>
        <textarea id="consult-text" class="consult-textarea" placeholder="상담 내용을 자유롭게 입력하세요" ${dis}></textarea>
      </div>
      <div class="consult-actions">
        ${readonly ? '<span class="hint">READ-ONLY 모드</span>' : ''}
        <button id="consult-save-btn" class="consult-save"
          onclick="onSaveConsultation('${esc(studentId)}')" ${dis}>저장</button>
      </div>
    </div>
  `;
}

function renderMarkdown(md) {
  // 단순 변환: 줄바꿈 → <br>, ##/### → h*. 본격 마크다운 처리는 v2.
  if (!md) return '<em>아직 AI 분석 전</em>';
  return esc(md)
    .replace(/\n{3,}/g, '\n\n')
    .replace(/\n\n(?=(?:[-*]|\d+\.|\*\*))/g, '\n')
    .replace(/^### (.+)$/gm, '<h5>$1</h5>')
    .replace(/^## (.+)$/gm, '<h4>$1</h4>')
    .replace(/^# (.+)$/gm, '<h3>$1</h3>')
    .replace(/\n/g, '<br>');
}

function formatGeneratedAt(value) {
  return formatDateTimeKST(value);
}

function renderAiAction(studentId, artifact) {
  const generating = _generatingAiFor === studentId;
  const label = artifact ? 'AI 갱신' : 'AI 생성';
  const generatedAt = formatGeneratedAt(artifact?.generated_at);
  const latest = artifact?.latest_consultation_date ? `최근 상담 ${esc(artifact.latest_consultation_date)}` : '';
  const meta = [generatedAt ? `마지막 생성 ${esc(generatedAt)}` : '', latest].filter(Boolean).join(' · ');
  return `
    <div class="consult-ai-action">
      <span class="hint">${meta}</span>
      <button class="consult-ai-btn" onclick="onGenerateConsultationAi('${esc(studentId)}')" ${generating ? 'disabled' : ''}>
        ${generating ? '생성 중...' : label}
      </button>
    </div>
  `;
}

function renderAiCollapseButton(kind) {
  const collapsed = _aiCollapsed[kind] === true;
  return `
    <button class="consult-collapse-btn" onclick="onToggleConsultationAiCard('${kind}')" title="${collapsed ? '펼치기' : '접기'}" aria-label="${collapsed ? '펼치기' : '접기'}">
      <span class="material-symbols-outlined">${collapsed ? 'expand_more' : 'expand_less'}</span>
    </button>
  `;
}

function renderSummaryCard(summary, studentId = '') {
  const meta = summary ? `priority: <strong>${esc(summary.priority || '-')}</strong> · 상담 ${summary.consultation_count ?? 0}건` : '';
  const collapsed = _aiCollapsed.summary === true;
  return `
    <div id="consult-summary-slot" class="card consultation-summary ${collapsed ? 'collapsed' : ''}">
      <div class="consult-card-head">
        <h4>AI 누적 요약 ${meta ? `<small>(${meta})</small>` : ''}</h4>
        ${renderAiCollapseButton('summary')}
      </div>
      ${collapsed ? '' : `
        ${renderAiAction(studentId, summary)}
        <div class="markdown consult-ai-body">${renderMarkdown(summary?.summary_markdown)}</div>
      `}
    </div>
  `;
}

function renderBriefingCard(briefing, studentId = '') {
  const next = briefing?.next_consultation_scheduled
    ? `다음 예정: ${esc(briefing.next_consultation_scheduled)}` : '';
  const collapsed = _aiCollapsed.briefing === true;
  return `
    <div id="consult-briefing-slot" class="card consultation-briefing ${collapsed ? 'collapsed' : ''}">
      <div class="consult-card-head">
        <h4>다음 상담 브리핑 ${next ? `<small>(${next})</small>` : ''}</h4>
        ${renderAiCollapseButton('briefing')}
      </div>
      ${collapsed ? '' : `
        ${renderAiAction(studentId, briefing)}
        <div class="markdown consult-ai-body">${renderMarkdown(briefing?.briefing_markdown)}</div>
      `}
    </div>
  `;
}

function getSearchEls() {
  return {
    startEl: document.getElementById('consult-search-start'),
    endEl: document.getElementById('consult-search-end'),
    kwEl: document.getElementById('consult-search-kw'),
    hintEl: document.getElementById('consult-search-hint'),
  };
}

function replaceHistoryCard(consultations, pinnedIds = [], studentId = '') {
  const slot = document.querySelector('.consultation-history');
  if (slot) slot.outerHTML = renderHistoryCard(consultations, pinnedIds, studentId);
}

// 기간 조회 + pin 로드 → 키워드 필터 → pin 먼저·최근순 정렬 → 이력 카드 교체.
async function loadAndRenderHistory(studentId, { startDate, endDate, keyword = '' }) {
  const [raw, pinnedIds] = await Promise.all([
    searchStudentConsultations(studentId, { startDate, endDate }),
    listStudentPins(studentId).catch(() => []),
  ]);
  const filtered = filterConsultationsByKeyword(raw, keyword);
  const sorted = sortConsultationsForHistory(filtered, pinnedIds);
  replaceHistoryCard(sorted, pinnedIds, studentId);
}

function replaceSlot(slotId, html) {
  const slot = document.getElementById(slotId);
  if (slot) slot.outerHTML = html;
}

function defaultSearchRangeForStudent(studentId) {
  const student = _deps.getStudent?.(studentId);
  const monthsBack = PAST_STUDENT_STATUSES.has(student?.status || '') ? 12 : 6;
  return defaultSearchRange(new Date(), monthsBack);
}

function renderSearchBar(studentId) {
  const { start, end } = defaultSearchRangeForStudent(studentId);
  return `
    <div class="card consultation-search">
      <div class="row consult-search-dates">
        <label>시작일 <input type="date" id="consult-search-start" value="${start}"></label>
        <label>종료일 <input type="date" id="consult-search-end" value="${end}"></label>
      </div>
      <div class="row">
        <input type="text" id="consult-search-kw" aria-label="키워드 검색" placeholder="키워드 (메모·유형·강사명)">
        <button id="consult-search-btn" onclick="onSearchConsultations('${esc(studentId)}')">검색</button>
        <button id="consult-search-reset" onclick="onResetConsultationSearch('${esc(studentId)}')">초기화</button>
      </div>
      <span class="hint" id="consult-search-hint"></span>
    </div>
  `;
}

// "2026-03-21" → "26-03-21" (yy-mm-dd)
function formatHistDate(dateStr) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(dateStr ?? ''));
  if (!m) return dateStr ?? '';
  return `${m[1].slice(2)}-${m[2]}-${m[3]}`;
}

function renderHistoryCard(consultations, pinnedIds = [], studentId = '') {
  if (!consultations.length) {
    return `<div class="card consultation-history"><h4>상담 이력</h4><em>기간 내역 없음</em></div>`;
  }
  const pinned = new Set(pinnedIds);
  const rows = consultations.map(c => {
    const isPinned = pinned.has(c.id);
    const name = c.student_name || '';
    let rawTitle = c.title || consultationTitleFallback(c.text);
    // 학생 이름은 패널 헤더에 이미 있으므로 제목 앞 이름 중복 제거
    if (name && rawTitle.startsWith(name)) rawTitle = rawTitle.slice(name.length).trim();
    const title = esc(rawTitle);
    const badge = esc([...new Set([c.consultation_type, c.method, c.target].filter(Boolean))].join('·'));
    return `
    <details class="consult-hist-item${isPinned ? ' pinned' : ''}">
      <summary>
        <button class="pin-toggle${isPinned ? ' active' : ''}" title="${isPinned ? '고정 해제' : '상단 고정'}"
          onclick="event.preventDefault(); event.stopPropagation(); onTogglePin('${esc(studentId)}','${esc(c.id)}')">📌</button>
        <strong>${esc(formatHistDate(c.date))}</strong>
        <span class="type-badge">${badge}</span>
        <span class="hist-title">${title}</span>
      </summary>
      <pre class="consultation-text">${esc(c.text)}</pre>
    </details>`;
  }).join('');
  return `<div class="card consultation-history"><h4>상담 이력 (${consultations.length}건)</h4>${rows}</div>`;
}

function renderConsultationHeader() {
  // 다른 탭과 통일: 별도 "상담" 헤더 바 없이 서브탭부터 바로 (탭 바에 이미 '상담' 표시됨)
  return `
    <div class="consultation-subtabs" role="tablist">
      <button class="consultation-subtab ${_activeSubtab === 'input' ? 'active' : ''}"
        role="tab" aria-selected="${_activeSubtab === 'input'}"
        onclick="onConsultationSubtab('input')">입력</button>
      <button class="consultation-subtab ${_activeSubtab === 'search' ? 'active' : ''}"
        role="tab" aria-selected="${_activeSubtab === 'search'}"
        onclick="onConsultationSubtab('search')">조회</button>
    </div>
  `;
}

export async function renderConsultationTab(studentId) {
  window.__consultStudentId = studentId;
  // #consultation-tab만 채운다. (#detail-content 전체를 덮으면 탭 바·다른 탭 div가
  // 사라져 switchDetailTab이 깨지고 닫기/탭전환이 TypeError로 실패한다)
  const container = document.getElementById('consultation-tab');
  if (!container) return;
  container.innerHTML = `
    ${renderConsultationHeader()}
    <div id="consult-subtab-body"><em>로딩 중…</em></div>
  `;
  if (_activeSubtab === 'input') {
    await renderInputTab(studentId);
  } else {
    await renderSearchTab(studentId);
  }
}

window.onConsultationSubtab = function (tab) {
  _activeSubtab = tab;
  const studentId = window.__consultStudentId;
  if (studentId) renderConsultationTab(studentId);  // 헤더가 active 상태를 다시 그림
};

// 상담일 변경 시 반명을 상담일 기준으로 갱신 (저장 로직과 일치). textContent라 XSS 안전.
window.onConsultDateChange = function (studentId) {
  const dateEl = document.getElementById('consult-date');
  const nameEl = document.getElementById('consult-class-name');
  if (!dateEl || !nameEl) return;
  const student = _deps.getStudent?.(studentId) || {};
  nameEl.textContent = consultClassCodes(student, dateEl.value).join(', ') || '-';
};

async function renderInputTab(studentId) {
  const body = document.getElementById('consult-subtab-body');
  if (!body) return;
  const readonly = _deps.readonly === true;
  body.innerHTML = `
    <div id="consult-briefing-slot"><em>브리핑 로딩 중…</em></div>
    ${renderInputForm(studentId, readonly)}
  `;
  const briefing = await getStudentBriefing(studentId).catch(() => null);
  if (window.__consultStudentId !== studentId) return;
  replaceSlot('consult-briefing-slot', renderBriefingCard(briefing, studentId));
}

async function renderSearchTab(studentId) {
  const body = document.getElementById('consult-subtab-body');
  if (!body) return;
  body.innerHTML = `
    <div id="consult-summary-slot"><em>요약 로딩 중…</em></div>
    ${renderSearchBar(studentId)}
    <div id="consult-history-slot"><em>이력 로딩 중…</em></div>
  `;
  const { start, end } = defaultSearchRangeForStudent(studentId);
  const [summary, history, pins] = await Promise.allSettled([
    getStudentSummary(studentId),
    searchStudentConsultations(studentId, { startDate: start, endDate: end }),
    listStudentPins(studentId),
  ]);
  if (window.__consultStudentId !== studentId) return;
  replaceSlot('consult-summary-slot', summary.status === 'fulfilled'
    ? renderSummaryCard(summary.value, studentId)
    : `<div class="card consultation-summary"><h4>AI 누적 요약</h4><em>로드 실패</em></div>`);
  if (history.status === 'fulfilled') {
    const pinnedIds = pins.status === 'fulfilled' ? pins.value : [];
    const sorted = sortConsultationsForHistory(history.value, pinnedIds);
    replaceSlot('consult-history-slot', renderHistoryCard(sorted, pinnedIds, studentId));
  } else {
    replaceSlot('consult-history-slot', `<div class="card consultation-history"><h4>상담 이력</h4><em>로드 실패</em></div>`);
  }
}

window.onSearchConsultations = async function (studentId) {
  const { startEl, endEl, kwEl, hintEl } = getSearchEls();
  const startDate = startEl.value || null;
  const endDate = endEl.value || null;
  const keyword = kwEl.value || '';

  if (startDate && endDate && startDate > endDate) {
    _deps.toast?.('시작일이 종료일보다 늦습니다', 'warn');
    return;
  }
  try {
    await loadAndRenderHistory(studentId, { startDate, endDate, keyword });
    if (hintEl) hintEl.textContent = '검색 완료';
  } catch (err) {
    console.error('[consultation] search failed:', err);
    _deps.toast?.(`검색 실패: ${err.message}`, 'error');
  }
};

window.onResetConsultationSearch = async function (studentId) {
  const { startEl, endEl, kwEl, hintEl } = getSearchEls();
  const { start, end } = defaultSearchRangeForStudent(studentId);
  if (startEl) startEl.value = start;
  if (endEl) endEl.value = end;
  if (kwEl) kwEl.value = '';
  if (hintEl) hintEl.textContent = '';
  try {
    await loadAndRenderHistory(studentId, { startDate: start, endDate: end, keyword: '' });
  } catch (err) {
    console.error('[consultation] reset failed:', err);
    _deps.toast?.(`초기화 실패: ${err.message}`, 'error');
  }
};

window.onGenerateConsultationAi = async function (studentId) {
  if (_generatingAiFor) return;
  _generatingAiFor = studentId;
  const refreshArtifacts = async () => {
    const [summary, briefing] = await Promise.all([
      getStudentSummary(studentId).catch(() => null),
      getStudentBriefing(studentId).catch(() => null),
    ]);
    if (document.getElementById('consult-summary-slot')) {
      replaceSlot('consult-summary-slot', renderSummaryCard(summary, studentId));
    }
    if (document.getElementById('consult-briefing-slot')) {
      replaceSlot('consult-briefing-slot', renderBriefingCard(briefing, studentId));
    }
  };
  await refreshArtifacts();
  try {
    const result = await generateStudentReportAi(studentId);
    _deps.toast?.(`AI 생성 완료 (상담 ${result?.consultation_count ?? 0}건 반영)`, 'success');
  } catch (err) {
    console.error('[consultation] AI generation failed:', err);
    _deps.toast?.(`AI 생성 실패: ${err.message}`, 'error');
  } finally {
    _generatingAiFor = null;
    await refreshArtifacts();
  }
};

window.onToggleConsultationAiCard = function (kind) {
  if (!Object.prototype.hasOwnProperty.call(_aiCollapsed, kind)) return;
  _aiCollapsed[kind] = !_aiCollapsed[kind];
  const studentId = window.__consultStudentId;
  if (studentId) renderConsultationTab(studentId);
};

window.onTogglePin = async function (studentId, cid) {
  if (_deps.readonly === true) { _deps.toast?.('읽기 전용 모드', 'warn'); return; }
  const teacher = _deps.getCurrentTeacher?.();
  if (!teacher) { _deps.toast?.('강사 정보 로드 실패', 'error'); return; }
  try {
    const pinnedIds = await listStudentPins(studentId);
    if (pinnedIds.includes(cid)) await unpinConsultation(cid);
    else await pinConsultation(cid, studentId, teacher.id);
    const { startEl, endEl, kwEl } = getSearchEls();
    await loadAndRenderHistory(studentId, {
      startDate: startEl?.value || null,
      endDate: endEl?.value || null,
      keyword: kwEl?.value || '',
    });
  } catch (err) {
    console.error('[consultation] pin toggle failed:', err);
    _deps.toast?.(`고정 변경 실패: ${err.message}`, 'error');
  }
};

// 저장 후 백그라운드로 AI 제목 생성 → fallback과 다르면 문서 업데이트. (저장 속도와 분리)
async function refineConsultationTitle(cid, memo) {
  try {
    const title = await generateConsultationTitle(memo);
    if (title && title !== consultationTitleFallback(memo)) {
      await updateConsultationTitle(cid, title);
    }
  } catch (err) {
    console.error('[consultation] 제목 백그라운드 갱신 실패:', err);
  }
}

window.onSaveConsultation = async function (studentId) {
  const dateEl = document.getElementById('consult-date');
  const methodEl = document.getElementById('consult-method');
  const typeEl = document.getElementById('consult-type');
  const textEl = document.getElementById('consult-text');
  const btn = document.getElementById('consult-save-btn');
  const targetEl = document.querySelector('input[name="consult-target"]:checked');
  if (!dateEl.value || !textEl.value.trim()) {
    _deps.toast?.('상담일과 메모를 입력하세요', 'warn');
    return;
  }
  const student = _deps.getStudent?.(studentId);
  const teacher = _deps.getCurrentTeacher?.();
  if (!student || !teacher) {
    _deps.toast?.('학생/강사 정보 로드 실패', 'error');
    return;
  }
  btn.disabled = true;
  btn.textContent = '저장 중...';
  try {
    const memo = textEl.value;
    const payload = buildConsultationPayload({
      studentId,
      studentName: student.name,
      className: consultClassCodes(student, dateEl.value).join(', '),
      teacherId: teacher.id,
      teacherName: teacher.name,
      date: dateEl.value,
      target: targetEl?.value || '학생',
      method: methodEl.value,
      consultationType: typeEl.value,
      text: memo,
      title: consultationTitleFallback(memo),
    });
    const cid = await addConsultation(payload);
    _deps.toast?.('상담 저장됨', 'success');
    textEl.value = '';
    if (cid) refineConsultationTitle(cid, memo);  // 백그라운드 AI 제목 (await 안 함 → 저장 즉시)
  } catch (err) {
    console.error('[consultation] save failed:', err);
    _deps.toast?.(`저장 실패: ${err.message}`, 'error');
  } finally {
    btn.disabled = false;
    btn.textContent = '저장';
  }
};
