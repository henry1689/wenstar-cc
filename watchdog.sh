#!/usr/bin/env bash
# 太虚境·看门狗 — 崩溃自动重启 + 健康检测
# 用法: bash watchdog.sh [--once]
#   --once: 只启动一次，不循环(用于调试)

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR" || exit 1

LOG_DIR="$SCRIPT_DIR/data/logs"
mkdir -p "$LOG_DIR"

PID_FILE="$LOG_DIR/server.pid"
RESTART_COUNT_FILE="$LOG_DIR/restart_count"
MAX_RESTARTS_PER_HOUR=5

# 🔴 预清理：杀掉所有残留node进程（防止EADDRINUSE）
ps aux | grep -i "node\|tsx" | grep -v grep | awk '{print $1}' | while read pid; do kill -9 "$pid" 2>/dev/null; done
sleep 1

# 读取重启计数
if [ -f "$RESTART_COUNT_FILE" ] && [ "$(stat -c %Y "$RESTART_COUNT_FILE" 2>/dev/null)" -gt "$(date -d '1 hour ago' +%s 2>/dev/null || echo 0)" ]; then
  RESTART_COUNT=$(cat "$RESTART_COUNT_FILE" 2>/dev/null || echo 0)
else
  RESTART_COUNT=0
  rm -f "$RESTART_COUNT_FILE"
fi

cleanup() {
  echo "[Watchdog] 清理..."
  if [ -f "$PID_FILE" ]; then
    kill "$(cat "$PID_FILE")" 2>/dev/null
    rm -f "$PID_FILE"
  fi
  exit 0
}
trap cleanup SIGINT SIGTERM

echo ""
echo "  ╔══════════════════════════════════════╗"
echo "  ║     太虚境·看门狗  v1.0               ║"
echo "  ║     崩溃自动重启 + 健康检测            ║"
echo "  ╚══════════════════════════════════════╝"
echo ""

while true; do
  # 检查重启频率限制
  if [ "$RESTART_COUNT" -ge "$MAX_RESTARTS_PER_HOUR" ]; then
    echo "[Watchdog] 🔴 1小时内重启超过${MAX_RESTARTS_PER_HOUR}次，停止看门狗防止死循环"
    exit 1
  fi

  echo "[Watchdog] 🚀 启动服务器 (重启#$((RESTART_COUNT + 1)))"

  # 启动前确保端口空闲
  ps aux | grep -i "node\|tsx" | grep -v grep | awk '{print $1}' | while read pid; do kill -9 "$pid" 2>/dev/null; done
  sleep 1

  node start.cjs &
  SERVER_PID=$!
  echo "$SERVER_PID" > "$PID_FILE"
  echo "[Watchdog] PID: $SERVER_PID"

  # 等待服务器启动
  sleep 8

  # 健康检测循环
  HEALTHY=true
  CONSECUTIVE_FAILURES=0

  while $HEALTHY; do
    sleep 15  # 每15秒检测一次

    if ! kill -0 "$SERVER_PID" 2>/dev/null; then
      echo "[Watchdog] ⚠️ 进程已退出 (PID: $SERVER_PID)"
      HEALTHY=false
      break
    fi

    # HTTP健康检测
    HTTP_CODE=$(curl -s -o /dev/null -w "%{http_code}" --max-time 3 http://localhost:3000/api/health 2>/dev/null)
    if [ "$HTTP_CODE" != "200" ]; then
      CONSECUTIVE_FAILURES=$((CONSECUTIVE_FAILURES + 1))
      echo "[Watchdog] ⚠️ 健康检测失败 #$CONSECUTIVE_FAILURES (HTTP $HTTP_CODE)"
      if [ "$CONSECUTIVE_FAILURES" -ge 3 ]; then
        echo "[Watchdog] 🔴 连续3次健康检测失败，重启服务器"
        HEALTHY=false
      fi
    else
      CONSECUTIVE_FAILURES=0
    fi
  done

  # 进程已死或健康检测失败
  if kill -0 "$SERVER_PID" 2>/dev/null; then
    echo "[Watchdog] 强制终止进程..."
    kill -9 "$SERVER_PID" 2>/dev/null
    sleep 1
  fi
  rm -f "$PID_FILE"

  RESTART_COUNT=$((RESTART_COUNT + 1))
  echo "$RESTART_COUNT" > "$RESTART_COUNT_FILE"

  # 检查 --once 模式
  if [ "$1" = "--once" ]; then
    echo "[Watchdog] --once 模式，退出"
    exit 0
  fi

  echo "[Watchdog] 5秒后重启..."
  sleep 5
done
