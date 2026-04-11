// ─── UI Utilities ──────────────────────────────────────────────────────────
// daily-ops.js에서 추출한 순수 UI 유틸리티 함수들

import { state, OX_CYCLE } from './state.js';

// ─── HTML Escape ───────────────────────────────────────────────────────────
export const esc = (str) => {
    const d = document.createElement('div');
    d.textContent = str ?? '';
    return d.innerHTML;
};

// HTML 엔티티 디코딩 (&amp; → &, &#39; → ', &quot; → " 등)
export const decodeHtmlEntities = (str) => {
    if (!str) return str;
    const ta = document.createElement('textarea');
    ta.innerHTML = str;
    return ta.value;
};

// HTML 속성(특히 onclick 내부 문자열 리터럴)에서 안전하게 사용하기 위한 이스케이프
export const escAttr = (str) => {
    return esc(str).replace(/'/g, '&#39;').replace(/"/g, '&quot;');
};

// ─── Time Formatting ───────────────────────────────────────────────────────
export function formatTime12h(time24) {
    if (!time24) return '';
    const [h, m] = time24.split(':');
    const hour = parseInt(h);
    const h12 = hour === 0 ? 12 : hour > 12 ? hour - 12 : hour;
    return `${h12}:${m}`;
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
