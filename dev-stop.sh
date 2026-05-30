#!/bin/bash
# dev-stop.sh - 手動停止所有開發服務
# 用於忘記 Ctrl+C 或終端意外關閉時的清理

set -e

PROJECT_ROOT="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"
PIPE="/tmp/ds-dev-pipe"

RED='\033[0;31m'
GREEN='\033[0;32m'
CYAN='\033[0;36m'
NC='\033[0m'

echo -e "${CYAN}▶ 停止所有開發服務...${NC}"

# 停止 Node.js 後端
PIDS=$(pgrep -f "node server.js" 2>/dev/null || true)
if [ -n "$PIDS" ]; then
    echo "   停止 Node.js 後端 (PIDs: $PIDS)..."
    kill $PIDS 2>/dev/null || true
fi

# 停止 Vite dev server
PIDS=$(pgrep -f "vite" 2>/dev/null || true)
if [ -n "$PIDS" ]; then
    echo "   停止 Vite dev server (PIDs: $PIDS)..."
    kill $PIDS 2>/dev/null || true
fi

# 透過 pipe 通知 daemon 停止 Docker
if [ -p "$PIPE" ]; then
    echo "   通知 daemon 停止 Docker 服務..."
    echo "down" > "$PIPE"
    echo -e "${GREEN}✅ 已通知 daemon 停止 Docker。${NC}"
    echo -e "   ${CYAN}daemon 本身仍在運行，可繼續接收指令。${NC}"
else
    echo -e "   ⚠️  找不到 daemon pipe，嘗試直接停止 Docker..."
    sudo docker compose -f "$PROJECT_ROOT/docker-compose.yml" down 2>/dev/null || true
fi

echo ""
echo -e "${GREEN}✅ 所有開發服務已停止。${NC}"
