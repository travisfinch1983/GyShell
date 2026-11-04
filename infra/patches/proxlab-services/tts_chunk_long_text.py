#!/usr/bin/env python3
"""Make proxlab-tts synthesize long input in sentence chunks.

Usage: tts_chunk_long_text.py <server.py or provider script containing it>

Chatterbox loses coherence past roughly 30 s of speech in one generate() call.
Measured through /preset-tts with Optimus-Prime (2026-11-04), words recovered by STT:
536 chars 99%, 802 chars 68%, 982 chars 33%, 1961 chars 1%. HTTP 200 throughout.
Idempotent: a file that already has split_for_tts is left alone.
"""
import sys

HELPERS = '''# Chatterbox loses coherence past roughly 30 s of speech in one generate() call: 536 chars
# was clean, 982 was mostly gibberish, 1961 was noise, all as HTTP 200. Keep each call well
# inside that and join the audio.
MAX_CHUNK_CHARS = 350
CHUNK_GAP_MS = 180


def split_for_tts(text: str, limit: int = MAX_CHUNK_CHARS) -> list[str]:
    """Split text into chunks of at most about `limit` chars, on sentence boundaries."""
    units = []
    for line in text.splitlines():
        line = line.strip()
        if not line:
            continue
        if line[-1].isalnum():
            line += "."  # headings and list items need a stop or the next line runs on
        for sentence in re.split(r"(?:(?<=[.!?\\u2026])|(?<=[.!?\\u2026][\\"'\\u201d\\u2019)\\]]))\\s+", line):
            if len(sentence) <= limit:
                units.append(sentence)
                continue
            current = ""
            for word in re.split(r"(?<=[,;:])\\s+|\\s+", sentence):
                while len(word) > limit:
                    if current:
                        units.append(current)
                        current = ""
                    units.append(word[:limit])
                    word = word[limit:]
                if current and len(current) + 1 + len(word) > limit:
                    units.append(current)
                    current = word
                else:
                    current = f"{current} {word}".strip()
            if current:
                units.append(current)

    chunks = []
    for unit in units:
        if chunks and len(chunks[-1]) + 1 + len(unit) <= limit:
            chunks[-1] += " " + unit
        else:
            chunks.append(unit)
    # A very short last chunk tends to come out badly, so let it ride on the previous one.
    if len(chunks) > 1 and len(chunks[-1]) < 40:
        chunks[-2] += " " + chunks.pop()
    return chunks


'''

OLD_HEAD = '''    def _generate():
        load_tts(resolved)
        if loaded_model == "chatterbox-turbo":
            wav_tensor = tts_engine.generate(
                text=req.input,
'''
NEW_HEAD = '''    def _synth_chunk(text):
        if loaded_model == "chatterbox-turbo":
            wav_tensor = tts_engine.generate(
                text=text,
'''
OLD_ORIG = '''            wav_tensor = tts_engine.generate(
                text=req.input,
                audio_prompt_path=ref_wav,
                exaggeration=req.exaggeration,
'''
NEW_ORIG = '''            wav_tensor = tts_engine.generate(
                text=text,
                audio_prompt_path=ref_wav,
                exaggeration=req.exaggeration,
'''
OLD_TAIL = '''        wav_data = wav_tensor.squeeze(0).cpu().numpy()
        sample_rate = tts_engine.sr
        return convert_audio(wav_data, sample_rate, req.response_format)
'''
NEW_TAIL = '''        return wav_tensor

    def _generate():
        load_tts(resolved)
        chunks = split_for_tts(req.input)
        if not chunks:
            raise HTTPException(400, "Input text is empty")
        parts = []
        for i, chunk in enumerate(chunks):
            part = _synth_chunk(chunk)
            if i:
                gap = int(tts_engine.sr * CHUNK_GAP_MS / 1000)
                parts.append(torch.zeros(*part.shape[:-1], gap, dtype=part.dtype, device=part.device))
            parts.append(part)
        wav_tensor = torch.cat(parts, dim=-1)
        if len(chunks) > 1:
            print(f"Synthesized {len(req.input)} chars as {len(chunks)} chunks, {wav_tensor.shape[-1]/tts_engine.sr:.1f}s")
        wav_data = wav_tensor.squeeze(0).cpu().numpy()
        sample_rate = tts_engine.sr
        return convert_audio(wav_data, sample_rate, req.response_format)
'''
ANCHOR = 'app = FastAPI(title='  # the title differs between the live file and the provider script

path = sys.argv[1]
src = open(path).read()
if "def split_for_tts" in src:
    print(f"{path}: already patched")
    sys.exit(0)
for name, old in (("head", OLD_HEAD), ("orig", OLD_ORIG), ("tail", OLD_TAIL), ("anchor", ANCHOR)):
    if src.count(old) != 1:
        sys.exit(f"{path}: {name} block found {src.count(old)} times, expected 1; nothing written")
src = src.replace(OLD_HEAD, NEW_HEAD).replace(OLD_ORIG, NEW_ORIG).replace(OLD_TAIL, NEW_TAIL)
src = src.replace(ANCHOR, HELPERS + ANCHOR, 1)
open(path, "w").write(src)
print(f"{path}: patched")
