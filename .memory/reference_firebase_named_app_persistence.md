# Firebase named app — 통합 호스팅 persistence 충돌 (2026-06-11)

## 사건
impact7-app.web.app 통합 호스팅 이후 /dsc/가 "학생 데이터를 불러오는 중..."에서 고착.
새로고침해도 동일. 코드 버그가 아니라 **브라우저 탭 간 Firestore persistence 충돌**.

## 원인 메커니즘
- 통합 호스팅으로 /db/·/dsc/·/hr/·/exam/이 **같은 origin** → 4개 앱이 같은 Firebase app 이름 `[DEFAULT]` + 같은 projectId(impact7db)라 **하나의 IndexedDB**(`firestore/[DEFAULT]/impact7db/main`)를 공유
- `persistentMultipleTabManager`에서 한 탭만 primary lease를 쥐고 네트워크를 담당
- 다른 앱 탭이 primary를 쥔 채 throttled/frozen → DSC 탭은 secondary → **write가 mutation 큐에 갇혀 영구 pending** (read는 캐시 폴백으로 동작해 증상이 헷갈림)
- DSC init 체인의 무조건 write(`trackTeacherLogin`)를 `await` → 그 뒤 `renderListPanel()` 영영 미도달

## 진단 기법 (재사용 가치)
- `indexedDB.databases()` → 공유 DB 이름 확인
- IndexedDB `owner` store의 `ownerId`·`leaseTimestampMs` → 누가 primary인지, lease 나이
- `mutations` store의 count → write가 갇혀 있는지 (`pendingMutations > 0` = write hang 실증)
- 네트워크 탭에 Firestore Write/Listen 채널이 **없으면** secondary 탭

## 수정 (2026-06-11, 4개 repo)
- 각 앱 `initializeApp(config, '<이름>')`: dsc / db / hr / exam → IndexedDB가 `firestore/dsc/...` 등으로 분리
- DSC `daily-ops.js`: `trackTeacherLogin`을 fire-and-forget으로 (초기 렌더링 차단 해제)
- exam `auth.ts`: argless `getAuth()` → config의 `auth` import ([DEFAULT] 부재로 throw 방지)

## 부작용·잔여 과제
- **일선 전원 1회 재로그인** (auth 저장 키가 `firebase:authUser:{apiKey}:{appName}`이라 키 변경)
- 전 클라이언트 1회 캐시 풀 재다운로드 (~15.7k docs: 재원 414 + 퇴원 15,273) — 읽기 스파이크 1회성, [[project_realtime_sync]] 모니터링과 연관
- 고아 `firestore/[DEFAULT]/impact7db/main` IndexedDB가 클라이언트 디스크에 잔존 — 4개 앱 모두 배포 완료 후에만 deleteDatabase 정리 안전
- 같은 앱 두 탭 + frozen primary 시나리오는 여전히 가능: init 체인의 조건부 write(promote*·backfillStudentNumbers·syncAbsenceRecords·autoCleanupClasses)는 await 유지 중 — 조건 충족일에는 hang 가능
- HR만 firebase ^11 (나머지 ^12) — persistence 분리로 충돌은 해소됐으나 버전 정렬은 별도 과제

## 규칙
- **argless `getAuth()`/`getFirestore()`/`getApp()` 금지** — named app 체제에서는 [DEFAULT]가 없어 throw. 항상 config의 인스턴스를 import
- 새 impact7 앱 추가 시 반드시 고유 앱 이름 부여
