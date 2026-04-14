/**
 * audit.js — Firestore 감사 필드 자동 추가 래퍼
 *
 * 모든 Firestore 쓰기에 updated_by + updated_at을 자동 추가한다.
 * 삭제 시에는 audit_logs 컬렉션에 삭제 전 스냅샷을 기록한다.
 *
 * 사용법:
 *   import { auditUpdate, auditSet, auditAdd, auditDelete, batchUpdate, batchSet } from './audit.js';
 *   await auditUpdate(ref, { field: value });  // updated_by, updated_at 자동 추가
 */

import { updateDoc, setDoc, deleteDoc, addDoc, getDoc, collection, serverTimestamp } from 'firebase/firestore';
import { db, auth } from './firebase-config.js';

// READ-ONLY DEV 모드: VITE_READ_ONLY=true일 때 모든 write를 console.log로 stub.
// production DB를 직격하는 dev 환경에서 실수로 일선 데이터를 건드리는 사고 방지.
// .env.development.local에 VITE_READ_ONLY=true 설정 시 활성화.
export const READ_ONLY = import.meta.env.DEV && import.meta.env.VITE_READ_ONLY === 'true';

if (READ_ONLY) {
    console.warn('%c🔒 READ-ONLY DEV MODE — Firestore write 차단됨', 'background:#fef3c7;color:#92400e;font-size:13px;font-weight:700;padding:4px 8px;border-radius:4px;');

    const _injectBanner = () => {
        if (document.getElementById('readonly-banner')) return;
        const banner = document.createElement('div');
        banner.id = 'readonly-banner';
        banner.textContent = '🔒 READ-ONLY DEV MODE — 저장 버튼은 동작하지만 Firestore에 쓰기는 차단됩니다 (.env: VITE_READ_ONLY)';
        banner.style.cssText = 'position:fixed;top:0;left:0;right:0;z-index:99999;background:#fef3c7;color:#92400e;font-size:12px;font-weight:700;text-align:center;padding:6px 12px;border-bottom:2px solid #f59e0b;font-family:system-ui,sans-serif;letter-spacing:0.2px;pointer-events:none;';
        document.body.appendChild(banner);
        document.body.style.paddingTop = '30px';
    };
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', _injectBanner);
    } else {
        _injectBanner();
    }
}

function _auditFields() {
    const email = auth.currentUser?.email || window._auditUser || 'unknown';
    return { updated_by: email, updated_at: serverTimestamp() };
}

function _stub(op, ref, data) {
    const path = ref?.path || ref?.id || '?';
    console.log(`%c[READ-ONLY] ${op} 차단:`, 'color:#92400e;font-weight:600;', path, data);
}

export async function auditUpdate(ref, data) {
    if (READ_ONLY) { _stub('auditUpdate', ref, data); return; }
    return updateDoc(ref, { ...data, ..._auditFields() });
}

export async function auditSet(ref, data, options) {
    if (READ_ONLY) { _stub('auditSet', ref, data); return; }
    return setDoc(ref, { ...data, ..._auditFields() }, options || {});
}

export async function auditAdd(collectionRef, data) {
    if (READ_ONLY) { _stub('auditAdd', collectionRef, data); return { id: '__readonly_stub__' }; }
    return addDoc(collectionRef, { ...data, ..._auditFields() });
}

export async function auditDelete(ref) {
    if (READ_ONLY) { _stub('auditDelete', ref, null); return; }
    try {
        const snap = await getDoc(ref);
        if (snap.exists()) {
            await addDoc(collection(db, 'audit_logs'), {
                action: 'delete',
                collection: ref.parent.id,
                doc_id: ref.id,
                data_before: snap.data(),
                deleted_by: auth.currentUser?.email || window._auditUser || 'unknown',
                deleted_at: serverTimestamp()
            });
        }
    } catch (err) {
        console.warn('[auditDelete] 삭제 로그 기록 실패:', err);
    }
    return deleteDoc(ref);
}

export function batchUpdate(batch, ref, data) {
    if (READ_ONLY) { _stub('batchUpdate', ref, data); return; }
    batch.update(ref, { ...data, ..._auditFields() });
}

export function batchSet(batch, ref, data, options) {
    if (READ_ONLY) { _stub('batchSet', ref, data); return; }
    batch.set(ref, { ...data, ..._auditFields() }, options || {});
}
