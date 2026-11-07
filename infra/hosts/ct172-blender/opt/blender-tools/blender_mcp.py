"""Blender MCP server (CT172). Streamable HTTP on :8765, bearer token + client IP allowlist.
Inputs: /3d-outputs (read-only) and /blender. Everything it writes goes under /blender/jobs.
run_script executes arbitrary Blender Python, so it only exists when BLENDER_MCP_ALLOW_SCRIPT=1.
Before giving other agents access: turn that off and tighten the allowlist deliberately.
"""
import hmac, io, json, logging, os, queue, re, subprocess, sys, tempfile, threading, time, uuid
from pathlib import Path

import uvicorn
from mcp.server.fastmcp import FastMCP, Image
from PIL import Image as PILImage
from starlette.responses import JSONResponse

logging.basicConfig(level=logging.INFO, format='%(asctime)s %(levelname)s %(message)s')
log = logging.getLogger('blender-mcp')
BLENDER = '/opt/blender/blender'
PIPE = '/opt/blender-tools/mesh_lines.py'
ROOTS = [Path('/3d-outputs'), Path('/blender')]
JOBS = Path('/blender/jobs')
EXT = {'.glb', '.gltf', '.obj', '.fbx', '.ply', '.stl'}
TOKEN = os.environ['BLENDER_MCP_TOKEN']
ALLOW_IPS = {x.strip() for x in os.environ.get('BLENDER_MCP_ALLOW_IPS', '').split(',') if x.strip()}
ALLOW_SCRIPT = os.environ.get('BLENDER_MCP_ALLOW_SCRIPT') == '1'
DENSITY = {'coarse': 8000, 'medium': 16000, 'fine': 32000}
JOB_TIMEOUT = 1800

mcp = FastMCP('blender', host='0.0.0.0', port=8765, stateless_http=True, json_response=True)
jobs, work = {}, queue.Queue()
lock = threading.Lock()


def inside(p):
    r = Path(p).resolve()
    if not any(r == root or root in r.parents for root in ROOTS):
        raise ValueError(f'path is outside {[str(x) for x in ROOTS]}: {p}')
    return r


def resolve_source(source):
    """A 3D job folder name, or an absolute path under /3d-outputs or /blender."""
    p = Path(source)
    if not p.is_absolute():
        if not re.fullmatch(r'[\w.-]+', source):
            raise ValueError(f'not a job name: {source}')
        found = sorted(x for x in (Path('/3d-outputs') / source).glob('model.*') if x.suffix.lower() in EXT)
        if not found:
            raise FileNotFoundError(f'no mesh in 3D job {source} (Idol jobs are splats, not meshes)')
        return found[0]
    r = inside(p)
    if r.suffix.lower() not in EXT or not r.is_file():
        raise ValueError(f'not a mesh file: {source}')
    return r


def job_dir(job_id):
    if not re.fullmatch(r'[\w.-]+', job_id):
        raise ValueError(f'bad job id: {job_id}')
    d = JOBS / job_id
    if not d.is_dir():
        raise FileNotFoundError(f'no job {job_id}')
    return d


def worker():
    while True:
        job_id = work.get()
        with lock:
            j = jobs[job_id]
            j.update(state='running', started=time.time())
        d = JOBS / job_id
        log.info('job %s start %s', job_id, j['cmd'])
        try:
            with open(d / 'job.log', 'wb') as f:
                rc = subprocess.run(j['cmd'], stdout=f, stderr=subprocess.STDOUT, timeout=JOB_TIMEOUT, cwd=str(d)).returncode
            ok = rc == 0 and (d / 'report.json').exists()
            state, err = ('done', None) if ok else ('failed', f'exit {rc}, report.json present: {(d / "report.json").exists()}')
        except subprocess.TimeoutExpired:
            state, err = 'failed', f'timed out after {JOB_TIMEOUT}s'
        except Exception as e:
            log.exception('job %s', job_id)
            state, err = 'failed', repr(e)
        with lock:
            j.update(state=state, error=err, finished=time.time())
            (d / 'job.json').write_text(json.dumps({k: v for k, v in j.items() if k != 'cmd'}, indent=1))
        log.info('job %s %s %s', job_id, state, err or '')


@mcp.tool()
def list_meshes(limit: int = 30) -> list[dict]:
    """List generated 3D jobs that have a mesh, newest first. Pass `name` to render_lines as `source`."""
    out = []
    for d in sorted((x for x in Path('/3d-outputs').iterdir() if x.is_dir()), key=lambda x: x.stat().st_mtime, reverse=True):
        m = [x for x in d.glob('model.*') if x.suffix.lower() in EXT]
        if m:
            out.append({'name': d.name, 'file': m[0].name, 'mb': round(m[0].stat().st_size / 1e6, 1)})
        if len(out) >= limit:
            break
    return out


@mcp.tool()
def render_lines(source: str, name: str = '', density: str = 'fine', views: str = 'front,side,back,threequarter',
                 voxel: float = 0.004, smooth: int = 12, resolution: int = 1536, line_width: float = 1.0) -> dict:
    """Queue a mesh -> quad wireframe -> flat 2D line render job (white lines on black). Returns job_id; poll job_status.
    source: a 3D job name from list_meshes, or an absolute path under /3d-outputs or /blender.
    density: coarse, medium or fine (default). Coarse loses thin parts such as wings and horns. views: comma list of front, side, back, threequarter, or degrees such as 135.
    voxel: fuse size as a fraction of the model's 1-unit scale; smaller keeps thin parts such as wings and horns but is slower.
    Writes quads_<view>.png, form_<view>.png, model_quads.glb and report.json under /blender/jobs/<job_id>."""
    if density not in DENSITY:
        raise ValueError(f'density must be one of {list(DENSITY)}')
    if not 0.001 <= voxel <= 0.05:
        raise ValueError('voxel must be between 0.001 and 0.05')
    if not 256 <= resolution <= 4096:
        raise ValueError('resolution must be between 256 and 4096')
    if not 0 <= smooth <= 100 or not 0.25 <= line_width <= 8:
        raise ValueError('smooth must be 0-100, line_width 0.25-8')
    if not re.fullmatch(r'[a-z0-9.,-]+', views):
        raise ValueError(f'bad views: {views}')
    src = resolve_source(source)
    slug = re.sub(r'[^\w.-]+', '-', name or src.parent.name)[:60].strip('-.') or 'mesh'
    job_id = f"{time.strftime('%Y%m%d-%H%M%S')}-{slug}-{uuid.uuid4().hex[:4]}"
    d = JOBS / job_id
    d.mkdir(parents=True)
    cmd = [BLENDER, '-b', '--factory-startup', '--python-exit-code', '1', '--python', PIPE, '--', str(src), str(d),
           '--faces', str(DENSITY[density]), '--voxel', str(voxel), '--smooth', str(smooth), '--res', str(resolution),
           '--line', str(line_width), '--views', views]
    with lock:
        jobs[job_id] = {'job_id': job_id, 'state': 'queued', 'source': str(src), 'density': density, 'created': time.time(), 'cmd': cmd}
    work.put(job_id)
    return {'job_id': job_id, 'state': 'queued', 'queue_length': work.qsize(), 'dir': str(d)}


@mcp.tool()
def job_status(job_id: str) -> dict:
    """State, mesh stats and output files for a job. A failed job includes the end of its log."""
    d = job_dir(job_id)
    with lock:
        j = dict(jobs.get(job_id, {}))
    j.pop('cmd', None)
    if not j and (d / 'job.json').exists():
        j = json.loads((d / 'job.json').read_text())
    j.setdefault('job_id', job_id)
    j.setdefault('state', 'unknown (server restarted before it finished)')
    if (d / 'report.json').exists():
        rep = json.loads((d / 'report.json').read_text())
        j['mesh'] = {k: rep.get(k) for k in ('input', 'quads', 'quad_method', 'seconds')}
    j['files'] = sorted(x.name for x in d.iterdir() if x.is_file())
    if j['state'] != 'done' and (d / 'job.log').exists():
        j['log_tail'] = (d / 'job.log').read_text(errors='replace')[-1500:]
    return j


@mcp.tool()
def list_jobs(limit: int = 20) -> list[str]:
    """Job ids under /blender/jobs, newest first."""
    return sorted((x.name for x in JOBS.iterdir() if x.is_dir()), reverse=True)[:limit]


@mcp.tool()
def get_image(job_id: str, file: str, max_size: int = 1024) -> Image:
    """Return a job's PNG so it can be viewed, scaled to max_size pixels on the long side."""
    if not re.fullmatch(r'[\w.-]+\.png', file):
        raise ValueError(f'bad file name: {file}')
    p = job_dir(job_id) / file
    if not p.is_file():
        raise FileNotFoundError(f'no {file} in {job_id}')
    im = PILImage.open(p).convert('RGB')
    im.thumbnail((max(64, min(max_size, 2048)),) * 2, PILImage.LANCZOS)
    b = io.BytesIO()
    im.save(b, 'PNG', optimize=True)
    return Image(data=b.getvalue(), format='png')


if ALLOW_SCRIPT:
    @mcp.tool()
    def run_script(code: str, timeout_s: int = 300) -> dict:
        """Run Blender Python headless in a fresh scene. cwd is /blender/scratch. Returns the exit code and the end of the output."""
        wd = Path('/blender/scratch')
        wd.mkdir(exist_ok=True)
        with tempfile.NamedTemporaryFile('w', suffix='.py', delete=False, dir='/tmp') as f:
            f.write(code)
        log.info('run_script %d chars -> %s', len(code), f.name)
        try:
            r = subprocess.run([BLENDER, '-b', '--factory-startup', '--python-exit-code', '1', '--python', f.name], cwd=str(wd),
                               capture_output=True, text=True, timeout=max(5, min(timeout_s, 1800)))
            return {'exit': r.returncode, 'output': (r.stdout + r.stderr)[-6000:]}
        except subprocess.TimeoutExpired as e:
            return {'exit': None, 'error': f'timed out after {e.timeout}s'}
        finally:
            os.unlink(f.name)


class Gate:
    """Bearer token and client IP check in front of the MCP app."""

    def __init__(self, app):
        self.app = app

    async def __call__(self, scope, receive, send):
        if scope['type'] != 'http':
            return await self.app(scope, receive, send)
        ip = (scope.get('client') or ('', 0))[0]
        auth = dict(scope.get('headers') or []).get(b'authorization', b'').decode('latin-1')
        ok = hmac.compare_digest(auth, f'Bearer {TOKEN}')
        if not ok or (ALLOW_IPS and ip not in ALLOW_IPS):
            log.warning('refused %s %s token_ok=%s', ip, scope.get('path'), ok)
            return await JSONResponse({'error': 'forbidden'}, status_code=403)(scope, receive, send)
        await self.app(scope, receive, send)


if __name__ == '__main__':
    if not TOKEN or len(TOKEN) < 32:
        sys.exit('BLENDER_MCP_TOKEN missing or too short')
    JOBS.mkdir(parents=True, exist_ok=True)
    threading.Thread(target=worker, daemon=True).start()
    log.info('allow ips=%s script=%s', sorted(ALLOW_IPS), ALLOW_SCRIPT)
    uvicorn.run(Gate(mcp.streamable_http_app()), host='0.0.0.0', port=8765, log_level='warning')
