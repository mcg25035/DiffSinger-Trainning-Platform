const express = require('express');
const fs = require('fs');
const path = require('path');

module.exports = function createLexiconsRouter({ dictionariesDir, mappingsDir }) {
    const router = express.Router();

    router.get('/api/dictionaries', (req, res) => {
        const files = fs.readdirSync(dictionariesDir).filter(f => f.endsWith('.json'));
        const dicts = files.map(f => {
            const content = JSON.parse(fs.readFileSync(path.join(dictionariesDir, f), 'utf-8'));
            return content;
        });
        res.json(dicts);
    });

    router.post('/api/dictionaries', express.json(), (req, res) => {
        const dict = req.body;
        if (!dict.id || !dict.name || !Array.isArray(dict.phonemes)) {
            return res.status(400).send('Invalid dictionary data');
        }
        const filePath = path.join(dictionariesDir, `${dict.id}.json`);
        fs.writeFileSync(filePath, JSON.stringify(dict, null, 2));
        res.json({ success: true });
    });

    router.delete('/api/dictionaries/:id', (req, res) => {
        const filePath = path.join(dictionariesDir, `${req.params.id}.json`);
        if (fs.existsSync(filePath)) {
            fs.unlinkSync(filePath);
            res.json({ success: true });
        } else {
            res.status(404).send('Not found');
        }
    });

    router.get('/api/mappings', (req, res) => {
        const files = fs.readdirSync(mappingsDir).filter(f => f.endsWith('.json'));
        const mappings = files.map(f => {
            const id = f.replace('.json', '');
            const content = JSON.parse(fs.readFileSync(path.join(mappingsDir, f), 'utf-8'));
            return { id, ...content };
        });
        res.json(mappings);
    });

    router.post('/api/mappings', express.json(), (req, res) => {
        const mapping = req.body;
        if (!mapping.id || !mapping.dictionary) {
            return res.status(400).send('Invalid mapping data');
        }
        const { id, ...content } = mapping;
        const filePath = path.join(mappingsDir, `${id}.json`);
        fs.writeFileSync(filePath, JSON.stringify(content, null, 2));
        res.json({ success: true });
    });

    router.delete('/api/mappings/:id', (req, res) => {
        const filePath = path.join(mappingsDir, `${req.params.id}.json`);
        if (fs.existsSync(filePath)) {
            fs.unlinkSync(filePath);
            res.json({ success: true });
        } else {
            res.status(404).send('Not found');
        }
    });

    return router;
};
