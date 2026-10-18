// 簡易 WAV (PCM) 讀寫工具 — 用於把 take 在 mora 邊界切成訓練用 segment
const fs = require('fs');

/** 讀取 PCM WAV,回傳 { sampleRate, channels, bitsPerSample, data: Buffer } */
function readWav(filePath) {
    const buf = fs.readFileSync(filePath);
    if (buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WAVE') {
        throw new Error(`Not a RIFF/WAVE file: ${filePath}`);
    }
    let offset = 12;
    let fmt = null;
    let data = null;
    while (offset + 8 <= buf.length) {
        const id = buf.toString('ascii', offset, offset + 4);
        const size = buf.readUInt32LE(offset + 4);
        const payload = offset + 8;
        if (id === 'fmt ') {
            fmt = {
                audioFormat: buf.readUInt16LE(payload),
                channels: buf.readUInt16LE(payload + 2),
                sampleRate: buf.readUInt32LE(payload + 4),
                bitsPerSample: buf.readUInt16LE(payload + 14),
            };
        } else if (id === 'data') {
            data = buf.subarray(payload, payload + size);
        }
        offset = payload + size + (size % 2); // chunks are word-aligned
    }
    if (!fmt || !data) throw new Error(`Malformed WAV: ${filePath}`);
    if (fmt.audioFormat !== 1 || fmt.bitsPerSample !== 16) {
        throw new Error(`Only 16-bit PCM WAV supported, got format=${fmt.audioFormat} bits=${fmt.bitsPerSample}`);
    }
    return { sampleRate: fmt.sampleRate, channels: fmt.channels, bitsPerSample: fmt.bitsPerSample, data };
}

/** 寫出 16-bit PCM WAV */
function writeWav(filePath, { sampleRate, channels, data }) {
    const byteRate = sampleRate * channels * 2;
    const blockAlign = channels * 2;
    const header = Buffer.alloc(44);
    header.write('RIFF', 0, 'ascii');
    header.writeUInt32LE(36 + data.length, 4);
    header.write('WAVE', 8, 'ascii');
    header.write('fmt ', 12, 'ascii');
    header.writeUInt32LE(16, 16);
    header.writeUInt16LE(1, 20); // PCM
    header.writeUInt16LE(channels, 22);
    header.writeUInt32LE(sampleRate, 24);
    header.writeUInt32LE(byteRate, 28);
    header.writeUInt16LE(blockAlign, 32);
    header.writeUInt16LE(16, 34);
    header.write('data', 36, 'ascii');
    header.writeUInt32LE(data.length, 40);
    fs.writeFileSync(filePath, Buffer.concat([header, data]));
}

/** 依秒數切出 [startSec, endSec] 區間,回傳 Buffer(PCM data) */
function clipSeconds(wav, startSec, endSec) {
    const bytesPerSec = wav.sampleRate * wav.channels * 2;
    const frame = wav.channels * 2;
    let s = Math.max(0, Math.round(startSec * bytesPerSec));
    let e = Math.min(wav.data.length, Math.round(endSec * bytesPerSec));
    s -= s % frame;
    e -= e % frame;
    return Buffer.from(wav.data.subarray(s, e));
}

module.exports = { readWav, writeWav, clipSeconds };
