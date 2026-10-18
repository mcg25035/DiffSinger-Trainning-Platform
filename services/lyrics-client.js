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
    if (!fs.existsSync(wavPath)) {
        throw new Error(`File not found: ${wavPath}`);
    }
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

// 與 SenseVoice 端 app.py 的 split_romaji 同規則:
// SenseVoice 的 rough romaji 是「音節分隔」(ki i ro ni a ka ne ...),
// 若參考歌詞用一般單字分隔(akane sasu ...),比對器逐詞 DP 會對不上。
// 這裡統一把參考歌詞正規化成音節分隔,讓兩種輸入格式都能正確比對。
const { splitRomajiToMorae } = require('./romaji-mora');

function splitRomajiSyllables(text) {
    return splitRomajiToMorae(text).join(' ');
}

async function transcribeWithLyrics(wavPath, fullLyrics) {
    if (!fs.existsSync(wavPath)) {
        throw new Error(`File not found: ${wavPath}`);
    }
    const form = new FormData();
    form.append('file', fs.createReadStream(wavPath));
    form.append('full_lyrics', splitRomajiSyllables(fullLyrics));

    const response = await lyricsClient.request({
        method: 'POST',
        url: '/transcribe_with_lyrics',
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

module.exports = { transcribe, transcribeWithLyrics, healthCheck };
