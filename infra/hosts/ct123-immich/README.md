# CT123 immich (px-nas)

## Machine learning (since 2026-10-28)
- **Primary ML = CT197 `immich-ml` on px-epyc (10.0.0.46:3003)**: the official
  `immich-machine-learning:<ver>-openvino` image on the **Arc A380**. Its compose file is in
  `../ct197-immich-ml/`. **Keep its tag equal to CT123's Immich version after every update.**
- **Fallback = CT123's own immich-ml on CPU** (`onnxruntime==1.28.0`, no GPU). It must stay
  running: `immich-web.service` has `Requires=immich-ml.service`, so stopping it takes Immich down.
- ML URLs are in the DB (`system_metadata` key `system-config` → `machineLearning.urls` =
  `["http://10.0.0.46:3003","http://127.0.0.1:3003"]`, tried in order). The pre-change config was
  backed up to `/root/system-config.bak-20261028.json` in CT123.
- **The RTX 5060 is no longer mounted** (removed with Plex/Jellyfin's mounts) so it can be shared by
  Frigate and the AI-Lab reranker (roadmap proj-mvsfbjthb9t). Old confs:
  `/root/lxc-{101,123,138}.conf.bak-20261028` on px-nas.
- `immich-restore-cuda.sh` is **retired**: the community-scripts updater installs cpu/openvino,
  which is now what we want. After an update, check that the venv still has plain `onnxruntime`
  and that CT197's image tag matches.
