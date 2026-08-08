const express = require('express');
const fs = require('fs');
const path = require('path');

module.exports = function createTranscriptionRouter({
    segmentsDir,
    transcribeFile,
    submitAlignment,
    lyricsService,
    mfaService,
}) {
    const router = express.Router();

    router.post('/api/transcribe', express.json(), async (req, res) => {
        const { filename } = req.body;
        if (!filename) return res.status(400).send('Missing filename');

        const result = await transcribeFile(filename);
        res.json(result);
    });

    router.post('/api/transcribe_with_lyrics', express.json(), async (req, res) => {
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

    router.post('/api/validate_lyrics', express.json(), async (req, res) => {
        const { lyrics, model } = req.body;
        try {
            const data = await mfaService.validateLyrics(lyrics, model);
            res.json(data);
        } catch (err) {
            res.status(500).json({ valid: false, message: err.message });
        }
    });

    router.post('/api/align', express.json(), async (req, res) => {
        const { filename, dictionaryId, aligner } = req.body;
        if (!filename) return res.status(400).send('Missing filename');

        const result = submitAlignment({ filename, dictionaryId, aligner });
        if (result.error) {
            return res.status(400).json({ error: result.error });
        }
        res.json({ jobId: result.jobId });
    });

    return router;
};
