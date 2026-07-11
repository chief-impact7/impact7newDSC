// 반 단체 안내(정보성) 인라인 발송 — 소속반 상세의 '메시지' 탭.
// message-card.js의 개별 발송과 독립. createBulkMessage(정보성)는 서버가 실제 발송하며
// BMS_FREE를 쓰지 않고 LMS/SMS로 큐잉한다. (광고) 규정 대상 아님.

import { msIcon } from './ms-icon.js';
import { state } from './state.js';
import { esc, escAttr, showToast } from './ui-utils.js';
import { READ_ONLY } from './audit.js';
import { createBulkMessage } from './data-layer.js';
import { getRegularClassStudents, getFreeSemesterClassStudents, getTeukangClassStudents, getNaesinStudentsByDerivedCode, _isNaesinClassCode } from './class-resolver.js';
import { onlyDigits } from './src/messages/message-format.js';

// 백엔드 recipientPhone.js의 RECIPIENT_FIELDS와 일치.
const RECIPIENT_OPTIONS = [
    { field: 'student', label: '학생', key: 'student_phone' },
    { field: 'parent_1', label: '학부모1', key: 'parent_phone_1' },
    { field: 'parent_2', label: '학부모2', key: 'parent_phone_2' },
    { field: 'other', label: '기타', key: 'other_phone' },
];

// 대량 발송 blast radius 제한 — 서버가 최종 검증하지만 클라 1차 방어(BulkSendCard와 동일 기준).
const BULK_CONFIRM_THRESHOLD = 30;
const BULK_MAX_RECIPIENTS = 500;

let _sending = false;
// 멱등키 — 응답 타임아웃 후 "같은 발송"의 재시도만 중복 차단. 발송 성공 시 재발급.
// 반·본문·수신대상이 달라지면 새 발송이므로 stale 키를 버린다 — 안 그러면 이전 반 발송이
// 서버 큐잉 성공+클라 타임아웃일 때 다음 반이 duplicate로 막혀 영구 잼(리뷰 #1).
let _reqId = null;
let _lastSendSig = null;

// 반 유형별 멤버 해석 — 소속 L4·반설정 양쪽에서 _classMgmtMode/class_type로 분기.
// 내신은 naesin_class_override 링크라 정규 로스터엔 안 잡혀 별도 조회가 필수(리뷰 #2·#3).
// 특강 반코드에 한글이 있어 _isNaesinClassCode 오탐 가능 → 특강을 먼저 판정.
export function resolveClassMembers(classCode) {
    if (state.classSettings[classCode]?.class_type === '특강' || state._classMgmtMode === 'teukang') return getTeukangClassStudents(classCode);
    if (state._classMgmtMode === 'naesin' || _isNaesinClassCode(classCode)) return getNaesinStudentsByDerivedCode(classCode).map(x => x.student);
    if (state._classMgmtMode === 'free') return getFreeSemesterClassStudents(classCode);
    return getRegularClassStudents(classCode);
}

// 소속반 상세의 '메시지' 탭 전체를 그린다 — 수신 대상 + 학생 체크리스트 + 본문 + 발송.
// onSnapshot 재렌더가 와도 작성 중이던 본문·체크 상태를 읽어 두었다가 복원한다.
export function renderClassBulkMessageTab(classCode) {
    const el = document.getElementById('message-tab');
    if (!el) return;

    // 같은 반의 재렌더(onSnapshot 등)에서만 작성 중 상태를 이월한다. 다른 반으로 전환됐거나
    // 직전이 학생 개인 메시지였다면 이월하지 않는다 — 반 간 초안 유출·전체체크 해제를 막는다(리뷰 확인).
    const sameClass = el.dataset.bulkClassCode === classCode;
    const prevBody = sameClass ? el.querySelector('#class-bulk-content')?.value : undefined;
    const prevRecipients = sameClass && el.querySelector('.class-bulk-recipient')
        ? new Set([...el.querySelectorAll('.class-bulk-recipient')].filter(c => c.checked).map(c => c.value))
        : null;
    const prevStudents = sameClass && el.querySelector('.class-bulk-student')
        ? new Set([...el.querySelectorAll('.class-bulk-student')].filter(c => c.checked).map(c => c.value))
        : null;

    const members = resolveClassMembers(classCode)
        .slice()
        .sort((a, b) => (a.name || '').localeCompare(b.name || '', 'ko'));
    // 번호가 있는 대상 필드만 노출 — 반 멤버 중 한 명이라도 그 번호가 있으면 선택 가능.
    const available = RECIPIENT_OPTIONS.filter(o => members.some(s => onlyDigits(s[o.key])));
    const dis = READ_ONLY ? 'disabled' : '';
    // 연락처가 있는 대상이 하나도 없으면 본문·발송 컨트롤을 비활성 (READ_ONLY도 동일)
    const controlDisabled = available.length ? dis : 'disabled';
    const defaultField = available.some(o => o.field === 'parent_1') ? 'parent_1' : available[0]?.field;

    const recipientChecks = available.map(o => {
        const checked = prevRecipients ? prevRecipients.has(o.field) : o.field === defaultField;
        return `<label style="display:inline-flex;align-items:center;gap:4px;margin:0;">
            <input type="checkbox" class="class-bulk-recipient" value="${escAttr(o.field)}" ${checked ? 'checked' : ''} ${dis}>
            ${esc(o.label)}
        </label>`;
    }).join('');

    const isChecked = (s) => prevStudents ? prevStudents.has(s.docId) : true;
    const studentRows = members.map(s => {
        const hasPhone = RECIPIENT_OPTIONS.some(o => onlyDigits(s[o.key]));
        return `<label style="display:flex;align-items:center;gap:6px;padding:4px 2px;border-bottom:1px solid var(--border);font-size:13px;margin:0;${hasPhone ? '' : 'opacity:.55;'}">
            <input type="checkbox" class="class-bulk-student" value="${escAttr(s.docId)}" ${isChecked(s) ? 'checked' : ''} ${dis}>
            <span>${esc(s.name)}</span>
            ${hasPhone ? '' : '<span style="font-size:11px;color:var(--text-sec);">연락처 없음</span>'}
        </label>`;
    }).join('');
    const allChecked = members.length > 0 && members.every(isChecked);

    el.innerHTML = `
        <div class="detail-card">
            <div class="detail-card-title">
                ${msIcon('campaign')}
                단체 안내
            </div>
            <div style="font-size:12px;color:var(--text-sec);margin-bottom:6px;">체크한 학생에게 정보성 안내를 보냅니다 (홍보 아님).</div>
            ${available.length
                ? `<div style="display:flex;flex-wrap:wrap;gap:10px;margin-bottom:6px;font-size:13px;">${recipientChecks}</div>`
                : '<div style="color:var(--danger);font-size:13px;margin-bottom:6px;">등록된 연락처가 없어 발송할 수 없습니다.</div>'}
            <div style="display:flex;align-items:center;justify-content:space-between;margin:8px 0 4px;">
                <span style="font-size:13px;font-weight:600;">학생 목록 (${members.length}명)</span>
                <label style="display:inline-flex;align-items:center;gap:4px;font-size:12px;margin:0;">
                    <input type="checkbox" ${allChecked ? 'checked' : ''} ${dis}
                        onchange="document.querySelectorAll('.class-bulk-student').forEach(c => { c.checked = this.checked; })">
                    전체 선택
                </label>
            </div>
            <div style="max-height:240px;overflow-y:auto;border:1px solid var(--border);border-radius:6px;padding:2px 8px;margin-bottom:8px;">
                ${studentRows || '<div class="detail-card-empty">학생 없음</div>'}
            </div>
            <textarea id="class-bulk-content" class="field-input" aria-label="단체 안내 본문" rows="4"
                style="width:100%;box-sizing:border-box;margin:0;" placeholder="보낼 내용을 입력하세요." ${controlDisabled}></textarea>
            <button type="button" id="class-bulk-send" class="btn btn-primary btn-sm" style="margin-top:8px;"
                onclick="sendClassBulkMessage('${escAttr(classCode)}')" ${controlDisabled}>발송</button>
        </div>`;

    // 이 pane이 어느 반의 단체 안내인지 기록 — 다음 렌더가 같은 반인지 판별해 이월 여부를 정한다.
    el.dataset.bulkClassCode = classCode;

    if (prevBody) {
        const ta = el.querySelector('#class-bulk-content');
        if (ta) ta.value = prevBody;
    }
}

export async function sendClassBulkMessage(classCode) {
    if (_sending) return;
    if (READ_ONLY) { showToast('READ-ONLY 모드에서는 발송할 수 없습니다.'); return; }

    const recipientFields = [...document.querySelectorAll('.class-bulk-recipient')]
        .filter(el => el.checked).map(el => el.value);
    if (!recipientFields.length) { showToast('수신 대상을 선택하세요.'); return; }

    const content = (document.getElementById('class-bulk-content')?.value || '').trim();
    if (!content) { showToast('보낼 내용을 입력하세요.'); return; }

    // 학생 체크리스트에서 체크된 학생만 발송 대상.
    const studentChecks = [...document.querySelectorAll('.class-bulk-student')];
    const checkedIds = new Set(studentChecks.filter(el => el.checked).map(el => el.value));
    if (studentChecks.length && !checkedIds.size) { showToast('보낼 학생을 선택하세요.'); return; }

    // 선택 수신 대상 중 하나라도 번호가 있는 학생만 — 서버도 번호 없는 대상은 건너뛰지만 클라에서 미리 집계.
    const keys = recipientFields.map(f => RECIPIENT_OPTIONS.find(o => o.field === f)?.key).filter(Boolean);
    const members = resolveClassMembers(classCode)
        .filter(s => !studentChecks.length || checkedIds.has(s.docId));
    const studentIds = members.filter(s => keys.some(k => onlyDigits(s[k]))).map(s => s.docId);

    if (!studentIds.length) { showToast('선택한 학생·수신 대상에 등록된 연락처가 없습니다.'); return; }
    if (studentIds.length > BULK_MAX_RECIPIENTS) {
        showToast(`한 번에 최대 ${BULK_MAX_RECIPIENTS}명까지 발송할 수 있습니다 (현재 ${studentIds.length}명).`);
        return;
    }
    if (studentIds.length >= BULK_CONFIRM_THRESHOLD &&
        !confirm(`${classCode} 반 ${studentIds.length}명에게 단체 안내를 발송합니다.\n계속하시겠습니까?`)) {
        return;
    }

    // 발송 서명이 이전과 다르면(다른 반/본문/대상/학생 선택) 새 발송 → stale 멱등키 폐기 후 재발급.
    const sig = `${classCode}\u0000${content}\u0000${recipientFields.join(',')}\u0000${studentIds.slice().sort().join(',')}`;
    if (sig !== _lastSendSig) { _reqId = null; _lastSendSig = sig; }
    if (!_reqId) _reqId = `classbulk_${classCode}_${Date.now()}`;
    _sending = true;
    const btn = document.getElementById('class-bulk-send');
    if (btn) btn.disabled = true;
    try {
        const res = await createBulkMessage({
            title: `반 단체 안내-${classCode}`,
            content,
            studentIds,
            recipientFields,
            requestId: _reqId,
        });
        if (res?.duplicate) {
            showToast('이미 발송된 요청입니다.');
        } else {
            const s = res?.stats || {};
            const parts = [`${s.queued ?? studentIds.length}건`];
            if (s.deduped) parts.push(`중복번호 ${s.deduped} 합침`);
            if (s.skipped_no_phone) parts.push(`번호없음 ${s.skipped_no_phone}`);
            showToast('단체 안내 발송 접수 — ' + parts.join(' · '));
            _reqId = null; // 성공 시 다음 발송에 새 멱등키 발급
            const contentEl = document.getElementById('class-bulk-content');
            if (contentEl) contentEl.value = '';
        }
    } catch (err) {
        showToast(err?.message || '발송에 실패했습니다.');
    } finally {
        _sending = false;
        if (btn) btn.disabled = false;
    }
}
