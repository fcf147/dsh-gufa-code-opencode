#!/usr/bin/env bash
# CodeBuddy 融合：opencode CLI 垫片。
# 本机没有独立的 opencode 二进制，用 bun 从源码启动（与 Spike 阶段一致）。
# 用法：OPENCODE_BIN=<此文件绝对路径> 或让 findOpencodeBin 自动探测。

export PATH="/d/Desktop/self_codebuddy/.tools/node_modules/.bin:$PATH"
REPO="/d/Desktop/self_codebuddy/opencode-full"

if [[ "$1" == "--version" ]]; then
  exec bun run --cwd "$REPO/packages/cli" src/index.ts --version
fi

exec bun run --cwd "$REPO/packages/cli" src/index.ts "$@"
