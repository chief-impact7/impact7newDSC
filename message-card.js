// 학생 상세의 [메시지] 탭 — 개별 발송. 정보성 안내(알림톡 템플릿) / 자유 안내(친구=카톡·비친구=문자) / 홍보(브랜드 메시지).
// 수신 대상(학생/학부모1/학부모2/기타) 선택. 대규모/다수 발송은 별도 화면.
// 권한·광고 규제는 서버 callable이 검증한다.

import {
  sendParentNotice, createPromoCampaign, sendDailyReport,
  tabletCheckin, sendAbsenceNotice, getAbsenceNoticeToday, getRecipientMessageHistory,
} from './data-layer.js';
import { ATTENDANCE_ACTIONS } from '@impact7/shared/attendance-action';
import { esc, escAttr, isKakaoNightKST } from './ui-utils.js';

let _deps = {};
let _mode = 'notice'; // 'notice'(템플릿 안내) | 'free'(자유 안내) | 'promo'(홍보)
let _recipientField = 'parent_1'; // 'student' | 'parent_1' | 'parent_2' | 'other'
let _sending = false;
let _quickBusy = false;
// 멱등키 — 폼 단위로 안정 유지(응답 타임아웃 후 재시도의 중복 발송 차단), 발송 성공 시 재발급.
let _noticeReqId = null;
let _promoReqId = null;

// 백엔드 PARENT_NOTICE_TEMPLATES와 변수 키가 일치해야 한다(parentNoticeHandler.js).
const NOTICE_TEMPLATES = {
  counsel: { label: '상담 안내', vars: ['상담일시', '장소'] },
  tuition: { label: '수강료 납부 안내', vars: ['해당월', '납부금액', '납부기한'] },
  exam: { label: '시험·성적 안내', vars: ['시험명', '안내내용'] },
  notice: { label: '휴원·일정 안내', vars: ['안내내용', '적용일자'] },
  // study(학습 안내)는 카카오 반려로 드롭다운에서 임시 숨김 — 수업 리포트 템플릿 승인 후 복원/대체 예정.
  makeup: { label: '보강 안내', vars: ['보강일시', '보강내용'] },
};

// 백엔드 recipientPhone.js의 RECIPIENT_FIELDS와 일치.
const RECIPIENT_OPTIONS = [
  { field: 'student', label: '학생', key: 'student_phone' },
  { field: 'parent_1', label: '학부모1', key: 'parent_phone_1' },
  { field: 'parent_2', label: '학부모2', key: 'parent_phone_2' },
  { field: 'other', label: '기타', key: 'other_phone' },
];

// 등하원 빠른 처리 — 태블릿을 찍지 않은 학생의 수동 처리. tabletCheckin과 같은 서버 경로를 타므로
// 출결 기록과 알림톡 발송이 함께 되고, 태블릿에서 이미 처리한 액션은 상태머신이 막는다(버튼 비활성).
const QUICK_ACTIONS = [
  { key: 'arrival', label: ATTENDANCE_ACTIONS.arrival },
  { key: 'out', label: ATTENDANCE_ACTIONS.out },
  { key: 'return', label: ATTENDANCE_ACTIONS.return },
  { key: 'departure', label: ATTENDANCE_ACTIONS.departure },
];
// 로그북 미도착(연락) 배지와 같은 의미(absence_notices.delivery_status).
const ABSENCE_STATUS_LABEL = {
  sent: '미등원 알림톡 발송됨 ✓',
  failed_permanent: '미등원 알림톡 실패 ⚠',
};

const PROMO_PLACEHOLDER = '(광고)[임팩트세븐학원]\n\n안내 내용을 입력하세요.\n\n무료수신거부 080-000-0000';

const KIND_LABEL = {
  attendance: '출결', parent_notice: '안내', report: '안내', parent_bms: '안내',
  promo: '홍보', promo_sms: '홍보 문자', direct: '문자', bulk_info: '단체 안내',
};
// 발송 이력 상태 배지 — message_queue status 전체 커버(메시지센터와 동일 의미).
const HISTORY_STATUS = {
  pending: { label: '대기', bg: '#eef1f4', fg: '#5f6b76' },
  processing: { label: '처리중', bg: '#eef1f4', fg: '#5f6b76' },
  awaiting_delivery_result: { label: '확인중', bg: '#eef1f4', fg: '#5f6b76' },
  sent: { label: '발송완료', bg: '#e6f4ea', fg: '#1e7e34' },
  failed_retryable: { label: '재시도 대기', bg: '#fff3e0', fg: '#b26a00' },
  failed_permanent: { label: '실패', bg: '#fce8e6', fg: '#c82014' },
  converted_to_sms: { label: '문자 전환', bg: '#e8f0fe', fg: '#1a56b8' },
  archived: { label: '보관됨', bg: '#f1f3f4', fg: '#80868b' },
};
const HISTORY_LIMIT = 50;

// deps: { getStudent(id) → {name, studentNumber, student_phone, parent_phone_*, other_phone}, toast(msg, type), readonly }
export function initMessageCardDeps(deps) { _deps = deps; }

function onlyDigits(v) { return String(v ?? '').replace(/\D/g, ''); }

export function renderMessageTab(studentId) {
  const el = document.getElementById('message-tab');
  if (!el) return;
  _mode = 'notice';
  _noticeReqId = null;
  _promoReqId = null;
  const student = _deps.getStudent?.(studentId) || {};
  const readonly = _deps.readonly === true;

  // 가용 대상 — 번호가 있는 것만. 기본 선택은 학부모1(있으면), 없으면 첫 가용.
  const available = RECIPIENT_OPTIONS.filter((o) => onlyDigits(student[o.key]));
  _recipientField = available.some((o) => o.field === 'parent_1') ? 'parent_1' : (available[0]?.field ?? 'parent_1');
  const hasRecipient = available.length > 0;

  const recipientRadios = available.map((o) =>
    `<label style="display:inline-flex;align-items:center;gap:4px;margin:0;">
       <input type="radio" name="msg-recipient" value="${escAttr(o.field)}" ${o.field === _recipientField ? 'checked' : ''}>
       ${esc(o.label)}
     </label>`,
  ).join('');

  el.innerHTML = `
    <div class="card" style="padding:16px;">
      ${hasRecipient
        ? `<div style="display:flex;align-items:center;flex-wrap:wrap;gap:14px;margin-bottom:14px;"><span style="color:#555;">수신 대상</span>${recipientRadios}</div>`
        : '<div style="color:#c82014;margin-bottom:12px;">등록된 연락처가 없어 발송할 수 없습니다.</div>'}
      <div style="display:flex;gap:8px;margin-bottom:14px;">
        <button type="button" class="btn msg-mode-btn" data-mode="notice" aria-pressed="${_mode === 'notice'}">정보성 안내</button>
        <button type="button" class="btn msg-mode-btn" data-mode="free" aria-pressed="${_mode === 'free'}">자유 안내</button>
        <button type="button" class="btn msg-mode-btn" data-mode="promo" aria-pressed="${_mode === 'promo'}">홍보(광고)</button>
      </div>
      <div id="msg-form"></div>
      <div id="msg-history" style="margin-top:18px;"></div>
    </div>
  `;
  el.querySelectorAll('input[name="msg-recipient"]').forEach((r) => {
    r.addEventListener('change', () => { _recipientField = r.value; });
  });
  el.querySelectorAll('.msg-mode-btn').forEach((b) => {
    b.addEventListener('click', () => { _mode = b.dataset.mode; renderForm(studentId, hasRecipient, readonly); });
  });
  renderForm(studentId, hasRecipient, readonly);
  loadHistory(studentId);
}

function formatLogTime(v) {
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) return '';
  return `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

// ─── 최근 발송 내역 — 수신자별 타임라인(message_queue 기반, 본문 포함) ────────────

function renderHistoryItem(it) {
  const st = HISTORY_STATUS[it.status] || { label: it.status || '-', bg: '#eef1f4', fg: '#5f6b76' };
  const content = it.content
    ? esc(it.content)
    : `<i style="color:#aaa;">${it.piiPurged ? '(보존기간 경과로 본문 삭제됨)' : '(본문 없음)'}</i>`;
  const meta = [
    formatLogTime(it.createdAt),
    it.recipientMasked || '',
    it.lastErrorCode ? `오류 ${it.lastErrorCode}` : '',
  ].filter(Boolean).join(' · ');
  return `<div class="msg-hist-item" role="button" tabindex="0" aria-expanded="false"
      style="padding:8px 11px;border:1px solid #eceae4;border-radius:9px;margin-bottom:6px;background:#fff;cursor:pointer;">
    <div style="display:flex;align-items:center;gap:7px;min-width:0;">
      <span style="flex-shrink:0;font-size:11px;font-weight:700;color:#00754A;background:#eef7f2;padding:2px 9px;border-radius:10px;">${esc(KIND_LABEL[it.kind] || it.kind || '-')}</span>
      <span class="msg-hist-content" style="flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:13px;color:#333;">${content}</span>
      <span style="flex-shrink:0;font-size:11px;font-weight:700;color:${st.fg};background:${st.bg};padding:2px 9px;border-radius:10px;">${esc(st.label)}</span>
    </div>
    <div style="font-size:11.5px;color:#9a958c;margin-top:3px;">${esc(meta)}</div>
  </div>`;
}

async function loadHistory(studentId) {
  const box = document.getElementById('msg-history');
  if (!box) return;
  box.innerHTML = '<div style="color:#888;font-size:13px;">발송 내역 불러오는 중…</div>';
  try {
    const { items } = await getRecipientMessageHistory({ studentId, limit: HISTORY_LIMIT });
    if (!items || !items.length) {
      box.innerHTML = '<div style="color:#888;font-size:13px;">발송 내역이 없습니다.</div>';
      return;
    }
    const capNote = items.length >= HISTORY_LIMIT ? ` — 최근 ${HISTORY_LIMIT}건만 표시` : '';
    box.innerHTML = `
      <div style="display:flex;align-items:baseline;gap:8px;margin-bottom:8px;">
        <span style="font-weight:600;">최근 발송 내역</span>
        <span style="font-size:12px;color:#999;">${items.length}건${capNote} · 알림톡 본문은 발송 후 7일까지</span>
      </div>
      ${items.map(renderHistoryItem).join('')}`;
    // 행 클릭/엔터 → 본문 한 줄 미리보기 ↔ 전체 펼침.
    box.querySelectorAll('.msg-hist-item').forEach((row) => {
      const toggle = () => {
        const c = row.querySelector('.msg-hist-content');
        const expanded = c.style.whiteSpace !== 'nowrap';
        c.style.whiteSpace = expanded ? 'nowrap' : 'pre-wrap';
        c.style.wordBreak = expanded ? '' : 'break-word';
        row.setAttribute('aria-expanded', String(!expanded));
      };
      row.addEventListener('click', toggle);
      row.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle(); } });
    });
  } catch (err) {
    box.innerHTML = `<div style="color:#c82014;font-size:13px;">내역 조회 실패: ${esc(err?.message || '')}</div>`;
  }
}

// 발송은 워커가 비동기로 처리하므로 잠시 뒤 내역을 새로고침한다.
function scheduleHistoryReload(studentId) {
  setTimeout(() => loadHistory(studentId), 2500);
}

function renderForm(studentId, hasRecipient, readonly) {
  const form = document.getElementById('msg-form');
  if (!form) return;

  document.querySelectorAll('.msg-mode-btn').forEach((b) => {
    const on = b.dataset.mode === _mode;
    b.style.background = on ? 'var(--primary, #00754A)' : '#e8e6e0';
    b.style.color = on ? '#fff' : '#333';
  });

  const dis = (readonly || !hasRecipient) ? 'disabled' : '';

  if (_mode === 'notice') {
    const opts = Object.entries(NOTICE_TEMPLATES)
      .map(([k, v]) => `<option value="${k}">${esc(v.label)}</option>`).join('');
    const quickBtns = QUICK_ACTIONS.map((q) =>
      `<button type="button" class="btn msg-quick" data-action="${escAttr(q.label)}" style="background:#006241;color:#fff;" disabled>${esc(q.label)}</button>`,
    ).join('');
    form.innerHTML = `
      <div style="display:flex;align-items:center;gap:8px;margin-bottom:6px;">
        <span style="color:#555;">등하원 빠른 처리</span>
        <span id="msg-day-state" style="font-size:11px;font-weight:700;color:#5f6b76;background:#eef1f4;padding:2px 9px;border-radius:10px;">상태 확인 중…</span>
      </div>
      <div id="msg-quick-row" style="display:flex;gap:6px;flex-wrap:wrap;margin-bottom:4px;">
        ${quickBtns}
        <span id="msg-absence-slot"></span>
      </div>
      <div style="font-size:12px;color:#999;margin-bottom:14px;">태블릿을 찍지 않은 학생의 수동 처리 — 알림톡 발송과 함께 출결에도 기록됩니다.</div>
      <hr style="border:none;border-top:1px solid #eee;margin:0 0 14px;">
      <label style="display:block;margin-bottom:6px;">안내 종류</label>
      <select id="msg-template" class="field-input" style="margin-bottom:12px;">${opts}</select>
      <div id="msg-vars"></div>
      <button type="button" id="msg-send" class="btn btn-primary" style="margin-top:12px;" ${dis}>알림톡 발송</button>
    `;
    form.querySelectorAll('.msg-quick').forEach((b) =>
      b.addEventListener('click', () => sendQuickAttendance(studentId, b.dataset.action)));
    loadQuickState(studentId, readonly);
    const sel = document.getElementById('msg-template');
    const renderVars = () => {
      const def = NOTICE_TEMPLATES[sel.value];
      document.getElementById('msg-vars').innerHTML = def.vars.map((key) =>
        `<label style="display:block;margin:8px 0 4px;">${esc(key)}</label>
         <input type="text" class="field-input msg-var" data-key="${escAttr(key)}" ${dis}>`,
      ).join('');
    };
    sel.addEventListener('change', renderVars);
    renderVars();
    document.getElementById('msg-send').addEventListener('click', () => sendNotice(studentId, sel));
  } else if (_mode === 'free') {
    form.innerHTML = `
      <div style="font-size:13px;color:#777;margin-bottom:6px;">템플릿 없는 정보성 자유 내용입니다. 채널 가입자는 카카오톡으로, 미가입자는 문자로 발송됩니다. (광고성 내용은 '홍보' 모드를 사용하세요)</div>
      <textarea id="msg-content" class="field-input" aria-label="자유 안내 본문" rows="6" style="width:100%;box-sizing:border-box;" placeholder="보낼 내용을 입력하세요." ${dis}></textarea>
      <button type="button" id="msg-send" class="btn btn-primary" style="margin-top:12px;" ${dis}>메시지 발송</button>
    `;
    document.getElementById('msg-send').addEventListener('click', () => sendFree(studentId));
  } else {
    form.innerHTML = `
      <div style="font-size:13px;color:#777;margin-bottom:6px;">광고는 본문에 (광고) 표기와 무료수신거부 안내가 있어야 합니다.</div>
      <textarea id="msg-content" class="field-input" aria-label="홍보 메시지 본문" rows="6" style="width:100%;box-sizing:border-box;" placeholder="${escAttr(PROMO_PLACEHOLDER)}" ${dis}></textarea>
      <button type="button" id="msg-send" class="btn btn-primary" style="margin-top:12px;" ${dis}>브랜드 메시지 발송</button>
    `;
    document.getElementById('msg-send').addEventListener('click', () => sendPromo(studentId));
  }
}

// ─── 등하원 빠른 처리 — 태블릿과 같은 상태머신·같은 출결 기록 ─────────────────────

// 오늘 상태(태블릿 lookup)와 미등원 발송 여부를 읽어 버튼 활성/배지를 갱신한다.
// 태블릿에서 이미 등원했으면 등원 버튼이 비활성화되는 것도 이 로직(allowedActions)이다.
async function loadQuickState(studentId, readonly) {
  const student = _deps.getStudent?.(studentId) || {};
  const studentNumber = String(student.studentNumber ?? '').trim();
  const [lookup, absence] = await Promise.all([
    studentNumber ? tabletCheckin({ studentNumber }).catch(() => null) : Promise.resolve(null),
    getAbsenceNoticeToday(studentId).catch(() => null),
  ]);
  const cand = lookup?.candidates?.find((c) => c.studentId === studentId) || null;
  const allowed = new Set(cand?.allowedActions ?? []);
  // '아직 미등원' 판정은 상태 문자열 비교 대신 서버가 계산한 가능 액션으로 —
  // 등원이 가능한 상태(NONE)가 곧 미등원이다(문자열 로컬 상수 금지, AGENTS.md).
  const beforeArrival = allowed.has(ATTENDANCE_ACTIONS.arrival);

  const stateEl = document.getElementById('msg-day-state');
  if (stateEl) {
    stateEl.textContent = cand ? `오늘: ${cand.dayState}` : '출결 대상 아님';
    if (cand && !beforeArrival) {
      stateEl.style.color = '#1e7e34';
      stateEl.style.background = '#e6f4ea';
    }
  }
  document.querySelectorAll('.msg-quick').forEach((b) => {
    const ok = !readonly && cand && allowed.has(b.dataset.action);
    b.disabled = !ok || _quickBusy;
    b.style.opacity = ok ? '1' : '.45';
    b.title = ok ? '' : (cand
      ? `현재 상태(${cand.dayState})에서는 처리할 수 없습니다`
      : '학생번호가 없거나 출결 대상(재원·휴원)이 아닙니다');
  });

  const slot = document.getElementById('msg-absence-slot');
  if (!slot) return;
  if (absence?.exists) {
    const label = ABSENCE_STATUS_LABEL[absence.deliveryStatus] || '미등원 알림톡 처리중…';
    const ok = absence.deliveryStatus === 'sent';
    slot.innerHTML = `<span style="display:inline-flex;align-items:center;font-size:12px;font-weight:700;padding:6px 12px;border-radius:10px;background:${ok ? '#e6f4ea' : '#fff3e0'};color:${ok ? '#1e7e34' : '#b26a00'};">${esc(label)}</span>`;
    return;
  }
  const canAbsence = !readonly && cand && beforeArrival;
  slot.innerHTML = `<button type="button" id="msg-absence-btn" class="btn"
      style="background:#b3261e;color:#fff;${canAbsence ? '' : 'opacity:.45;'}"
      ${canAbsence && !_quickBusy ? '' : 'disabled'}
      title="${canAbsence ? '' : '아직 등원하지 않은 학생에게만 보낼 수 있습니다'}">미등원 알림톡</button>`;
  document.getElementById('msg-absence-btn')?.addEventListener('click', () => sendAbsenceQuick(studentId, readonly));
}

// 등하원 수동 처리 — tabletCheckin 확정 호출(출결 기록 + 알림톡 enqueue가 서버 트랜잭션 하나).
// 상태머신·연타 멱등은 서버가 보장하므로 클라는 이중 클릭만 막는다.
async function sendQuickAttendance(studentId, actionLabel) {
  if (_quickBusy) return;
  const student = _deps.getStudent?.(studentId) || {};
  _quickBusy = true;
  document.querySelectorAll('.msg-quick').forEach((b) => { b.disabled = true; });
  try {
    const res = await tabletCheckin({
      studentNumber: String(student.studentNumber ?? '').trim(),
      studentId, action: actionLabel, source: 'dsc',
    });
    if (res.result === 'duplicate') {
      _deps.toast?.('방금 처리된 출결입니다.', 'error');
    } else {
      _deps.toast?.(`${actionLabel} 처리 완료 — 출결 기록${res.queued ? ' + 알림톡 발송' : ' (연락처 없어 알림톡 생략)'}`, 'success');
      scheduleHistoryReload(studentId);
    }
  } catch (err) {
    _deps.toast?.(err?.message || `${actionLabel} 처리에 실패했습니다.`, 'error');
  } finally {
    _quickBusy = false;
    loadQuickState(studentId, _deps.readonly === true);
  }
}

// 미등원 알림톡 — 로그북 '미도착(연락)'과 같은 서버 멱등(absence_notices)이라 어느 쪽에서 보내든
// 다른 쪽에도 '발송됨'으로 반영된다.
async function sendAbsenceQuick(studentId, readonly) {
  if (_quickBusy) return;
  _quickBusy = true;
  try {
    const res = await sendAbsenceNotice({ studentId });
    if (res.alreadySent) _deps.toast?.('오늘 이미 미등원 안내를 발송했습니다.', 'error');
    else {
      _deps.toast?.('미등원 알림톡 발송을 요청했습니다.', 'success');
      scheduleHistoryReload(studentId);
    }
  } catch (err) {
    _deps.toast?.(err?.message || '미등원 안내 발송에 실패했습니다.', 'error');
  } finally {
    _quickBusy = false;
    loadQuickState(studentId, readonly);
  }
}

async function sendNotice(studentId, sel) {
  if (_sending) return;
  const templateKey = sel.value;
  const variables = {};
  document.querySelectorAll('.msg-var').forEach((i) => { variables[i.dataset.key] = i.value.trim(); });
  if (!_noticeReqId) _noticeReqId = `notice_${studentId}_${Date.now()}`;
  await doSend(
    () => sendParentNotice({ studentId, templateKey, variables, recipientField: _recipientField, requestId: _noticeReqId }),
    '알림톡 발송을 요청했습니다.',
    () => { _noticeReqId = null; scheduleHistoryReload(studentId); },
  );
}

async function sendPromo(studentId) {
  if (_sending) return;
  const content = document.getElementById('msg-content').value.trim();
  if (!content) { _deps.toast?.('본문을 입력하세요.', 'error'); return; }
  if (!_promoReqId) _promoReqId = `promo_${studentId}_${Date.now()}`;
  await doSend(
    () => createPromoCampaign({
      title: `개별홍보-${studentId}`, content, targeting: 'M',
      studentIds: [studentId], recipientField: _recipientField, requestId: _promoReqId,
    }),
    '브랜드 메시지 발송을 요청했습니다.',
    () => { _promoReqId = null; scheduleHistoryReload(studentId); },
  );
}

// 자유 안내(템플릿 없음) — 친구=정보형 BMS(카톡), 비친구=문자. sendDailyReport가 서버에서 분기.
// 멱등키 없이 재발송 허용(더블클릭은 _sending으로 차단) — parent-message.js 정책과 동일.
async function sendFree(studentId) {
  if (_sending) return;
  const content = document.getElementById('msg-content').value.trim();
  if (!content) { _deps.toast?.('내용을 입력하세요.', 'error'); return; }
  // 야간(20:50~08:00)엔 카카오가 친구 대상 카톡(브랜드메시지)을 차단한다. 발송자에게 처리 방식을 묻는다.
  let reserveIfNight = false;
  if (isKakaoNightKST()) {
    reserveIfNight = confirm('지금은 카카오톡 발송 제한 시간(밤 8:50~오전 8시)입니다.\n\n[확인] 채널 가입 학부모는 내일 오전 8시에 카카오톡으로 발송 (미가입자는 지금 문자)\n[취소] 지금 바로 문자로 발송');
  }
  await doSend(
    () => sendDailyReport({ studentId, content, recipientField: _recipientField, reserveIfNight }),
    // 실제 예약 여부는 서버 응답(scheduledDate: 친구+야간만 non-null)으로 판정 — 경계 시계 스큐 오표기 방지.
    (res) => (reserveIfNight && res?.scheduledDate)
      ? '예약했습니다 — 가입자는 내일 오전 8시 카카오톡, 미가입자는 지금 문자로 발송됩니다.'
      : '발송을 요청했습니다. (미도달 시 문자로 자동 전환)',
    () => scheduleHistoryReload(studentId),
  );
}

// onSuccess는 발송 성공 시에만 호출 — 멱등키를 비워 다음 발송에 새 키를 발급하게 한다.
async function doSend(fn, okMsg, onSuccess) {
  const btn = document.getElementById('msg-send');
  _sending = true;
  if (btn) btn.disabled = true;
  try {
    const res = await fn();
    _deps.toast?.(typeof okMsg === 'function' ? okMsg(res) : okMsg, 'success');
    onSuccess?.();
  } catch (err) {
    _deps.toast?.(err?.message || '발송에 실패했습니다.', 'error');
  } finally {
    _sending = false;
    if (btn) btn.disabled = false;
  }
}
