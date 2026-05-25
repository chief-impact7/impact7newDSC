// ─── 수업이력 카드 (비활성 학생 전용) ────────────────────────────────────
// DB(impact7DB) app.js 의 `_classifyHistory` / `renderHistory` 와 **동일한 분류·표시**를
// 그대로 사용한다. 일선 교사는 DB와 DSC를 같은 화면으로 인식하므로, 비원생 수업이력도
// DB와 똑같이 7종(신규/휴원/복귀/퇴원/재등원/전반/수업추가) + `이전 → 이후` 형식으로 보여준다.
// (DB app.js 와 로직이 갈라지지 않도록 변경 시 양쪽을 함께 수정할 것.)

import { collection, query, where, orderBy, limit, getDocs } from 'firebase/firestore';
import { db } from './firebase-config.js';
import { esc } from './ui-utils.js';

// history before/after에서 상태·반코드·휴원시작일을 best-effort로 추출.
// 형태: "상태:재원, 반:A101, 요일:월,금" | {"status":"재원","pause_start_date":"..."} | 단독 상태문자열("재원").
function _parseStatusClass(text) {
    if (typeof text !== 'string') return { status: '', classes: '', pauseStart: '' };
    const t = text.trim();
    if (!t || t === '—') return { status: '', classes: '', pauseStart: '' };
    if (t.startsWith('{')) {
        try {
            const o = JSON.parse(t);
            return { status: o.status || '', classes: '', pauseStart: o.pause_start_date || '' };
        } catch { /* JSON 아니면 아래 파싱 */ }
    }
    const STATUSES = ['상담', '등원예정', '재원', '실휴원', '가휴원', '퇴원'];
    // "상태:.." (편집 저장 포맷) 또는 "status:.." (일괄 import 포맷) 둘 다 인식
    const mStatus = t.match(/상태[:\s]*([^,]+)/) || t.match(/(?:^|,\s*)status:\s*([^,]+)/);
    if (mStatus) {
        const cls = (t.match(/반[:\s]*([^,]*?)(?:,\s*요일|$)/)?.[1] || '').trim();
        const pause = (t.match(/pause_start_date:\s*([^,]*)/)?.[1] || '').trim();
        return { status: mStatus[1].trim(), classes: cls === '—' ? '' : cls, pauseStart: pause };
    }
    if (STATUSES.includes(t)) return { status: t, classes: '', pauseStart: '' };
    return { status: '', classes: '', pauseStart: '' };
}

// 작성자 표시: 이메일은 @ 앞부분만, 자동전환·시스템·미상은 'system'.
function _shortAuthor(id) {
    return typeof id === 'string' && id.includes('@') ? id.split('@')[0] : 'system';
}

// 종류별 뱃지 색 (초록=긍정/등록, 파랑=중립 변경, 빨강=퇴원)
const HISTORY_BADGE = {
    '신규': 'badge-enroll', '복귀': 'badge-enroll', '재등원': 'badge-enroll', '수업추가': 'badge-enroll',
    '전반': 'badge-update', '휴원': 'badge-update', '퇴원': 'badge-withdraw',
};

// 수업이력을 7종(신규/휴원/복귀/퇴원/재등원/전반/수업추가)으로만 분류 — 일선 교사용.
// 상태 전이·휴원기간·반이동·수업추가만 노출하고 그 외(요일변경·자동활성화 등)는 숨김.
// STATUS_CHANGE는 UPDATE와 쌍으로 기록되는 중복 로그이므로 무시.
// impact7DB app.js 의 _classifyHistory 와 동일 로직 — 한쪽 수정 시 양쪽 동기화할 것.
function _classifyHistory(log) {
    const t = log.change_type;
    if (t === 'STATUS_CHANGE' || t === 'DELETE' || t === 'PROMOTION') return null;

    const { status: bS, classes: bC, pauseStart: bP } = _parseStatusClass(log.before);
    const { status: aS, classes: aC, pauseStart: aP } = _parseStatusClass(log.after);
    const LEAVE = ['실휴원', '가휴원'];
    const afterText = typeof log.after === 'string' ? log.after : '';
    const combined = `${typeof log.before === 'string' ? log.before : ''} ${afterText}`;

    // 신규 등록 (상태 텍스트 없는 import 로그는 '등록'만 — 가짜 '등원예정' 박지 않음)
    if (t === 'ENROLL') return { label: '신규', from: '', to: aS || '등록' };
    // 퇴원생 "첫데이터 재입력 + 수업 추가" = 재등원 (수업 추가 없는 단순 재입력은 상태 불변이므로 숨김)
    if (bS === '퇴원' && combined.includes('재입력') && combined.includes('수업') && combined.includes('추가')) {
        return { label: '재등원', from: '퇴원', to: '재원' };
    }

    // 퇴원 (WITHDRAW: status JSON 또는 "종강→퇴원" 서술형 모두 포함)
    if (t === 'WITHDRAW') return { label: '퇴원', from: bS || '재원', to: '퇴원' };

    // 상태 전이 기반
    if (aS) {
        if (bS === '퇴원' && (aS === '재원' || aS === '등원예정')) return { label: '재등원', from: '퇴원', to: aS };
        if (LEAVE.includes(bS) && aS === '재원') return { label: '복귀', from: bS, to: '재원' };
        if (LEAVE.includes(aS) && !LEAVE.includes(bS)) return { label: '휴원', from: bS || '재원', to: aS };
        if (aS === '퇴원' && bS !== '퇴원') return { label: '퇴원', from: bS || '재원', to: '퇴원' };
        if ((bS === '' || bS === '상담') && (aS === '등원예정' || aS === '재원')) return { label: '신규', from: '', to: aS };
    }

    // 휴원기간(pause_start_date) 기반 — status는 활성 유지하고 휴원 날짜만 변하는 예약 휴원/복귀 경로.
    // 이미 휴원 상태에서 날짜만 바뀐 로그는 휴원/복귀로 오판하지 않도록 가드.
    if (!bP && aP && !LEAVE.includes(bS)) return { label: '휴원', from: bS || '재원', to: '휴원' };
    if (bP && !aP && (aS === '재원' || aS === '등원예정')) return { label: '복귀', from: '휴원', to: aS };

    // 수업 추가 ("추가: SP201 ... 총 N개 누적" — 수업추가 로그 시그니처. 코드 있을 때만)
    if (afterText.includes('추가:') && afterText.includes('누적')) {
        const added = afterText.match(/추가:\s*([A-Za-z]*\d+)/)?.[1];
        if (added) return { label: '수업추가', from: '', to: added };
    }

    // 전반: 상태 변화 없이 반코드 변경
    if (bC && aC && bC !== aC) return { label: '전반', from: bC, to: aC };

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
        .map(log => ({ log, cat: _classifyHistory(log) }))
        .filter(x => x.cat)
        // 연속된 동일 전이(같은 종류·이전·다음)는 중복 로그이므로 한 건으로 합침
        .filter((x, i, arr) => {
            const p = arr[i - 1]?.cat;
            return !(p && p.label === x.cat.label && p.from === x.cat.from && p.to === x.cat.to);
        });

    if (filtered.length === 0) {
        container.innerHTML = '<div class="detail-card-empty" style="padding:32px;text-align:center;">표시할 수업 이력이 없습니다.</div>';
        return;
    }

    const list = document.createElement('div');
    list.className = 'class-history-list';
    filtered.forEach(({ log, cat }) => {
        const ts = log.timestamp?.toDate ? log.timestamp.toDate() : null;
        const dateStr = ts
            ? `${String(ts.getMonth() + 1).padStart(2, '0')}/${String(ts.getDate()).padStart(2, '0')}`
            : '—';
        const change = cat.from ? `${cat.from} → ${cat.to}` : `→ ${cat.to}`;

        const item = document.createElement('div');
        item.className = 'history-item';
        item.innerHTML = `
            <span class="history-badge ${HISTORY_BADGE[cat.label]}">${esc(cat.label)}</span>
            <span class="history-change">${esc(change)}</span>
            <span class="history-meta">${esc(dateStr)} · ${esc(_shortAuthor(log.google_login_id))}</span>
        `;
        list.appendChild(item);
    });
    container.appendChild(list);
}
