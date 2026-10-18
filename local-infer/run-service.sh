#!/usr/bin/env bash
# 本機推論服務:一次性啟動(--restart unless-stopped,重開機自動回來)
# 之後後端走 HTTP 127.0.0.1:8791,不再需要 docker-gate auth
set -e
cd "$(dirname "$0")"

REPO_SRC="${REPO_SRC:-$HOME/.cache/train-mgr/diffsinger}"
JOBS="${LOCAL_INFER_JOBS:-$HOME/.cache/train-mgr/infer}"
NAME="${NAME:-diffsinger-local-infer}"
IMAGE="${IMAGE:-diffsinger-infer-cpu:latest}"
PORT="${PORT:-8791}"

cmd="${1:-start}"

case "$cmd" in
  start)
    sudo -n docker-gate rm -f "$NAME" >/dev/null 2>&1 || true
    sudo -n docker-gate run -d --name "$NAME" --restart unless-stopped \
      -p "127.0.0.1:$PORT:8791" \
      -v "$REPO_SRC:/repo-root:ro" \
      -v "$JOBS:/jobs" \
      "$IMAGE"
    echo "已啟動 $NAME(:$PORT)— 之後合成用本機引擎不再需要 docker auth"
    ;;
  stop)
    sudo -n docker-gate rm -f "$NAME"
    echo "已停止 $NAME"
    ;;
  logs)
    sudo -n docker-gate logs --tail 50 -f "$NAME"
    ;;
  status)
    sudo -n docker-gate ps -a --filter "name=$NAME" --format '{{.Names}}  {{.Status}}'
    curl -sf -m 3 "http://127.0.0.1:$PORT/health" && echo
    ;;
  *)
    echo "用法:$0 {start|stop|logs|status}"; exit 1
    ;;
esac
