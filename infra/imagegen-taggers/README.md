# imagegen caption engines

Deployed to the tagger host (CT176 / ai-epyc, 10.0.0.234) at `/opt/imagegen-tagger/`, which is
NOT version controlled — this directory is the tracked copy. Dispatched over SSH by
`packages/backend/src/services/Cluster/proxy/llm/routes/imagegen.js`.

| engine | script | sidecar | notes |
|---|---|---|---|
| `onnx` | `tagger.py` | `.txt` | WD / JoyTag booru tags |
| `blip` | `blip_caption.py` | `.caption` | BLIP-large, local, fast, NOT steerable |
| `vlm` | `vlm_caption.py` | `.caption` | Qwen3.5-9B-MM via the AI-Lab proxy, instructable |

## Deploying a change
    scp infra/imagegen-taggers/vlm_caption.py root@10.0.0.234:/opt/imagegen-tagger/
No service restart — imagegen.js invokes the script per job.

## Why the vlm engine exists
BLIP tops out on a style/material set: on the red-satin set it returned "a woman in a pink
bikini" (a pink tube top was in frame and it collapsed the two garments) and on another image
never mentioned the garment at all. Its only steering lever is a conditional prefix, which it
parrots — turning a visibly wrong caption into an invisibly wrong one. ~3s/image, so a 90-image
set is ~4 min.

## Things that bite (all found live, 2026-09-01)
* The model is a \*-Thinking-\* build. It returns its chain of thought as content unless BOTH
  `{"chat_template_kwargs":{"enable_thinking":false}}` and an in-prompt `/no_think` are used —
  the body flag alone was NOT enough.
* **A numbered-list instruction induces list-shaped reasoning.** Writing the priorities as
  "1. ... 2. ..." made one image reliably reply with its working ("I need to follow a specific
  priority order: 1. **Material & Light:** ..."). The same priorities as PROSE fixed it.
* Lead-ins stack: "This image shows ..." needs repeated stripping, not one pass.
* Replies get cut off at the token cap; anything not ending on sentence punctuation is trimmed
  back to the last complete sentence rather than written mid-thought.
* Nothing is ever written on failure. A wrong caption sits in a training set looking exactly
  like a good one.
