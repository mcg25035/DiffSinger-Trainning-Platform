// Frozen copy of the 35 inline handlers from the pre-router-refactor worktree.
// Keep this fixture independent from routes/ so differential tests can detect
// behavior changes in the extracted routers.
module.exports = function createLegacyRoutesApp(deps) {
    const express = deps.express || require('express');
    const multer = deps.multer || require('multer');
    const {
        fs,
        path,
        uploadsDir,
        segmentsDir,
        chunkUploadDir,
        dictionariesDir,
        mappingsDir,
        defaultAlgoDir,
        fingerprintPath,
        weightsDir,
        jobs,
        transcribeFile,
        submitAlignment,
        syncAndTrain,
        mfaService,
        lyricsService,
        mmsService,
    } = deps;

    const app = express();

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
        const { updates } = req.body;
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
        return nums.length > 0 ? nums[0] + 1 : 1;
    }

    const storage = multer.diskStorage({
        destination: (req, file, cb) => {
            if (req.body.type === 'upload_segments') {
                cb(null, segmentsDir);
            } else {
                cb(null, uploadsDir);
            }
        },
        filename: (req, file, cb) => {
            console.log(`[UPLOAD] Type: ${req.body.type}, Original: ${file.originalname}`);

            if (req.body.type === 'upload_segments') {
                const num = getNextNumber(segmentsDir);
                const name = String(num).padStart(3, '0') + '.wav';
                console.log(`[STRICT] Renaming to: ${name}`);
                cb(null, name);
            } else if (req.body.type === 'adopted') {
                const num = getNextNumber(uploadsDir);
                const name = String(num).padStart(3, '0') + '.wav';
                cb(null, name);
            } else {
                cb(null, `raw-audio-${Date.now()}-${Math.floor(Math.random() * 1000)}.wav`);
            }
        }
    });
    const upload = multer({ storage });

    app.post('/upload', upload.single('audio'), async (req, res) => {
        if (!req.file) return res.status(400).send('No file');

        const filename = req.file.filename;
        const type = req.body.type;
        if (type === 'upload_segments') {
            transcribeFile(filename);
        }
        res.json({ filename });
    });

    app.post('/upload_chunk', express.raw({ limit: '20mb', type: '*/*' }), (req, res) => {
        const { uploadId, chunkIndex } = req.query;
        if (!uploadId || chunkIndex === undefined) return res.status(400).send('Missing params');

        const chunkPath = path.join(chunkUploadDir, `${uploadId}_${chunkIndex}`);
        fs.writeFileSync(chunkPath, req.body);
        res.json({ success: true });
    });

    app.post('/upload_complete', express.json(), (req, res) => {
        const { uploadId, totalChunks, type } = req.body;

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

        const result = submitAlignment({ filename, dictionaryId, aligner });
        if (result.error) {
            return res.status(400).json({ error: result.error });
        }
        res.json({ jobId: result.jobId });
    });

    app.post('/api/mms/sync-train', express.json(), async (req, res) => {
        const { epochs, lr, dictionaryId } = req.body;
        try {
            const { count, result } = await syncAndTrain({ epochs, lr, dictionaryId });
            res.json({
                message: `Successfully synced ${count} segments. Fine-tuning started in the background.`,
                status: result.status || 'started'
            });
        } catch (err) {
            console.error('[MMS-TRAIN] Sync and train failed:', err.message);
            res.status(500).json({ error: err.message });
        }
    });

    app.post('/api/mms/train/stop', async (req, res) => {
        try {
            const result = await mmsService.stopTraining();
            res.json(result);
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    });

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

    const weightsStorage = multer.diskStorage({
        destination: function (req, file, cb) {
            if (!fs.existsSync(weightsDir)) {
                fs.mkdirSync(weightsDir, { recursive: true });
            }
            cb(null, weightsDir);
        },
        filename: function (req, file, cb) {
            cb(null, 'mms_fine_tuned_head.pth');
        }
    });
    const uploadWeights = multer({ storage: weightsStorage });
    const weightsPath = path.join(weightsDir, 'mms_fine_tuned_head.pth');

    app.get('/api/mms/model/download', (req, res) => {
        if (fs.existsSync(weightsPath)) {
            res.download(weightsPath, 'mms_fine_tuned_head.pth');
        } else {
            res.status(404).json({ error: 'No fine-tuned model weights found' });
        }
    });

    app.post('/api/mms/model/upload', uploadWeights.single('model'), async (req, res) => {
        try {
            if (!req.file) {
                return res.status(400).json({ error: 'No file uploaded' });
            }

            await mmsService.reloadModel();
            if (fs.existsSync(fingerprintPath)) {
                fs.unlinkSync(fingerprintPath);
            }
            res.json({ message: 'Model weights uploaded and loaded successfully.' });
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

    app.head('/api/lab2/:filename', (req, res) => {
        const filename = req.params.filename.replace(/\.wav$/, '.lab2');
        const labPath = path.join(segmentsDir, filename);
        res.sendStatus(fs.existsSync(labPath) ? 200 : 404);
    });

    app.get('/api/lab2/:filename', (req, res) => {
        const filename = req.params.filename.replace(/\.wav$/, '.lab2');
        const labPath = path.join(segmentsDir, filename);
        if (fs.existsSync(labPath)) {
            const content = fs.readFileSync(labPath, 'utf-8');
            res.send(content);
        } else {
            res.status(404).send('Lab2 file not found');
        }
    });

    app.post('/api/lab2/:filename', express.text({ type: '*/*' }), (req, res) => {
        const filename = req.params.filename.replace(/\.wav$/, '.lab2');
        const labPath = path.join(segmentsDir, filename);
        fs.writeFileSync(labPath, req.body);
        res.json({ success: true });
    });

    app.post('/api/lab_algo/:filename', express.json(), (req, res) => {
        const { content, reason, boundaryInfo } = req.body;
        if (!content) return res.status(400).json({ error: 'Missing content' });

        const baseName = req.params.filename.replace(/\.wav$/, '');
        const timestamp = Date.now();
        const sanitizedReason = (reason || 'no_reason').trim().replace(/[^a-zA-Z0-9_\-\u4e00-\u9fa5]/g, '_');
        const algoDir = path.resolve(process.env.ALGO_DATA_DIR || defaultAlgoDir);
        if (!fs.existsSync(algoDir)) {
            fs.mkdirSync(algoDir, { recursive: true });
        }

        let bndTag = 'bnd';
        let bndComment = '';
        if (boundaryInfo) {
            const { phonemeBefore, phonemeAfter, oldTime, newTime, diffMs } = boundaryInfo;
            bndTag = `${phonemeBefore || 'start'}_to_${phonemeAfter || 'end'}`;
            bndComment = `# Target Boundary: [ ${phonemeBefore || '^'} | ${phonemeAfter || '$'} ]\n# Boundary Shift: ${oldTime?.toFixed(4)}s -> ${newTime?.toFixed(4)}s (${diffMs >= 0 ? '+' : ''}${diffMs}ms)\n`;
        }

        const algoFilename = `${baseName}_${timestamp}_${bndTag}_${sanitizedReason}.lab`;
        const algoPath = path.join(algoDir, algoFilename);
        const fileHeader = `# Reason: ${reason || 'Unspecified'}\n${bndComment}# Timestamp: ${new Date().toISOString()}\n# Original: ${baseName}.wav\n`;
        fs.writeFileSync(algoPath, fileHeader + content);

        const logPath = path.join(algoDir, `${baseName}_boundary_edits.json`);
        let logEntries = [];
        if (fs.existsSync(logPath)) {
            try {
                logEntries = JSON.parse(fs.readFileSync(logPath, 'utf-8'));
            } catch (e) {
                logEntries = [];
            }
        }
        const newEntry = {
            timestamp: new Date().toISOString(),
            filename: `${baseName}.wav`,
            reason: reason || 'Unspecified',
            boundaryInfo: boundaryInfo || null,
            labFile: algoFilename
        };
        logEntries.push(newEntry);
        fs.writeFileSync(logPath, JSON.stringify(logEntries, null, 2));

        const globalLogPath = path.join(algoDir, 'all_boundary_edits.json');
        let globalLog = [];
        if (fs.existsSync(globalLogPath)) {
            try {
                globalLog = JSON.parse(fs.readFileSync(globalLogPath, 'utf-8'));
            } catch (e) {
                globalLog = [];
            }
        }
        globalLog.push(newEntry);
        fs.writeFileSync(globalLogPath, JSON.stringify(globalLog, null, 2));

        console.log(`[ALGO-LABEL] Saved boundary edit lab: ${algoFilename}`);
        res.json({ success: true, savedFile: algoFilename, path: algoPath, entry: newEntry });
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
        } else if (fs.existsSync(checkedPath)) {
            fs.unlinkSync(checkedPath);
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
                const activeJobId = Object.keys(jobs).find(id =>
                    jobs[id].filename === f &&
                    (jobs[id].status === 'pending' || jobs[id].status === 'processing')
                );

                return { filename: f, type: 'segment', lyrics, isPending, hasAlignment, activeJobId, isChecked };
            });

        res.json({ raw: rawFiles, segments: segmentFiles });
    });

    return app;
};
