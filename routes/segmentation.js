const express = require('express');
const fs = require('fs');
const path = require('path');

module.exports = function createSegmentationRouter({ segmentsDir, segmentationService, segmentationCache }) {
    const router = express.Router();

    function validFilename(filename) {
        return filename && path.basename(filename) === filename && filename.toLowerCase().endsWith('.wav');
    }

    router.get('/api/red-boundaries/:filename', async (req, res) => {
        const filename = req.params.filename;
        if (!validFilename(filename)) return res.status(400).json({ error: 'Invalid WAV filename' });
        if (!fs.existsSync(path.join(segmentsDir, filename))) {
            return res.status(404).json({ error: 'WAV not found' });
        }
        try {
            res.json(await segmentationService.getCached(filename));
        } catch (error) {
            const status = error.response?.status;
            if (status === 404) return res.status(404).json({ error: 'Boundary cache not ready' });
            res.status(503).json({ error: 'Segmentation service unavailable' });
        }
    });

    router.get('/api/segmentation/status', (req, res) => {
        res.json(segmentationCache.getStatus());
    });

    router.post('/api/segmentation/sync', (req, res) => {
        segmentationCache.scheduleSync(0);
        res.status(202).json({ status: 'scheduled' });
    });

    return router;
};
