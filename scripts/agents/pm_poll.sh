#!/usr/bin/env bash
# 同一專案以隊列作為預設。只有尚未啟用隊列的既有部署才明確指定 legacy。
set -euo pipefail
export PATH="$PATH:/opt/homebrew/bin:/usr/local/bin"

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
case "${FEEDBACK_DESK_POLL_MODE:-queue}" in
  queue)
    exec "${NODE_BIN:-node}" "$SCRIPT_DIR/consumer/cli.mjs" "$@"
    ;;
  legacy)
    if [[ "$#" -ne 0 || -n "${FEEDBACK_DESK_AUTOMATION_TOKEN:-}" || -n "${FEEDBACK_DESK_CONSUMER_STATE:-}" ]]; then
      echo "[PM Agent] legacy 模式不能與隊列設定或參數同時使用。" >&2
      exit 1
    fi
    ;;
  *)
    echo "[PM Agent] FEEDBACK_DESK_POLL_MODE 只接受 queue 或 legacy。" >&2
    exit 1
    ;;
esac

OPENCODE="${OPENCODE:-$(command -v opencode || echo /opt/homebrew/bin/opencode)}"

# token 是祕密：只從環境變數讀，不寫死在腳本。沒設就警告並退出。
: "${FEEDBACK_DESK_MCP_TOKEN:?[PM Agent] 未設定 FEEDBACK_DESK_MCP_TOKEN（pm-agent 的 token），請先 export 後再執行}"

MODEL="${PM_MODEL:-opencode-go/muse-spark-1.3-contributor#xhigh}"
INTERVAL="${PM_INTERVAL:-30}"
POLL_LOG="${PM_POLL_LOG:-/tmp/pm_agent_poll.log}"

# --session 用 ses 開頭，可跨輪沿用同一 session 保持上下文。
SESSION_ID="ses_pmagent"
PROMPT="請用 airedale MCP 收單並處理（見你的 system prompt）。"

echo "[PM Agent] 啟動輪詢，每 ${INTERVAL}s 喚起一次 PM agent（模型 ${MODEL}）。"
echo "[PM Agent] log: ${POLL_LOG}"

while true; do
  echo "=== $(date '+%F %T') PM poll ===" | tee -a "$POLL_LOG"
  # --standalone：開私有 server 繼承目前 shell 的環境變數，{env:FEEDBACK_DESK_MCP_TOKEN}
  # 才能在 server 程序裡解析；否則會連到沒有 token 的背景 service 而 401。
  "$OPENCODE" run --standalone -m "$MODEL" --agent pm --session "$SESSION_ID" "$PROMPT" >>"$POLL_LOG" 2>&1 || true
  sleep "$INTERVAL"
done
