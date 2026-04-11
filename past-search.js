// ─── 과거 학생 검색 ───────────────────────────────────────────────────────
// daily-ops.js에서 분리 (Phase 2-4)

import { collection, getDocs, query, where, limit } from 'firebase/firestore';
import { db } from './firebase-config.js';
import { state } from './state.js';
import { studentShortLabel, PAST_STUDENT_STATUSES } from './src/shared/firestore-helpers.js';
import { esc, escAttr } from './ui-utils.js';

// students에서 퇴원/종강 학생을 prefix 쿼리로 가져온다.
// (현재 활성 학생은 allStudents에 이미 들어있으므로 dedupe로 제외)
export async function _searchContactsDSC(term) {
    if (!term || term.length < 2) return [];
    const currentIds = new Set(state.allStudents.map(s => s.docId));
    const results = [];
    const seenIds = new Set();
    const addIfPast = (d) => {
        if (currentIds.has(d.id) || seenIds.has(d.id)) return;
        const data = d.data();
        if (!PAST_STUDENT_STATUSES.has(data.status)) return;
        results.push({ id: d.id, ...data });
        seenIds.add(d.id);
    };
    try {
        const nameSnap = await getDocs(query(
            collection(db, 'students'),
            where('name', '>=', term),
            where('name', '<=', term + '\uf8ff'),
            limit(50)
        ));
        nameSnap.forEach(addIfPast);
        if (/\d{3,}/.test(term)) {
            const phoneSnap = await getDocs(query(
                collection(db, 'students'),
                where('student_phone', '>=', term),
                where('student_phone', '<=', term + '\uf8ff'),
                limit(20)
            ));
            phoneSnap.forEach(addIfPast);
        }
    } catch (e) {
        console.warn('[searchPastStudents] 검색 실패:', e);
    }
    return results;
}

export function _renderPastContacts(pastContactResults, container) {
    const PAST_LIMIT = 50;
    const showAll = pastContactResults.length <= PAST_LIMIT;
    const visiblePast = showAll ? pastContactResults : pastContactResults.slice(0, PAST_LIMIT);
    const renderPastItem = (c) => {
        const phone = c.parent_phone_1 || c.student_phone || '';
        const last4 = phone.replace(/\D/g, '').slice(-4);
        const sub = [studentShortLabel(c), last4 ? `☎${last4}` : ''].filter(Boolean).join(' · ');
        return `<div class="list-item contact-item" style="cursor:pointer" onclick="window.openContactAsTemp('${escAttr(c.id)}')">
            <div class="item-info">
                <span class="item-title">${esc(c.name || '—')} <span class="tag-past">과거</span></span>
                <span class="item-desc">${esc(sub || '—')}</span>
            </div>
        </div>`;
    };
    let pastHtml = `<div class="leave-section-divider"><span>과거 학생 (${pastContactResults.length}명)</span></div>`;
    pastHtml += visiblePast.map(renderPastItem).join('');
    if (!showAll) {
        pastHtml += `<div class="list-item" style="justify-content:center;cursor:pointer;color:var(--primary)" onclick="window._showAllPastStudents()">
            <span>+ ${pastContactResults.length - PAST_LIMIT}명 더보기</span>
        </div>`;
    }
    container.insertAdjacentHTML('beforeend', pastHtml);
    if (!showAll) {
        window._showAllPastStudents = () => {
            const moreHtml = pastContactResults.slice(PAST_LIMIT).map(renderPastItem).join('');
            const btn = container.querySelector('[onclick="window._showAllPastStudents()"]');
            if (btn) btn.outerHTML = moreHtml;
        };
    }
}
