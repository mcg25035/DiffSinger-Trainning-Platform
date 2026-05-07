import os
import shutil
import subprocess
import tempfile
import multiprocessing
from typing import List, Dict
from fastapi import FastAPI, UploadFile, File, Form, Query
from fastapi.responses import PlainTextResponse
import json
from praatio import textgrid

app = FastAPI()

import ast
import re

# 全域快取
MODEL_LIST_CACHE = {"local": [], "remote": [], "timestamp": 0}
PHONE_SET_CACHE = {} # {model_name: {"phones": [], "timestamp": 0}}
CACHE_TTL = 3600 # 1小時

@app.get("/models")
async def list_models():
    """列出本地與遠端可用的聲學模型 (含快取)"""
    global MODEL_LIST_CACHE
    import time
    
    now = time.time()
    if now - MODEL_LIST_CACHE["timestamp"] < CACHE_TTL and MODEL_LIST_CACHE["local"]:
        return {**MODEL_LIST_CACHE, "version": "v1.3-final"}

    try:
        # 獲取本地已下載的模型
        local_result = subprocess.run(["mfa", "model", "list", "acoustic"], capture_output=True, text=True)
        # 獲取遠端可下載的模型
        remote_result = subprocess.run(["mfa", "model", "download", "acoustic"], capture_output=True, text=True)
        
        def parse_mfa_output(output):
            # 極度暴力清理：將所有非字母數字字元轉為空格
            clean = "".join([c if c.isalnum() or c in "_-" else " " for c in output])
            items = []
            for w in clean.split():
                w = w.strip()
                if w and w.lower() not in ["usage", "options", "acoustic", "download", "model", "list", "locally", "saved", "pretrained", "mfa", "repository"]:
                    items.append(w)
            return sorted(list(set(items)))

        local_models = parse_mfa_output(local_result.stdout)
        remote_models = parse_mfa_output(remote_result.stdout)
        
        # 過濾掉 remote 中已經在 local 的模型
        remote_models = [m for m in remote_models if m not in local_models]

        MODEL_LIST_CACHE = {
            "local": local_models,
            "remote": remote_models,
            "timestamp": now
        }
        return {**MODEL_LIST_CACHE, "version": "v1.3-final"}
    except Exception as e:
        return {"error": str(e)}, 500

@app.get("/model_phones/{model_name}")
async def get_model_phones(model_name: str):
    """獲取指定模型的音素集 (Phone set) (含快取)"""
    global PHONE_SET_CACHE
    import time
    
    now = time.time()
    if model_name in PHONE_SET_CACHE:
        if now - PHONE_SET_CACHE[model_name]["timestamp"] < CACHE_TTL:
            return {"model": model_name, "phones": PHONE_SET_CACHE[model_name]["phones"]}

    try:
        ensure_mfa_model(model_name)
        cmd = ["mfa", "model", "inspect", "acoustic", model_name]
        result = subprocess.run(cmd, capture_output=True, text=True)
        
        # 移除裝飾字元
        clean_stdout = re.sub(r'[│╭╯╰─╮]', ' ', result.stdout)
        
        # 尋找 Phones 區塊 - 更加彈性的正規表達式
        phones = []
        # 尋找 'Phones': { 或 Phones: {
        match = re.search(r"Phones['\"]?\s*[:\s]*\{(.*?)\}", clean_stdout, re.DOTALL | re.IGNORECASE)
        if match:
            phone_text = match.group(1)
            # 提取所有被引號包圍的內容
            items = re.findall(r"['\"](.*?)['\"]", phone_text)
            phones = [p.strip("'\", ") for p in items if p.strip("'\", ")]
        
        # 如果正規表達式沒抓到，嘗試簡單的逐行抓取
        if not phones:
            in_section = False
            for line in clean_stdout.splitlines():
                if "Phones" in line:
                    in_section = True
                    continue
                if in_section:
                    if "}" in line: break
                    items = re.findall(r"['\"](.*?)['\"]", line)
                    phones.extend([p.strip("'\", ") for p in items if p.strip("'\", ")])

        phones = sorted(list(set(phones)))
        PHONE_SET_CACHE[model_name] = {
            "phones": phones,
            "timestamp": now
        }
        
        return {"model": model_name, "phones": phones}
    except Exception as e:
        return {"error": str(e)}, 500

def get_mapping_config(model_name: str) -> dict:
    """從 mappings 目錄載入模型對應的音素映射表"""
    path = f"mappings/{model_name}.json"
    if os.path.exists(path):
        with open(path, "r", encoding="utf-8") as f:
            return json.load(f)
    return {"dictionary": {}, "reverse_mapping": {}}

# 模型檢查緩存
MODEL_CHECK_CACHE = set()

def ensure_mfa_model(model_name: str):
    """檢查並下載指定的 MFA 聲學模型 (快取檢查結果)"""
    if model_name in MODEL_CHECK_CACHE:
        return
        
    check_cmd = ["mfa", "model", "inspect", "acoustic", model_name]
    result = subprocess.run(check_cmd, capture_output=True)
    if result.returncode != 0:
        subprocess.run(["mfa", "model", "download", "acoustic", model_name], check=True)
    
    MODEL_CHECK_CACHE.add(model_name)

import asyncio

def generate_custom_dictionary(lyrics: str, dict_map: dict, dict_path: str):
    """根據映射表生成 MFA 字典"""
    words = lyrics.strip().split()
    unique_words = set(words)
    with open(dict_path, "w", encoding="utf-8") as f:
        for w in unique_words:
            phones = dict_map.get(w, w)
            f.write(f"{w}\t{phones}\n")

@app.post("/validate_lyrics")
async def validate_lyrics(
    romanji_lyrics: str = Form(...),
    model: str = Query("japanese_mfa")
):
    config = get_mapping_config(model)
    dict_map = config.get("dictionary", {})
    
    words = romanji_lyrics.strip().split()
    missing_words = []
    
    for w in words:
        if w not in dict_map:
            missing_words.append(w)
            
    if missing_words:
        return {
            "valid": False,
            "missing": list(set(missing_words)),
            "message": f"Missing mappings for: {', '.join(list(set(missing_words)))}"
        }
        
    return {"valid": True, "missing": [], "message": "All words have mappings."}

@app.post("/align")
async def align(
    phonemes: str = Form(...),
    romanji_lyrics: str = Form(...),
    wav: UploadFile = File(...),
    model: str = Query("japanese_mfa"),
    tier_type: str = Query("phones"),
    num_jobs: int = Query(default=max(1, multiprocessing.cpu_count() - 1))
):
    config = get_mapping_config(model)
    dict_map = config.get("dictionary", {})
    rev_map = config.get("reverse_mapping", {})

    try:
        ensure_mfa_model(model)
    except Exception as e:
        return PlainTextResponse(f"Model error: {str(e)}", status_code=500)

    with tempfile.TemporaryDirectory() as tmpdir:
        corpus_dir = os.path.join(tmpdir, "corpus")
        os.makedirs(corpus_dir)
        
        wav_path = os.path.join(corpus_dir, "audio.wav")
        with open(wav_path, "wb") as f:
            shutil.copyfileobj(wav.file, f)
            
        lab_path = os.path.join(corpus_dir, "audio.lab")
        with open(lab_path, "w", encoding="utf-8") as f:
            f.write(romanji_lyrics)
            
        dict_path = os.path.join(tmpdir, "dict.txt")
        generate_custom_dictionary(romanji_lyrics, dict_map, dict_path)
        
        output_dir = os.path.join(tmpdir, "output")
        
        try:
            cmd = [
                "mfa", "align",
                corpus_dir,
                dict_path,
                model,
                output_dir,
                "--clean", "--overwrite", "--no_debug",
                f"--num_jobs={num_jobs}",
                "--single_speaker",
                "--beam", "100", "--retry_beam", "400"
            ]
            
            print(f"DEBUG_EXEC: {' '.join(cmd)}")
            
            # Debug: 紀錄產生的字典內容
            with open(dict_path, "r", encoding="utf-8") as df:
                dict_content = df.read()
                print(f"--- Generated Dictionary ---\n{dict_content}\n--------------------------")
            
            proc = await asyncio.create_subprocess_exec(
                *cmd,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE
            )
            stdout, stderr = await proc.communicate()
            
            tg_path = os.path.join(output_dir, "audio.TextGrid")
            if not os.path.exists(tg_path):
                tg_path = os.path.join(output_dir, "corpus", "audio.TextGrid")
            
            if not os.path.exists(tg_path):
                return PlainTextResponse(f"MFA Error: {stderr.decode()}", status_code=500)
                
            tg = textgrid.openTextgrid(tg_path, includeEmptyIntervals=False)
            target_tier = tg.getTier(tier_type) if tier_type in tg.tierNames else tg.getTier(tg.tierNames[0])
            
            output_lines = []
            for start, end, label in target_tier.entries:
                if label in ["<eps>", "sil", "sp", ""]: continue
                translated_label = rev_map.get(label, label)
                s = int(float(start) * 10000000)
                e = int(float(end) * 10000000)
                output_lines.append(f"{s} {e} {translated_label}")
                
            return PlainTextResponse("\n".join(output_lines))
        except Exception as e:
            return PlainTextResponse(f"Execution failed: {str(e)}", status_code=500)

@app.post("/align_batch")
async def align_batch(
    wavs: List[UploadFile] = File(...),
    lyrics_json: str = Form(...),
    model: str = Query("japanese_mfa"),
    tier_type: str = Query("phones"),
    num_jobs: int = Query(default=max(1, multiprocessing.cpu_count() - 1))
):
    """批量對齊多個音檔"""
    config = get_mapping_config(model)
    dict_map = config.get("dictionary", {})
    rev_map = config.get("reverse_mapping", {})
    
    try:
        lyrics_data = json.loads(lyrics_json) # Expecting { "original_filename": "lyrics" }
    except Exception as e:
        return PlainTextResponse(f"Invalid lyrics_json: {str(e)}", status_code=400)

    try:
        ensure_mfa_model(model)
    except Exception as e:
        return PlainTextResponse(f"Model error: {str(e)}", status_code=500)

    results = {}

    with tempfile.TemporaryDirectory() as tmpdir:
        corpus_dir = os.path.join(tmpdir, "corpus")
        os.makedirs(corpus_dir)
        
        all_lyrics = ""
        for wav in wavs:
            # 使用原始檔名或從 lyrics_data 匹配
            # 為了安全，我們將檔名清理一下
            safe_name = "".join([c for c in wav.filename if c.isalnum() or c in "._-"])
            base_name = os.path.splitext(safe_name)[0]
            
            wav_path = os.path.join(corpus_dir, safe_name)
            with open(wav_path, "wb") as f:
                shutil.copyfileobj(wav.file, f)
            
            # 獲取對應歌詞
            content = lyrics_data.get(wav.filename) or lyrics_data.get(safe_name) or ""
            if not content:
                # 嘗試模糊匹配
                for k, v in lyrics_data.items():
                    if k in safe_name or safe_name in k:
                        content = v
                        break
            
            lab_path = os.path.join(corpus_dir, f"{base_name}.lab")
            with open(lab_path, "w", encoding="utf-8") as f:
                f.write(content)
            
            all_lyrics += " " + content
            
        dict_path = os.path.join(tmpdir, "dict.txt")
        generate_custom_dictionary(all_lyrics, dict_map, dict_path)
        
        output_dir = os.path.join(tmpdir, "output")
        
        try:
            cmd = [
                "mfa", "align",
                corpus_dir,
                dict_path,
                model,
                output_dir,
                "--clean", "--overwrite", "--no_debug",
                f"--num_jobs={num_jobs}",
                "--single_speaker",
                "--beam", "100", "--retry_beam", "400"
            ]
            
            print(f"DEBUG_EXEC: {' '.join(cmd)}")
            
            # Debug: 紀錄產生的字典內容
            with open(dict_path, "r", encoding="utf-8") as df:
                dict_content = df.read()
                print(f"--- Generated Dictionary ---\n{dict_content}\n--------------------------")
            
            proc = await asyncio.create_subprocess_exec(
                *cmd,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE
            )
            stdout, stderr = await proc.communicate()
            stderr_text = stderr.decode()
            
            # 先遞迴找出所有的 TextGrid
            found_tgs = {}
            for root, dirs, files in os.walk(output_dir):
                for f in files:
                    if f.endswith(".TextGrid"):
                        found_tgs[f] = os.path.join(root, f)
            
            # 如果執行失敗且完全沒產出檔案，才報錯
            if proc.returncode != 0 and not found_tgs:
                print(f"MFA Error (Exit {proc.returncode}): {stderr_text}")
                return PlainTextResponse(f"MFA Error (Exit {proc.returncode}): {stderr_text}", status_code=500)

            # 如果執行成功但沒產出檔案（例如音檔太短被跳過），也報錯
            if not found_tgs:
                print(f"MFA finished but produced NO TextGrids. Stderr:\n{stderr_text}")
                return PlainTextResponse(f"MFA finished but produced NO TextGrids. Stderr:\n{stderr_text}", status_code=500)

            for wav in wavs:
                safe_name = "".join([c for c in wav.filename if c.isalnum() or c in "._-"])
                base_name = os.path.splitext(safe_name)[0]
                tg_name = f"{base_name}.TextGrid"
                
                tg_path = found_tgs.get(tg_name)
                
                if tg_path:
                    try:
                        tg = textgrid.openTextgrid(tg_path, includeEmptyIntervals=False)
                        target_tier = tg.getTier(tier_type) if tier_type in tg.tierNames else tg.getTier(tg.tierNames[0])
                        
                        output_lines = []
                        for start, end, label in target_tier.entries:
                            if label in ["<eps>", "sil", "sp", ""]: continue
                            translated_label = rev_map.get(label, label)
                            s = int(float(start) * 10000000)
                            e = int(float(end) * 10000000)
                            output_lines.append(f"{s} {e} {translated_label}")
                        
                        results[wav.filename] = "\n".join(output_lines)
                    except Exception as e:
                        results[wav.filename] = f"ERROR: Failed to parse TextGrid: {str(e)}"
                else:
                    all_found = list(found_tgs.keys())
                    results[wav.filename] = (
                        f"ERROR: TextGrid not found for {wav.filename}. Expected: {tg_name}. "
                        f"Found: {all_found}."
                    )
            
            return results
        except Exception as e:
            return PlainTextResponse(f"Execution failed: {str(e)}", status_code=500)

if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8001)
