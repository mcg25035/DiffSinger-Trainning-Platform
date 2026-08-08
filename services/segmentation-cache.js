function createSegmentationCacheService({ fs, path, segmentsDir, segmentationService, isProd }) {
    let activeSync = null;
    let scheduledTimer = null;
    let autoSyncStarted = false;
    let rerunRequested = false;
    const status = {
        state: 'idle',
        total: 0,
        completed: 0,
        failed: 0,
        currentFile: null,
        startedAt: null,
        finishedAt: null,
        errors: [],
    };

    async function syncAll() {
        if (activeSync) return activeSync;

        activeSync = (async () => {
            if (segmentationService.healthCheck) {
                const health = await segmentationService.healthCheck();
                if (!health.ok) {
                    Object.assign(status, {
                        state: 'unavailable',
                        currentFile: null,
                        finishedAt: new Date().toISOString(),
                        errors: [{ filename: null, error: health.error || 'Service unavailable' }],
                    });
                    throw new Error(health.error || 'Segmentation service unavailable');
                }
            }

            const files = fs.readdirSync(segmentsDir)
                .filter(file => file.toLowerCase().endsWith('.wav'))
                .sort();
            Object.assign(status, {
                state: 'processing',
                total: files.length,
                completed: 0,
                failed: 0,
                currentFile: null,
                startedAt: new Date().toISOString(),
                finishedAt: null,
                errors: [],
            });

            for (const filename of files) {
                status.currentFile = filename;
                try {
                    await segmentationService.compute(filename);
                    status.completed++;
                } catch (error) {
                    status.failed++;
                    status.errors.push({ filename, error: error.message });
                    if (status.errors.length > 100) status.errors.shift();
                    console.error(`[SEGMENTATION] Failed ${filename}:`, error.message);
                }
            }

            status.state = 'idle';
            status.currentFile = null;
            status.finishedAt = new Date().toISOString();
            return { ...status, errors: [...status.errors] };
        })().finally(() => {
            activeSync = null;
            if (rerunRequested) {
                rerunRequested = false;
                scheduleSync(0);
            }
        });

        return activeSync;
    }

    function scheduleSync(delayMs = 3000) {
        if (scheduledTimer) clearTimeout(scheduledTimer);
        scheduledTimer = setTimeout(() => {
            scheduledTimer = null;
            if (activeSync) {
                rerunRequested = true;
                return;
            }
            syncAll().catch(error => {
                console.error('[SEGMENTATION] Sync failed:', error.message);
                if (autoSyncStarted) scheduleSync(60000);
            });
        }, delayMs);
    }

    function startAutoSync() {
        if (!isProd || autoSyncStarted) return;
        autoSyncStarted = true;
        scheduleSync(10000);
        setInterval(() => scheduleSync(0), 3600000);
    }

    function getStatus() {
        return { ...status, errors: [...status.errors] };
    }

    return { syncAll, scheduleSync, startAutoSync, getStatus };
}

module.exports = createSegmentationCacheService;
