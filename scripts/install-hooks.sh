#!/bin/sh
set -eu

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
HOOK_DIR=$(git rev-parse --path-format=absolute --git-common-dir)/hooks

mkdir -p "$HOOK_DIR"
cp "$SCRIPT_DIR/pre-push.hook" "$HOOK_DIR/pre-push"
cp "$SCRIPT_DIR/post-checkout.hook" "$HOOK_DIR/post-checkout"
chmod +x "$HOOK_DIR/pre-push" "$HOOK_DIR/post-checkout"
git config --unset core.hooksPath 2>/dev/null || true

echo "Git hooks 설치 완료: $HOOK_DIR"
