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


# ─── image dimensions, from HEADERS ONLY ────────────────────────────────────
# No PIL on this host, and decoding a 40MP PNG to learn its width would be absurd
# anyway: every branch below reads a fixed-size header and stops. Verified against
# `file` output across the real jpg/jpeg/png/webp/gif mix in /ai-assets/imagegen.
def _img_png(f):
    f.seek(16); b = f.read(8)
    if len(b) < 8: return None
    return struct.unpack(">II", b)

def _img_gif(f):
    f.seek(6); b = f.read(4)
    if len(b) < 4: return None
    return struct.unpack("<HH", b)

def _img_bmp(f):
    f.seek(18); b = f.read(8)
    if len(b) < 8: return None
    w, h = struct.unpack("<ii", b)
    return (abs(w), abs(h))

def _img_webp(f):
    f.seek(12); chunk = f.read(4)
    if chunk == b"VP8X":                      # extended: 24-bit canvas, stored minus 1
        f.seek(24); b = f.read(6)
        if len(b) < 6: return None
        w = b[0] | b[1] << 8 | b[2] << 16
        h = b[3] | b[4] << 8 | b[5] << 16
        return (w + 1, h + 1)
    if chunk == b"VP8 ":                      # lossy: after the 3-byte start code
        f.seek(23); b = f.read(10)
        i = b.find(b"\x9d\x01\x2a")
        if i < 0 or len(b) < i + 7: return None
        w, h = struct.unpack("<HH", b[i + 3:i + 7])
        return (w & 0x3FFF, h & 0x3FFF)
    if chunk == b"VP8L":                       # lossless: 14+14 bits, stored minus 1
        f.seek(21); b = f.read(4)
        if len(b) < 4: return None
        n = int.from_bytes(b, "little")
        return ((n & 0x3FFF) + 1, ((n >> 14) & 0x3FFF) + 1)
    return None

def _img_jpeg(f):
    """Walk the marker chain to a Start-Of-Frame. Skipping by segment length is what
    keeps this correct — scanning for 0xFFC0 bytes would hit them inside EXIF/ICC."""
    f.seek(2)
    while True:
        b = f.read(1)
        if not b: return None
        if b != b"\xff": continue
        while b == b"\xff":                    # fill bytes are legal
            b = f.read(1)
            if not b: return None
        m = b[0]
        if m in (0xD8, 0xD9) or 0xD0 <= m <= 0xD7: continue   # no length field
        ln = f.read(2)
        if len(ln) < 2: return None
        seglen = struct.unpack(">H", ln)[0]
        # SOF0..SOF15, minus DHT(C4) / JPG(C8) / DAC(CC) which are not frame headers
        if 0xC0 <= m <= 0xCF and m not in (0xC4, 0xC8, 0xCC):
            d = f.read(5)
            if len(d) < 5: return None
            h, w = struct.unpack(">HH", d[1:5])
            return (w, h)
        f.seek(seglen - 2, 1)

def _img_tiff(f):
    f.seek(0); head = f.read(8)
    if len(head) < 8: return None
    en = "<" if head[:2] == b"II" else ">"
    off = struct.unpack(en + "I", head[4:8])[0]
    f.seek(off); nb = f.read(2)
    if len(nb) < 2: return None
    w = h = None
    for _ in range(struct.unpack(en + "H", nb)[0]):
        e = f.read(12)
        if len(e) < 12: break
        tag, typ = struct.unpack(en + "HH", e[:4])
        val = struct.unpack(en + "I", e[8:12])[0] if typ == 4 else struct.unpack(en + "H", e[8:10])[0]
        if tag == 256: w = val
        elif tag == 257: h = val
    return (w, h) if w and h else None

_IMG_EXT = {
    ".png": _img_png, ".jpg": _img_jpeg, ".jpeg": _img_jpeg, ".jpe": _img_jpeg,
    ".gif": _img_gif, ".bmp": _img_bmp, ".webp": _img_webp,
    ".tif": _img_tiff, ".tiff": _img_tiff,
}

def _gcd(a, b):
    while b: a, b = b, a % b
    return a or 1

def _sniff(path):
    """Identify the real format from MAGIC BYTES, never the extension.

    This is not pedantry: 19 of a random 120 images under /ai-assets/imagegen are
    PNGs carrying a .jpeg extension (the CivitAI downloader names previews by
    assumption, not content). Dispatching on the extension parsed those as JPEG and
    produced garbage dimensions like 65239x65439 from entropy-coded bytes.
    """
    with open(path, "rb") as f:
        h = f.read(32)
    if h[:8] == b"\x89PNG\r\n\x1a\n":                    return "png"
    if h[:3] == b"\xff\xd8\xff":                          return "jpeg"
    if h[:6] in (b"GIF87a", b"GIF89a"):                    return "gif"
    if h[:2] == b"BM":                                     return "bmp"
    if h[:4] == b"RIFF" and h[8:12] == b"WEBP":            return "webp"
    if h[:4] in (b"II*\x00", b"MM\x00*"):                  return "tiff"
    if h[4:8] == b"ftyp":
        brand = h[8:12]
        if brand in (b"avif", b"avis"):                    return "avif"
        if brand in (b"heic", b"heix", b"hevc", b"mif1"):  return "heif"
    return None

_IMG_FMT = {"png": _img_png, "jpeg": _img_jpeg, "gif": _img_gif,
            "bmp": _img_bmp, "webp": _img_webp, "tiff": _img_tiff}


# Common ratios, snapped within 1.5%. An exact gcd reduction is worse than useless in a
# filename: 3932x1416 reduces to 983:354, which tells you nothing. Separator is "-", NOT
# ":" — a colon is illegal in Windows/SMB filenames and these live on a NAS.
_COMMON_AR = [(1,1),(4,3),(3,4),(3,2),(2,3),(16,9),(9,16),(5,4),(4,5),
              (2,1),(1,2),(21,9),(9,21),(7,5),(5,7),(16,10),(10,16)]

def _aspect(w, h):
    if not w or not h: return ""
    r = w / h
    best, err = None, 1e9
    for a, b in _COMMON_AR:
        e = abs(r - a / b) / (a / b)
        if e < err: best, err = (a, b), e
    if best and err <= 0.015:
        return "%d-%d" % best
    g = _gcd(w, h)
    a, b = w // g, h // g
    if a <= 32 and b <= 32:            # a genuinely tidy odd ratio is still useful
        return "%d-%d" % (a, b)
    return ("%.2f" % r).rstrip("0").rstrip(".")   # else a plain decimal

def _image(path, ext):
    out = {"kind": "image"}
    try:
        fmt = _sniff(path)
    except Exception as e:
        out["error"] = str(e)[:80]; return out
    if fmt:
        out["fmt"] = fmt
        # flag a wrong extension so the renamer can offer to repair it
        claimed = ext.lstrip(".").lower()
        alias = {"jpg": "jpeg", "jpe": "jpeg", "tif": "tiff"}.get(claimed, claimed)
        if alias != fmt:
            out["ext_mismatch"] = True
            out["warn"] = "extension says .%s but the file is %s" % (claimed, fmt)
    fn = _IMG_FMT.get(fmt or "")
    if not fn: return out
    try:
        with open(path, "rb") as f:
            wh = fn(f)
    except Exception as e:
        out["error"] = str(e)[:80]; return out
    if not wh or not wh[0] or not wh[1]:
        out["warn"] = "dimensions not found in header"; return out
    w, h = int(wh[0]), int(wh[1])
    out.update({
        "w": w, "h": h, "dim": "%dx%d" % (w, h),
        "mp": round(w * h / 1_000_000, 1),
        "ar": _aspect(w, h),
        "orient": "sq" if w == h else ("land" if w > h else "port"),
    })
    return out

def probe(path):
    try:
        st = os.stat(path)
    except OSError as e:
        return {"error": str(e)}
    base = {"size": st.st_size, "mtime": int(st.st_mtime)}
    ext = os.path.splitext(path)[1].lower()
    if st.st_size < 4096 and ext not in _IMG_EXT:
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
        elif ext in _IMG_EXT or ext in (".avif", ".heic", ".heif"):
                                                   base.update(_image(path, ext))
        else:                                      base["kind"] = ext.lstrip(".") or "file"
    except Exception as e:
        base["kind"] = "unreadable"; base["error"] = str(e)[:120]
    return base


if __name__ == "__main__":
    json.dump({p: probe(p) for p in sys.argv[1:]}, sys.stdout)
