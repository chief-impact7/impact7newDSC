/**
 * class-student-search.js — 반에 학생 추가하는 검색 카드 + 검색기.
 *
 * 특강(class-detail.js)과 내신(naesin.js)에서 공유. 로컬 allStudents + 리모트
 * _searchContactsDSC(퇴원/종강) 병합 조회, 200ms 디바운스, reqId 기반 stale 무시.
 *
 * 호출 규약 (onclick 핸들러 이름은 window에 노출되어 있어야 함):
 *   renderAddStudentCard({...})         — 카드 HTML 반환
 *   createStudentSearcher({...})(k, q)  — 검색 실행 (호출자가 window 핸들러로 감쌈)
 */

import { studentShortLabel, ACTIVE_STUDENT_STATUSES } from './src/shared/firestore-helpers.js';
import { _searchContactsDSC } from './past-search.js';

// daily-ops.js에서 window로 노출된 이스케이프 헬퍼
const _esc = (str) => window._esc(str);
const _escAttr = (str) => window._escAttr(str);

export function renderAddStudentCard({ key, idPrefix, searchHandlerName, footerText }) {
    return `
        <div class="detail-card">
            <div class="detail-card-title">
                <span class="material-symbols-outlined">person_add</span>
                학생 추가
            </div>
            <div class="domain-add-row">
                <input type="text" id="${idPrefix}-search" class="field-input"
                    placeholder="이름 또는 학교 검색" style="flex:1;"
                    oninput="window.${searchHandlerName}('${_escAttr(key)}', this.value)">
            </div>
            <div id="${idPrefix}-results" class="search-results-list" style="margin-top:8px;"></div>
            <div style="font-size:11px;color:var(--text-sec);margin-top:6px;">
                ${_esc(footerText)}
            </div>
        </div>
    `;
}

export function createStudentSearcher({ idPrefix, addHandlerName, getEnrolledIds, getAllStudents }) {
    let timer = null;
    let reqId = 0;

    function renderItem(key, s) {
        const docId = s.docId || s.id;
        const meta = [studentShortLabel(s), s.status].filter(Boolean).join(' · ');
        return `<div class="search-result-item" style="display:flex;justify-content:space-between;align-items:center;padding:8px;border-bottom:1px solid var(--border);cursor:pointer;"
                    onclick="window.${addHandlerName}('${_escAttr(key)}', '${_escAttr(docId)}')">
                    <div>
                        <div style="font-weight:600;">${_esc(s.name)}</div>
                        <div style="font-size:11px;color:var(--text-sec);">${_esc(meta)}</div>
                    </div>
                    <span class="material-symbols-outlined" style="font-size:18px;color:var(--primary);">add</span>
                </div>`;
    }

    async function doSearch(key, q) {
        const results = document.getElementById(`${idPrefix}-results`);
        if (!results) return;
        q = (q || '').trim().toLowerCase();
        if (!q) { results.innerHTML = ''; return; }

        const currentReqId = ++reqId;
        const enrolledIds = getEnrolledIds(key);

        const localItems = (getAllStudents() || []).filter(s => {
            if (!ACTIVE_STUDENT_STATUSES.has(s.status)) return false;
            if (enrolledIds.has(s.docId)) return false;
            const name = (s.name || '').toLowerCase();
            const school = (s.school || '').toLowerCase();
            return name.includes(q) || school.includes(q);
        });

        const renderCombined = (localList, pastList) => {
            const items = [...localList, ...pastList].slice(0, 30).map(s => renderItem(key, s));
            results.innerHTML = items.length === 0
                ? '<div style="font-size:12px;color:var(--text-sec);padding:8px;">검색 결과 없음</div>'
                : items.join('');
        };

        renderCombined(localItems.slice(0, 20), []);

        try {
            // 리모트(퇴원/종강) prefix 쿼리 — reqId가 바뀌면 stale로 폐기
            const remote = await _searchContactsDSC(q);
            if (currentReqId !== reqId) return;
            const pastItems = remote.filter(r => !enrolledIds.has(r.id)).slice(0, 10);
            renderCombined(localItems.slice(0, 20), pastItems);
        } catch (err) {
            console.debug(`[${idPrefix} remote search]`, err?.message || err);
        }
    }

    return function search(key, q) {
        clearTimeout(timer);
        timer = setTimeout(() => doSearch(key, q), 200);
    };
}
