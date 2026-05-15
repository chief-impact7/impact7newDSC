// ─── 수업이력 카드 (비활성 학생 전용) ────────────────────────────────────
// DB의 app.js `_categorizeHistoryLog` / `renderHistory` 와 동일한 7-카테고리
// (첫등록 / 전반 / 휴원 / 퇴원 / 내신 / 자유학기 / 특강) 분류로
// `history_logs` 를 표시한다. 비활성 학생일 때 출결현황 탭의 콘텐츠를 대체.

import { collection, query, where, orderBy, limit, getDocs } from 'firebase/firestore';
import { db } from './firebase-config.js';
import { esc } from './ui-utils.js';

// JSON 문자열로 박힌 history before/after 를 사람이 읽을 한 줄로 요약.
function _summarizeHistoryText(text) {
    if (typeof text !== 'string') return '—';
    const trimmed = text.trim();
    if (!trimmed) return '—';
    if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) return text;
    try {
        const obj = JSON.parse(trimmed);
        if (Array.isArray(obj)) return `(배열 ${obj.length}건)`;
        if (obj.description) return obj.reason ? `${obj.description} [${obj.reason}]` : obj.description;
        if (obj.reason) return obj.reason;
        if (typeof obj.status !== 'undefined') return `상태: ${obj.status || '(없음)'}`;
        if (Array.isArray(obj.enrollments)) return `수업 ${obj.enrollments.length}건`;
        const entries = Object.entries(obj).filter(([, v]) => typeof v !== 'object');
        if (entries.length > 0 && entries.length <= 4) {
            return entries.map(([k, v]) => `${k}: ${v}`).join(', ');
        }
        return text;
    } catch {
        return text;
    }
}

// 7개 카테고리(첫등록/전반/휴원/퇴원/내신/자유학기/특강) 외 로그는 표시 대상에서 제외.
function _categorizeHistoryLog(log) {
    const t = log.change_type;
    const beforeText = typeof log.before === 'string' ? log.before : '';
    const afterText = typeof log.after === 'string' ? log.after : '';
    const combined = `${beforeText} ${afterText}`;

    if (combined.includes('first_registered')) {
        const prev = beforeText.match(/first_registered\s*:\s*([^,]*)/)?.[1].trim() || '';
        if (!prev || prev === '—') return { label: '첫등록', cls: 'badge-enroll' };
    }

    if (t === 'WITHDRAW' || t === 'RESTORE') return { label: '퇴원', cls: 'badge-withdraw' };
    if (t === 'RETURN' || t === 'LR_AMEND') return { label: '휴원', cls: 'badge-update' };

    if (t === 'STATUS_CHANGE') {
        try {
            const status = JSON.parse(afterText)?.status;
            if (status === '실휴원' || status === '가휴원') return { label: '휴원', cls: 'badge-update' };
            if (status === '퇴원') return { label: '퇴원', cls: 'badge-withdraw' };
        } catch { /* JSON 아닐 때 무시 */ }
        return null;
    }

    if (t === 'ENROLL' || t === 'UPDATE') {
        if (combined.includes('내신')) return { label: '내신', cls: 'badge-enroll' };
        if (combined.includes('자유학기')) return { label: '자유학기', cls: 'badge-enroll' };
        if (combined.includes('특강')) return { label: '특강', cls: 'badge-enroll' };
        const regularKeywords = ['정규', '신규 등록', '종강 처리', '반:', '추가:'];
        if (regularKeywords.some(k => combined.includes(k))) return { label: '전반', cls: 'badge-enroll' };
        return null;
    }

    return null;
}

export async function loadClassHistoryCard(studentId) {
    const contentEl = document.getElementById('report-content');
    if (!contentEl || !studentId) return;
    contentEl.innerHTML = '<div class="detail-card-empty" style="padding:32px;text-align:center;">로딩 중...</div>';

    try {
        const q = query(
            collection(db, 'history_logs'),
            where('doc_id', '==', studentId),
            orderBy('timestamp', 'desc'),
            limit(200)
        );
        const snap = await getDocs(q);
        const logs = [];
        snap.forEach(d => logs.push({ id: d.id, ...d.data() }));
        _renderClassHistory(logs, contentEl);
    } catch (e) {
        console.error('[CLASS HISTORY]', e);
        const indexUrl = e.message?.match(/https:\/\/console\.firebase\.google\.com\/[^\s]+/)?.[0];
        const safeIndexUrl = indexUrl && /^https:\/\/console\.firebase\.google\.com\//.test(indexUrl) ? indexUrl : null;
        const hint = safeIndexUrl
            ? `<br><a href="${esc(safeIndexUrl)}" target="_blank" rel="noopener" style="color:var(--primary);font-size:0.85em;">→ Firebase Console 에서 인덱스 생성</a>`
            : '';
        contentEl.innerHTML = `<div class="detail-card-empty" style="padding:32px;text-align:center;color:var(--danger);">이력 로드 실패: ${esc(e.message)}${hint}</div>`;
    }
}

function _renderClassHistory(logs, container) {
    container.innerHTML = '';
    if (logs.length === 0) {
        container.innerHTML = '<div class="detail-card-empty" style="padding:32px;text-align:center;">수업 이력이 없습니다.</div>';
        return;
    }
    const filtered = logs
        .map(log => ({ log, cat: _categorizeHistoryLog(log) }))
        .filter(x => x.cat);
    if (filtered.length === 0) {
        container.innerHTML = '<div class="detail-card-empty" style="padding:32px;text-align:center;">표시할 수업 이력이 없습니다.</div>';
        return;
    }

    const list = document.createElement('div');
    list.className = 'class-history-list';
    filtered.forEach(({ log, cat }) => {
        const ts = log.timestamp?.toDate ? log.timestamp.toDate() : null;
        const dateStr = ts
            ? ts.toLocaleString('ko-KR', { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })
            : '—';
        const beforeText = _summarizeHistoryText(log.before);
        const afterText = _summarizeHistoryText(log.after);
        const hasBefore = beforeText && beforeText !== '—';
        const item = document.createElement('div');
        item.className = 'history-item';
        item.innerHTML = `
            <div class="history-item-header">
                <span class="history-badge ${cat.cls}">${esc(cat.label)}</span>
                <span class="history-date">${esc(dateStr)}</span>
                <span class="history-author">${esc(log.google_login_id || '')}</span>
            </div>
            ${hasBefore ? `<div class="history-row"><span class="history-field-label">이전</span><span>${esc(beforeText)}</span></div>` : ''}
            <div class="history-row"><span class="history-field-label">내용</span><span>${esc(afterText || '—')}</span></div>
        `;
        list.appendChild(item);
    });
    container.appendChild(list);
}
