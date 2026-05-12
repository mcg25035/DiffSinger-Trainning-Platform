#!/bin/bash
# update.sh - 安全審核與全域授權入口

PROJECT_ROOT="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"

echo "🔄 正在檢查更新..."
git -C "$PROJECT_ROOT" fetch

# 檢查變動
UPSTREAM=${1:-'@{u}'}
LOCAL=$(git -C "$PROJECT_ROOT" rev-parse @)
REMOTE=$(git -C "$PROJECT_ROOT" rev-parse "$UPSTREAM")

if [ "$LOCAL" != "$REMOTE" ]; then
    echo "📢 偵測到新版本！變更摘要："
    git -C "$PROJECT_ROOT" log HEAD..$UPSTREAM --oneline --graph --color
    read -p "❓ 是否執行 git pull？(y/N) " pull_confirm
    if [[ "$pull_confirm" == "y" || "$pull_confirm" == "Y" ]]; then
        git -C "$PROJECT_ROOT" pull
    fi
else
    echo "✅ 目前已是最新代碼。"
fi

echo ""
echo "------------------------------------------------"
echo "🛡️  請選擇執行鏈授權等級："
echo "1) 信任此 GitHub 專案 (REPO) - 自動信任未來所有的合法更新"
echo "2) 僅信任本次變更 (COMMIT) - 每次更新都需要重新跑 update.sh 審核"
echo "3) 暫不更新授權 (CANCEL)"
echo "------------------------------------------------"
read -p "請選擇 (1/2/3): " trust_choice

case $trust_choice in
    1)
        bash "$PROJECT_ROOT/scripts/trust_manager.sh" REPO
        ;;
    2)
        bash "$PROJECT_ROOT/scripts/trust_manager.sh" COMMIT
        ;;
    *)
        echo "🛑 授權未變更。"
        ;;
esac

echo "🚀 正在執行部署流程..."
bash "$PROJECT_ROOT/deploy.sh"
