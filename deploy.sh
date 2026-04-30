#!/usr/bin/env bash
set -euo pipefail

cd /Users/bogdanleonov/FU/formayya/shikaka

npm run check

rsync -az --delete \
  --exclude node_modules \
  --exclude .venv \
  --exclude .git \
  --exclude .env \
  --exclude __pycache__ \
  --exclude '*.pyc' \
  ./ bogdan@111.88.150.78:/home/bogdan/shikaka/

ssh -o StrictHostKeyChecking=no -l bogdan 111.88.150.78 \
  'cd /home/bogdan/shikaka && (test -x .venv/bin/pip || python3 -m venv .venv || (sudo apt-get update && sudo apt-get install -y python3-venv && python3 -m venv .venv)) && .venv/bin/pip install -r requirements.txt && npm run check && sudo systemctl restart shikaka && systemctl is-active shikaka'
