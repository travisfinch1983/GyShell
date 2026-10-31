# CT177 ai-gpu (px-gpu) — hand-placed host files

| File | Why | Deployed |
|---|---|---|
| `etc/systemd/system/ailab-imagegen-models-9310.service.d/10-memory-ramlru.conf` | imagegen-models-9310 memory limits (MemoryHigh=88G, MemoryMax=100G) + `AILAB_MODELSVC_RAM_BUDGET_GB=64` / `AILAB_MODELSVC_RAM_MIN_IDLE_S=300` for the serve.py RAM budget (`infra/patches/ailab-modelsvc/0004-ram-budget-lru-eviction.patch`). Port of the CT176 fix after its 2026-10-31 memcg OOM; CT177 ran the same unbounded code. Sized for the HOST, not the CT: CT177's memcg is 700 GiB, but px-gpu (754 GiB) carries the 512 GiB `/mnt/model-cache` RAM disk (318 GiB used, ~319 GiB host-available on 2026-10-31) and CT177 also runs 1cat-vllm-5003/5004/5012, vllm-5013, audio-tools-8890 (~32 GiB RSS). A drop-in because ai.js regenerates the unit file and `/opt/proxlab/services/*.sh` on relaunch. Apply: copy, `systemctl daemon-reload`, restart via AI-Lab. | 2026-10-31 |
