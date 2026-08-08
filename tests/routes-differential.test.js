'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const {
    EXPECTED_ROUTES,
    collectRoutes,
    createRoutesPair,
    jsonRequest,
    textRequest,
    binaryRequest,
    multipartRequest,
} = require('./helpers/routes-harness');

const coveredRoutes = new Set();

async function setup(t, options) {
    const pair = await createRoutesPair(options);
    t.after(() => pair.close());
    const originalCompare = pair.compare.bind(pair);
    pair.compare = (route, request, compareOptions) => {
        assert.ok(EXPECTED_ROUTES.includes(route), `unknown manifest route: ${route}`);
        coveredRoutes.add(route);
        return originalCompare(route, request, compareOptions);
    };
    return pair;
}

function write(relativePath, data) {
    return paths => {
        const destination = path.join(paths.root, relativePath);
        fs.mkdirSync(path.dirname(destination), { recursive: true });
        fs.writeFileSync(destination, data);
    };
}

function seed(...writers) {
    return paths => writers.forEach(writer => writer(paths));
}

test('route manifest is exactly the legacy 35 method/path pairs in production mount order', { concurrency: false }, async t => {
    const pair = await setup(t);
    assert.equal(EXPECTED_ROUTES.length, 35);
    assert.deepStrictEqual(collectRoutes(pair.legacyApp), EXPECTED_ROUTES);
    assert.deepStrictEqual(collectRoutes(pair.currentApp), EXPECTED_ROUTES);
});

test('operational and MFA routes match for healthy, unhealthy, found, missing, and service errors', { concurrency: false }, async t => {
    const pair = await setup(t);

    assert.equal((await pair.compare('GET /api/health', { method: 'GET', path: '/api/health' })).status, 200);
    pair.configure(behavior => { behavior.lyricsHealth.ok = false; });
    assert.equal((await pair.compare('GET /api/health', { method: 'GET', path: '/api/health' })).status, 500);

    assert.equal((await pair.compare('GET /api/jobs/:id', { method: 'GET', path: '/api/jobs/active' })).status, 200);
    assert.equal((await pair.compare('GET /api/jobs/:id', { method: 'GET', path: '/api/jobs/absent' })).status, 404);

    assert.equal((await pair.compare('GET /api/mfa/models', { method: 'GET', path: '/api/mfa/models' })).status, 200);
    assert.equal((await pair.compare('GET /api/mfa/phones/:model', { method: 'GET', path: '/api/mfa/phones/acoustic-a' })).status, 200);
    pair.configure(behavior => { behavior.failures['mfaService.getModelPhones'] = 'phones unavailable'; });
    assert.equal((await pair.compare('GET /api/mfa/phones/:model', { method: 'GET', path: '/api/mfa/phones/broken' })).status, 500);
});

test('dictionary and mapping file routes match for list, validation, writes, deletes, and missing files', { concurrency: false }, async t => {
    const pair = await setup(t, {
        seed: seed(
            write('dictionaries/base.json', JSON.stringify({ id: 'base', name: 'Base', phonemes: ['a'] })),
            write('dictionaries/ignored.txt', 'not json'),
            write('mappings/base.json', JSON.stringify({ dictionary: 'base', map: { a: 'AA' } }))
        ),
    });

    assert.equal((await pair.compare('GET /api/dictionaries', { method: 'GET', path: '/api/dictionaries' })).status, 200);
    assert.equal((await pair.compare('POST /api/dictionaries', jsonRequest('POST', '/api/dictionaries', { id: 'bad' }))).status, 400);
    assert.equal((await pair.compare('POST /api/dictionaries', jsonRequest('POST', '/api/dictionaries', {
        id: 'custom', name: 'Custom', phonemes: ['k', 'a'],
    }))).status, 200);
    assert.equal((await pair.compare('DELETE /api/dictionaries/:id', { method: 'DELETE', path: '/api/dictionaries/custom' })).status, 200);
    assert.equal((await pair.compare('DELETE /api/dictionaries/:id', { method: 'DELETE', path: '/api/dictionaries/missing' })).status, 404);

    assert.equal((await pair.compare('GET /api/mappings', { method: 'GET', path: '/api/mappings' })).status, 200);
    assert.equal((await pair.compare('POST /api/mappings', jsonRequest('POST', '/api/mappings', { id: 'bad' }))).status, 400);
    assert.equal((await pair.compare('POST /api/mappings', jsonRequest('POST', '/api/mappings', {
        id: 'custom', dictionary: 'base', map: { k: 'K' },
    }))).status, 200);
    assert.equal((await pair.compare('DELETE /api/mappings/:id', { method: 'DELETE', path: '/api/mappings/custom' })).status, 200);
    assert.equal((await pair.compare('DELETE /api/mappings/:id', { method: 'DELETE', path: '/api/mappings/missing' })).status, 404);
});

test('bulk lyrics, lyrics, checked state, and recordings routes match file mutations', { concurrency: false }, async t => {
    const pair = await setup(t, {
        seed: seed(
            write('uploads/raw-take.wav', Buffer.from([1, 2, 3])),
            write('uploads/007.wav', Buffer.from([7])),
            write('upload_segments/001.wav', Buffer.from([10, 11])),
            write('upload_segments/001.pending', ''),
            write('upload_segments/002.wav', Buffer.from([12]))
        ),
    });

    assert.equal((await pair.compare('POST /api/lyrics/bulk', jsonRequest('POST', '/api/lyrics/bulk', {}))).status, 400);
    assert.equal((await pair.compare('POST /api/lyrics/bulk', jsonRequest('POST', '/api/lyrics/bulk', {
        updates: [{ filename: '001.wav', lyrics: 'bulk lyric' }],
    }))).status, 200);

    assert.equal((await pair.compare('POST /api/lyrics', jsonRequest('POST', '/api/lyrics', { filename: '001.wav' }))).status, 400);
    assert.equal((await pair.compare('POST /api/lyrics', jsonRequest('POST', '/api/lyrics', {
        filename: '001.wav', lyrics: '',
    }))).status, 200);
    assert.equal((await pair.compare('POST /api/check', jsonRequest('POST', '/api/check', { checked: true }))).status, 400);
    assert.equal((await pair.compare('POST /api/check', jsonRequest('POST', '/api/check', {
        filename: '001.wav', checked: true,
    }))).status, 200);
    assert.equal((await pair.compare('POST /api/check', jsonRequest('POST', '/api/check', {
        filename: '001.wav', checked: false,
    }))).status, 200);

    const recordings = await pair.compare('GET /api/recordings', { method: 'GET', path: '/api/recordings' });
    assert.equal(recordings.status, 200);
    assert.equal(recordings.body.raw.length, 1);
    assert.equal(recordings.body.segments.length, 2);
});

test('lab, conf, lab2, and algorithm-label routes match content, absence, validation, and deterministic files', { concurrency: false }, async t => {
    const pair = await setup(t, {
        seed: seed(
            write('upload_segments/001.conf', 'confidence=0.9\n'),
            write('upload_segments/001.lab2', '0 100000 a\n')
        ),
    });

    assert.equal((await pair.compare('GET /api/lab/:filename', { method: 'GET', path: '/api/lab/missing.wav' })).status, 404);
    assert.equal((await pair.compare('POST /api/lab/:filename', textRequest('POST', '/api/lab/001.wav', '0 500000 k\n'))).status, 200);
    assert.equal((await pair.compare('GET /api/lab/:filename', { method: 'GET', path: '/api/lab/001.wav' })).body, '0 500000 k\n');

    assert.equal((await pair.compare('GET /api/conf/:filename', { method: 'GET', path: '/api/conf/001.wav' })).body, 'confidence=0.9\n');
    assert.equal((await pair.compare('GET /api/conf/:filename', { method: 'GET', path: '/api/conf/missing.wav' })).status, 404);

    assert.equal((await pair.compare('HEAD /api/lab2/:filename', { method: 'HEAD', path: '/api/lab2/missing.wav' })).status, 404);
    assert.equal((await pair.compare('POST /api/lab2/:filename', textRequest('POST', '/api/lab2/002.wav', '0 250000 i\n'))).status, 200);
    assert.equal((await pair.compare('HEAD /api/lab2/:filename', { method: 'HEAD', path: '/api/lab2/002.wav' })).status, 200);
    assert.equal((await pair.compare('GET /api/lab2/:filename', { method: 'GET', path: '/api/lab2/002.wav' })).body, '0 250000 i\n');
    assert.equal((await pair.compare('GET /api/lab2/:filename', { method: 'GET', path: '/api/lab2/absent.wav' })).status, 404);

    assert.equal((await pair.compare('POST /api/lab_algo/:filename', jsonRequest('POST', '/api/lab_algo/001.wav', {
        reason: 'missing content',
    }))).status, 400);
    const algorithm = await pair.compare('POST /api/lab_algo/:filename', jsonRequest('POST', '/api/lab_algo/001.wav', {
        content: '0 500000 k\n',
        reason: 'shift / vowel',
        boundaryInfo: { phonemeBefore: 'k', phonemeAfter: 'a', oldTime: 0.1, newTime: 0.12, diffMs: 20 },
    }));
    assert.equal(algorithm.status, 200);
    assert.equal(algorithm.body.savedFile, '001_1700000000123_k_to_a_shift___vowel.lab');
});

test('single multipart uploads match validation, generated names, destinations, mock calls, and files', { concurrency: false }, async t => {
    const pair = await setup(t, {
        seed: seed(
            write('uploads/003.wav', Buffer.from([3])),
            write('upload_segments/009.wav', Buffer.from([9]))
        ),
    });

    assert.equal((await pair.compare('POST /upload', multipartRequest('POST', '/upload', { type: 'raw' }))).status, 400);
    const raw = await pair.compare('POST /upload', multipartRequest('POST', '/upload', { type: 'raw' }, {
        field: 'audio', filename: 'take.wav', contentType: 'audio/wav', body: Buffer.from([0, 1, 2, 3]),
    }));
    assert.deepStrictEqual(raw.body, { filename: 'raw-audio-1700000000123-456.wav' });

    const segment = await pair.compare('POST /upload', multipartRequest('POST', '/upload', { type: 'upload_segments' }, {
        field: 'audio', filename: 'segment.wav', contentType: 'audio/wav', body: Buffer.from([4, 5, 6]),
    }));
    assert.deepStrictEqual(segment.body, { filename: '010.wav' });
    assert.equal(pair.current.calls.at(-1).name, 'transcribeFile');
});

test('chunk upload and completion routes match missing parameters, missing chunks, assembly, and transcription', { concurrency: false }, async t => {
    const pair = await setup(t);

    assert.equal((await pair.compare('POST /upload_chunk', binaryRequest('POST', '/upload_chunk?uploadId=x', 'chunk'))).status, 400);
    assert.equal((await pair.compare('POST /upload_chunk', binaryRequest('POST', '/upload_chunk?uploadId=incomplete&chunkIndex=0', 'first'))).status, 200);
    assert.equal((await pair.compare('POST /upload_complete', jsonRequest('POST', '/upload_complete', {
        uploadId: 'incomplete', totalChunks: 2, type: 'upload_segments',
    }))).status, 400);

    assert.equal((await pair.compare('POST /upload_chunk', binaryRequest('POST', '/upload_chunk?uploadId=complete&chunkIndex=0', 'abc'))).status, 200);
    assert.equal((await pair.compare('POST /upload_chunk', binaryRequest('POST', '/upload_chunk?uploadId=complete&chunkIndex=1', 'def'))).status, 200);
    const complete = await pair.compare('POST /upload_complete', jsonRequest('POST', '/upload_complete', {
        uploadId: 'complete', totalChunks: 2, type: 'upload_segments',
    }));
    assert.deepStrictEqual(complete.body, { filename: '002.wav' });
    assert.equal(pair.current.calls.at(-1).name, 'transcribeFile');
});

test('transcription, lyric validation, and alignment routes match primary validation, success, and errors', { concurrency: false }, async t => {
    const pair = await setup(t);

    assert.equal((await pair.compare('POST /api/transcribe', jsonRequest('POST', '/api/transcribe', {}))).status, 400);
    assert.equal((await pair.compare('POST /api/transcribe', jsonRequest('POST', '/api/transcribe', { filename: '001.wav' }))).status, 200);

    assert.equal((await pair.compare('POST /api/transcribe_with_lyrics', jsonRequest('POST', '/api/transcribe_with_lyrics', {}))).status, 400);
    assert.equal((await pair.compare('POST /api/transcribe_with_lyrics', jsonRequest('POST', '/api/transcribe_with_lyrics', { filename: '001.wav' }))).status, 400);
    assert.equal((await pair.compare('POST /api/transcribe_with_lyrics', jsonRequest('POST', '/api/transcribe_with_lyrics', {
        filename: '001.wav', fullLyrics: 'kana',
    }))).status, 200);
    pair.configure(behavior => { behavior.failures['lyricsService.transcribeWithLyrics'] = 'lyrics service failed'; });
    assert.equal((await pair.compare('POST /api/transcribe_with_lyrics', jsonRequest('POST', '/api/transcribe_with_lyrics', {
        filename: '002.wav', fullLyrics: 'error',
    }))).status, 500);
    pair.configure(behavior => { delete behavior.failures['lyricsService.transcribeWithLyrics']; });

    assert.equal((await pair.compare('POST /api/validate_lyrics', jsonRequest('POST', '/api/validate_lyrics', {
        lyrics: 'ka na', model: 'acoustic-a',
    }))).status, 200);
    pair.configure(behavior => { behavior.failures['mfaService.validateLyrics'] = 'invalid model'; });
    assert.equal((await pair.compare('POST /api/validate_lyrics', jsonRequest('POST', '/api/validate_lyrics', {
        lyrics: 'ka na', model: 'missing',
    }))).status, 500);

    assert.equal((await pair.compare('POST /api/align', jsonRequest('POST', '/api/align', {}))).status, 400);
    pair.configure(behavior => { behavior.alignment = { error: 'dictionary missing' }; });
    assert.equal((await pair.compare('POST /api/align', jsonRequest('POST', '/api/align', {
        filename: '001.wav', dictionaryId: 'missing', aligner: 'mfa',
    }))).status, 400);
    pair.configure(behavior => { behavior.alignment = { jobId: 'alignment-99' }; });
    assert.equal((await pair.compare('POST /api/align', jsonRequest('POST', '/api/align', {
        filename: '001.wav', dictionaryId: 'base', aligner: 'mfa',
    }))).status, 200);
});

test('MMS control and model file routes match service errors, fingerprint changes, downloads, and uploads', { concurrency: false }, async t => {
    const pair = await setup(t, {
        seed: seed(write('state/dataset.fingerprint', 'old-fingerprint')),
    });

    assert.equal((await pair.compare('POST /api/mms/sync-train', jsonRequest('POST', '/api/mms/sync-train', {
        epochs: 5, lr: 0.001, dictionaryId: 'base',
    }))).status, 200);
    pair.configure(behavior => { behavior.failures.syncAndTrain = 'training unavailable'; });
    assert.equal((await pair.compare('POST /api/mms/sync-train', jsonRequest('POST', '/api/mms/sync-train', {
        epochs: 1, lr: 0.01,
    }))).status, 500);

    assert.equal((await pair.compare('POST /api/mms/train/stop', { method: 'POST', path: '/api/mms/train/stop' })).status, 200);
    assert.equal((await pair.compare('GET /api/mms/status', { method: 'GET', path: '/api/mms/status' })).status, 200);
    assert.equal((await pair.compare('GET /api/mms/health', { method: 'GET', path: '/api/mms/health' })).status, 200);
    assert.equal((await pair.compare('DELETE /api/mms/model', { method: 'DELETE', path: '/api/mms/model' })).status, 200);

    assert.equal((await pair.compare('GET /api/mms/model/download', { method: 'GET', path: '/api/mms/model/download' })).status, 404);
    pair.writeBoth('weights/mms_fine_tuned_head.pth', Buffer.from([0, 255, 10, 20]));
    const download = await pair.compare('GET /api/mms/model/download', { method: 'GET', path: '/api/mms/model/download' });
    assert.equal(download.status, 200);
    assert.equal(download.contentDisposition, 'attachment; filename="mms_fine_tuned_head.pth"');
    assert.deepStrictEqual(download.body, { base64: Buffer.from([0, 255, 10, 20]).toString('base64') });

    assert.equal((await pair.compare('POST /api/mms/model/upload', multipartRequest('POST', '/api/mms/model/upload', {}))).status, 400);
    pair.writeBoth('state/dataset.fingerprint', 'new-fingerprint');
    assert.equal((await pair.compare('POST /api/mms/model/upload', multipartRequest('POST', '/api/mms/model/upload', {}, {
        field: 'model', filename: 'head.pth', body: Buffer.from([9, 8, 7, 6]),
    }))).status, 200);
    assert.equal(pair.current.calls.at(-1).name, 'mmsService.reloadModel');
});

test('differential scenarios covered every manifest route', { concurrency: false }, () => {
    assert.deepStrictEqual([...coveredRoutes].sort(), [...EXPECTED_ROUTES].sort());
});
