#!/bin/bash
# ds-daemon.sh - 特權代理 Daemon
# 由 systemd 管理，監聽 FIFO named pipe，接收指令並執行 docker compose
# 讓 deploy.sh 不需要 root 就能觸發 Docker 服務

set -euo pipefail

PROJECT_ROOT="$(dirname "$(dirname "$(readlink -f "$0")")")"
PIPE="/run/ds-platform/trigger"

# 建立 FIFO pipe，設定權限讓非 root 使用者可寫入
mkdir -p "$(dirname "$PIPE")"
[ -p "$PIPE" ] || mkfifo "$PIPE"
chmod 622 "$PIPE"

# 用 fd3 持續開啟 pipe（讀+寫），避免：
# 1. 沒有寫入者時 read 立即收到 EOF
# 2. 沒有讀取者時寫入端收到 SIGPIPE
exec 3<>"$PIPE"

echo "[ds-daemon] Daemon started. PID: $$"
echo "[ds-daemon] Project root: $PROJECT_ROOT"
echo "[ds-daemon] Listening on: $PIPE"

# 確保 MMS 訓練與權重目錄存在且有適當權限，防止 Node.js 寫入權限問題
mkdir -p "$PROJECT_ROOT/mms_service/data/training_data"
chmod -R 777 "$PROJECT_ROOT/mms_service/data" || true

while true; do
    if read -r cmd <&3; then
        case "$cmd" in
            up)
                echo "[ds-daemon] $(date '+%Y-%m-%d %H:%M:%S') Received 'up', starting services..."
                
                # 再次確保目錄權限正確（以防 Docker 重建目錄）
                mkdir -p "$PROJECT_ROOT/mms_service/data/training_data"
                chmod -R 777 "$PROJECT_ROOT/mms_service/data" || true
                
                # 每次執行前動態解析環境（CUDA/GPU 偵測）
                source "$PROJECT_ROOT/scripts/resolve_env.sh" || true
                cd "$PROJECT_ROOT"
                if docker compose -f docker-compose.yml -f docker-compose.gpu.yml up --build -d; then
                    echo "[ds-daemon] $(date '+%Y-%m-%d %H:%M:%S') Services started successfully."
                else
                    echo "[ds-daemon] $(date '+%Y-%m-%d %H:%M:%S') ERROR: docker compose up failed with exit code $?"
                fi
                ;;
            down)
                echo "[ds-daemon] $(date '+%Y-%m-%d %H:%M:%S') Received 'down', stopping services..."
                cd "$PROJECT_ROOT"
                docker compose down
                echo "[ds-daemon] $(date '+%Y-%m-%d %H:%M:%S') Services stopped."
                ;;
            *)
                echo "[ds-daemon] $(date '+%Y-%m-%d %H:%M:%S') Unknown command: '$cmd'"
                ;;
        esac
    fi
done
