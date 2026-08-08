const express = require('express');
const fs = require('fs');
const path = require('path');

module.exports = function createBulkLyricsRouter({ segmentsDir }) {
    const router = express.Router();

    router.post('/api/lyrics/bulk', express.json(), (req, res) => {
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

    return router;
};
