#!/bin/bash

# 智慧偵測 GPU 與啟動 MFA 服務

# 偵測是否具備 NVIDIA GPU 驅動
if command -v nvidia-smi &> /dev/null; then
    echo "🚀 偵測到 NVIDIA GPU，準備啟動 GPU 加速模式..."
    HAS_GPU=true
else
    echo "ℹ️ 未偵測到 GPU，將使用純 CPU 模式啟動..."
    HAS_GPU=false
fi

# 檢查 Docker Compose 命令 (相容新版 docker compose 與舊版 docker-compose)
if docker compose version &> /dev/null; then
    DOCKER_CMD="docker compose"
elif sudo docker-compose version &> /dev/null; then
    DOCKER_CMD="sudo docker-compose"
else
    echo "❌ 找不到 docker-compose，請先安裝。"
    exit 1
fi

if [ "$HAS_GPU" = true ]; then
    echo "📦 執行: $DOCKER_CMD -f docker-compose.yml -f docker-compose.gpu.yml up --build -d"
    $DOCKER_CMD -f docker-compose.yml -f docker-compose.gpu.yml up --build -d
else
    echo "📦 執行: $DOCKER_CMD up --build -d"
    $DOCKER_CMD up --build -d
fi

echo "------------------------------------------------"
echo "✅ 服務啟動指令已發送。"
echo "🔗 API 地址: http://localhost:8001"
echo "📝 查看日誌: $DOCKER_CMD logs -f"
