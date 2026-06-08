/**
 * teacher-history.js — 강사 배정 변경 이력 (class_teacher_history) append-only 기록
 *
 * class_settings.teacher는 현재값만 보존하므로, 강사가 바뀌면 과거가 사라진다.
 * 지금부터 모든 반의 강사 배정 변경을 class_teacher_history에 append-only로 남겨
 * 향후 강사 재등원율 등 분석을 가능하게 한다. (forward-only, 과거 복구 불가)
 *
 * ⚠️ rules가 hasOnly로 9개 필드만 허용하므로 auditAdd 금지 (updated_by/updated_at 주입 → rules 거부).
 *    plain addDoc만 사용한다.
 */

import { addDoc, collection, serverTimestamp } from 'firebase/firestore';
import { db, auth } from './firebase-config.js';
import { state } from './state.js';
import { READ_ONLY, normalizeImpact7Email } from './audit.js';

function currentUserEmail() {
    return normalizeImpact7Email(auth.currentUser?.email || state.currentUser?.email || window._auditUser || '');
}

/**
 * 강사 배정 변경을 class_teacher_history에 기록한다.
 * 실제 변경이 있을 때만(teacher/sub_teacher가 prev와 다를 때) 기록하며,
 * 기록 실패가 강사 저장 UX를 깨지 않도록 try/catch로 감싼다.
 * 반드시 class_settings 저장이 성공한 뒤 호출할 것.
 *
 * @param {string} classKey class_settings 문서 키 (정규/특강은 반 코드, 내신은 csKey)
 * @param {object} payload
 * @param {string} [payload.class_type]       '정규'|'내신'|'특강'|'자유학기' 등, 모르면 ''
 * @param {string} [payload.branch]           소속, 못 구하면 ''
 * @param {string} [payload.teacher]          새 담당 이메일, 미지정이면 ''
 * @param {string} [payload.sub_teacher]      새 부담당, 없으면 ''
 * @param {string} [payload.prev_teacher]     이전 담당, 없으면 ''
 * @param {string} [payload.prev_sub_teacher] 이전 부담당, 없으면 ''
 */
export async function recordTeacherChange(classKey, {
    class_type = '',
    branch = '',
    teacher = '',
    sub_teacher = '',
    prev_teacher = '',
    prev_sub_teacher = '',
} = {}) {
    // 미변경(같은 값 재저장)이면 기록하지 않는다.
    if (teacher === prev_teacher && sub_teacher === prev_sub_teacher) return;

    const changed_by = currentUserEmail();
    if (!changed_by) return; // changed_by는 비어있으면 안 됨 (rules required) → 스킵

    if (READ_ONLY) {
        console.log('%c[READ-ONLY] recordTeacherChange 차단:', 'color:#92400e;font-weight:600;', classKey, { teacher, sub_teacher, prev_teacher, prev_sub_teacher });
        return;
    }

    try {
        await addDoc(collection(db, 'class_teacher_history'), {
            class_code: classKey,
            class_type,
            branch,
            teacher,
            sub_teacher,
            prev_teacher,
            prev_sub_teacher,
            changed_at: serverTimestamp(),
            changed_by,
        });
    } catch (err) {
        // 이력 기록 실패는 강사 저장 UX를 깨지 않게 흡수한다.
        console.warn('[recordTeacherChange] 이력 기록 실패:', err);
    }
}
