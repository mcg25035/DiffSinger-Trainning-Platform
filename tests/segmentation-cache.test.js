const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const createSegmentationCacheService = require('../services/segmentation-cache');

test('processes every WAV sequentially and continues after failures', async (t) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'segmentation-cache-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    fs.writeFileSync(path.join(root, '002.wav'), 'two');
    fs.writeFileSync(path.join(root, '001.wav'), 'one');
    fs.writeFileSync(path.join(root, 'ignore.txt'), 'ignored');

    const calls = [];
    let active = 0;
    let maximumActive = 0;
    const segmentationService = {
        compute: async filename => {
            calls.push(filename);
            active++;
            maximumActive = Math.max(maximumActive, active);
            await new Promise(resolve => setTimeout(resolve, 5));
            active--;
            if (filename === '002.wav') throw new Error('bad audio');
        },
    };
    const service = createSegmentationCacheService({
        fs,
        path,
        segmentsDir: root,
        segmentationService,
        isProd: false,
    });

    const result = await service.syncAll();

    assert.deepEqual(calls, ['001.wav', '002.wav']);
    assert.equal(maximumActive, 1);
    assert.equal(result.completed, 1);
    assert.equal(result.failed, 1);
    assert.equal(result.state, 'idle');
    assert.equal(result.errors[0].filename, '002.wav');
});

test('concurrent sync requests share one scan', async (t) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'segmentation-cache-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    fs.writeFileSync(path.join(root, '001.wav'), 'one');

    let calls = 0;
    const service = createSegmentationCacheService({
        fs,
        path,
        segmentsDir: root,
        segmentationService: {
            compute: async () => {
                calls++;
                await new Promise(resolve => setTimeout(resolve, 10));
            },
        },
        isProd: false,
    });

    await Promise.all([service.syncAll(), service.syncAll()]);
    assert.equal(calls, 1);
});

test('a sync scheduled during processing runs again after the active scan', async (t) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'segmentation-cache-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    fs.writeFileSync(path.join(root, '001.wav'), 'one');

    let calls = 0;
    let releaseFirst;
    const firstCallStarted = new Promise(resolve => {
        releaseFirst = resolve;
    });
    let unblockFirst;
    const firstCallBlock = new Promise(resolve => {
        unblockFirst = resolve;
    });
    const service = createSegmentationCacheService({
        fs,
        path,
        segmentsDir: root,
        segmentationService: {
            compute: async () => {
                calls++;
                if (calls === 1) {
                    releaseFirst();
                    await firstCallBlock;
                }
            },
        },
        isProd: false,
    });

    const firstSync = service.syncAll();
    await firstCallStarted;
    service.scheduleSync(0);
    await new Promise(resolve => setTimeout(resolve, 5));
    unblockFirst();
    await firstSync;

    for (let attempt = 0; attempt < 20 && calls < 2; attempt++) {
        await new Promise(resolve => setTimeout(resolve, 5));
    }
    assert.equal(calls, 2);
});
