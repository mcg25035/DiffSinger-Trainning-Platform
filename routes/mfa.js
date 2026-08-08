const express = require('express');

module.exports = function createMfaRouter({ mfaService }) {
    const router = express.Router();

    router.get('/api/mfa/models', async (req, res) => {
        try {
            const data = await mfaService.getModels();
            res.json(data);
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    });

    router.get('/api/mfa/phones/:model', async (req, res) => {
        try {
            const data = await mfaService.getModelPhones(req.params.model);
            res.json(data);
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    });

    return router;
};
