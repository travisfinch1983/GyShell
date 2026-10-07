# GPU passthrough and service pinning

How a GPU gets from a Proxmox host into an LXC container, and how an AI-Lab service ends up on the
right card. It covers the whole chain, from the hookscript to the launch script. Written 2026-10-04,
after ai-epyc (CT176) booted without 5060 Ti #1 and its services silently moved onto other cards.

```
 AI-Lab UI: assign GPUs to a CT ──► gpu-assignments.json  {vmid: {gpus: [PCI, ...]}}
                                         │
                hookscript-deploy.js     ▼
   proxlab-vars/<vmid>.sh  (PROXLAB_GPU_n_PCI / _UUID / _NAME)      on the px-data snippets share
   proxlab-master.sh  ──►  proxlab-hooks/gpu-hook.sh                (registered as the CT hookscript)
                                         │  pre-start, and at host boot (proxlab-gpu-refresh.service)
                                         ▼
   /etc/pve/lxc/<vmid>.conf  # proxlab-gpu-start … # proxlab-gpu-end   (bind mounts + cgroup allows)
                                         │  NEXT container start
                                         ▼
   container sees /dev/nvidiaN for the cards that were present when the block was written
                                         │
  UI launch (indices) ──► ai.js /launch-service, /launch                 
                          gpuPciIds = the card identities ──► GPU-pin preamble in the launch script
                                         │  at every service start, inside the container
                                         ▼
   PCI ──► /proc/driver/nvidia/gpus/<pci>/information ──► attached? ──► CUDA index ──► run / exit 78
```

## 1. Identity: what names a card

| Name | Example | Stable? | Used for |
|---|---|---|---|
| Friendly name | `GeForce RTX 5060 Ti #1` | yes (AI-Lab label) | UI |
| **PCI address** | `0000:02:00.0` | **yes**, per slot | **the identity AI-Lab stores** (`gpuPciIds`, `gpu-assignments.json`) |
| UUID | `GPU-a33cd194-…` | yes, per card | hook fallback if a card changes slot; **service pin: primary** (since 2026-10-07) |
| Host device minor | `/dev/nvidia2` | **no**: probe order, can shift | bind mount + cgroup line |
| CUDA index | `CUDA_VISIBLE_DEVICES=1` | **no**: position among the cards *visible right now* | what CUDA programs consume |

Rule: **store the PCI address, derive everything else at the last possible moment.** An index is
"whichever card is Nth right now". When 02:00.0 was missing, index 1 meant 22:00.0, and five services
ran on the wrong card while AI-Lab's metrics still attributed them to 02:00.0.

ai-epyc (px-epyc) for reference, from host `/proc/driver/nvidia/gpus/*/information`:

| PCI | Card | Host minor | CUDA index in CT176 (all attached, PCI order) |
|---|---|---|---|
| 0000:01:00.0 | 5060 Ti #0 | 1 | 0 |
| 0000:02:00.0 | 5060 Ti #1 | 2 | 1 |
| 0000:22:00.0 | 5060 Ti #2 | 3 | 2 |
| 0000:43:00.0 | 5060 Ti #3 | 0 | 3 |
| 0000:a1:00.0 | RTX 4090   | 4 | 4 |

## 2. Container passthrough (host side)

**Source of truth:** `packages/backend/src/services/Cluster/proxy/llm/services/hookscript-deploy.js`
generates every file below. They're marked "auto-deployed, do not edit manually", and a hand edit is
overwritten on the next deploy. Edit the generator.

Files on the px-data snippets share. It's mounted at `/mnt/pve/px-data/snippets` on px-epyc/px-gpu
and `/mnt/zpoolalpha/pxdata/snippets` on px-nas. Always resolve it with
`pvesm path px-data:snippets/proxlab-master.sh`.

- `proxlab-master.sh`: the hookscript registered on each CT (`hookscript: px-data:snippets/proxlab-master.sh`).
  It sources `proxlab-vars/<vmid>.sh`, then dispatches: pre-start goes to `gpu-hook.sh` (if
  `PROXLAB_GPU_COUNT>0`) and `shared-hook.sh`; post-start goes to `cache-hook.sh`.
- `proxlab-vars/<vmid>.sh`: `PROXLAB_MOUNT_STYLE`, `PROXLAB_GPU_COUNT`, and for each card
  `PROXLAB_GPU_n_PCI / _UUID / _NAME / _VENDOR`, plus shared-folder and model-cache vars.
- `proxlab-hooks/gpu-hook.sh` pre-start does the following:
  1. Deletes the old `# proxlab-gpu-start … # proxlab-gpu-end` block and any stray GPU lines.
  2. For each card, finds the DRI card/renderD through `/dev/dri/by-path`, and the NVIDIA minor from
     **`/proc/driver/nvidia/gpus/<pci>/information`** (`Device Minor:`). If the address moved, it
     matches on the UUID instead. **It never calls `nvidia-smi`**: on a stalled card that can take
     the driver's RM lock and deadlock the host, and this runs on every container start.
  3. Writes bind mounts (`lxc.mount.entry … optional`) and `lxc.cgroup2.devices.allow` lines for
     those cards, plus the shared nodes (`nvidiactl`, `nvidia-uvm*`, `nvidia-modeset`, `nvidia-caps/*`).
     If `/dev/nvidiaN` doesn't exist yet, the cgroup line falls back to `c 195:N`.
  4. Logs `GPU(s) NOT present on this host: …` for any card it couldn't resolve.

### ⚠ The one-start-behind trap

**PVE parses `<vmid>.conf` BEFORE it runs the pre-start hookscript.** Whatever the hook writes
applies to the **next** start, not the current one. If the set of cards changes between two starts
(a card drops off the bus, or comes back after an IPMI power cycle), the container gets the
**previous** start's set. That is exactly what happened on 2026-10-04: the conf was written while
02:00.0 was missing, the host was power-cycled and the card came back, and CT176 autostarted
without it anyway.

Two defences:

- **`proxlab-gpu-refresh.service`** (oneshot on each PVE node, `/usr/local/sbin/proxlab-gpu-refresh`).
  Runs after udev and storage and `Before=pve-guests.service`. It runs the gpu-hook for every ProxLab
  GPU container on that node, so the confs match the hardware **before anything autostarts**. It also
  creates any missing `/dev/nvidiaN`. AI-Lab installs it per node through `ensureNodeBootRefresh`.
  Currently installed on px-epyc; other nodes get it on their next deploy.
- **Drift alarm:** if a start-time hook run changes the block, the PVE task log shows
  `GPU device set CHANGED since PVE loaded this config -- THIS start uses the OLD set; restart CT <id>`.
  When you see that, restart the container once more.

A card that drops off the bus while the container is running isn't covered by either. The container
keeps a dead device node. See the GPU wedge runbooks: IPMI power off, 45 s, power on.

## 3. Service pinning (container side)

**Source:** `ai.js`: `gpuPinPreamble()`, `applyGpuPin()`, `/launch-service` (systemd services) and
`/launch` (tmux one-offs, quantization).

1. The UI still builds `CUDA_VISIBLE_DEVICES=<indices>` (serviceLaunchTemplates.ts,
   LlmLaunchStore.ts, QuantizationStore.ts). Those indices mean **positions in the CT's assigned list**
   (`gpu-assignments.json[vmid].gpus`, PCI-sorted).
2. The backend turns them into identities. `/launch-service` uses explicit `gpuPciIds` when the UI
   sends them, otherwise `resolveServiceGpuPciIds(vmid, indices)`. The result is stored as
   `services[id].gpuPciIds`, in **launch order**.
3. `applyGpuPin()` replaces every `CUDA_VISIBLE_DEVICES=<digits>` (both the `export` and the inline
   form) with `CUDA_VISIBLE_DEVICES="$AILAB_CVD"`, and puts a preamble at the top of the script:
   ```bash
   AILAB_GPU_PCIS="0000:02:00.0"
   export CUDA_DEVICE_ORDER=PCI_BUS_ID
   # attached = cards whose /proc entry exists AND whose /dev/nvidia<minor> exists in this CT, PCI-sorted
   # index   = position of each wanted PCI in that list; missing -> message + exit 78
   export CUDA_VISIBLE_DEVICES="$AILAB_CVD"
   echo "AI-LAB GPU PIN: 0000:02:00.0 -> CUDA_VISIBLE_DEVICES=1 (PCI order among attached)"
   ```
   The index is computed **at every start**, against the cards actually attached. It stays correct
   even when some *other* card is missing.
4. If the card is missing, you get `AI-LAB GPU PIN: GPU 0000:02:00.0 is NOT attached to this container
   (attached: …) -- refusing to start rather than run on a different card`, and the script exits **78**.
   The systemd unit has `RestartPreventExitStatus=78`, so it doesn't retry in a loop.
5. If the number of indices and identities don't match (or the format is bad), the script is left
   unpinned and `[gpu-pin] not pinning …` goes to the backend log. A CPU-only service (no CVD) is
   untouched.

**Why numeric and not `GPU-<uuid>`:** CUDA itself accepts UUIDs, but vLLM does
`int(CUDA_VISIBLE_DEVICES[i])` (`vllm/platforms/interface.py: device_id_to_physical_device_id`). The
first version of the pin exported UUIDs and crash-looped the reranker. Keep it numeric.

**Device numbering inside a process** follows the **list order** of `CUDA_VISIBLE_DEVICES`, not PCI
order. With `4,1,2,3`, the 4090 is `cuda:0` inside ComfyUI. Anything that reports per-process GPU
indices (the ComfyUI instance listing in ai.js) must use the stored launch order, never a sorted one.

Existing scripts are migrated in place. Backups sit next to them: `<script>.pre-gpupin-20261004`
(original, index form) and `<script>.uuidpin-20261004` (the short-lived UUID form).

## 4. Diagnosing

| Question | Where to look |
|---|---|
| Which cards does the host driver see? | host: `ls /proc/driver/nvidia/gpus/` and `…/<pci>/information` (**not** nvidia-smi on a suspect box) |
| Which cards did the CT get? | CT: `ls /dev/nvidia[0-9]*`; host: the `proxlab-gpu` block in `/etc/pve/lxc/<id>.conf` |
| What did the hook do at the last start? | the PVE task log for the CT start; `journalctl -u proxlab-gpu-refresh -b` for the boot run |
| Which card did a service pin to? | `grep "AI-LAB GPU PIN" /var/log/proxlab/<session>.log` |
| Which card is a process *actually* on? | host: map `/proc/<pid>/fd → /dev/nvidiaN` to the host minor table above |
| Service won't start, exit 78 | its card is not attached; fix passthrough (section 2), then restart the service |

## 5. Known gaps

- `/api/ai/agent-gpus` reports `cuda_index` assuming **every** assigned card is attached. An external
  consumer (e.g. the immich upscale companion) that launches with that index can still land on the
  wrong card while a card is missing.
- The UI still sends bare indices. The backend translates them, but the UI could send `gpuPciIds`
  directly everywhere.


## Service pin follows the card by UUID (2026-10-07)

Until 2026-10-07 the hook followed a moved card by UUID but the **service pin matched PCI only**, so after a
slot change the card was attached to the container and every service pinned to it refused to start (exit 78).
The pin now lives in `packages/backend/src/services/Cluster/proxy/llm/services/gpu-pin.js` and scripts carry
`AILAB_GPU_PINS="<pci>=<uuid> ..."` (UUIDs from the GPU monitor's `uuidMap`, the hook's own source):

- UUID known: use the attached card **with that UUID** wherever it sits (logged as `moved <old> -> <new>`);
  if it is not attached, refuse, even if another card now occupies the old address (swapped cards must not
  silently trade services).
- No UUID (non-NVIDIA): PCI address, as before.

Existing scripts were migrated in place (backups `*.sh.pre-uuidpin-20261007`, 10 on CT176, 7 on CT177).
Verified inside CT176 against real /proc: normal, moved, swapped, missing (refused), PCI-only, multi-card.
⚠ After a move, the registry's `gpuPciIds` (UI attribution) still names the old address until the service is
relaunched from the UI.
