import { useCallback } from 'react';

export interface SilenceGap {
    start: number;
    end: number;
    mid: number;
}

export function useSplitterLogic() {
    const findQuietestPoint = (
        dbValues: number[], 
        startSec: number, 
        endSec: number, 
        sampleRate: number, 
        chunkSize: number
    ) => {
        const startIdx = Math.floor((startSec * sampleRate) / chunkSize);
        const endIdx = Math.floor((endSec * sampleRate) / chunkSize);
        let minDb = Infinity;
        let bestIdx = startIdx;
        for (let i = startIdx; i < endIdx && i < dbValues.length; i++) {
            if (dbValues[i] < minDb) {
                minDb = dbValues[i];
                bestIdx = i;
            }
        }
        return (bestIdx * chunkSize) / sampleRate;
    };

    const calculateSplitPoints = useCallback((
        dbValues: number[],
        sampleRate: number,
        duration: number,
        threshold: number,
        minGap: number,
        maxLen: number
    ) => {
        const chunkSize = Math.floor(sampleRate * 0.02);
        const silenceGaps: SilenceGap[] = [];
        let silenceStart = -1;

        // 1. Find all valid silence gaps
        for (let i = 0; i < dbValues.length; i++) {
            if (dbValues[i] < threshold) {
                if (silenceStart === -1) silenceStart = i;
            } else {
                if (silenceStart !== -1) {
                    const len = ((i - silenceStart) * chunkSize) / sampleRate;
                    if (len >= minGap) {
                        silenceGaps.push({
                            start: (silenceStart * chunkSize) / sampleRate,
                            end: (i * chunkSize) / sampleRate,
                            mid: ((silenceStart + i) / 2 * chunkSize) / sampleRate
                        });
                    }
                    silenceStart = -1;
                }
            }
        }

        // 2. Greedy Merge Logic
        const finalPoints: number[] = [];
        let lastSplit = 0;

        for (let i = 0; i < silenceGaps.length; i++) {
            const currentGapMid = silenceGaps[i].mid;
            const nextTarget = (i + 1 < silenceGaps.length) ? silenceGaps[i + 1].mid : duration;

            // If the distance to the NEXT potential split point is too far,
            // we MUST split at the current one to maintain maximum allowed length.
            if (nextTarget - lastSplit > maxLen) {
                // If even the CURRENT gap is already too far, we need a forced split before it.
                if (currentGapMid - lastSplit > maxLen) {
                    let tempStart = lastSplit;
                    while (currentGapMid - tempStart > maxLen) {
                        const forceCut = findQuietestPoint(dbValues, tempStart + (maxLen * 0.6), tempStart + maxLen, sampleRate, chunkSize);
                        finalPoints.push(forceCut);
                        tempStart = forceCut;
                    }
                }
                finalPoints.push(currentGapMid);
                lastSplit = currentGapMid;
            }
        }

        // Final tail check
        if (duration - lastSplit > maxLen) {
            let tempStart = lastSplit;
            while (duration - tempStart > maxLen) {
                const forceCut = findQuietestPoint(dbValues, tempStart + (maxLen * 0.6), tempStart + maxLen, sampleRate, chunkSize);
                finalPoints.push(forceCut);
                tempStart = forceCut;
            }
        }

        return Array.from(new Set([...finalPoints, duration])).sort((a, b) => a - b);
    }, []);

    return { calculateSplitPoints };
}
