// 학생 상세의 [메시지] 탭 — 개별 발송. 정보성 안내(알림톡 템플릿) / 자유 안내(친구=카톡·비친구=문자) / 홍보(브랜드 메시지).
// 수신 대상(학생/학부모1/학부모2/기타) 선택. 대규모/다수 발송은 별도 화면.
// 권한·광고 규제는 서버 callable이 검증한다.

import { sendParentNotice, createPromoCampaign, getStudentMessages, sendDailyReport } from './data-layer.js';
import { ATTENDANCE_ACTIONS } from '@impact7/shared/attendance-action';
import { esc, escAttr, isKakaoNightKST } from './ui-utils.js';

let _deps = {};
let _mode = 'notice'; // 'notice'(템플릿 안내) | 'free'(자유 안내) | 'promo'(홍보)
let _recipientField = 'parent_1'; // 'student' | 'parent_1' | 'parent_2' | 'other'
let _sending = false;
// 멱등키 — 폼 단위로 안정 유지(응답 타임아웃 후 재시도의 중복 발송 차단), 발송 성공 시 재발급.
let _noticeReqId = null;
let _promoReqId = null;

// 백엔드 PARENT_NOTICE_TEMPLATES와 변수 키가 일치해야 한다(parentNoticeHandler.js).
const NOTICE_TEMPLATES = {
  counsel: { label: '상담 안내', vars: ['상담일시', '장소'] },
  tuition: { label: '수강료 납부 안내', vars: ['해당월', '납부금액', '납부기한'] },
  exam: { label: '시험·성적 안내', vars: ['시험명', '안내내용'] },
  notice: { label: '휴원·일정 안내', vars: ['안내내용', '적용일자'] },
  study: { label: '학습 안내', vars: ['안내내용'] },
  makeup: { label: '보강 안내', vars: ['보강일시', '보강내용'] },
};

// 백엔드 recipientPhone.js의 RECIPIENT_FIELDS와 일치.
const RECIPIENT_OPTIONS = [
  { field: 'student', label: '학생', key: 'student_phone' },
  { field: 'parent_1', label: '학부모1', key: 'parent_phone_1' },
  { field: 'parent_2', label: '학부모2', key: 'parent_phone_2' },
  { field: 'other', label: '기타', key: 'other_phone' },
];

// 등하원 빠른 발송 — 현재 시각으로 즉시 알림톡(parent_notice 템플릿 arrival/departure/out/return).
const QUICK_ACTIONS = [
  { key: 'arrival', label: ATTENDANCE_ACTIONS.arrival },
  { key: 'departure', label: ATTENDANCE_ACTIONS.departure },
  { key: 'out', label: ATTENDANCE_ACTIONS.out },
  { key: 'return', label: ATTENDANCE_ACTIONS.return },
];

const PROMO_PLACEHOLDER = '(광고)[임팩트세븐학원]\n\n안내 내용을 입력하세요.\n\n무료수신거부 080-000-0000';

const KIND_LABEL = { attendance: '출결', parent_notice: '안내', promo: '홍보', report: '안내', direct: '문자' };
const CHANNEL_LABEL = { kakao: '알림톡', sms: 'SMS', lms: 'LMS', mms: 'MMS' };

// deps: { getStudent(id) → {name, student_phone, parent_phone_*, other_phone}, toast(msg, type), readonly }
export function initMessageCardDeps(deps) { _deps = deps; }

function onlyDigits(v) { return String(v ?? '').replace(/\D/g, ''); }

// 현재 시각(KST 가정 — DSC 사용자 브라우저)을 '오전/오후 h:mm'으로. 등하원 #{시각} 변수값.
function nowTimeKST() {
  const d = new Date();
  const h = d.getHours();
  const ap = h < 12 ? '오전' : '오후';
  const h12 = h % 12 || 12;
  return `${ap} ${h12}:${String(d.getMinutes()).padStart(2, '0')}`;
}

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

function formatLogTime(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

function renderHistoryItem(it) {
  const ok = it.status === 'sent';
  const statusTxt = ok ? '성공' : '실패';
  const color = ok ? '#00754A' : '#c82014';
  const left = `${esc(KIND_LABEL[it.kind] || it.kind || '')} · ${esc(CHANNEL_LABEL[it.channel] || it.channel || '-')}`;
  return `<div style="display:flex;justify-content:space-between;padding:6px 0;border-bottom:1px solid #f0efea;font-size:13px;">
    <span>${left}</span>
    <span><span style="color:${color};">${esc(statusTxt)}</span> <span style="color:#999;">${esc(formatLogTime(it.createdAt))}</span></span>
  </div>`;
}

async function loadHistory(studentId) {
  const box = document.getElementById('msg-history');
  if (!box) return;
  box.innerHTML = '<div style="color:#888;font-size:13px;">발송 내역 불러오는 중…</div>';
  try {
    const { items } = await getStudentMessages(studentId);
    if (!items || !items.length) {
      box.innerHTML = '<div style="color:#888;font-size:13px;">발송 내역이 없습니다.</div>';
      return;
    }
    box.innerHTML = `<div style="font-weight:600;margin-bottom:8px;">최근 발송 내역</div>${items.map(renderHistoryItem).join('')}`;
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
      `<button type="button" class="btn msg-quick" data-key="${escAttr(q.key)}" style="background:#006241;color:#fff;" ${dis}>${esc(q.label)}</button>`,
    ).join('');
    form.innerHTML = `
      <div style="margin-bottom:6px;color:#555;">등하원 빠른 발송 (현재 시각)</div>
      <div style="display:flex;gap:6px;flex-wrap:wrap;margin-bottom:14px;">${quickBtns}</div>
      <hr style="border:none;border-top:1px solid #eee;margin:0 0 14px;">
      <label style="display:block;margin-bottom:6px;">안내 종류</label>
      <select id="msg-template" class="field-input" style="margin-bottom:12px;">${opts}</select>
      <div id="msg-vars"></div>
      <button type="button" id="msg-send" class="btn btn-primary" style="margin-top:12px;" ${dis}>알림톡 발송</button>
    `;
    form.querySelectorAll('.msg-quick').forEach((b) => b.addEventListener('click', () => sendQuick(studentId, b.dataset.key)));
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

// 등하원 빠른 발송 — 현재 시각으로 즉시. 의도적 반복(등원→하원 등)이 가능하므로 멱등키는 매번 새로 발급(더블클릭만 _sending으로 차단).
async function sendQuick(studentId, templateKey) {
  if (_sending) return;
  await doSend(
    () => sendParentNotice({
      studentId, templateKey,
      variables: { 시각: nowTimeKST() },
      recipientField: _recipientField,
      requestId: `${templateKey}_${studentId}_${Date.now()}`,
    }),
    '알림톡 발송을 요청했습니다.',
    () => scheduleHistoryReload(studentId),
  );
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
