function createMmsTrainingService({
    fs,
    path,
    rootDir,
    segmentsDir,
    mappingsDir,
    mmsService,
    mapRomajiToPhonemes,
    isProd,
}) {
    const fingerprintPath = path.join(rootDir, 'microservices/mms_service/data/last_trained_fingerprint.txt');
    const weightsDir = path.join(rootDir, 'microservices/mms_service/data/weights');
    let autoTrainingStarted = false;

    function getDatasetFingerprint() {
        try {
            const files = fs.readdirSync(segmentsDir);
            const parts = [];
            for (const file of files) {
                if (file.endsWith('.wav')) {
                    const wavPath = path.join(segmentsDir, file);
                    const checkedPath = wavPath.replace(/\.wav$/, '.checked');
                    const txtPath = wavPath.replace(/\.wav$/, '.txt');
                    if (fs.existsSync(checkedPath) && fs.existsSync(txtPath)) {
                        const stat = fs.statSync(wavPath);
                        const txtStat = fs.statSync(txtPath);
                        parts.push(`${file}:${stat.size}:${stat.mtimeMs}:${txtStat.mtimeMs}`);
                    }
                }
            }
            parts.sort();
            return parts.join('|');
        } catch (e) {
            console.error('[MMS-TRAIN] Failed to generate dataset fingerprint:', e.message);
            return null;
        }
    }

    function getLastTrainedFingerprint() {
        if (fs.existsSync(fingerprintPath)) {
            try {
                return fs.readFileSync(fingerprintPath, 'utf-8').trim();
            } catch (e) {
                console.error('[MMS-TRAIN] Failed to read last fingerprint file:', e.message);
            }
        }
        return null;
    }

    function saveLastTrainedFingerprint(fingerprint) {
        try {
            fs.writeFileSync(fingerprintPath, fingerprint, 'utf-8');
        } catch (e) {
            console.error('[MMS-TRAIN] Failed to save fingerprint file:', e.message);
        }
    }

    async function syncAndTrain(options = {}) {
        const { epochs, lr, dictionaryId } = options;
        const mmsTrainDataDir = path.join(rootDir, 'microservices/mms_service/data/training_data');

        if (fs.existsSync(mmsTrainDataDir)) {
            const files = fs.readdirSync(mmsTrainDataDir);
            for (const file of files) {
                fs.unlinkSync(path.join(mmsTrainDataDir, file));
            }
        } else {
            fs.mkdirSync(mmsTrainDataDir, { recursive: true });
        }

        let mapping = null;
        let targetDictId = dictionaryId;

        if (!targetDictId) {
            try {
                const files = fs.readdirSync(path.join(rootDir, 'dictionaries')).filter(f => f.endsWith('.json'));
                if (files.length > 0) {
                    targetDictId = files[0].replace('.json', '');
                }
            } catch (e) {
                console.error('[MMS-TRAIN] Failed to auto-detect dictionary:', e.message);
            }
        }

        if (targetDictId) {
            const dictPath = path.join(rootDir, 'dictionaries', `${targetDictId}.json`);
            if (fs.existsSync(dictPath)) {
                const dict = JSON.parse(fs.readFileSync(dictPath, 'utf-8'));
                const modelName = dict.mfa_model || 'japanese_mfa';
                const mappingPath = path.join(mappingsDir, `${modelName}.json`);
                if (fs.existsSync(mappingPath)) {
                    mapping = JSON.parse(fs.readFileSync(mappingPath, 'utf-8'));
                }
            }
        }

        const files = fs.readdirSync(segmentsDir);
        let count = 0;

        for (const file of files) {
            if (file.endsWith('.wav')) {
                const labFile = file.replace(/\.wav$/, '.lab');
                const txtPath = path.join(segmentsDir, file.replace(/\.wav$/, '.txt'));
                const wavPath = path.join(segmentsDir, file);
                const checkedPath = wavPath.replace(/\.wav$/, '.checked');

                if (!fs.existsSync(checkedPath) || !fs.existsSync(txtPath)) {
                    continue;
                }

                let lyrics = fs.readFileSync(txtPath, 'utf-8').trim();
                if (!lyrics) continue;

                if (mapping) {
                    lyrics = mapRomajiToPhonemes(lyrics, mapping);
                }

                const phonemes = lyrics.split(/\s+/).filter(p => p && !['pau', 'br', 'sp', 'sil', 'spn'].includes(p));

                if (phonemes.length > 0) {
                    const targetWavPath = path.join(mmsTrainDataDir, file);
                    const targetLabPath = path.join(mmsTrainDataDir, labFile);

                    fs.copyFileSync(wavPath, targetWavPath);
                    fs.writeFileSync(targetLabPath, phonemes.join(' '));
                    count++;
                }
            }
        }

        if (count === 0) {
            throw new Error('No valid training segments (WAV + TXT pairs) checked.');
        }

        console.log(`[MMS-TRAIN] Synced ${count} segments for training.`);
        const result = await mmsService.train(epochs || 20, lr || 0.001);

        const currentFingerprint = getDatasetFingerprint();
        if (currentFingerprint) {
            saveLastTrainedFingerprint(currentFingerprint);
        }

        return { count, result };
    }

    function startAutoTraining() {
        if (!isProd || autoTrainingStarted) {
            return;
        }
        autoTrainingStarted = true;

        console.log('[MMS-AUTO-TRAIN] Production mode. Scheduling periodic auto-training check.');

        const runCheck = async () => {
            console.log('[MMS-AUTO-TRAIN] Running periodic check...');
            try {
                const status = await mmsService.getStatus();
                if (status && (status.status === 'training' || status.status === 'paused')) {
                    console.log('[MMS-AUTO-TRAIN] Service is already training or paused. Skip.');
                    return;
                }

                const currentFingerprint = getDatasetFingerprint();
                const lastFingerprint = getLastTrainedFingerprint();
                const weightsExist = fs.existsSync(path.join(weightsDir, 'mms_fine_tuned_head.pth'));

                if (weightsExist && currentFingerprint && lastFingerprint && currentFingerprint === lastFingerprint) {
                    console.log('[MMS-AUTO-TRAIN] Training dataset fingerprint is unchanged. Skip auto-training.');
                    return;
                }

                const { count } = await syncAndTrain();
                console.log(`[MMS-AUTO-TRAIN] Auto-training triggered successfully with ${count} segments.`);
            } catch (err) {
                console.log('[MMS-AUTO-TRAIN] Auto-training check completed:', err.message);
            }
        };

        setTimeout(runCheck, 10000);
        setInterval(runCheck, 3600000);
    }

    return { syncAndTrain, fingerprintPath, weightsDir, startAutoTraining };
}

module.exports = createMmsTrainingService;
