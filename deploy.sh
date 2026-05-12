#!/bin/bash
# deploy.sh - 完整部署腳本

set -e

PROJECT_ROOT=$(pwd)

# 載入 .env 檔案 (L1 Override)
if [ -f .env ]; then
    export $(cat .env | grep -v '#' | xargs)
fi

# 執行智慧解析 (L2 Discovery & L3 Fallback)
chmod +x scripts/resolve_env.sh
source scripts/resolve_env.sh

# 執行連接埠衝突測試
chmod +x scripts/check_ports.sh
bash scripts/check_ports.sh

echo "📦 [1/4] 安裝相依套件..."
npm install --quiet
cd frontend && npm install --quiet && cd ..

echo "🏗️ [2/4] 編譯前端..."
cd frontend && npm run build && cd ..

echo "🐳 [3/4] 啟動 Docker 服務 (透過 Systemd 隔離)..."

# --- 檢查是否需要重新註冊 Systemd 服務 ---
NEEDS_SYSTEMD_SETUP=false
if [ ! -f "/etc/systemd/system/ds-mfa.service" ]; then
    NEEDS_SYSTEMD_SETUP=true
elif ! grep -q "WorkingDirectory=$PROJECT_ROOT" /etc/systemd/system/ds-mfa.service; then
    echo "⚠️ 偵測到專案路徑變更，將重新註冊服務..."
    NEEDS_SYSTEMD_SETUP=true
fi

if [ "$NEEDS_SYSTEMD_SETUP" = true ]; then
    cat "$PROJECT_ROOT/SECURITY_DESIGN.md"
    echo ""
    echo "------------------------------------------------"
    echo "⚠️  系統配置通知："
    echo "   這是您首次在此路徑部署本系統。"
    echo "   接下來的步驟需要 Sudo 權限來註冊 Systemd 服務並配置免密碼 Sudoers。"
    echo "------------------------------------------------"
    # 如果在 CI 環境 (無互動終端)，read 會直接跳過，但 sudo 會報錯。
    # 所以通常這一步只在手動初始化時執行。
    if [ -t 0 ]; then
        read -p "請按 Enter 鍵確認，並在出現提示時輸入密碼繼續..."
    fi

    # 動態產生並註冊 MFA 服務
    cat <<EOF | sudo tee /etc/systemd/system/ds-mfa.service > /dev/null
[Unit]
Description=DiffSinger Platform - MFA Service (Docker)
After=docker.service
Requires=docker.service

[Service]
Type=oneshot
RemainAfterExit=yes
WorkingDirectory=$PROJECT_ROOT/mfa/mfa_service
EnvironmentFile=$PROJECT_ROOT/.env
ExecStartPre=$PROJECT_ROOT/scripts/verify_trust.sh
ExecStart=/usr/bin/docker compose -f docker-compose.yml -f docker-compose.gpu.yml up --build -d
ExecStop=/usr/bin/docker compose down
StandardOutput=journal

[Install]
WantedBy=multi-user.target
EOF

    # 動態產生並註冊 Lyrics 服務
    cat <<EOF | sudo tee /etc/systemd/system/ds-lyrics.service > /dev/null
[Unit]
Description=DiffSinger Platform - Lyrics Recognizer Service (Docker)
After=docker.service
Requires=docker.service

[Service]
Type=oneshot
RemainAfterExit=yes
WorkingDirectory=$PROJECT_ROOT/lyrics_regonizer
EnvironmentFile=$PROJECT_ROOT/.env
ExecStartPre=$PROJECT_ROOT/scripts/verify_trust.sh
ExecStart=/usr/bin/docker compose -f docker-compose.yml -f docker-compose.gpu.yml up --build -d
ExecStop=/usr/bin/docker compose down
StandardOutput=journal

[Install]
WantedBy=multi-user.target
EOF

    sudo systemctl daemon-reload
    sudo systemctl enable ds-mfa ds-lyrics > /dev/null 2>&1

    # 設定免密碼重啟權限 (Sudoers) 給當前使用者
    SUDOERS_FILE="/etc/sudoers.d/ds-services-${USER}"
    if [ ! -f "$SUDOERS_FILE" ]; then
        echo "🔐 正在設定免密碼服務重啟權限 (Sudoers)..."
        echo "${USER} ALL=(ALL) NOPASSWD: /usr/bin/systemctl restart ds-mfa, /usr/bin/systemctl restart ds-lyrics, /usr/bin/journalctl" | sudo tee "$SUDOERS_FILE" > /dev/null
        sudo chmod 440 "$SUDOERS_FILE"
    fi
fi

# 啟動 MFA
echo "📦 執行: sudo systemctl restart ds-mfa"
sudo systemctl restart ds-mfa

# 啟動 Lyrics Regonizer
echo "📦 執行: sudo systemctl restart ds-lyrics"
sudo systemctl restart ds-lyrics

echo "🚀 [4/4] 啟動 Node.js 後端服務..."
if command -v pm2 &> /dev/null; then
    pm2 delete diffsinger-platform 2>/dev/null || true
    pm2 start server.js --name diffsinger-platform
    echo "✅ 使用 PM2 啟動成功！"
else
    echo "⚠️ 找不到 PM2，請手動執行: npm start"
fi

echo "------------------------------------------------"
echo "✨ 部署完成！"
echo "🌐 平台地址: http://localhost:${BACKEND_PORT:-3010}"
echo "🎤 MFA API: http://localhost:${MFA_PORT:-8001}"
echo "📝 Lyrics API: http://localhost:${LYRICS_PORT:-8000}"
echo "------------------------------------------------"
echo "使用 './update.sh' 可以快速獲取更新並重啟服務。"
