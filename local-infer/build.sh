#!/usr/bin/env bash
# 組 build context(源碼快照 + vocoder config)→ build diffsinger-infer-cpu:latest
set -e
cd "$(dirname "$0")"

REPO_SRC="${REPO_SRC:-$HOME/.cache/train-mgr/diffsinger}"
ASSETS="${TRAIN_MGR_ASSETS:-/media/codingbear/code/train-mgr/assets}"
IMAGE="${IMAGE:-diffsinger-infer-cpu:latest}"

[ -d "$REPO_SRC/basics" ] || { echo "repo 源碼不存在:$REPO_SRC"; exit 1; }
[ -f "$ASSETS/vocoder-config.json" ] || { echo "train-mgr assets 不存在:$ASSETS"; exit 1; }

# restage 預設跳過:tar 重抓會換 mtime → COPY 層 cache 失效 → 後面全部重 build(數分鐘)。
# repo 源碼有變(罕見)才 FORCE_RESTAGE=1 ./build.sh
if [ ! -d repo-src ] || [ -n "$FORCE_RESTAGE" ]; then
    rm -rf repo-src
    mkdir repo-src
    (cd "$REPO_SRC" && tar cf - --exclude=checkpoints --exclude=artifacts --exclude=docs --exclude=samples .) | tar xf - -C repo-src
    echo "== repo-src 已重新抓取($REPO_SRC)=="
else
    echo "== 沿用現有 repo-src(FORCE_RESTAGE=1 可強制重抓)=="
fi
cp "$ASSETS/vocoder-config.json" .
rm -f diffsinger-infer-cpu.tar

echo "== docker build $IMAGE =="
sudo -n docker-gate build -t "$IMAGE" .

echo "== 完成 =="
sudo -n docker-gate images "$IMAGE"
