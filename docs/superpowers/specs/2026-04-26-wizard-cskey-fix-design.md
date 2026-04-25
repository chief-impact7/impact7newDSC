# 반편성 마법사 csKey 형식 수정

**날짜:** 2026-04-26
**대상:** `class-setup.html`, `class-setup.js`
**관련 메모:** `.memory/project_class_setup_wizard_cskey_bug.md`
**계기:** 2026-04-26 오소윤 사고 — 정규 식별 버그(67c92d0)와 별개로, 마법사 자체가 잘못된 형식의 class_settings doc을 만들어왔음을 발견

## 문제

마법사가 만든 내신반의 csKey 형식이 메인 앱 `resolveNaesinCsKey`의 자동 유도와 불일치한다.

| | 형식 | 예시 |
|---|---|---|
| 마법사 (현재) | `${school}${grade}${group}` | `염경1B` |
| 메인 앱 자동 유도 | `${branch}${school}${levelShort}${grade}${group}` | `2단지염경중1B` |

결과: 마법사로 만든 `class_settings` doc의 id가 학생의 정규 enrollment에서 도출되는 csKey와 달라, 학생이 내신반에 매핑되지 않음.

## 도메인 제약

- 내신은 정규의 일시적 전환 (내신 종료 후 정규 복귀)
- 내신 기간엔 다른 지점/다른 그룹/다른 요일에서 합반 가능 → csKey의 `branch`/`group`은 학생의 branch/group과 다를 수 있음
- 학교/학년/level은 동일 (다른 학교·학년·level 합반은 운영 사례 없음)

## 설계

### 1. UI — `class-setup.html` step 2 (내신)

`#name-naesin` 안 학교 입력 form-row **위에** 새 form-row 추가:

- `<select id="input-naesin-branch">` — 옵션: `2단지` / `10단지`
- `<select id="input-naesin-level">` — 옵션: `중` / `고`

라벨: "지점", "과정"

### 2. csKey 형식 — `class-setup.js`

`buildClassCode`의 내신 분기:
```js
if (t === '내신') {
    const br = document.getElementById('input-naesin-branch').value;
    const lv = document.getElementById('input-naesin-level').value;
    const s = document.getElementById('input-school').value.trim();
    const g = document.getElementById('input-grade').value;
    const grp = document.getElementById('input-naesin-group').value;
    if (!br || !lv || !s || !g || !grp) return '';
    wizardData.naesinBranch = br;
    wizardData.naesinLevel = lv;
    wizardData.school = s;
    wizardData.grade = g;
    wizardData.naesinGroup = grp;
    wizardData.classCode = `${br}${s}${lv}${g}${grp}`;
    return wizardData.classCode;
}
```

`wizardData`에 `naesinBranch`, `naesinLevel` 필드 추가.

### 3. 학생 추가 검증 — `addStudent`

내신 마법사일 때 학생의 `school` / `LEVEL_SHORT[level]` / `grade`가 마법사 입력과 다르면 **차단** + toast 안내. branch/group은 자유.

```js
window.addStudent = function (docId) {
    if (wizardData.students.some(s => s.docId === docId)) return;
    const found = allStudents.find(s => s.docId === docId);
    if (!found) return;

    if (wizardData.classType === '내신') {
        const studentLevel = LEVEL_SHORT[found.level] || '';
        if (found.school !== wizardData.school) {
            showToast(`학교 불일치: 마법사(${wizardData.school}) vs 학생(${found.school || '미지정'})`, 'error');
            return;
        }
        if (studentLevel !== wizardData.naesinLevel) {
            showToast(`과정 불일치: 마법사(${wizardData.naesinLevel}) vs 학생(${studentLevel || '미지정'})`, 'error');
            return;
        }
        if (String(found.grade) !== String(wizardData.grade)) {
            showToast(`학년 불일치: 마법사(${wizardData.grade}) vs 학생(${found.grade || '미지정'})`, 'error');
            return;
        }
    }

    wizardData.students.push(found);
    renderSelectedStudents();
    // ... 기존 reset/focus 로직
};
```

`LEVEL_SHORT`는 `state.js`에서 import.

### 4. submitWizard — `naesin_class_override` 자동 설정

내신 마법사 submit 시, 기존 batch에서 학생별로:
1. 학생 doc 읽어 현재 `enrollments` 가져오기
2. 정규/자유학기 enrollment 찾아 `naesin_class_override = csKey` 박기
3. 새 내신 enrollment array에 추가
4. 전체 `enrollments` 배열을 set (arrayUnion 못 씀)

```js
if (d.classType === '내신') {
    const studentSnap = await getDoc(studentRef);
    const currentEnrollments = studentSnap.data()?.enrollments || [];
    const updated = currentEnrollments.map(e =>
        (e.class_type === '정규' || e.class_type === '자유학기')
            ? { ...e, naesin_class_override: d.classCode }
            : e
    );
    updated.push(newEnrollment);
    batchUpdate(batch, studentRef, { enrollments: updated });
} else {
    batchUpdate(batch, studentRef, {
        enrollments: arrayUnion(newEnrollment),
    });
}
```

기존 batch는 유지하되 내신만 분기. read는 batch 밖에서 발생하지만 1인 학원 마법사 동시 실행 가능성 낮음 → race condition 허용.

### 5. 비목적 (이번 PR 범위 외)

- 이미 잘못된 형식으로 production에 만들어진 `class_settings` doc 조사·정리 → 다음 세션, `firestore-data-fix` 스킬로 별도 진행
- 정규 enrollment에 이미 있는 `naesin_class_override`가 다른 csKey면 마법사가 덮어씀 (의도된 동작)

## 영향 범위

| 파일 | 변경 |
|---|---|
| `class-setup.html` | step 2 내신 섹션에 branch/level 드롭다운 추가 |
| `class-setup.js` | `wizardData`, `buildClassCode`, `addStudent`, `submitWizard` |
| `state.js` | (참조만, 변경 없음) `LEVEL_SHORT` import |

학생 데이터 / class_settings 스키마 변경 없음 → Firestore rules 영향 없음.

## 검증 시나리오

1. **정상 케이스**: 마법사로 "2단지 / 중 / 염경중 / 1학년 / A" 내신반 생성 → csKey "2단지염경중1A" doc 생성, 선택한 학생들의 정규 enrollment에 `naesin_class_override = "2단지염경중1A"` 세팅 → 메인 앱에서 정상 매핑
2. **학교 불일치 차단**: 마법사 "염경중" 반에 다른 학교 학생 추가 시도 → toast 차단
3. **branch 자유**: 마법사 "2단지" 내신반에 10단지 정규 학생 추가 → 통과 (override 박힘 → 메인 앱 매핑 OK)
4. **group 자유**: 마법사 "A" 내신반에 정규 class_number 끝자리 짝수 학생(자동 유도하면 B) 추가 → 통과
5. **자유학기 학생**: 자유학기 enrollment를 가진 학생도 `naesin_class_override` 동일하게 박힘
