#!/bin/bash
# deploy.sh - 部署腳本（不需要 root 權限）
# 前置條件：需先執行 sudo ./svc.sh 註冊 daemon

set -e

PROJECT_ROOT=$(pwd)
PIPE="/run/ds-platform/trigger"

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

echo "📦 [1/3] 安裝相依套件..."
npm install --quiet
cd frontend && npm install --quiet && cd ..

echo "🏗️ [2/3] 編譯前端..."
cd frontend && npm run build && cd ..

echo "🐳 [3/3] 觸發 Docker 服務啟動..."
if [ ! -p "$PIPE" ]; then
    echo ""
    echo "❌ 找不到 daemon pipe ($PIPE)"
    echo "   請先執行: sudo ./svc.sh"
    echo "   這只需要做一次，之後的 deploy 都不需要 root。"
    exit 1
fi
echo "up" > "$PIPE"
echo "✅ 已通知 daemon 啟動 Docker 服務"
echo "📋 查看 Docker 啟動進度: journalctl -u ds-platform -f"

echo ""
echo "🚀 啟動 Node.js 後端服務..."
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
echo "🔊 MMS API: http://localhost:${MMS_PORT:-8002}"
echo "------------------------------------------------"
echo "使用 './update.sh' 可以快速獲取更新並重啟服務。"
