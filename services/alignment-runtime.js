function createAlignmentRuntime({
    fs,
    path,
    FormData,
    rootDir,
    segmentsDir,
    mappingsDir,
    mfaService,
    mmsService,
    mapRomajiToPhonemes,
}) {
    const jobs = {};
    let queue = [];
    let processing = false;

    async function processQueue() {
        if (processing || queue.length === 0) return;

        processing = true;

        // Wait a bit to collect more items if they are arriving in a burst
        await new Promise(resolve => setTimeout(resolve, 300));

        const firstTask = queue[0];
        const aligner = firstTask.aligner || 'mfa';
        const dictionaryId = firstTask.dictionaryId;

        // Take at most 10 matching tasks to prevent CUDA OOM or timeouts
        const matchingTasks = queue.filter(task =>
            (task.aligner || 'mfa') === aligner &&
            task.dictionaryId === dictionaryId
        );
        const batch = matchingTasks.slice(0, 10);
        queue = queue.filter(task => !batch.includes(task));

        console.log(`[ALIGN-QUEUE] Processing batch of ${batch.length} files using aligner: ${aligner}`);

        let mapping = null;
        if (dictionaryId) {
            try {
                const dictPath = path.join(rootDir, 'dictionaries', `${dictionaryId}.json`);
                if (fs.existsSync(dictPath)) {
                    const dict = JSON.parse(fs.readFileSync(dictPath, 'utf-8'));
                    const modelName = dict.mfa_model || 'japanese_mfa';
                    const mappingPath = path.join(mappingsDir, `${modelName}.json`);
                    if (fs.existsSync(mappingPath)) {
                        mapping = JSON.parse(fs.readFileSync(mappingPath, 'utf-8'));
                    }
                }
            } catch (err) {
                console.error(`[ALIGN-QUEUE] Failed to load mapping for dictionary ${dictionaryId}:`, err.message);
            }
        }

        const lyricsData = {};
        const romanjiData = {};
        const form = new FormData();

        for (const task of batch) {
            const { jobId, filename, wavPath, txtPath } = task;
            jobs[jobId].status = 'processing';

            try {
                let lyrics = fs.readFileSync(txtPath, 'utf-8');
                if (aligner === 'mms' && mapping) {
                    romanjiData[filename] = lyrics.trim();
                    lyrics = mapRomajiToPhonemes(lyrics, mapping);
                }
                lyricsData[filename] = lyrics;
                form.append('wavs', fs.createReadStream(wavPath), { filename });
            } catch (err) {
                jobs[jobId].status = 'error';
                jobs[jobId].error = `File read error: ${err.message}`;
            }
        }

        const activeTasks = batch.filter(task => jobs[task.jobId].status === 'processing');

        if (activeTasks.length === 0) {
            processing = false;
            setTimeout(processQueue, 500);
            return;
        }

        form.append('lyrics_json', JSON.stringify(lyricsData));

        if (aligner === 'mms' && Object.keys(romanjiData).length > 0) {
            form.append('romanji_json', JSON.stringify(romanjiData));
            if (mapping?.model) {
                form.append('mfa_model', mapping.model);
            }
        }

        try {
            let results;
            if (aligner === 'mms') {
                results = await mmsService.alignBatch(form);
            } else {
                results = await mfaService.alignBatch(form, { model: mapping?.model || 'japanese_mfa' });
            }

            for (const task of activeTasks) {
                const result = results[task.filename];
                if (result && !result.startsWith('ERROR:')) {
                    const confPath = task.labPath.replace(/\.lab$/, '.conf');
                    fs.writeFileSync(confPath, result);

                    const cleanedResult = result.split('\n')
                        .map(line => line.trim())
                        .filter(line => line && !line.startsWith('#'))
                        .map(line => {
                            const parts = line.split(/\s+/);
                            if (parts.length >= 3) {
                                return `${parts[0]} ${parts[1]} ${parts[2]}`;
                            }
                            return line;
                        })
                        .join('\n');

                    fs.writeFileSync(task.labPath, cleanedResult);
                    jobs[task.jobId].status = 'completed';
                } else {
                    jobs[task.jobId].status = 'error';
                    jobs[task.jobId].error = result || 'Alignment failed';
                }
            }
        } catch (err) {
            console.error('[ALIGN-QUEUE] Batch processing failed:', err.message);
            if (err.response && err.response.data) {
                console.error('[ALIGN-QUEUE] Service Error Details:\n', err.response.data);
            }
            for (const task of activeTasks) {
                jobs[task.jobId].status = 'error';
                jobs[task.jobId].error = err.message;
            }
        } finally {
            processing = false;
            setTimeout(processQueue, 500);
        }
    }

    function submitAlignment({ filename, dictionaryId, aligner }) {
        const activeAligner = aligner || 'mfa';

        const existingJobId = Object.keys(jobs).find(id =>
            jobs[id].filename === filename &&
            (jobs[id].status === 'pending' || jobs[id].status === 'processing')
        );
        if (existingJobId) {
            console.log(`[ALIGN-QUEUE] Task for ${filename} already exists: ${existingJobId}`);
            return { jobId: existingJobId };
        }

        const jobId = `align-${Date.now()}-${Math.floor(Math.random() * 1000)}`;
        const wavPath = path.join(segmentsDir, filename);
        const txtPath = wavPath.replace(/\.wav$/, '.txt');
        const labPath = wavPath.replace(/\.wav$/, '.lab');

        if (!fs.existsSync(txtPath)) {
            return { error: 'Lyrics missing' };
        }

        console.log(`[ALIGN-QUEUE] Adding ${filename} to queue. Job: ${jobId} (Aligner: ${activeAligner})`);
        jobs[jobId] = { status: 'pending', filename };

        queue.push({ jobId, filename, wavPath, txtPath, labPath, dictionaryId, aligner: activeAligner });
        processQueue();

        setTimeout(() => delete jobs[jobId], 600000);

        return { jobId };
    }

    return { jobs, submitAlignment };
}

module.exports = createAlignmentRuntime;
