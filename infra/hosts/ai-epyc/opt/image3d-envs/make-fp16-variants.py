"""claude1 2026-11-03: fp16 model variants for cards without bf16 (V100 sm_70), as configs only.
TRELLIS.2: <ailab-models>/TRELLIS.2-4B-fp16/{pipeline.json, ckpts/*.json (dtype float16), ckpts/*.safetensors -> originals}
UniForge3D: /opt/uniforge3d/ailab-models/pipeline-fp16.json (VGGT extractor dtype float16).
The weights stay bf16 on disk; the models cast them to fp16 at load. Run on each host that serves V100s."""
import json, os, shutil
SRC = "/opt/image3d-view/TRELLIS.2-4B/ckpts"
DST = "/opt/trellis2/ailab-models/TRELLIS.2-4B-fp16"
os.makedirs(f"{DST}/ckpts", exist_ok=True)
for f in sorted(os.listdir(SRC)):
    s, d = f"{SRC}/{f}", f"{DST}/ckpts/{f}"
    if f.endswith(".json"):
        c = json.load(open(s)); a = c.get("args", {})
        if a.get("dtype") in ("bfloat16", "bf16"):
            a["dtype"] = "float16"; print("fp16:", f)
        json.dump(c, open(d, "w"), indent=4)
    elif f.endswith(".safetensors"):
        if os.path.lexists(d): os.unlink(d)
        os.symlink(s, d)
shutil.copy("/opt/trellis2/ailab-models/TRELLIS.2-4B/pipeline.json", f"{DST}/pipeline.json")
u = json.load(open("/opt/uniforge3d/ailab-models/pipeline.json"))
assert u["conditioner"]["vggt_feature_extractor"]["dtype"] == "bfloat16"
u["conditioner"]["vggt_feature_extractor"]["dtype"] = "float16"
u["_ailab"] = u.get("_ailab", "") + " | fp16 variant for V100 (VGGT extractor dtype float16)"
json.dump(u, open("/opt/uniforge3d/ailab-models/pipeline-fp16.json", "w"), indent=2)
print("ok", DST, "/opt/uniforge3d/ailab-models/pipeline-fp16.json")
