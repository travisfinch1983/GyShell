#!/usr/bin/env python3
"""imagegen VLM captioner — instructed natural-language captions via the AI-Lab proxy.

WHY THIS EXISTS. The BLIP engine is a 2022-era captioner and its ceiling shows on a
style/material training set: on the red-satin set it produced "a woman in a pink bikini" (there
is a pink floral tube top in frame and BLIP collapsed the two garments) and, on another image,
never mentioned the garment at all. It also cannot really be instructed — its only lever is a
conditional prefix, which it tends to PARROT, turning a visibly wrong caption into an invisibly
wrong one.

This engine sends the image to a real vision model through the AI-Lab proxy with a proper
instruction, so the caption can be steered toward the attributes a LoRA actually needs
(material, how light behaves on it, cut, view) instead of generic scene description.
Measured ~3s/image, so a 90-image set is ~4 minutes.

CLI, sidecar, skip/overwrite/trigger semantics and JSON progress events are DELIBERATELY
identical to blip_caption.py, so the backend job tracking and UI progress need no changes.

🛑 A BAD CAPTION IS WORSE THAN NO CAPTION — it silently poisons a training set. So this never
writes on failure, never writes an empty or suspiciously short caption, and never writes an
error string into a sidecar. Those count as errors and are reported.
"""
import argparse
import base64
import io
import json
import os
import re
import sys
import time
import urllib.error
import urllib.request

IMG_EXT = {".png", ".jpg", ".jpeg", ".webp", ".bmp", ".gif"}

DEFAULT_INSTRUCTION = (
    "You write one-sentence training captions for a LoRA. Lead with the garment's material and "
    "how light behaves on it - its sheen or gloss, any specular highlights, whether it reads "
    "matte or satin, sheer or opaque, and how the fabric folds, gathers or stretches over the "
    "body. Then give its cut and construction: waistband, trim, seams, straps, string sides, "
    "coverage. Then the camera view (front, rear, three-quarter or side) and the pose. End with "
    "the setting in a few words at most. Be specific and factual about what is actually visible, "
    "never guess or invent a colour, and use the same ordinary vocabulary for the garment in "
    "every caption. Reply with the caption itself and nothing else: one flowing sentence, no "
    "preamble, no reasoning, no lists, and do not open with 'The subject', 'The image', 'This "
    "image' or 'A photo of'."
)

# Lead-ins a caption should not start with - same intent as the BLIP engine's filler strip.
LEAD_INS = (
    "there is ", "there are ", "this is ", "this image ", "the image ", "the photo ",
    "a picture of ", "an image of ", "a photo of ", "a photography of ", "image of ",
    "photo of ", "in this image, ", "in this image ", "the picture ", "the subject ",
    "shows ", "showing ", "depicts ", "depicting ",
)

# Text that is the model THINKING rather than captioning. Seen live: "The user wants a single
# flowing sentence caption ... Analysis of the image: - **Material:** Red satin ...". Long, not a
# refusal, and it was written straight into a sidecar. Rejected on sight now.
REASONING_MARKERS = (
    "the user wants", "the user is asking", "analysis of the image", "constraints:",
    "let me ", "i need to ", "i should ", "first, i", "okay, ", "**material:", "**cut",
    "priorit", "one flowing sentence", "training caption", "lora training set",
)

# A model that declines, or emits boilerplate, must not land in a sidecar.
REFUSAL_MARKERS = (
    "i can't", "i cannot", "i'm sorry", "i am sorry", "unable to", "as an ai",
    "i won't", "i will not", "cannot assist", "can't assist", "sorry, ",
)


def log(o):
    sys.stderr.write(json.dumps(o) + "\n")
    sys.stderr.flush()


def list_images(folder):
    return sorted(n for n in os.listdir(folder)
                  if not n.startswith(".") and not n.startswith("_collage")
                  and os.path.splitext(n)[1].lower() in IMG_EXT)


def encode(path, max_side):
    from PIL import Image
    im = Image.open(path).convert("RGB")
    im.thumbnail((max_side, max_side))
    buf = io.BytesIO()
    im.save(buf, format="JPEG", quality=88)
    return base64.b64encode(buf.getvalue()).decode()


def strip_leading_phrase(cap, phrase):
    """Remove the trigger phrase ONLY where it opens the caption.

    🛑 An earlier version removed it anywhere in the sentence and produced grammatically broken
    captions -- "A woman wearing red with a glossy sheen", "Rear view of, the fabric catching
    sunlight". Deleting a noun phrase from mid-sentence strands the verb and article, and a
    mangled caption is a worse training signal than a redundant one. A leading restatement is
    the one case that can be cut without touching the grammar of what follows.

    Matches the phrase however it is separated (underscores, spaces, hyphens), plus a leading
    article and any colour word sitting in front of it.
    """
    words = [w for w in re.split(r"[\s_\-,]+", phrase.strip()) if w]
    if not words:
        return cap
    body = r"[\s_\-]+".join(re.escape(w) for w in words)
    pat = re.compile(
        r"^(?:an?\s+|the\s+)?(?:[a-z]+\s+)?" + body + r"\s*[,:;.\-]*\s*",
        re.I,
    )
    out = pat.sub("", cap, count=1)
    out = out.strip()
    return out or cap   # never return an empty caption


def complete_sentences(cap):
    """Trim a reply that ran out of tokens back to its last COMPLETE sentence.

    A caption cut off mid-thought ("...with a window and furniture", "The sides") is a bad
    training signal that looks exactly like a good one, so it must not survive into a sidecar.
    If the text already ends on sentence punctuation this is a no-op.
    """
    cap = cap.strip()
    if not cap or cap[-1] in ".!?":
        return cap
    cut = max(cap.rfind(". "), cap.rfind("! "), cap.rfind("? "))
    if cut > 0:
        return cap[:cut + 1].strip()
    return ""   # nothing complete — validate() will reject on min-chars


def clean(cap, avoid_phrase):
    # Some builds emit an inline reasoning block even with thinking disabled.
    cap = re.sub(r"<think>.*?</think>", " ", cap, flags=re.S | re.I)
    cap = re.sub(r"^.*?</think>", " ", cap, flags=re.S | re.I)   # unclosed opener
    cap = cap.strip().strip('"').strip()
    cap = re.sub(r"\s+", " ", cap)
    # Strip lead-ins REPEATEDLY: they stack. "This image shows a rear view ..." matched only
    # "this image " under the old break-after-one loop and was written as "Shows a rear view ...".
    for _ in range(4):
        low = cap.lower()
        hit = next((p for p in LEAD_INS if low.startswith(p)), None)
        if not hit:
            break
        cap = cap[len(hit):].lstrip()
    if avoid_phrase:
        cap = strip_leading_phrase(cap, avoid_phrase)
    cap = complete_sentences(cap)
    cap = cap.strip()
    if cap:
        cap = cap[0].upper() + cap[1:] if cap[0].islower() else cap
    return cap


def validate(cap, min_chars):
    """Raise unless this is a usable caption. Shared by the retry loop below."""
    low = cap.lower()
    if any(m in low for m in REFUSAL_MARKERS):
        raise RuntimeError("model declined or returned boilerplate: %r" % cap[:120])
    if any(m in low for m in REASONING_MARKERS):
        raise RuntimeError("model returned REASONING, not a caption: %r" % cap[:140])
    if cap.count("\n") >= 2 or re.search(r"(^|\n)\s*(\d[.)]|[-*\u2022])\s", cap):
        raise RuntimeError("model returned a list/notes, not a caption: %r" % cap[:140])
    if len(cap) < min_chars:
        raise RuntimeError("caption too short (%d chars, min %d): %r"
                           % (len(cap), min_chars, cap))


def call_model(api, model, b64, instruction, max_tokens, timeout, retries):
    body = {
        "model": model,
        "max_tokens": max_tokens,
        "temperature": 0.2,
        # The request-body equivalent of /no_think. AI-Lab sets exactly this for its own vision
        # role; without it a *-Thinking-* model will sometimes return its reasoning as content.
        "chat_template_kwargs": {"enable_thinking": False},
        "messages": [
            {"role": "system", "content": instruction},
            {"role": "user", "content": [
                # /no_think is the in-prompt equivalent these Qwen builds honour. The body flag
                # is kept too: on red-2 the flag ALONE did not stop the model returning
                # its reasoning, so both mechanisms are used.
                {"type": "text", "text": "Caption this image. /no_think"},
                {"type": "image_url", "image_url": {"url": "data:image/jpeg;base64," + b64}},
            ]},
        ],
    }
    last = None
    for attempt in range(retries + 1):
        try:
            req = urllib.request.Request(
                api, data=json.dumps(body).encode(),
                headers={"Content-Type": "application/json"})
            with urllib.request.urlopen(req, timeout=timeout) as r:
                d = json.loads(r.read())
            return d["choices"][0]["message"]["content"]
        except Exception as e:  # transient proxy/model hiccups are common; a caption is worth a retry
            last = e
            if attempt < retries:
                time.sleep(1.5 * (attempt + 1))
    raise last


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--folder", required=True)
    ap.add_argument("--api", default=os.environ.get(
        "AILAB_PROXY_API", "http://10.0.0.219:17890/api/proxy/llm/v1/chat/completions"))
    ap.add_argument("--model", default="Qwen3.5-9B-INT8-MM-Thinking-Non_preserved-256k")
    ap.add_argument("--instruction", default="")
    ap.add_argument("--context", default="")       # domain hint: what this SET is
    ap.add_argument("--avoid", default="")         # phrase to keep out of the body (default: trigger)
    ap.add_argument("--max-side", type=int, default=768)
    # Raised from 220: at 220 the model was being cut off mid-sentence on the longer, more
    # detailed captions the material-first instruction produces.
    ap.add_argument("--max-new-tokens", type=int, default=340)
    ap.add_argument("--min-chars", type=int, default=40)
    ap.add_argument("--timeout", type=int, default=180)
    ap.add_argument("--retries", type=int, default=2)
    ap.add_argument("--trigger", default="")
    ap.add_argument("--overwrite", action="store_true")
    ap.add_argument("--caption-ext", default="caption")
    ap.add_argument("--json", action="store_true")
    a = ap.parse_args()

    instruction = a.instruction.strip() or DEFAULT_INSTRUCTION
    if a.context.strip():
        # Context goes IN so the model knows what it is looking at; the trigger phrase is kept
        # OUT of the output so it is not said twice (it is prepended separately).
        instruction = (
            "Context for this image set: %s\n\n%s" % (a.context.strip(), instruction)
        )
    avoid = (a.avoid or a.trigger or "").strip().rstrip(",")
    if avoid:
        instruction += (
            "\n\nDo NOT include the phrase \"%s\" (or an underscored/hyphenated form of it) in "
            "your caption — it is added separately. Describe the subject with ordinary words "
            "instead." % avoid.replace("_", " ")
        )

    imgs = list_images(a.folder)
    total = len(imgs)
    log({"event": "start", "total": total, "engine": "vlm", "device": "proxy",
         "provider": a.model, "model": a.model})

    done = wrote = skipped = errs = 0
    for nm in imgs:
        done += 1
        stem = os.path.splitext(nm)[0]
        txt = os.path.join(a.folder, stem + "." + a.caption_ext)
        if os.path.exists(txt) and not a.overwrite:
            skipped += 1
            if a.json:
                log({"event": "img", "done": done, "total": total, "file": nm, "status": "skip"})
            continue
        try:
            b64 = encode(os.path.join(a.folder, nm), a.max_side)
            # A reasoning-shaped reply is RETRYABLE: at temperature 0.2 a resample usually lands
            # on a real caption, and a retried image beats a gap the user fills by hand. Only
            # after the retries are exhausted is it an error — and it stays an error, never a
            # written sidecar.
            cap, last_err = None, None
            for attempt in range(a.retries + 1):
                raw = call_model(a.api, a.model, b64, instruction,
                                 a.max_new_tokens, a.timeout, 1)
                candidate = clean(raw, avoid)
                try:
                    validate(candidate, a.min_chars)
                    cap = candidate
                    break
                except RuntimeError as ve:
                    last_err = ve
                    if a.json and attempt < a.retries:
                        log({"event": "retry", "file": nm, "attempt": attempt + 1,
                             "reason": str(ve)[:120]})
            if cap is None:
                raise last_err

            if a.trigger:
                cap = "%s, %s" % (a.trigger.strip().rstrip(","), cap)
            with open(txt, "w") as f:
                f.write(cap)
            try:
                os.chmod(txt, 0o664)
            except Exception:
                pass
            wrote += 1
            if a.json:
                log({"event": "img", "done": done, "total": total, "file": nm,
                     "status": "ok", "chars": len(cap)})
        except Exception as e:
            errs += 1
            # No sidecar is written. An unwritten caption is visible as an error; a wrong one
            # would sit in the training set looking exactly like a good one.
            log({"event": "img", "done": done, "total": total, "file": nm,
                 "status": "error", "error": str(e)[:200]})

    log({"event": "done", "total": total, "wrote": wrote, "skipped": skipped, "errors": errs})
    print(json.dumps({"ok": True, "total": total, "wrote": wrote,
                      "skipped": skipped, "errors": errs}))


if __name__ == "__main__":
    main()
