#!/usr/bin/env python3
"""Extract rename-useful metadata from model files, WITHOUT executing them.

Invoked by files.js as:  file-meta.py <path> [<path> ...]
Emits one JSON object to stdout: { "<path>": {..fields..}, ... }

.pt (torch/YOLO): a .pt is a ZIP whose archive/data.pkl is the pickled object graph.
Unpickling would import and EXECUTE arbitrary code, and Ultralytics checkpoints contain
custom classes so torch.load(weights_only=True) refuses them anyway. We never unpickle —
the head class name, module fingerprints and task string are present as literal bytes and
reading them is inert.

Validated against 172 real detectors: head classes seen were Detect 94, Segment 60,
v10Detect 8, Segment26 7, DualDDetect 2; Proto appeared in exactly the 67 segmentation
models and no others, so `proto` is redundant with `task=segm` and is reported only as a
consistency check, never as an independent signal.

TRAPS THIS CODE EXISTS TO AVOID (both were real bugs during development):
  * `(\\w+)` after "head." runs PAST the class name into pickle opcode bytes, yielding
    "Segmentr" / "v10DetectrSQ" and matching nothing. Match a KNOWN name list instead.
  * `\\bProto\\b` needs a word boundary that the following opcode byte swallows, so it
    reported "no Proto" for 7 real segmentation models. Use a leading boundary only.
"""
import json, os, re, sys, zipfile, struct

# longest-first so Segment26 is not shortened to Segment
HEAD_RE = re.compile(
    r"(?:ultralytics\.nn\.modules(?:\.head)?|models\.yolo|models\.common)"
    r"\.(RTDETRDecoder|DualDDetect|v10Detect|Segment26|Detect26|DDetect|Segment|Detect|Pose|OBB|Classify)"
)
TASK_OF = {
    "Segment": "segm", "Segment26": "segm",
    "Detect": "bbox", "Detect26": "bbox", "v10Detect": "bbox",
    "DDetect": "bbox", "DualDDetect": "bbox", "RTDETRDecoder": "bbox",
    "Pose": "pose", "OBB": "obb", "Classify": "cls",
}
HEAD_RANK = ["Segment26", "Segment", "Pose", "OBB", "Classify",
             "RTDETRDecoder", "DualDDetect", "DDetect", "v10Detect", "Detect26", "Detect"]


def _pt(path):
    if not zipfile.is_zipfile(path):
        blob = open(path, "rb").read(4 * 1024 * 1024)
    else:
        with zipfile.ZipFile(path) as z:
            blob = b"".join(z.read(n) for n in z.namelist() if n.endswith("data.pkl"))
    t = blob.decode("latin-1")

    found = set(HEAD_RE.findall(t))
    head = next((h for h in HEAD_RANK if h in found), None)
    out = {"kind": "yolo" if found or "ultralytics" in t else "torch"}
    if head:
        out["head"] = head
        out["task"] = TASK_OF[head]
    else:
        m = re.search(r"task[\x00-\x20\x80-\xff]{0,12}(segment|detect|pose|classify|obb)", t)
        if m:
            out["task"] = {"segment": "segm", "detect": "bbox", "pose": "pose",
                           "classify": "cls", "obb": "obb"}[m.group(1)]

    # leading boundary ONLY — a trailing \b is eaten by the next pickle opcode byte
    out["proto"] = bool(re.search(r"\bProto", t))

    # architecture generation, from head class then module fingerprints
    if head in ("Segment26", "Detect26"):        out["arch"] = "y26"
    elif head == "v10Detect":                    out["arch"] = "y10"
    elif head == "DualDDetect" or head == "DDetect" or re.search(r"\bADown", t): out["arch"] = "y9"
    elif head == "RTDETRDecoder":                out["arch"] = "rtd"
    elif re.search(r"\bC3k2", t):                out["arch"] = "y11+"   # v11 and v12 are
    elif re.search(r"\bC2f", t):                 out["arch"] = "y8"     # indistinguishable here
    # imgsz, if the training args survived
    m = re.search(r"imgsz[\x00-\x20\x80-\xff]{0,12}([\x00-\xff]{0,4})", t)
    m2 = re.search(r"\b(640|768|800|960|1024|1280|1536)\b", os.path.basename(path))
    if m2: out["imgsz"] = m2.group(1)
    # class count: ultralytics stores names as {0:'x',1:'y'} — count is best-effort
    m3 = re.search(r"\bnc[\x00-\x20\x80-\xff]{1,6}([\x01-\x7f])", t)
    if m3:
        n = ord(m3.group(1))
        if 1 <= n <= 200: out["nc"] = n
    if out.get("task") == "segm" and not out["proto"]:
        out["warn"] = "segm head but no Proto branch found"
    if out.get("task") == "bbox" and out["proto"]:
        out["warn"] = "bbox head but a Proto branch is present"
    return out


def _safetensors(path):
    """Header is: 8-byte LE length, then that many bytes of JSON. Pure data, no exec."""
    with open(path, "rb") as f:
        raw = f.read(8)
        if len(raw) < 8: return {"kind": "safetensors", "error": "truncated"}
        n = struct.unpack("<Q", raw)[0]
        if n > 200 * 1024 * 1024: return {"kind": "safetensors", "error": "implausible header"}
        hdr = json.loads(f.read(n).decode("utf-8"))
    meta = hdr.pop("__metadata__", {}) or {}
    dtypes = sorted({v.get("dtype") for v in hdr.values() if isinstance(v, dict) and v.get("dtype")})
    out = {"kind": "safetensors", "tensors": len(hdr), "dtypes": dtypes}
    for k_out, k_in in (("arch", "modelspec.architecture"), ("title", "modelspec.title"),
                        ("base", "ss_base_model_version"), ("network_dim", "ss_network_dim"),
                        ("network_alpha", "ss_network_alpha")):
        if meta.get(k_in): out[k_out] = str(meta[k_in])[:80]
    # LoRA trigger: the near-universal tag, NOT the ss_tag_frequency KEY (that is a dir name)
    try:
        tf = json.loads(meta["ss_tag_frequency"]) if isinstance(meta.get("ss_tag_frequency"), str) else meta.get("ss_tag_frequency")
        if isinstance(tf, dict):
            tags = {}
            for _dir, d in tf.items():
                if isinstance(d, dict):
                    for tag, cnt in d.items(): tags[tag] = tags.get(tag, 0) + cnt
            if tags:
                top, cnt = max(tags.items(), key=lambda kv: kv[1])
                out["top_tag"] = top
                out["top_tag_count"] = cnt
    except Exception:
        pass
    return out


def probe(path):
    try:
        st = os.stat(path)
    except OSError as e:
        return {"error": str(e)}
    base = {"size": st.st_size, "mtime": int(st.st_mtime)}
    ext = os.path.splitext(path)[1].lower()
    if st.st_size < 4096:
        base["kind"] = "stub"
        try:
            head = open(path, "rb").read(400).decode("utf-8", "replace")
            base["preview"] = head.strip()[:200]
            if head.lstrip().startswith("{"): base["warn"] = "tiny JSON, likely a failed download"
        except Exception:
            pass
        return base
    try:
        if ext in (".pt", ".pth", ".ckpt"):        base.update(_pt(path))
        elif ext in (".safetensors", ".sft"):      base.update(_safetensors(path))
        else:                                      base["kind"] = ext.lstrip(".") or "file"
    except Exception as e:
        base["kind"] = "unreadable"; base["error"] = str(e)[:120]
    return base


if __name__ == "__main__":
    json.dump({p: probe(p) for p in sys.argv[1:]}, sys.stdout)
