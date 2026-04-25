---
name: 반편성 마법사 csKey branch 접두사 누락 (미해결)
description: class-setup.js의 마법사가 내신 class_settings 만들 때 csKey 형식이 잘못됨 — 별도 PR 필요
type: project
---

`class-setup.js`(반편성 도우미)의 내신 반 생성 시 csKey 형식이 메인 앱의 자동 유도와 불일치한다.

## 현재 (버그)
```js
// class-setup.js:289
wizardData.classCode = `${school}${grade}${group}`;  // 예: "염경1B"
```
- branch 접두사 없음
- LEVEL_SHORT 없음 → 학교명에 '중'/'고'가 안 붙어 있으면 빠짐
- 결과: 메인 앱 `resolveNaesinCsKey`가 만드는 키와 다른 doc id가 만들어짐

## 메인 앱 자동 유도 (정상)
```js
// student-helpers.js
return branchFromStudent(s) + `${school}${LEVEL_SHORT[level]}${grade}${group}`;
// 예: "2단지염경중1B"
```

## 수정 방향
1. 마법사가 csKey 만들 때 `${branch}${school}${levelShort}${grade}${group}` 형식 사용
   - branch는 학생 추가 단계에서 첫 학생의 branch 또는 사용자가 마법사에서 선택
   - levelShort는 grade로부터 추정 또는 학교 학년 분류로 결정
2. 학생 추가 시 정규 enrollment에 `naesin_class_override = csKey` 설정 (자동 유도 우회 + 명시적 매핑)
3. 동일 branch+school+grade+group의 class_settings 중복 생성 방지 (체크 + 경고)

## 영향
- 다른 학생도 마법사로 내신 반 추가 시 같은 문제 가능성
- 현재 production class_settings에 잘못된 형식 doc이 더 있을 수 있음 (조사 필요)

**Why:** 2026-04-26 오소윤 사고에서 발견. 정규 식별 버그(67c92d0)와 별개로, 마법사 자체도 잘못된 형식의 doc을 만들어왔음.
**How to apply:** 별도 세션에서 이 메모리 읽고 수정 진행. 이전에 잘못 생성된 class_settings doc 정리도 같이.
