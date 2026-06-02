import { useState, useEffect, useRef, useCallback } from 'react';
import { encodeWAV } from '../utils/wavEncoder';

export interface Device {
    deviceId: string;
    label: string;
}

export interface Recording {
    filename: string;
    url: string;
    type: 'raw' | 'segment';
    lyrics?: string;
    isPending?: boolean;
    hasAlignment?: boolean;
    activeJobId?: string;
    isChecked?: boolean;
}

export function useAudioMonitor() {
    const [devices, setDevices] = useState<Device[]>([]);
    const [selectedDeviceId, setSelectedDeviceId] = useState<string>('');
    const [status, setStatus] = useState<{ text: string, color: string }>({ text: '就緒', color: 'green' });
    const [isRecording, setIsRecording] = useState<boolean>(false);
    const isRecordingRef = useRef<boolean>(false);
    
    const [rawRecordings, setRawRecordings] = useState<Recording[]>([]);
    const [uploadSegments, setUploadSegments] = useState<Recording[]>([]);
    const [analyser, setAnalyser] = useState<AnalyserNode | null>(null);

    const audioContextRef = useRef<AudioContext | null>(null);
    const mediaStreamRef = useRef<MediaStream | null>(null);
    const processorNodeRef = useRef<ScriptProcessorNode | null>(null);
    const analyserNodeRef = useRef<AnalyserNode | null>(null);
    const sourceNodeRef = useRef<MediaStreamAudioSourceNode | null>(null);
    const pcmChunksRef = useRef<Float32Array[]>([]);
    
    // This will be detected from the hardware/browser
    const sampleRateRef = useRef<number>(0);

    const fetchRecordings = useCallback(async () => {
        try {
            const response = await fetch(`/api/recordings?t=${Date.now()}`);
            if (response.ok) {
                const data = await response.json();
                
                const raw: Recording[] = data.raw.map((f: { filename: string }) => ({
                    filename: f.filename,
                    url: `/uploads/${f.filename}`,
                    type: 'raw'
                }));
                
                const segments: Recording[] = data.segments.map((f: { filename: string, lyrics: string, isPending: boolean, hasAlignment: boolean, activeJobId?: string, isChecked?: boolean }) => ({
                    filename: f.filename,
                    url: `/upload_segments/${f.filename}`,
                    type: 'segment',
                    lyrics: f.lyrics,
                    isPending: f.isPending,
                    hasAlignment: f.hasAlignment,
                    activeJobId: f.activeJobId,
                    isChecked: f.isChecked
                }));

                segments.sort((a, b) => parseInt(b.filename, 10) - parseInt(a.filename, 10));
                
                setRawRecordings(raw);
                setUploadSegments(segments);
            }
        } catch (err) { console.error("Fetch Recordings Error:", err); }
    }, []);

    const getDevices = useCallback(async () => {
        try {
            await navigator.mediaDevices.getUserMedia({ audio: true });
            const allDevices = await navigator.mediaDevices.enumerateDevices();
            const audioInputs = allDevices.filter(d => d.kind === 'audioinput');
            setDevices(audioInputs.map((d, i) => ({ deviceId: d.deviceId, label: d.label || `Mic ${i + 1}` })));
            if (audioInputs.length > 0 && !selectedDeviceId) setSelectedDeviceId(audioInputs[0].deviceId);
        } catch { setStatus({ text: "權限錯誤", color: "red" }); }
    }, [selectedDeviceId]);

    const startMonitoring = useCallback(async (deviceId: string) => {
        try {
            if (!deviceId) return;
            if (mediaStreamRef.current) mediaStreamRef.current.getTracks().forEach(t => t.stop());
            if (processorNodeRef.current) {
                processorNodeRef.current.disconnect();
                analyserNodeRef.current?.disconnect();
            }

            // --- NATIVE FIDELITY ONLY ---
            const stream = await navigator.mediaDevices.getUserMedia({ 
                audio: { 
                    deviceId: { exact: deviceId },
                    echoCancellation: false,
                    autoGainControl: false,
                    noiseSuppression: false,
                    channelCount: 1
                } 
            });
            mediaStreamRef.current = stream;
            
            if (!audioContextRef.current) {
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                audioContextRef.current = new (window.AudioContext || (window as any).webkitAudioContext)();
            }
            sampleRateRef.current = audioContextRef.current.sampleRate;
            console.log(`HARDWARE SAMPLE RATE: ${sampleRateRef.current}Hz`);

            sourceNodeRef.current = audioContextRef.current.createMediaStreamSource(stream);
            const newAnalyser = audioContextRef.current.createAnalyser();
            analyserNodeRef.current = newAnalyser;
            setAnalyser(newAnalyser);

            processorNodeRef.current = audioContextRef.current.createScriptProcessor(4096, 1, 1);
            
            processorNodeRef.current.onaudioprocess = (e) => {
                // Use the REF to check if we are recording, to avoid closure issues
                if (isRecordingRef.current) {
                    pcmChunksRef.current.push(new Float32Array(e.inputBuffer.getChannelData(0)));
                }
            };

            sourceNodeRef.current.connect(newAnalyser);
            sourceNodeRef.current.connect(processorNodeRef.current);
        } catch (err) { console.error("Monitor Fail:", err); }
    }, []); // No dependency on isRecording

    useEffect(() => { 
        const init = async () => {
            await getDevices(); 
            await fetchRecordings();
        };
        init();
    }, [getDevices, fetchRecordings]);

    useEffect(() => { if (selectedDeviceId) startMonitoring(selectedDeviceId); }, [selectedDeviceId, startMonitoring]);

    const startRecording = async () => {
        pcmChunksRef.current = [];
        isRecordingRef.current = true;
        setIsRecording(true);
        setStatus({ text: `🔴 錄製中 (${sampleRateRef.current}Hz)`, color: "red" });
    };

    const stopAndUploadRecording = async () => {
        isRecordingRef.current = false;
        setIsRecording(false);
        
        if (pcmChunksRef.current.length === 0) {
            setStatus({ text: "未採集到音訊", color: "red" });
            return;
        }

        const wavBlob = encodeWAV([...pcmChunksRef.current], sampleRateRef.current);
        const formData = new FormData();
        formData.append('type', 'raw'); 
        formData.append('audio', wavBlob, 'recording.wav');
        
        await fetch('/upload', { method: 'POST', body: formData });
        fetchRecordings();
        setStatus({ text: "錄音已上傳", color: "green" });
    };

    const uploadFile = async (file: File) => {
        const sizeMb = (file.size / 1024 / 1024).toFixed(2);
        setStatus({ text: `準備分塊上傳... (${sizeMb}MB)`, color: "blue" });
        
        try {
            const CHUNK_SIZE = 10 * 1024 * 1024; // 10MB per chunk
            const totalChunks = Math.ceil(file.size / CHUNK_SIZE);
            const uploadId = `upload-${Date.now()}-${Math.floor(Math.random() * 10000)}`;
            
            let uploadedBytes = 0;
            
            for (let i = 0; i < totalChunks; i++) {
                const start = i * CHUNK_SIZE;
                const end = Math.min(start + CHUNK_SIZE, file.size);
                const chunk = file.slice(start, end);
                
                await new Promise((resolve, reject) => {
                    const xhr = new XMLHttpRequest();
                    xhr.open('POST', `/upload_chunk?uploadId=${uploadId}&chunkIndex=${i}`, true);
                    xhr.timeout = 120000; // 2 mins per chunk
                    
                    xhr.upload.onprogress = (e) => {
                        if (e.lengthComputable) {
                            const currentTotalLoaded = uploadedBytes + e.loaded;
                            const percentComplete = Math.round((currentTotalLoaded / file.size) * 100);
                            const loadedMb = (currentTotalLoaded / 1024 / 1024).toFixed(2);
                            setStatus({ text: `上傳中... ${percentComplete}% (${loadedMb}/${sizeMb}MB)`, color: "blue" });
                        }
                    };
                    
                    xhr.onload = () => {
                        if (xhr.status >= 200 && xhr.status < 300) {
                            uploadedBytes += chunk.size;
                            resolve(xhr.responseText);
                        } else {
                            reject(new Error(`伺服器拒絕分塊 ${i} (HTTP ${xhr.status})`));
                        }
                    };
                    
                    xhr.onerror = () => reject(new Error("網路錯誤或被擋"));
                    xhr.onabort = () => reject(new Error("被瀏覽器中斷"));
                    xhr.ontimeout = () => reject(new Error("連線逾時"));
                    
                    xhr.setRequestHeader("Content-Type", "application/octet-stream");
                    xhr.send(chunk);
                });
            }
            
            setStatus({ text: "合併檔案中...", color: "blue" });
            
            const completeResponse = await fetch('/upload_complete', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    uploadId,
                    totalChunks,
                    filename: file.name,
                    type: 'raw'
                })
            });
            
            if (!completeResponse.ok) {
                throw new Error(`合併失敗 (HTTP ${completeResponse.status})`);
            }
            
            fetchRecordings();
            setStatus({ text: "✅ 檔案已上傳", color: "green" });
        } catch (err: any) {
            console.error("Upload Error:", err);
            setStatus({ text: `❌ 失敗: ${err.message}`, color: "red" });
        }
    };

    return {
        devices, selectedDeviceId, setSelectedDeviceId,
        analyser,
        status, isRecording, startRecording, stopAndUploadRecording, uploadFile,
        rawRecordings, uploadSegments,
        refreshRecordings: fetchRecordings,
        refreshDevices: getDevices
    };
}
