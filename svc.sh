#!/bin/bash
# svc.sh - 首次安裝：註冊 ds-platform daemon 到 systemd
# 用法：sudo ./svc.sh
#
# 此腳本只需要執行一次。它會：
# 1. 清除舊的分散式 systemd units（ds-mfa, ds-lyrics）
# 2. 產生並註冊新的 ds-platform.service
# 3. 啟動 daemon

set -e

if [ "$EUID" -ne 0 ]; then
    echo "❌ 請使用 sudo 執行此腳本：sudo ./svc.sh"
    exit 1
fi

PROJECT_ROOT="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"

echo "🔧 DiffSinger Platform - 服務註冊"
echo "   專案路徑: $PROJECT_ROOT"
echo ""

# --- 清除舊的分散式 systemd units（遷移用）---
for old_svc in ds-mfa ds-lyrics; do
    if [ -f "/etc/systemd/system/${old_svc}.service" ]; then
        echo "🧹 清除舊服務 ${old_svc}..."
        systemctl disable --now "$old_svc" 2>/dev/null || true
        rm -f "/etc/systemd/system/${old_svc}.service"
    fi
done

# 清除舊的 sudoers 白名單（如果存在）
DEPLOYER_USER="${SUDO_USER:-$USER}"
OLD_SUDOERS="/etc/sudoers.d/ds-services-${DEPLOYER_USER}"
if [ -f "$OLD_SUDOERS" ]; then
    echo "🧹 清除舊的 sudoers 設定: $OLD_SUDOERS"
    rm -f "$OLD_SUDOERS"
fi

# --- 產生 systemd unit ---
echo "📝 產生 ds-platform.service..."

cat <<EOF > /etc/systemd/system/ds-platform.service
[Unit]
Description=DiffSinger Platform - Docker Service Daemon
After=docker.service
Requires=docker.service

[Service]
Type=simple
RuntimeDirectory=ds-platform
WorkingDirectory=$PROJECT_ROOT
ExecStart=$PROJECT_ROOT/scripts/ds-daemon.sh
Restart=on-failure
RestartSec=5
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=multi-user.target
EOF

# 確保 daemon 腳本有執行權限
chmod +x "$PROJECT_ROOT/scripts/ds-daemon.sh"

# --- 啟動 ---
systemctl daemon-reload
systemctl enable --now ds-platform

echo ""
echo "================================================"
echo "✅ ds-platform.service 已註冊並啟動！"
echo ""
echo "📋 常用指令："
echo "   查看狀態: systemctl status ds-platform"
echo "   查看日誌: journalctl -u ds-platform -f"
echo "   重啟服務: systemctl restart ds-platform"
echo ""
echo "🚀 現在可以用 ./deploy.sh 進行部署（不需要 root）"
echo "================================================"
