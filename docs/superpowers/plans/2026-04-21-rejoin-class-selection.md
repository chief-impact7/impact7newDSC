# 재등원·복귀 반 선택 + Cloud Function 이관 구현 플랜

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `leave_requests`의 모든 승인 전이를 Cloud Function으로 이관하고, 재등원·복귀 모달에 정규반 선택 UI를 추가해 DSC·impact7DB 클라이언트 경합 사고를 구조적으로 방지한다.

**Architecture:** `leave_requests/{id}` onUpdate 트리거가 `status: requested → approved` 전이를 감지해 학생 문서·history_logs를 Firestore Transaction으로 원자적 갱신. 두 클라이언트는 leave_request write만 담당. `use_server_finalize` 플래그로 점진적 마이그레이션.

**Tech Stack:** Firebase Cloud Functions (Node 20, asia-northeast3), firebase-functions-test, Vitest, Firestore Emulator. 기존 클라이언트는 Vanilla JS (DSC) + 단일 SPA (impact7DB).

**Spec:** `docs/superpowers/specs/2026-04-21-rejoin-class-selection-design.md`

**Repos affected:**
- `~/projects/impact7DB` — Cloud Function 코드 owner, 클라이언트 모달 변경
- `~/projects/impact7newDSC` — 클라이언트 모달 변경
- `~/projects/impact7HR`, `~/projects/impact7exam` — rules 동기화만

---

## File Structure

### impact7DB (신규)

```
impact7DB/functions/
├── package.json                       # Node 20, firebase-admin, firebase-functions
├── .eslintrc.json
├── index.js                           # 트리거 export
├── src/
│   ├── finalize.js                    # finalize 트랜잭션 래퍼
│   ├── buildUpdate.js                 # 유형별 분기 (휴원/연장/퇴원/재등원/복귀)
│   ├── enrollments.js                 # replaceRegularEnrollment
│   ├── classCode.js                   # parseClassCode
│   ├── dedupName.js                   # deduplicateName
│   └── kst.js                         # KST 날짜 헬퍼
└── test/
    ├── classCode.test.js
    ├── enrollments.test.js
    ├── dedupName.test.js
    ├── buildUpdate.test.js
    └── finalize.integration.test.js   # Firestore emulator 기반
```

### impact7DB (수정)

- `app.js` 4498-4925 라인 부근 (`_finalizeLeaveRequest`, 모달, 승인 토글)
- `index.html` `#return-from-leave-modal` 영역
- `firebase.json` — functions 섹션 추가

### impact7newDSC (수정)

- `leave-request.js` (모달 핸들러, 승인 토글, `_finalizeLeaveDSC`)
- `index.html` `#return-from-leave-modal` 영역

### 4개 프로젝트 (수정)

- `firestore.rules` — `leave_requests` 허용 필드 확장 + admin 필드 차단

---

## 사전 조건 (수동)

플랜 실행 전 사용자가 수행:

- [ ] **Firebase 프로젝트 `impact7db`를 Blaze(종량제)로 전환** — Firebase 콘솔 > 사용량 및 결제 > 요금제 > Blaze. Cloud Functions 실행 필수 조건. 기본 무료 할당량 안에서 비용 0원 예상이지만, 결제 수단 등록 필요.
- [ ] **`gcloud` 인증 확인** — `gcloud auth application-default login` 한 번 수행 (테스트 스크립트용).
- [ ] **Firebase CLI 인증** — `firebase login`.

---

## Phase 1 — Cloud Function: 순수 로직 (TDD)

### Task 1.1: functions/ 스캐폴드 생성

**Files:**
- Create: `~/projects/impact7DB/functions/package.json`
- Create: `~/projects/impact7DB/functions/.eslintrc.json`
- Create: `~/projects/impact7DB/functions/index.js`
- Modify: `~/projects/impact7DB/firebase.json` (functions 섹션 추가)
- Create: `~/projects/impact7DB/functions/.gitignore`

- [ ] **Step 1: package.json 작성**

```json
{
  "name": "impact7-functions",
  "engines": { "node": "20" },
  "main": "index.js",
  "type": "module",
  "scripts": {
    "lint": "eslint .",
    "test": "vitest run",
    "test:watch": "vitest",
    "serve": "firebase emulators:start --only functions,firestore",
    "deploy": "firebase deploy --only functions",
    "logs": "firebase functions:log"
  },
  "dependencies": {
    "firebase-admin": "^12.0.0",
    "firebase-functions": "^6.0.0"
  },
  "devDependencies": {
    "eslint": "^9.0.0",
    "firebase-functions-test": "^3.3.0",
    "vitest": "^2.0.0"
  },
  "private": true
}
```

- [ ] **Step 2: .eslintrc.json 작성**

```json
{
  "env": { "es2022": true, "node": true },
  "parserOptions": { "ecmaVersion": 2022, "sourceType": "module" },
  "rules": { "no-unused-vars": ["warn", { "argsIgnorePattern": "^_" }] }
}
```

- [ ] **Step 3: 빈 index.js 작성**

```js
// Cloud Functions 엔트리포인트. Phase 1 후반에 트리거 추가.
import { initializeApp } from 'firebase-admin/app';
initializeApp();
```

- [ ] **Step 4: .gitignore 작성**

```
node_modules/
*.log
.env
.firebase/
```

- [ ] **Step 5: firebase.json에 functions 섹션 추가**

`~/projects/impact7DB/firebase.json`을 열어 기존 객체에 추가:

```json
{
  "firestore": { ... },
  "hosting": { ... },
  "functions": [
    {
      "source": "functions",
      "codebase": "default",
      "runtime": "nodejs20",
      "ignore": ["node_modules", ".git", "*.log"]
    }
  ]
}
```

- [ ] **Step 6: 의존성 설치**

```bash
cd ~/projects/impact7DB/functions && npm install
```

Expected: package-lock.json 생성, node_modules 채워짐. Warning 정도는 허용.

- [ ] **Step 7: 커밋**

```bash
cd ~/projects/impact7DB
git add functions/ firebase.json
git commit -m "feat(functions): scaffold Cloud Functions for leave_requests trigger"
```

---

### Task 1.2: `parseClassCode` 헬퍼 (TDD)

**Files:**
- Create: `~/projects/impact7DB/functions/test/classCode.test.js`
- Create: `~/projects/impact7DB/functions/src/classCode.js`

- [ ] **Step 1: 실패 테스트 작성**

`functions/test/classCode.test.js`:

```js
import { describe, it, expect } from 'vitest';
import { parseClassCode } from '../src/classCode.js';

describe('parseClassCode', () => {
  it('영문+숫자 코드를 분리한다', () => {
    expect(parseClassCode('A103')).toEqual({ level_symbol: 'A', class_number: '103' });
  });
  it('숫자만 있는 코드는 level_symbol이 빈 문자열', () => {
    expect(parseClassCode('101')).toEqual({ level_symbol: '', class_number: '101' });
  });
  it('영문 prefix가 여러 글자인 코드도 처리', () => {
    expect(parseClassCode('AB103')).toEqual({ level_symbol: 'AB', class_number: '103' });
  });
  it('빈 문자열/null은 빈 결과', () => {
    expect(parseClassCode('')).toEqual({ level_symbol: '', class_number: '' });
    expect(parseClassCode(null)).toEqual({ level_symbol: '', class_number: '' });
  });
  it('소문자도 처리', () => {
    expect(parseClassCode('a103')).toEqual({ level_symbol: 'a', class_number: '103' });
  });
});
```

- [ ] **Step 2: 테스트 실행 — FAIL 확인**

```bash
cd ~/projects/impact7DB/functions && npm test
```

Expected: `Cannot find module '../src/classCode.js'` 또는 `parseClassCode is not defined`.

- [ ] **Step 3: 구현 작성**

`functions/src/classCode.js`:

```js
// "A103" → { level_symbol: "A", class_number: "103" }
// "101"  → { level_symbol: "", class_number: "101" }
// 첫 영문 연속 prefix를 level_symbol로, 나머지를 class_number로.
export function parseClassCode(code) {
  if (!code) return { level_symbol: '', class_number: '' };
  const m = String(code).match(/^([A-Za-z]*)(.*)$/);
  return { level_symbol: m[1] || '', class_number: m[2] || '' };
}
```

- [ ] **Step 4: 테스트 통과 확인**

```bash
npm test
```

Expected: 5개 케이스 PASS.

- [ ] **Step 5: 커밋**

```bash
cd ~/projects/impact7DB
git add functions/src/classCode.js functions/test/classCode.test.js
git commit -m "feat(functions): add parseClassCode helper with tests"
```

---

### Task 1.3: `replaceRegularEnrollment` 헬퍼 (TDD)

**Files:**
- Create: `~/projects/impact7DB/functions/test/enrollments.test.js`
- Create: `~/projects/impact7DB/functions/src/enrollments.js`

- [ ] **Step 1: 실패 테스트 작성**

`functions/test/enrollments.test.js`:

```js
import { describe, it, expect } from 'vitest';
import { replaceRegularEnrollment } from '../src/enrollments.js';

const today = '2026-04-21';

describe('replaceRegularEnrollment', () => {
  it('정규만 교체하고 내신/특강 보존', () => {
    const stu = {
      enrollments: [
        { class_type: '정규', level_symbol: 'A', class_number: '101', day: ['월', '금'] },
        { class_type: '내신', class_number: '103', day: ['화', '목', '토'], end_date: '2026-05-03' },
        { class_type: '특강', class_number: '수요특강', day: ['수'] },
      ],
    };
    const cs = { A103: { default_days: ['월', '수'] } };
    const result = replaceRegularEnrollment(stu, 'A103', today, cs);
    expect(result).toHaveLength(3);
    const reg = result.find(e => e.class_type === '정규');
    expect(reg).toEqual({
      class_type: '정규',
      level_symbol: 'A',
      class_number: '103',
      day: ['월', '수'],
      start_date: today,
    });
    expect(result.find(e => e.class_type === '내신')).toBeDefined();
    expect(result.find(e => e.class_type === '특강')).toBeDefined();
  });

  it('class_type 없는 레거시 정규 enrollment도 교체 대상', () => {
    const stu = {
      enrollments: [
        { level_symbol: 'A', class_number: '101', day: ['월', '금'] },
      ],
    };
    const cs = { A103: { schedule: { 월: '17:00', 수: '17:00' } } };
    const result = replaceRegularEnrollment(stu, 'A103', today, cs);
    expect(result).toHaveLength(1);
    expect(result[0].class_type).toBe('정규');
    expect(result[0].class_number).toBe('103');
    expect(result[0].day).toEqual(['월', '수']);
  });

  it('targetCode 없으면 기존 enrollments 그대로 반환', () => {
    const stu = {
      enrollments: [{ class_type: '정규', class_number: '101', day: ['월'] }],
    };
    const result = replaceRegularEnrollment(stu, '', today, {});
    expect(result).toEqual(stu.enrollments);
  });

  it('class_settings 누락 시 day는 빈 배열', () => {
    const stu = { enrollments: [{ class_type: '정규', class_number: '101', day: ['월'] }] };
    const result = replaceRegularEnrollment(stu, 'B201', today, {});
    expect(result[0].day).toEqual([]);
  });

  it('default_days가 schedule보다 우선', () => {
    const stu = { enrollments: [] };
    const cs = { A103: { default_days: ['월', '수'], schedule: { 화: '17:00' } } };
    const result = replaceRegularEnrollment(stu, 'A103', today, cs);
    expect(result[0].day).toEqual(['월', '수']);
  });

  it('enrollments 배열이 없는 학생도 처리', () => {
    const stu = {};
    const cs = { A103: { default_days: ['월'] } };
    const result = replaceRegularEnrollment(stu, 'A103', today, cs);
    expect(result).toHaveLength(1);
    expect(result[0].class_type).toBe('정규');
  });
});
```

- [ ] **Step 2: 테스트 실행 — FAIL**

```bash
npm test enrollments
```

- [ ] **Step 3: 구현**

`functions/src/enrollments.js`:

```js
import { parseClassCode } from './classCode.js';

const REGULAR_KEYS = ['정규', undefined, null];

// 정규 enrollment를 targetCode 기반으로 교체. 내신/특강/자유학기 보존.
// targetCode 없으면 기존 그대로.
export function replaceRegularEnrollment(student, targetCode, returnDate, classSettings) {
  const existing = student?.enrollments || [];
  if (!targetCode) return existing;

  const preserved = existing.filter(e => !REGULAR_KEYS.includes(e?.class_type));
  const cs = classSettings?.[targetCode] || {};
  const days = cs.default_days
    || (cs.schedule ? Object.keys(cs.schedule) : [])
    || [];
  const { level_symbol, class_number } = parseClassCode(targetCode);

  const newRegular = {
    class_type: '정규',
    level_symbol,
    class_number,
    day: days,
    start_date: returnDate,
  };
  return [...preserved, newRegular];
}
```

- [ ] **Step 4: 테스트 통과 확인**

```bash
npm test enrollments
```

- [ ] **Step 5: 커밋**

```bash
cd ~/projects/impact7DB
git add functions/src/enrollments.js functions/test/enrollments.test.js
git commit -m "feat(functions): add replaceRegularEnrollment with tests"
```

---

### Task 1.4: `deduplicateName` 헬퍼 (TDD)

**Files:**
- Create: `~/projects/impact7DB/functions/test/dedupName.test.js`
- Create: `~/projects/impact7DB/functions/src/dedupName.js`

- [ ] **Step 1: 실패 테스트 작성**

`functions/test/dedupName.test.js`:

```js
import { describe, it, expect } from 'vitest';
import { deduplicateName } from '../src/dedupName.js';

const ACTIVE = ['재원', '등원예정'];

describe('deduplicateName', () => {
  it('충돌 없으면 null 반환', () => {
    const others = [
      { id: 'b', name: '김철수', status: '재원' },
      { id: 'c', name: '이영희', status: '재원' },
    ];
    expect(deduplicateName('a', '박민수', others)).toBeNull();
  });

  it('단순 중복은 이름2로', () => {
    const others = [{ id: 'b', name: '김철수', status: '재원' }];
    expect(deduplicateName('a', '김철수', others)).toBe('김철수2');
  });

  it('이미 김철수와 김철수2가 있으면 김철수3', () => {
    const others = [
      { id: 'b', name: '김철수', status: '재원' },
      { id: 'c', name: '김철수2', status: '재원' },
    ];
    expect(deduplicateName('a', '김철수', others)).toBe('김철수3');
  });

  it('퇴원/종강 학생과는 충돌 안 함', () => {
    const others = [
      { id: 'b', name: '김철수', status: '퇴원' },
      { id: 'c', name: '김철수', status: '종강' },
    ];
    expect(deduplicateName('a', '김철수', others)).toBeNull();
  });

  it('자기 자신은 제외', () => {
    const others = [{ id: 'a', name: '김철수', status: '재원' }];
    expect(deduplicateName('a', '김철수', others)).toBeNull();
  });

  it('등원예정도 활성으로 간주', () => {
    const others = [{ id: 'b', name: '김철수', status: '등원예정' }];
    expect(deduplicateName('a', '김철수', others)).toBe('김철수2');
  });
});
```

- [ ] **Step 2: 테스트 실행 — FAIL**

- [ ] **Step 3: 구현**

`functions/src/dedupName.js`:

```js
const ACTIVE = new Set(['재원', '등원예정']);

// 활성 학생 중 동명이인이 있으면 숫자 접미사 붙인 이름 반환, 없으면 null.
export function deduplicateName(selfId, currentName, allStudents) {
  if (!currentName) return null;
  const isDup = allStudents.some(s =>
    s.id !== selfId && s.name === currentName && ACTIVE.has(s.status)
  );
  if (!isDup) return null;

  const base = currentName.replace(/\d+$/, '');
  const escaped = base.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`^${escaped}\\d*$`);
  const variants = allStudents.filter(s =>
    s.id !== selfId && re.test(s.name) && ACTIVE.has(s.status)
  );
  const used = variants.map(s => {
    const m = s.name.match(/(\d+)$/);
    return m ? parseInt(m[1], 10) : 1;
  });
  used.push(1);
  return `${base}${Math.max(...used) + 1}`;
}
```

- [ ] **Step 4: 테스트 통과**

- [ ] **Step 5: 커밋**

```bash
cd ~/projects/impact7DB
git add functions/src/dedupName.js functions/test/dedupName.test.js
git commit -m "feat(functions): add deduplicateName with tests"
```

---

### Task 1.5: KST 날짜 헬퍼

**Files:**
- Create: `~/projects/impact7DB/functions/src/kst.js`

- [ ] **Step 1: 구현**

`functions/src/kst.js`:

```js
// KST 기준 오늘 날짜 문자열 (YYYY-MM-DD).
// Cloud Functions 런타임은 UTC이므로 명시적 KST 변환 필수.
export function todayKST() {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Seoul' });
}
```

- [ ] **Step 2: 테스트 작성**

`functions/test/kst.test.js`:

```js
import { describe, it, expect } from 'vitest';
import { todayKST } from '../src/kst.js';

describe('todayKST', () => {
  it('YYYY-MM-DD 형식', () => {
    expect(todayKST()).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});
```

- [ ] **Step 3: 테스트 통과 확인 + 커밋**

```bash
cd ~/projects/impact7DB
npm --prefix functions test kst
git add functions/src/kst.js functions/test/kst.test.js
git commit -m "feat(functions): add KST date helper"
```

---

### Task 1.6: `buildUpdate` — 휴원요청 + 휴원연장 (TDD)

**Files:**
- Create: `~/projects/impact7DB/functions/test/buildUpdate.test.js`
- Create: `~/projects/impact7DB/functions/src/buildUpdate.js`

- [ ] **Step 1: 휴원요청 실패 테스트 작성**

`functions/test/buildUpdate.test.js`:

```js
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { buildUpdate } from '../src/buildUpdate.js';

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-04-21T03:00:00Z')); // KST 12:00
});

const baseStu = { id: 'a', name: '김철수', status: '재원', enrollments: [] };

describe('buildUpdate — 휴원요청', () => {
  it('시작일이 오늘 → status 변경 즉시', () => {
    const r = {
      request_type: '휴원요청',
      leave_sub_type: '실휴원',
      leave_start_date: '2026-04-21',
      leave_end_date: '2026-05-31',
    };
    const { studentUpdate, changeType } = buildUpdate(r, baseStu, {}, []);
    expect(changeType).toBe('UPDATE');
    expect(studentUpdate.status).toBe('실휴원');
    expect(studentUpdate.pause_start_date).toBe('2026-04-21');
    expect(studentUpdate.pause_end_date).toBe('2026-05-31');
    expect(studentUpdate.scheduled_leave_status).toBeUndefined();
  });

  it('시작일이 미래 → scheduled_leave_status 예약, status 유지', () => {
    const r = {
      request_type: '휴원요청',
      leave_sub_type: '가휴원',
      leave_start_date: '2026-05-01',
      leave_end_date: '2026-06-01',
    };
    const { studentUpdate } = buildUpdate(r, baseStu, {}, []);
    expect(studentUpdate.status).toBeUndefined();
    expect(studentUpdate.scheduled_leave_status).toBe('가휴원');
    expect(studentUpdate.pause_start_date).toBe('2026-05-01');
  });
});

describe('buildUpdate — 휴원연장', () => {
  it('pause_end_date만 갱신', () => {
    const r = { request_type: '휴원연장', leave_end_date: '2026-07-31' };
    const stu = { ...baseStu, status: '실휴원', pause_start_date: '2026-04-01', pause_end_date: '2026-05-31' };
    const { studentUpdate } = buildUpdate(r, stu, {}, []);
    expect(studentUpdate.pause_end_date).toBe('2026-07-31');
    expect(studentUpdate.status).toBeUndefined();
    expect(studentUpdate.pause_start_date).toBeUndefined();
  });
});
```

- [ ] **Step 2: 테스트 실행 — FAIL**

```bash
cd ~/projects/impact7DB/functions && npm test buildUpdate
```

- [ ] **Step 3: 휴원·연장 분기 구현**

`functions/src/buildUpdate.js`:

```js
import { todayKST } from './kst.js';
import { replaceRegularEnrollment } from './enrollments.js';
import { deduplicateName } from './dedupName.js';

const RETURN_TYPES = new Set(['복귀요청', '재등원요청']);
const WITHDRAW_TYPES = new Set(['퇴원요청', '휴원→퇴원']);

export function buildUpdate(r, student, classSettings, allStudents) {
  const today = todayKST();

  if (r.request_type === '휴원연장') {
    return {
      studentUpdate: { pause_end_date: r.leave_end_date || '' },
      changeType: 'UPDATE',
    };
  }

  if (RETURN_TYPES.has(r.request_type)) {
    // Task 1.8에서 채움
    throw new Error('not implemented');
  }
  if (WITHDRAW_TYPES.has(r.request_type)) {
    // Task 1.7에서 채움
    throw new Error('not implemented');
  }

  // 휴원요청 / 퇴원→휴원
  const subType = r.leave_sub_type || '실휴원';
  const start = r.leave_start_date || '';
  const studentUpdate = {
    pause_start_date: start,
    pause_end_date: r.leave_end_date || '',
  };
  if (start && start > today) {
    studentUpdate.scheduled_leave_status = subType;
  } else {
    studentUpdate.status = subType;
  }
  return { studentUpdate, changeType: 'UPDATE' };
}
```

- [ ] **Step 4: 테스트 통과 확인**

- [ ] **Step 5: 커밋**

```bash
cd ~/projects/impact7DB
git add functions/src/buildUpdate.js functions/test/buildUpdate.test.js
git commit -m "feat(functions): buildUpdate handles 휴원요청 and 휴원연장"
```

---

### Task 1.7: `buildUpdate` — 퇴원요청 (TDD)

**Files:**
- Modify: `~/projects/impact7DB/functions/test/buildUpdate.test.js`
- Modify: `~/projects/impact7DB/functions/src/buildUpdate.js`

- [ ] **Step 1: 퇴원요청 실패 테스트 추가**

`functions/test/buildUpdate.test.js` 끝에 추가:

```js
describe('buildUpdate — 퇴원요청', () => {
  it('withdrawal_date가 오늘 이하 → status=퇴원', () => {
    const r = { request_type: '퇴원요청', withdrawal_date: '2026-04-21' };
    const { studentUpdate, changeType } = buildUpdate(r, baseStu, {}, []);
    expect(changeType).toBe('WITHDRAW');
    expect(studentUpdate.status).toBe('퇴원');
    expect(studentUpdate.withdrawal_date).toBe('2026-04-21');
  });

  it('withdrawal_date가 미래 → pre_withdrawal_status 저장, status 유지', () => {
    const r = { request_type: '퇴원요청', withdrawal_date: '2026-05-15' };
    const stu = { ...baseStu, status: '실휴원' };
    const { studentUpdate } = buildUpdate(r, stu, {}, []);
    expect(studentUpdate.status).toBeUndefined();
    expect(studentUpdate.pre_withdrawal_status).toBe('실휴원');
    expect(studentUpdate.withdrawal_date).toBe('2026-05-15');
  });

  it('휴원→퇴원도 동일 동작', () => {
    const r = { request_type: '휴원→퇴원', withdrawal_date: '2026-04-21' };
    const stu = { ...baseStu, status: '실휴원', pause_start_date: '2026-04-01', pause_end_date: '2026-05-31' };
    const { studentUpdate } = buildUpdate(r, stu, {}, []);
    expect(studentUpdate.status).toBe('퇴원');
    // pause_* 필드는 finalize 단계에서 deleteField로 처리 (Task 1.9)
  });
});
```

- [ ] **Step 2: 테스트 실행 — FAIL**

- [ ] **Step 3: 퇴원 분기 구현**

`functions/src/buildUpdate.js`의 WITHDRAW_TYPES 분기 채우기:

```js
if (WITHDRAW_TYPES.has(r.request_type)) {
  const wDate = r.withdrawal_date || today;
  const studentUpdate = { withdrawal_date: wDate };
  if (wDate > today) {
    studentUpdate.pre_withdrawal_status = student.status || '재원';
  } else {
    studentUpdate.status = '퇴원';
  }
  return { studentUpdate, changeType: 'WITHDRAW' };
}
```

- [ ] **Step 4: 테스트 통과 확인**

- [ ] **Step 5: 커밋**

```bash
cd ~/projects/impact7DB
git add functions/src/buildUpdate.js functions/test/buildUpdate.test.js
git commit -m "feat(functions): buildUpdate handles 퇴원요청 and 휴원→퇴원"
```

---

### Task 1.8: `buildUpdate` — 재등원/복귀요청 + enrollment 교체 (TDD)

**Files:**
- Modify: `~/projects/impact7DB/functions/test/buildUpdate.test.js`
- Modify: `~/projects/impact7DB/functions/src/buildUpdate.js`

- [ ] **Step 1: 실패 테스트 추가**

`functions/test/buildUpdate.test.js` 끝에 추가:

```js
describe('buildUpdate — 재등원/복귀요청', () => {
  const cs = { A103: { default_days: ['월', '수'] } };

  it('재등원: status=재원, enrollment 정규 교체', () => {
    const stu = {
      id: 'a',
      name: '유시우',
      status: '퇴원',
      enrollments: [
        { class_type: '내신', class_number: '103', day: ['화'], end_date: '2026-05-03' },
      ],
    };
    const r = { request_type: '재등원요청', target_class_code: 'A103', return_date: '2026-04-21' };
    const { studentUpdate, changeType, enrollments } = buildUpdate(r, stu, cs, []);
    expect(changeType).toBe('RETURN');
    expect(studentUpdate.status).toBe('재원');
    expect(enrollments).toHaveLength(2);
    expect(enrollments.find(e => e.class_type === '정규').class_number).toBe('103');
    expect(enrollments.find(e => e.class_type === '내신')).toBeDefined();
  });

  it('복귀: status=재원, target 없으면 기존 enrollment 유지', () => {
    const stu = {
      id: 'a',
      name: '김민수',
      status: '실휴원',
      enrollments: [{ class_type: '정규', class_number: '101', day: ['월', '금'] }],
      pause_start_date: '2026-03-01',
      pause_end_date: '2026-04-30',
    };
    const r = { request_type: '복귀요청', return_date: '2026-04-21' };
    const { studentUpdate, enrollments } = buildUpdate(r, stu, cs, []);
    expect(studentUpdate.status).toBe('재원');
    expect(enrollments).toEqual(stu.enrollments);
  });

  it('동명이인 → 숫자 접미사', () => {
    const stu = { id: 'a', name: '김철수', status: '퇴원', enrollments: [] };
    const allStudents = [{ id: 'b', name: '김철수', status: '재원' }];
    const r = { request_type: '재등원요청', target_class_code: 'A103', return_date: '2026-04-21' };
    const { studentUpdate } = buildUpdate(r, stu, cs, allStudents);
    expect(studentUpdate.name).toBe('김철수2');
  });
});
```

- [ ] **Step 2: 테스트 실행 — FAIL**

- [ ] **Step 3: 재등원/복귀 분기 구현**

`functions/src/buildUpdate.js`의 RETURN_TYPES 분기 채우기:

```js
if (RETURN_TYPES.has(r.request_type)) {
  const studentUpdate = { status: '재원' };
  const dedup = deduplicateName(student.id, student.name || '', allStudents);
  if (dedup) studentUpdate.name = dedup;
  const enrollments = replaceRegularEnrollment(
    student,
    r.target_class_code || '',
    r.return_date || today,
    classSettings,
  );
  return { studentUpdate, enrollments, changeType: 'RETURN' };
}
```

- [ ] **Step 4: 테스트 통과 확인**

- [ ] **Step 5: 커밋**

```bash
cd ~/projects/impact7DB
git add functions/src/buildUpdate.js functions/test/buildUpdate.test.js
git commit -m "feat(functions): buildUpdate handles 재등원/복귀 with enrollment replace"
```

---

### Task 1.9: `finalize` 트랜잭션 래퍼

**Files:**
- Create: `~/projects/impact7DB/functions/src/finalize.js`

- [ ] **Step 1: 구현 작성**

`functions/src/finalize.js`:

```js
import { getFirestore, FieldValue } from 'firebase-admin/firestore';
import { buildUpdate } from './buildUpdate.js';

const RETURN_TYPES = new Set(['복귀요청', '재등원요청']);
const WITHDRAW_TYPES = new Set(['퇴원요청', '휴원→퇴원']);

// leave_request 승인 이벤트를 학생 문서·history_logs로 원자적 반영.
export async function finalize(lrRef, r) {
  const db = getFirestore();
  const studentRef = db.doc(`students/${r.student_id}`);

  // class_settings는 transaction 밖에서 로드 (마스터 데이터, 경합 없음)
  const csSnap = await db.collection('class_settings').get();
  const classSettings = {};
  csSnap.forEach(d => { classSettings[d.id] = d.data(); });

  // 활성 학생 목록도 미리 로드 (동명이인 체크용)
  const stuSnap = await db.collection('students')
    .where('status', 'in', ['재원', '등원예정'])
    .get();
  const allStudents = [];
  stuSnap.forEach(d => allStudents.push({ id: d.id, ...d.data() }));

  await db.runTransaction(async tx => {
    const stuDoc = await tx.get(studentRef);
    if (!stuDoc.exists) throw new Error(`student ${r.student_id} not found`);
    const stu = { id: stuDoc.id, ...stuDoc.data() };
    const beforeStatus = stu.status || '';

    const { studentUpdate, enrollments, changeType } = buildUpdate(r, stu, classSettings, allStudents);

    // pause_* / withdrawal_date 정리 (RETURN/WITHDRAW)
    const finalUpdate = { ...studentUpdate };
    if (changeType === 'RETURN') {
      finalUpdate.pause_start_date = FieldValue.delete();
      finalUpdate.pause_end_date = FieldValue.delete();
      finalUpdate.scheduled_leave_status = FieldValue.delete();
      if (r.request_type === '재등원요청') {
        finalUpdate.withdrawal_date = FieldValue.delete();
      }
    } else if (changeType === 'WITHDRAW') {
      finalUpdate.pause_start_date = FieldValue.delete();
      finalUpdate.pause_end_date = FieldValue.delete();
      finalUpdate.scheduled_leave_status = FieldValue.delete();
    }
    if (enrollments) finalUpdate.enrollments = enrollments;
    finalUpdate.updated_at = FieldValue.serverTimestamp();
    finalUpdate.updated_by = r.approved_by || r.teacher_approved_by || 'cloud-function';

    tx.update(studentRef, finalUpdate);

    tx.update(lrRef, {
      finalized_at: FieldValue.serverTimestamp(),
      finalize_attempts: FieldValue.increment(1),
      finalize_error: FieldValue.delete(),
      ...(finalUpdate.name ? { student_name: finalUpdate.name } : {}),
    });

    const historyRef = db.collection('history_logs').doc();
    tx.set(historyRef, {
      doc_id: r.student_id,
      change_type: changeType,
      before: JSON.stringify({
        status: beforeStatus,
        pause_start_date: stu.pause_start_date || '',
        pause_end_date: stu.pause_end_date || '',
      }),
      after: JSON.stringify({
        status: studentUpdate.status || beforeStatus,
        pause_start_date: changeType === 'UPDATE' ? (studentUpdate.pause_start_date || '') : '',
        pause_end_date: changeType === 'UPDATE' ? (studentUpdate.pause_end_date || '') : '',
      }),
      google_login_id: r.approved_by || r.teacher_approved_by || 'cloud-function',
      timestamp: FieldValue.serverTimestamp(),
    });
  });
}
```

- [ ] **Step 2: 커밋 (테스트는 Task 2에서 통합 테스트로)**

```bash
cd ~/projects/impact7DB
git add functions/src/finalize.js
git commit -m "feat(functions): add finalize transaction wrapper"
```

---

### Task 1.10: onUpdate 트리거 엔트리

**Files:**
- Modify: `~/projects/impact7DB/functions/index.js`

- [ ] **Step 1: 트리거 작성**

`functions/index.js` 전체 교체:

```js
import { initializeApp } from 'firebase-admin/app';
import { onDocumentUpdated } from 'firebase-functions/v2/firestore';
import { setGlobalOptions } from 'firebase-functions/v2';
import { finalize } from './src/finalize.js';

initializeApp();

// 모든 함수 기본 옵션
setGlobalOptions({
  region: 'asia-northeast3',
  maxInstances: 10,
});

// leave_requests/{docId} 승인 전이 트리거
export const onLeaveRequestApproved = onDocumentUpdated(
  'leave_requests/{docId}',
  async (event) => {
    const before = event.data?.before?.data();
    const after  = event.data?.after?.data();
    if (!before || !after) return null;

    // 마이그레이션 플래그 (Phase 6에서 제거)
    if (!after.use_server_finalize) return null;
    // 승인 전이만 처리
    if (before.status === 'approved' || after.status !== 'approved') return null;
    // 중복 발동 방어
    if (after.finalized_at) return null;

    try {
      await finalize(event.data.after.ref, after);
    } catch (err) {
      console.error('[onLeaveRequestApproved] finalize failed:', err);
      // 에러를 leave_request에 기록 (재시도용 상태)
      await event.data.after.ref.update({
        finalize_error: String(err?.message || err),
        finalize_attempts: (after.finalize_attempts || 0) + 1,
      });
      throw err; // Functions 런타임이 자동 재시도
    }
  }
);
```

- [ ] **Step 2: 린트 확인**

```bash
cd ~/projects/impact7DB/functions && npm run lint
```

- [ ] **Step 3: 커밋**

```bash
cd ~/projects/impact7DB
git add functions/index.js
git commit -m "feat(functions): add onLeaveRequestApproved trigger"
```

---

## Phase 2 — 통합 테스트 (Firestore Emulator)

### Task 2.1: Emulator 통합 테스트

**Files:**
- Create: `~/projects/impact7DB/functions/test/finalize.integration.test.js`

- [ ] **Step 1: 통합 테스트 작성**

`functions/test/finalize.integration.test.js`:

```js
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { initializeApp, deleteApp } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import { finalize } from '../src/finalize.js';

let app;
let db;

beforeAll(() => {
  process.env.FIRESTORE_EMULATOR_HOST = '127.0.0.1:8080';
  app = initializeApp({ projectId: 'impact7db-test' });
  db = getFirestore();
});

afterAll(async () => {
  await deleteApp(app);
});

beforeEach(async () => {
  // 모든 컬렉션 클리어
  for (const col of ['students', 'leave_requests', 'history_logs', 'class_settings']) {
    const snap = await db.collection(col).get();
    await Promise.all(snap.docs.map(d => d.ref.delete()));
  }
});

async function seed(stu, lr, cs = {}) {
  await db.doc(`students/${stu.id}`).set(stu);
  for (const [code, data] of Object.entries(cs)) {
    await db.doc(`class_settings/${code}`).set(data);
  }
  const lrRef = db.collection('leave_requests').doc();
  await lrRef.set(lr);
  return lrRef;
}

describe('finalize — integration', () => {
  it('재등원 + 반 변경 → status=재원, 정규 교체', async () => {
    const lrRef = await seed(
      { id: 's1', name: '유시우', status: '퇴원', enrollments: [] },
      {
        student_id: 's1', request_type: '재등원요청',
        target_class_code: 'A103', return_date: '2026-04-21',
        status: 'approved', use_server_finalize: true,
      },
      { A103: { default_days: ['월', '수'] } },
    );
    const lr = (await lrRef.get()).data();
    await finalize(lrRef, lr);

    const stu = (await db.doc('students/s1').get()).data();
    expect(stu.status).toBe('재원');
    expect(stu.enrollments).toHaveLength(1);
    expect(stu.enrollments[0].class_number).toBe('103');

    const lrAfter = (await lrRef.get()).data();
    expect(lrAfter.finalized_at).toBeDefined();
    expect(lrAfter.finalize_attempts).toBe(1);

    const hl = await db.collection('history_logs').get();
    expect(hl.size).toBe(1);
    expect(hl.docs[0].data().change_type).toBe('RETURN');
  });

  it('휴원요청 + 미래 시작일 → scheduled_leave_status', async () => {
    const lrRef = await seed(
      { id: 's2', name: '김철수', status: '재원', enrollments: [] },
      {
        student_id: 's2', request_type: '휴원요청', leave_sub_type: '실휴원',
        leave_start_date: '2099-01-01', leave_end_date: '2099-02-01',
        status: 'approved', use_server_finalize: true,
      },
    );
    const lr = (await lrRef.get()).data();
    await finalize(lrRef, lr);
    const stu = (await db.doc('students/s2').get()).data();
    expect(stu.status).toBe('재원');
    expect(stu.scheduled_leave_status).toBe('실휴원');
    expect(stu.pause_start_date).toBe('2099-01-01');
  });

  it('휴원→퇴원: pause_* 삭제, status=퇴원', async () => {
    const lrRef = await seed(
      {
        id: 's3', name: '이민호', status: '실휴원',
        pause_start_date: '2026-01-01', pause_end_date: '2026-12-31',
        enrollments: [{ class_type: '정규', class_number: '101', day: ['월'] }],
      },
      {
        student_id: 's3', request_type: '휴원→퇴원', withdrawal_date: '2026-04-21',
        status: 'approved', use_server_finalize: true,
      },
    );
    const lr = (await lrRef.get()).data();
    await finalize(lrRef, lr);
    const stu = (await db.doc('students/s3').get()).data();
    expect(stu.status).toBe('퇴원');
    expect(stu.pause_start_date).toBeUndefined();
    expect(stu.pause_end_date).toBeUndefined();
  });
});
```

- [ ] **Step 2: Emulator 시작 (별도 터미널)**

```bash
cd ~/projects/impact7DB && firebase emulators:start --only firestore --project=impact7db-test
```

Wait until "All emulators ready!".

- [ ] **Step 3: 테스트 실행**

```bash
cd ~/projects/impact7DB/functions && npm test finalize.integration
```

Expected: 3개 케이스 PASS.

- [ ] **Step 4: Emulator 종료 + 커밋**

```bash
cd ~/projects/impact7DB
git add functions/test/finalize.integration.test.js
git commit -m "test(functions): integration tests for finalize against Firestore emulator"
```

---

## Phase 3 — Cloud Function 배포 (no-op)

이 단계에서 함수는 배포되지만 어떤 leave_request에도 `use_server_finalize: true`가 없으므로 발동되지 않는다.

### Task 3.1: Cloud Function 배포

- [ ] **Step 1: Firebase 프로젝트 확인**

```bash
cd ~/projects/impact7DB && firebase projects:list
```

Expected: `impact7db` 표시. 아니면 `firebase use impact7db`.

- [ ] **Step 2: 배포**

```bash
cd ~/projects/impact7DB && firebase deploy --only functions
```

Expected: `Deploy complete!` + 함수 URL 표시.
첫 배포 시 Cloud Build, Eventarc 등 API 활성화 안내가 나오면 콘솔에서 활성화.

- [ ] **Step 3: 배포 확인**

```bash
firebase functions:list
```

Expected: `onLeaveRequestApproved` 표시, region=asia-northeast3.

- [ ] **Step 4: 로그 모니터 (별도 터미널)**

```bash
firebase functions:log --only onLeaveRequestApproved
```

이 단계에서는 발동 로그 없음(=정상).

---

## Phase 4 — Firestore Rules 업데이트

### Task 4.1: leave_requests 허용 필드 확장

**Files:**
- Modify: `~/projects/impact7DB/firestore.rules` (line 478-491)

- [ ] **Step 1: 룰 수정**

`firestore.rules`의 `hasOnlyAllowedLeaveRequestFields` 함수를 다음으로 교체:

```
function hasOnlyAllowedLeaveRequestFields() {
  return request.resource.data.keys().hasOnly([
    'student_id', 'student_name', 'branch', 'class_codes',
    'request_type', 'leave_sub_type',
    'leave_start_date', 'leave_end_date', 'withdrawal_date',
    'student_phone', 'parent_phone_1',
    'consultation_note', 'status',
    'requested_by', 'requested_at',
    'approved_by', 'approved_at',
    'teacher_approved_by', 'teacher_approved_at',
    'return_date',
    'previous_status', 'created_at', 'updated_by', 'updated_at',
    'target_class_code', 'use_server_finalize',
    'finalized_at', 'finalize_error', 'finalize_attempts'
  ]);
}
```

그리고 `allow create, update` 블록에 admin 필드 차단 추가:

```
allow create, update: if isAuthorized()
  && hasOnlyAllowedLeaveRequestFields()
  && request.resource.data.status is string
  && request.resource.data.status in ['requested', 'approved', 'rejected', 'cancelled']
  && withinFieldLimit(30)
  && !affectsAdminFields();

function affectsAdminFields() {
  let admin = ['finalized_at', 'finalize_error', 'finalize_attempts'];
  return resource != null
    && request.resource.data.diff(resource.data).affectedKeys().hasAny(admin);
}
```

`withinFieldLimit(25)` → `withinFieldLimit(30)`.

- [ ] **Step 2: rules 문법 검증**

```bash
cd ~/projects/impact7DB && firebase deploy --only firestore:rules --dry-run
```

Expected: `Compilation successful`.

- [ ] **Step 3: 커밋 (배포는 Task 4.2에서 4-repo 동기화 후)**

```bash
cd ~/projects/impact7DB
git add firestore.rules
git commit -m "feat(rules): allow leave_request new fields + block admin fields"
```

---

### Task 4.2: 4개 프로젝트 rules 동기화 + 배포

- [ ] **Step 1: rules-sync 스킬 호출**

이 task는 `firestore-rules-sync` 스킬을 사용해 4개 프로젝트(impact7DB, impact7newDSC, impact7HR, impact7exam)에 같은 룰을 복사하고 impact7DB에서 배포한다.

명령:
```
사용자에게 "firestore-rules-sync 스킬 실행해서 4개 프로젝트에 룰 동기화 + impact7DB에서 배포" 요청
```

- [ ] **Step 2: 배포 확인**

Firebase 콘솔 > Firestore > Rules 에서 새 룰이 반영됐는지 확인.

- [ ] **Step 3: 클라이언트가 admin 필드 write 시도 → 거부 확인 (수동)**

브라우저 콘솔에서:
```js
firebase.firestore().collection('leave_requests').doc('TEST').update({ finalized_at: new Date() })
```
Expected: `permission-denied` 에러.

---

## Phase 5 — 클라이언트 (DSC) 변경

### Task 5.1: 모달 HTML — 정규반 드롭다운 추가

**Files:**
- Modify: `~/projects/impact7newDSC/index.html` — `#return-from-leave-modal` 영역

- [ ] **Step 1: 현재 모달 구조 확인**

```bash
grep -n "return-from-leave-modal" ~/projects/impact7newDSC/index.html
```

찾은 영역의 `rfl-return-date` 필드 다음 줄에 추가.

- [ ] **Step 2: HTML 추가**

`#return-from-leave-modal` 안의 폼 필드 영역에 추가:

```html
<div id="rfl-target-class-wrap" style="margin-top:12px;">
    <label style="font-size:12px;font-weight:600;margin-bottom:4px;display:block;">
        복귀할 정규반
    </label>
    <select id="rfl-target-class" class="field-input" style="width:100%;"
            onchange="window._onRflTargetClassChange?.()">
        <option value="">-- 반 선택 --</option>
    </select>
    <div id="rfl-target-class-hint" style="font-size:11px;color:var(--text-sec);margin-top:4px;"></div>
</div>
```

- [ ] **Step 3: 커밋**

```bash
cd ~/projects/impact7newDSC
git add index.html
git commit -m "feat(dsc): add target class dropdown to return modal"
```

---

### Task 5.2: `_openReturnModal` — 드롭다운 채우기

**Files:**
- Modify: `~/projects/impact7newDSC/leave-request.js` — `_openReturnModal` 함수 (line 908-942 부근)

- [ ] **Step 1: 함수 끝 부분 수정**

`_openReturnModal` 마지막의 `document.getElementById('return-from-leave-modal').style.display = 'flex';` 줄 **앞에** 추가:

```js
    // 정규반 드롭다운 채우기 (branch+level 필터)
    const branch = branchFromStudent(student);
    const level = student.level || '';
    const select = document.getElementById('rfl-target-class');
    select.innerHTML = '<option value="">-- 반 선택 --</option>';
    const candidates = Object.entries(state.classSettings || {})
        .filter(([code, cs]) => {
            if (cs.class_type && cs.class_type !== '정규') return false;
            // class_settings에 branch/level 메타가 있다면 필터 (없으면 전체 노출)
            if (branch && cs.branch && cs.branch !== branch) return false;
            if (level && cs.level && cs.level !== level) return false;
            return true;
        })
        .sort(([a], [b]) => a.localeCompare(b));
    for (const [code, cs] of candidates) {
        const days = (cs.default_days || Object.keys(cs.schedule || {})).join('·');
        const opt = document.createElement('option');
        opt.value = code;
        opt.textContent = days ? `${code} (${days})` : code;
        select.appendChild(opt);
    }
    // 기존 정규 enrollment의 class_number를 기본값으로
    const existingReg = (student.enrollments || []).find(e =>
        (!e.class_type || e.class_type === '정규') && e.class_number
    );
    if (existingReg) {
        const existingCode = `${existingReg.level_symbol || ''}${existingReg.class_number || ''}`;
        if (candidates.some(([c]) => c === existingCode)) {
            select.value = existingCode;
        }
    }
    document.getElementById('rfl-target-class-hint').textContent =
        select.value ? `현재 선택: ${select.value}` : '복귀할 반을 선택하세요';

    window._onRflTargetClassChange = () => {
        const code = select.value;
        document.getElementById('rfl-target-class-hint').textContent =
            code ? `선택: ${code}` : '복귀할 반을 선택하세요';
    };
```

- [ ] **Step 2: dev 서버 띄우고 모달 동작 확인**

```bash
cd ~/projects/impact7newDSC && npm run dev
```

브라우저에서 휴원/퇴원 학생 → 복귀/재등원 버튼 → 모달 → 드롭다운에 반 목록 + 기본값 자동 선택 확인.

- [ ] **Step 3: 커밋**

```bash
cd ~/projects/impact7newDSC
git add leave-request.js
git commit -m "feat(dsc): populate target class dropdown in return modal"
```

---

### Task 5.3: `submitReturnFromLeave` — `target_class_code` + `use_server_finalize` 저장

**Files:**
- Modify: `~/projects/impact7newDSC/leave-request.js` — `submitReturnFromLeave` 함수 (line 952-998)

- [ ] **Step 1: 함수 수정**

`const note = document.getElementById('rfl-consultation-note').value.trim();` 다음에 추가:

```js
    const targetClassCode = document.getElementById('rfl-target-class').value || '';
    if (!targetClassCode) {
        alert('복귀할 반을 선택해주세요.');
        return;
    }
```

`data` 객체에 두 필드 추가:

```js
        const data = {
            student_id: _returnModalStudentId,
            student_name: student.name,
            branch: branchFromStudent(student),
            class_codes: activeClassCodes(student, state.selectedDate),
            request_type: _returnModalType,
            return_date: returnDate,
            target_class_code: targetClassCode,    // 신규
            use_server_finalize: true,              // 신규
            student_phone: student.student_phone || '',
            parent_phone_1: student.parent_phone_1 || '',
            consultation_note: note,
            status: 'requested',
            previous_status: student.status || '',
            requested_by: state.currentUser?.email || '',
            requested_at: serverTimestamp(),
            created_at: serverTimestamp()
        };
```

- [ ] **Step 2: 동작 확인**

dev 서버에서 재등원/복귀 요청 생성 → Firestore 콘솔에서 leave_requests 문서에 `target_class_code`, `use_server_finalize: true` 들어갔는지 확인.

- [ ] **Step 3: 커밋**

```bash
cd ~/projects/impact7newDSC
git add leave-request.js
git commit -m "feat(dsc): persist target_class_code + use_server_finalize on return request"
```

---

### Task 5.4: 클라이언트 `_finalizeLeaveDSC` 호출 제거

**Files:**
- Modify: `~/projects/impact7newDSC/leave-request.js` — `teacherApproveLeaveRequest`, `approveLeaveRequest`

- [ ] **Step 1: 두 함수에서 `await _finalizeLeaveDSC(r, studentId);` 호출 제거**

`teacherApproveLeaveRequest` (line 703-710 부근)에서:

```js
        if (r.approved_by) {
            await _finalizeLeaveDSC(r, studentId);   // ← 이 줄 제거
        } else {
            showSaveIndicator('saved');
            ...
        }
```

`approveLeaveRequest` (line 755-762 부근)에서 동일하게 `_finalizeLeaveDSC` 호출 제거.

`if/else` 분기를 합쳐 단순화:

```js
        showSaveIndicator('saved');
        renderSubFilters();
        if (state.currentCategory === 'admin' && state.currentSubFilter.has('leave_request')) {
            renderLeaveRequestList();
        }
        renderStudentDetail(studentId);
```

- [ ] **Step 2: `_finalizeLeaveDSC` 함수 자체는 삭제하지 않고 보존** (Phase 6 정리 단계까지 안전망)

- [ ] **Step 3: dev 서버에서 휴원요청 승인 → Firestore에서 student 문서가 1~2초 후 (Cloud Function이) 업데이트되는지 확인**

- [ ] **Step 4: 커밋**

```bash
cd ~/projects/impact7newDSC
git add leave-request.js
git commit -m "feat(dsc): remove client-side _finalizeLeaveDSC, server handles transition"
```

---

### Task 5.5: 레거시 요청 처리 + finalize_error 배지

**Files:**
- Modify: `~/projects/impact7newDSC/leave-request.js`

- [ ] **Step 1: 승인 함수에 `use_server_finalize` 자동 세팅 + 레거시 가드**

`teacherApproveLeaveRequest`와 `approveLeaveRequest` 둘 다, 승인 write 직전에 추가:

```js
    // 레거시 요청에 use_server_finalize 플래그 추가
    if (!r.use_server_finalize) {
        const isReturn = r.request_type === '복귀요청' || r.request_type === '재등원요청';
        if (isReturn && !r.target_class_code) {
            alert('이 요청은 새 버전 이전에 생성되어 복귀할 반 정보가 없습니다.\n요청을 취소하고 다시 작성해주세요.');
            return;
        }
        updates.use_server_finalize = true;
    }
```

- [ ] **Step 2: finalize_error 배지 — `_renderLRRow`에 추가**

`leave-request.js`의 `_renderLRRow` 함수 (line 349 근처) 안 `actionsHtml` 정의 위에 추가:

```js
    const errorHtml = r.finalize_error
        ? `<div style="margin-top:6px;padding:6px 8px;background:#fee2e2;color:#b91c1c;border-radius:4px;font-size:11px;">
            <strong>서버 처리 실패:</strong> ${esc(r.finalize_error)}
            <button class="lr-btn lr-btn-outlined" style="margin-left:8px;font-size:10px;padding:2px 6px;"
                onclick="window._retryFinalize?.('${escAttr(r.docId)}')">재시도</button>
           </div>`
        : '';
```

그리고 리턴 템플릿에 `${errorHtml}` 삽입 (noteHtml 위).

`_retryFinalize` 헬퍼 함수도 추가:

```js
window._retryFinalize = async (docId) => {
    if (!confirm('서버 처리를 재시도합니다. 진행할까요?')) return;
    try {
        // finalized_at 없는 상태로 재트리거: status를 잠시 'requested'로 → 다시 'approved'
        await auditUpdate(doc(db, 'leave_requests', docId), { status: 'requested' });
        await new Promise(r => setTimeout(r, 500));
        await auditUpdate(doc(db, 'leave_requests', docId), { status: 'approved' });
        showSaveIndicator('saved');
    } catch (err) {
        alert('재시도 실패: ' + err.message);
    }
};
```

- [ ] **Step 3: 커밋**

```bash
cd ~/projects/impact7newDSC
git add leave-request.js
git commit -m "feat(dsc): legacy request guard + finalize_error UI with retry"
```

---

## Phase 6 — 클라이언트 (impact7DB) 변경

### Task 6.1: 모달 HTML 추가

**Files:**
- Modify: `~/projects/impact7DB/index.html` — `#return-from-leave-modal`

- [ ] **Step 1: Task 5.1과 동일한 HTML을 impact7DB의 모달에 추가**

```bash
grep -n "return-from-leave-modal" ~/projects/impact7DB/index.html
```

찾은 영역의 `rfl-return-date` 다음에 Task 5.1과 동일한 `rfl-target-class-wrap` 블록 삽입.

- [ ] **Step 2: 커밋**

```bash
cd ~/projects/impact7DB
git add index.html
git commit -m "feat(db): add target class dropdown to return modal"
```

---

### Task 6.2: `_openReturnModal` 수정

**Files:**
- Modify: `~/projects/impact7DB/app.js` — `_openReturnModal` (line 4673-4701)

- [ ] **Step 1: Task 5.2와 동일 로직 추가**

`document.getElementById('return-from-leave-modal').style.display = 'flex';` 직전에 다음 코드 삽입 (DSC와 변수명 차이만 주의: `state.allStudents` → `allStudents`, `state.classSettings` → `classSettings`):

```js
    // 정규반 드롭다운 채우기
    const branch = branchFromStudent(student);
    const level = student.level || '';
    const select = document.getElementById('rfl-target-class');
    select.innerHTML = '<option value="">-- 반 선택 --</option>';
    const candidates = Object.entries(classSettings || {})
        .filter(([code, cs]) => {
            if (cs.class_type && cs.class_type !== '정규') return false;
            if (branch && cs.branch && cs.branch !== branch) return false;
            if (level && cs.level && cs.level !== level) return false;
            return true;
        })
        .sort(([a], [b]) => a.localeCompare(b));
    for (const [code, cs] of candidates) {
        const days = (cs.default_days || Object.keys(cs.schedule || {})).join('·');
        const opt = document.createElement('option');
        opt.value = code;
        opt.textContent = days ? `${code} (${days})` : code;
        select.appendChild(opt);
    }
    const existingReg = (student.enrollments || []).find(e =>
        (!e.class_type || e.class_type === '정규') && e.class_number
    );
    if (existingReg) {
        const existingCode = `${existingReg.level_symbol || ''}${existingReg.class_number || ''}`;
        if (candidates.some(([c]) => c === existingCode)) {
            select.value = existingCode;
        }
    }
    document.getElementById('rfl-target-class-hint').textContent =
        select.value ? `현재 선택: ${select.value}` : '복귀할 반을 선택하세요';
    window._onRflTargetClassChange = () => {
        const code = select.value;
        document.getElementById('rfl-target-class-hint').textContent =
            code ? `선택: ${code}` : '복귀할 반을 선택하세요';
    };
```

- [ ] **Step 2: 커밋**

```bash
cd ~/projects/impact7DB
git add app.js
git commit -m "feat(db): populate target class dropdown in return modal"
```

---

### Task 6.3: `submitReturnFromLeave` 수정

**Files:**
- Modify: `~/projects/impact7DB/app.js` — `submitReturnFromLeave` (line 4706-4751)

- [ ] **Step 1: `target_class_code` + `use_server_finalize` 추가**

`const note = ...` 다음에:

```js
        const targetClassCode = document.getElementById('rfl-target-class').value || '';
        if (!targetClassCode) { alert('복귀할 반을 선택해주세요.'); return; }
```

`data` 객체에 두 필드 추가 (Task 5.3과 동일).

- [ ] **Step 2: 커밋**

```bash
cd ~/projects/impact7DB
git add app.js
git commit -m "feat(db): persist target_class_code + use_server_finalize"
```

---

### Task 6.4: `_finalizeLeaveRequest` 호출 제거 + 레거시 가드 + finalize_error UI

**Files:**
- Modify: `~/projects/impact7DB/app.js` — `teacherApproveLeaveRequest`, `approveLeaveRequest` (line 4772-4866), `_finalizeLeaveRequest` 본문은 보존

- [ ] **Step 1: 두 승인 함수에서 `await _finalizeLeaveRequest(r, studentId);` 제거** (Task 5.4와 동일 패턴)

- [ ] **Step 2: 승인 write 직전에 레거시 가드 추가** (Task 5.5와 동일 코드)

- [ ] **Step 3: 휴퇴원요청서 카드 렌더에 finalize_error 배지 추가** (Task 5.5와 동일 코드, impact7DB의 해당 렌더 함수 위치 찾아서)

- [ ] **Step 4: 커밋**

```bash
cd ~/projects/impact7DB
git add app.js
git commit -m "feat(db): remove client-side _finalizeLeaveRequest, server handles transition"
```

---

## Phase 7 — 배포 + 검증

### Task 7.1: 두 클라이언트 동시 배포

- [ ] **Step 1: pre-deploy 점검 — DSC**

```bash
cd ~/projects/impact7newDSC
```

`pre-deploy` 스킬 호출. 빌드 + rules 동기화 + 코드 품질 확인.

- [ ] **Step 2: DSC 푸시 (자동 배포)**

```bash
git push origin master
```

GitHub Actions가 자동 배포. Actions 탭에서 성공 확인.

- [ ] **Step 3: pre-deploy 점검 — impact7DB**

```bash
cd ~/projects/impact7DB
```

`pre-deploy` 스킬 호출.

- [ ] **Step 4: impact7DB 배포**

```bash
firebase deploy --only hosting
```

또는 GitHub Actions가 있다면 푸시.

---

### Task 7.2: 프로덕션 스모크 테스트

- [ ] **Step 1: 테스트 학생 1명에 대해 전체 흐름 검증 (DSC)**

1. DSC에서 테스트 학생에게 휴원요청 생성 (오늘 시작일)
2. 교수부 승인 → 행정부 승인
3. 1~2초 후 학생 status가 '실휴원'으로 바뀌는지 확인
4. Cloud Function 로그 확인:
   ```bash
   cd ~/projects/impact7DB && firebase functions:log --only onLeaveRequestApproved -n 20
   ```
5. `leave_requests` 문서에 `finalized_at` 채워졌는지 확인

- [ ] **Step 2: 재등원 + 반 변경 시나리오 (DSC)**

1. 테스트 학생을 퇴원으로 만든 후, DSC에서 재등원요청 생성 + A102 반 선택
2. 양쪽 승인
3. `students` 문서의 `enrollments`가 A102 정규로 교체됐는지 확인
4. `history_logs`에 RETURN 이벤트 1건 추가됐는지 확인

- [ ] **Step 3: impact7DB에서도 동일 시나리오 반복**

- [ ] **Step 4: 동시 작업 시나리오** (선택)

DSC에서 승인 직후 impact7DB에서 student 문서를 만져도, Function이 단일 처리만 했는지 history_logs로 확인.

---

### Task 7.3: 1~2일 모니터링

- [ ] **Step 1: 매일 1회 finalize_error 검색**

```bash
cd ~/projects/impact7newDSC
node -e "
import('firebase-admin').then(async fa => {
  const { initializeApp, applicationDefault } = await import('firebase-admin/app');
  const { getFirestore } = await import('firebase-admin/firestore');
  initializeApp({ credential: applicationDefault(), projectId: 'impact7db' });
  const snap = await getFirestore().collection('leave_requests').where('finalize_error', '!=', null).get();
  console.log('finalize_error count:', snap.size);
  snap.forEach(d => console.log(d.id, d.data().finalize_error));
});
"
```

- [ ] **Step 2: Cloud Function 로그에 ERROR 없는지 확인**

```bash
firebase functions:log --only onLeaveRequestApproved -n 100 | grep -i error
```

- [ ] **Step 3: 이슈 없으면 Phase 8로 진행**

---

## Phase 8 — 정리 (use_server_finalize 플래그 제거)

### Task 8.1: Function에서 플래그 가드 제거

**Files:**
- Modify: `~/projects/impact7DB/functions/index.js`

- [ ] **Step 1: `if (!after.use_server_finalize) return null;` 줄 제거**

- [ ] **Step 2: 재배포**

```bash
cd ~/projects/impact7DB && firebase deploy --only functions
```

- [ ] **Step 3: 커밋**

```bash
git add functions/index.js
git commit -m "refactor(functions): remove use_server_finalize flag, always process"
```

---

### Task 8.2: 클라이언트에서 플래그 세팅 제거

**Files:**
- Modify: `~/projects/impact7newDSC/leave-request.js`
- Modify: `~/projects/impact7DB/app.js`

- [ ] **Step 1: 양쪽 `submitReturnFromLeave` + `submitLeaveRequest`에서 `use_server_finalize: true` 제거**
- [ ] **Step 2: 양쪽 승인 함수에서 레거시 가드의 플래그 추가 코드 제거** (반 선택 가드는 유지)
- [ ] **Step 3: 양쪽 `_finalizeLeaveDSC` / `_finalizeLeaveRequest` 함수 자체 삭제**
- [ ] **Step 4: 두 레포 각각 커밋**

```bash
cd ~/projects/impact7newDSC
git add leave-request.js
git commit -m "refactor(dsc): remove use_server_finalize flag and legacy _finalizeLeaveDSC"
```

```bash
cd ~/projects/impact7DB
git add app.js
git commit -m "refactor(db): remove use_server_finalize flag and legacy _finalizeLeaveRequest"
```

- [ ] **Step 5: 양쪽 배포**

DSC: `git push origin master` (Actions 자동)
impact7DB: `firebase deploy --only hosting`

---

### Task 8.3: rules에서 use_server_finalize 필드 제거 (선택)

이 필드는 더 이상 클라이언트가 쓰지 않지만 룰에서 명시적으로 제외할 필요는 없음 (다른 필드와 동일하게 허용 목록에 둬도 무해). 정리하고 싶다면 4-repo rules-sync로 제거 후 재배포.

---

## 마이그레이션 후 — 유시우 데이터 복구 (별도 one-off)

이 플랜의 범위 밖이지만, Phase 8 완료 후 별도 스크립트로:

1. `students/유시우_1030485220` `status` → `재원`
2. `enrollments`에서 내신 A103 제거, 정규 A101 (월·금) 추가
3. `pause_*` 필드 삭제
4. history_logs에 복구 기록

`scripts/oneoff/restore-yoosiwoo.mjs` 작성 후 실행.

---

## 자체 점검 (Self-Review)

- ✅ 스펙의 모든 섹션을 task로 매핑함 (아키텍처/스키마/Function/클라이언트/rules/마이그레이션/테스트)
- ✅ 모든 step에 실제 코드 또는 명령 포함
- ✅ 함수 시그니처 일관성 (parseClassCode, replaceRegularEnrollment, deduplicateName, buildUpdate, finalize)
- ✅ 파일 경로 절대경로로 명시 (~/projects/impact7DB, ~/projects/impact7newDSC)
- ✅ TDD 패턴 (테스트 먼저 → FAIL 확인 → 구현 → PASS → 커밋)
- ✅ 커밋 메시지에 `feat(scope)` / `test(scope)` / `refactor(scope)` prefix
- ⚠️ Phase 4.2(rules-sync) 와 Phase 7.1(pre-deploy)는 사용자가 보유한 스킬에 위임 — 플랜에서 직접 명령을 쓰는 것보다 스킬 호출이 안전
- ⚠️ Phase 6(impact7DB)은 Phase 5(DSC)와 동일 패턴 반복이므로 의도적으로 간략 표기. 실제 구현 시 변수명 차이(state. prefix 유무)에 주의
