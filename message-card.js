// 학생 상세의 [메시지] 탭 — 개별 발송. 정보성 안내(알림톡 템플릿) / 자유 안내(SMS/LMS) / 홍보 문자.
// 수신 대상(학생/학부모1/학부모2/기타) 선택. 대규모/다수 발송은 별도 화면.
// 권한·광고 규제는 서버 callable이 검증한다.

import {
  sendParentNotice, createPromoCampaign, sendDailyReport,
  tabletCheckin, sendAbsenceNotice, getAbsenceNoticeToday, getRecipientMessageHistory,
  setPromoConsent, saveStudentMessageRecipientSettings,
} from './data-layer.js';
import { ATTENDANCE_ACTIONS } from '@impact7/shared/attendance-action';
import { esc, escAttr } from './ui-utils.js';
import { OPT_OUT_LINE, ensurePromoCompliance } from './promo-compliance.js';
import {
  buildRecipientSettings,
  createRecipientSettingsSaveQueue,
  MESSAGE_RECIPIENT_SETTINGS_FIELD,
  resolveRecipientFields,
} from './src/messages/recipient-settings.js';
import { onlyDigits } from './src/messages/message-format.js';
import { msIcon } from './ms-icon.js';

let _deps = {};
let _mode = 'notice'; // 'notice'(템플릿 안내) | 'free'(자유 안내) | 'promo'(홍보)
let _alimtalkRecipientFields = new Set(['parent_1']);
let _smsRecipientFields = new Set(['parent_1']);
let _sending = false;
let _quickBusy = false;
let _currentStudentId = null;
// 멱등키 — 폼 단위로 안정 유지(응답 타임아웃 후 재시도의 중복 발송 차단), 발송 성공 시 재발급.
let _noticeReqId = null;
let _promoReqId = null;
let _freeReqId = null;

// 백엔드 PARENT_NOTICE_TEMPLATES와 변수 키가 일치해야 한다(parentNoticeHandler.js).
const NOTICE_TEMPLATES = {
  counsel: { label: '상담 안내', vars: ['상담일시', '장소'] },
  tuition: { label: '수강료 납부 안내', vars: ['해당월', '납부금액', '납부기한'] },
  exam: { label: '시험·성적 안내', vars: ['시험명', '안내내용'] },
  notice: { label: '휴원·일정 안내', vars: ['안내내용', '적용일자'] },
  arrival_plan: { label: '등원 예정 안내', vars: ['일시', '사유'] },
  makeup: { label: '보강 안내', vars: ['보강일시', '보강내용'] },
};

// 백엔드 recipientPhone.js의 RECIPIENT_FIELDS와 일치.
const RECIPIENT_OPTIONS = [
  { field: 'student', label: '학생', key: 'student_phone' },
  { field: 'parent_1', label: '학부모1', key: 'parent_phone_1' },
  { field: 'parent_2', label: '학부모2', key: 'parent_phone_2' },
  { field: 'other', label: '기타', key: 'other_phone' },
];
const RECIPIENT_LABELS = Object.fromEntries(RECIPIENT_OPTIONS.map((o) => [o.field, o.label]));

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
  sent: '미등원 알림톡 발송됨',
  failed_permanent: '미등원 알림톡 실패',
};

// 광고 수신동의 — 번호 주인 단위. 서버 promoConsent.js(promo=보호자, promo_student=학생)와 필드 일치.
const CONSENT_TARGETS = [
  { target: 'parent', field: 'promo', label: '학부모' },
  { target: 'student', field: 'promo_student', label: '학생' },
];
const CONSENT_SOURCE_LABEL = {
  diagnostic_form: '진단평가 신청서', survey_form: '설문', admin: '관리자 입력', kakao_friend: '카카오 친구',
  optout_080: '080 수신거부',
};
let _consent = null; // 현재 학생의 message_consent 사본(설정/철회 후 낙관 갱신)

const PROMO_PLACEHOLDER = `(광고)[임팩트세븐학원]\n\n안내 내용을 입력하세요.\n\n${OPT_OUT_LINE}`;

const KIND_LABEL = {
  attendance: '출결', parent_notice: '안내', report: '안내', parent_bms: '안내',
  promo: '홍보', promo_sms: '홍보 문자', direct: '문자', bulk_info: '단체 안내',
};
// 발송 이력 상태 배지 — message_queue status 전체 커버(메시지센터와 동일 의미).
const HISTORY_STATUS = {
  pending: { label: '대기', bg: '#eef1f4', fg: '#5f6b76' },
  split_waiting: { label: '분할 대기', bg: '#eef1f4', fg: '#5f6b76' },
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

function selectedRecipientFields(channel) {
  return [...(channel === 'alimtalk' ? _alimtalkRecipientFields : _smsRecipientFields)];
}

function currentRecipientSettings() {
  return buildRecipientSettings(_alimtalkRecipientFields, _smsRecipientFields);
}

const enqueueRecipientSettingsSave = createRecipientSettingsSaveQueue(
  (studentId, settings) => saveStudentMessageRecipientSettings(studentId, settings),
  (err) => {
    console.error('[message-card] 수신 대상 저장 실패:', err);
    _deps.toast?.(err?.message || '수신 대상 저장에 실패했습니다.', 'error');
  },
);

function saveRecipientSettings(studentId) {
  const settings = currentRecipientSettings();
  const cached = _deps.getStudent?.(studentId);
  if (cached) cached[MESSAGE_RECIPIENT_SETTINGS_FIELD] = settings;
  void enqueueRecipientSettingsSave(studentId, settings);
}

export function renderMessageTab(studentId) {
  const el = document.getElementById('message-tab');
  if (!el) return;
  _currentStudentId = studentId;
  _mode = 'notice';
  _noticeReqId = null;
  _promoReqId = null;
  _freeReqId = null;
  const student = _deps.getStudent?.(studentId) || {};
  const readonly = _deps.readonly === true;

  // 가용 대상 — 번호가 있는 것만. 기본 선택은 학부모1(있으면), 없으면 첫 가용.
  const available = RECIPIENT_OPTIONS.filter((o) => onlyDigits(student[o.key]));
  const availableFields = available.map((o) => o.field);
  const savedRecipients = student[MESSAGE_RECIPIENT_SETTINGS_FIELD];
  _alimtalkRecipientFields = new Set(resolveRecipientFields(savedRecipients, 'alimtalk', availableFields));
  _smsRecipientFields = new Set(resolveRecipientFields(savedRecipients, 'sms', availableFields));
  const hasRecipient = available.length > 0;

  const recipientChecks = (channel, selected) => available.map((o) =>
    `<label style="display:inline-flex;align-items:center;gap:4px;margin:0;">
       <input type="checkbox" name="msg-recipient-${channel}" value="${escAttr(o.field)}" ${selected.has(o.field) ? 'checked' : ''}>
       ${esc(o.label)}
     </label>`,
  ).join('');

  _consent = student.message_consent ? { ...student.message_consent } : {};

  const modeBtnStyle = 'padding:4px 12px;font-size:12.5px;';
  el.innerHTML = `
    <div style="display:flex;flex-direction:column;gap:8px;">
      <div class="card" style="padding:7px 14px;">
        <div id="msg-consent"></div>
      </div>
      <div class="card" style="padding:9px 14px;">
        ${hasRecipient
          ? `<div style="display:grid;gap:5px;margin-bottom:6px;font-size:13px;">
              <div style="display:flex;align-items:center;flex-wrap:wrap;gap:10px;">
                <span style="color:#555;min-width:74px;">알림톡 수신</span>${recipientChecks('alimtalk', _alimtalkRecipientFields)}
              </div>
              <div style="display:flex;align-items:center;flex-wrap:wrap;gap:10px;">
                <span style="color:#555;min-width:74px;">문자 수신</span>${recipientChecks('sms', _smsRecipientFields)}
              </div>
            </div>`
          : '<div style="color:#c82014;margin-bottom:6px;font-size:13px;">등록된 연락처가 없어 발송할 수 없습니다.</div>'}
        <div style="display:flex;gap:6px;margin-bottom:8px;">
          <button type="button" class="btn msg-mode-btn" data-mode="notice" style="${modeBtnStyle}" aria-pressed="${_mode === 'notice'}">정보성 안내</button>
          <button type="button" class="btn msg-mode-btn" data-mode="free" style="${modeBtnStyle}" aria-pressed="${_mode === 'free'}">자유 안내</button>
          <button type="button" class="btn msg-mode-btn" data-mode="promo" style="${modeBtnStyle}" aria-pressed="${_mode === 'promo'}">홍보(광고)</button>
        </div>
        <div id="msg-form"></div>
      </div>
      <div class="card" style="padding:9px 14px;">
        <div id="msg-history"></div>
      </div>
    </div>
  `;
  renderConsentStrip(studentId, readonly);
  el.querySelectorAll('input[name="msg-recipient-alimtalk"]').forEach((r) => {
    r.addEventListener('change', () => {
      if (r.checked) _alimtalkRecipientFields.add(r.value);
      else _alimtalkRecipientFields.delete(r.value);
      _noticeReqId = null;
      void saveRecipientSettings(studentId);
    });
  });
  el.querySelectorAll('input[name="msg-recipient-sms"]').forEach((r) => {
    r.addEventListener('change', () => {
      if (r.checked) _smsRecipientFields.add(r.value);
      else _smsRecipientFields.delete(r.value);
      _freeReqId = null;
      _promoReqId = null;
      void saveRecipientSettings(studentId);
    });
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

// ─── 광고 수신동의 표시·철회 — 개인정보 동의(표시)와 마케팅 동의(설정/철회)를 분리 ────

// Firestore Timestamp(toDate)·Date·epoch 모두 'YYYY-MM-DD'로.
function consentDate(ts) {
  const d = ts?.toDate?.() ?? (ts != null ? new Date(ts.seconds ? ts.seconds * 1000 : ts) : null);
  if (!d || Number.isNaN(d.getTime())) return '';
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function consentStatusHtml(c) {
  if (c?.optedIn === true && !c.revokedAt) {
    const src = CONSENT_SOURCE_LABEL[c.source] || c.source || '';
    return `<span style="color:#00754A;font-weight:700;">동의</span> <span style="color:#999;">${esc([consentDate(c.at), src].filter(Boolean).join(' · '))}</span>`;
  }
  if (c?.revokedAt) {
    // 080 전화 수신거부(솔라피 명단 동기화)는 학원 철회 처리와 구분해 표기.
    const label = c.source === 'optout_080' ? '수신거부(080)' : '철회';
    return `<span style="color:#c82014;font-weight:700;">${label}</span> <span style="color:#999;">${esc(consentDate(c.revokedAt))}</span>`;
  }
  return '<span style="color:#888;">미동의</span>';
}

function renderConsentStrip(studentId, readonly) {
  const box = document.getElementById('msg-consent');
  if (!box) return;
  const privacy = _consent?.privacy;
  const rows = CONSENT_TARGETS.map(({ target, field, label }) => {
    const c = _consent?.[field];
    const consented = c?.optedIn === true && !c.revokedAt;
    const btn = readonly ? '' : (consented
      ? `<button type="button" class="btn msg-consent-btn" data-target="${target}" data-opt="0" style="font-size:11.5px;padding:1px 9px;background:#fff;color:#c82014;border:1px solid #e5b9b5;border-radius:12px;">철회</button>`
      : `<button type="button" class="btn msg-consent-btn" data-target="${target}" data-opt="1" style="font-size:11.5px;padding:1px 9px;background:#fff;color:#00754A;border:1px solid #bcd8cb;border-radius:12px;">동의</button>`);
    return `<span style="display:inline-flex;align-items:center;gap:5px;">
      <b style="color:#555;font-weight:600;">${esc(label)}</b> ${consentStatusHtml(c)} ${btn}
    </span>`;
  }).join('<span style="color:#ddd;">|</span>');
  // 상세 설명(정보성 무관·개인정보 동의 내역)은 툴팁으로 — 한 줄 유지가 우선.
  const privacyTxt = privacy?.agreed
    ? `개인정보 동의 ${[consentDate(privacy.at), CONSENT_SOURCE_LABEL[privacy.source] || privacy.source || ''].filter(Boolean).join(' · ')}`
    : '개인정보 동의 기록 없음';
  box.innerHTML = `
    <div style="display:flex;align-items:center;gap:9px;flex-wrap:wrap;font-size:12.5px;"
         title="출결·안내 등 정보성 메시지는 광고 동의와 무관하게 발송됩니다">
      <span style="font-weight:700;color:#555;">광고 수신동의</span>${rows}
      <span style="margin-left:auto;font-size:11px;color:#9a958c;">${esc(privacyTxt)}</span>
    </div>`;
  box.querySelectorAll('.msg-consent-btn').forEach((b) =>
    b.addEventListener('click', () => setConsent(studentId, b.dataset.target, b.dataset.opt === '1', readonly)));
}

async function setConsent(studentId, target, optedIn, readonly) {
  if (_sending) return;
  const label = CONSENT_TARGETS.find((t) => t.target === target)?.label || target;
  const msg = optedIn
    ? `${label} 대상 광고 수신동의를 기록할까요?\n(전화·서면 등으로 동의 의사를 확인한 경우에만)`
    : `${label} 대상 광고 수신동의를 철회 처리할까요?\n철회하면 광고 발송 대상에서 영구 제외됩니다.`;
  if (!confirm(msg)) return;
  _sending = true;
  try {
    await setPromoConsent({ studentId, target, optedIn, source: 'admin' });
    const field = CONSENT_TARGETS.find((t) => t.target === target)?.field;
    if (field) {
      const entry = { optedIn, source: 'admin', at: new Date(), revokedAt: optedIn ? null : new Date() };
      _consent = { ..._consent, [field]: entry };
      // 캐시된 student.message_consent도 함께 갱신한다. students는 onSnapshot이 아니라 getDocs로
      // 로드돼 renderMessageTab이 재진입마다 student.message_consent로 _consent를 재초기화하므로,
      // 여기서 캐시를 안 고치면 탭 재진입 시 방금 철회/기록이 이전 상태로 되돌아 보인다(M-1).
      const cached = _deps.getStudent?.(studentId);
      if (cached) cached.message_consent = { ...(cached.message_consent || {}), [field]: entry };
    }
    _deps.toast?.(optedIn ? `${label} 광고 수신동의를 기록했습니다.` : `${label} 광고 수신동의를 철회했습니다.`, 'success');
  } catch (err) {
    _deps.toast?.(err?.message || '동의 처리에 실패했습니다.', 'error');
  } finally {
    _sending = false;
    renderConsentStrip(studentId, readonly);
  }
}

// ─── 최근 발송 내역 — 수신자별 타임라인(message_queue 기반, 본문 포함) ────────────

function renderHistoryItem(it) {
  const st = HISTORY_STATUS[it.status] || { label: it.status || '-', bg: '#eef1f4', fg: '#5f6b76' };
  const content = it.content
    ? esc(it.content)
    : `<i style="color:#aaa;">${it.piiPurged ? '(보존기간 경과로 본문 삭제됨)' : '(본문 없음)'}</i>`;
  const meta = [
    formatLogTime(it.createdAt),
    RECIPIENT_LABELS[it.recipientRole] || '',
    it.recipientMasked || '',
    it.lastErrorCode ? `오류 ${it.lastErrorCode}` : '',
  ].filter(Boolean).join(' · ');
  return `<div class="msg-hist-item" role="button" tabindex="0" aria-expanded="false"
      style="padding:6px 10px;border:1px solid #eceae4;border-radius:8px;margin-bottom:5px;background:#fff;cursor:pointer;">
    <div style="display:flex;align-items:center;gap:6px;min-width:0;">
      <span style="flex-shrink:0;font-size:11px;font-weight:700;color:#00754A;background:#eef7f2;padding:1px 8px;border-radius:10px;">${esc(KIND_LABEL[it.kind] || it.kind || '-')}</span>
      <span class="msg-hist-content" style="flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:12.5px;color:#333;">${content}</span>
      <span style="flex-shrink:0;font-size:11px;font-weight:700;color:${st.fg};background:${st.bg};padding:1px 8px;border-radius:10px;">${esc(st.label)}</span>
    </div>
    <div style="font-size:11px;color:#9a958c;margin-top:2px;">${esc(meta)}</div>
  </div>`;
}

async function loadHistory(studentId) {
  const box = document.getElementById('msg-history');
  if (!box) return;
  // 발송 확정(접수→도달 확인)은 1~3분 걸린다 — 배지는 자동 갱신되지 않으므로 새로고침 버튼 제공.
  const headHtml = (note) => `
    <div style="display:flex;align-items:baseline;gap:8px;margin-bottom:6px;">
      <span style="font-weight:600;font-size:13.5px;">최근 발송 내역</span>
      <span style="font-size:11.5px;color:#999;" title="알림톡 본문은 개인정보 보존기간(발송 후 7일)까지 표시됩니다">${note}</span>
      <button type="button" id="msg-hist-refresh" title="발송 상태는 확정까지 1~3분 걸립니다"
        style="margin-left:auto;font-size:11.5px;padding:1px 10px;border:1px solid #dde3e8;border-radius:12px;background:#fff;color:#4a5560;cursor:pointer;">새로고침</button>
    </div>`;
  const bindRefresh = () =>
    document.getElementById('msg-hist-refresh')?.addEventListener('click', () => loadHistory(studentId));
  box.innerHTML = headHtml('불러오는 중…');
  try {
    const { items } = await getRecipientMessageHistory({ studentId, limit: HISTORY_LIMIT });
    if (_currentStudentId !== studentId) return;
    if (!items || !items.length) {
      box.innerHTML = headHtml('발송 내역 없음');
      bindRefresh();
      return;
    }
    const capNote = items.length >= HISTORY_LIMIT ? ` (최근 ${HISTORY_LIMIT}건)` : '';
    box.innerHTML = `
      ${headHtml(`${items.length}건${capNote} · 본문 7일 보관`)}
      <div style="max-height:320px;overflow-y:auto;padding-right:2px;">${items.map(renderHistoryItem).join('')}</div>`;
    bindRefresh();
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
    if (_currentStudentId !== studentId) return;
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
      `<button type="button" class="btn msg-quick" data-action="${escAttr(q.label)}" style="background:#006241;color:#fff;padding:4px 11px;font-size:12.5px;" disabled>${esc(q.label)}</button>`,
    ).join('');
    form.innerHTML = `
      <div id="msg-quick-row" style="display:flex;align-items:center;gap:6px;flex-wrap:wrap;margin-bottom:8px;"
           title="태블릿을 찍지 않은 학생의 수동 처리 — 알림톡 발송과 함께 출결에도 기록됩니다">
        <span style="color:#555;font-size:12.5px;">등하원</span>
        <span id="msg-day-state" style="font-size:11px;font-weight:700;color:#5f6b76;background:#eef1f4;padding:2px 8px;border-radius:10px;">확인 중…</span>
        ${quickBtns}
        <span id="msg-absence-slot"></span>
      </div>
      <hr style="border:none;border-top:1px solid #eee;margin:0 0 8px;">
      <div style="display:flex;align-items:center;gap:8px;margin-bottom:6px;">
        <label for="msg-template" style="white-space:nowrap;font-size:12.5px;color:#555;margin:0;">안내 종류</label>
        <select id="msg-template" class="field-input" style="flex:1;margin:0;padding:5px 8px;font-size:13px;">${opts}</select>
      </div>
      <div id="msg-vars" style="display:grid;grid-template-columns:repeat(auto-fit,minmax(170px,1fr));gap:6px;"></div>
      <button type="button" id="msg-send" class="btn btn-primary" style="margin-top:8px;padding:6px 16px;" ${dis}>알림톡 발송</button>
    `;
    form.querySelectorAll('.msg-quick').forEach((b) =>
      b.addEventListener('click', () => sendQuickAttendance(studentId, b.dataset.action)));
    loadQuickState(studentId, readonly);
    const sel = document.getElementById('msg-template');
    const renderVars = () => {
      const def = NOTICE_TEMPLATES[sel.value];
      document.getElementById('msg-vars').innerHTML = def.vars.map((key) =>
        `<label style="display:flex;flex-direction:column;gap:2px;margin:0;font-size:12px;color:#666;">${esc(key)}
           <input type="text" class="field-input msg-var" data-key="${escAttr(key)}" style="margin:0;padding:5px 8px;font-size:13px;" ${dis}>
         </label>`,
      ).join('');
    };
    sel.addEventListener('change', () => {
      _noticeReqId = null;
      renderVars();
    });
    renderVars();
    document.getElementById('msg-vars').addEventListener('input', () => { _noticeReqId = null; });
    document.getElementById('msg-send').addEventListener('click', () => sendNotice(studentId, sel));
  } else if (_mode === 'free') {
    form.innerHTML = `
      <div style="font-size:12px;color:#999;margin-bottom:5px;">승인 템플릿이 없는 정보성 안내는 SMS/LMS로 발송합니다. 광고성은 '홍보' 모드를 사용하세요.</div>
      <textarea id="msg-content" class="field-input" aria-label="자유 안내 본문" rows="4" style="width:100%;box-sizing:border-box;margin:0;" placeholder="보낼 내용을 입력하세요." ${dis}></textarea>
      <button type="button" id="msg-send" class="btn btn-primary" style="margin-top:8px;padding:6px 16px;" ${dis}>문자 발송</button>
    `;
    document.getElementById('msg-content').addEventListener('input', () => { _freeReqId = null; });
    document.getElementById('msg-send').addEventListener('click', () => sendFree(studentId));
  } else {
    form.innerHTML = `
      <div style="font-size:12px;color:#999;margin-bottom:5px;">(광고) 표기와 무료수신거부 080 안내는 발송 시 자동으로 붙습니다</div>
      <textarea id="msg-content" class="field-input" aria-label="홍보 메시지 본문" rows="4" style="width:100%;box-sizing:border-box;margin:0;" placeholder="${escAttr(PROMO_PLACEHOLDER)}" ${dis}></textarea>
      <button type="button" id="msg-send" class="btn btn-primary" style="margin-top:8px;padding:6px 16px;" ${dis}>홍보 문자 발송</button>
    `;
    document.getElementById('msg-content').addEventListener('input', () => { _promoReqId = null; });
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
  if (_currentStudentId !== studentId) return;
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
    slot.innerHTML = `<span style="display:inline-flex;align-items:center;gap:3px;font-size:11.5px;font-weight:700;padding:3px 10px;border-radius:10px;background:${ok ? '#e6f4ea' : '#fff3e0'};color:${ok ? '#1e7e34' : '#b26a00'};">${msIcon(ok ? 'check_circle' : 'warning', '', 'style="font-size:1em;"')}${esc(label)}</span>`;
    return;
  }
  const canAbsence = !readonly && cand && beforeArrival;
  slot.innerHTML = `<button type="button" id="msg-absence-btn" class="btn"
      style="background:#b3261e;color:#fff;padding:4px 11px;font-size:12.5px;${canAbsence ? '' : 'opacity:.45;'}"
      ${canAbsence && !_quickBusy ? '' : 'disabled'}
      title="${canAbsence ? '' : '아직 등원하지 않은 학생에게만 보낼 수 있습니다'}">미등원 알림톡</button>`;
  document.getElementById('msg-absence-btn')?.addEventListener('click', () => sendAbsenceQuick(studentId, readonly));
}

// 등하원 수동 처리 — tabletCheckin 확정 호출(출결 기록 + 알림톡 enqueue가 서버 트랜잭션 하나).
// 상태머신·연타 멱등은 서버가 보장하므로 클라는 이중 클릭만 막는다.
async function sendQuickAttendance(studentId, actionLabel) {
  if (_quickBusy) return;
  const recipientFields = selectedRecipientFields('alimtalk');
  if (!recipientFields.length) { _deps.toast?.('알림톡 수신 대상을 선택하세요.', 'error'); return; }
  const student = _deps.getStudent?.(studentId) || {};
  _quickBusy = true;
  document.querySelectorAll('.msg-quick').forEach((b) => { b.disabled = true; });
  try {
    const res = await tabletCheckin({
      studentNumber: String(student.studentNumber ?? '').trim(),
      studentId, action: actionLabel, source: 'dsc', recipientFields,
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
  const recipientFields = selectedRecipientFields('alimtalk');
  if (!recipientFields.length) { _deps.toast?.('알림톡 수신 대상을 선택하세요.', 'error'); return; }
  const templateKey = sel.value;
  const variables = {};
  document.querySelectorAll('.msg-var').forEach((i) => { variables[i.dataset.key] = i.value.trim(); });
  if (!_noticeReqId) _noticeReqId = `notice_${studentId}_${Date.now()}`;
  const payload = { studentId, templateKey, variables, recipientFields, requestId: _noticeReqId };
  await doSend(
    () => sendParentNotice(payload),
    (res) => res?.channel === 'sms'
      ? `알림톡 대신 문자 ${res.splitParts}건 발송을 요청했습니다.`
      : '알림톡 발송을 요청했습니다.',
    () => { _noticeReqId = null; scheduleHistoryReload(studentId); },
    () => sendParentNotice({ ...payload, splitLongMessage: true }),
  );
}

async function sendPromo(studentId) {
  if (_sending) return;
  const recipientFields = selectedRecipientFields('sms');
  if (!recipientFields.length) { _deps.toast?.('문자 수신 대상을 선택하세요.', 'error'); return; }
  const raw = document.getElementById('msg-content').value.trim();
  if (!raw) { _deps.toast?.('본문을 입력하세요.', 'error'); return; }
  // (광고)·080 표기는 발송 직전 자동 보정(멱등) — 깜빡해도 법적 표기가 빠지지 않는다.
  const content = ensurePromoCompliance(raw);
  if (!_promoReqId) _promoReqId = `promo_${studentId}_${Date.now()}`;
  await doSend(
    () => createPromoCampaign({
      title: `개별홍보-${studentId}`, content, targeting: 'M',
      studentIds: [studentId], recipientFields, recipientField: recipientFields[0], requestId: _promoReqId,
    }),
    '홍보 문자 발송을 요청했습니다.',
    () => { _promoReqId = null; scheduleHistoryReload(studentId); },
  );
}

// 자유 안내(템플릿 없음) — SMS/LMS로 보낸다.
async function sendFree(studentId) {
  if (_sending) return;
  const recipientFields = selectedRecipientFields('sms');
  if (!recipientFields.length) { _deps.toast?.('문자 수신 대상을 선택하세요.', 'error'); return; }
  const content = document.getElementById('msg-content').value.trim();
  if (!content) { _deps.toast?.('내용을 입력하세요.', 'error'); return; }
  if (!_freeReqId) _freeReqId = `free_${studentId}_${Date.now()}`;
  const payload = {
    studentId, content, recipientFields, recipientField: recipientFields[0], requestId: _freeReqId,
  };
  await doSend(
    () => sendDailyReport(payload),
    (res) => res?.splitParts > 1
      ? `문자 ${res.splitParts}건으로 나누어 발송을 요청했습니다.`
      : '문자 발송을 요청했습니다.',
    () => { _freeReqId = null; scheduleHistoryReload(studentId); },
    () => sendDailyReport({ ...payload, splitLongMessage: true }),
  );
}

// onSuccess는 발송 성공 시에만 호출 — 멱등키를 비워 다음 발송에 새 키를 발급하게 한다.
async function doSend(fn, okMsg, onSuccess, retrySplit) {
  const btn = document.getElementById('msg-send');
  _sending = true;
  if (btn) btn.disabled = true;
  try {
    let res;
    try {
      res = await fn();
    } catch (err) {
      const details = err?.details;
      if (!retrySplit || !details?.canSplit) throw err;
      const split = confirm(
        `${err?.message || err}\n\n문자 ${details.splitParts}건으로 나누어 발송할까요?\n각 문자에 [1/${details.splitParts}]처럼 순서가 표시됩니다.\n취소하면 내용을 복사해 일반폰에서 보낼 수 있습니다.`,
      );
      if (!split) return;
      res = await retrySplit();
    }
    _deps.toast?.(typeof okMsg === 'function' ? okMsg(res) : okMsg, 'success');
    onSuccess?.();
  } catch (err) {
    _deps.toast?.(err?.message || '발송에 실패했습니다.', 'error');
  } finally {
    _sending = false;
    if (btn) btn.disabled = false;
  }
}
