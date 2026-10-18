# DiffSinger 本機(CPU)推論 image
# - 源碼 = ~/.cache/train-mgr/diffsinger(已套 diffsinger.patch,和雲端 VM 同狀態)
# - deps = setup_uv.sh 同一套 pinned 版本,但 torch 換 CPU wheel
# - vocoder = build 時抓官方 zip(SingingVocoders v1.0.0)+ 轉 {'generator'}(和 VM 端同 snippet)
FROM python:3.11-slim

RUN apt-get update \
    && apt-get install -y --no-install-recommends wget unzip g++ make \
    && rm -rf /var/lib/apt/lists/*

COPY repo-src /work/DiffSinger

# torch CPU(和 setup_uv.sh 同版 2.4.1,只換 index)
RUN pip install --no-cache-dir \
    torch==2.4.1 torchaudio==2.4.1 \
    --index-url https://download.pytorch.org/whl/cpu

# 其餘 pinned deps(setup_uv.sh 同清單;setuptools<81 保留 pkg_resources 給 lightning)
RUN pip install --no-cache-dir \
    "setuptools<81" \
    click "einops>=0.7.0" h5py "librosa<0.10.0" "lightning~=2.3.0" \
    matplotlib matplotlib-inline IPython MonkeyType==23.3.0 "numpy<2.0.0" praat-parselmouth \
    pyworld==0.3.4 PyYAML resampy "scipy>=1.10.0" tensorboard tensorboardX \
    torchmetrics tqdm

# vocoder:官方 zip → {'generator'} model.ckpt + config.json
COPY vocoder-config.json /tmp/vocoder-config.json
RUN set -e; VD=/work/DiffSinger/checkpoints/pc_nsf_hifigan_44.1k_hop512_128bin_2025.02; \
    wget -q https://github.com/openvpi/SingingVocoders/releases/download/v1.0.0/pc_nsf_hifigan_44.1k_hop512_128bin_2025.02.zip -O /tmp/vocoder.zip \
    && mkdir -p /tmp/vz && (cd /tmp/vz && unzip -q -o /tmp/vocoder.zip) \
    && python -c "import torch,os; ck='/tmp/vz/'+[p for p in os.listdir('/tmp/vz') if p.endswith('.ckpt')][0]; d=torch.load(ck,map_location='cpu'); sd=d.get('state_dict',d); g={k[len('generator.'):]:v for k,v in sd.items() if k.startswith('generator.')}; os.makedirs('$VD',exist_ok=True); torch.save({'generator':g},'$VD/model.ckpt')" \
    && cp /tmp/vocoder-config.json $VD/config.json \
    && rm -rf /tmp/vz /tmp/vocoder.zip

# smoke test:import 鏈(不 assert CUDA — 這是 CPU image)
RUN python -c "import torch, lightning, librosa, tensorboardX, yaml, h5py, parselmouth; print('SMOKE_OK torch', torch.__version__)"

COPY entry.sh /entry.sh
RUN chmod +x /entry.sh

# 常駐服務模式(預設):HTTP :8791,host 用 run-service.sh 起;
# 一次性 debug:docker run --entrypoint /entry.sh ... -e EXP_NAME=... -v stage:/in:ro -v out:/out
COPY server.py /server.py
EXPOSE 8791
CMD ["python", "/server.py"]

WORKDIR /work
