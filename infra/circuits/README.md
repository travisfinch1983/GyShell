# Circuit Designer — Fritzing parts import

`import-fritzing.mjs` turns the [Fritzing parts library](https://github.com/fritzing/fritzing-parts)
(CC-BY-SA 3.0) into read-only Circuit Designer parts in `<dataDir>/circuits/fritzing/<id>.json`
(ids `fz-…`, categories `Fritzing · …`), plus `_report.json` listing every skipped part and why.

Pin positions are measured by laying each breadboard SVG out in headless Chrome and taking the
centre of the connector's `svgId` element, so transforms/viewBoxes/units come out as a browser
renders them. Parts whose connectors can't all be located are skipped rather than imported broken.

## Runtime (CT152)

| what | where |
|---|---|
| Fritzing checkout | `/opt/fritzing-parts` (`git clone --depth 1`; imported rev is in `_report.json`) |
| script deps | `/opt/fritzing-import` (`npm i playwright-core@1.62.1 @xmldom/xmldom`; copy the script there to run it) |
| browser | `~/.cache/ms-playwright/chromium_headless_shell-1248/chrome-headless-shell-linux64/chrome-headless-shell` |

```sh
cd /opt/fritzing-import && cp /opt/ai-lab/infra/circuits/import-fritzing.mjs . \
  && node import-fritzing.mjs --parts /opt/fritzing-parts \
       --out /opt/ai-lab/.gybackend-data/circuits/fritzing \
       --chrome ~/.cache/ms-playwright/chromium_headless_shell-1248/chrome-headless-shell-linux64/chrome-headless-shell
```

It writes `<out>.new` and swaps it in at the end; the backend notices the new `_report.json` and
reloads (no restart). Designs reference parts by id, so ids are kept stable (`fz-<moduleId>`).

Notes:
- Both `core/` and `contrib/` (where the Adafruit parts live) are imported.
- Fritzing has no pin types or ESP32 flags. Types are guessed from pin names; connectors named
  `pin1`/`connector3` take their name from the description (e.g. `22, GPIO1, TXD0` → id `GPIO1`).
- Categories come from Fritzing's bins (`bins/core.fzb` sections, `bins/more/*.fzb` titles);
  parts in no bin are grouped by family/title keywords.
- The backend keeps only metadata + pins in memory (~150 MB of art stays on disk) and serves the
  art via `GET /api/circuits/parts/:id`; the palette list uses `?lite=1`.
