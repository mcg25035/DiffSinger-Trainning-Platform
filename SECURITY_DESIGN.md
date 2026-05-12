# DiffSinger Training Platform Security & Architecture Design

這份文件詳細記錄了本專案在部署與架構設計上的所有核心決策，旨在向伺服器管理員與開發者解釋「系統為什麼要這樣設計」以及「我們採取了哪些行動來保障安全與穩定」。

## 1. 權限隔離與 Systemd 中介化
**背景**：Docker 預設需要 root 權限 (`sudo`)。如果將使用者直接加入 `docker` 群組，等同於賦予該使用者免密碼的 root 權限，存在極大安全隱患。
**行動**：
* 我們放棄了直接在腳本中使用 `docker-compose up`。
* 改為將 Docker 的啟動邏輯封裝到兩個 Systemd 服務中 (`ds-mfa.service`, `ds-lyrics.service`)。
* 只有 root 可以修改這些服務的配置檔（如掛載路徑）。一般使用者只能透過白名單機制來「重啟」服務，落實了**最小權限原則**。

## 2. 自動化免密碼重啟 (Sudoers Whitelist)
**背景**：為了配合自動化部署 (CI/CD)，腳本不能卡在等待密碼輸入。
**行動**：
* 在系統「首次部署」時，腳本會要求管理員輸入一次密碼，隨後自動將當前使用者寫入 `/etc/sudoers.d/` 的白名單中。
* 該白名單嚴格限制使用者只能免密碼執行 `systemctl restart ds-mfa`、`systemctl restart ds-lyrics` 以及 `journalctl`。既保障了自動化流暢度，也防止了越權操作。

## 3. 全域指紋掃描與執行鏈校驗 (DevSecOps)
**背景**：如果攻擊者在 Git 專案中偷偷混入惡意腳本 (影子腳本)，或是維護者漏掉了某些 PR 的審查，自動部署腳本可能會在不知情的情況下用高權限執行惡意代碼。
**行動**：
* 導入了 `trust_manager.sh` 與 `verify_trust.sh`。
* 系統會對專案內**所有的** `.sh`, `.py`, `.env`, `Dockerfile` 等具備執行或配置能力的檔案進行 `SHA256` 全域指紋計算。
* 每次 Systemd 啟動服務前都會進行指紋比對。只要有任何未經授權的檔案變更，服務將強制攔截並拒絕啟動。
* 更新代碼時，必須透過 `./update.sh` 進行人工審核，並選擇信任等級 (如信任整個 Repo 或僅信任本次 Commit) 才能重新產生授權指紋。

## 4. 智慧環境解析 (Dynamic OS & GPU Discovery)
**背景**：不同的伺服器有不同的作業系統版本與 NVIDIA 驅動限制。如果硬編碼 (Hardcode) 依賴版本，換到新機器就會崩潰。
**行動**：
* 建立了 `resolve_env.sh` 中介層。
* 它會動態讀取 `/etc/os-release` 來決定使用 Ubuntu 20.04 還是 22.04 的基礎鏡像。
* 它會動態讀取 `nvidia-smi`。若驅動較舊 (如 450.x)，自動降級使用 CUDA 11.0 與相容的 PyTorch 1.7.1；若驅動較新，則自動升級至 CUDA 12.1。
* Dockerfile 內部完全參數化，所有版本皆從外部環境變數注入，實現了 100% 的硬體自適應。

## 5. 封殺隱藏相依安裝 (Pip to UV Wrapper)
**背景**：某些 AI 框架 (如 FunASR) 在初始化時會偷跑 `pip install`，這不僅拖慢啟動速度，還可能把我們精心挑選的 PyTorch 版本強制升級，導致 `torchaudio` 出現符號連結錯誤 (Undefined Symbol)。
**行動**：
* 我們在 Dockerfile 中寫入了一個自定義的 `pip` 轉發器 (Wrapper)，將所有內部的 `pip` 呼叫強制攔截並轉交給極速的 `uv` 套件管理器。
* 強制在安裝鏈的所有環節鎖定 `torch` 版本，徹底解決了函式庫之間的版本衝突問題。
