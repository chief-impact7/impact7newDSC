---
name: rules 동기화 후 4-repo 커밋 규율
description: firestore.rules 수정·배포 후 4개 repo 중 일부만 커밋되고 나머지가 uncommitted 상태로 방치되는 패턴 방지 — 2026-04-09 발견
type: feedback
---

`firestore.rules` 변경 작업이 끝나면 **4개 repo(DB/DSC/HR/exam) 모두에서 해당 파일이 clean한지 `git status`로 검증**한 뒤에야 작업 완료로 간주한다. 한 repo라도 uncommitted로 남아있으면 미완료.

**Why**: 2026-04-09, DSC의 class_settings에 `special_start`/`special_end` 필드 추가 작업에서 4개 repo에 일괄 파일 복사(mtime 17:03:12 초 단위 동일)되고 impact7DB에서 `firebase deploy --only firestore:rules` 실행됨. 하지만 DSC만 커밋/푸시(`5e759cd`)되고 **DB/HR/exam 3개 repo는 uncommitted로 수 시간 방치**. Phase 5 작업 중 `git status`로 우연히 발견해 사후 정리 커밋(`e233496`/`06f7927`/`c91d11a`).

원인:
- 기능 작업 repo(DSC)만 "본 작업"으로 인식, 나머지 3개는 "단순 파일 복사"로 취급되어 커밋 인식 밖
- 외부 `cp`/스크립트로 파일이 수정되면 편집기 세션 밖이라 "저장→커밋" 습관이 트리거되지 않음
- 한 Claude 세션은 하나의 repo 컨텍스트에 집중 → 다른 3개 repo의 `git status`는 blind spot
- DB/HR/exam은 hosting-only 워크플로우라 uncommitted rules가 즉시 에러를 안 냄 → 발견이 늦어짐

리스크: live 배포 경로는 impact7DB 하나로 고정이지만, stale한 DB/HR/exam repo에서 누군가 실수로 `firebase deploy --only firestore:rules`를 돌리면 live 규칙이 **구버전으로 revert**되어 해당 기능이 차단됨. 잠재적 시한폭탄.

**How to apply**:
1. `firestore.rules` diff가 등장하면 "4-repo 동기화 작업"으로 확장 인식한다.
2. 수정 → 4개 repo cp → impact7DB에서 배포 → **4개 repo 모두 각각 `git add firestore.rules && git commit && git push` 실행**. 한 repo라도 빠지면 미완료.
3. 검증 한 줄:
   ```sh
   for p in impact7DB impact7newDSC impact7HR impact7exam; do (cd ~/projects/$p && git status --short firestore.rules); done
   ```
   출력이 전부 비어 있어야 완료.
4. 작업 중이라도 어느 repo에서든 `git status`에 `firestore.rules`가 보이면 즉시 나머지 3개 repo도 점검.
5. 가능하면 `sync-rules.sh` 스크립트에 "cp + 4-repo commit/push + DB에서 deploy"까지 묶어서 수동 실수 여지를 없앤다.

관련 기존 메모:
- impact7newDSC: `feedback_firestore_rules_4projects.md` (4-repo 동기화 원칙)
- impact7HR: `feedback_deploy_firestore_rules.md` (GitHub Actions는 hosting만, 수동 deploy 필요)
- impact7exam: `feedback_firestore_rules.md` (이 repo에서 배포 절대 금지)
