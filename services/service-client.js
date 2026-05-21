const axios = require('axios');

/**
 * 子服務 API 客戶端基底類別
 * 提供統一的 retry 邏輯、health check、和 axios 實例管理
 */
class ServiceClient {
    /**
     * @param {string} name - 服務名稱（用於日誌）
     * @param {string} baseURL - 服務的 base URL，例如 'http://localhost:8001'
     * @param {object} [options]
     * @param {number} [options.maxRetries=3] - 最大重試次數
     * @param {number} [options.retryDelayMs=1000] - 初始重試延遲（exponential backoff）
     * @param {number} [options.timeoutMs=30000] - 預設 request timeout
     */
    constructor(name, baseURL, options = {}) {
        this.name = name;
        this.baseURL = baseURL;
        this.maxRetries = options.maxRetries ?? 3;
        this.retryDelayMs = options.retryDelayMs ?? 1000;

        this.client = axios.create({
            baseURL,
            timeout: options.timeoutMs ?? 30000,
        });
    }

    /**
     * 帶 exponential backoff 的 request wrapper
     *
     * Retry 策略：
     * - Network error (ECONNREFUSED, ETIMEDOUT 等)：retry
     * - HTTP 5xx：retry
     * - HTTP 4xx：不 retry（客戶端錯誤，重試也沒用）
     *
     * @param {import('axios').AxiosRequestConfig} config - axios request config
     * @param {number} [retryOverride] - 覆蓋此次呼叫的最大重試次數
     * @returns {Promise<import('axios').AxiosResponse>}
     */
    async request(config, retryOverride) {
        const maxRetries = retryOverride ?? this.maxRetries;
        let lastError;

        for (let attempt = 0; attempt <= maxRetries; attempt++) {
            try {
                const response = await this.client.request(config);
                return response;
            } catch (err) {
                lastError = err;

                const status = err.response?.status;
                // 有 HTTP 回應且不是 5xx → 不 retry
                const isRetryable = !status || status >= 500;

                if (!isRetryable || attempt === maxRetries) {
                    throw err;
                }

                const delay = this.retryDelayMs * Math.pow(2, attempt);
                console.warn(
                    `[${this.name}] Request failed (attempt ${attempt + 1}/${maxRetries + 1}), ` +
                    `retrying in ${delay}ms: ${err.message}`
                );
                await new Promise(resolve => setTimeout(resolve, delay));
            }
        }

        throw lastError;
    }

    /**
     * Health check: GET /health
     * 不會 throw，永遠回傳結果物件
     *
     * @returns {Promise<{ ok: boolean, latencyMs: number, error?: string }>}
     */
    async healthCheck() {
        const start = Date.now();
        try {
            await this.client.get('/health', { timeout: 5000 });
            return { ok: true, latencyMs: Date.now() - start };
        } catch (err) {
            return { ok: false, latencyMs: Date.now() - start, error: err.message };
        }
    }
}

module.exports = ServiceClient;
