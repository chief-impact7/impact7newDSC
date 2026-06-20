// 기록 탭 데이터 I/O — Firestore(student_records) + Storage(파일 첨부).
import {
  collection, query, where, getDocs, doc, serverTimestamp,
} from 'firebase/firestore';
import { ref, uploadBytes, deleteObject } from 'firebase/storage';
import { db, storage } from './firebase-config.js';
import { auditSet, auditUpdate, auditDelete, READ_ONLY } from './audit.js';
import { toFileMeta } from './docu-records.js';

const COL = 'student_records';

export async function listStudentRecords(studentId) {
  const q = query(collection(db, COL), where('student_id', '==', studentId));
  const snap = await getDocs(q);
  return snap.docs.map(d => ({ id: d.id, ...d.data() }));
}

// 문서 쓰기 전에 id만 확보 — Storage 경로에 recordId를 쓰기 위함.
export function newRecordRef() {
  return doc(collection(db, COL));
}

// 파일 업로드 성공 후 마지막에 1회만 문서 기록(고아 객체·빈 문서 방지). 반환: 문서 id.
export async function createRecord(recordRef, studentId, type, { occurred_at, content, files = [] }) {
  await auditSet(recordRef, {
    student_id: studentId,
    type,
    occurred_at: occurred_at || '',
    content: content || '',
    files,
    created_at: serverTimestamp(),
  });
  return recordRef.id;
}

// 내용·일시(+선택적 files 병합)만 수정. audit이 updated_* 채움, READ_ONLY는 auditUpdate가 stub.
export async function updateRecord(recordId, { occurred_at, content, files }) {
  const data = { occurred_at: occurred_at || '', content: content || '' };
  if (files !== undefined) data.files = files;
  await auditUpdate(doc(db, COL, recordId), data);
}

export async function uploadRecordFile(studentId, recordId, file, index = 0) {
  // Storage 경로에는 정제된 파일명만 사용(원본명은 toFileMeta의 name에 보존).
  const safeName = String(file.name).replace(/[^\w.\-]/g, '_');
  const path = `student-records/${studentId}/${recordId}/${Date.now()}_${index}_${safeName}`;
  if (READ_ONLY) { console.log('[READ-ONLY] uploadRecordFile 차단:', path); return toFileMeta(file, path); }
  await uploadBytes(ref(storage, path), file);
  return toFileMeta(file, path);
}

// 부분 업로드 실패 롤백용 — 이미 업로드된 객체 정리.
export async function deleteRecordFiles(files) {
  for (const f of files || []) {
    if (READ_ONLY) { console.log('[READ-ONLY] deleteObject(롤백) 차단:', f.path); continue; }
    try { await deleteObject(ref(storage, f.path)); }
    catch (err) { console.warn('[docu] 롤백 파일 삭제 실패(무시):', f.path, err); }
  }
}

// 반환: { failed: string[] } — 삭제 실패한 파일 경로(이미 없는 객체는 무시).
// 문서를 먼저 삭제한다 — 문서 삭제가 실패하면 파일은 건드리지 않아 정합성을 유지하고(throw),
// 성공 후 파일 삭제가 실패하면 고아 객체만 남아(failed로 반환) dangling 참조는 생기지 않는다. F-05.
export async function deleteRecord(record) {
  await auditDelete(doc(db, COL, record.id));
  const failed = [];
  for (const f of record.files || []) {
    if (READ_ONLY) { console.log('[READ-ONLY] deleteObject 차단:', f.path); continue; }
    try { await deleteObject(ref(storage, f.path)); }
    catch (err) {
      if (err?.code === 'storage/object-not-found') continue;
      console.warn('[docu] 파일 삭제 실패:', f.path, err);
      failed.push(f.path);
    }
  }
  return { failed };
}
