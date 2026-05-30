#!/bin/bash
# dev-daemon.sh - 開發用 Docker 特權代理 Daemon（前景執行）
# 用法：sudo ./dev-daemon.sh
#
# 功能：
#   以 root 身份前景監聽 named pipe，接收來自非 root 使用者（AI Agent 等）的指令，
#   代為執行 docker compose 操作。
#
# 支援指令：
#   up       - docker compose up --build -d
#   down     - docker compose down
#   restart  - docker compose restart
#   rebuild  - docker compose down && up --build -d（完整重建）
#   status   - 顯示 docker compose ps
#   logs     - 輸出最近 50 行 log
#
# 停止方式：Ctrl+C

set -euo pipefail

# 先解析絕對路徑（提權前 BASH_SOURCE 還拿得到）
SCRIPT_PATH="$(readlink -f "${BASH_SOURCE[0]}")"
PROJECT_ROOT="$(dirname "$SCRIPT_PATH")"

# ─── 自動提權：pkexec → sudo ───
if [ "$EUID" -ne 0 ]; then
    echo "🔐 需要 root 權限來管理 Docker，正在提權..."
    if command -v pkexec &>/dev/null; then
        # pkexec 會彈出 GUI 認證視窗
        exec pkexec env \
            "DISPLAY=$DISPLAY" \
            "TERM=${TERM:-xterm}" \
            bash "$SCRIPT_PATH" "$@"
    else
        echo "   (pkexec 不可用，改用 sudo)"
        exec sudo bash "$SCRIPT_PATH" "$@"
    fi
fi
PIPE="/tmp/ds-dev-pipe"

# ─── 顏色 ───
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
DIM='\033[2m'
NC='\033[0m'

ts() { date '+%Y-%m-%d %H:%M:%S'; }

# ─── 清理函式 ───
cleanup() {
    echo ""
    echo -e "${CYAN}[dev-daemon]${NC} $(ts) 收到停止訊號，清理中..."
    # 關閉 fd3
    exec 3>&- 2>/dev/null || true
    # 移除 pipe
    rm -f "$PIPE"
    echo -e "${GREEN}[dev-daemon]${NC} $(ts) Daemon 已停止。Pipe 已移除。"
    exit 0
}

trap cleanup SIGINT SIGTERM EXIT

# ─── 建立 named pipe ───
if [ -e "$PIPE" ]; then
    if [ -p "$PIPE" ]; then
        echo -e "${YELLOW}⚠️  偵測到舊的 pipe，移除中...${NC}"
        rm -f "$PIPE"
    else
        echo -e "${RED}❌ $PIPE 存在但不是 named pipe，請手動移除。${NC}"
        exit 1
    fi
fi

mkfifo "$PIPE"
# 允許非 root 使用者寫入
chmod 622 "$PIPE"

# 用 fd3 持續開啟 pipe（讀+寫），避免 EOF / SIGPIPE
exec 3<>"$PIPE"

# ─── 載入環境 ───
if [ -f "$PROJECT_ROOT/.env" ]; then
    export $(cat "$PROJECT_ROOT/.env" | grep -v '^#' | grep -v '^$' | xargs) 2>/dev/null || true
fi
chmod +x "$PROJECT_ROOT/scripts/resolve_env.sh"
source "$PROJECT_ROOT/scripts/resolve_env.sh" || true

# 偵測 GPU → compose files
COMPOSE_CMD="docker compose -f docker-compose.yml"
if command -v nvidia-smi &>/dev/null; then
    COMPOSE_CMD="$COMPOSE_CMD -f docker-compose.gpu.yml"
fi

echo ""
echo -e "${GREEN}══════════════════════════════════════════════════${NC}"
echo -e "${GREEN}  🐳 DiffSinger Dev Daemon 已啟動${NC}"
echo -e "${GREEN}══════════════════════════════════════════════════${NC}"
echo ""
echo -e "  ${CYAN}專案路徑:${NC}  $PROJECT_ROOT"
echo -e "  ${CYAN}Pipe:${NC}      $PIPE"
echo -e "  ${CYAN}PID:${NC}       $$"
echo -e "  ${CYAN}Compose:${NC}   $COMPOSE_CMD"
echo ""
echo -e "  ${DIM}等待指令中... (up / down / restart / rebuild / status / logs)${NC}"
echo -e "  ${DIM}發送方式: echo \"up\" > $PIPE${NC}"
echo -e "  ${DIM}按 Ctrl+C 停止${NC}"
echo ""

# ─── 主迴圈 ───
while true; do
    if read -r cmd <&3; then
        cmd=$(echo "$cmd" | xargs)  # trim whitespace
        [ -z "$cmd" ] && continue

        echo -e "${CYAN}[dev-daemon]${NC} $(ts) 收到指令: ${YELLOW}${cmd}${NC}"

        cd "$PROJECT_ROOT"

        case "$cmd" in
            up)
                echo -e "${CYAN}[dev-daemon]${NC} 啟動 Docker 服務..."
                if $COMPOSE_CMD up --build -d 2>&1; then
                    echo -e "${GREEN}[dev-daemon]${NC} $(ts) ✅ 服務啟動成功"
                else
                    echo -e "${RED}[dev-daemon]${NC} $(ts) ❌ 服務啟動失敗 (exit: $?)"
                fi
                ;;

            down)
                echo -e "${CYAN}[dev-daemon]${NC} 停止 Docker 服務..."
                $COMPOSE_CMD down 2>&1
                echo -e "${GREEN}[dev-daemon]${NC} $(ts) ✅ 服務已停止"
                ;;

            restart)
                echo -e "${CYAN}[dev-daemon]${NC} 重啟 Docker 服務..."
                $COMPOSE_CMD restart 2>&1
                echo -e "${GREEN}[dev-daemon]${NC} $(ts) ✅ 服務已重啟"
                ;;

            rebuild)
                echo -e "${CYAN}[dev-daemon]${NC} 完整重建 Docker 服務..."
                $COMPOSE_CMD down 2>&1
                source "$PROJECT_ROOT/scripts/resolve_env.sh" || true
                $COMPOSE_CMD up --build -d 2>&1
                echo -e "${GREEN}[dev-daemon]${NC} $(ts) ✅ 服務已重建"
                ;;

            status)
                echo -e "${CYAN}[dev-daemon]${NC} Docker 服務狀態:"
                $COMPOSE_CMD ps 2>&1
                ;;

            logs)
                echo -e "${CYAN}[dev-daemon]${NC} 最近日誌:"
                $COMPOSE_CMD logs --tail=50 2>&1
                ;;

            *)
                echo -e "${YELLOW}[dev-daemon]${NC} $(ts) ⚠️ 未知指令: '$cmd'"
                echo -e "${DIM}  支援: up / down / restart / rebuild / status / logs${NC}"
                ;;
        esac

        echo ""
    fi
done
