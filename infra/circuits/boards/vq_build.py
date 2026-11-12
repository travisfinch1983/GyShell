import json, base64, html
import build as B
d = json.load(open('vq.json'))
U = B.U
img = base64.b64encode(open('out/vq_board.jpg', 'rb').read()).decode()
SIDES = {'JANALOG': ('L',), 'QWIIC': ('L',), 'JDIGITAL': ('L',), 'FAN': ('R',), 'PWR_CAN_TERMINAL': ('B',)}
def side(h, p):
    if h in SIDES: return SIDES[h][0]
    if h == 'JHAT': return 'L' if p['num'] % 2 else 'R'
    if h in ('JCTL', 'JSPI'):
        ys = sorted({round(q['y_mm'], 1) for q in hp[h]}); return 'T' if round(p['y_mm'], 1) == ys[0] else 'B'
hp = {h['name']: h['pins'] for h in d['headers']}
allnames = {}
for h in d['headers']:
    for p in h['pins']: allnames.setdefault(p['name'], set()).add(h['name'])
m = 2.0  # margin mm around board
gl, gr, gt, gb = B.GUT, 0, 0, 14
W, H = (160 + 2*m) * U, (100 + 2*m) * U
tw, th = round(W + gl + gr, 1), round(H + gt + gb, 1)
ox, oy = gl + m*U, gt + m*U
out = [f'<image x="{ox:.1f}" y="{oy:.1f}" width="{160*U:.1f}" height="{100*U:.1f}" preserveAspectRatio="none" href="data:image/jpeg;base64,{img}"/>']
pins, seen = [], {}
fs = 3.0
for h in d['headers']:
    small = h['name'] == 'QWIIC'
    for q in h['pins']:
        nm = q['name']
        if nm in ('GND', '3V3', '5V', '1V8', 'VIN') or len(allnames[nm]) == 1: pid = q.get('id') or nm
        else: pid = f"{'UNO' if h['name'] in ('JDIGITAL', 'JANALOG') else h['name'].replace('PWR_CAN_TERMINAL', 'TERM')}_{nm}"
        if pid[:-1].endswith('_') and pid[-1].isdigit() and nm in ('GND', '3V3', '5V'): pid = nm
        base = pid; n = seen.get(base, 0) + 1; seen[base] = n
        if n > 1: pid = f'{base}_{n}'
        x, y = round(ox + q['x_mm']*U, 2), round(oy + q['y_mm']*U, 2)
        s = side(h['name'], q)
        p = dict(id=pid, name=nm, x=x, y=y, side=s, type=q['type'])
        if q.get('fn'): p['functions'] = q['fn']
        if q.get('flags'): p['flags'] = q['flags']
        if q.get('voltage') is not None: p['voltage'] = q['voltage']
        p['notes'] = (f"{h['name']} pin {q['num']}. " + (q.get('notes') or '')).strip()
        pins.append(p)
        r = 1.6 if small else 3.0
        out.append(f'<circle cx="{x}" cy="{y}" r="{r}" fill="#d4a017" stroke="#7a5a08" stroke-width="0.4"/><circle cx="{x}" cy="{y}" r="{r*0.42:.2f}" fill="#1b1b1b"/>')
        f = 2.2 if small else fs; hh = 3.6 if small else 4.8; w = B.text_w(nm, f) + 2.4
        col = B.tag_color(p); stroke = '#8a9099' if p['type'] == 'ground' else '#00000066'
        gap = 3 if small else 4.6
        if s in ('L', 'R'):
            tx = x - gap - w if s == 'L' else x + gap
            out.append(f'<rect x="{tx:.1f}" y="{y-hh/2:.1f}" width="{w:.1f}" height="{hh}" rx="1" fill="{col}" stroke="{stroke}" stroke-width="0.3"/><text x="{tx+w/2:.1f}" y="{y+f*0.36:.1f}" font-size="{f}" font-family="monospace" fill="#fff" text-anchor="middle">{html.escape(nm)}</text>')
        else:
            ty = y - gap - w if s == 'T' else y + gap
            mx, my = x + f*0.36, ty + w/2
            out.append(f'<rect x="{x-hh/2:.1f}" y="{ty:.1f}" width="{hh}" height="{w:.1f}" rx="1" fill="{col}" stroke="{stroke}" stroke-width="0.3"/><text x="{mx:.1f}" y="{my:.1f}" font-size="{f}" font-family="monospace" fill="#fff" text-anchor="middle" transform="rotate(-90 {mx:.1f} {my:.1f})">{html.escape(nm)}</text>')
svg = f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {tw} {th}" width="{tw}" height="{th}">' + ''.join(out) + '</svg>'
names = {}
for p in pins: names.setdefault(p['name'], []).append(p['id'])
part = dict(id=d['id'], name=d['name'], category='Microcontrollers', refPrefix='U', description=d['description'], tags=d['tags'],
            source='builtin', license='Board art © Arduino, CC BY-SA 4.0 (from the ABX00181 full-pinout PDF). Pin positions measured from that drawing; pin data from the ABX00181 datasheet.',
            width=tw, height=th, svg=svg, pins=pins, buses=[v for k, v in names.items() if k in ('GND',) and len(v) > 1],
            props=dict(logicVoltage=3.3, chip='STM32H5F5 (MCU) + Qualcomm QCS8275 (MPU)', sizeMm=[160, 100], datasheet='https://docs.arduino.cc/hardware/ventuno-q',
                       note='UNO headers, JSPI, Qwiic and FAN are on the STM32 MCU (3.3 V). JHAT is driven by the MPU. JCTL is 1.8 V debug.'))
json.dump(part, open(f'out/{part["id"]}.json', 'w')); open(f'out/{part["id"]}.svg', 'w').write(svg)
print(part['id'], tw, th, len(pins), len(svg)//1024, 'KB'); print([p['id'] for p in pins])
