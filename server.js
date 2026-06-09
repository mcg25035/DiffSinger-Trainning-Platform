const express = require('express');
const multer = require('multer');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const FormData = require('form-data');
const mfaService = require('./services/mfa-client');
const lyricsService = require('./services/lyrics-client');
const mmsService = require('./services/mms-client');

const app = express();
require('dotenv').config();
const PORT = process.env.BACKEND_PORT || 3010;

app.use(cors());
app.use(express.static('public'));
app.use('/uploads', express.static('uploads'));
app.use('/upload_segments', express.static('upload_segments'));

const uploadsDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadsDir)) {
    fs.mkdirSync(uploadsDir);
}

const segmentsDir = path.join(__dirname, 'upload_segments');
if (!fs.existsSync(segmentsDir)) {
    fs.mkdirSync(segmentsDir);
}

const chunkUploadDir = path.join(__dirname, 'upload_chunks');
if (!fs.existsSync(chunkUploadDir)) {
    fs.mkdirSync(chunkUploadDir);
}

const dictionariesDir = path.join(__dirname, 'dictionaries');
if (!fs.existsSync(dictionariesDir)) {
    fs.mkdirSync(dictionariesDir);
}

const mappingsDir = path.join(__dirname, 'mfa/mfa_service/app/mappings');
if (!fs.existsSync(mappingsDir)) {
    fs.mkdirSync(mappingsDir, { recursive: true });
}

// In-memory job tracking
const jobs = {};
let mfaQueue = [];
let isMfaProcessing = false;

function mapRomajiToPhonemes(romajiStr, mapping) {
    if (!mapping || !mapping.dictionary) {
        return romajiStr;
    }
    const words = romajiStr.trim().split(/\s+/);
    const phonemes = [];
    
    for (const word of words) {
        if (!word) continue;
        const ipaStr = mapping.dictionary[word] || mapping.dictionary[word.toLowerCase()];
        if (ipaStr) {
            const ipaSymbols = ipaStr.split(/\s+/);
            for (const sym of ipaSymbols) {
                const mappedSym = mapping.reverse_mapping[sym] ?? sym;
                phonemes.push(mappedSym);
            }
        } else {
            // Fallback: if not in dictionary, just push individual characters
            for (const char of word) {
                phonemes.push(char.toLowerCase());
            }
        }
    }
    return phonemes.join(' ');
}

async function processMfaQueue() {
    if (isMfaProcessing || mfaQueue.length === 0) return;
    
    isMfaProcessing = true;
    
    // Wait a bit to collect more items if they are arriving in a burst
    await new Promise(resolve => setTimeout(resolve, 300));
    
    const firstTask = mfaQueue[0];
    const aligner = firstTask.aligner || 'mfa';
    const dictionaryId = firstTask.dictionaryId;
    
    // Take all current tasks with same aligner and dictionaryId as a batch
    const batch = mfaQueue.filter(t => 
        (t.aligner || 'mfa') === aligner && 
        t.dictionaryId === dictionaryId
    );
    mfaQueue = mfaQueue.filter(t => !batch.includes(t));
    
    console.log(`[ALIGN-QUEUE] Processing batch of ${batch.length} files using aligner: ${aligner}`);
    
    let mapping = null;
    if (dictionaryId) {
        try {
            const dictPath = path.join(__dirname, 'dictionaries', `${dictionaryId}.json`);
            if (fs.existsSync(dictPath)) {
                const dict = JSON.parse(fs.readFileSync(dictPath, 'utf-8'));
                const modelName = dict.mfa_model || 'japanese_mfa';
                const mappingPath = path.join(mappingsDir, `${modelName}.json`);
                if (fs.existsSync(mappingPath)) {
                    mapping = JSON.parse(fs.readFileSync(mappingPath, 'utf-8'));
                }
            }
        } catch (e) {
            console.error(`[ALIGN-QUEUE] Failed to load mapping for dictionary ${dictionaryId}:`, e.message);
        }
    }
    
    const lyricsData = {};
    const form = new FormData();
    
    for (const task of batch) {
        const { jobId, filename, wavPath, txtPath } = task;
        jobs[jobId].status = 'processing';
        
        try {
            let lyrics = fs.readFileSync(txtPath, 'utf-8');
            if (aligner === 'mms' && mapping) {
                lyrics = mapRomajiToPhonemes(lyrics, mapping);
            }
            lyricsData[filename] = lyrics;
            form.append('wavs', fs.createReadStream(wavPath), { filename });
        } catch (err) {
            jobs[jobId].status = 'error';
            jobs[jobId].error = `File read error: ${err.message}`;
        }
    }
    
    // Filter out tasks that failed during preparation
    const activeTasks = batch.filter(t => jobs[t.jobId].status === 'processing');
    
    if (activeTasks.length === 0) {
        isMfaProcessing = false;
        setTimeout(processMfaQueue, 500);
        return;
    }

    form.append('lyrics_json', JSON.stringify(lyricsData));

    try {
        let results;
        if (aligner === 'mms') {
            results = await mmsService.alignBatch(form);
        } else {
            results = await mfaService.alignBatch(form, { model: mapping?.model || 'japanese_mfa' });
        }
        
        for (const task of activeTasks) {
            const result = results[task.filename];
            if (result && !result.startsWith('ERROR:')) {
                // 儲存原始結果（含信心分數）到 .conf 檔案
                const confPath = task.labPath.replace(/\.lab$/, '.conf');
                fs.writeFileSync(confPath, result);

                // 清理結果：移除信心分數、[!] 標記以及以 # 開頭的 metadata
                const cleanedResult = result.split('\n')
                    .map(line => line.trim())
                    .filter(line => line && !line.startsWith('#'))
                    .map(line => {
                        const parts = line.split(/\s+/);
                        // 只保留前三個欄位：開始時間 結束時間 音素
                        if (parts.length >= 3) {
                            return `${parts[0]} ${parts[1]} ${parts[2]}`;
                        }
                        return line;
                    })
                    .join('\n');
                
                fs.writeFileSync(task.labPath, cleanedResult);
                jobs[task.jobId].status = 'completed';
            } else {
                jobs[task.jobId].status = 'error';
                jobs[task.jobId].error = result || 'Alignment failed';
            }
        }
    } catch (err) {
        console.error(`[ALIGN-QUEUE] Batch processing failed:`, err.message);
        if (err.response && err.response.data) {
            console.error(`[ALIGN-QUEUE] Service Error Details:\n`, err.response.data);
        }
        for (const task of activeTasks) {
            jobs[task.jobId].status = 'error';
            jobs[task.jobId].error = err.message;
        }
    } finally {
        isMfaProcessing = false;
        setTimeout(processMfaQueue, 500); // Small delay before next batch
    }
}

// --- Health Check ---
app.get('/api/health', async (req, res) => {
    const [mfa, lyrics, mms] = await Promise.all([
        mfaService.healthCheck(),
        lyricsService.healthCheck(),
        mmsService.healthCheck(),
    ]);
    const allOk = mfa.ok && lyrics.ok && mms.ok;
    res.status(allOk ? 200 : 500).json({
        ok: allOk,
        services: { mfa, lyrics, mms },
    });
});

app.get('/api/jobs/:id', (req, res) => {
    const job = jobs[req.params.id];
    if (!job) return res.status(404).send('Job not found');
    res.json(job);
});

app.get('/api/dictionaries', (req, res) => {
    const files = fs.readdirSync(dictionariesDir).filter(f => f.endsWith('.json'));
    const dicts = files.map(f => {
        const content = JSON.parse(fs.readFileSync(path.join(dictionariesDir, f), 'utf-8'));
        return content;
    });
    res.json(dicts);
});

app.post('/api/dictionaries', express.json(), (req, res) => {
    const dict = req.body;
    if (!dict.id || !dict.name || !Array.isArray(dict.phonemes)) {
        return res.status(400).send('Invalid dictionary data');
    }
    const filePath = path.join(dictionariesDir, `${dict.id}.json`);
    fs.writeFileSync(filePath, JSON.stringify(dict, null, 2));
    res.json({ success: true });
});

app.delete('/api/dictionaries/:id', (req, res) => {
    const filePath = path.join(dictionariesDir, `${req.params.id}.json`);
    if (fs.existsSync(filePath)) {
        fs.unlinkSync(filePath);
        res.json({ success: true });
    } else {
        res.status(404).send('Not found');
    }
});

app.get('/api/mappings', (req, res) => {
    const files = fs.readdirSync(mappingsDir).filter(f => f.endsWith('.json'));
    const mappings = files.map(f => {
        const id = f.replace('.json', '');
        const content = JSON.parse(fs.readFileSync(path.join(mappingsDir, f), 'utf-8'));
        return { id, ...content };
    });
    res.json(mappings);
});

app.post('/api/mappings', express.json(), (req, res) => {
    const mapping = req.body;
    if (!mapping.id || !mapping.dictionary) {
        return res.status(400).send('Invalid mapping data');
    }
    const { id, ...content } = mapping;
    const filePath = path.join(mappingsDir, `${id}.json`);
    fs.writeFileSync(filePath, JSON.stringify(content, null, 2));
    res.json({ success: true });
});

app.delete('/api/mappings/:id', (req, res) => {
    const filePath = path.join(mappingsDir, `${req.params.id}.json`);
    if (fs.existsSync(filePath)) {
        fs.unlinkSync(filePath);
        res.json({ success: true });
    } else {
        res.status(404).send('Not found');
    }
});

app.get('/api/mfa/models', async (req, res) => {
    try {
        const data = await mfaService.getModels();
        res.json(data);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.get('/api/mfa/phones/:model', async (req, res) => {
    try {
        const data = await mfaService.getModelPhones(req.params.model);
        res.json(data);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/lyrics/bulk', express.json(), (req, res) => {
    const { updates } = req.body; // Array of { filename, lyrics }
    if (!Array.isArray(updates)) return res.status(400).send('Invalid data');
    
    updates.forEach(({ filename, lyrics }) => {
        const txtFilename = filename.replace(/\.wav$/, '.txt');
        const txtPath = path.join(segmentsDir, txtFilename);
        const pendingPath = path.join(segmentsDir, filename.replace(/\.wav$/, '.pending'));
        
        fs.writeFileSync(txtPath, lyrics);
        if (fs.existsSync(pendingPath)) {
            fs.unlinkSync(pendingPath);
        }
    });
    res.json({ success: true });
});

function getNextNumber(dir) {
    const files = fs.readdirSync(dir);
    const nums = files
        .filter(f => /^\d+\.wav$/.test(f))
        .map(f => parseInt(f.split('.')[0], 10))
        .sort((a, b) => b - a);
    return (nums.length > 0 ? nums[0] + 1 : 1);
}

const storage = multer.diskStorage({
    destination: (req, file, cb) => {
        if (req.body.type === 'upload_segments') {
            cb(null, 'upload_segments/');
        } else {
            cb(null, 'uploads/');
        }
    },
    filename: (req, file, cb) => {
        // req.body is populated as long as text fields come BEFORE the file in FormData
        console.log(`[UPLOAD] Type: ${req.body.type}, Original: ${file.originalname}`);
        
        if (req.body.type === 'upload_segments') {
            const num = getNextNumber(segmentsDir);
            const name = String(num).padStart(3, '0') + '.wav';
            console.log(`[STRICT] Renaming to: ${name}`);
            cb(null, name);
        } else if (req.body.type === 'adopted') {
            // Backward compatibility or legacy support if needed
            const num = getNextNumber(uploadsDir);
            const name = String(num).padStart(3, '0') + '.wav';
            cb(null, name);
        } else {
            cb(null, `raw-audio-${Date.now()}-${Math.floor(Math.random() * 1000)}.wav`);
        }
    }
});

const upload = multer({ storage: storage });

async function transcribeFile(filename) {
    const wavPath = path.join(segmentsDir, filename);
    const txtPath = wavPath.replace(/\.wav$/, '.txt');
    const pendingPath = wavPath.replace(/\.wav$/, '.pending');

    try {
        const data = await lyricsService.transcribe(wavPath);

        if (data && data.romaji) {
            fs.writeFileSync(txtPath, data.romaji);
            fs.writeFileSync(pendingPath, ''); 
            console.log(`[AI] Transcribed ${filename}: ${data.romaji}`);
            return { success: true, lyrics: data.romaji };
        }
    } catch (err) {
        console.error(`[AI] Transcription Failed for ${filename}:`, err.message);
        return { success: false, error: err.message };
    }
    return { success: false, error: 'No data' };
}

app.post('/upload', upload.single('audio'), async (req, res) => {
    if (!req.file) return res.status(400).send('No file');
    
    const filename = req.file.filename;
    const type = req.body.type;

    if (type === 'upload_segments') {
        // Trigger async transcription without waiting for response
        transcribeFile(filename);
    }

    res.json({ filename: filename });
});

app.post('/upload_chunk', express.raw({ limit: '20mb', type: '*/*' }), (req, res) => {
    const { uploadId, chunkIndex } = req.query;
    if (!uploadId || chunkIndex === undefined) return res.status(400).send('Missing params');
    
    const chunkPath = path.join(chunkUploadDir, `${uploadId}_${chunkIndex}`);
    fs.writeFileSync(chunkPath, req.body);
    res.json({ success: true });
});

app.post('/upload_complete', express.json(), (req, res) => {
    const { uploadId, totalChunks, filename, type } = req.body;
    
    let finalName = '';
    if (type === 'upload_segments') {
        finalName = String(getNextNumber(segmentsDir)).padStart(3, '0') + '.wav';
    } else {
        finalName = `raw-audio-${Date.now()}-${Math.floor(Math.random() * 1000)}.wav`;
    }
    
    const finalPath = type === 'upload_segments' 
        ? path.join(segmentsDir, finalName) 
        : path.join(uploadsDir, finalName);
        
    const writeStream = fs.createWriteStream(finalPath);
    for (let i = 0; i < totalChunks; i++) {
        const chunkPath = path.join(chunkUploadDir, `${uploadId}_${i}`);
        if (!fs.existsSync(chunkPath)) {
            return res.status(400).send(`Missing chunk ${i}`);
        }
        const data = fs.readFileSync(chunkPath);
        writeStream.write(data);
        fs.unlinkSync(chunkPath);
    }
    writeStream.end();
    
    if (type === 'upload_segments') {
        transcribeFile(finalName);
    }
    
    res.json({ filename: finalName });
});

app.post('/api/transcribe', express.json(), async (req, res) => {
    const { filename } = req.body;
    if (!filename) return res.status(400).send('Missing filename');
    
    const result = await transcribeFile(filename);
    res.json(result);
});

app.post('/api/transcribe_with_lyrics', express.json(), async (req, res) => {
    const { filename, fullLyrics } = req.body;
    if (!filename) return res.status(400).send('Missing filename');
    if (!fullLyrics) return res.status(400).send('Missing fullLyrics');
    
    const wavPath = path.join(segmentsDir, filename);
    const txtPath = wavPath.replace(/\.wav$/, '.txt');
    const pendingPath = wavPath.replace(/\.wav$/, '.pending');
    
    try {
        const data = await lyricsService.transcribeWithLyrics(wavPath, fullLyrics);
        if (data && data.matched_romaji) {
            fs.writeFileSync(txtPath, data.matched_romaji);
            fs.writeFileSync(pendingPath, '');
            console.log(`[AI with Lyrics] Transcribed ${filename}: ${data.matched_romaji} (score: ${data.match_score})`);
            return res.json({ 
                success: true, 
                lyrics: data.matched_romaji, 
                match_score: data.match_score,
                rough_romaji: data.rough_romaji
            });
        }
    } catch (err) {
        console.error(`[AI with Lyrics] Transcription Failed for ${filename}:`, err.message);
        return res.status(500).json({ success: false, error: err.message });
    }
    res.status(500).json({ success: false, error: 'No data' });
});

app.post('/api/validate_lyrics', express.json(), async (req, res) => {
    const { lyrics, model } = req.body;
    try {
        const data = await mfaService.validateLyrics(lyrics, model);
        res.json(data);
    } catch (err) {
        res.status(500).json({ valid: false, message: err.message });
    }
});

app.post('/api/align', express.json(), async (req, res) => {
    const { filename, dictionaryId, aligner } = req.body;
    if (!filename) return res.status(400).send('Missing filename');
    
    const activeAligner = aligner || 'mfa';

    // Check if already in queue or processing
    const existingJobId = Object.keys(jobs).find(id => 
        jobs[id].filename === filename && 
        (jobs[id].status === 'pending' || jobs[id].status === 'processing')
    );
    if (existingJobId) {
        console.log(`[ALIGN-QUEUE] Task for ${filename} already exists: ${existingJobId}`);
        return res.json({ jobId: existingJobId });
    }

    const jobId = `align-${Date.now()}-${Math.floor(Math.random() * 1000)}`;
    const wavPath = path.join(segmentsDir, filename);
    const txtPath = wavPath.replace(/\.wav$/, '.txt');
    const labPath = wavPath.replace(/\.wav$/, '.lab');

    if (!fs.existsSync(txtPath)) {
        return res.status(400).json({ error: 'Lyrics missing' });
    }

    console.log(`[ALIGN-QUEUE] Adding ${filename} to queue. Job: ${jobId} (Aligner: ${activeAligner})`);
    jobs[jobId] = { status: 'pending', filename };
    
    // Add to queue
    mfaQueue.push({ jobId, filename, wavPath, txtPath, labPath, dictionaryId, aligner: activeAligner });
    
    // Trigger queue processing
    processMfaQueue();

    // Auto-cleanup after 10 mins
    setTimeout(() => delete jobs[jobId], 600000);

    res.json({ jobId });
});

// --- MMS-FA Fine-tuning / Training endpoints & Cron ---

const IS_PROD = process.env.NODE_ENV === 'production' || process.env.NODE_ENV === 'prod';

const fingerprintPath = path.join(__dirname, 'mms_service/data/last_trained_fingerprint.txt');

function getDatasetFingerprint() {
    try {
        const files = fs.readdirSync(segmentsDir);
        const parts = [];
        for (const file of files) {
            if (file.endsWith('.wav')) {
                const wavPath = path.join(segmentsDir, file);
                const checkedPath = wavPath.replace(/\.wav$/, '.checked');
                const txtPath = wavPath.replace(/\.wav$/, '.txt');
                if (fs.existsSync(checkedPath) && fs.existsSync(txtPath)) {
                    const stat = fs.statSync(wavPath);
                    const txtStat = fs.statSync(txtPath);
                    parts.push(`${file}:${stat.size}:${stat.mtimeMs}:${txtStat.mtimeMs}`);
                }
            }
        }
        parts.sort();
        return parts.join('|');
    } catch (e) {
        console.error('[MMS-TRAIN] Failed to generate dataset fingerprint:', e.message);
        return null;
    }
}

function getLastTrainedFingerprint() {
    if (fs.existsSync(fingerprintPath)) {
        try {
            return fs.readFileSync(fingerprintPath, 'utf-8').trim();
        } catch (e) {
            console.error('[MMS-TRAIN] Failed to read last fingerprint file:', e.message);
        }
    }
    return null;
}

function saveLastTrainedFingerprint(fingerprint) {
    try {
        fs.writeFileSync(fingerprintPath, fingerprint, 'utf-8');
    } catch (e) {
        console.error('[MMS-TRAIN] Failed to save fingerprint file:', e.message);
    }
}

async function syncAndTrain(options = {}) {
    const { epochs, lr, dictionaryId } = options;
    const mmsTrainDataDir = path.join(__dirname, 'mms_service/data/training_data');
    
    // Ensure directory exists and is empty
    if (fs.existsSync(mmsTrainDataDir)) {
        const files = fs.readdirSync(mmsTrainDataDir);
        for (const file of files) {
            fs.unlinkSync(path.join(mmsTrainDataDir, file));
        }
    } else {
        fs.mkdirSync(mmsTrainDataDir, { recursive: true });
    }
    
    // Load mapping
    let mapping = null;
    let targetDictId = dictionaryId;
    
    if (!targetDictId) {
        try {
            const files = fs.readdirSync(path.join(__dirname, 'dictionaries')).filter(f => f.endsWith('.json'));
            if (files.length > 0) {
                targetDictId = files[0].replace('.json', '');
            }
        } catch (e) {
            console.error('[MMS-TRAIN] Failed to auto-detect dictionary:', e.message);
        }
    }
    
    if (targetDictId) {
        const dictPath = path.join(__dirname, 'dictionaries', `${targetDictId}.json`);
        if (fs.existsSync(dictPath)) {
            const dict = JSON.parse(fs.readFileSync(dictPath, 'utf-8'));
            const modelName = dict.mfa_model || 'japanese_mfa';
            const mappingPath = path.join(mappingsDir, `${modelName}.json`);
            if (fs.existsSync(mappingPath)) {
                mapping = JSON.parse(fs.readFileSync(mappingPath, 'utf-8'));
            }
        }
    }
    
    const files = fs.readdirSync(segmentsDir);
    let count = 0;
    
    for (const file of files) {
        if (file.endsWith('.wav')) {
            const labFile = file.replace(/\.wav$/, '.lab');
            const txtPath = path.join(segmentsDir, file.replace(/\.wav$/, '.txt'));
            const wavPath = path.join(segmentsDir, file);
            const checkedPath = wavPath.replace(/\.wav$/, '.checked');
            
            // 只有打勾選中的片段（存在 .checked 檔案）且有歌詞（.txt）的片段才加入訓練
            if (!fs.existsSync(checkedPath) || !fs.existsSync(txtPath)) {
                continue;
            }
            
            let lyrics = fs.readFileSync(txtPath, 'utf-8').trim();
            if (!lyrics) continue;
            
            // 用 mapping 把 romaji/word 轉成 phoneme 序列（跟對齊時同樣的邏輯）
            if (mapping) {
                lyrics = mapRomajiToPhonemes(lyrics, mapping);
            }
            
            const phonemes = lyrics.split(/\s+/).filter(p => p && !['pau', 'br', 'sp', 'sil', 'spn'].includes(p));
            
            if (phonemes.length > 0) {
                const targetWavPath = path.join(mmsTrainDataDir, file);
                const targetLabPath = path.join(mmsTrainDataDir, labFile);
                
                fs.copyFileSync(wavPath, targetWavPath);
                fs.writeFileSync(targetLabPath, phonemes.join(' '));
                count++;
            }
        }
    }
    
    if (count === 0) {
        throw new Error('No valid training segments (WAV + TXT pairs) checked.');
    }
    
    console.log(`[MMS-TRAIN] Synced ${count} segments for training.`);
    const result = await mmsService.train(epochs || 20, lr || 0.001);
    
    // 成功觸發訓練後存入指紋
    const currentFingerprint = getDatasetFingerprint();
    if (currentFingerprint) {
        saveLastTrainedFingerprint(currentFingerprint);
    }
    
    return { count, result };
}

app.post('/api/mms/sync-train', express.json(), async (req, res) => {
    const { epochs, lr, dictionaryId } = req.body;
    try {
        const { count, result } = await syncAndTrain({ epochs, lr, dictionaryId });
        res.json({
            message: `Successfully synced ${count} segments. Fine-tuning started in the background.`,
            status: result.status || 'started'
        });
    } catch (err) {
        console.error(`[MMS-TRAIN] Sync and train failed:`, err.message);
        res.status(500).json({ error: err.message });
    }
});

// 非 dev 的正式環境：定期檢查並跑客製化微調
if (IS_PROD) {
    console.log('[MMS-AUTO-TRAIN] Production mode. Scheduling periodic auto-training check.');
    
    const runCheck = async () => {
        console.log('[MMS-AUTO-TRAIN] Running periodic check...');
        try {
            // 先確認目前是否已經在跑訓練或處於暫停狀態
            const status = await mmsService.getStatus();
            if (status && (status.status === 'training' || status.status === 'paused')) {
                console.log('[MMS-AUTO-TRAIN] Service is already training or paused. Skip.');
                return;
            }
            
            // 檢查訓練集指紋是否與上次相同且權重檔依然存在
            const currentFingerprint = getDatasetFingerprint();
            const lastFingerprint = getLastTrainedFingerprint();
            const weightsExist = fs.existsSync(path.join(__dirname, 'mms_service/data/weights/mms_fine_tuned_head.pth'));
            
            if (weightsExist && currentFingerprint && lastFingerprint && currentFingerprint === lastFingerprint) {
                console.log('[MMS-AUTO-TRAIN] Training dataset fingerprint is unchanged. Skip auto-training.');
                return;
            }
            
            const { count } = await syncAndTrain();
            console.log(`[MMS-AUTO-TRAIN] Auto-training triggered successfully with ${count} segments.`);
        } catch (err) {
            console.log('[MMS-AUTO-TRAIN] Auto-training check completed:', err.message);
        }
    };

    // 啟動 10 秒後先跑第一次檢查，之後每小時跑一次
    setTimeout(runCheck, 10000);
    setInterval(runCheck, 3600000); // 1小時 = 3,600,000 ms
}

app.get('/api/mms/status', async (req, res) => {
    try {
        const status = await mmsService.getStatus();
        res.json(status);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.get('/api/mms/health', async (req, res) => {
    try {
        const health = await mmsService.healthCheck();
        res.json(health);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.delete('/api/mms/model', async (req, res) => {
    try {
        const result = await mmsService.deleteModel();
        if (fs.existsSync(fingerprintPath)) {
            fs.unlinkSync(fingerprintPath);
        }
        res.json(result);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/lyrics', express.json(), (req, res) => {
    const { filename, lyrics } = req.body;
    if (!filename || lyrics === undefined) return res.status(400).send('Missing data');
    
    const txtFilename = filename.replace(/\.wav$/, '.txt');
    const txtPath = path.join(segmentsDir, txtFilename);
    const pendingPath = path.join(segmentsDir, filename.replace(/\.wav$/, '.pending'));
    
    fs.writeFileSync(txtPath, lyrics);
    if (fs.existsSync(pendingPath)) {
        fs.unlinkSync(pendingPath);
    }
    res.json({ success: true });
});

app.get('/api/lab/:filename', (req, res) => {
    const filename = req.params.filename.replace(/\.wav$/, '.lab');
    const labPath = path.join(segmentsDir, filename);
    if (fs.existsSync(labPath)) {
        const content = fs.readFileSync(labPath, 'utf-8');
        res.send(content);
    } else {
        res.status(404).send('Lab file not found');
    }
});

app.get('/api/conf/:filename', (req, res) => {
    const filename = req.params.filename.replace(/\.wav$/, '.conf');
    const confPath = path.join(segmentsDir, filename);
    if (fs.existsSync(confPath)) {
        const content = fs.readFileSync(confPath, 'utf-8');
        res.send(content);
    } else {
        res.status(404).send('Conf file not found');
    }
});

app.post('/api/lab/:filename', express.text({ type: '*/*' }), (req, res) => {
    const filename = req.params.filename.replace(/\.wav$/, '.lab');
    const labPath = path.join(segmentsDir, filename);
    fs.writeFileSync(labPath, req.body);
    res.json({ success: true });
});


app.post('/api/check', express.json(), (req, res) => {
    const { filename, checked } = req.body;
    if (!filename) return res.status(400).send('Missing filename');
    
    const txtFile = filename.replace(/\.wav$/, '.txt');
    const checkedFile = filename.replace(/\.wav$/, '.checked');
    const txtPath = path.join(segmentsDir, txtFile);
    const checkedPath = path.join(segmentsDir, checkedFile);
    
    if (checked) {
        if (fs.existsSync(txtPath)) {
            const lyrics = fs.readFileSync(txtPath, 'utf-8');
            fs.writeFileSync(checkedPath, lyrics);
        } else {
            fs.writeFileSync(checkedPath, '');
        }
    } else {
        if (fs.existsSync(checkedPath)) {
            fs.unlinkSync(checkedPath);
        }
    }
    res.json({ success: true });
});

app.get('/api/recordings', (req, res) => {
    const rawFiles = fs.readdirSync(uploadsDir)
        .filter(f => f.endsWith('.wav') && !/^\d+\.wav$/.test(f))
        .map(f => ({ filename: f, type: 'raw' }));
    
    const segmentFiles = fs.readdirSync(segmentsDir)
        .filter(f => f.endsWith('.wav'))
        .map(f => {
            const txtFile = f.replace(/\.wav$/, '.txt');
            const labFile = f.replace(/\.wav$/, '.lab');
            const pendingFile = f.replace(/\.wav$/, '.pending');
            const checkedFile = f.replace(/\.wav$/, '.checked');
            
            let lyrics = '';
            if (fs.existsSync(path.join(segmentsDir, txtFile))) {
                lyrics = fs.readFileSync(path.join(segmentsDir, txtFile), 'utf-8');
            }
            const isPending = fs.existsSync(path.join(segmentsDir, pendingFile));
            const hasAlignment = fs.existsSync(path.join(segmentsDir, labFile));
            const isChecked = fs.existsSync(path.join(segmentsDir, checkedFile));
            
            // Find any active background job for this file
            const activeJobId = Object.keys(jobs).find(id => 
                jobs[id].filename === f && 
                (jobs[id].status === 'pending' || jobs[id].status === 'processing')
            );

            return { filename: f, type: 'segment', lyrics, isPending, hasAlignment, activeJobId, isChecked };
        });

    res.json({ raw: rawFiles, segments: segmentFiles });
});

app.listen(PORT, async () => {
    console.log(`Server listening on ${PORT}`);

    // 非阻塞式等待子服務就緒，最多 60 秒
    const maxWait = 60000;
    const interval = 3000;
    const start = Date.now();

    const waitFor = async (name, checkFn) => {
        while (Date.now() - start < maxWait) {
            const result = await checkFn();
            if (result.ok) {
                console.log(`✅ ${name} service ready (${result.latencyMs}ms)`);
                return;
            }
            await new Promise(r => setTimeout(r, interval));
        }
        console.warn(`⚠️ ${name} service not ready after ${maxWait / 1000}s, continuing anyway`);
    };

    await Promise.all([
        waitFor('MFA', mfaService.healthCheck),
        waitFor('Lyrics', lyricsService.healthCheck),
        waitFor('MMS', mmsService.healthCheck),
    ]);
});
