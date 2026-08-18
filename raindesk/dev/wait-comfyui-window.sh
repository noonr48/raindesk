#!/bin/bash
# rd-comfyui-wait — bounded watcher: start ComfyUI when GPU 3 frees.
# Polls every 5 min for up to 6h. No generation; judgment stays with primary.
DEADLINE=$(( $(date +%s) + 21600 ))
while [ "$(date +%s)" -lt "$DEADLINE" ]; do
  if ! systemctl --user is-active --quiet minimax-music3.service; then
    if ! nvidia-smi --query-gpu=memory.used --format=csv,noheader,nounits -i 3 2>/dev/null | awk '{ exit !($1 < 2000) }'; then
      # unit inactive but VRAM still held — residual, wait one more cycle
      sleep 300; continue
    fi
    echo "$(date -Is) GPU 3 free and minimax inactive — starting comfyui-5090"
    gpu-fleet start comfyui-5090 --host server && \
      curl -sf -m 10 http://127.0.0.1:8188/system_stats > /dev/null && \
      echo "$(date -Is) COMFYUI-READY" || echo "$(date -Is) START-FAILED-CHECK-MANUALLY"
    exit 0
  fi
  sleep 300
done
echo "$(date -Is) WINDOW-EXPIRED-6H"
