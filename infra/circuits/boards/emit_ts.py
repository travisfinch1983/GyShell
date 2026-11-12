"""Concatenate out/*.json into circuitBoardParts.ts (header comment must stay in sync with the repo file)."""
import json, sys
ids = ['waveshare-esp32-p4-nano', 'waveshare-esp32-p4-wifi6', 'waveshare-esp32-p4-eth', 'waveshare-esp32-p4-module-dev-kit', 'arduino-ventuno-q']
hdr = open(sys.argv[1]).read().split('export const BOARD_PARTS')[0] if len(sys.argv) > 1 else "import type { PartDef } from './circuitParts'\n\n"
parts = [json.load(open(f'out/{i}.json')) for i in ids]
open('out/circuitBoardParts.ts', 'w').write(hdr + 'export const BOARD_PARTS: PartDef[] = ' + json.dumps(parts, indent=1, ensure_ascii=False) + '\n')
