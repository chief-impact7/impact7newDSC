# 재등원·복귀 시 반 선택 + Cloud Function 서버사이드 이관

- **작성일**: 2026-04-21
- **저자**: 이종수 + Claude
- **범위**: impact7DB + impact7newDSC (Firestore 공유)
- **관련 사고**: 2026-04-21 유시우(양정중2) status=퇴원 잔류 사건 (DSC+DB 클라이언트 경합)

---

## 1. 배경

현재 `leave_requests` 승인 처리(`_finalizeLeaveDSC` / `_finalizeLeaveRequest`)가 두 가지 구조적 문제를 가진다.

### 문제 A — 재등원/복귀 모달에 "반 선택" UI가 없음

`submitReturnFromLeave`는 기존 class_codes만 캡처하고, `_finalizeLeave*`는 `status`만 변경한다. 퇴원 후 재등원할 때 원래 반(예: A101)이 폐강되었거나 요일이 바뀌어 다른 반(A102/A103)으로 가야 하는 케이스가 업무상 흔한데, 이 경로가 데이터 레벨에서 없다. 관리자는 재등원 승인 후 별도로 enrollment를 수동 편집해야 하고, 이 2단계 작업 사이에 경합/누락이 발생한다.

### 문제 B — 클라이언트 경합

DSC와 impact7DB 양쪽 모두 `_finalizeLeave*`를 **클라이언트 사이드**에서 실행한다. 한쪽에서 승인 처리를 하는 동안 다른 쪽 클라이언트가 같은 student 문서를 편집하면 마지막 쓰기가 이긴다. 2026-04-21 유시우 사고는 정확히 이 패턴으로, `RETURN` history_log가 기록된 후에도 최종 `status=퇴원`으로 되돌려진 채 남았다.

## 2. 목표

1. 재등원·복귀 모달에서 **들어갈 정규반을 드롭다운으로 선택**할 수 있다.
2. DSC·impact7DB **어느 쪽에서 승인을 눌러도 동일한 전이 로직**이 실행된다.
3. 두 클라이언트가 동시에 작업해도 **승인 이벤트당 단 한 번**의 student 전이가 원자적으로 보장된다.
4. 기존 휴원/퇴원/연장 유형도 동일 경로로 이관해 일관성을 확보한다.

## 3. 범위

### 포함
- 재등원·복귀 모달 UI 변경 (DSC + impact7DB)
- `leave_requests`의 모든 유형(휴원·퇴원·연장·재등원·복귀) 승인 전이를 Cloud Function으로 이관
- Firestore rules 업데이트 (신규 필드 허용, 관리용 필드는 admin SDK 전용)
- Firestore emulator 기반 단위 테스트

### 범위 밖
- 2026-04-21 유시우 데이터 복구 — 별도 one-off 스크립트로 처리
- 클라이언트의 `students` 컬렉션 write 전반 금지 — 이번 스펙은 휴퇴원 한정
- 다국어/UX 디테일 개선

## 4. 아키텍처

```
┌─────────────┐   ┌─────────────┐
│    DSC      │   │ impact7DB   │   (양쪽 동일 모달: 반 드롭다운 포함)
└──────┬──────┘   └──────┬──────┘
       │ 승인 버튼        │
       ▼                 ▼
  ┌──────────────────────────────┐
  │  leave_requests/{docId}      │
  │  { status: 'approved',       │   (클라이언트는 여기까지만 씀)
  │    target_class_code: 'A103',│
  │    use_server_finalize: true }│
  └──────────────┬───────────────┘
                 │ onUpdate 트리거
                 ▼
  ┌──────────────────────────────┐
  │ Cloud Function               │
  │  onLeaveRequestApproved      │   (서버사이드 단일 로직)
  │  - 유형별 분기                │
  │  - students 업데이트          │
  │  - enrollments 정규 교체      │
  │  - history_logs 기록          │
  │  - Firestore Transaction 원자적 │
  └──────────────┬───────────────┘
                 ▼
       ┌──────────────────┐
       │ students/{id}    │  (양쪽 앱의 onSnapshot이 자동 감지)
       │ history_logs/... │
       └──────────────────┘
```

### 핵심 원칙
1. **클라이언트 `_finalizeLeave*` 완전 제거**. 클라이언트는 `leave_requests` 문서 생성·승인 토글만 수행.
2. **Cloud Function이 유일한 student 상태 전이 주체**. 동시 작업해도 onUpdate 이벤트당 1회 원자적 실행.
3. **Firestore Transaction**. student 업데이트 + leave_request `finalized_at` 기록 + history_logs 작성을 한 트랜잭션으로 묶는다.
4. **Idempotent**. 재시도 등으로 같은 이벤트가 두 번 발화되어도 `finalized_at` 가드로 no-op.

## 5. 데이터 스키마

### `leave_requests/{autoId}` — 필드 추가

| 필드 | 타입 | 의미 | 쓰기 주체 |
|---|---|---|---|
| `target_class_code` | string | 재등원/복귀 시 선택된 정규반 코드 (예: `"A103"`). 복귀요청·재등원요청에서만 세팅. 기존 정규반 유지 시도 동일 값을 저장. | 클라이언트 |
| `use_server_finalize` | boolean | 마이그레이션용 플래그. `true`면 Cloud Function이 처리, 없으면 클라이언트 레거시 경로(전환 완료 후 플래그 제거 + 무조건 Function) | 클라이언트 |
| `finalized_at` | Timestamp | Cloud Function이 전이 완료한 시각 (idempotent 가드) | Cloud Function |
| `finalize_error` | string | 실패 시 에러 메시지 | Cloud Function |
| `finalize_attempts` | number | 시도 횟수 | Cloud Function |

### `students` — 스키마 변경 없음

Cloud Function이 enrollments 배열의 정규 enrollment(`class_type === '정규'` 또는 `class_type`이 없는 레거시)를 `target_class_code` 기반으로 교체. 내신·특강·자유학기 enrollment는 그대로 보존.

### `history_logs` — 스키마 변경 없음

기존 형식(`before`/`after`를 JSON 문자열) 유지. 재등원·복귀 시 enrollment 변경은 after JSON에 반영.

## 6. Cloud Function 상세

### 배포 구조

```
impact7DB/functions/           # impact7DB 레포에만 위치
├── package.json
├── index.js                   # 엔트리포인트
├── finalizeLeaveRequest.js    # 핵심 전이 로직
├── helpers.js                 # parseClassCode, deriveEnrollment 등
└── test/
    └── finalize.test.js
```

- Firestore가 프로젝트 공유(`impact7db`)이므로 DB 레포에만 두고 배포하면 DSC/HR/exam 어디서 이벤트 쏘든 같은 Function이 받는다.

### 트리거

```js
export const onLeaveRequestApproved = functions
    .region('asia-northeast3')
    .firestore.document('leave_requests/{docId}')
    .onUpdate(async (change, context) => {
        const before = change.before.data();
        const after  = change.after.data();

        if (!after.use_server_finalize) return null;        // 플래그 가드 (마이그레이션)
        if (before.status === 'approved' || after.status !== 'approved') return null;
        if (after.finalized_at) return null;                // idempotent 가드

        await finalize(change.after.ref, after);
    });
```

### 유형별 분기 표

| request_type | studentUpdate | changeType |
|---|---|---|
| 휴원요청 / 퇴원→휴원 | `pause_start_date`, `pause_end_date`. 시작일 ≤ 오늘이면 `status = leave_sub_type`; 미래면 `scheduled_leave_status = leave_sub_type` (status='재원' 유지) | `UPDATE` |
| 휴원연장 | `pause_end_date`만 교체 | `UPDATE` |
| 퇴원요청 / 휴원→퇴원 | `withdrawal_date`. 오늘 이하면 `status='퇴원'`; 미래면 `pre_withdrawal_status = beforeStatus` 저장 | `WITHDRAW` |
| 복귀요청 | `status='재원'`, `pause_*` 삭제. + enrollments 정규 교체 | `RETURN` |
| 재등원요청 | `status='재원'`, `pause_*`·`withdrawal_date` 삭제. + enrollments 정규 교체 | `RETURN` |

### enrollments 정규 교체 로직

```js
function replaceRegularEnrollment(stu, targetCode, returnDate, classSettings) {
    const existing = stu.enrollments || [];
    // 정규만 제거 (내신/특강/자유학기 보존)
    const preserved = existing.filter(e => e.class_type && e.class_type !== '정규');
    if (!targetCode) {
        // target 미지정 → 기존 정규 enrollment 유지 (구 동작 fallback)
        return existing;
    }
    const cs = classSettings[targetCode] || {};
    const days = cs.default_days || Object.keys(cs.schedule || {});
    const { level_symbol, class_number } = parseClassCode(targetCode);  // "A103" → A, "103"
    return [
        ...preserved,
        {
            class_type: '정규',
            level_symbol,
            class_number,
            day: days,
            start_date: returnDate || todayStr(),
        },
    ];
}
```

- **naesin_class_override 복원 안 함**: 제거된 정규 enrollment에 붙어 있었어도, 자동 유도로 돌아가는 게 기본. 필요 시 학생 상세에서 재지정.
- `class_settings`는 transaction 밖에서 `getDoc`으로 로드 (관리자가 거의 수정 안 하는 마스터 데이터).
- **`parseClassCode`**: 코드 첫 문자가 영문이면 `level_symbol`과 `class_number`로 분리 (예: `"A103"` → `"A"`, `"103"`). 첫 문자가 숫자면 `level_symbol`은 빈 문자열, 전체를 `class_number`로 (예: `"101"` → `""`, `"101"`). 복수 문자 prefix(예: `"AB103"`)는 학원 운영상 없지만, 있다면 영문 연속 prefix 전체를 `level_symbol`로 처리.

### 동명이인 처리

재원 전환 시 `(status === '재원' || '등원예정')` 학생 중 동명이인이 있으면 `이름2`, `이름3`... 숫자 접미사를 붙여 `studentUpdate.name`에 세팅. `leave_requests.student_name`도 함께 업데이트.

### 에러 처리

- transaction 실패 시 throw → Firestore Functions 런타임이 자동 재시도 3회.
- 3회 실패 시 `leave_requests`에 `finalize_error` 기록, `status`는 `approved` 그대로. UI가 빨간 배지로 경고 표시.

### 타임존

Function에서 `process.env.TZ = 'Asia/Seoul'` 설정. 날짜 비교는 모두 KST 기준.

## 7. 클라이언트 변경

### 공통 UI (DSC + impact7DB)

`#return-from-leave-modal`에 추가:

```html
<div id="rfl-target-class-wrap">
    <label>복귀할 정규반</label>
    <select id="rfl-target-class">
        <option value="">-- 반 선택 --</option>
    </select>
    <div id="rfl-target-class-hint"></div>
</div>
```

### `_openReturnModal` 수정

- 학생의 `branch` + `level`을 기준으로 `state.classSettings`에서 정규반 필터링 → 드롭다운 option 채우기.
- 기존 정규 enrollment의 `class_number`가 목록에 있으면 기본 선택.
- 선택 시 `hint` 영역에 해당 반의 요일/시간 표시.

### `submitReturnFromLeave` 수정

- 드롭다운 값을 `data.target_class_code`로 저장.
- 빈 값이면 alert로 "복귀할 반을 선택하세요" 반환.
- `data.use_server_finalize = true` 함께 저장.

### 승인 토글 함수

`approveLeaveRequest`, `teacherApproveLeaveRequest`에서 **`_finalizeLeave*` 호출 제거**. 양쪽 승인 완료 시 `status: 'approved'` write만 수행 → 나머지는 onSnapshot으로 자동 감지.

### finalize_error 배지

- 휴퇴원요청 리스트·상세 카드에서 `r.finalize_error`가 있으면 빨간 배지 + 툴팁.

## 8. Firestore rules

```
match /leave_requests/{id} {
    allow read: if signedIn();
    allow create, update: if signedIn()
        && !affectsAdminFields(request);
    function affectsAdminFields(req) {
        return ['finalized_at', 'finalize_error', 'finalize_attempts']
            .hasAny(req.resource.data.diff(resource.data).affectedKeys());
    }
}
```

클라이언트는 `target_class_code`, `use_server_finalize` 포함 일반 필드는 쓸 수 있고, admin 관리 필드는 거부. firebase-admin(Cloud Function)은 rules 우회.

4개 프로젝트 rules는 `firestore-rules-sync` 스킬로 배포.

## 9. 마이그레이션 & 롤아웃

| 단계 | 작업 | 위험 |
|---|---|---|
| 1 | **Blaze 요금제 전환** (사용자 수동, Firebase 콘솔) | 결제 이슈만 아니면 무위험 |
| 2 | Cloud Function 개발 + Firestore emulator 테스트 | 로컬 |
| 3 | Cloud Function 배포 — 이 시점엔 `use_server_finalize` 플래그를 쓰는 요청이 아직 없으므로 Function은 발동 안 함 | 무위험 |
| 4 | rules 업데이트 (신규 필드 허용) + 4개 프로젝트 동기화 | rules-sync 스킬 사용 |
| 5 | 클라이언트 변경 배포 (DSC + impact7DB 동시) — 새 요청에 `use_server_finalize: true` 포함, `_finalizeLeave*` 호출 제거 | 기존 requested 상태 요청은 플래그 없음 → 재작성 안내 |
| 6 | 1~2일 모니터링 (Function 로그 + finalize_error 확인) | — |
| 7 | 플래그 `use_server_finalize` 제거 + Function에서 조건 제거 (무조건 처리) | 문제 없음 확인 후 |

### 배포 이전 생성된 requested 상태 처리

- 기존 `requested` leave_request는 `use_server_finalize` 필드가 없음 → 신규 클라이언트가 승인해도 Function 발동 안 함 → 승인 후 status만 `approved`로 남고 학생 전이 안 됨.
- **정책**: 클라이언트의 승인 토글 함수가 승인 write 시점에 `r.use_server_finalize`가 falsy면 `use_server_finalize: true`를 같이 세팅. 단 이 레거시 요청은 `target_class_code`도 없을 수 있으므로:
  - 재등원/복귀 유형인데 `target_class_code`가 없으면 **승인 버튼을 비활성화**하고 "복귀할 반을 다시 요청 작성해주세요" 안내.
  - 그 외 유형(휴원/퇴원/연장)은 `target_class_code` 불필요하므로 정상 승인.

## 10. 테스트 계획

`functions/test/finalize.test.js` — Firestore emulator 기반 단위 테스트:

- [ ] 휴원요청 — 시작일이 오늘 이하 → status 변경 즉시
- [ ] 휴원요청 — 시작일이 미래 → scheduled_leave_status 예약, status='재원' 유지
- [ ] 휴원연장 — pause_end_date만 갱신
- [ ] 퇴원요청 — withdrawal_date 오늘 이하 → status='퇴원'
- [ ] 퇴원요청 — withdrawal_date 미래 → pre_withdrawal_status 저장
- [ ] 재등원요청 — target_class_code 있음 → 정규 enrollment 교체, 내신·특강 보존
- [ ] 재등원요청 — target_class_code 없음 → 기존 enrollment 유지
- [ ] 복귀요청 — target_class_code 있음, pause_* 삭제
- [ ] 동명이인 — 재원 전환 시 이름 충돌 → 숫자 접미사
- [ ] Idempotent — 이미 `finalized_at` 있는 문서 재발동 → no-op
- [ ] 에러 케이스 — student 문서 없음 → finalize_error 기록
- [ ] rules — 클라이언트가 `finalized_at` write 시도 → 거부

## 11. 미해결 이슈 / 후속

- **유시우 데이터 복구**: 이번 스펙 배포 전 별도 one-off 스크립트로 수행. status=재원 복원 + 정규 A101 enrollment 복원 + 불필요한 내신 enrollment 제거.
- **history_logs 형식 통일**: 현재 DSC(JSON)와 impact7DB(일부 한글 텍스트)가 혼용. Function은 JSON 형식으로 통일. 구 텍스트 로그는 그대로 둠.
- **클라이언트 students write 전반 금지**: 이번 스펙 이후 과제. 현재는 class-setup, naesin, student-detail 등 다양한 경로에서 student를 수정하므로 광범위한 리팩토링 필요.
