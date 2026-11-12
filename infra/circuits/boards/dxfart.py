import ezdxf
from ezdxf import path as P, bbox
U = 10 / 2.54
class View:
    def __init__(s, x0, y0, x1, y1, margin, rot):
        s.x0, s.y0, s.x1, s.y1 = x0 - margin, y0 - margin, x1 + margin, y1 + margin
        s.m, s.rot = margin, rot
        s.W, s.H = s.x1 - s.x0, s.y1 - s.y0
        s.bw, s.bh = x1 - x0, y1 - y0
    def tf(s, x, y):
        u, v = x - s.x0, s.y1 - y
        if s.rot == 0: return u, v
        if s.rot == 90: return s.H - v, u
        if s.rot == -90: return v, s.W - u
        return s.W - u, s.H - v
    @property
    def size(s): return (s.W, s.H) if s.rot in (0, 180) else (s.H, s.W)
    @property
    def board(s):
        w, h = (s.bw, s.bh) if s.rot in (0, 180) else (s.bh, s.bw)
        return dict(x=s.m, y=s.m, w=w, h=h)

def dxf_art(f, view, tiny=0.08, tol=0.03):
    m = ezdxf.readfile(f).modelspace()
    segs = []
    for e in m:
        if e.dxftype() in ('DIMENSION', 'TEXT', 'MTEXT', 'INSERT', 'HATCH', 'POINT'): continue
        try:
            bb = bbox.extents([e])
            if not bb.has_data: continue
            if bb.extmin.x < view.x0 or bb.extmax.x > view.x1 or bb.extmin.y < view.y0 or bb.extmax.y > view.y1: continue
            if max(bb.size.x, bb.size.y) < tiny: continue
            pts = list(P.make_path(e).flattening(tol))
        except Exception: continue
        if len(pts) < 2: continue
        q = [view.tf(a.x, a.y) for a in pts]
        segs.append('M' + f'{q[0][0]*U:.1f},{q[0][1]*U:.1f}' + 'L' + ' '.join(f'{a*U:.1f},{b*U:.1f}' for a, b in q[1:]))
    w, h = view.size
    return dict(w_mm=w, h_mm=h, d=''.join(segs))
