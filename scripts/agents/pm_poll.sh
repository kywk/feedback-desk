#!/usr/bin/env bash
# PM Agent 輪詢器：定期喚起 OpenCode 的 PM agent（.opencode/agents/pm.md）
# 透過 feedback-desk MCP 收單並處理。流程已寫在 agent 定義與 system prompt，
# 這裡只負責「喚起 agent」，不再內嵌整段流程 prompt。
set -euo pipefail

# opencode 在 non-login shell 下可能不在 PATH，補上 Homebrew 安裝位置。
export PATH="$PATH:/opt/homebrew/bin:/usr/local/bin"
OPENCODE="${OPENCODE:-$(command -v opencode || echo /opt/homebrew/bin/opencode)}"

# token 是祕密：只從環境變數讀，不寫死在腳本。沒設就警告並退出。
: "${FEEDBACK_DESK_MCP_TOKEN:?[PM Agent] 未設定 FEEDBACK_DESK_MCP_TOKEN（pm-agent 的 token），請先 export 後再執行}"

MODEL="${PM_MODEL:-opencode-go/muse-spark-1.3-contributor#xhigh}"
INTERVAL="${PM_INTERVAL:-30}"
POLL_LOG="${PM_POLL_LOG:-/tmp/pm_agent_poll.log}"

# --session 用 ses 開頭，可跨輪沿用同一 session 保持上下文。
SESSION_ID="ses_pmagent"
PROMPT="請用 feedback-desk MCP 收單並處理（見你的 system prompt）。"

echo "[PM Agent] 啟動輪詢，每 ${INTERVAL}s 喚起一次 PM agent（模型 ${MODEL}）。"
echo "[PM Agent] log: ${POLL_LOG}"

while true; do
  echo "=== $(date '+%F %T') PM poll ===" | tee -a "$POLL_LOG"
  # --standalone：開私有 server 繼承目前 shell 的環境變數，{env:FEEDBACK_DESK_MCP_TOKEN}
  # 才能在 server 程序裡解析；否則會連到沒有 token 的背景 service 而 401。
  "$OPENCODE" run --standalone -m "$MODEL" --agent pm --session "$SESSION_ID" "$PROMPT" >>"$POLL_LOG" 2>&1 || true
  sleep "$INTERVAL"
done
