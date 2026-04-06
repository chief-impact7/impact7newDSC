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
import { db } from './firebase-config.js';

function _auditFields() {
    const email = window._auditUser || 'unknown';
    return { updated_by: email, updated_at: serverTimestamp() };
}

export async function auditUpdate(ref, data) {
    return updateDoc(ref, { ...data, ..._auditFields() });
}

export async function auditSet(ref, data, options) {
    return setDoc(ref, { ...data, ..._auditFields() }, options || {});
}

export async function auditAdd(collectionRef, data) {
    return addDoc(collectionRef, { ...data, ..._auditFields() });
}

export async function auditDelete(ref) {
    try {
        const snap = await getDoc(ref);
        if (snap.exists()) {
            await addDoc(collection(db, 'audit_logs'), {
                action: 'delete',
                collection: ref.parent.id,
                doc_id: ref.id,
                data_before: snap.data(),
                deleted_by: window._auditUser || 'unknown',
                deleted_at: serverTimestamp()
            });
        }
    } catch (err) {
        console.warn('[auditDelete] 삭제 로그 기록 실패:', err);
    }
    return deleteDoc(ref);
}

export function batchUpdate(batch, ref, data) {
    batch.update(ref, { ...data, ..._auditFields() });
}

export function batchSet(batch, ref, data, options) {
    batch.set(ref, { ...data, ..._auditFields() }, options || {});
}
