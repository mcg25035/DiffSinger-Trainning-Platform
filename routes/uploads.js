const express = require('express');
const multer = require('multer');
const fs = require('fs');
const path = require('path');

module.exports = function createUploadsRouter({ uploadsDir, segmentsDir, chunkUploadDir, transcribeFile, onSegmentReady = () => {} }) {
    const router = express.Router();

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
                cb(null, 'upload_segments/');
            } else {
                cb(null, 'uploads/');
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

    router.post('/upload', upload.single('audio'), async (req, res) => {
        if (!req.file) return res.status(400).send('No file');

        const filename = req.file.filename;
        const type = req.body.type;
        if (type === 'upload_segments') {
            transcribeFile(filename);
            onSegmentReady(filename);
        }
        res.json({ filename });
    });

    router.post('/upload_chunk', express.raw({ limit: '20mb', type: '*/*' }), (req, res) => {
        const { uploadId, chunkIndex } = req.query;
        if (!uploadId || chunkIndex === undefined) return res.status(400).send('Missing params');

        const chunkPath = path.join(chunkUploadDir, `${uploadId}_${chunkIndex}`);
        fs.writeFileSync(chunkPath, req.body);
        res.json({ success: true });
    });

    router.post('/upload_complete', express.json(), (req, res) => {
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
        if (type === 'upload_segments') {
            writeStream.once('finish', () => {
                transcribeFile(finalName);
                onSegmentReady(finalName);
            });
        }
        writeStream.end();
        res.json({ filename: finalName });
    });

    return router;
};
