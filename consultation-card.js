// 학생 상세의 [상담] 탭 렌더링 + 입력 저장 + 조회.
// data-layer.js 의 헬퍼 4개를 활용.

import {
  addConsultation,
  getStudentSummary,
  getStudentBriefing,
  listStudentConsultations,
  searchStudentConsultations,
} from './data-layer.js';
import { filterConsultationsByKeyword, DEFAULT_HISTORY_LIMIT } from './consultation-filter.js';
import { buildConsultationPayload } from './consultation-payload.js';
import { activeClassCodes } from './student-helpers.js';

let _deps = {};
let _activeSubtab = 'input';  // 'input' | 'search'
export function initConsultationCardDeps(deps) {
  // deps: { getStudent(id) → {name, ...}, getCurrentTeacher() → {id, name}, toast(msg, type), readonly: bool }
  _deps = deps;
}

const TYPES = ['정기', '휴원', '퇴원', '복귀', '학부모요청', '기타'];

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

const TARGETS = ['학생', '학부모'];
const METHODS = ['전화', '문자', '대면', '기타'];

function renderInputForm(studentId, readonly) {
  const today = new Date().toISOString().slice(0, 10);
  const dis = readonly ? 'disabled' : '';
  const teacher = _deps.getCurrentTeacher?.() || { name: '?' };
  const student = _deps.getStudent?.(studentId) || {};
  const className = activeClassCodes(student, today).join(', ');
  const typeOpts = TYPES.map(t => `<option value="${t}">${t}</option>`).join('');
  const methodOpts = METHODS.map(m => `<option value="${m}">${m}</option>`).join('');
  const targetRadios = TARGETS.map((t, i) =>
    `<label class="consult-radio"><input type="radio" name="consult-target" value="${t}" ${i === 0 ? 'checked' : ''} ${dis}> ${t}</label>`
  ).join('');
  return `
    <div class="card consultation-input ${readonly ? 'readonly' : ''}">
      <h4>이번 상담 입력</h4>
      <div class="consult-meta-grid">
        <label>상담일 <input type="date" id="consult-date" value="${today}" ${dis}></label>
        <span class="consult-meta-field">입력일 <strong>저장 시 자동</strong></span>
        <span class="consult-meta-field">반명 <strong>${escapeHtml(className || '-')}</strong></span>
        <span class="consult-meta-field">학생명 <strong>${escapeHtml(student.name || '-')}</strong></span>
      </div>
      <div class="consult-row">
        <span class="consult-label">대상</span> ${targetRadios}
        ${teacher.name ? `<span class="hint">입력자: ${escapeHtml(teacher.name)}</span>` : ''}
      </div>
      <div class="consult-row">
        <label>형태 <select id="consult-method" ${dis}>${methodOpts}</select></label>
        <label>유형 <select id="consult-type" ${dis}>${typeOpts}</select></label>
      </div>
      <textarea id="consult-text" rows="6" placeholder="상담 메모를 자유롭게 입력하세요" ${dis}></textarea>
      <div class="consult-row consult-actions">
        <button id="consult-save-btn" class="consult-save"
          onclick="onSaveConsultation('${escapeHtml(studentId)}')" ${dis}>저장</button>
        ${readonly ? '<span class="hint">READ-ONLY 모드</span>' : ''}
      </div>
    </div>
  `;
}

function renderMarkdown(md) {
  // 단순 변환: 줄바꿈 → <br>, ##/### → h*. 본격 마크다운 처리는 v2.
  if (!md) return '<em>아직 AI 분석 전 (다음 파이프라인 실행 후 표시됨)</em>';
  return escapeHtml(md)
    .replace(/^### (.+)$/gm, '<h5>$1</h5>')
    .replace(/^## (.+)$/gm, '<h4>$1</h4>')
    .replace(/^# (.+)$/gm, '<h3>$1</h3>')
    .replace(/\n/g, '<br>');
}

function renderSummaryCard(summary) {
  const meta = summary ? `priority: <strong>${escapeHtml(summary.priority || '-')}</strong> · 상담 ${summary.consultation_count ?? 0}건` : '';
  return `
    <div class="card consultation-summary">
      <h4>AI 누적 요약 ${meta ? `<small>(${meta})</small>` : ''}</h4>
      <div class="markdown">${renderMarkdown(summary?.summary_markdown)}</div>
    </div>
  `;
}

function renderBriefingCard(briefing) {
  const next = briefing?.next_consultation_scheduled
    ? `다음 예정: ${escapeHtml(briefing.next_consultation_scheduled)}` : '';
  return `
    <div class="card consultation-briefing">
      <h4>다음 상담 브리핑 ${next ? `<small>(${next})</small>` : ''}</h4>
      <div class="markdown">${renderMarkdown(briefing?.briefing_markdown)}</div>
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

function replaceHistoryCard(consultations) {
  const slot = document.querySelector('.consultation-history');
  if (slot) slot.outerHTML = renderHistoryCard(consultations);
}

function replaceSlot(slotId, html) {
  const slot = document.getElementById(slotId);
  if (slot) slot.outerHTML = html;
}

function renderSearchBar(studentId) {
  return `
    <div class="card consultation-search">
      <div class="row">
        <label>시작일 <input type="date" id="consult-search-start"></label>
        <label>종료일 <input type="date" id="consult-search-end"></label>
      </div>
      <div class="row">
        <input type="text" id="consult-search-kw" placeholder="키워드 (메모·유형·강사명)">
        <button id="consult-search-btn" onclick="onSearchConsultations('${escapeHtml(studentId)}')">검색</button>
        <button id="consult-search-reset" onclick="onResetConsultationSearch('${escapeHtml(studentId)}')">초기화</button>
      </div>
      <span class="hint" id="consult-search-hint"></span>
    </div>
  `;
}

function renderHistoryCard(consultations) {
  if (!consultations.length) {
    return `<div class="card consultation-history"><h4>상담 이력</h4><em>없음</em></div>`;
  }
  const rows = consultations.map(c => `
    <details>
      <summary>
        <strong>${escapeHtml(c.date)}</strong>
        <span class="type-badge">${escapeHtml([c.consultation_type, c.method, c.target].filter(Boolean).join('·'))}</span>
        (${escapeHtml(c.teacher_name)})
        <span class="ellipsis">${escapeHtml((c.text || '').slice(0, 40))}…</span>
      </summary>
      <pre class="consultation-text">${escapeHtml(c.text)}</pre>
    </details>
  `).join('');
  return `<div class="card consultation-history"><h4>상담 이력 (최근 ${consultations.length}건)</h4>${rows}</div>`;
}

function renderConsultationHeader() {
  return `
    <div class="consultation-header">
      <h3>🗨 상담</h3>
      <button class="consultation-close" onclick="switchDetailTab('daily')">× 닫기</button>
    </div>
    <div class="consultation-subtabs">
      <button class="consultation-subtab ${_activeSubtab === 'input' ? 'active' : ''}"
        onclick="onConsultationSubtab('input')">입력</button>
      <button class="consultation-subtab ${_activeSubtab === 'search' ? 'active' : ''}"
        onclick="onConsultationSubtab('search')">조회</button>
    </div>
  `;
}

export async function renderConsultationTab(studentId) {
  window.__consultStudentId = studentId;
  const container = document.getElementById('detail-content');
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

async function renderInputTab(studentId) {
  const body = document.getElementById('consult-subtab-body');
  if (!body) return;
  const readonly = _deps.readonly === true;
  body.innerHTML = `
    <div id="consult-briefing-slot"><em>브리핑 로딩 중…</em></div>
    ${renderInputForm(studentId, readonly)}
  `;
  const briefing = await getStudentBriefing(studentId).catch(() => null);
  replaceSlot('consult-briefing-slot', renderBriefingCard(briefing));
}

async function renderSearchTab(studentId) {
  const body = document.getElementById('consult-subtab-body');
  if (!body) return;
  body.innerHTML = `
    <div id="consult-summary-slot"><em>요약 로딩 중…</em></div>
    ${renderSearchBar(studentId)}
    <div id="consult-history-slot"><em>이력 로딩 중…</em></div>
  `;
  const [summary, history] = await Promise.allSettled([
    getStudentSummary(studentId),
    listStudentConsultations(studentId, DEFAULT_HISTORY_LIMIT),
  ]);
  replaceSlot('consult-summary-slot', summary.status === 'fulfilled'
    ? renderSummaryCard(summary.value)
    : `<div class="card consultation-summary"><h4>AI 누적 요약</h4><em>로드 실패</em></div>`);
  replaceSlot('consult-history-slot', history.status === 'fulfilled'
    ? renderHistoryCard(history.value)
    : `<div class="card consultation-history"><h4>상담 이력</h4><em>로드 실패</em></div>`);
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
    const raw = await searchStudentConsultations(studentId, { startDate, endDate });
    const filtered = filterConsultationsByKeyword(raw, keyword);
    replaceHistoryCard(filtered);
    if (hintEl) {
      hintEl.textContent = (!startDate && !endDate)
        ? `최근 ${DEFAULT_HISTORY_LIMIT}건 범위에서 검색됨`
        : `${filtered.length}건 검색됨`;
    }
  } catch (err) {
    console.error('[consultation] search failed:', err);
    _deps.toast?.(`검색 실패: ${err.message}`, 'error');
  }
};

window.onResetConsultationSearch = async function (studentId) {
  const { startEl, endEl, kwEl, hintEl } = getSearchEls();
  if (startEl) startEl.value = '';
  if (endEl) endEl.value = '';
  if (kwEl) kwEl.value = '';
  if (hintEl) hintEl.textContent = '';
  const history = await listStudentConsultations(studentId, DEFAULT_HISTORY_LIMIT);
  replaceHistoryCard(history);
};

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
    const payload = buildConsultationPayload({
      studentId,
      studentName: student.name,
      className: activeClassCodes(student, dateEl.value).join(', '),
      teacherId: teacher.id,
      teacherName: teacher.name,
      date: dateEl.value,
      target: targetEl?.value || '학생',
      method: methodEl.value,
      consultationType: typeEl.value,
      text: textEl.value,
    });
    await addConsultation(payload);
    _deps.toast?.('상담 저장됨', 'success');
    textEl.value = '';
  } catch (err) {
    console.error('[consultation] save failed:', err);
    _deps.toast?.(`저장 실패: ${err.message}`, 'error');
  } finally {
    btn.disabled = false;
    btn.textContent = '저장';
  }
};
