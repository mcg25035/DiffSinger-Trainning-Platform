const express = require('express');
const multer = require('multer');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const FormData = require('form-data');
const mfaService = require('./services/mfa-client');
const lyricsService = require('./services/lyrics-client');

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

async function processMfaQueue() {
    if (isMfaProcessing || mfaQueue.length === 0) return;
    
    isMfaProcessing = true;
    
    // Wait a bit to collect more items if they are arriving in a burst (e.g. from a "process all" action)
    await new Promise(resolve => setTimeout(resolve, 300));
    
    // Take all current tasks as a batch
    const batch = [...mfaQueue];
    mfaQueue = [];
    
    console.log(`[MFA-QUEUE] Processing batch of ${batch.length} files`);
    
    const lyricsData = {};
    const form = new FormData();
    
    for (const task of batch) {
        const { jobId, filename, wavPath, txtPath } = task;
        jobs[jobId].status = 'processing';
        
        try {
            const lyrics = fs.readFileSync(txtPath, 'utf-8');
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
        const results = await mfaService.alignBatch(form);
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
                jobs[task.jobId].error = result || 'MFA failed';
            }
        }
    } catch (err) {
        console.error(`[MFA-QUEUE] Batch processing failed:`, err.message);
        if (err.response && err.response.data) {
            console.error(`[MFA-QUEUE] Service Error Details:\n`, err.response.data);
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
    const [mfa, lyrics] = await Promise.all([
        mfaService.healthCheck(),
        lyricsService.healthCheck(),
    ]);

    const allOk = mfa.ok && lyrics.ok;
    res.status(allOk ? 200 : 503).json({
        status: allOk ? 'healthy' : 'degraded',
        services: { mfa, lyrics },
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
    const { filename, dictionaryId } = req.body;
    if (!filename) return res.status(400).send('Missing filename');
    
    // Check if already in queue or processing
    const existingJobId = Object.keys(jobs).find(id => 
        jobs[id].filename === filename && 
        (jobs[id].status === 'pending' || jobs[id].status === 'processing')
    );
    if (existingJobId) {
        console.log(`[MFA-QUEUE] Task for ${filename} already exists: ${existingJobId}`);
        return res.json({ jobId: existingJobId });
    }

    const jobId = `align-${Date.now()}-${Math.floor(Math.random() * 1000)}`;
    const wavPath = path.join(segmentsDir, filename);
    const txtPath = wavPath.replace(/\.wav$/, '.txt');
    const labPath = wavPath.replace(/\.wav$/, '.lab');

    if (!fs.existsSync(txtPath)) {
        return res.status(400).json({ error: 'Lyrics missing' });
    }

    console.log(`[MFA-QUEUE] Adding ${filename} to queue. Job: ${jobId}`);
    jobs[jobId] = { status: 'pending', filename };
    
    // Add to queue
    mfaQueue.push({ jobId, filename, wavPath, txtPath, labPath });
    
    // Trigger queue processing
    processMfaQueue();

    // Auto-cleanup after 10 mins
    setTimeout(() => delete jobs[jobId], 600000);

    res.json({ jobId });
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

// TODO: 待移除（下兩次 commit 後刪除）— 一次性邊界遷移
app.post('/api/migrate-lab-boundaries', (req, res) => {
    const labFiles = fs.readdirSync(segmentsDir).filter(f => f.endsWith('.lab'));
    const results = [];

    for (const file of labFiles) {
        const filePath = path.join(segmentsDir, file);
        const content = fs.readFileSync(filePath, 'utf-8');
        const lines = content.split('\n').map(l => l.trim()).filter(l => l.length > 0);

        const parsed = lines.map(line => {
            const parts = line.split(/\s+/);
            if (parts.length < 3) return null;
            const start = parseFloat(parts[0]);
            const end = parseFloat(parts[1]);
            return { start, end, rest: parts.slice(2).join(' ') };
        }).filter(Boolean);

        if (parsed.length === 0) {
            results.push({ file, status: 'skipped', reason: 'empty' });
            continue;
        }

        // 格式偵測：與 parseLab 相同邏輯，只處理 HTK 整數格式
        const isHTK = parsed[0].start > 100000 || parsed[0].end > 100000;
        if (!isHTK) {
            results.push({ file, status: 'skipped', reason: 'not HTK format' });
            continue;
        }

        // HTK 格式：取整後做邊界修正
        const intParsed = parsed.map(p => ({
            start: Math.round(p.start),
            end: Math.round(p.end),
            rest: p.rest,
        }));

        let changed = false;
        for (let i = 0; i < intParsed.length - 1; i++) {
            const nextStart = intParsed[i + 1].start;
            if (intParsed[i].end >= nextStart) {
                intParsed[i].end = nextStart - 1;
                changed = true;
            }
        }

        if (changed) {
            const newContent = intParsed.map(p => `${p.start} ${p.end} ${p.rest}`).join('\n');
            fs.writeFileSync(filePath, newContent);
            results.push({ file, status: 'fixed' });
        } else {
            results.push({ file, status: 'ok' });
        }
    }

    res.json({ migrated: results.length, results });
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
            let lyrics = '';
            if (fs.existsSync(path.join(segmentsDir, txtFile))) {
                lyrics = fs.readFileSync(path.join(segmentsDir, txtFile), 'utf-8');
            }
            const isPending = fs.existsSync(path.join(segmentsDir, pendingFile));
            const hasAlignment = fs.existsSync(path.join(segmentsDir, labFile));
            
            // Find any active background job for this file
            const activeJobId = Object.keys(jobs).find(id => 
                jobs[id].filename === f && 
                (jobs[id].status === 'pending' || jobs[id].status === 'processing')
            );

            return { filename: f, type: 'segment', lyrics, isPending, hasAlignment, activeJobId };
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
    ]);
});
