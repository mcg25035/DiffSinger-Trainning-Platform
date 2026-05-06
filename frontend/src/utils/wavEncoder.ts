import Crunker from 'crunker';

/**
 * UNIFIED LIBRARY-BACKED ENCODER
 * Replaces all hand-written PCM logic with the professional Crunker library.
 */
export function encodeWAV(chunks: Float32Array[], sampleRate: number): Blob {
    if (chunks.length === 0) {
        throw new Error("Cannot encode empty audio chunks.");
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const CrunkerConstructor = (Crunker as any).default || Crunker;
    const crunker = new CrunkerConstructor({ sampleRate });
    
    // 1. Convert our raw chunks to a single AudioBuffer
    const totalLength = chunks.reduce((acc, chunk) => acc + chunk.length, 0);
    if (totalLength === 0) {
        throw new Error("Total audio length is 0.");
    }
    const audioBuffer = crunker.context.createBuffer(1, totalLength, sampleRate);
    
    const channelData = audioBuffer.getChannelData(0);
    let offset = 0;
    for (const chunk of chunks) {
        channelData.set(chunk, offset);
        offset += chunk.length;
    }

    // 2. Use Crunker's export to get a high-fidelity WAV Blob
    const { blob } = crunker.export(audioBuffer, "audio/wav");
    
    return blob;
}
