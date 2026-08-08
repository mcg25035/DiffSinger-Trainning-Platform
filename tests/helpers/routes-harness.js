'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');

const express = require('express');
const multer = require('multer');

const createLegacyRoutesApp = require('../fixtures/create-legacy-routes-app');
const createOperationalRouter = require('../../routes/operational');
const createLexiconsRouter = require('../../routes/lexicons');
const createMfaRouter = require('../../routes/mfa');
const createBulkLyricsRouter = require('../../routes/bulk-lyrics');
const createUploadsRouter = require('../../routes/uploads');
const createTranscriptionRouter = require('../../routes/transcription');
const createMmsRouter = require('../../routes/mms');
const createSegmentsRouter = require('../../routes/segments');

const FIXED_NOW = 1700000000123;
const FIXED_RANDOM = 0.456;

const EXPECTED_ROUTES = [
    'GET /api/health',
    'GET /api/jobs/:id',
    'GET /api/dictionaries',
    'POST /api/dictionaries',
    'DELETE /api/dictionaries/:id',
    'GET /api/mappings',
    'POST /api/mappings',
    'DELETE /api/mappings/:id',
    'GET /api/mfa/models',
    'GET /api/mfa/phones/:model',
    'POST /api/lyrics/bulk',
    'POST /upload',
    'POST /upload_chunk',
    'POST /upload_complete',
    'POST /api/transcribe',
    'POST /api/transcribe_with_lyrics',
    'POST /api/validate_lyrics',
    'POST /api/align',
    'POST /api/mms/sync-train',
    'POST /api/mms/train/stop',
    'GET /api/mms/status',
    'GET /api/mms/health',
    'DELETE /api/mms/model',
    'GET /api/mms/model/download',
    'POST /api/mms/model/upload',
    'POST /api/lyrics',
    'GET /api/lab/:filename',
    'GET /api/conf/:filename',
    'POST /api/lab/:filename',
    'HEAD /api/lab2/:filename',
    'GET /api/lab2/:filename',
    'POST /api/lab2/:filename',
    'POST /api/lab_algo/:filename',
    'POST /api/check',
    'GET /api/recordings',
];

function clone(value) {
    return value === undefined ? undefined : structuredClone(value);
}

function makeSandbox(root) {
    const paths = {
        root,
        uploadsDir: path.join(root, 'uploads'),
        segmentsDir: path.join(root, 'upload_segments'),
        chunkUploadDir: path.join(root, 'upload_chunks'),
        dictionariesDir: path.join(root, 'dictionaries'),
        mappingsDir: path.join(root, 'mappings'),
        defaultAlgoDir: path.join(root, 'algo'),
        weightsDir: path.join(root, 'weights'),
        fingerprintPath: path.join(root, 'state', 'dataset.fingerprint'),
    };

    for (const directory of [
        paths.root,
        paths.uploadsDir,
        paths.segmentsDir,
        paths.chunkUploadDir,
        paths.dictionariesDir,
        paths.mappingsDir,
        paths.defaultAlgoDir,
        paths.weightsDir,
        path.dirname(paths.fingerprintPath),
    ]) {
        fs.mkdirSync(directory, { recursive: true });
    }

    return paths;
}

function createMocks(paths) {
    const calls = [];
    const behavior = {
        failures: {},
        mfaHealth: { ok: true, service: 'mfa' },
        lyricsHealth: { ok: true, service: 'lyrics' },
        mmsHealth: { ok: true, service: 'mms' },
        models: ['acoustic-a', 'acoustic-b'],
        phones: ['a', 'i', 'u'],
        validation: { valid: true, unknown: [] },
        lyricTranscription: {
            matched_romaji: 'ka na',
            match_score: 0.875,
            rough_romaji: 'kana',
        },
        transcription: { success: true, text: 'mock transcription' },
        alignment: { jobId: 'alignment-42' },
        syncTrain: { count: 3, result: { status: 'queued' } },
        stopTraining: { stopped: true },
        status: { status: 'idle', epoch: 0 },
        deleteModel: { deleted: true },
        reloadModel: { reloaded: true },
    };

    function record(name, args) {
        calls.push({ name, args: clone(args) });
        const failure = behavior.failures[name];
        if (failure) throw new Error(failure);
    }

    const mfaService = {
        async healthCheck(...args) {
            record('mfaService.healthCheck', args);
            return clone(behavior.mfaHealth);
        },
        async getModels(...args) {
            record('mfaService.getModels', args);
            return clone(behavior.models);
        },
        async getModelPhones(...args) {
            record('mfaService.getModelPhones', args);
            return clone(behavior.phones);
        },
        async validateLyrics(...args) {
            record('mfaService.validateLyrics', args);
            return clone(behavior.validation);
        },
    };

    const lyricsService = {
        async healthCheck(...args) {
            record('lyricsService.healthCheck', args);
            return clone(behavior.lyricsHealth);
        },
        async transcribeWithLyrics(...args) {
            record('lyricsService.transcribeWithLyrics', args);
            return clone(behavior.lyricTranscription);
        },
    };

    const mmsService = {
        async healthCheck(...args) {
            record('mmsService.healthCheck', args);
            return clone(behavior.mmsHealth);
        },
        async stopTraining(...args) {
            record('mmsService.stopTraining', args);
            return clone(behavior.stopTraining);
        },
        async getStatus(...args) {
            record('mmsService.getStatus', args);
            return clone(behavior.status);
        },
        async deleteModel(...args) {
            record('mmsService.deleteModel', args);
            return clone(behavior.deleteModel);
        },
        async reloadModel(...args) {
            record('mmsService.reloadModel', args);
            return clone(behavior.reloadModel);
        },
    };

    async function transcribeFile(...args) {
        record('transcribeFile', args);
        return clone(behavior.transcription);
    }

    function submitAlignment(...args) {
        record('submitAlignment', args);
        return clone(behavior.alignment);
    }

    async function syncAndTrain(...args) {
        record('syncAndTrain', args);
        return clone(behavior.syncTrain);
    }

    return {
        paths,
        calls,
        behavior,
        jobs: {
            active: { filename: '001.wav', status: 'processing', progress: 40 },
            finished: { filename: '002.wav', status: 'complete', progress: 100 },
        },
        mfaService,
        lyricsService,
        mmsService,
        transcribeFile,
        submitAlignment,
        syncAndTrain,
    };
}

function dependencies(sandbox) {
    return {
        fs,
        path,
        express,
        multer,
        ...sandbox.paths,
        jobs: sandbox.jobs,
        mfaService: sandbox.mfaService,
        lyricsService: sandbox.lyricsService,
        mmsService: sandbox.mmsService,
        transcribeFile: sandbox.transcribeFile,
        submitAlignment: sandbox.submitAlignment,
        syncAndTrain: sandbox.syncAndTrain,
    };
}

function createCurrentRoutesApp(sandbox) {
    const deps = dependencies(sandbox);
    const app = express();

    // Keep this order identical to server.js; order is part of the differential contract.
    app.use(createOperationalRouter(deps));
    app.use(createLexiconsRouter(deps));
    app.use(createMfaRouter(deps));
    app.use(createBulkLyricsRouter(deps));
    app.use(createUploadsRouter(deps));
    app.use(createTranscriptionRouter(deps));
    app.use(createMmsRouter(deps));
    app.use(createSegmentsRouter(deps));

    return app;
}

function listen(app) {
    return new Promise((resolve, reject) => {
        const server = app.listen(0, '127.0.0.1');
        server.once('error', reject);
        server.once('listening', () => resolve(server));
    });
}

function close(server) {
    if (!server) return Promise.resolve();
    return new Promise((resolve, reject) => {
        server.close(error => error ? reject(error) : resolve());
        server.closeAllConnections?.();
    });
}

function send(server, request) {
    const body = request.body === undefined
        ? undefined
        : Buffer.isBuffer(request.body) ? request.body : Buffer.from(request.body);
    const headers = { Connection: 'close', ...(request.headers || {}) };
    if (body !== undefined) headers['Content-Length'] = body.length;

    return new Promise((resolve, reject) => {
        const req = http.request({
            host: '127.0.0.1',
            port: server.address().port,
            method: request.method,
            path: request.path,
            headers,
            agent: false,
        }, res => {
            const chunks = [];
            res.on('data', chunk => chunks.push(chunk));
            res.on('end', () => resolve({
                status: res.statusCode,
                headers: res.headers,
                body: Buffer.concat(chunks),
            }));
        });
        req.once('error', reject);
        if (body !== undefined) req.end(body);
        else req.end();
    });
}

async function withSandboxGlobals(root, action) {
    const OriginalDate = global.Date;
    const originalNow = OriginalDate.now;
    const originalRandom = Math.random;
    const originalCwd = process.cwd();
    const hadAlgoDataDir = Object.hasOwn(process.env, 'ALGO_DATA_DIR');
    const originalAlgoDataDir = process.env.ALGO_DATA_DIR;

    OriginalDate.now = () => FIXED_NOW;
    Math.random = () => FIXED_RANDOM;
    global.Date = class DeterministicDate extends OriginalDate {
        constructor(...args) {
            super(...(args.length ? args : [FIXED_NOW]));
        }

        static now() {
            return FIXED_NOW;
        }
    };
    delete process.env.ALGO_DATA_DIR;
    process.chdir(root);

    try {
        return await action();
    } finally {
        process.chdir(originalCwd);
        if (hadAlgoDataDir) process.env.ALGO_DATA_DIR = originalAlgoDataDir;
        else delete process.env.ALGO_DATA_DIR;
        global.Date = OriginalDate;
        OriginalDate.now = originalNow;
        Math.random = originalRandom;
    }
}

function normalizeValue(value, root) {
    if (typeof value === 'string') return value.split(root).join('<sandbox>');
    if (Array.isArray(value)) return value.map(item => normalizeValue(item, root));
    if (value && typeof value === 'object') {
        return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, normalizeValue(item, root)]));
    }
    return value;
}

function normalizeResponse(response, root) {
    const contentType = response.headers['content-type']?.toLowerCase().replace(/\s+/g, ' ').trim() || null;
    let body;
    if (contentType?.startsWith('application/json')) {
        body = normalizeValue(JSON.parse(response.body.toString('utf8')), root);
    } else if (contentType?.startsWith('text/') || contentType === null) {
        body = normalizeValue(response.body.toString('utf8'), root);
    } else {
        body = { base64: response.body.toString('base64') };
    }

    return {
        status: response.status,
        contentType,
        contentDisposition: response.headers['content-disposition'] || null,
        body,
    };
}

function filesystemSnapshot(root) {
    const entries = [];

    function visit(directory, relativeDirectory) {
        for (const entry of fs.readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
            const relativePath = path.posix.join(relativeDirectory, entry.name);
            const absolutePath = path.join(directory, entry.name);
            if (entry.isDirectory()) {
                entries.push({ path: `${relativePath}/`, type: 'directory' });
                visit(absolutePath, relativePath);
            } else if (entry.isFile()) {
                entries.push({
                    path: relativePath,
                    type: 'file',
                    base64: fs.readFileSync(absolutePath).toString('base64'),
                });
            } else {
                entries.push({ path: relativePath, type: 'other' });
            }
        }
    }

    visit(root, '');
    return entries;
}

function collectRoutes(app) {
    const routes = [];

    function visit(stack) {
        for (const layer of stack || []) {
            if (layer.route) {
                for (const method of Object.keys(layer.route.methods).filter(key => layer.route.methods[key])) {
                    routes.push(`${method.toUpperCase()} ${layer.route.path}`);
                }
            } else if (layer.handle?.stack) {
                visit(layer.handle.stack);
            }
        }
    }

    visit(app.router?.stack || app._router?.stack);
    return routes;
}

function jsonRequest(method, requestPath, value) {
    return {
        method,
        path: requestPath,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(value),
    };
}

function textRequest(method, requestPath, value) {
    return {
        method,
        path: requestPath,
        headers: { 'Content-Type': 'text/plain' },
        body: value,
    };
}

function binaryRequest(method, requestPath, value) {
    return {
        method,
        path: requestPath,
        headers: { 'Content-Type': 'application/octet-stream' },
        body: Buffer.from(value),
    };
}

function multipartRequest(method, requestPath, fields, file) {
    const boundary = '----routes-differential-boundary';
    const chunks = [];
    for (const [name, value] of Object.entries(fields || {})) {
        chunks.push(Buffer.from(
            `--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`
        ));
    }
    if (file) {
        chunks.push(Buffer.from(
            `--${boundary}\r\nContent-Disposition: form-data; name="${file.field}"; filename="${file.filename}"\r\n` +
            `Content-Type: ${file.contentType || 'application/octet-stream'}\r\n\r\n`
        ));
        chunks.push(Buffer.isBuffer(file.body) ? file.body : Buffer.from(file.body));
        chunks.push(Buffer.from('\r\n'));
    }
    chunks.push(Buffer.from(`--${boundary}--\r\n`));
    return {
        method,
        path: requestPath,
        headers: { 'Content-Type': `multipart/form-data; boundary=${boundary}` },
        body: Buffer.concat(chunks),
    };
}

async function createRoutesPair(options = {}) {
    const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'routes-differential-'));
    const legacyPaths = makeSandbox(path.join(baseDir, 'legacy'));
    const currentPaths = makeSandbox(path.join(baseDir, 'current'));
    const legacy = createMocks(legacyPaths);
    const current = createMocks(currentPaths);

    if (options.seed) {
        options.seed(legacyPaths);
        options.seed(currentPaths);
    }

    const legacyApp = createLegacyRoutesApp(dependencies(legacy));
    const currentApp = createCurrentRoutesApp(current);
    let legacyServer;
    let currentServer;

    try {
        [legacyServer, currentServer] = await Promise.all([listen(legacyApp), listen(currentApp)]);
    } catch (error) {
        await Promise.allSettled([close(legacyServer), close(currentServer)]);
        fs.rmSync(baseDir, { recursive: true, force: true });
        throw error;
    }

    let closed = false;
    return {
        legacyApp,
        currentApp,
        legacy,
        current,
        paths: { legacy: legacyPaths, current: currentPaths },
        configure(action) {
            action(legacy.behavior);
            action(current.behavior);
        },
        writeBoth(relativePath, data) {
            for (const sandbox of [legacyPaths, currentPaths]) {
                const destination = path.join(sandbox.root, relativePath);
                fs.mkdirSync(path.dirname(destination), { recursive: true });
                fs.writeFileSync(destination, data);
            }
        },
        async compare(route, request, compareOptions = {}) {
            const legacyCallStart = legacy.calls.length;
            const currentCallStart = current.calls.length;
            const legacyResponse = await withSandboxGlobals(
                legacyPaths.root,
                () => send(legacyServer, request)
            );
            const currentResponse = await withSandboxGlobals(
                currentPaths.root,
                () => send(currentServer, request)
            );

            // upload_complete responds immediately after stream.end(); allow its file flush to finish.
            await new Promise(resolve => setTimeout(resolve, 25));

            const normalizedLegacyResponse = normalizeResponse(legacyResponse, legacyPaths.root);
            const normalizedCurrentResponse = normalizeResponse(currentResponse, currentPaths.root);
            assert.deepStrictEqual(normalizedCurrentResponse, normalizedLegacyResponse, `${route}: response differs`);

            if (compareOptions.calls !== false) {
                const legacyCalls = normalizeValue(legacy.calls.slice(legacyCallStart), legacyPaths.root);
                const currentCalls = normalizeValue(current.calls.slice(currentCallStart), currentPaths.root);
                assert.deepStrictEqual(currentCalls, legacyCalls, `${route}: mock calls differ`);
            }
            if (compareOptions.filesystem !== false) {
                assert.deepStrictEqual(
                    filesystemSnapshot(currentPaths.root),
                    filesystemSnapshot(legacyPaths.root),
                    `${route}: filesystem differs`
                );
            }
            return normalizedCurrentResponse;
        },
        async close() {
            if (closed) return;
            closed = true;
            await Promise.allSettled([close(legacyServer), close(currentServer)]);
            fs.rmSync(baseDir, { recursive: true, force: true });
        },
    };
}

module.exports = {
    EXPECTED_ROUTES,
    collectRoutes,
    createRoutesPair,
    jsonRequest,
    textRequest,
    binaryRequest,
    multipartRequest,
};
