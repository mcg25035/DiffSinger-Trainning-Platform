const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const mfaService = require('./services/mfa-client');
const lyricsService = require('./services/lyrics-client');
const mmsService = require('./services/mms-client');
const segmentationService = require('./services/segmentation-client');
const createAlignmentRuntime = require('./services/alignment-runtime');
const createMmsTrainingService = require('./services/mms-training');
const mapRomajiToPhonemes = require('./services/phoneme-mapping');
const createTranscriptionService = require('./services/transcription');
const createSegmentationCacheService = require('./services/segmentation-cache');
const createOperationalRouter = require('./routes/operational');
const createLexiconsRouter = require('./routes/lexicons');
const createMfaRouter = require('./routes/mfa');
const createBulkLyricsRouter = require('./routes/bulk-lyrics');
const createUploadsRouter = require('./routes/uploads');
const createTranscriptionRouter = require('./routes/transcription');
const createMmsRouter = require('./routes/mms');
const createSegmentsRouter = require('./routes/segments');
const createSegmentationRouter = require('./routes/segmentation');

const app = express();
require('dotenv').config();
const PORT = process.env.BACKEND_PORT || 3010;

app.use(cors());
app.use(express.static('public'));
app.use('/uploads', express.static('uploads'));
app.use('/upload_segments', express.static('upload_segments'));

const uploadsDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir);

const segmentsDir = path.join(__dirname, 'upload_segments');
if (!fs.existsSync(segmentsDir)) fs.mkdirSync(segmentsDir);

const chunkUploadDir = path.join(__dirname, 'upload_chunks');
if (!fs.existsSync(chunkUploadDir)) fs.mkdirSync(chunkUploadDir);

const dictionariesDir = path.join(__dirname, 'dictionaries');
if (!fs.existsSync(dictionariesDir)) fs.mkdirSync(dictionariesDir);

const mappingsDir = path.join(__dirname, 'microservices/mfa/mfa_service/app/mappings');
if (!fs.existsSync(mappingsDir)) fs.mkdirSync(mappingsDir, { recursive: true });

const { transcribeFile } = createTranscriptionService({ fs, path, segmentsDir, lyricsService });
const { jobs, submitAlignment } = createAlignmentRuntime({
    fs, path, FormData: require('form-data'), rootDir: __dirname, segmentsDir,
    mappingsDir, mfaService, mmsService, mapRomajiToPhonemes,
});
const mmsTraining = createMmsTrainingService({
    fs, path, rootDir: __dirname, segmentsDir, mappingsDir, mmsService,
    mapRomajiToPhonemes,
    isProd: process.env.NODE_ENV === 'production' || process.env.NODE_ENV === 'prod',
});
const segmentationCache = createSegmentationCacheService({
    fs, path, segmentsDir, segmentationService,
    isProd: process.env.NODE_ENV === 'production' || process.env.NODE_ENV === 'prod',
});

app.use(createOperationalRouter({ mfaService, lyricsService, mmsService, jobs }));
app.use(createLexiconsRouter({ dictionariesDir, mappingsDir }));
app.use(createMfaRouter({ mfaService }));
app.use(createBulkLyricsRouter({ segmentsDir }));
app.use(createUploadsRouter({
    uploadsDir, segmentsDir, chunkUploadDir, transcribeFile,
    onSegmentReady: () => segmentationCache.scheduleSync(),
}));
app.use(createTranscriptionRouter({ segmentsDir, transcribeFile, submitAlignment, lyricsService, mfaService }));
app.use(createMmsRouter({
    mmsService,
    syncAndTrain: mmsTraining.syncAndTrain,
    fingerprintPath: mmsTraining.fingerprintPath,
    weightsDir: mmsTraining.weightsDir,
    trainingEnabled: false,
}));
app.use(createSegmentationRouter({ segmentsDir, segmentationService, segmentationCache }));
app.use(createSegmentsRouter({
    uploadsDir, segmentsDir, jobs,
    defaultAlgoDir: path.join(__dirname, 'projects', 'attention-labeler', 'data', 'algo'),
}));
segmentationCache.startAutoSync();

app.listen(PORT, async () => {
    console.log(`Server listening on ${PORT}`);
    const maxWait = 60000;
    const interval = 3000;
    const start = Date.now();
    const waitFor = async (name, checkFn) => {
        while (Date.now() - start < maxWait) {
            const result = await checkFn();
            if (result.ok) {
                console.log(`✅ ${name} service ready (${result.latencyMs}ms)`);
                return;
            }
            await new Promise(resolve => setTimeout(resolve, interval));
        }
        console.warn(`⚠️ ${name} service not ready after ${maxWait / 1000}s, continuing anyway`);
    };

    const mmsReady = waitFor('MMS', mmsService.healthCheck);
    mmsReady.then(async () => {
        try {
            await mmsService.stopTraining();
            console.log('[MMS-TRAIN] Training is disabled and any active training was stopped.');
        } catch (error) {
            console.warn('[MMS-TRAIN] Unable to confirm training stop:', error.message);
        }
    });

    await Promise.all([
        waitFor('MFA', mfaService.healthCheck),
        waitFor('Lyrics', lyricsService.healthCheck),
        mmsReady,
    ]);
});
