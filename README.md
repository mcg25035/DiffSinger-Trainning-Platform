# DiffSinger Training Platform

這是一個基於 Docker 與 Node.js 的高可用性架構，專為 AI 音訊處理 (MFA 對齊與 SenseVoice 語音辨識) 所設計。

## 🛡️ 安全架構 (DevSecOps)

為了在自動化部署與系統安全之間取得平衡，本專案實作了嚴密的信任鏈系統：

1. **全域指紋掃描 (Manifest Check)**：
   每次服務啟動前，系統會掃描專案內所有的腳本 (`.sh`, `.py`) 與配置檔 (`Dockerfile`, `.env`)。如果偵測到任何未經授權的修改或新增檔案（影子腳本），服務將會被系統層級強制攔截並拒絕啟動。
2. **信任分級授權 (Trust Manager)**：
   您可以選擇「永久信任本專案的合法更新 (REPO)」或「僅信任單次提交 (COMMIT)」。
3. **免密碼服務重啟 (Sudoers Whitelist)**：
   為了自動化 CI/CD，部署腳本會在第一次執行時，將當前用戶加入 `sudoers` 白名單。您後續重啟 `ds-mfa` 或 `ds-lyrics` 服務時**完全不需要輸入 root 密碼**，且無法藉此越權執行其他指令。

## 🚀 新伺服器部署指南

在新機器上部署時，請遵循以下步驟：

1. **拉取代碼**：
   \`\`\`bash
   git clone <your-repo-url>
   cd DiffSinger-Trainning-Platform
   \`\`\`

2. **執行初始化與部署**：
   強烈建議使用 \`update.sh\` 作為唯一入口：
   \`\`\`bash
   ./update.sh
   \`\`\`

3. **首次部署注意事項**：
   * 腳本會自動偵測您的 OS 與 GPU 驅動 (支援動態降級 CUDA 版本)。
   * **授權提示**：腳本會要求您選擇信任等級（建議輸入 \`1\`）。
   * **提權提示**：在最後階段註冊 Systemd 服務時，系統會**要求您輸入一次 sudo 密碼**。這是為了自動化配置後續的免密碼環境。

## ⚙️ 常用管理指令

系統部署完成後，您可以使用以下指令（無需密碼）：

* **查看服務狀態**：
  \`\`\`bash
  systemctl status ds-mfa ds-lyrics
  \`\`\`
* **查看即時日誌**：
  \`\`\`bash
  sudo journalctl -u ds-lyrics -f
  \`\`\`
* **手動重啟服務**：
  \`\`\`bash
  sudo systemctl restart ds-mfa
  \`\`\`

## 🔧 環境配置 (.env)

專案預設使用「智慧環境探測」來決定 CUDA 與 Torch 版本。
如果您需要強制覆蓋設定，請編輯 \`.env\` 檔案取消註解：
\`\`\`env
# CUDA_VERSION=11.0.3
# TORCH_VERSION=1.7.1+cu110
MFA_PORT=8001
\`\`\`
修改後執行 \`./update.sh\` 即可套用。
