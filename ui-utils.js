// ─── UI Utilities ──────────────────────────────────────────────────────────
// daily-ops.js에서 추출한 순수 UI 유틸리티 함수들

import { state, OX_CYCLE } from './state.js';
// re-export 전용 구문(export {...} from)은 로컬 스코프에 바인딩하지 않는다 —
// 이 파일 안에서도 esc/escAttr를 쓰므로 반드시 import 후 export로 분리할 것.
import { esc, escAttr } from '@impact7/shared/html-escape';
import { formatTime12h, formatTime12hNoAmPm } from '@impact7/shared/datetime';
export { esc, escAttr };
export { formatTime12h, formatTime12hNoAmPm };

// HTML 엔티티 디코딩 (&amp; → &, &#39; → ', &quot; → " 등) — DOM 필요, 로컬 유지.
export const decodeHtmlEntities = (str) => {
    if (!str) return str;
    const ta = document.createElement('textarea');
    ta.innerHTML = str;
    return ta.value;
};

export function renderTime12hOptions(value = '16:00') {
    const normalized = value || '16:00';
    const slots = [
        ...Array.from({ length: 22 }, (_, idx) => {
            const totalMinutes = 12 * 60 + idx * 30;
            return `${String(Math.floor(totalMinutes / 60)).padStart(2, '0')}:${String(totalMinutes % 60).padStart(2, '0')}`;
        }),
        ...Array.from({ length: 6 }, (_, idx) => {
            const totalMinutes = 9 * 60 + idx * 30;
            return `${String(Math.floor(totalMinutes / 60)).padStart(2, '0')}:${String(totalMinutes % 60).padStart(2, '0')}`;
        }),
    ];
    const options = slots.includes(normalized) ? slots : [normalized, ...slots];
    return options.map(time => `<option value="${escAttr(time)}" ${time === normalized ? 'selected' : ''}>${esc(formatTime12h(time))}</option>`).join('');
}

export function renderTime12hSelect({ value = '16:00', dataAttr = '', className = '', style = '' } = {}) {
    return `<select class="field-input time12-select ${escAttr(className)}" ${dataAttr} style="${escAttr(style)}">
        ${renderTime12hOptions(value)}
    </select>`;
}

export function nowTimeStr() {
    const d = new Date();
    return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

// ─── OX Helpers ────────────────────────────────────────────────────────────
export function nextOXValue(current) {
    const idx = OX_CYCLE.indexOf(current || '');
    return OX_CYCLE[(idx + 1) % OX_CYCLE.length];
}

export function oxDisplayClass(value) {
    if (value === 'O') return 'ox-green';
    if (value === 'X') return 'ox-red';
    if (value === '△') return 'ox-yellow';
    return 'ox-empty';
}

export function oxChip(label, val) {
    return `<div class="hw-domain-item">
        <span class="hw-domain-label">${esc(label)}</span>
        <span class="hw-domain-ox readonly ${oxDisplayClass(val)}">${esc(val || '—')}</span>
    </div>`;
}

export function oxChipBtn(label, val, studentId, field) {
    return `<div class="hw-domain-item">
        <span class="hw-domain-label">${esc(label)}</span>
        <button class="hw-domain-ox ${oxDisplayClass(val)}" data-student="${escAttr(studentId)}" data-field="${field}" data-domain="${escAttr(label)}"
            onclick="event.stopPropagation(); toggleHwDomainOX('${escAttr(studentId)}', '${field}', '${escAttr(label)}')">${esc(val || '—')}</button>
    </div>`;
}

// ─── Attendance Toggle Helper ──────────────────────────────────────────────
export function _attToggleClass(status) {
    const d = status === '미확인' ? '등원전' : status;
    if (d === '출석') return { display: d, cls: 'active-present' };
    if (d === '지각') return { display: d, cls: 'active-late' };
    if (d === '결석') return { display: d, cls: 'active-absent' };
    return { display: d, cls: 'active-other' };
}

// ─── Visit Status Helpers ──────────────────────────────────────────────────
export function _toVisitStatus(rawStatus) {
    return rawStatus === '완료' ? '완료' : rawStatus === '기타' ? '기타' : '미완료';
}

export function _visitBtnStyles(status) {
    const cls = status === '완료' ? 'active-present' : status === '시행' ? 'active-present' : status === '기타' ? 'active-other' : '';
    const sty = (status === 'pending' || status === '미완료' || status === '미시행') ? 'color:var(--text-sec);border-color:var(--border);' : '';
    return { cls, sty: `padding:2px 10px;font-size:12px;min-width:auto;${sty}` };
}

export function _visitLabel(status, source) {
    if (source === 'temp') {
        if (status === 'pending' || status === '미완료') return '미시행';
        if (status === '완료') return '시행';
        return status; // '기타'
    }
    return status === 'pending' ? '미완료' : status;
}

// ─── Save Indicator ────────────────────────────────────────────────────────
export function showSaveIndicator(status) {
    const el = document.getElementById('save-indicator');
    const text = document.getElementById('save-text');
    if (state.saveIndicatorTimer) clearTimeout(state.saveIndicatorTimer);

    el.style.display = 'flex';
    el.className = 'save-indicator';

    if (status === 'saving') {
        text.textContent = '저장 중...';
    } else if (status === 'saved') {
        text.textContent = '저장 완료';
        el.classList.add('saved');
        state.saveIndicatorTimer = setTimeout(() => el.style.display = 'none', 1500);
    } else {
        text.textContent = '저장 실패';
        el.classList.add('error');
        state.saveIndicatorTimer = setTimeout(() => el.style.display = 'none', 3000);
    }
}

export const stripEmailDomain = (email) => (email || '').replace(/@(gw\.)?impact7\.kr$/, '');

// ─── Date/Timestamp Helpers (from daily-ops.js) ────────────────────────────
export function _stripYear(dateStr) {
    if (!dateStr) return '';
    return dateStr.replace(/^\d{4}-/, '');
}

export function _fmtTs(ts, includeTime = false) {
    if (!ts) return '';
    const d = ts.toDate ? ts.toDate() : new Date(ts);
    const base = `${d.getMonth()+1}/${d.getDate()}`;
    return includeTime
        ? `${base} ${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}`
        : base;
}

export function _isNoShow(t) {
    return t.type === '등원' && t.status === 'pending'
        && t.scheduled_date && t.scheduled_date < state.selectedDate;
}

// ─── Markdown Renderer ─────────────────────────────────────────────────────
export function renderMarkdown(md) {
    if (!md) return '<em>아직 AI 분석 전</em>';
    return esc(md)
        .replace(/\n{3,}/g, '\n\n')
        .replace(/\n\n(?=(?:[-*]|\d+\.|\*\*))/g, '\n')
        .replace(/^### (.+)$/gm, '<h5>$1</h5>')
        .replace(/^## (.+)$/gm, '<h4>$1</h4>')
        .replace(/^# (.+)$/gm, '<h3>$1</h3>')
        .replace(/\n/g, '<br>');
}

export function _renderRescheduleHistory(history) {
    if (!history || !Array.isArray(history) || history.length === 0) return '';
    const sorted = [...history].sort((a, b) => (b.rescheduled_at || '').localeCompare(a.rescheduled_at || ''));
    const items = sorted.map(h => {
        const prevLabel = `${_stripYear(h.prev_date)}${h.prev_time ? ' ' + formatTime12h(h.prev_time) : ''}`;
        const newLabel = `${_stripYear(h.new_date)}${h.new_time ? ' ' + formatTime12h(h.new_time) : ''}`;
        const reason = h.reason ? ` (${esc(h.reason)})` : '';
        const by = h.rescheduled_by ? ` by ${esc(h.rescheduled_by)}` : '';
        return `<div class="reschedule-history-item">${esc(prevLabel)} → ${esc(newLabel)}${reason}${by}</div>`;
    }).join('');
    return `<div class="reschedule-history">
        <div class="reschedule-history-title">재지정 이력</div>
        ${items}
    </div>`;
}

// ─── Toast Notification ────────────────────────────────────────────────────
export function showToast(message) {
    let container = document.querySelector('.toast-container');
    if (!container) {
        container = document.createElement('div');
        container.className = 'toast-container';
        document.body.appendChild(container);
    }
    const toast = document.createElement('div');
    toast.className = 'toast';
    toast.textContent = message;
    container.appendChild(toast);
    requestAnimationFrame(() => toast.classList.add('show'));
    setTimeout(() => {
        toast.classList.remove('show');
        toast.addEventListener('transitionend', () => toast.remove());
    }, 3000);
}
