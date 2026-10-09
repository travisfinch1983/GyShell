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
import concurrent.futures
import threading
import io
import json
import os
import re
import sys
import time
import urllib.error
import urllib.request

IMG_EXT = {".png", ".jpg", ".jpeg", ".webp", ".bmp", ".gif"}

# ── The permanent half. Always sent, for every set, whatever the subject is. ────────────
# This is about HOW to caption, not WHAT the subject is: consistency of vocabulary, only what
# is visible, describe what VARIES across the set (that is what the model learns to control),
# and no preamble. Subject-specific direction arrives through the composed fields below.
# Split into HEAD + PERSON clause + TAIL (2026-10-08) so "describe the person" can be a per-set choice.
# Garment-set finding (training_batch_solid_colors, Qwen-2.1 LoRA): with the person never described, the
# recurring models' faces/poses were absorbed into the trigger, and co-occurring clothing that was only
# SOMETIMES named (tops 33x, jackets 0x across 280 captions) came back as unrequested tops and jackets.
DISCIPLINE_HEAD = (
    "You write training captions for a LoRA image dataset: exactly ONE flowing, factual "
    "sentence per image \u2014 never a list, numbered items, bullet points, or multiple sentences. "
    "Describe only what is clearly visible; never guess or invent a colour, material, size, or "
    "detail. Write the varying elements as a single sentence of comma-separated clauses in this "
    "fixed order: camera view (front, rear, three-quarter or side), pose, then the clothing (its "
    "cut, colour and fabric), and a few words of setting \u2014 no sub-lists, aiming for roughly "
    "25-40 words (hard cap ~50). Name EVERY garment and accessory in the frame, not only the "
    "focal one \u2014 tops, bras, shirts, jackets, skirts, shorts, jeans, stockings, socks, "
    "garters, belts, shoes and jewellery \u2014 each separately with its type, colour and fabric, "
    "in every caption: anything worn but left unnamed is learned as part of the trigger. Never "
    "collapse items to a category word like 'lingerie', 'undergarments' or 'outfit', and never "
    "drop the fabric/cut detail when you name one. "
    "Vocabulary consistency across the whole set matters MORE than "
    "per-image precision: when unsure between a plain word already used in the set and a unique "
    "word for one image, use the plain word, and never reword for variety. Keep it clinical and "
    "literal, never suggestive or evaluative. "
)
# Default for bulge sets: the ban also closes a size-word back door ("muscular", "large") there.
PERSON_OFF = (
    "Describe ONLY these things: the camera view, the pose, each garment and accessory named by "
    "type, colour and fabric, the focal subject exactly as the naming rule specifies, and the "
    "setting. Describe NOTHING else about the person \u2014 no hair, face, body build, skin, "
    "nudity level, or marking such as a tattoo, piercing, scar or birthmark. These are not "
    "control axes and describing them overfits the LoRA to the training subjects. "
)
# Garment sets: naming the recurring people keeps them OUT of the trigger.
PERSON_BRIEF = (
    "Describe ONLY these things: the camera view, the pose, the person in ONE short neutral clause "
    "placed right after the pose \u2014 apparent gender plus hair colour and length only, e.g. "
    "'woman with long brown hair' \u2014 each garment and accessory named by type, colour and "
    "fabric, the focal subject exactly as the naming rule specifies, and the setting. Say NOTHING "
    "else about the person \u2014 no face, expression, body build, skin, size, nudity level, or "
    "marking such as a tattoo, piercing, scar or birthmark. The person clause exists so that the "
    "recurring models are described rather than absorbed into the trigger. "
)
DISCIPLINE_TAIL = (
    "Do not judge or re-name the core subject the trigger word already names, and never open "
    "with a phrase that describes the picture rather than its contents (e.g. 'The image', 'The "
    "subject', 'A photo of')."
)
PERSON_CLAUSES = {"off": PERSON_OFF, "brief": PERSON_BRIEF}


def default_discipline(person="off"):
    """The base prompt for a describe-person mode. `off` reproduces the original discipline."""
    return DISCIPLINE_HEAD + PERSON_CLAUSES.get((person or "off").strip().lower(), PERSON_OFF) + DISCIPLINE_TAIL


UNIVERSAL_DISCIPLINE = default_discipline("off")

# Split OUT of the discipline so it can be the LAST thing the model reads. A few-shot exemplar
# wants recency to work, and the composed subject fields sit between the two -- so the output
# rule has to be appended after them rather than living at the tail of the discipline string.
# Split in two. "No preamble, no reasoning" is right for ANY captioning job — nobody wants
# "Sure! Here's a caption:" in a sidecar. The SINGLE-SENTENCE constraint is LoRA-specific and
# actively wrong for other uses: a posing reference wants structure, not one packed sentence.
# Forcing both unconditionally is why a custom --instruction still produced LoRA-shaped output.
OUTPUT_RULE = "Output the single sentence only \u2014 no preamble, no reasoning."
OUTPUT_RULE_FREE = "Output the caption only \u2014 no preamble, no reasoning."

# The old garment-specific skeleton, kept as an OPT-IN preset (--preset garment). It is a fine
# instruction for a fabric set and a bad one for everything else; it stopped being the default
# because it could not be turned off from the UI.
GARMENT_PRESET = (
    "Lead with the garment's material and how light behaves on it - its sheen or gloss, any "
    "specular highlights, whether it reads matte or satin, sheer or opaque, and how the fabric "
    "folds, gathers or stretches over the body. Then give its cut and construction: waistband, "
    "trim, seams, straps, string sides, coverage."
)

PRESETS = {"garment": GARMENT_PRESET}


def compose_instruction(a):
    """UNIVERSAL_DISCIPLINE + the subject fields, in the order a reader would want them.

    An explicit --instruction still replaces the discipline outright: it is the escape hatch
    for a set that needs something this composition cannot express.
    """
    # An explicit --instruction means the caller owns the prompt. The LoRA-shaped tails below
    # (size suppression, single-sentence) are then NOT appended: leaving them on is what made
    # "caption these as posing references" still come back as one-sentence training captions.
    free = bool(a.instruction.strip())
    if free:
        base = a.instruction.strip()
    else:
        # --discipline replaces ONLY the base prompt (edited in the UI); the subject fields, size
        # rule, example and output rule below still compose on top of it. It wins over
        # --describe-person, because the person clause is part of the text the user edited.
        base = a.discipline.strip() or default_discipline(a.describe_person)
        preset = PRESETS.get((a.preset or "").strip().lower())
        if preset:
            base += " " + preset
    parts = [base]

    def sentence(text):
        """Append a full stop only if the caller did not already end one — otherwise a field
        typed as a complete sentence comes out with '..' on the end."""
        t = text.strip()
        return t if t.endswith((".", "!", "?")) else t + "."

    if a.context.strip():
        parts.append("This image set is: %s" % sentence(a.context))
    if a.naming.strip():
        # 🛑 WRAP IT IN A RULE. This used to append the field's raw text, which works only if
        # the caller types a full sentence ("always call X the bulge"). The field is labelled
        # "Consistent Naming Convention", so what people actually type is a NOUN PHRASE —
        # "teal smiley print satin string bikini panties" — and a dangling noun phrase in a
        # system prompt reads as a hint, not an instruction. Observed 2026-09-17: the model
        # paraphrased it as "teal string-side satin panties", and the enforcement sentence had
        # to be hand-written into the context box on every run. That sentence is now here.
        # Drifting between synonyms is what makes a trigger token unlearnable, so this is the
        # one field where obedience matters more than fluency.
        parts.append(
            'NAMING RULE - MANDATORY AND VERBATIM. Refer to the subject as "%s" - exactly '
            'those words, in that order, in EVERY caption. Do not substitute synonyms, '
            'reorder, shorten, expand, or vary the wording for the sake of variety, not even '
            'once. Inconsistent naming across a caption set makes the token unlearnable and '
            'defeats the purpose of the set. If a caption reads repetitively as a result, '
            'that is correct and intended - repeat it anyway.' % a.naming.strip()
        )
    # Size is MODE-driven, and the universal text above is deliberately size-NEUTRAL so the two
    # cannot contradict each other: it forbids guessing a size (true in both modes) and says
    # nothing about whether one may be stated. Default omit, because the model is measurably
    # unreliable here — on the "huge" set it wrote "large" 21x and "huge" once — so for these
    # sets size is carried by the token and stamped with find & replace. `state` exists for a
    # LoRA that genuinely needs the word in the prose.
    mode = (a.size_mode or "omit").strip().lower()
    if mode == "state" and a.size_word.strip():
        parts.append("Every image here is %s; if you refer to size, say '%s' and nothing else."
                     % (a.size_word.strip(), a.size_word.strip()))
    elif not free:
        # Only suppress size for the LoRA path. Under a custom instruction the caller may well
        # WANT size described, and an unconditional "do not mention size" quietly overrides them.
        parts.append("Do not mention or estimate size; it is labelled separately.")
    if a.emphasize.strip():
        parts.append("Priority for this set: %s" % sentence(a.emphasize))
    # Few-shot exemplar LAST but one. A model imitates a concrete example far better than it
    # obeys a rule, so this is the strongest lever available and it is placed where recency
    # helps it. 🛑 The example must NOT carry the trigger prefix: the trigger is prepended
    # separately, and an exemplar showing it would teach the model to write it twice.
    if a.example.strip():
        parts.append('Follow the EXACT format of this example: "%s"' % a.example.strip())
    parts.append(OUTPUT_RULE_FREE if free else OUTPUT_RULE)
    return "\n\n".join(parts)


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


_LOG_LOCK = threading.Lock()


def log(o):
    # Serialised because --concurrency > 1 has several workers logging progress, and the
    # BACKEND PARSES these lines. Two interleaved writes are not a cosmetic problem: they
    # produce a line that is not valid JSON, which the caller reads as a failed job.
    with _LOG_LOCK:
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


def complete_sentences(cap, truncated=True):
    """Trim a reply that ran out of tokens back to its last COMPLETE sentence.

    A caption cut off mid-thought ("...with a window and furniture", "The sides") is a bad
    training signal that looks exactly like a good one, so it must not survive into a sidecar.
    If the text already ends on sentence punctuation this is a no-op.

    🛑 `truncated` MATTERS AND MUST BE PASSED HONESTLY. This used to return "" for ANY caption
    with no terminal punctuation, on the assumption that such a caption was cut short. That is
    true of prose; it is false of a TERSE caption, which legitimately ends without a full stop:
    "low angle, rear view, bent over, legs apart" is complete and correct and was being thrown
    away. The effect was a silent SELECTION BIAS, not a visible error — terse pose captions were
    discarded and retried while verbose narrative ones survived purely because a model writing a
    full sentence ends it with a period. The folder filled with exactly the captions the
    instruction forbade, and the ones that obeyed it never reached disk.
    So: only salvage-trim when the reply was ACTUALLY cut off. Otherwise take it as written.
    """
    cap = cap.strip()
    if not cap or cap[-1] in ".!?":
        return cap
    if not truncated:
        return cap          # complete reply that simply is not a sentence — keep it verbatim
    cut = max(cap.rfind(". "), cap.rfind("! "), cap.rfind("? "))
    if cut > 0:
        return cap[:cut + 1].strip()
    return ""   # genuinely truncated with nothing complete — validate() rejects on min-chars


def clean(cap, avoid_phrase, truncated=False):
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
    cap = complete_sentences(cap, truncated)
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


def call_model(api, model, b64, instruction, max_tokens, timeout, retries,
               reasoning=""):
    """Returns (content, truncated). `truncated` is the caller's only honest way to tell
    whether a caption lacking a full stop was CUT SHORT or simply written tersely."""
    body = {
        "model": model,
        "max_tokens": max_tokens,
        "temperature": 0.2,
        # The request-body equivalent of /no_think. AI-Lab sets exactly this for its own vision
        # role; without it a *-Thinking-* model will sometimes return its reasoning as content.
        # enable_thinking IS A QWEN CHAT-TEMPLATE KWARG. It is silently ignored by every other
        # family - notably DeepSeek, which then reasons at full length. The reply either
        # exceeds --timeout or arrives as reasoning prose that REASONING_MARKERS rejects, and
        # either way the sidecar is left BLANK. That was the intermittent blank-caption bug
        # (2026-09-17); the mechanism had been doing nothing on DeepSeek all along.
        # reasoning_effort is the runtime lever those models DO honour, so both are sent -
        # each is ignored by the family that does not use it.
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
    # DeepSeek-style control. `thinking` is the field that actually turns reasoning OFF —
    # reasoning_effort alone only sets a LEVEL, so sending it without the companion object
    # leaves thinking on and does not fix the blank-caption case it was added for.
    if reasoning == "off":
        body["thinking"] = {"type": "disabled"}
    elif reasoning:
        body["thinking"] = {"type": "enabled"}
        body["reasoning_effort"] = reasoning
    last = None
    budget = max_tokens
    # +2: budget escalations need their own attempts on top of the transient-error retries.
    for attempt in range(retries + 3):
        body["max_tokens"] = budget
        try:
            req = urllib.request.Request(
                api, data=json.dumps(body).encode(),
                headers={"Content-Type": "application/json"})
            with urllib.request.urlopen(req, timeout=timeout) as r:
                d = json.loads(r.read())
            ch = d["choices"][0]
            m = ch["message"]
            content = (m.get("content") or "").strip()
            reasoning = m.get("reasoning_content") or m.get("reasoning") or ""
            truncated = ch.get("finish_reason") == "length"
            # 🛑 A TRUNCATED REPLY IS NOT A CAPTION. This used to accept any length-cut content
            # of 60+ chars, which is trivially met by a verbose FIRST DRAFT cut mid-sentence —
            # measured as captions like "...red fabric thigh-high stockings and black high-heeled
            # shoes, again", where ", again" IS the cut. The instruction had been obeyed on the
            # retry; what leaked through was the unrefined draft from the attempt before it.
            # So while escalations remain, a truncation is a reason to RETRY, not to accept.
            # Only once the budget is exhausted do we fall back to salvaging what came back.
            if content and not truncated:
                return content, False
            if content and truncated and budget >= 4096:
                # Ceiling reached: a trimmed partial beats nothing, and complete_sentences()
                # cuts it back to the last whole sentence downstream.
                return content, True
            if reasoning or ch.get("finish_reason") == "length":
                # Reasoning models burn the budget THINKING and the caption never arrives:
                # measured on (DS) deepseek-v4-flash-vision-exp — 98 of 100 completion tokens
                # went to reasoning_content, content='This', finish_reason=length. That is why
                # a 235-image folder captioned only a handful (2026-09-02). /no_think and
                # chat_template_kwargs are Qwen dialects other providers ignore; MORE BUDGET
                # is the fix that works for every model. Escalate and re-ask.
                budget = min(budget * 4, 4096)
                last = RuntimeError(
                    "reasoning consumed the token budget (finish=%s, %d reasoning chars, "
                    "content=%r) — retried at max_tokens=%d"
                    % (ch.get("finish_reason"), len(reasoning), content[:40], budget))
                continue
            return content, False   # empty with no reasoning: surface to validate()
        except Exception as e:  # transient proxy/model hiccups are common; a caption is worth a retry
            last = e
            if attempt < retries + 2:
                time.sleep(1.5 * (attempt + 1))
    raise last


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--folder", default="")     # required unless --print-default
    ap.add_argument("--describe-person", default="off", choices=["off", "brief"])
    ap.add_argument("--discipline", default="")   # replaces only the base prompt (see compose_instruction)
    ap.add_argument("--print-default", action="store_true")  # JSON of the default prompt parts, then exit
    ap.add_argument("--api", default=os.environ.get(
        "AILAB_PROXY_API", "http://10.0.0.219:17890/api/proxy/llm/v1/chat/completions"))
    ap.add_argument("--model", default="Qwen3.5-9B-INT8-MM-Thinking-Non_preserved-256k")
    ap.add_argument("--instruction", default="")
    ap.add_argument("--context", default="")       # domain hint: what this SET is
    ap.add_argument("--naming", default="")        # verbatim vocabulary rule, e.g. always call X "the bulge"
    ap.add_argument("--size-mode", default="omit", choices=["omit", "state"])
    ap.add_argument("--size-word", default="")     # only meaningful with --size-mode state
    ap.add_argument("--emphasize", default="")     # extra things to make sure are described
    ap.add_argument("--example", default="")       # one literal caption showing the exact format
    ap.add_argument("--preset", default="")        # optional subject skeleton, e.g. "garment"
    ap.add_argument("--avoid", default="")         # phrase to keep out of the body (default: trigger)
    ap.add_argument("--max-side", type=int, default=768)
    # Raised from 220: at 220 the model was being cut off mid-sentence on the longer, more
    # detailed captions the material-first instruction produces.
    # 340 was sized for a one-sentence caption from a NON-reasoning model. Measured against
    # (OR) deepseek/deepseek-v4-flash-vision-exp on 2026-09-11: at 340 the model spent the whole
    # budget in reasoning_content and returned EMPTY content for 7 of 8 images (the eighth: "low").
    # Completion tokens for a successful pose caption ranged 100-1503 on the same 8 images, so the
    # first attempt needs room for a model that thinks. A generous ceiling costs nothing on a
    # non-reasoning model, which stops at EOS regardless.
    ap.add_argument("--max-new-tokens", type=int, default=1600)
    ap.add_argument("--min-chars", type=int, default=40)
    ap.add_argument("--timeout", type=int, default=180)
    ap.add_argument("--retries", type=int, default=2)
    ap.add_argument("--trigger", default="")
    ap.add_argument("--overwrite", action="store_true")
    ap.add_argument("--files", default="")   # comma-separated names within --folder; empty = whole folder
    ap.add_argument("--caption-ext", default="caption")
    ap.add_argument("--json", action="store_true")
    # Runtime reasoning control for families that honour it (DeepSeek et al).
    #   off              -> {"thinking": {"type": "disabled"}}          <- what captioning wants
    #   none|low|high|max-> {"thinking": {"type": "enabled"}} + reasoning_effort
    #   ""               -> send NEITHER field; the provider's own default applies
    # Empty is the honest default: guessing here means sending a value some providers reject.
    ap.add_argument("--reasoning", default="",
                    choices=["", "off", "none", "low", "high", "max"])
    # 1 = the old strictly-sequential behaviour, kept as a real option: a LOCAL model serving
    # one stream can be slower, not faster, under parallel load. API models are stateless and
    # benefit; the caller decides which it is talking to.
    ap.add_argument("--concurrency", type=int, default=1)
    a = ap.parse_args()
    if a.print_default:
        # For the AI-Lab UI: what the default base prompt says in each describe-person mode, plus the
        # fixed output rule that always ends the composed prompt. Nothing is captioned.
        print(json.dumps({"discipline": {m: default_discipline(m) for m in PERSON_CLAUSES},
                          "output_rule": OUTPUT_RULE, "output_rule_free": OUTPUT_RULE_FREE,
                          "composed_after": ["context", "naming rule", "size rule", "priority",
                                             "format example", "output rule"]}))
        return
    if not a.folder:
        ap.error("--folder is required")

    # Context used to be PREPENDED to a garment-shaped default, which meant the skeleton could
    # not be replaced from the UI however the box was filled in. Now the shape is composed.
    instruction = compose_instruction(a)
    avoid = (a.avoid or a.trigger or "").strip().rstrip(",")
    # A trigger that is a real phrase ("satin_string_bikini_panties") can also be what the naming
    # rule REQUIRES in the prose ("always call it '<colour> satin string bikini panties'"). Telling
    # the model to avoid it then fights the naming rule and it compromises on "red satin panties"
    # (7/7 captions, 2026-10-09). So when the naming rule contains the trigger's words, the naming
    # rule wins: no avoid sentence and no leading-phrase strip. An explicit --avoid still applies.
    def _norm(t):
        return " ".join(re.findall(r"[a-z0-9]+", t.lower()))
    if avoid and not a.avoid and a.naming.strip() and _norm(a.trigger) and \
            (" %s " % _norm(a.trigger)) in (" %s " % _norm(a.naming)):
        print("avoid rule skipped: the naming rule uses the trigger words %r" % _norm(a.trigger), flush=True)
        avoid = ""
    if avoid:
        instruction += (
            "\n\nDo NOT include the phrase \"%s\" (or an underscored/hyphenated form of it) in "
            "your caption — it is added separately. Describe the subject with ordinary words "
            "instead." % avoid.replace("_", " ")
        )

    imgs = list_images(a.folder)
    if a.files:
        _want = {n.strip() for n in a.files.split(",") if n.strip()}
        imgs = [n for n in imgs if n in _want]
    total = len(imgs)
    log({"event": "start", "total": total, "engine": "vlm", "device": "proxy",
         "pid": os.getpid(),
         "provider": a.model, "model": a.model})

    done = wrote = skipped = errs = 0
    _stat_lock = threading.Lock()

    def process_one(nm):
        """Caption ONE image. Never raises — every outcome is counted and logged.

        Extracted from the loop so SEQUENTIAL AND CONCURRENT RUN THE SAME CODE. Two copies
        of this body would drift, and the divergence would show up as captions that differ
        by which mode produced them — the hardest kind of difference to notice in a dataset.
        """
        nonlocal done, wrote, skipped, errs
        stem = os.path.splitext(nm)[0]
        txt = os.path.join(a.folder, stem + "." + a.caption_ext)
        if os.path.exists(txt) and not a.overwrite:
            with _stat_lock:
                done += 1; skipped += 1; d = done
            if a.json:
                log({"event": "img", "done": d, "total": total, "file": nm, "status": "skip"})
            return
        try:
            b64 = encode(os.path.join(a.folder, nm), a.max_side)
            # A reasoning-shaped reply is RETRYABLE: at temperature 0.2 a resample usually
            # lands on a real caption, and a retried image beats a gap the user fills by hand.
            # Only after the retries are exhausted is it an error — and it stays an error,
            # never a written sidecar.
            cap, last_err = None, None
            for attempt in range(a.retries + 1):
                raw, was_cut = call_model(a.api, a.model, b64, instruction,
                                          a.max_new_tokens, a.timeout, 1,
                                          a.reasoning)
                candidate = clean(raw, avoid, was_cut)
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
            with _stat_lock:
                done += 1; wrote += 1; d = done
            if a.json:
                log({"event": "img", "done": d, "total": total, "file": nm,
                     "status": "ok", "chars": len(cap)})
        except Exception as e:
            with _stat_lock:
                done += 1; errs += 1; d = done
            # No sidecar is written. An unwritten caption is visible as an error; a wrong one
            # would sit in the training set looking exactly like a good one.
            log({"event": "img", "done": d, "total": total, "file": nm,
                 "status": "error", "error": str(e)[:200]})

    # Bounded above so a mistyped setting cannot open 500 sockets at a shared proxy. `done` is
    # a COMPLETION counter under a lock, not a position, so progress stays monotonic and
    # correct out of order.
    workers = max(1, min(int(a.concurrency or 1), 16))
    if workers > 1 and len(imgs) > 1:
        log({"event": "mode", "concurrency": workers})
        with concurrent.futures.ThreadPoolExecutor(max_workers=workers) as ex:
            list(ex.map(process_one, imgs))
    else:
        for nm in imgs:
            process_one(nm)

    log({"event": "done", "total": total, "wrote": wrote, "skipped": skipped, "errors": errs})
    print(json.dumps({"ok": True, "total": total, "wrote": wrote,
                      "skipped": skipped, "errors": errs}))


if __name__ == "__main__":
    main()
