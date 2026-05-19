// 학생 상세의 [상담] 탭 렌더링 + 입력 저장 + 조회.
// data-layer.js 의 헬퍼 4개를 활용.

import {
  addConsultation,
  getStudentSummary,
  getStudentBriefing,
  listStudentConsultations,
} from './data-layer.js';

let _deps = {};
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

function renderInputForm(studentId, readonly) {
  const today = new Date().toISOString().slice(0, 10);
  const typeOpts = TYPES.map(t => `<option value="${t}">${t}</option>`).join('');
  const dis = readonly ? 'disabled' : '';
  return `
    <div class="card consultation-input ${readonly ? 'readonly' : ''}">
      <h4>이번 상담 입력</h4>
      <div class="row">
        <label>상담일 <input type="date" id="consult-date" value="${today}" ${dis}></label>
        <label>유형 <select id="consult-type" ${dis}>${typeOpts}</select></label>
      </div>
      <textarea id="consult-text" rows="6" placeholder="상담 메모를 자유롭게 입력하세요"
        ${dis}></textarea>
      <div class="row">
        <button id="consult-save-btn"
          onclick="onSaveConsultation('${escapeHtml(studentId)}')"
          ${dis}>저장</button>
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

function renderHistoryCard(consultations) {
  if (!consultations.length) {
    return `<div class="card consultation-history"><h4>상담 이력</h4><em>없음</em></div>`;
  }
  const rows = consultations.map(c => `
    <details>
      <summary>
        <strong>${escapeHtml(c.date)}</strong>
        <span class="type-badge">${escapeHtml(c.consultation_type)}</span>
        (${escapeHtml(c.teacher_name)})
        <span class="ellipsis">${escapeHtml((c.text || '').slice(0, 40))}…</span>
      </summary>
      <pre class="consultation-text">${escapeHtml(c.text)}</pre>
    </details>
  `).join('');
  return `<div class="card consultation-history"><h4>상담 이력 (최근 ${consultations.length}건)</h4>${rows}</div>`;
}

export async function renderConsultationTab(studentId) {
  const container = document.getElementById('detail-content');
  if (!container) return;

  // 1차 렌더 (입력 폼은 즉시, 나머지는 로딩 중 표시)
  const readonly = _deps.readonly === true;
  container.innerHTML = `
    ${renderInputForm(studentId, readonly)}
    <div id="consult-summary-slot"><em>요약 로딩 중…</em></div>
    <div id="consult-briefing-slot"><em>브리핑 로딩 중…</em></div>
    <div id="consult-history-slot"><em>이력 로딩 중…</em></div>
  `;

  // 병렬 페치
  const [summary, briefing, history] = await Promise.allSettled([
    getStudentSummary(studentId),
    getStudentBriefing(studentId),
    listStudentConsultations(studentId, 10),
  ]);

  document.getElementById('consult-summary-slot').outerHTML = summary.status === 'fulfilled'
    ? renderSummaryCard(summary.value)
    : `<div class="card"><h4>AI 누적 요약</h4><em>로드 실패: ${escapeHtml(summary.reason?.message || '')}</em></div>`;

  document.getElementById('consult-briefing-slot').outerHTML = briefing.status === 'fulfilled'
    ? renderBriefingCard(briefing.value)
    : `<div class="card"><h4>다음 상담 브리핑</h4><em>로드 실패</em></div>`;

  document.getElementById('consult-history-slot').outerHTML = history.status === 'fulfilled'
    ? renderHistoryCard(history.value)
    : `<div class="card"><h4>상담 이력</h4><em>로드 실패</em></div>`;
}

window.onSaveConsultation = async function (studentId) {
  const dateEl = document.getElementById('consult-date');
  const typeEl = document.getElementById('consult-type');
  const textEl = document.getElementById('consult-text');
  const btn = document.getElementById('consult-save-btn');
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
    await addConsultation({
      student_id: studentId,
      student_name: student.name,
      teacher_id: teacher.id,
      teacher_name: teacher.name,
      date: dateEl.value,
      consultation_type: typeEl.value,
      text: textEl.value.trim(),
    });
    _deps.toast?.('상담 저장됨', 'success');
    textEl.value = '';
    // 이력만 재페치
    const history = await listStudentConsultations(studentId, 10);
    document.querySelector('.consultation-history').outerHTML = renderHistoryCard(history);
  } catch (err) {
    console.error('[consultation] save failed:', err);
    _deps.toast?.(`저장 실패: ${err.message}`, 'error');
  } finally {
    btn.disabled = false;
    btn.textContent = '저장';
  }
};
