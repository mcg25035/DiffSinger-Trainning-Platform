const express = require('express');
const multer = require('multer');
const fs = require('fs');
const path = require('path');

module.exports = function createMmsRouter({
    mmsService,
    syncAndTrain,
    fingerprintPath,
    weightsDir,
    trainingEnabled = true,
}) {
    const router = express.Router();

    router.post('/api/mms/sync-train', express.json(), async (req, res) => {
        if (!trainingEnabled) {
            return res.status(503).json({ error: 'MMS training is disabled' });
        }
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

    router.post('/api/mms/train/stop', async (req, res) => {
        try {
            const result = await mmsService.stopTraining();
            res.json(result);
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    });

    router.get('/api/mms/status', async (req, res) => {
        try {
            const status = await mmsService.getStatus();
            res.json(status);
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    });

    router.get('/api/mms/health', async (req, res) => {
        try {
            const health = await mmsService.healthCheck();
            res.json(health);
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    });

    router.delete('/api/mms/model', async (req, res) => {
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

    router.get('/api/mms/model/download', (req, res) => {
        if (fs.existsSync(weightsPath)) {
            res.download(weightsPath, 'mms_fine_tuned_head.pth');
        } else {
            res.status(404).json({ error: 'No fine-tuned model weights found' });
        }
    });

    router.post('/api/mms/model/upload', uploadWeights.single('model'), async (req, res) => {
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

    return router;
};
