const express = require('express');

module.exports = function createOperationalRouter({ mfaService, lyricsService, mmsService, jobs }) {
    const router = express.Router();

    router.get('/api/health', async (req, res) => {
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

    router.get('/api/jobs/:id', (req, res) => {
        const job = jobs[req.params.id];
        if (!job) return res.status(404).send('Job not found');
        res.json(job);
    });

    return router;
};
