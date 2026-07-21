---
name: firestore-rules-sync
description: "Firestore Security Rules를 4개 프로젝트(impact7DB·impact7newDSC·impact7HR·impact7exam)에 동기화하는 런북. 'rules 동기화', 'firestore.rules 수정했어', '4개 프로젝트 동기화', 'rules 복사해줘', 'rules 맞춰줘', '규칙 파일 맞추기', 'rules가 달라', '배포 전 rules 확인', 'rules 불일치' 요청 시 반드시 이 스킬을 사용. pre-deploy 하네스가 자동으로 호출하기도 함. 후속: 'rules 다시 확인', '동기화 됐어?', '배포는', '나머지 프로젝트 커밋' 시에도 사용."
---

# Firestore Rules 동기화

이 프로젝트는 impact7DB, impact7newDSC, impact7HR, impact7exam이 **동일한 Firebase 프로젝트(impact7db)**를 공유한다.
`firestore.rules`는 4개 프로젝트가 반드시 동일해야 한다. (impact7qbank은 firestore.rules 없음)

## 프로젝트 경로

- `/Users/jongsooyi/IMPACT7/impact7DB/firestore.rules`
- `/Users/jongsooyi/IMPACT7/impact7newDSC/firestore.rules`
- `/Users/jongsooyi/IMPACT7/impact7HR/firestore.rules`
- `/Users/jongsooyi/IMPACT7/impact7exam/firestore.rules`

## 실행 절차

1. **변경 감지**: 4개 파일을 `diff`로 비교하여 불일치 확인
2. **기준 파일 결정**: 가장 최근에 수정된 파일을 기준으로 삼는다 (`ls -lt`로 확인)
3. **사용자 확인**: 동기화 전 변경 내용(diff)을 보여주고 사용자 승인을 받는다
4. **복사**: 기준 파일을 나머지 3개 프로젝트에 `cp`로 복사
5. **검증**: 복사 후 다시 `diff`로 4개 파일이 동일한지 확인
6. **결과 보고**: 동기화 완료 여부와 배포 안내 ("배포는 impact7DB에서 권장")

## 주의사항

- `students` 컬렉션: 클라이언트 삭제 완전 차단 (`allow delete: if false`) 규칙이 반드시 포함되어야 함
- HR 앱의 사용자 컬렉션은 `director_users` (DB의 `users`와 분리)
- 동기화 후 배포는 impact7DB 프로젝트에서만 하는 것을 권장
