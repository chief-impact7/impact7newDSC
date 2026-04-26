---
name: pdf2fire 스킬 반드시 사용
description: PDF 문제 추출/Firestore 임포트 시 자체 스크립트 작성 금지, 반드시 pdf2fire 스킬 사용
type: feedback
---

PDF에서 문제 추출 → Firestore 임포트 작업 시, 자체 스크립트를 새로 작성하지 말고 **반드시 `/pdf2fire` 스킬을 사용**할 것.

**Why:** 사용자가 여러 번 지시하고 AGENTS.md에도 명시했음에도 Claude가 자체 스크립트로 추출을 시도하여 2주간의 시간을 허비함. 스크립트 추출은 품질이 낮고, 세션 리밋에 걸려 작업이 중단되는 문제도 반복됨.

**How to apply:**
- 시험지/교재 PDF 관련 작업 요청 시 → 무조건 `/pdf2fire` 스킬 먼저 invoke
- EBS 교재도 포함 — ebs-extraction 스크립트는 정답 누락률 8%로 실전 사용 불가. EBS도 pdf2fire + Claude 독해로 처리해야 함
- 자체 파싱 스크립트를 새로 작성하려는 충동이 들면 → 중단하고 기존 스킬 확인
- 세션 리밋 대응: 체크포인트 기반 배치 처리 구조 필수
