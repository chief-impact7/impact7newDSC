---
name: 반 편성 도우미 개발 진행 상태
description: class-setup 마법사 페이지 개발 진행 상황 — 플랜 승인됨, 구현 시작 직전
type: project
---

## 반 편성 도우미 (Class Setup Wizard) — 2026-04-06 시작

**상태**: 플랜 승인됨, 구현 시작 직전 (vite.config.js 수정부터)

### 플랜 요약
- 별도 페이지 `class-setup.html` + `class-setup.js` + `class-setup.css` 생성
- 5단계 마법사: 반유형 → 반이름 → 학생추가 → 요일 → 시간/확인
- 반 유형: 정규 / 내신 / 자유학기 / 특강
- 반이름 형식: 정규/자유학기=레벨+반번호, 내신=학교학년A/B, 특강=자유텍스트
- 학생: students 컬렉션 검색, 재원생 우선 정렬, 복수 선택
- 자유학기: 정규와 동일 구조, class_type만 '자유학기'

### 플랜 파일 위치
- 상세 플랜: `docs/superpowers/plans/` 에는 아직 없음
- Claude 플랜: `~/.claude-yijongsoo/plans/velvety-sniffing-peacock.md` (계정별이라 다른 계정에선 못 읽음)

### 남은 작업
1. `vite.config.js` — rollupOptions.input에 classSetup 추가
2. `class-setup.html` — HTML 마법사 페이지 생성
3. `class-setup.css` — 스타일 (daily-ops.css :root 변수 재사용)
4. `class-setup.js` — 마법사 로직 (auth, 5단계, Firestore 저장)
5. `index.html` — 사이드바에 "반 편성" 링크 추가

### 오늘 이미 완료된 작업 (같은 세션)
- 학기 필터/가드 전체 제거 (isPastSemester 저장 차단 해소) ✅ 푸시됨
- 내신 학생 등원요일 토글 (naesin_days 필드) ✅ 푸시됨
- Firestore 감사 필드 자동 추가 (audit.js 래퍼) ✅ 푸시됨

**Why:** 직원들이 시트/CSV를 모르므로, 앱 내 마법사로 반 편성을 쉽게 할 수 있어야 함
**How to apply:** 새 계정으로 진입 시 이 메모리 읽고 남은 작업부터 이어서 진행
