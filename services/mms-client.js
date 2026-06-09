const FormData = require('form-data');
const ServiceClient = require('./service-client');

const MMS_PORT = process.env.MMS_PORT || 8002;

const mmsClient = new ServiceClient('MMS', `http://localhost:${MMS_PORT}`, {
    maxRetries: 3,
    retryDelayMs: 1000,
    timeoutMs: 30000,
});

/**
 * 批次對齊
 *
 * @param {FormData} form - 已組好的 multipart form（wavs + lyrics_json）
 * @returns {Promise<object>} - { [filename]: resultString }
 */
async function alignBatch(form) {
    const response = await mmsClient.request({
        method: 'POST',
        url: '/align_batch',
        data: form,
        headers: form.getHeaders(),
        maxContentLength: Infinity,
        maxBodyLength: Infinity,
        timeout: 600000, // 10 min
    }, 1);
    return response.data;
}

/**
 * 手動觸發微調
 * @param {number} [epochs=20]
 * @param {number} [lr=0.001]
 * @returns {Promise<object>}
 */
async function train(epochs = 20, lr = 0.001) {
    const form = new FormData();
    form.append('epochs', String(epochs));
    form.append('lr', String(lr));

    const response = await mmsClient.request({
        method: 'POST',
        url: '/train',
        data: form,
        headers: form.getHeaders(),
        timeout: 30000,
    });
    return response.data;
}

/**
 * 查詢微調狀態
 * @returns {Promise<object>}
 */
async function getStatus() {
    const response = await mmsClient.request({
        method: 'GET',
        url: '/status',
        timeout: 10000,
    });
    return response.data;
}

/**
 * 獲取支援的詞典集
 * @returns {Promise<string[]>}
 */
async function getDictionary() {
    const response = await mmsClient.request({
        method: 'GET',
        url: '/dictionary',
        timeout: 10000,
    });
    return response.data;
}

/**
 * Health check
 * @returns {Promise<{ ok: boolean, latencyMs: number, error?: string }>}
 */
async function healthCheck() {
    return mmsClient.healthCheck();
}

/**
 * Delete fine-tuned model
 * @returns {Promise<object>}
 */
async function deleteModel() {
    const response = await mmsClient.request({
        method: 'DELETE',
        url: '/model',
        timeout: 10000,
    });
    return response.data;
}

module.exports = { alignBatch, train, getStatus, getDictionary, healthCheck, deleteModel };
