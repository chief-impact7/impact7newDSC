// 학생 상세의 종합 상태 카드: Firebase 출결·숙제·테스트·상담을 Gemini로 종합한 요약.
// generateStudentReportAi(통합 Cloud Function)로 생성 → student_status_summaries 결과를 렌더.

import { msIcon } from './ms-icon.js';
import { getStudentStatusSummary, generateStudentReportAi } from './data-layer.js';
import { formatDateTimeKST } from '@impact7/shared/datetime';
import { esc, showToast, renderMarkdown } from './ui-utils.js';

let _deps = {};
let _generatingFor = null;
let _collapsed = false;

export function initStudentStatusCardDeps(deps) {
  // deps: { readonly: bool }
  _deps = deps;
}

const STATUS_TONE = {
  good: { label: '양호', cls: 'tone-good' },
  caution: { label: '주의', cls: 'tone-caution' },
  risk: { label: '위험', cls: 'tone-risk' },
};

function renderList(title, items) {
  if (!Array.isArray(items) || items.length === 0) return '';
  const lis = items.map(i => `<li>${esc(i)}</li>`).join('');
  return `<div class="status-list"><strong>${esc(title)}</strong><ul>${lis}</ul></div>`;
}

function renderStat(label, value) {
  return `<div class="status-stat"><span class="status-stat-label">${esc(label)}</span><span class="status-stat-val">${esc(String(value ?? 0))}</span></div>`;
}

function renderAction(studentId, artifact) {
  const generating = _generatingFor === studentId;
  const label = artifact ? 'AI 갱신' : 'AI 생성';
  const generatedAt = artifact?.generated_at ? formatDateTimeKST(artifact.generated_at) : '';
  const meta = generatedAt ? `마지막 생성 ${esc(generatedAt)}` : '';
  const dis = _deps.readonly ? 'disabled' : (generating ? 'disabled' : '');
  return `
    <div class="status-ai-action">
      <span class="hint">${meta}</span>
      <button class="status-ai-btn" ${dis}>
        ${generating ? '생성 중...' : label}
      </button>
    </div>
  `;
}

// 상담 공백 경고: 최근 상담 후 30일 초과(또는 상담 기록 없음)면 배너 표시.
function renderGapWarning(artifact) {
  if (!artifact?.consultation_gap_warning) return '';
  const days = artifact.consultation_gap_days;
  const msg = (days == null)
    ? '상담 기록 없음 — 첫 상담 필요'
    : `최근 상담 후 ${days}일 경과 — 상담 공백 주의`;
  return `<div class="status-gap-warning">${msIcon('warning')}${esc(msg)}</div>`;
}

function renderCardBody(studentId, artifact) {
  if (!artifact) {
    return `${renderAction(studentId, null)}<div class="markdown status-ai-body"><em>아직 AI 분석 전입니다. [AI 생성]을 눌러 최근 3개월 종합 상태를 분석하세요.</em></div>`;
  }
  return `
    ${renderAction(studentId, artifact)}
    ${renderGapWarning(artifact)}
    <div class="status-stats">
      ${renderStat('수업', artifact.daily_record_count)}
      ${renderStat('결석', artifact.absence_count)}
      ${renderStat('숙제미제출', artifact.hw_fail_count)}
      ${renderStat('테스트미달', artifact.test_fail_count)}
      ${renderStat('상담', artifact.consultation_count)}
    </div>
    <div class="markdown status-ai-body">${renderMarkdown(artifact.summary_markdown)}</div>
    ${renderList('위험 신호', artifact.risk_flags)}
    ${renderList('권장 조치', artifact.action_items)}
    ${artifact.attendance_comment ? `<p class="status-comment"><strong>출결</strong> ${esc(artifact.attendance_comment)}</p>` : ''}
    ${artifact.hw_comment ? `<p class="status-comment"><strong>숙제</strong> ${esc(artifact.hw_comment)}</p>` : ''}
    ${artifact.test_comment ? `<p class="status-comment"><strong>테스트</strong> ${esc(artifact.test_comment)}</p>` : ''}
  `;
}

function cardHtml(studentId, artifact) {
  const tone = artifact ? (STATUS_TONE[artifact.status] || STATUS_TONE.caution) : null;
  const badge = tone ? `<span class="status-tone-badge ${tone.cls}">${tone.label}</span>` : '';
  return `
    <div id="student-status-slot" data-student-id="${esc(studentId)}" class="detail-card student-status-card ${_collapsed ? 'collapsed' : ''}">
      <div class="detail-card-title status-card-head">
        <span>AI 종합 상태 ${badge}</span>
        <button class="status-collapse-btn" onclick="onToggleStudentStatusCard()" title="${_collapsed ? '펼치기' : '접기'}" aria-label="${_collapsed ? '펼치기' : '접기'}">
          ${msIcon(_collapsed ? 'expand_more' : 'expand_less')}
        </button>
      </div>
      ${_collapsed ? '' : renderCardBody(studentId, artifact)}
    </div>
  `;
}

function updateCard(mountEl, studentId, artifact) {
  mountEl.innerHTML = cardHtml(studentId, artifact);
  mountEl.querySelector('.status-ai-btn')?.addEventListener('click', () => {
    window.onGenerateStudentStatusAi(studentId);
  });
}

// artifact 조회 후 카드 재렌더. 조회 실패 시 골격(artifact=null)으로 폴백.
async function refresh(studentId, mountEl) {
  if (!mountEl) return;
  const artifact = await getStudentStatusSummary(studentId).catch((err) => {
    console.error('[student-status] 조회 실패:', err);
    return null;
  });
  // stale 방지: 그 사이 다른 학생으로 전환됐으면 무시
  if (mountEl.dataset.studentId && mountEl.dataset.studentId !== studentId) return;
  updateCard(mountEl, studentId, artifact);
}

export async function renderStudentStatusCard(studentId, mountEl) {
  if (!studentId || !mountEl) return;
  // 즉시 골격 렌더(생성 전이라도 버튼 노출), 데이터는 비동기로 채움
  updateCard(mountEl, studentId, null);
  await refresh(studentId, mountEl);
}

window.onGenerateStudentStatusAi = async function (studentId) {
  if (_deps.readonly || _generatingFor) return;
  const mountEl = document.getElementById('student-status-slot')?.parentElement;
  _generatingFor = studentId;
  if (mountEl) updateCard(mountEl, studentId, null);
  try {
    await generateStudentReportAi(studentId);
    showToast('AI 종합 분석 완료');
  } catch (err) {
    showToast('AI 생성 실패: ' + (err?.message || err));
    console.error('[student-status] 생성 실패:', err);
  } finally {
    _generatingFor = null;
    await refresh(studentId, mountEl);
  }
};

window.onToggleStudentStatusCard = function () {
  _collapsed = !_collapsed;
  const slot = document.getElementById('student-status-slot');
  refresh(slot?.dataset.studentId || '', slot?.parentElement);
};
