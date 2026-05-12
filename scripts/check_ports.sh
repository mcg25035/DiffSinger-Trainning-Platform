#!/bin/bash
# check_ports.sh - 部署前置檢查：連接埠撞車偵測

SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"

# 載入 .env
if [ -f "$PROJECT_ROOT/.env" ]; then
    export $(cat "$PROJECT_ROOT/.env" | grep -v '#' | xargs)
fi

MFA_PORT=${MFA_PORT:-8001}
LYRICS_PORT=${LYRICS_PORT:-8000}
BACKEND_PORT=${BACKEND_PORT:-3010}

check_port() {
    local port=$1
    local service_name=$2
    
    # 使用 lsof 尋找正在監聽該 Port 的 PID
    local pids=$(lsof -t -i :$port -s TCP:LISTEN 2>/dev/null)
    
    if [ ! -z "$pids" ]; then
        for pid in $pids; do
            local cmd=$(ps -p $pid -o args= | xargs)
            local is_ours=false
            
            # 1. 檢查是否為我們的 PM2 服務 (Backend)
            if command -v pm2 &> /dev/null && command -v jq &> /dev/null; then
                local pm2_name=$(pm2 jlist 2>/dev/null | jq -r ".[] | select(.pid == $pid) | .name")
                if [ "$pm2_name" == "diffsinger-platform" ]; then
                    is_ours=true
                fi
            fi
            
            # 2. 檢查是否為我們的 Docker 服務
            # docker-proxy 會監聽這些 port
            if [[ "$cmd" == *"docker-proxy"* ]]; then
                 # 檢查是否有我們的 container 綁定這個 port
                 local container=$(sudo docker ps --format "{{.Names}} {{.Ports}}" | grep ":$port->" | awk '{print $1}')
                 if [[ "$container" == *"mfa_aligner_api"* || "$container" == *"sensevoice-hira-api"* ]]; then
                     is_ours=true
                 fi
            fi
            
            if [ "$is_ours" = false ]; then
                echo ""
                echo "🚨 致命錯誤：連接埠撞車！"
                echo "  服務 [$service_name] 預計使用 Port $port，但該 Port 目前已被其他未知的程序佔用。"
                echo "  佔用程序的 PID: $pid"
                echo "  佔用程序的指令: $cmd"
                echo "------------------------------------------------"
                echo "  💡 解決方案："
                echo "  1. 修改專案根目錄的 .env 檔案，為本系統換一個沒有人使用的 Port。"
                echo "  2. 或者關閉該佔用程序後再重試部署。"
                echo "------------------------------------------------"
                exit 1
            fi
        done
    fi
}

echo "🔍 執行佈署前檢查：連接埠衝突測試..."
if ! command -v lsof &> /dev/null; then
    echo "⚠️ 找不到 lsof 指令，跳過連接埠檢查。"
    exit 0
fi

if ! command -v jq &> /dev/null; then
    echo "⚠️ 找不到 jq 指令，跳過連接埠檢查。"
    exit 0
fi

check_port $MFA_PORT "MFA 對齊服務"
check_port $LYRICS_PORT "Lyrics 辨識服務"
check_port $BACKEND_PORT "Node.js 後端服務"

echo "✅ 連接埠檢查通過，無撞車風險。"
exit 0