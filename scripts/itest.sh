#!/bin/bash
# 隔离环境集成验证（指南 §6.3 路径）：独立 DSH_HOME + 独立端口，不碰运行中的桌面实例。
# 用法: scripts/itest.sh [port]   —— 构建 → 装包 → 启动测试实例 → 探活
set -e
cd "$(dirname "$0")/.."
PORT="${1:-19777}"
TEST_HOME=/tmp/dsh-lp-itest
DSH_BIN="/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh"

echo "== 构建 =="
node build.mjs

echo "== 刷新隔离环境 $TEST_HOME =="
rm -rf "$TEST_HOME/profiles/web/node_modules/dsh-launchpad" 2>/dev/null || true
mkdir -p "$TEST_HOME"
DSH_HOME="$TEST_HOME" "$DSH_BIN" plugin --profile web add "file:$(pwd)" 2>&1 | tail -2

echo "== 启动隔离实例（端口 $PORT，后台）=="
DSH_HOME="$TEST_HOME" "$DSH_BIN" web --port "$PORT" > "$TEST_HOME/boot.log" 2>&1 &
BOOT_PID=$!
echo "$BOOT_PID" > "$TEST_HOME/boot.pid"
echo "PID $BOOT_PID，日志 $TEST_HOME/boot.log"

for i in $(seq 1 30); do
  sleep 1
  if curl -sf "http://127.0.0.1:$PORT/api/launchpad/health" > /dev/null 2>&1; then
    echo "== /api/launchpad/health 探活成功 =="
    curl -s "http://127.0.0.1:$PORT/api/launchpad/health"
    echo
    echo "GUI: http://127.0.0.1:$PORT/ （验证完执行: kill \$(cat $TEST_HOME/boot.pid)）"
    exit 0
  fi
  if ! kill -0 $BOOT_PID 2>/dev/null; then
    echo "!! 启动失败，日志如下："; cat "$TEST_HOME/boot.log"; exit 1
  fi
done
echo "!! 30s 内未探活，日志：" ; tail -30 "$TEST_HOME/boot.log"; exit 1
