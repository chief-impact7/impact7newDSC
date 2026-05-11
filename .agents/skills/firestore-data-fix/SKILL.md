---
name: firestore-data-fix
description: "프로덕션 Firestore 데이터 수작업 복구·조사 패턴. scripts/oneoff/에 check-X.mjs로 현재 상태 감사 + restore-X.mjs로 --dry 플래그·history_logs·batch atomic write 기반 복구를 체계적으로 수행. '유시우 복구해줘', '특정 학생 데이터 복구', '필드 수정 스크립트', 'Firestore 수동 수정', 'one-off 스크립트', '데이터 복구', 'DB 수정 스크립트', 'scripts/oneoff' 요청 시 반드시 이 스킬 사용. 후속: '다른 학생도 같은 방식', '복구 스크립트 템플릿', '더 이상 변경 말고 확인만' 요청 시에도 사용."
---

# Firestore Data Fix Pattern

프로덕션 Firestore 문서를 수동으로 감사·복구할 때 쓰는 2단계 패턴. 실수로 데이터를 손상시키지 않기 위해 **반드시 check → dry-run → execute 순으로 진행**한다.

## 언제 쓰는가

- 버그/사고로 단일 문서(학생 한 명, 반 하나 등)가 이상 상태가 됐을 때
- 스키마 변경으로 소수 문서만 마이그레이션이 필요할 때
- Cloud Function 실패로 stale 상태가 남은 문서를 정리해야 할 때
- 클라이언트 UI로는 접근 불가능한 필드를 수정해야 할 때

**쓰지 않는 경우:**
- 반복/자동 처리가 필요 → Cloud Function으로 설계
- 스키마 전체 마이그레이션 → 별도 마이그레이션 도구·계획 필요
- 클라이언트 UI로 가능한 작업 → UI 사용

## 실행 모드: 단일 런북 (파이프라인)

에이전트 불필요. Claude가 사용자와 대화하며 단계별로 수동 진행한다.

## 사전 조건

- `gcloud auth application-default login` 완료 (admin SDK용)
- `~/projects/impact7DB`에 `firebase-admin` 설치 (기존 `_check_*.cjs` 스크립트들 참고)
- 또는 현재 프로젝트에 firebase-admin이 devDep으로 있음 (impact7newDSC는 있음)

## 워크플로우

### Phase 0: 문제 확인

사용자가 "X 학생 데이터 이상해" 식으로 요청한다. 먼저 상황을 명확히:
- 어떤 문서인가? (컬렉션/ID)
- 무엇이 잘못됐나? (기대 vs 실제)
- 의도한 최종 상태는? (복구 목표)

### Phase 1: check 스크립트 작성·실행

`scripts/oneoff/check-{target}.mjs`를 작성하여 현재 상태를 Firestore에서 직접 읽어 출력한다.

**템플릿:**
```js
// 1회용: {target} 현재 상태 조사
import { initializeApp, applicationDefault } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';

initializeApp({ credential: applicationDefault(), projectId: 'impact7db' });
const db = getFirestore();

// 대상 문서 + 관련 보조 문서 조회
const snap = await db.collection('students').where('name', '==', NAME).get();
for (const doc of snap.docs) {
    const d = doc.data();
    console.log(`\n===== ${doc.ref.path} =====`);
    console.log(`status: ${d.status}`);
    console.log(`enrollments: ${JSON.stringify(d.enrollments, null, 2)}`);
    // ...필요한 필드 나열
}

// 관련 leave_requests, history_logs 등도 같이 출력하여 맥락 파악
```

**출력을 사용자와 공유**하여 진짜 이상 상태인지, 기대와 일치하는지 확인.

### Phase 2: 복구안 설계

check 결과와 사용자 목표를 바탕으로:
1. 어떤 필드를 어떻게 바꿀지 정의
2. 삭제할 필드 / 추가할 필드 / 덮어쓸 배열 명확히
3. `history_logs`에 남길 before/after 내용 결정
4. 사용자에게 텍스트로 설계안 공유 후 승인 받기

**승인 없이 Phase 3로 진행 금지.**

### Phase 3: restore 스크립트 작성 (--dry 기본)

`scripts/oneoff/restore-{target}.mjs`를 작성한다. 반드시 `--dry` 플래그로 프리뷰 기본, 실제 실행은 사용자가 `--dry` 제거 후 재실행.

**템플릿:**
```js
// 1회용: {target} 데이터 복구
// 실행:
//   node scripts/oneoff/restore-{target}.mjs --dry   # 프리뷰
//   node scripts/oneoff/restore-{target}.mjs         # 실제 실행

import { initializeApp, applicationDefault } from 'firebase-admin/app';
import { getFirestore, FieldValue } from 'firebase-admin/firestore';

const DRY = process.argv.includes('--dry');
initializeApp({ credential: applicationDefault(), projectId: 'impact7db' });
const db = getFirestore();

const ref = db.doc(`students/${STUDENT_ID}`);
const snap = await ref.get();
if (!snap.exists) { console.error('문서 없음'); process.exit(1); }
const before = snap.data();

// 현재 상태 출력
console.log('=== BEFORE ===');
console.log(JSON.stringify(before, null, 2));

// 복구 후 상태 구성
const update = {
    status: '재원',
    enrollments: [/* 새 배열 */],
    pause_start_date: FieldValue.delete(),
    withdrawal_date: FieldValue.delete(),
    updated_at: FieldValue.serverTimestamp(),
    updated_by: 'one-off-restore-script',
};

console.log('\n=== AFTER (예정) ===');
console.log(JSON.stringify(update, null, 2));

if (DRY) {
    console.log('\n[DRY-RUN] 실제 변경 없음. --dry 제거하고 재실행.');
    process.exit(0);
}

// atomic batch: 학생 + history_logs 동시 기록
const batch = db.batch();
batch.update(ref, update);
batch.set(db.collection('history_logs').doc(), {
    doc_id: STUDENT_ID,
    change_type: 'RESTORE',
    before: JSON.stringify({ /* 주요 필드만 */ }),
    after: JSON.stringify({ /* 주요 필드만 */ }),
    google_login_id: 'one-off-restore-script',
    timestamp: FieldValue.serverTimestamp(),
});
await batch.commit();
console.log('\n✓ 복구 완료.');
```

**필수 요소:**
- `--dry` 플래그 + 프리뷰 출력
- `FieldValue.delete()`로 명시적 필드 삭제
- `FieldValue.serverTimestamp()`로 audit 타임스탬프
- `history_logs`에 `RESTORE` change_type 기록 (복구 추적용)
- batch로 atomic 처리

### Phase 4: Dry-run 실행

```bash
node scripts/oneoff/restore-{target}.mjs --dry
```

출력을 사용자와 검토. 차이가 기대와 일치하는지 확인.

### Phase 5: 실제 실행

```bash
node scripts/oneoff/restore-{target}.mjs
```

완료 후 Phase 1의 check 스크립트를 다시 돌려 실제 반영되었는지 확인.

## 설계 원칙

1. **Idempotent**: 같은 스크립트를 두 번 실행해도 상태가 같아야 함 (이미 복구된 문서에 재실행 시 no-op 또는 안전한 업데이트만)
2. **Atomic**: 학생 문서 + history_logs를 batch로 묶어 부분 실패 방지
3. **Auditable**: `history_logs`에 `RESTORE` change_type + 실행자(`one-off-restore-script`) 기록
4. **Reversible**: before 상태를 history_logs에 JSON으로 남겨 필요 시 역복구 가능
5. **Scoped**: 한 스크립트는 한 도메인(학생 1명 또는 소수)만 다룸. 대량 마이그레이션은 별도 도구.

## 파일 위치

- 모든 스크립트는 `scripts/oneoff/` 하위에 둔다
- 커밋은 **선택적** (일회성이지만 향후 유사 복구의 참고 자료)
- `.gitignore`에 `scripts/oneoff/`가 있으면 그대로 두고 스크립트 보관만

## 에러 핸들링

| 상황 | 전략 |
|------|------|
| gcloud ADC 인증 만료 | `gcloud auth application-default login` 재실행 안내 |
| 문서 없음 | 스크립트 초기에 `snap.exists` 체크 후 중단 |
| batch 실패 | Firestore 에러 메시지 그대로 출력 + 원인 추적 안내 |
| dry-run 결과와 실제가 다름 | `FieldValue.delete()` 타이밍 등 확인 (하지만 이 경우는 드뭄) |

## 후속 작업

비슷한 복구가 다시 필요할 때:
- 기존 check/restore 스크립트를 복사 후 대상만 바꿔 재사용
- `scripts/oneoff/`의 과거 스크립트는 템플릿 역할 (삭제하지 말 것)

## 테스트 시나리오

### 정상 흐름 (유시우 복구 사례)
1. 사용자: "유시우 데이터 이상해, 복구해줘"
2. Phase 1: `check-yoosiwoo.mjs` 작성 → 현재 status=퇴원, enrollments에 내신만 남음 확인
3. Phase 2: 복구안 — status=재원, 정규 A101(월·금) + naesin_class_override="2단지양정중2B"
4. Phase 3: `restore-yoosiwoo.mjs --dry` 작성
5. Phase 4: dry-run 출력 검토 → 사용자 승인
6. Phase 5: 실제 실행 → history_logs에 RESTORE 기록
7. 재확인: `check-yoosiwoo.mjs` 재실행 → 복구 확인

### 에러 흐름
1. 사용자: "김철수 삭제해줘"
2. Phase 0: **거부** — students 컬렉션은 `allow delete: if false` 규칙. 복구 스킬이 아니라 퇴원 처리 UI를 통한 정상 경로 안내.
