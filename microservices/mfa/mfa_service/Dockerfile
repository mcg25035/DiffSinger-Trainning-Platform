FROM mmcauliffe/montreal-forced-aligner:latest

USER root
RUN apt-get update && apt-get install -y libgl1-mesa-glx && rm -rf /var/lib/apt/lists/*
RUN /opt/conda/bin/pip install fastapi uvicorn python-multipart praatio

USER mfauser
# 預先下載預設模型
RUN mfa model download acoustic japanese_mfa

# 建立並複製應用程式檔案
WORKDIR /app
COPY ./app /app

# MFA 需要寫入權限來建立數據庫和暫存檔
RUN mkdir -p /home/mfauser/Documents/MFA

EXPOSE 8001

CMD ["/opt/conda/bin/uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8001"]
