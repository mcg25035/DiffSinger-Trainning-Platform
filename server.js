const express = require('express');
const multer = require('multer');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const axios = require('axios');
const FormData = require('form-data');

const app = express();
const PORT = process.env.PORT || 3000;

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
        const response = await axios.post('http://localhost:8001/align_batch?model=japanese_mfa&tier_type=phones', form, {
            headers: form.getHeaders(),
            maxContentLength: Infinity,
            maxBodyLength: Infinity,
            timeout: 600000 // 10 minutes
        });

        const results = response.data;
        for (const task of activeTasks) {
            const result = results[task.filename];
            if (result && !result.startsWith('ERROR:')) {
                fs.writeFileSync(task.labPath, result);
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
        const response = await axios.get('http://localhost:8001/models');
        res.json(response.data);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.get('/api/mfa/phones/:model', async (req, res) => {
    try {
        const response = await axios.get(`http://localhost:8001/model_phones/${req.params.model}`);
        res.json(response.data);
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
        const form = new FormData();
        form.append('file', fs.createReadStream(wavPath));

        const response = await axios.post('http://localhost:8000/transcribe', form, {
            headers: form.getHeaders(),
            timeout: 120000 
        });

        if (response.data && response.data.romaji) {
            fs.writeFileSync(txtPath, response.data.romaji);
            fs.writeFileSync(pendingPath, ''); 
            console.log(`[AI] Transcribed ${filename}: ${response.data.romaji}`);
            return { success: true, lyrics: response.data.romaji };
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

app.post('/api/transcribe', express.json(), async (req, res) => {
    const { filename } = req.body;
    if (!filename) return res.status(400).send('Missing filename');
    
    const result = await transcribeFile(filename);
    res.json(result);
});

app.post('/api/validate_lyrics', express.json(), async (req, res) => {
    const { lyrics, model } = req.body;
    try {
        const form = new FormData();
        form.append('romanji_lyrics', lyrics);
        const response = await axios.post(`http://localhost:8001/validate_lyrics?model=${model || 'japanese_mfa'}`, form, {
            headers: form.getHeaders()
        });
        res.json(response.data);
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

app.post('/api/lab/:filename', express.text({ type: '*/*' }), (req, res) => {
    const filename = req.params.filename.replace(/\.wav$/, '.lab');
    const labPath = path.join(segmentsDir, filename);
    fs.writeFileSync(labPath, req.body);
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

app.listen(PORT, () => {
    console.log(`FINAL STRICT SERVER listening on ${PORT}`);
});
