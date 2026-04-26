#!/usr/bin/env bash
set -euo pipefail

echo "This Raspberry Pi is 32-bit with very limited RAM."
echo "llama.cpp can be compiled, but useful support models may not fit in memory."

sudo apt-get update
sudo apt-get install -y git cmake build-essential curl

if [ ! -d "$HOME/llama.cpp" ]; then
  git clone https://github.com/ggml-org/llama.cpp.git "$HOME/llama.cpp"
fi

cd "$HOME/llama.cpp"
git pull --ff-only || true
cmake -B build -DGGML_NATIVE=OFF -DLLAMA_CURL=ON
cmake --build build --config Release -j"$(nproc)"

mkdir -p "$HOME/models"

cat <<'EOF'

llama.cpp compiled.

Next you need a very small GGUF model in ~/models.
With this Pi's 425 MB RAM, realistic options are tiny experimental models only.

Start an OpenAI-compatible server with:

  ~/llama.cpp/build/bin/llama-server \
    -m ~/models/model.gguf \
    --host 0.0.0.0 \
    --port 8080 \
    -c 512 \
    -ngl 0

Then set NexaDesk:

  AI_PROVIDER=openai-compatible
  OPENAI_COMPAT_BASE_URL=http://192.168.1.52:8080/v1
  OPENAI_COMPAT_MODEL=local

EOF
