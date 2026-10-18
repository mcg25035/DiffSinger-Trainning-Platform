#!/bin/sh
# 容器內執行:組 exp dir(ckpt/小檔/train.yaml 生成 config)→ infer.py
# 掛載:/in/{exp/,train/} (ro)、/out (rw)、/model.ckpt (ro)、/input.ds (ro)
# env:EXP_NAME、CKPT_NAME、TITLE(可空)
set -e
EXP="$EXP_NAME"
repo=/work/DiffSinger
expDir=$repo/checkpoints/$EXP
mkdir -p "$expDir" /out

# ckpt(保留原檔名 — load_ckpt 找 model_ckpt_steps_*.ckpt)
cp -f /model.ckpt "$expDir/$CKPT_NAME"
# input.ds(掛在根路徑)
cp -f /input.ds /tmp/input.ds
# exp 小檔(config.yaml/spk_map/lang_map/dictionary-default.txt,有什麼給什麼)
for f in config.yaml spk_map.json lang_map.json dictionary-default.txt; do
    [ -f "/in/exp/$f" ] && cp -f "/in/exp/$f" "$expDir"/ || true
done
# config.yaml 缺 → train.yaml 生成(和 VM 端 set_hparams 同一段;set_hparams 會寫 expDir/config.yaml)
if [ ! -f "$expDir/config.yaml" ] && [ -f /in/train/train.yaml ]; then
    cd "$repo"
    python -c "import sys; sys.argv=['x','--config','/in/train/train.yaml','--exp_name','$EXP']; from utils.hparams import set_hparams; set_hparams()"
    cd /work
fi

cd "$repo"
export COLUMNS=1000 PYTHONUNBUFFERED=1
if [ -n "$TITLE" ]; then
    exec python scripts/infer.py acoustic /tmp/input.ds --exp "$EXP" --out /out --title "$TITLE"
else
    exec python scripts/infer.py acoustic /tmp/input.ds --exp "$EXP" --out /out
fi
