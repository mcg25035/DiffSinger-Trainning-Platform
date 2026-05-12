#!/bin/bash
# resolve_env.sh - 智慧環境解析器 (V2: 動態 OS 偵測)

# --- 偵測宿主機 OS 版本 (L2.1) ---
if [ -f /etc/os-release ]; then
    # 提取如 "20.04" 或 "22.04"
    HOST_OS_VER=$(grep -oP '(?<=^VERSION_ID=").*(?=")' /etc/os-release)
    HOST_OS_NAME=$(grep -oP '(?<=^ID=).*' /etc/os-release | tr -d '"')
    echo "🖥️  偵測到宿主機 OS: $HOST_OS_NAME $HOST_OS_VER"
else
    HOST_OS_VER="20.04"
    HOST_OS_NAME="ubuntu"
fi

# 目前 NVIDIA 官方鏡像主要支援 ubuntu20.04 和 ubuntu22.04
# 我們做一個簡單的過濾，確保 Tag 是有效的
if [[ "$HOST_OS_VER" == "22.04" ]]; then
    OS_TAG="ubuntu22.04"
else
    # 預設使用 20.04，因為它對舊驅動相容性更好
    OS_TAG="ubuntu20.04"
fi

# --- 預設值 (L3) ---
DEFAULT_CUDA="11.0.3"
DEFAULT_TAG="${DEFAULT_CUDA}-base-${OS_TAG}"
DEFAULT_PYTORCH_INDEX="https://download.pytorch.org/whl/cu110"
DEFAULT_TORCH="1.7.1+cu110"
DEFAULT_TORCHAUDIO="0.7.2"

# --- 偵測驅動版本 (L2.2) ---
if command -v nvidia-smi &> /dev/null; then
    DRIVER_VER=$(nvidia-smi --query-gpu=driver_version --format=csv,noheader | cut -d'.' -f1)
    echo "🔍 偵測到 NVIDIA 驅動版本: $DRIVER_VER"

    if [ "$DRIVER_VER" -ge 525 ]; then
        DETECTED_CUDA="12.1.0"
        DETECTED_TAG="${DETECTED_CUDA}-base-${OS_TAG}"
        DETECTED_PYTORCH_INDEX="https://download.pytorch.org/whl/cu121"
        DETECTED_TORCH="2.1.2"
        DETECTED_TORCHAUDIO="2.1.2"
    elif [ "$DRIVER_VER" -ge 450 ]; then
        DETECTED_CUDA="11.0.3"
        DETECTED_TAG="${DETECTED_CUDA}-base-${OS_TAG}"
        DETECTED_PYTORCH_INDEX="https://download.pytorch.org/whl/cu110"
        DETECTED_TORCH="1.7.1+cu110"
        DETECTED_TORCHAUDIO="0.7.2"
    fi
fi

# --- 合併結果 (L1 > L2 > L3) ---
export CUDA_VERSION=${CUDA_VERSION:-${DETECTED_CUDA:-$DEFAULT_CUDA}}
export BASE_IMAGE_TAG=${BASE_IMAGE_TAG:-${DETECTED_TAG:-$DEFAULT_TAG}}
export PYTORCH_INDEX_URL=${PYTORCH_INDEX_URL:-${DETECTED_PYTORCH_INDEX:-$DEFAULT_PYTORCH_INDEX}}
export TORCH_VERSION=${TORCH_VERSION:-${DETECTED_TORCH:-$DEFAULT_TORCH}}
export TORCHAUDIO_VERSION=${TORCHAUDIO_VERSION:-${DETECTED_TORCHAUDIO:-$DEFAULT_TORCHAUDIO}}

echo "✅ 環境解析完成:"
echo "   OS Base: $OS_TAG"
echo "   Docker Tag: $BASE_IMAGE_TAG"
echo "   CUDA: $CUDA_VERSION"
echo "   Torch: $TORCH_VERSION"
