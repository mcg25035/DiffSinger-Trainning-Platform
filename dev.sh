#!/bin/bash
# dev.sh - 開發用啟動腳本（非 root）
# 用法：./dev.sh
#
# 前置條件：先在另一個終端執行 sudo ./dev-daemon.sh
#
# 功能：
#   1. 安裝 npm 相依套件
#   2. 透過 pipe 通知 daemon 啟動 Docker 服務
#   3. 啟動 Node.js 後端（背景）
#   4. 啟動 Vite 前端 dev server（前景，Ctrl+C 停止）

set -e

PROJECT_ROOT="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"
cd "$PROJECT_ROOT"

PIPE="/tmp/ds-dev-pipe"

# ─── 顏色定義 ───
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
NC='\033[0m'

log_step()  { echo -e "${CYAN}▶ $1${NC}"; }
log_ok()    { echo -e "${GREEN}✅ $1${NC}"; }
log_warn()  { echo -e "${YELLOW}⚠️  $1${NC}"; }
log_err()   { echo -e "${RED}❌ $1${NC}"; }

# ─── 發送指令給 daemon ───
send_cmd() {
    local cmd="$1"
    if [ ! -p "$PIPE" ]; then
        log_err "找不到 daemon pipe ($PIPE)"
        echo "   請先在另一個終端執行: sudo ./dev-daemon.sh"
        return 1
    fi
    echo "$cmd" > "$PIPE"
}

# ─── 背景程序追蹤 ───
BACKEND_PID=""

cleanup() {
    echo ""
    log_step "正在關閉開發服務..."

    if [ -n "$BACKEND_PID" ] && kill -0 "$BACKEND_PID" 2>/dev/null; then
        kill "$BACKEND_PID" 2>/dev/null
        wait "$BACKEND_PID" 2>/dev/null
        log_ok "Node.js 後端已停止"
    fi

    # 不自動 docker down — daemon 獨立管理
    echo ""
    log_ok "前端 & 後端已停止。Docker 服務仍由 daemon 管理。"
    echo -e "   ${CYAN}若要停止 Docker: echo \"down\" > $PIPE${NC}"
    echo -e "   ${CYAN}或直接 Ctrl+C 你的 dev-daemon.sh${NC}"
    exit 0
}

trap cleanup SIGINT SIGTERM

# ─── 前置檢查 ───
log_step "檢查環境..."

for cmd in node npm; do
    if ! command -v $cmd &>/dev/null; then
        log_err "找不到 $cmd，請先安裝。"
        exit 1
    fi
done

echo "   Node.js: $(node --version)"
echo "   npm:     $(npm --version)"

# 檢查 daemon 是否在運行
if [ ! -p "$PIPE" ]; then
    log_err "Dev daemon 尚未啟動！"
    echo ""
    echo "   請先在另一個終端執行:"
    echo -e "   ${CYAN}sudo ./dev-daemon.sh${NC}"
    echo ""
    exit 1
fi
log_ok "偵測到 dev daemon (pipe: $PIPE)"

# ─── 載入 .env ───
if [ -f .env ]; then
    export $(cat .env | grep -v '^#' | grep -v '^$' | xargs) 2>/dev/null || true
    log_ok "已載入 .env"
fi

BACKEND_PORT=${BACKEND_PORT:-3010}
MFA_PORT=${MFA_PORT:-8001}
LYRICS_PORT=${LYRICS_PORT:-8000}
MMS_PORT=${MMS_PORT:-8002}
VITE_PORT=${VITE_PORT:-5173}

# ─── [1/4] 安裝相依套件 ───
echo ""
log_step "[1/4] 安裝 npm 相依套件..."
npm install --quiet
(cd frontend && npm install --quiet)
log_ok "相依套件安裝完成"

# ─── [2/4] 觸發 Docker 服務啟動 ───
echo ""
log_step "[2/4] 通知 daemon 啟動 Docker 服務..."
send_cmd "up"
log_ok "已發送 'up' 指令給 daemon"

# ─── [3/4] 啟動 Node.js 後端 ───
echo ""
log_step "[3/4] 啟動 Node.js 後端 (port $BACKEND_PORT)..."
NODE_ENV=development node server.js &
BACKEND_PID=$!
log_ok "Node.js 後端已啟動 (PID: $BACKEND_PID)"

sleep 2

# ─── [4/4] 啟動 Vite 前端 dev server ───
echo ""
log_step "[4/4] 啟動 Vite 前端 dev server..."
echo ""
echo "================================================"
echo -e "${GREEN}🚀 開發環境啟動完成！${NC}"
echo ""
echo -e "   🌐 前端 (Vite):   ${CYAN}http://localhost:${VITE_PORT}${NC}"
echo -e "   ⚙️  後端 (API):    ${CYAN}http://localhost:${BACKEND_PORT}${NC}"
echo -e "   🎤 MFA 服務:      ${CYAN}http://localhost:${MFA_PORT}${NC}"
echo -e "   📝 Lyrics 服務:   ${CYAN}http://localhost:${LYRICS_PORT}${NC}"
echo -e "   🔊 MMS 服務:      ${CYAN}http://localhost:${MMS_PORT}${NC}"
echo ""
echo -e "   ${CYAN}Docker 操作:${NC}"
echo -e "     echo \"restart\" > $PIPE   # 重啟 Docker 服務"
echo -e "     echo \"rebuild\" > $PIPE   # 重建 Docker 映像"
echo -e "     echo \"status\"  > $PIPE   # 查看狀態"
echo -e "     echo \"logs\"    > $PIPE   # 查看日誌"
echo ""
echo "   按 Ctrl+C 停止前端 & 後端"
echo "================================================"
echo ""

cd frontend && npm run dev
