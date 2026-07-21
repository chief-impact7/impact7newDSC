// AI 종합상태 뷰의 순수 로직 — 컴포넌트·Firestore 비의존 (node --test 대상).
// firestore-helpers.js는 firebase-config를 당기므로 여기서 import 금지.
import { enrollmentCode } from '../../../student-core.js';
import { staffLabel } from '@impact7/shared/staff-label';
import { teacherDisplayName } from '@impact7/shared/teacher-label';

export const STATUS_GROUPS = [
    { key: 'risk', label: '위험' },
    { key: 'caution', label: '주의' },
    { key: 'good', label: '양호' },
    { key: 'none', label: '미생성' },
];

export const STALE_DAYS = 30;

// good/risk 외 값은 caution — student-status-card STATUS_TONE 폴백과 동일.
export function summaryStatusKey(summary) {
    const s = summary?.status;
    return (s === 'good' || s === 'risk') ? s : 'caution';
}

// Firestore Timestamp | ISO string | Date → epoch ms (해석 불가 시 null)
export function generatedAtMs(value) {
    if (!value) return null;
    if (typeof value.toMillis === 'function') return value.toMillis();
    const ms = value instanceof Date ? value.getTime() : new Date(value).getTime();
    return Number.isNaN(ms) ? null : ms;
}

export function isStale(value, nowMs, days = STALE_DAYS) {
    const ms = generatedAtMs(value);
    return ms != null && nowMs - ms > days * 24 * 60 * 60 * 1000;
}

// class_settings 주담당(teacher)만 → 드롭다운 옵션.
// key = 이메일 로컬파트 소문자(@gw/@impact7 혼재 통합), name = HR english_name 우선(bd56042).
export function teacherOptions(classSettingsMap, staffByLocal) {
    const byKey = new Map();
    for (const [classCode, cs] of Object.entries(classSettingsMap || {})) {
        const email = cs?.teacher;
        if (!email) continue;
        const key = staffLabel(email).toLowerCase();
        if (!key) continue;
        if (!byKey.has(key)) {
            const name = staffByLocal?.get(key) || teacherDisplayName(staffLabel(email)) || staffLabel(email);
            byKey.set(key, { key, name, classCodes: new Set() });
        }
        byKey.get(key).classCodes.add(classCode);
    }
    return [...byKey.values()].sort((a, b) => a.name.localeCompare(b.name, 'ko'));
}

// 필터·검색 적용 후 상태별 그룹 생성. 그룹 내 이름 가나다순, 그룹 순서는 STATUS_GROUPS 고정.
export function buildGroups(students, summariesById, { allowedIds = null, teacherClassCodes = null, search = '' } = {}) {
    const kw = search.trim();
    const byStatus = { risk: [], caution: [], good: [], none: [] };
    for (const s of students) {
        if (allowedIds && !allowedIds.has(s.id)) continue;
        if (teacherClassCodes && !(s.enrollments || []).some(e => teacherClassCodes.has(enrollmentCode(e)))) continue;
        if (kw && !String(s.name || '').includes(kw)) continue;
        const summary = summariesById?.[s.id] || null;
        byStatus[summary ? summaryStatusKey(summary) : 'none'].push({ student: s, summary });
    }
    for (const list of Object.values(byStatus)) {
        list.sort((a, b) => String(a.student.name || '').localeCompare(String(b.student.name || ''), 'ko'));
    }
    return STATUS_GROUPS.map(g => ({ ...g, items: byStatus[g.key] }));
}

// 0이 아닌 카운트만 "라벨 N" 목록으로.
export function countParts(summary) {
    return [['결석', 'absence_count'], ['숙제미제출', 'hw_fail_count'], ['테스트미달', 'test_fail_count']]
        .filter(([, k]) => Number(summary?.[k]) > 0)
        .map(([label, k]) => `${label} ${Number(summary[k])}`);
}

export function gapLabel(summary) {
    if (!summary?.consultation_gap_warning) return '';
    const days = summary.consultation_gap_days;
    return days == null ? '상담기록 없음' : `상담공백 ${days}일`;
}
