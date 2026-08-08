const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const createMmsTrainingService = require('../services/mms-training');

function createHarness(t, options = {}) {
    const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mms-training-'));
    const segmentsDir = path.join(rootDir, 'segments');
    const mappingsDir = path.join(rootDir, 'mappings');

    fs.mkdirSync(segmentsDir, { recursive: true });
    fs.mkdirSync(mappingsDir, { recursive: true });
    fs.mkdirSync(path.join(rootDir, 'dictionaries'), { recursive: true });

    const mmsService = {
        train: t.mock.fn(options.train || (async () => ({ status: 'started' }))),
        getStatus: t.mock.fn(options.getStatus || (async () => ({ status: 'idle' }))),
    };
    const mapRomajiToPhonemes = t.mock.fn(
        options.mapRomajiToPhonemes || ((lyrics) => lyrics),
    );
    const service = createMmsTrainingService({
        fs,
        path,
        rootDir,
        segmentsDir,
        mappingsDir,
        mmsService,
        mapRomajiToPhonemes,
        isProd: options.isProd || false,
    });

    t.after(() => fs.rmSync(rootDir, { recursive: true, force: true }));

    return {
        rootDir,
        segmentsDir,
        mappingsDir,
        mmsService,
        mapRomajiToPhonemes,
        service,
        trainingDir: path.join(rootDir, 'microservices/mms_service/data/training_data'),
    };
}

function addSegment(harness, name, options = {}) {
    const wavPath = path.join(harness.segmentsDir, `${name}.wav`);
    fs.writeFileSync(wavPath, options.wav || `audio-${name}`);

    if (options.txt !== undefined) {
        fs.writeFileSync(path.join(harness.segmentsDir, `${name}.txt`), options.txt);
    }
    if (options.checked !== false) {
        fs.writeFileSync(path.join(harness.segmentsDir, `${name}.checked`), '');
    }
}

test('returns the fingerprint and weights paths for the isolated root', (t) => {
    const harness = createHarness(t);

    assert.equal(
        harness.service.fingerprintPath,
        path.join(harness.rootDir, 'microservices/mms_service/data/last_trained_fingerprint.txt'),
    );
    assert.equal(
        harness.service.weightsDir,
        path.join(harness.rootDir, 'microservices/mms_service/data/weights'),
    );
});

test('syncs only checked WAV and TXT pairs, cleans training data, and filters phonemes', async (t) => {
    const trainResult = { jobId: 'job-1' };
    const harness = createHarness(t, { train: async () => trainResult });
    fs.mkdirSync(harness.trainingDir, { recursive: true });
    fs.writeFileSync(path.join(harness.trainingDir, 'stale.wav'), 'stale');
    fs.writeFileSync(path.join(harness.trainingDir, 'stale.lab'), 'stale');

    addSegment(harness, 'included', {
        wav: 'included-audio',
        txt: 'pau a br b sp sil spn',
    });
    addSegment(harness, 'unchecked', { txt: 'c', checked: false });
    addSegment(harness, 'missing-text');
    addSegment(harness, 'empty', { txt: '   \n' });

    const result = await harness.service.syncAndTrain();

    assert.deepEqual(result, { count: 1, result: trainResult });
    assert.deepEqual(fs.readdirSync(harness.trainingDir).sort(), ['included.lab', 'included.wav']);
    assert.equal(fs.readFileSync(path.join(harness.trainingDir, 'included.wav'), 'utf8'), 'included-audio');
    assert.equal(fs.readFileSync(path.join(harness.trainingDir, 'included.lab'), 'utf8'), 'a b');
});

test('uses the explicitly selected dictionary mapping', async (t) => {
    const mapping = { ka: ['k', 'a'] };
    const harness = createHarness(t, {
        mapRomajiToPhonemes: () => 'pau k a sp',
    });
    fs.writeFileSync(
        path.join(harness.rootDir, 'dictionaries', 'explicit.json'),
        JSON.stringify({ mfa_model: 'explicit-model' }),
    );
    fs.writeFileSync(
        path.join(harness.mappingsDir, 'explicit-model.json'),
        JSON.stringify(mapping),
    );
    addSegment(harness, 'mapped', { txt: 'ka' });

    await harness.service.syncAndTrain({ dictionaryId: 'explicit' });

    assert.equal(harness.mapRomajiToPhonemes.mock.callCount(), 1);
    assert.deepEqual(harness.mapRomajiToPhonemes.mock.calls[0].arguments, ['ka', mapping]);
    assert.equal(fs.readFileSync(path.join(harness.trainingDir, 'mapped.lab'), 'utf8'), 'k a');
});

test('auto-detects a dictionary and applies its mapping', async (t) => {
    const mapping = { shi: ['sh', 'i'] };
    const harness = createHarness(t, {
        mapRomajiToPhonemes: () => 'sh i',
    });
    fs.writeFileSync(
        path.join(harness.rootDir, 'dictionaries', 'auto.json'),
        JSON.stringify({ mfa_model: 'auto-model' }),
    );
    fs.writeFileSync(
        path.join(harness.mappingsDir, 'auto-model.json'),
        JSON.stringify(mapping),
    );
    addSegment(harness, 'auto-mapped', { txt: 'shi' });

    await harness.service.syncAndTrain();

    assert.equal(harness.mapRomajiToPhonemes.mock.callCount(), 1);
    assert.deepEqual(harness.mapRomajiToPhonemes.mock.calls[0].arguments, ['shi', mapping]);
    assert.equal(fs.readFileSync(path.join(harness.trainingDir, 'auto-mapped.lab'), 'utf8'), 'sh i');
});

test('throws the exact no-segments error without starting training', async (t) => {
    const harness = createHarness(t);
    addSegment(harness, 'unchecked', { txt: 'a', checked: false });
    addSegment(harness, 'missing-text');
    addSegment(harness, 'empty', { txt: ' \n ' });

    await assert.rejects(
        harness.service.syncAndTrain(),
        (error) => {
            assert.equal(error.message, 'No valid training segments (WAV + TXT pairs) checked.');
            return true;
        },
    );
    assert.equal(harness.mmsService.train.mock.callCount(), 0);
});

test('passes default and explicit epochs and learning rate to training', async (t) => {
    const harness = createHarness(t);
    addSegment(harness, 'valid', { txt: 'a' });

    await harness.service.syncAndTrain();
    await harness.service.syncAndTrain({ epochs: 8, lr: 0.025 });

    assert.equal(harness.mmsService.train.mock.callCount(), 2);
    assert.deepEqual(harness.mmsService.train.mock.calls[0].arguments, [20, 0.001]);
    assert.deepEqual(harness.mmsService.train.mock.calls[1].arguments, [8, 0.025]);
});

test('does not update the fingerprint when training rejects', async (t) => {
    const trainingError = new Error('training failed');
    const harness = createHarness(t, {
        train: async () => {
            throw trainingError;
        },
    });
    addSegment(harness, 'valid', { txt: 'a' });
    fs.mkdirSync(path.dirname(harness.service.fingerprintPath), { recursive: true });
    fs.writeFileSync(harness.service.fingerprintPath, 'previous-fingerprint');

    await assert.rejects(harness.service.syncAndTrain(), trainingError);

    assert.equal(
        fs.readFileSync(harness.service.fingerprintPath, 'utf8'),
        'previous-fingerprint',
    );
});

test('non-production scheduler creates no timers', (t) => {
    const setTimeoutMock = t.mock.method(globalThis, 'setTimeout', () => {
        throw new Error('setTimeout should not be called');
    });
    const setIntervalMock = t.mock.method(globalThis, 'setInterval', () => {
        throw new Error('setInterval should not be called');
    });
    const harness = createHarness(t, { isProd: false });

    harness.service.startAutoTraining();

    assert.equal(setTimeoutMock.mock.callCount(), 0);
    assert.equal(setIntervalMock.mock.callCount(), 0);
});

test('production scheduler is idempotent and runs one initial check without live timers', async (t) => {
    let initialCheck;
    const timeoutHandle = { type: 'timeout' };
    const intervalHandle = { type: 'interval' };
    const setTimeoutMock = t.mock.method(globalThis, 'setTimeout', (callback) => {
        initialCheck = callback;
        return timeoutHandle;
    });
    const setIntervalMock = t.mock.method(globalThis, 'setInterval', () => intervalHandle);
    const harness = createHarness(t, {
        isProd: true,
        getStatus: async () => ({ status: 'training' }),
    });

    harness.service.startAutoTraining();
    harness.service.startAutoTraining();

    assert.equal(setTimeoutMock.mock.callCount(), 1);
    assert.deepEqual(setTimeoutMock.mock.calls[0].arguments, [initialCheck, 10000]);
    assert.equal(setTimeoutMock.mock.calls[0].result, timeoutHandle);
    assert.equal(setIntervalMock.mock.callCount(), 1);
    assert.deepEqual(setIntervalMock.mock.calls[0].arguments, [initialCheck, 3600000]);
    assert.equal(setIntervalMock.mock.calls[0].result, intervalHandle);

    await initialCheck();

    assert.equal(harness.mmsService.getStatus.mock.callCount(), 1);
    assert.equal(harness.mmsService.train.mock.callCount(), 0);
});
