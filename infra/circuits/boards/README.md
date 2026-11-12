# Board parts generator (Travis's own boards)

Builds `packages/backend/src/services/Circuits/circuitBoardParts.ts`: built-in Circuit Designer parts drawn
from vendor mechanical data, not hand-placed.

| Board | Art source | Pin positions | Pinout source |
|---|---|---|---|
| Waveshare ESP32-P4-NANO | DXF top view (line art) | DXF header square centres | schematic P1/P2 + docs.waveshare.com pinout image |
| Waveshare ESP32-P4-WIFI6 | DXF | DXF Ø1.0 pin circles | schematic U10 + pinout image |
| Waveshare ESP32-P4-ETH | PDF dimension drawing (no DXF, only DWG) | PDF Ø1.0 pin circles (drawing is 1:1) | schematic P1 + pinout image |
| Waveshare ESP32-P4-Module-DEV-KIT | DXF | DXF header squares | schematic P6 (its pin numbers are MIRRORED vs the Pi standard — the part uses Pi numbering, verified on the silkscreen photo) |
| Arduino VENTUNO Q | raster crop of the full-pinout PDF board drawing (CC BY-SA) | measured on that vector drawing, snapped to 2.54 mm / RPi HAT / Arduino R3 geometry (`vq.json`) | ABX00181 datasheet §9 |

Inputs live in `/claude/microcontroller_boards/` on CT181 (not in git; vendor files).

Run (needs a venv with `ezdxf pymupdf pillow cairosvg`):

    python boards.py nano wifi6 devkit eth   # -> out/<id>.json/.svg
    python vq_build.py                       # -> out/arduino-ventuno-q.json
    python emit_ts.py <repo>/packages/backend/src/services/Circuits/circuitBoardParts.ts   # keeps its header
    # copy out/circuitBoardParts.ts into the repo, then ailab-restart.

Gotchas:
- pdftoppm's -x/-y crop of the Ventuno pinout PDF came out at the wrong scale; crop with pymupdf (`get_pixmap(clip=…)`).
- Waveshare touch-channel numbering in their images is 0-based; the parts use the Espressif datasheet names (TOUCH_CHANNEL1 = GPIO2).
- Header orientation (which end is pin 1) is NOT in the DXF; it was matched against the silkscreen photo for every board.
