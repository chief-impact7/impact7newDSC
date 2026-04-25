# Firestore 감사 필드 자동 추가 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 모든 Firestore 쓰기 작업에 `updated_by` + `updated_at` 감사 필드를 자동 추가하고, 삭제 시 사전 로그를 남긴다.

**Architecture:** `audit.js` 모듈이 `updateDoc`/`setDoc`/`deleteDoc`을 감싸는 래퍼 함수를 제공한다. 현재 사용자 이메일은 `window._auditUser`에서 읽는다. 삭제 시에는 `audit_logs` 컬렉션에 삭제 전 스냅샷을 기록한다. 기존 코드의 직접 호출을 래퍼로 교체한다.

**Tech Stack:** Firebase Firestore, ES Modules

---

### Task 1: audit.js 모듈 생성

**Files:**
- Create: `audit.js`

- [ ] **Step 1: audit.js 파일 생성**

```javascript
import { updateDoc, setDoc, deleteDoc, addDoc, doc, collection, getDoc, serverTimestamp, writeBatch } from 'firebase/firestore';
import { db } from './firebase-config.js';

function _auditFields() {
    const email = window._auditUser || 'unknown';
    return { updated_by: email, updated_at: serverTimestamp() };
}

// updateDoc 래퍼: data에 감사 필드 자동 추가
export async function auditUpdate(ref, data) {
    return updateDoc(ref, { ...data, ..._auditFields() });
}

// setDoc 래퍼: data에 감사 필드 자동 추가 (merge 옵션 지원)
export async function auditSet(ref, data, options) {
    return setDoc(ref, { ...data, ..._auditFields() }, options || {});
}

// addDoc 래퍼: data에 감사 필드 자동 추가
export async function auditAdd(collectionRef, data) {
    return addDoc(collectionRef, { ...data, ..._auditFields() });
}

// deleteDoc 래퍼: 삭제 전 audit_logs에 스냅샷 기록
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

// writeBatch 헬퍼: batch.update에 감사 필드 추가
export function batchUpdate(batch, ref, data) {
    batch.update(ref, { ...data, ..._auditFields() });
}

// writeBatch 헬퍼: batch.set에 감사 필드 추가
export function batchSet(batch, ref, data, options) {
    batch.set(ref, { ...data, ..._auditFields() }, options || {});
}
```

- [ ] **Step 2: 빌드 확인**

Run: `npm run build`
Expected: 빌드 성공

- [ ] **Step 3: 커밋**

```bash
git add audit.js
git commit -m "feat: audit.js — Firestore 감사 필드 자동 추가 래퍼 모듈"
```

---

### Task 2: daily-ops.js에 window._auditUser 설정 + audit.js import

**Files:**
- Modify: `daily-ops.js`

- [ ] **Step 1: import 추가**

`daily-ops.js` 상단 import 블록에 추가:
```javascript
import { auditUpdate, auditSet, auditAdd, auditDelete, batchUpdate, batchSet } from './audit.js';
```

- [ ] **Step 2: window._auditUser 설정**

`onAuthStateChanged` 콜백에서 `currentUser` 설정 직후에 추가:
```javascript
window._auditUser = user?.email || null;
```
로그아웃 시에도:
```javascript
window._auditUser = null;
```

- [ ] **Step 3: 빌드 확인**

Run: `npm run build`
Expected: 빌드 성공

- [ ] **Step 4: 커밋**

```bash
git add daily-ops.js
git commit -m "feat: daily-ops.js에 audit.js import 및 _auditUser 설정"
```

---

### Task 3: daily-ops.js — 감사 필드 없는 updateDoc/setDoc 교체

**Files:**
- Modify: `daily-ops.js`

이 태스크는 감사 필드가 **없는** Firestore 쓰기 호출을 래퍼로 교체한다.
이미 `updated_by`/`updated_at`이 있는 호출도 래퍼로 교체하되, 수동 `updated_by`/`updated_at`은 제거한다 (래퍼가 자동 추가).

**교체 원칙:**
- `updateDoc(ref, data)` → `auditUpdate(ref, data)` (data에서 `updated_by`, `updated_at` 제거)
- `setDoc(ref, data, { merge: true })` → `auditSet(ref, data, { merge: true })` (동일)
- `addDoc(collection, data)` → `auditAdd(collection, data)` (data에서 `created_by` → 유지, `updated_by`/`updated_at` 제거)
- `deleteDoc(ref)` → `auditDelete(ref)`
- `batch.update(ref, data)` → `batchUpdate(batch, ref, data)`
- `batch.set(ref, data)` → `batchSet(batch, ref, data)`

**주의사항:**
- `created_by`, `created_at` 필드는 제거하지 않는다 (생성 시점 기록은 별도 의미)
- `completed_by`, `completed_at`, `cancelled_by`, `cancelled_at` 등 비즈니스 상태 필드도 유지한다
- `updated_by`, `updated_at`만 제거한다 (래퍼가 자동 추가하므로)

- [ ] **Step 1: 감사 필드 없는 호출들을 래퍼로 교체**

대상 (감사 필드 없는 호출):
- teachers 컬렉션 setDoc (line ~308)
- temp_class_overrides updateDoc (line ~602)  
- syncTaskStudentNames 내 updateDoc들 (line ~722)
- absence_records updateDoc (line ~856)
- students updateDoc — enrollment 저장 (line ~8175, ~10940)
- temp_attendance updateDoc들 (line ~7022, ~10395, ~10417, ~10651)
- temp_attendance addDoc (line ~10684)
- absence_records setDoc (line ~7144)
- retake_schedule updateDoc들 (line ~7490, ~7512)
- leave_requests updateDoc들 (line ~7757, ~7809, ~7904)
- leave_requests addDoc (line ~8003)
- hw_fail_tasks updateDoc들 (line ~5131, ~5152)
- test_fail_tasks updateDoc들 (line ~5131, ~5152)
- students updateDoc — return_consult_note (line ~4622)
- daily_records setDoc (line ~6979)
- user_settings setDoc (line ~8215)

- [ ] **Step 2: 감사 필드 있는 호출들도 래퍼로 통일**

대상 (이미 updated_by/updated_at 있는 호출):
- class_next_hw setDoc (line ~350) — `updated_by`, `updated_at` 제거
- daily_records setDoc들 (line ~886, ~958, ~4161, ~4184) — 동일
- absence_records updateDoc들 (line ~735, ~833) — 동일

각 호출에서 수동 `updated_by: currentUser.email, updated_at: serverTimestamp()` 제거 후 래퍼 사용.

- [ ] **Step 3: deleteDoc 교체**

- `deleteDoc(doc(db, 'temp_attendance', docId))` → `auditDelete(doc(db, 'temp_attendance', docId))`  (line ~5752)
- `deleteDoc(doc(db, 'absence_records', record.docId))` → `auditDelete(doc(db, 'absence_records', record.docId))` (line ~7172)

- [ ] **Step 4: batch 호출 교체**

- students batch.update들 → `batchUpdate(batch, ref, data)`
- temp_class_overrides batch.set → `batchSet(batch, ref, data)`
- hw_fail_tasks batch.set/update → `batchSet`/`batchUpdate`

- [ ] **Step 5: 빌드 확인**

Run: `npm run build`
Expected: 빌드 성공

- [ ] **Step 6: 커밋**

```bash
git add daily-ops.js
git commit -m "refactor: daily-ops.js — 모든 Firestore 쓰기를 audit 래퍼로 교체"
```

---

### Task 4: naesin.js — 감사 필드 추가

**Files:**
- Modify: `naesin.js`

- [ ] **Step 1: import 추가**

```javascript
import { auditUpdate, auditSet } from './audit.js';
```

기존 `import { updateDoc, doc } from 'firebase/firestore';`에서 `updateDoc` 제거.

- [ ] **Step 2: 5개 호출 교체**

1. `updateDoc(doc(db, 'students', studentId), { enrollments })` (editNaesinTime, line ~478) → `auditUpdate(...)`
2. `updateDoc(doc(db, 'students', studentId), { enrollments })` (toggleNaesinDay, line ~525) → `auditUpdate(...)`
3. `setDoc(doc(db, 'class_settings', csKey), { teacher }, { merge: true })` (saveNaesinClassTeacher, line ~651) → `auditSet(..., { merge: true })`
4. `setDoc(doc(db, 'class_settings', csKey), { [field]: value }, { merge: true })` (saveNaesinClassPeriod, line ~666) → `auditSet(..., { merge: true })`
5. `setDoc(doc(db, 'class_settings', csKey), { schedule }, { merge: true })` (saveNaesinClassSchedule, line ~689) → `auditSet(..., { merge: true })`

- [ ] **Step 3: 빌드 확인**

Run: `npm run build`
Expected: 빌드 성공

- [ ] **Step 4: 커밋**

```bash
git add naesin.js
git commit -m "refactor: naesin.js — Firestore 쓰기를 audit 래퍼로 교체"
```

---

### Task 5: app.js — 감사 필드 추가

**Files:**
- Modify: `app.js`

- [ ] **Step 1: import 추가**

```javascript
import { auditUpdate, auditSet, auditAdd } from './audit.js';
```

- [ ] **Step 2: window._auditUser 설정**

`onAuthStateChanged` 콜백에서 `currentUser` 설정 직후:
```javascript
window._auditUser = user?.email || null;
```

- [ ] **Step 3: 호출 교체**

- daily_checks setDoc (line ~647) → `auditSet` (수동 `updated_by`/`updated_at` 제거)
- postponed_tasks addDoc (line ~837) → `auditAdd` (`created_by`/`created_at` 유지, `updated_by`/`updated_at` 자동)
- postponed_tasks updateDoc들 (line ~868, ~884) → `auditUpdate` (수동 감사 필드 제거)

- [ ] **Step 4: 빌드 확인**

Run: `npm run build`
Expected: 빌드 성공

- [ ] **Step 5: 커밋**

```bash
git add app.js
git commit -m "refactor: app.js — Firestore 쓰기를 audit 래퍼로 교체"
```

---

### Task 6: 최종 검증 및 푸시

**Files:** 모든 파일

- [ ] **Step 1: 미교체 호출 잔존 확인**

감사 필드 없이 직접 호출하는 `updateDoc`/`setDoc`/`addDoc`/`deleteDoc`이 남아있는지 grep:
```bash
grep -n 'updateDoc\|setDoc\|addDoc\|deleteDoc' daily-ops.js naesin.js app.js | grep -v 'audit\|import\|from\|//'
```
Expected: 결과 없음 (모두 래퍼로 교체됨) 또는 읽기 전용 호출만 남음

- [ ] **Step 2: 전체 빌드**

Run: `npm run build`
Expected: 빌드 성공

- [ ] **Step 3: 커밋 & 푸시**

```bash
git push origin master
```
