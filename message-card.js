// 학생 상세의 [메시지] 탭 — 개별 발송. 정보성 안내(알림톡 템플릿) 또는 홍보(브랜드 메시지).
// 수신 대상(학생/학부모1/학부모2/기타) 선택. 대규모/다수 발송은 별도 화면.
// 권한·광고 규제는 서버 callable이 검증한다.

import { sendParentNotice, createPromoCampaign } from './data-layer.js';
import { esc, escAttr } from './ui-utils.js';

let _deps = {};
let _mode = 'notice'; // 'notice' | 'promo'
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
  { key: 'arrival', label: '등원' },
  { key: 'departure', label: '귀가' },
  { key: 'out', label: '외출' },
  { key: 'return', label: '귀원' },
];

const PROMO_PLACEHOLDER = '(광고)[임팩트세븐학원]\n\n안내 내용을 입력하세요.\n\n무료수신거부 080-000-0000';

// deps: { getStudent(id) → {name, student_phone, parent_phone_*, other_phone}, toast(msg, type), readonly }
export function initMessageCardDeps(deps) { _deps = deps; }

function onlyDigits(v) { return String(v ?? '').replace(/\D/g, ''); }

function formatPhone(v) {
  const d = onlyDigits(v);
  if (!d) return '';
  if (d.length === 11) return `${d.slice(0, 3)}-${d.slice(3, 7)}-${d.slice(7)}`;
  if (d.length === 10) return `${d.slice(0, 3)}-${d.slice(3, 6)}-${d.slice(6)}`;
  return d;
}

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
    `<label style="display:inline-flex;align-items:center;gap:4px;margin:0 14px 6px 0;">
       <input type="radio" name="msg-recipient" value="${escAttr(o.field)}" ${o.field === _recipientField ? 'checked' : ''}>
       ${esc(o.label)} <span style="color:#555;">${esc(formatPhone(student[o.key]))}</span>
     </label>`,
  ).join('');

  el.innerHTML = `
    <div class="card" style="padding:16px;">
      <h4 style="margin:0 0 12px;">메시지 발송 — ${esc(student.name || '')}</h4>
      ${hasRecipient
        ? `<div style="margin-bottom:14px;"><div style="margin-bottom:6px;color:#555;">수신 대상</div>${recipientRadios}</div>`
        : '<div style="color:#c82014;margin-bottom:12px;">등록된 연락처가 없어 발송할 수 없습니다.</div>'}
      <div style="display:flex;gap:8px;margin-bottom:14px;">
        <button type="button" class="btn msg-mode-btn" data-mode="notice">정보성 안내</button>
        <button type="button" class="btn msg-mode-btn" data-mode="promo">홍보(광고)</button>
      </div>
      <div id="msg-form"></div>
    </div>
  `;
  el.querySelectorAll('input[name="msg-recipient"]').forEach((r) => {
    r.addEventListener('change', () => { _recipientField = r.value; });
  });
  el.querySelectorAll('.msg-mode-btn').forEach((b) => {
    b.addEventListener('click', () => { _mode = b.dataset.mode; renderForm(studentId, hasRecipient, readonly); });
  });
  renderForm(studentId, hasRecipient, readonly);
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
  } else {
    form.innerHTML = `
      <div style="font-size:13px;color:#777;margin-bottom:6px;">광고는 본문에 (광고) 표기와 무료수신거부 안내가 있어야 합니다.</div>
      <textarea id="msg-content" class="field-input" rows="6" style="width:100%;box-sizing:border-box;" placeholder="${escAttr(PROMO_PLACEHOLDER)}" ${dis}></textarea>
      <button type="button" id="msg-send" class="btn btn-primary" style="margin-top:12px;" ${dis}>브랜드 메시지 발송</button>
    `;
    document.getElementById('msg-send').addEventListener('click', () => sendPromo(studentId));
  }
}

// 등하원 빠른 발송 — 현재 시각으로 즉시. 의도적 반복(등원→귀가 등)이 가능하므로 멱등키는 매번 새로 발급(더블클릭만 _sending으로 차단).
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
    () => { _noticeReqId = null; },
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
    () => { _promoReqId = null; },
  );
}

// onSuccess는 발송 성공 시에만 호출 — 멱등키를 비워 다음 발송에 새 키를 발급하게 한다.
async function doSend(fn, okMsg, onSuccess) {
  const btn = document.getElementById('msg-send');
  _sending = true;
  if (btn) btn.disabled = true;
  try {
    await fn();
    _deps.toast?.(okMsg, 'success');
    onSuccess?.();
  } catch (err) {
    _deps.toast?.(err?.message || '발송에 실패했습니다.', 'error');
  } finally {
    _sending = false;
    if (btn) btn.disabled = false;
  }
}
