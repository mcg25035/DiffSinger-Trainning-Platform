const express = require('express');
const fs = require('fs');
const path = require('path');

module.exports = function createSegmentsRouter({ uploadsDir, segmentsDir, jobs, defaultAlgoDir }) {
    const router = express.Router();

    router.post('/api/lyrics', express.json(), (req, res) => {
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

    router.get('/api/lab/:filename', (req, res) => {
        const filename = req.params.filename.replace(/\.wav$/, '.lab');
        const labPath = path.join(segmentsDir, filename);
        if (fs.existsSync(labPath)) {
            const content = fs.readFileSync(labPath, 'utf-8');
            res.send(content);
        } else {
            res.status(404).send('Lab file not found');
        }
    });

    router.get('/api/conf/:filename', (req, res) => {
        const filename = req.params.filename.replace(/\.wav$/, '.conf');
        const confPath = path.join(segmentsDir, filename);
        if (fs.existsSync(confPath)) {
            const content = fs.readFileSync(confPath, 'utf-8');
            res.send(content);
        } else {
            res.status(404).send('Conf file not found');
        }
    });

    router.post('/api/lab/:filename', express.text({ type: '*/*' }), (req, res) => {
        const filename = req.params.filename.replace(/\.wav$/, '.lab');
        const labPath = path.join(segmentsDir, filename);
        fs.writeFileSync(labPath, req.body);
        res.json({ success: true });
    });

    router.head('/api/lab2/:filename', (req, res) => {
        const filename = req.params.filename.replace(/\.wav$/, '.lab2');
        const labPath = path.join(segmentsDir, filename);
        res.sendStatus(fs.existsSync(labPath) ? 200 : 404);
    });

    router.get('/api/lab2/:filename', (req, res) => {
        const filename = req.params.filename.replace(/\.wav$/, '.lab2');
        const labPath = path.join(segmentsDir, filename);
        if (fs.existsSync(labPath)) {
            const content = fs.readFileSync(labPath, 'utf-8');
            res.send(content);
        } else {
            res.status(404).send('Lab2 file not found');
        }
    });

    router.post('/api/lab2/:filename', express.text({ type: '*/*' }), (req, res) => {
        const filename = req.params.filename.replace(/\.wav$/, '.lab2');
        const labPath = path.join(segmentsDir, filename);
        fs.writeFileSync(labPath, req.body);
        res.json({ success: true });
    });

    router.post('/api/lab_algo/:filename', express.json(), (req, res) => {
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

    router.post('/api/check', express.json(), (req, res) => {
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

    router.get('/api/recordings', (req, res) => {
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

    return router;
};
