"""Build AI-Lab Circuit Designer PartDefs for Travis's boards from vendor mechanical drawings.
Each board: line art (true scale) + PCB fill + gold pads + colour label tags, pins at the measured hole centres."""
import json, sys, re, html
from p4 import spec
U = 10 / 2.54                       # circuit units per mm
GUT = 30                            # label gutter (units) on sides that carry outside labels
COL = {'power': '#d32f2f', 'ground': '#111111', 'gpio': '#43a047', 'input': '#ec8fa0', 'other': '#8e6e53', 'c6': '#8d5a2b'}

def tag_color(p):
    if p['name'].startswith('C6_'): return COL['c6']
    return COL.get(p['type'], '#607d8b')

def text_w(s, fs): return len(s) * fs * 0.6

def build(cfg, art):
    """cfg: id,name,description,tags,props, board:{w,h,r} (mm, art-local), pcb colour,
       pins: list of dict(name, x_mm, y_mm, side, label: 'out'|'in'), gutters: dict side->bool, art d (units, art-local)."""
    W, H = art['w_mm'] * U, art['h_mm'] * U
    gl, gr, gt, gb = (GUT if cfg['gutters'].get(s) else 0 for s in 'LRTB')
    tw, th = round(W + gl + gr, 1), round(H + gt + gb, 1)
    ox, oy = gl, gt
    out = []
    b = cfg['board']
    out.append(f'<rect x="{ox + b["x"]*U:.1f}" y="{oy + b["y"]*U:.1f}" width="{b["w"]*U:.1f}" height="{b["h"]*U:.1f}" rx="{b.get("r",1)*U:.1f}" fill="{cfg["pcb"]}" stroke="{cfg.get("edge","#9aa4b2")}" stroke-width="0.8"/>')
    for (x, y, w, h, fill) in cfg.get('blocks', []):
        out.append(f'<rect x="{ox + x*U:.1f}" y="{oy + y*U:.1f}" width="{w*U:.1f}" height="{h*U:.1f}" fill="{fill}"/>')
    out.append(f'<path transform="translate({ox} {oy})" d="{art["d"]}" fill="none" stroke="{cfg.get("ink","#c9cdd3")}" stroke-width="0.32" stroke-linecap="round" stroke-linejoin="round"/>')
    for (x, y, s, fs, anchor, rot) in cfg.get('texts', []):
        r = f' transform="rotate({rot} {ox + x*U:.1f} {oy + y*U:.1f})"' if rot else ''
        out.append(f'<text x="{ox + x*U:.1f}" y="{oy + y*U:.1f}" font-size="{fs}" font-family="sans-serif" font-weight="bold" fill="#ffffffd0" text-anchor="{anchor}"{r}>{html.escape(s)}</text>')
    pins, seen = [], {}
    fs = 3.3
    for q in cfg['pins']:
        p = spec(q['name'], q.get('num'))
        if q.get('id'): p['id'] = q['id']
        n = seen.get(p['id'], 0) + 1; seen[p['id']] = n
        if n > 1: p['id'] = f"{p['id']}_{n}"
        x, y = round(ox + q['x_mm'] * U, 2), round(oy + q['y_mm'] * U, 2)
        p.update(x=x, y=y, side=q['side'])
        if q.get('num') is not None: p['notes'] = (f"{q['hdr']} pin {q['num']}. " + p.get('notes', '')).strip()
        for k in ('functions', 'flags', 'notes'):
            if not p.get(k): p.pop(k, None)
        pins.append(p)
        # pad
        out.append(f'<circle cx="{x}" cy="{y}" r="3.1" fill="#d4a017" stroke="#7a5a08" stroke-width="0.5"/><circle cx="{x}" cy="{y}" r="1.3" fill="#1b1b1b"/>')
        # label tag
        lab = p['name']; w = text_w(lab, fs) + 3; h = 5.2
        s = q['side']
        if s in ('L', 'R'):
            tx = x - 5 - w if s == 'L' else x + 5
            out.append(f'<rect x="{tx:.1f}" y="{y - h/2:.1f}" width="{w:.1f}" height="{h}" rx="1.2" fill="{tag_color(p)}" stroke="{'#8a9099' if p['type']=='ground' else '#00000066'}" stroke-width="0.3"/>')
            out.append(f'<text x="{tx + w/2:.1f}" y="{y + fs*0.36:.1f}" font-size="{fs}" font-family="monospace" fill="#fff" text-anchor="middle">{html.escape(lab)}</text>')
        else:
            ty = y - 5 - w if s == 'T' else y + 5
            cx = x
            out.append(f'<rect x="{cx - h/2:.1f}" y="{ty:.1f}" width="{h}" height="{w:.1f}" rx="1.2" fill="{tag_color(p)}" stroke="{'#8a9099' if p['type']=='ground' else '#00000066'}" stroke-width="0.3"/>')
            mx, my = cx + fs*0.36, ty + w/2
            out.append(f'<text x="{mx:.1f}" y="{my:.1f}" font-size="{fs}" font-family="monospace" fill="#fff" text-anchor="middle" transform="rotate(-90 {mx:.1f} {my:.1f})">{html.escape(lab)}</text>')
    svg = f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {tw} {th}" width="{tw}" height="{th}">' + ''.join(out) + '</svg>'
    names = {}
    for p in pins: names.setdefault(p['name'], []).append(p['id'])
    buses = [v for k, v in names.items() if len(v) > 1 and k in ('GND', '3V3', '5V')]
    part = dict(id=cfg['id'], name=cfg['name'], category='Microcontrollers', refPrefix='U', description=cfg['description'],
                tags=cfg['tags'], source='builtin', license=cfg['license'], width=tw, height=th, svg=svg, pins=pins,
                buses=buses, props=cfg.get('props', {}))
    return part

def header_pins(hdr, names, first, step_col, step_row, ncols, sides, layout):
    """names: {num: name}. layout 'dual': pin n -> row (n-1)//2, col (n-1)%2.  'pico': pins 1..N/2 down col0, N/2+1..N up col1.
       first: (x,y) mm of pin1; step_col: (dx,dy) from col0 to col1; step_row: (dx,dy) per row. sides: (side col0, side col1)."""
    out = []; N = len(names)
    for n, nm in names.items():
        if layout == 'dual': r, c = (n - 1) // 2, (n - 1) % 2
        elif layout == 'pico': half = N // 2; (r, c) = (n - 1, 0) if n <= half else (N - n, 1)
        else: r, c = n - 1, 0
        x = first[0] + c * step_col[0] + r * step_row[0]; y = first[1] + c * step_col[1] + r * step_row[1]
        out.append(dict(name=nm, num=n, hdr=hdr, x_mm=round(x, 3), y_mm=round(y, 3), side=sides[c]))
    return out
