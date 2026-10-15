#!/usr/bin/env python3
"""Upscale every pose whose only 'original' is the 224x284 thumbnail, via SeedVR2 on ai-epyc.
Writes /imagegen/pose_library/upscaled_images/<id>.png (never touches pose_images/, which the
ComfyUI Krea2 gallery reads). Skips poses with a full-size `source` on disk or an existing output.
Usage: upscale_small.py [gpu ...]   (default: 1 2 = the two 5060 Tis)"""
import base64, io, json, os, queue, sys, threading, time, urllib.request
from PIL import Image
LIB = '/imagegen/pose_library'; OUT = os.path.join(LIB, 'upscaled_images')
URL = 'http://10.0.0.234:9312/seedvr2/upscale'
gpus = [int(g) for g in sys.argv[1:]] or [1, 2]
poses = json.load(open(os.path.join(LIB, 'poses.json')))
todo = queue.Queue()
for p in poses:
    src = p.get('source')
    if src and os.path.isfile(os.path.join('/imagegen', src)): continue
    if os.path.isfile(os.path.join(OUT, p['id'] + '.png')): continue
    todo.put(p)
total = todo.qsize(); done = [0]; fails = []; lock = threading.Lock()
print(f'{total} to upscale on gpus {gpus}', flush=True)
def work(gpu):
    while True:
        try: p = todo.get_nowait()
        except queue.Empty: return
        t = time.time()
        try:
            im = Image.open(os.path.join(LIB, 'pose_images', p.get('image') or p['id'] + '.webp')).convert('RGBA')
            bg = Image.new('RGB', im.size, (255, 255, 255)); bg.paste(im, mask=im.split()[3])
            b = io.BytesIO(); bg.save(b, 'PNG')
            body = json.dumps({'image': base64.b64encode(b.getvalue()).decode(), 'resolution': 1120, 'seed': 42, 'gpu': gpu}).encode()
            d = urllib.request.urlopen(urllib.request.Request(URL, data=body, headers={'Content-Type': 'application/json'}), timeout=900).read()
            Image.open(io.BytesIO(d)).verify()
            tmp = os.path.join(OUT, p['id'] + '.png.tmp')
            open(tmp, 'wb').write(d); os.replace(tmp, os.path.join(OUT, p['id'] + '.png'))
            with lock:
                done[0] += 1; print(f'[gpu{gpu}] {p["id"]} ok {time.time()-t:.0f}s ({done[0]}/{total})', flush=True)
        except Exception as e:
            with lock: fails.append(p['id']); print(f'[gpu{gpu}] {p["id"]} FAILED: {e}', flush=True)
ts = [threading.Thread(target=work, args=(g,)) for g in gpus]
[t.start() for t in ts]; [t.join() for t in ts]
print(f'DONE {done[0]}/{total} ok, {len(fails)} failed: {fails}', flush=True)
