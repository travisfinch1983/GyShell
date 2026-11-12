import pymupdf as fitz
from dxfart import View, U
K = 72 / 25.4
class PdfView(View):
    """Same as View but source coordinates are already y-down (PDF)."""
    def tf(s, x, y):
        u, v = x - s.x0, y - s.y0
        if s.rot == 0: return u, v
        if s.rot == 90: return s.H - v, u
        if s.rot == -90: return v, s.W - u
        return s.W - u, s.H - v
def pdf_art(f, view, page=0, tiny=0.08):
    pg = fitz.open(f)[page]; segs = []
    for d in pg.get_drawings():
        r = d['rect']
        x0, y0, x1, y1 = r.x0 / K, r.y0 / K, r.x1 / K, r.y1 / K
        if x0 < view.x0 or x1 > view.x1 or y0 < view.y0 or y1 > view.y1: continue
        if max(x1 - x0, y1 - y0) < tiny: continue
        cur = None; s = ''
        def pt(p): a, b = view.tf(p.x / K, p.y / K); return f'{a*U:.1f},{b*U:.1f}'
        for it in d['items']:
            if it[0] == 'l':
                a, b = it[1], it[2]
                s += ('' if cur is not None and abs(cur.x - a.x) < 1e-3 and abs(cur.y - a.y) < 1e-3 else 'M' + pt(a)) + 'L' + pt(b); cur = b
            elif it[0] == 'c':
                p0, p1, p2, p3 = it[1:5]
                if not (cur is not None and abs(cur.x - p0.x) < 1e-3 and abs(cur.y - p0.y) < 1e-3): s += 'M' + pt(p0)
                pts = []
                for i in range(1, 7):
                    t = i / 6; m = 1 - t
                    pts.append(fitz.Point(m**3*p0.x + 3*m*m*t*p1.x + 3*m*t*t*p2.x + t**3*p3.x, m**3*p0.y + 3*m*m*t*p1.y + 3*m*t*t*p2.y + t**3*p3.y))
                s += 'L' + ' '.join(pt(q) for q in pts); cur = p3
            elif it[0] == 're':
                q = it[1]; s += 'M' + pt(q.tl) + 'L' + ' '.join(pt(z) for z in (q.tr, q.br, q.bl, q.tl)); cur = None
            elif it[0] == 'qu':
                q = it[1]; s += 'M' + pt(q.ul) + 'L' + ' '.join(pt(z) for z in (q.ur, q.lr, q.ll, q.ul)); cur = None
        if d.get('closePath'): s += 'Z'
        segs.append(s)
    w, h = view.size
    return dict(w_mm=w, h_mm=h, d=''.join(segs))
