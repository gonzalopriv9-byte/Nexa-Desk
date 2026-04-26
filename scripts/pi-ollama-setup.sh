#!/usr/bin/env bash
set -euo pipefail

MODEL="${1:-llama3.2:3b}"

echo "Installing Ollama if needed..."
if ! command -v ollama >/dev/null 2>&1; then
  curl -fsSL https://ollama.com/install.sh | sh
fi

echo "Configuring Ollama to listen on the LAN..."
sudo mkdir -p /etc/systemd/system/ollama.service.d
sudo tee /etc/systemd/system/ollama.service.d/override.conf >/dev/null <<'EOF'
[Service]
Environment="OLLAMA_HOST=0.0.0.0:11434"
EOF

sudo systemctl daemon-reload
sudo systemctl enable ollama
sudo systemctl restart ollama

echo "Pulling model: ${MODEL}"
ollama pull "${MODEL}"

echo "Testing local Ollama API..."
curl -fsS http://127.0.0.1:11434/api/tags >/dev/null

echo "Ollama is ready on port 11434 with model ${MODEL}."
