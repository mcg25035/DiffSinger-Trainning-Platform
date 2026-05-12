#!/bin/bash
# trust_manager.sh - 全域授權管理工具

SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"
TRUST_FILE="$PROJECT_ROOT/.ds_trusted"

# 定義什麼是「關鍵執行鏈」檔案
function get_manifest() {
    find "$PROJECT_ROOT" -type f \
        \( -name "*.sh" -o -name "*.py" -o -name "*.js" -o -name "Dockerfile" -o -name "*.yml" -o -name "*.yaml" -o -name ".env" \) \
        -not -path "*/.git/*" \
        -not -path "*/node_modules/*" \
        -not -path "*/uploads/*" \
        -not -path "*/upload_segments/*" | sort | xargs sha256sum | sha256sum | cut -d' ' -f1
}

MODE=$1 # COMMIT or REPO
if [[ "$MODE" != "COMMIT" && "$MODE" != "REPO" ]]; then
    echo "Usage: $0 [COMMIT|REPO]"
    exit 1
fi

COMMIT_ID=$(git -C "$PROJECT_ROOT" rev-parse HEAD)
MANIFEST=$(get_manifest)

echo "mode=$MODE" > "$TRUST_FILE"
echo "commit=$COMMIT_ID" >> "$TRUST_FILE"
echo "manifest=$MANIFEST" >> "$TRUST_FILE"
echo "timestamp=$(date +%s)" >> "$TRUST_FILE"

echo "🛡️  全域授權已更新 (模式: $MODE)"
echo "   Commit: $COMMIT_ID"
echo "   全域執行鏈指紋: $MANIFEST"
