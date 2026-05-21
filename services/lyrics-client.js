const FormData = require('form-data');
const fs = require('fs');
const ServiceClient = require('./service-client');

const LYRICS_PORT = process.env.LYRICS_PORT || 8000;

const lyricsClient = new ServiceClient('Lyrics', `http://localhost:${LYRICS_PORT}`, {
    maxRetries: 3,
    retryDelayMs: 1000,
    timeoutMs: 120000, // 2 min — 語音辨識需要較長時間
});

/**
 * 語音轉歌詞（語音辨識）
 * 取代 server.js 中的 raw axios.post(.../transcribe)
 *
 * @param {string} wavPath - wav 檔案的絕對路徑
 * @returns {Promise<{ romaji: string }>}
 */
async function transcribe(wavPath) {
    const form = new FormData();
    form.append('file', fs.createReadStream(wavPath));

    const response = await lyricsClient.request({
        method: 'POST',
        url: '/transcribe',
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
    return lyricsClient.healthCheck();
}

module.exports = { transcribe, healthCheck };
