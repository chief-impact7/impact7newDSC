#!/bin/sh
# git hooks 설치 — 새 클론 후 한 번만 실행
HOOK=.git/hooks/pre-push
cp scripts/pre-push.hook $HOOK
chmod +x $HOOK
echo "✅ pre-push hook 설치 완료"
