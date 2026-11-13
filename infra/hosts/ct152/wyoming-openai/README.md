# wyoming-openai: AI-Lab speech for Home Assistant (Wyoming bridge)

Lets Home Assistant's **core Wyoming integration** use AI-Lab speech through the universal proxy:
faster-whisper STT (`/api/proxy/stt/v1`) and chatterbox TTS (`/api/proxy/multi-tts/v1`).
Upstream: https://github.com/roryeckel/wyoming_openai (MIT), image pinned to `0.9.0`.

Deployed 2026-11-12 on **CT152** (`/opt/wyoming-openai/docker-compose.yml`, container `ailab-wyoming-openai`,
host network, **tcp/10300**). First consumer: the fifth-wheel HA (10.50.0.144) and the rooted
Echo Dot 3 satellites (echo-dot-assist / hassmic). The fifth wheel reaches CT152 over the home<->trailer
site-to-site route (`infra/hosts/ct110-headscale/README-site-to-site.md`).

**Interim:** the plan is to replace this with local whisper + piper on the Arduino Ventuno Q in the fifth wheel
(no ~77 ms cross-site hop). When that happens, delete the Wyoming entry pointing at 10.0.0.219:10300 in HA.

## Design rules (don't regress these)
- **No backend capacity in this file.** The AI-Lab proxy load-balances across however many chatterbox/whisper
  instances are up. Don't add `TTS_CONCURRENT_REQUESTS` or anything else tied to an instance count (Travis, 2026-11-12).
  The bridge's own default prefetch window (3 sentences per connection) just keeps up to 3 requests in flight
  per connection; it isn't a capacity setting.
- **No hard-coded voice list.** `TTS_BACKEND: KOKORO_FASTAPI` makes the bridge `GET <TTS_OPENAI_URL>/audio/voices`,
  which multi-tts answers in the `{"voices":[{"id":...}]}` envelope. For the TTS client that is the *only* behaviour
  this backend value changes (v0.9.0 `compatibility.py:739`). With `OPENAI` the bridge would advertise OpenAI's
  **hard-coded** names (alloy, echo, ...). The README calls this "autodetected", which is misleading.
- **multi-tts, not preset-tts.** multi-tts takes raw voice names. preset-tts takes preset names and silently falls
  back to Shadowheart (HTTP 200) on a miss.
- Voices are read **at container start**. After adding a voice in AI-Lab: `cd /opt/wyoming-openai && docker compose restart`,
  then reload the Wyoming integration in HA so its voice picker refreshes.

## Verified 2026-11-12
- AI-Lab TTS returns **16-bit PCM WAV, mono, 24 kHz**, which the bridge plays directly. Upstream issue #72 (static in
  HA) is about backends that send 32-bit *float* WAV; it doesn't apply here unless a future TTS backend changes format.
  Check with `file out.wav` and look for `Microsoft PCM, 16 bit`.
- Raw Wyoming test from CT181: STT exact transcript in 0.26 s; TTS first audio in ~1.4-1.6 s for a 3.3 s sentence, and
  that audio round-trips through whisper word for word.
- HA: Wyoming entry title `openai` (state loaded) -> `stt.openai`, `tts.openai_streaming` (44 voices discovered).
  Pipeline **"AI-Lab Assist"** (conversation.home_assistant, prefer local intents, STT stt.openai, TTS
  tts.openai_streaming, voice American-Normal-Woman-1, wake word on-device "Alexa"). Only the Dot's
  `select.echo_dot_3_e05ce0_assistant` points at it; HA's global preferred pipeline was left unchanged.
- `assist_satellite.announce` on the Dot -> bridge log showed sentence-chunked streaming synthesis, all 200s.

## Ops
- Logs: `docker logs --tail 50 ailab-wyoming-openai` (per-request transcribe/synthesize lines at INFO).
- Wyoming smoke test (describe/transcribe/synthesize over raw TCP): see the session notes in the
  claude1 memory `project_echo_dot_local_voice`, or point any Wyoming client at `10.0.0.219:10300`.
- The bridge is NOT an AI-Lab-managed service (not in `ai.js`/services); `restart: unless-stopped` brings it back after reboots.
