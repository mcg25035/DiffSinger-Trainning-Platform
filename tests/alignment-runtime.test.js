const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { after, before, describe, it } = require('node:test');

const createAlignmentRuntime = require('../services/alignment-runtime');

const WAIT_TIMEOUT_MS = Number(process.env.ALIGNMENT_TEST_TIMEOUT_MS || 5000);
const originalSetTimeout = global.setTimeout;
const followUpTimers = new Set();

function delay(milliseconds) {
    return new Promise(resolve => originalSetTimeout(resolve, milliseconds));
}

async function waitFor(predicate, description) {
    const deadline = Date.now() + WAIT_TIMEOUT_MS;
    while (Date.now() < deadline) {
        if (predicate()) return;
        await delay(10);
    }
    assert.fail(`Timed out waiting for ${description}`);
}

function field(form, name) {
    return form.appendCalls.find(call => call.name === name)?.value;
}

function destroyStreams(form) {
    for (const call of form.appendCalls) {
        if (call.value instanceof fs.ReadStream && !call.value.destroyed) {
            call.value.destroy();
        }
    }
}

function resultsFor(form) {
    const lyrics = JSON.parse(field(form, 'lyrics_json'));
    return Object.fromEntries(Object.keys(lyrics).map(filename => [filename, '0.000 1.000 ok']));
}

function createHarness(t, options = {}) {
    const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'alignment-runtime-'));
    const segmentsDir = path.join(rootDir, 'segments');
    const mappingsDir = path.join(rootDir, 'mappings');
    fs.mkdirSync(segmentsDir);
    fs.mkdirSync(mappingsDir);
    fs.mkdirSync(path.join(rootDir, 'dictionaries'));

    const forms = [];
    const mfaCalls = [];
    const mmsCalls = [];
    const mappingCalls = [];

    class FakeFormData {
        constructor() {
            this.appendCalls = [];
            forms.push(this);
        }

        append(name, value, appendOptions) {
            this.appendCalls.push({ name, value, options: appendOptions });
        }
    }

    const mfaService = {
        async alignBatch(form, alignOptions) {
            mfaCalls.push({ form, options: alignOptions });
            try {
                return await (options.mfaAlignBatch || resultsFor)(form, alignOptions);
            } finally {
                destroyStreams(form);
            }
        },
    };
    const mmsService = {
        async alignBatch(form) {
            mmsCalls.push({ form });
            try {
                return await (options.mmsAlignBatch || resultsFor)(form);
            } finally {
                destroyStreams(form);
            }
        },
    };
    const mapRomajiToPhonemes = (lyrics, mapping) => {
        mappingCalls.push({ lyrics, mapping });
        return options.mapResult || 'mapped phonemes';
    };

    const runtime = createAlignmentRuntime({
        fs,
        path,
        FormData: FakeFormData,
        rootDir,
        segmentsDir,
        mappingsDir,
        mfaService,
        mmsService,
        mapRomajiToPhonemes,
    });

    function writeSegment(filename, lyrics) {
        const wavPath = path.join(segmentsDir, filename);
        fs.writeFileSync(wavPath, 'fake wav data');
        if (lyrics !== undefined) {
            fs.writeFileSync(wavPath.replace(/\.wav$/, '.txt'), lyrics);
        }
    }

    t.after(() => {
        for (const form of forms) destroyStreams(form);
        fs.rmSync(rootDir, { recursive: true, force: true });
    });

    return {
        forms,
        mappingCalls,
        mappingsDir,
        mfaCalls,
        mmsCalls,
        rootDir,
        runtime,
        segmentsDir,
        writeSegment,
    };
}

describe('alignment runtime', { concurrency: false }, () => {
    before(() => {
        global.setTimeout = (callback, milliseconds, ...args) => {
            if (milliseconds === 600000) {
                return { ref() { return this; }, unref() { return this; } };
            }

            if (milliseconds === 500) {
                let timer;
                timer = originalSetTimeout(() => {
                    followUpTimers.delete(timer);
                    callback(...args);
                }, milliseconds);
                timer.unref();
                followUpTimers.add(timer);
                return timer;
            }

            return originalSetTimeout(callback, milliseconds, ...args);
        };
    });

    after(() => {
        for (const timer of followUpTimers) clearTimeout(timer);
        followUpTimers.clear();
        global.setTimeout = originalSetTimeout;
    });

    it('returns a missing lyrics error without creating a job', t => {
        const harness = createHarness(t);
        harness.writeSegment('missing.wav');

        assert.deepEqual(
            harness.runtime.submitAlignment({ filename: 'missing.wav', dictionaryId: 'ja' }),
            { error: 'Lyrics missing' },
        );
        assert.deepEqual(harness.runtime.jobs, {});
        assert.equal(harness.forms.length, 0);
        assert.equal(harness.mfaCalls.length, 0);
        assert.equal(harness.mmsCalls.length, 0);
    });

    it('creates a pending job and deduplicates active jobs by filename', async t => {
        const harness = createHarness(t);
        harness.writeSegment('dedupe.wav', 'la');

        const first = harness.runtime.submitAlignment({
            filename: 'dedupe.wav',
            dictionaryId: 'first',
            aligner: 'mfa',
        });
        const duplicate = harness.runtime.submitAlignment({
            filename: 'dedupe.wav',
            dictionaryId: 'second',
            aligner: 'mms',
        });

        assert.match(first.jobId, /^align-\d+-\d+$/);
        assert.deepEqual(duplicate, first);
        assert.deepEqual(harness.runtime.jobs[first.jobId], {
            status: 'pending',
            filename: 'dedupe.wav',
        });
        assert.equal(Object.keys(harness.runtime.jobs).length, 1);

        await waitFor(
            () => harness.runtime.jobs[first.jobId].status === 'completed',
            'deduplicated job completion',
        );
        assert.equal(harness.mfaCalls.length, 1);
        assert.equal(harness.mmsCalls.length, 0);
    });

    it('writes the exact MFA conf, a cleaned lab, and completes the job', async t => {
        const result = [
            '# generated by aligner',
            '0.000 0.100 a 0.98',
            '',
            '  0.100   0.250   b   extra  ',
            'short-line',
            '# ignored trailer',
        ].join('\n');
        const harness = createHarness(t, {
            mfaAlignBatch: () => ({ 'mfa.wav': result }),
        });
        harness.writeSegment('mfa.wav', 'a b\n');

        const { jobId } = harness.runtime.submitAlignment({ filename: 'mfa.wav' });
        await waitFor(
            () => harness.runtime.jobs[jobId].status === 'completed',
            'MFA job completion',
        );

        assert.equal(fs.readFileSync(path.join(harness.segmentsDir, 'mfa.conf'), 'utf8'), result);
        assert.equal(
            fs.readFileSync(path.join(harness.segmentsDir, 'mfa.lab'), 'utf8'),
            ['0.000 0.100 a', '0.100 0.250 b', 'short-line'].join('\n'),
        );
        assert.deepEqual(harness.mfaCalls[0].options, { model: 'japanese_mfa' });

        const form = harness.mfaCalls[0].form;
        assert.deepEqual(form.appendCalls.map(call => call.name), ['wavs', 'lyrics_json']);
        assert.equal(form.appendCalls[0].options.filename, 'mfa.wav');
        assert.equal(form.appendCalls[0].value.destroyed, true);
        assert.equal(field(form, 'lyrics_json'), JSON.stringify({ 'mfa.wav': 'a b\n' }));
    });

    it('sends mapped lyrics, romanji_json, and mfa_model to MMS', async t => {
        const harness = createHarness(t, { mapResult: 'k o N n i ch i w a' });
        const mapping = { model: 'mms-ja-acoustic', symbols: { a: ['a'] } };
        fs.writeFileSync(
            path.join(harness.rootDir, 'dictionaries', 'custom.json'),
            JSON.stringify({ mfa_model: 'custom-map' }),
        );
        fs.writeFileSync(
            path.join(harness.mappingsDir, 'custom-map.json'),
            JSON.stringify(mapping),
        );
        harness.writeSegment('mms.wav', '  konnichiwa \n');

        const { jobId } = harness.runtime.submitAlignment({
            filename: 'mms.wav',
            dictionaryId: 'custom',
            aligner: 'mms',
        });
        await waitFor(
            () => harness.runtime.jobs[jobId].status === 'completed',
            'MMS job completion',
        );

        assert.equal(harness.mfaCalls.length, 0);
        assert.equal(harness.mmsCalls.length, 1);
        assert.deepEqual(harness.mappingCalls, [{ lyrics: '  konnichiwa \n', mapping }]);

        const form = harness.mmsCalls[0].form;
        assert.deepEqual(
            form.appendCalls.map(call => call.name),
            ['wavs', 'lyrics_json', 'romanji_json', 'mfa_model'],
        );
        assert.equal(field(form, 'lyrics_json'), JSON.stringify({ 'mms.wav': 'k o N n i ch i w a' }));
        assert.equal(field(form, 'romanji_json'), JSON.stringify({ 'mms.wav': 'konnichiwa' }));
        assert.equal(field(form, 'mfa_model'), 'mms-ja-acoustic');
        assert.equal(form.appendCalls[0].value.destroyed, true);
    });

    it('marks an ERROR result as a job error', async t => {
        const harness = createHarness(t, {
            mfaAlignBatch: () => ({ 'bad.wav': 'ERROR: phoneme mismatch' }),
        });
        harness.writeSegment('bad.wav', 'bad lyrics');

        const { jobId } = harness.runtime.submitAlignment({ filename: 'bad.wav' });
        await waitFor(
            () => harness.runtime.jobs[jobId].status === 'error',
            'ERROR result handling',
        );

        assert.equal(harness.runtime.jobs[jobId].error, 'ERROR: phoneme mismatch');
        assert.equal(fs.existsSync(path.join(harness.segmentsDir, 'bad.conf')), false);
        assert.equal(fs.existsSync(path.join(harness.segmentsDir, 'bad.lab')), false);
        assert.equal(harness.mfaCalls[0].form.appendCalls[0].value.destroyed, true);
    });

    it('marks a rejected service request as a job error', async t => {
        const harness = createHarness(t, {
            mfaAlignBatch: () => {
                throw new Error('alignment service unavailable');
            },
        });
        harness.writeSegment('rejected.wav', 'lyrics');

        const { jobId } = harness.runtime.submitAlignment({ filename: 'rejected.wav' });
        await waitFor(
            () => harness.runtime.jobs[jobId].status === 'error',
            'service rejection handling',
        );

        assert.equal(harness.runtime.jobs[jobId].error, 'alignment service unavailable');
        assert.equal(harness.mfaCalls[0].form.appendCalls[0].value.destroyed, true);
    });

    it('groups by aligner and dictionary while limiting batches to ten files', async t => {
        const harness = createHarness(t);
        const submissions = [];

        harness.writeSegment('a01.wav', 'a01');
        submissions.push(harness.runtime.submitAlignment({
            filename: 'a01.wav',
            dictionaryId: 'dictionary-a',
            aligner: 'mfa',
        }));

        harness.writeSegment('other-dictionary.wav', 'other dictionary');
        submissions.push(harness.runtime.submitAlignment({
            filename: 'other-dictionary.wav',
            dictionaryId: 'dictionary-b',
            aligner: 'mfa',
        }));

        harness.writeSegment('other-aligner.wav', 'other aligner');
        submissions.push(harness.runtime.submitAlignment({
            filename: 'other-aligner.wav',
            dictionaryId: 'dictionary-a',
            aligner: 'mms',
        }));

        for (let index = 2; index <= 11; index += 1) {
            const filename = `a${String(index).padStart(2, '0')}.wav`;
            harness.writeSegment(filename, filename);
            submissions.push(harness.runtime.submitAlignment({
                filename,
                dictionaryId: 'dictionary-a',
                aligner: 'mfa',
            }));
        }

        await waitFor(
            () => submissions.every(({ jobId }) => harness.runtime.jobs[jobId].status === 'completed'),
            'all grouped jobs to complete',
        );

        const mfaBatches = harness.mfaCalls.map(({ form }) =>
            Object.keys(JSON.parse(field(form, 'lyrics_json'))));
        const mmsBatches = harness.mmsCalls.map(({ form }) =>
            Object.keys(JSON.parse(field(form, 'lyrics_json'))));

        assert.deepEqual(mfaBatches, [
            Array.from({ length: 10 }, (_, index) => `a${String(index + 1).padStart(2, '0')}.wav`),
            ['other-dictionary.wav'],
            ['a11.wav'],
        ]);
        assert.deepEqual(mmsBatches, [['other-aligner.wav']]);
        assert.equal(Math.max(...mfaBatches.map(batch => batch.length), ...mmsBatches.map(batch => batch.length)), 10);
        assert.equal(
            [...harness.mfaCalls, ...harness.mmsCalls].every(({ form }) =>
                form.appendCalls.filter(call => call.value instanceof fs.ReadStream)
                    .every(call => call.value.destroyed)),
            true,
        );
    });
});
