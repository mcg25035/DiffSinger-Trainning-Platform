const FormData = require('form-data');
const ServiceClient = require('./service-client');

const MFA_PORT = process.env.MFA_PORT || 8001;

const mfaClient = new ServiceClient('MFA', `http://localhost:${MFA_PORT}`, {
    maxRetries: 3,
    retryDelayMs: 1000,
    timeoutMs: 30000,
});

/**
 * 批次對齊
 * 取代 server.js 中的 raw axios.post(.../align_batch)
 *
 * @param {FormData} form - 已組好的 multipart form（wavs + lyrics_json）
 * @param {object} [options]
 * @param {string} [options.model='japanese_mfa']
 * @param {string} [options.tierType='phones']
 * @returns {Promise<object>} - { [filename]: resultString }
 */
async function alignBatch(form, options = {}) {
    const model = options.model || 'japanese_mfa';
    const tierType = options.tierType || 'phones';

    const response = await mfaClient.request({
        method: 'POST',
        url: `/align_batch?model=${model}&tier_type=${tierType}`,
        data: form,
        headers: form.getHeaders(),
        maxContentLength: Infinity,
        maxBodyLength: Infinity,
        timeout: 600000, // 10 min — 對齊是長時間操作
    }, 1); // align 只 retry 1 次（操作本身很重，且不一定冪等）

    return response.data;
}

/**
 * 取得可用模型列表
 * 取代 server.js 中的 raw axios.get(.../models)
 *
 * @returns {Promise<object>}
 */
async function getModels() {
    const response = await mfaClient.request({ method: 'GET', url: '/models' });
    return response.data;
}

/**
 * 取得指定模型的 phone 列表
 * 取代 server.js 中的 raw axios.get(.../model_phones/:model)
 *
 * @param {string} model - 模型名稱
 * @returns {Promise<object>}
 */
async function getModelPhones(model) {
    const response = await mfaClient.request({ method: 'GET', url: `/model_phones/${model}` });
    return response.data;
}

/**
 * 驗證歌詞是否與模型的 phone set 相容
 * 取代 server.js 中的 raw axios.post(.../validate_lyrics)
 *
 * @param {string} lyrics - romaji 歌詞
 * @param {string} [model='japanese_mfa'] - 模型名稱
 * @returns {Promise<object>}
 */
async function validateLyrics(lyrics, model = 'japanese_mfa') {
    const form = new FormData();
    form.append('romanji_lyrics', lyrics);

    const response = await mfaClient.request({
        method: 'POST',
        url: `/validate_lyrics?model=${model}`,
        data: form,
        headers: form.getHeaders(),
    });
    return response.data;
}

/**
 * Health check
 * @returns {Promise<{ ok: boolean, latencyMs: number, error?: string }>}
 */
async function healthCheck() {
    return mfaClient.healthCheck();
}

module.exports = { alignBatch, getModels, getModelPhones, validateLyrics, healthCheck };
