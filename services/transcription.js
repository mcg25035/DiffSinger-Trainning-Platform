function createTranscriptionService({ fs, path, segmentsDir, lyricsService }) {
    async function transcribeFile(filename) {
        const wavPath = path.join(segmentsDir, filename);
        const txtPath = wavPath.replace(/\.wav$/, '.txt');
        const pendingPath = wavPath.replace(/\.wav$/, '.pending');

        try {
            const data = await lyricsService.transcribe(wavPath);

            if (data && data.romaji) {
                fs.writeFileSync(txtPath, data.romaji);
                fs.writeFileSync(pendingPath, '');
                console.log(`[AI] Transcribed ${filename}: ${data.romaji}`);
                return { success: true, lyrics: data.romaji };
            }
        } catch (err) {
            console.error(`[AI] Transcription Failed for ${filename}:`, err.message);
            return { success: false, error: err.message };
        }
        return { success: false, error: 'No data' };
    }

    return { transcribeFile };
}

module.exports = createTranscriptionService;
