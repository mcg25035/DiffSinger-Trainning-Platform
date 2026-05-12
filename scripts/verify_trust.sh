#!/bin/bash
# verify_trust.sh - 全域完整性與執行鏈校驗 (V3)

SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"
TRUST_FILE="$PROJECT_ROOT/.ds_trusted"

if [ ! -f "$TRUST_FILE" ]; then
    echo "❌ 錯誤：未授權的專案。請執行 ./update.sh 進行授權。"
    exit 1
fi

# 載入授權資訊
source "$TRUST_FILE"

# --- 核心檢查 1：全域執行鏈指紋比對 ---
# 自動尋找所有具備執行能力的檔案與設定檔
# 包含所有 .sh, .py, .js, Dockerfile, yaml, .env
CURRENT_MANIFEST=$(find "$PROJECT_ROOT" -type f \
    \( -name "*.sh" -o -name "*.py" -o -name "*.js" -o -name "Dockerfile" -o -name "*.yml" -o -name "*.yaml" -o -name ".env" \) \
    -not -path "*/.git/*" \
    -not -path "*/node_modules/*" \
    -not -path "*/uploads/*" \
    -not -path "*/upload_segments/*" | sort | xargs sha256sum | sha256sum | cut -d' ' -f1)

if [ "$manifest" != "$CURRENT_MANIFEST" ]; then
    echo "🚨 安全警告：偵測到非授權的檔案變動！"
    echo "有新的腳本被加入，或現有設定被修改，但尚未通過審核。"
    echo "請執行 ./update.sh 審核變更並重新授權。"
    exit 1
fi

# --- 核心檢查 2：Git 提交與歷史驗證 ---
CURRENT_COMMIT=$(git -C "$PROJECT_ROOT" rev-parse HEAD)

if [ "$mode" == "COMMIT" ]; then
    if [ "$commit" != "$CURRENT_COMMIT" ]; then
        echo "⚠️  警告：目前的授權僅限於 Commit $commit，但現在是 $CURRENT_COMMIT。"
        exit 1
    fi
elif [ "$mode" == "REPO" ]; then
    # 確保當前代碼是基於已授權的歷史開發的（防止強制推回或歷史改寫）
    if ! git -C "$PROJECT_ROOT" merge-base --is-ancestor "$commit" HEAD 2>/dev/null; then
        echo "🚨 安全警告：偵測到非法的 Git 歷史篡改！"
        exit 1
    fi
fi

echo "✅ 全域執行鏈校驗通過。"
exit 0
