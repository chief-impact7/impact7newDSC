---
name: reference_unified_hosting_deploy
description: 통합 호스팅(impact7-hosting) 배포 메커니즘 + 캐시 헤더 + "배포했는데 옛 화면" 진단법
metadata:
  type: reference
---

# 통합 호스팅 배포·캐시 (impact7-hosting)

각 앱(DB·DSC·HR·Dashboard·forms)은 **자체 빌드/배포를 하지 않는다.** 통합 호스팅 `impact7-app`(repo `chief-impact7/impact7-hosting`)이 전담.

## 배포 흐름
1. DSC `master` push → DSC `.github/workflows/deploy.yml`은 **빌드 안 하고**(약 6초) impact7-hosting에 `repository_dispatch{event_type:deploy-unified}`만 보낸다.
2. impact7-hosting workflow(`on: workflow_dispatch | repository_dispatch[deploy-unified]` — **push 트리거 없음**)가 4앱을 `actions/checkout@v6`(ref 없음=각 repo master 최신)으로 받아 `npm ci && vite build --base=/dsc/`(등) → `public/dsc` → `firebase deploy`.
3. ⚠️ **DSC Actions success ≠ 배포 완료.** 실제 반영은 impact7-hosting workflow(약 2~3분) 완료 후. `gh run list -R chief-impact7/impact7-hosting`로 확인.
4. impact7-hosting `firebase.json`만 바꿨다면 push로는 배포 안 됨 → `gh workflow run "Deploy unified hosting" -R chief-impact7/impact7-hosting --ref main` 수동 실행.

## 캐시 헤더 (firebase.json headers)
- Firebase headers는 **요청 경로**로 매칭(rewrite 전). SPA 진입 `/dsc/`는 rewrite로 index.html을 받을 뿐 `source:"/dsc/index.html"`과 **경로가 안 맞아** no-cache 미적용. → `source:"/dsc/**"`로 잡아야 한다.
- 패턴(2026-06-23 적용): `/{app}/**` → `no-cache`, 그 **뒤에** `/{app}/**/*.@(js|css|png|...)` → `immutable`. Firebase는 **마지막 매칭이 우선**이라 js/css는 장기 캐시(immutable), index.html은 no-cache. db·dsc·hr·dashboard 모두 적용(forms는 `/forms` 진입으로 별도 커버).
- DSC는 PWA/Service Worker **없음**. 캐시는 브라우저/CDN(Fastly, `x-served-by: cache-*`)·index.html 뿐.

## "배포했는데 화면이 안 바뀐다" 진단법
1. impact7-hosting workflow가 success인지 + 완료 시각(2~3분 소요) 확인.
2. 배포 코드 일치: 로컬에서 `npx vite build --base=/dsc/` → `dist/assets/main-*.js` hash vs 배포 `curl -sL https://impact7-app.web.app/dsc/ | grep -oE 'assets/main-[^"]+\.js'` 비교. 같으면 **배포는 최신**.
3. **시크릿/프라이빗 창**에서 확인 → 점/화면이 정상이면 **일반 창 캐시 문제 확정**(코드·배포 정상). no-cache 적용 후로는 재발 없음.
4. 헤더 검증: `curl -sI https://impact7-app.web.app/dsc/ | grep -i cache-control` → `no-cache`여야.
