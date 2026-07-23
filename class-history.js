// ─── 수업이력 카드 (비활성 학생 전용) ────────────────────────────────────
// 분류·표시 로직은 공유 모듈 @impact7/shared/history 를 import 한다 (DB app.js 와 동일 SSoT).
// 일선 교사는 DB와 DSC를 같은 화면으로 인식하므로, 비원생 수업이력도 7종
// (신규/휴원/복귀/퇴원/재등원/전반/수업추가) + `이전 → 이후` 형식으로 동일하게 보여준다.
// 분류 로직을 바꾸려면 공유 repo(impact7-shared)에서 고치고 양쪽에서 npm i 로 갱신.
//
// override 기반 내신/자유학기 합성: 마법사 표준 학생(정규+naesin_class_override)은
// history_logs에 내신 로그가 없어 수업이력에 안 뜬다. 공유 헬퍼 deriveClassPeriodHistory로
// enrollments+class_settings에서 파생 항목을 만들어 "수업추가" 형태로 합성한다 (DB와 동일 로직).

import { collection, query, where, orderBy, limit, getDocs } from 'firebase/firestore';
import { db } from './firebase-config.js';
import { esc } from './ui-utils.js';
import { msIcon } from './ms-icon.js';
import { classifyHistory, HISTORY_BADGE, shortAuthor } from '@impact7/shared/history';
import { deriveClassPeriodHistory } from '@impact7/shared/enrollment-derivation';
import { state } from './state.js';
import { findStudent, branchFromStudent, enrollmentCode, displayCodeFromCsKey } from './student-helpers.js';

// 수업이력 분류기(classifyHistory / HISTORY_BADGE / shortAuthor)는 공유 모듈로 이동:
// @impact7/shared/history — impact7DB·impact7newDSC 공통 SSoT. 분류 로직 수정은 그 repo에서.

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
        if (state.selectedStudentId !== studentId) return;
        const logs = [];
        snap.forEach(d => logs.push({ id: d.id, ...d.data() }));
        _renderClassHistory(logs, contentEl, _deriveCardItems(studentId, logs));
    } catch (e) {
        if (state.selectedStudentId !== studentId) return;
        console.error('[CLASS HISTORY]', e);
        const indexUrl = e.message?.match(/https:\/\/console\.firebase\.google\.com\/[^\s]+/)?.[0];
        const safeIndexUrl = indexUrl && /^https:\/\/console\.firebase\.google\.com\//.test(indexUrl) ? indexUrl : null;
        const hint = safeIndexUrl
            ? `<br><a href="${esc(safeIndexUrl)}" target="_blank" rel="noopener" style="color:var(--primary);font-size:0.85em;">${msIcon('arrow_forward', '', 'style="font-size:1em;"')} Firebase Console 에서 인덱스 생성</a>`
            : '';
        contentEl.innerHTML = `<div class="detail-card-empty" style="padding:32px;text-align:center;color:var(--danger);">이력 로드 실패: ${esc(e.message)}${hint}</div>`;
    }
}

// override 기반 내신/자유학기를 "수업추가" 형태 항목으로 파생 (공유 헬퍼, DB와 동일 로직).
// 로그에 같은 code의 수업추가가 이미 있으면 스킵 (헬퍼는 명시적 내신/자유학기 enrollment 있으면 파생 안 함).
function _deriveCardItems(studentId, logs) {
    const student = findStudent(studentId);
    if (!student) return [];
    const derived = deriveClassPeriodHistory(student.enrollments, state.classSettings, { enrollmentCode });
    if (derived.length === 0) return [];

    const branch = branchFromStudent(student);
    const loggedCodes = new Set(
        logs.map(log => classifyHistory(log))
            .filter(cat => cat && cat.label === '수업추가')
            .map(cat => cat.to)
    );

    return derived
        // 로그에 같은 code(원본 csKey 또는 표시코드)가 이미 있으면 중복 스킵
        .filter(d => !loggedCodes.has(d.code) && !loggedCodes.has(displayCodeFromCsKey(d.code, branch)))
        .map(d => ({
            label: '수업추가',
            change: `→ ${displayCodeFromCsKey(d.code, branch)}`,
            startDate: d.start_date,
        }));
}

// 'YYYY-MM-DD' → 'MM/DD' (표시용). 비어있으면 '—'.
function _shortDate(dateStr) {
    const m = /^\d{4}-(\d{2})-(\d{2})/.exec(dateStr || '');
    return m ? `${m[1]}/${m[2]}` : '—';
}

function _renderClassHistory(logs, container, derivedItems = []) {
    container.innerHTML = '';

    const filtered = logs
        .map(log => ({ log, cat: classifyHistory(log) }))
        .filter(x => x.cat)
        // 연속된 동일 전이(같은 종류·이전·다음)는 중복 로그이므로 한 건으로 합침
        .filter((x, i, arr) => {
            const p = arr[i - 1]?.cat;
            return !(p && p.label === x.cat.label && p.from === x.cat.from && p.to === x.cat.to);
        });

    // 로그 항목 + 파생 항목을 start_date(또는 timestamp) 기준 시간 역순으로 병합.
    const items = [
        ...filtered.map(({ log, cat }) => {
            const ts = log.timestamp?.toDate ? log.timestamp.toDate() : null;
            return {
                sortKey: ts ? ts.getTime() : 0,
                badgeClass: HISTORY_BADGE[cat.label],
                label: cat.label,
                change: cat.from ? `${cat.from} → ${cat.to}` : `→ ${cat.to}`,
                meta: `${ts ? `${String(ts.getMonth() + 1).padStart(2, '0')}/${String(ts.getDate()).padStart(2, '0')}` : '—'} · ${shortAuthor(log.google_login_id)}`,
            };
        }),
        ...derivedItems.map(d => ({
            sortKey: d.startDate ? new Date(`${d.startDate}T00:00:00`).getTime() : 0,
            badgeClass: HISTORY_BADGE[d.label],
            label: d.label,
            change: d.change,
            meta: `${_shortDate(d.startDate)} · 자동`,
        })),
    ].sort((a, b) => b.sortKey - a.sortKey);

    if (items.length === 0) {
        container.innerHTML = '<div class="detail-card-empty" style="padding:32px;text-align:center;">표시할 수업 이력이 없습니다.</div>';
        return;
    }

    const list = document.createElement('div');
    list.className = 'class-history-list';
    items.forEach(it => {
        const item = document.createElement('div');
        item.className = 'history-item';
        item.innerHTML = `
            <span class="history-badge ${it.badgeClass}">${esc(it.label)}</span>
            <span class="history-change">${esc(it.change)}</span>
            <span class="history-meta">${esc(it.meta)}</span>
        `;
        list.appendChild(item);
    });
    container.appendChild(list);
}
