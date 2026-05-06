const express = require('express');
const multer = require('multer');
const cors = require('cors');
const path = require('path');
const fs = require('fs');

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

app.post('/api/lyrics/bulk', express.json(), (req, res) => {
    const { updates } = req.body; // Array of { filename, lyrics }
    if (!Array.isArray(updates)) return res.status(400).send('Invalid data');
    
    updates.forEach(({ filename, lyrics }) => {
        const labFilename = filename.replace(/\.wav$/, '.lab');
        const labPath = path.join(segmentsDir, labFilename);
        fs.writeFileSync(labPath, lyrics);
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

app.post('/upload', upload.single('audio'), (req, res) => {
    if (!req.file) return res.status(400).send('No file');
    res.json({ filename: req.file.filename });
});

app.post('/api/lyrics', express.json(), (req, res) => {
    const { filename, lyrics } = req.body;
    if (!filename || lyrics === undefined) return res.status(400).send('Missing data');
    
    // Replace .wav with .lab for DiffSinger convention
    const labFilename = filename.replace(/\.wav$/, '.lab');
    const labPath = path.join(segmentsDir, labFilename);
    
    fs.writeFileSync(labPath, lyrics);
    res.json({ success: true });
});

app.get('/api/recordings', (req, res) => {
    const rawFiles = fs.readdirSync(uploadsDir)
        .filter(f => f.endsWith('.wav') && !/^\d+\.wav$/.test(f))
        .map(f => ({ filename: f, type: 'raw' }));
    
    const segmentFiles = fs.readdirSync(segmentsDir)
        .filter(f => f.endsWith('.wav'))
        .map(f => {
            const labFile = f.replace(/\.wav$/, '.lab');
            let lyrics = '';
            if (fs.existsSync(path.join(segmentsDir, labFile))) {
                lyrics = fs.readFileSync(path.join(segmentsDir, labFile), 'utf-8');
            }
            return { filename: f, type: 'segment', lyrics };
        });

    res.json({ raw: rawFiles, segments: segmentFiles });
});

app.listen(PORT, () => {
    console.log(`FINAL STRICT SERVER listening on ${PORT}`);
});
