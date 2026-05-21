# MFA 對齊流程 (MFA Alignment Flow)

此文件描述了在前端網頁點擊「MFA」按鈕後，系統從前端到後端再到 MFA 微服務的完整執行流程。

## 1. 前端觸發 (Frontend - `RecordingItem.tsx`)

當使用者點擊某個音檔片段的「MFA」按鈕時，會觸發 `handleAlign` 函數：

1. **基本檢查**：
   - 檢查是否已選擇語言 (`dictionaryId`)。
   - 如果該片段已經有對齊資料 (`recording.hasAlignment`)，跳出確認視窗詢問是否要覆蓋。

2. **事前驗證 (Pre-validation)**：
   - 發送 `POST /api/validate_lyrics` 到 Node.js 後端，傳遞當前的歌詞 (`lyrics`) 與目標模型 (目前寫死為 `japanese_mfa`)。
   - 後端會向 MFA 服務確認歌詞中包含的音素是否都存在於模型中。
   - 若驗證失敗（例如有未知的音素），前端會跳出警告要求使用者至 Mapping Manager 修正，並**中斷後續流程**。

3. **提交對齊任務**：
   - 驗證通過後，發送 `POST /api/align` 給後端，傳遞 `{ filename, dictionaryId }`。
   - 後端將任務加入佇列，並回傳一個 `jobId`。

4. **輪詢狀態 (Polling)**：
   - 呼叫 `startPolling(jobId)`，每 2 秒發送 `GET /api/jobs/${jobId}` 查詢進度。
   - 當狀態變成 `completed`：停止輪詢，並刷新畫面顯示對齊結果。
   - 當狀態變成 `error`：停止輪詢，並跳出錯誤提示。

---

## 2. Node.js 後端 API (`server.js`)

後端接收到前端的請求後，負責任務管理與轉發：

### 驗證階段 (`/api/validate_lyrics`)
- 透過 `mfaService.validateLyrics` 將請求轉發給 MFA 微服務 (Port 8001) 的 `/validate_lyrics` 端點。

### 提交階段 (`/api/align`)
1. **防止重複提交**：檢查該 `filename` 是否已經有正在 `pending` 或 `processing` 的任務。
2. **檔案檢查**：確認該音檔對應的 `.txt` 歌詞檔是否存在。
3. **建立任務**：產生一個 `jobId`，將任務狀態設為 `pending`。
4. **加入佇列**：將任務資料 (包含 wav, txt, lab 等路徑) 推入 `mfaQueue` 陣列。
5. **觸發處理**：呼叫 `processMfaQueue()`。
6. **設定超時**：設定 10 分鐘的計時器，時間到自動從記憶體中清除該 job 狀態。
7. 回傳 `jobId` 給前端。

---

## 3. 後端佇列處理 (`processMfaQueue`)

為了避免頻繁呼叫 MFA 服務，後端實作了批次處理機制：

1. **防抖等待 (Debounce/Batching)**：
   - 若已經在處理中 (`isMfaProcessing === true`) 則跳出。
   - 等待 300 毫秒，收集這段時間內所有進入 `mfaQueue` 的任務，組合成一個批次 (Batch)。

2. **準備資料**：
   - 讀取批次中每個任務的 `.txt` 歌詞內容。
   - 將每個任務的 `.wav` 檔案建立讀取串流 (ReadStream)。
   - 組裝成一個 `FormData`，包含所有的 `wavs` 檔案與 `lyrics_json` (檔名對應歌詞的 JSON 字串)。

3. **呼叫 MFA 微服務**：
   - 透過 `mfaService.alignBatch(form)`，發送 `POST /align_batch` 請求到 MFA 微服務。

4. **處理回傳結果**：
   - MFA 微服務會回傳一個包含各檔案結果的字典 `{ [filename]: resultString }`。
   - 對於每個任務：
     - **若成功**：
       1. **儲存原始結果**：將帶有信心分數 (Confidence Scores) 的原始結果儲存為 `.conf` 檔案。
       2. **清理結果**：移除信心分數、以 `#` 開頭的 Metadata 以及 `[!]` 標記，只保留標準的 `開始時間 結束時間 音素` 格式。
       3. **儲存對齊結果**：將清理後的結果儲存覆蓋原本的 `.lab` 檔案。
       4. 更新狀態為 `completed`。
     - **若失敗**：更新狀態為 `error`，並記錄錯誤訊息。
   
5. **遞迴觸發**：處理完畢後，等待 500 毫秒再次呼叫 `processMfaQueue()` 檢查是否有新任務。

---

## 4. MFA 微服務 (Python Service)

雖然不在 Node.js 範圍內，但主要負責接收來自 Node.js 後端的 `/align_batch` 請求，執行核心的 Montreal Forced Aligner (MFA) 聲學模型對齊計算，並回傳包含音素邊界與信心分數的結果。

### 羅馬拼音與 IPA 轉換 (Dictionary Generation)
在真正執行 MFA 對齊之前，Python 服務會先進行羅馬拼音到 IPA 的轉換，以滿足 MFA 模型的需求：
1. **載入映射表**：根據請求傳入的模型名稱（例如 `japanese_mfa`），載入對應的字典映射配置 (`dict_map`)。
2. **生成自訂字典 (`dict.txt`)**：
   - 提取批次任務中所有 `.lab` 檔案裡的羅馬拼音單字。
   - 透過映射表 (`dict_map`)，將每一個羅馬拼音轉換為對應的 IPA 音素序列。
   - 產生一個暫時的 MFA 專用字典檔 (`dict.txt`)，格式為 `單字\t音素`。
3. **執行對齊**：MFA 在執行時，就會根據這個自訂的 `dict.txt` 檔案，正確地將音檔、羅馬拼音與聲學模型裡的 IPA 音素進行對齊計算。
