const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const express = require('express');

const createSegmentationRouter = require('../routes/segmentation');

async function createServer(t, overrides = {}) {
    const segmentsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'segmentation-routes-'));
    fs.writeFileSync(path.join(segmentsDir, '001.wav'), 'audio');
    const segmentationService = {
        getCached: async filename => ({ filename, boundary_paths: [] }),
        ...overrides,
    };
    const segmentationCache = {
        getStatus: () => ({ state: 'idle' }),
        scheduleSync: t.mock.fn(),
    };
    const app = express();
    app.use(createSegmentationRouter({ segmentsDir, segmentationService, segmentationCache }));
    const server = app.listen(0);
    await new Promise(resolve => server.once('listening', resolve));
    t.after(() => {
        server.close();
        fs.rmSync(segmentsDir, { recursive: true, force: true });
    });
    return { baseUrl: `http://127.0.0.1:${server.address().port}`, segmentationCache };
}

test('returns cached boundaries and never computes from the read route', async (t) => {
    const { baseUrl } = await createServer(t);
    const response = await fetch(`${baseUrl}/api/red-boundaries/001.wav`);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { filename: '001.wav', boundary_paths: [] });
});

test('maps missing cache and service failures without blocking the platform', async (t) => {
    const missing = await createServer(t, {
        getCached: async () => {
            const error = new Error('missing');
            error.response = { status: 404 };
            throw error;
        },
    });
    assert.equal((await fetch(`${missing.baseUrl}/api/red-boundaries/001.wav`)).status, 404);

    const unavailable = await createServer(t, {
        getCached: async () => { throw new Error('offline'); },
    });
    assert.equal((await fetch(`${unavailable.baseUrl}/api/red-boundaries/001.wav`)).status, 503);
});

test('manual sync schedules background work and returns immediately', async (t) => {
    const { baseUrl, segmentationCache } = await createServer(t);
    const response = await fetch(`${baseUrl}/api/segmentation/sync`, { method: 'POST' });
    assert.equal(response.status, 202);
    assert.equal(segmentationCache.scheduleSync.mock.callCount(), 1);
});
