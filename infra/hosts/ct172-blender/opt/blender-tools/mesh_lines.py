"""Headless Blender: mesh -> fused skin -> quads -> flat 2D line renders.
blender -b --factory-startup --python mesh_lines.py -- IN.glb OUT_DIR [--faces 8000] [--voxel 0.004] [--res 1536]
Outputs white lines on flat black: quads_<view>.png (hidden-line quad wire), form_<view>.png (outline + creases), model_quads.glb
"""
import argparse, json, math, os, sys, time
import bpy
from mathutils import Vector

argv = sys.argv[sys.argv.index('--') + 1:]
ap = argparse.ArgumentParser()
ap.add_argument('src'); ap.add_argument('out')
ap.add_argument('--faces', type=int, default=8000)
ap.add_argument('--voxel', type=float, default=0.004)
ap.add_argument('--res', type=int, default=1536)
ap.add_argument('--smooth', type=int, default=12)
ap.add_argument('--line', type=float, default=1.0)
ap.add_argument('--views', default='front,side,back,threequarter')
a = ap.parse_args(argv)
os.makedirs(a.out, exist_ok=True)
t0 = time.time()
report = {'src': a.src, 'args': vars(a)}


def log(*x):
    print('[lines %6.1fs]' % (time.time() - t0), *x, flush=True)


def stats(o):
    me = o.data
    tri = sum(1 for p in me.polygons if len(p.vertices) == 3)
    quad = sum(1 for p in me.polygons if len(p.vertices) == 4)
    return {'verts': len(me.vertices), 'faces': len(me.polygons), 'tris': tri, 'quads': quad}


bpy.ops.wm.read_factory_settings(use_empty=True)
ext = os.path.splitext(a.src)[1].lower()
{'.glb': lambda p: bpy.ops.import_scene.gltf(filepath=p), '.gltf': lambda p: bpy.ops.import_scene.gltf(filepath=p),
 '.obj': lambda p: bpy.ops.wm.obj_import(filepath=p), '.fbx': lambda p: bpy.ops.import_scene.fbx(filepath=p),
 '.ply': lambda p: bpy.ops.wm.ply_import(filepath=p), '.stl': lambda p: bpy.ops.wm.stl_import(filepath=p)}[ext](a.src)
meshes = [o for o in bpy.context.scene.objects if o.type == 'MESH']
if not meshes:
    raise SystemExit('no mesh in file')
bpy.ops.object.select_all(action='DESELECT')
for o in meshes:
    o.select_set(True)
bpy.context.view_layer.objects.active = meshes[0]
if len(meshes) > 1:
    bpy.ops.object.join()
ob = bpy.context.view_layer.objects.active
bpy.ops.object.transform_apply(location=True, rotation=True, scale=True)
ob.data.materials.clear()
report['input'] = stats(ob); log('input', report['input'])

# 1. fuse: every loose piece becomes one closed skin
m = ob.modifiers.new('fuse', 'REMESH')
m.mode = 'VOXEL'; m.voxel_size = a.voxel; m.use_smooth_shade = False
bpy.ops.object.modifier_apply(modifier=m.name)
report['voxel'] = stats(ob); log('voxel', report['voxel'])

# 2. take the surface noise off before the quad pass
if a.smooth:
    m = ob.modifiers.new('calm', 'SMOOTH')
    m.factor = 0.6; m.iterations = a.smooth
    bpy.ops.object.modifier_apply(modifier=m.name)
    log('smoothed')

# 3. repair: QuadriFlow only accepts a manifold mesh
import bmesh, numpy as np


def nonmanifold(bm):
    return [e for e in bm.edges if not e.is_manifold]


bm = bmesh.new(); bm.from_mesh(ob.data)
bm.verts.ensure_lookup_table()
seen, doomed, small = set(), [], 0
for v in bm.verts:
    if v.index in seen:
        continue
    stack, isl = [v], []
    seen.add(v.index)
    while stack:
        c = stack.pop(); isl.append(c)
        for e in c.link_edges:
            o2 = e.other_vert(c)
            if o2.index not in seen:
                seen.add(o2.index); stack.append(o2)
    if len(isl) < 150:
        small += 1
        doomed.extend(isl)
if doomed:
    bmesh.ops.delete(bm, geom=doomed, context='VERTS')
report['small_islands_removed'] = small
start_nm = len(nonmanifold(bm))
for _ in range(6):
    bad = nonmanifold(bm)
    if not bad:
        break
    vs = list({v for e in bad for v in e.verts})
    bmesh.ops.delete(bm, geom=vs, context='VERTS')
    open_e = [e for e in bm.edges if e.is_boundary]
    if open_e:
        bmesh.ops.holes_fill(bm, edges=open_e, sides=0)
    loose = [v for v in bm.verts if not v.link_faces]
    if loose:
        bmesh.ops.delete(bm, geom=loose, context='VERTS')
bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
report['nonmanifold_edges'] = [start_nm, len(nonmanifold(bm))]
bm.to_mesh(ob.data); bm.free(); ob.data.update()
log('repair', 'islands removed', small, 'non-manifold edges', report['nonmanifold_edges'])

# 4. quads: QuadriFlow, then Instant Meshes if it still refuses
before = len(ob.data.polygons)
res = bpy.ops.object.quadriflow_remesh(mode='FACES', target_faces=a.faces, use_mesh_symmetry=False,
                                       use_preserve_sharp=False, use_preserve_boundary=False, smooth_normals=False, seed=0)
ob = bpy.context.view_layer.objects.active
report['quadriflow_result'] = sorted(res)
method = 'quadriflow'
if 'FINISHED' not in res or len(ob.data.polygons) == before:
    sys.path.insert(0, '/opt/blender-tools/lib')
    import pynanoinstantmeshes as pim
    me = ob.data
    me.calc_loop_triangles()
    V = np.empty(len(me.vertices) * 3, np.float32); me.vertices.foreach_get('co', V); V = V.reshape(-1, 3)
    T = np.empty(len(me.loop_triangles) * 3, np.int32); me.loop_triangles.foreach_get('vertices', T)
    T = T.reshape(-1, 3).astype(np.uint32)
    nv, nf = pim.remesh(V, T, max(200, a.faces // 4))
    nv, nf = np.asarray(nv), np.asarray(nf)
    log('instant meshes out', nv.shape, nf.shape)
    polys = []
    for f in nf.tolist():
        q = []
        for i in f:
            if i not in q:
                q.append(int(i))
        if len(q) >= 3:
            polys.append(q)
    new = bpy.data.meshes.new('quads')
    new.from_pydata(nv.tolist(), [], polys)
    new.update()
    ob.data = new
    method = 'instant-meshes'
report['quad_method'] = method
report['quads'] = stats(ob); log('quads', method, report['quads'])
bm = bmesh.new(); bm.from_mesh(ob.data); bm.normal_update()
bmesh.ops.recalc_face_normals(bm, faces=bm.faces); bm.to_mesh(ob.data); bm.free()
ob.select_set(True); bpy.context.view_layer.objects.active = ob
bpy.ops.export_scene.gltf(filepath=os.path.join(a.out, 'model_quads.glb'), use_selection=True, export_format='GLB', export_materials='NONE')

# 5. every edge marked, so Freestyle can draw the quad wire with hidden lines removed
bpy.ops.object.mode_set(mode='EDIT')
bpy.ops.mesh.select_mode(type='EDGE')
bpy.ops.mesh.select_all(action='SELECT')
bpy.ops.mesh.mark_freestyle_edge(clear=False)
bpy.ops.object.mode_set(mode='OBJECT')
blk = bpy.data.materials.new('black')
blk.use_nodes = True
blk.node_tree.nodes.clear()
outn = blk.node_tree.nodes.new('ShaderNodeOutputMaterial')
em = blk.node_tree.nodes.new('ShaderNodeEmission')
em.inputs[0].default_value = (0, 0, 0, 1); em.inputs[1].default_value = 0
blk.node_tree.links.new(em.outputs[0], outn.inputs[0])
ob.data.materials.append(blk)

sc = bpy.context.scene
sc.render.engine = 'CYCLES'
sc.cycles.device = 'CPU'; sc.cycles.samples = 1; sc.cycles.use_denoising = False
sc.render.resolution_x = sc.render.resolution_y = a.res
sc.render.image_settings.file_format = 'PNG'; sc.render.image_settings.color_mode = 'RGB'
sc.view_settings.view_transform = 'Standard'; sc.view_settings.look = 'None'
w = bpy.data.worlds.new('black'); w.use_nodes = True
w.node_tree.nodes['Background'].inputs[0].default_value = (0, 0, 0, 1)
sc.world = w
sc.render.use_freestyle = True
sc.render.line_thickness_mode = 'ABSOLUTE'; sc.render.line_thickness = a.line
vl = sc.view_layers[0]
vl.use_freestyle = True
fs = vl.freestyle_settings
fs.crease_angle = math.radians(120)
ls = fs.linesets[0] if len(fs.linesets) else fs.linesets.new('lines')
ls.select_by_visibility = True; ls.visibility = 'VISIBLE'
ls.select_by_edge_types = True; ls.edge_type_combination = 'OR'
ls.linestyle = ls.linestyle or bpy.data.linestyles.new('white')
ls.linestyle.color = (1, 1, 1)
ls.linestyle.thickness = a.line

corners = [ob.matrix_world @ Vector(c) for c in ob.bound_box]
lo = Vector((min(c[i] for c in corners) for i in range(3)))
hi = Vector((max(c[i] for c in corners) for i in range(3)))
ctr = (lo + hi) / 2
R = (hi - lo).length / 2
cam_d = bpy.data.cameras.new('cam'); cam_d.type = 'ORTHO'; cam_d.ortho_scale = (hi - lo).z * 1.08 if (hi - lo).z > R else R * 2
cam_d.ortho_scale = max((hi - lo).z, (hi - lo).x, (hi - lo).y) * 1.08
cam = bpy.data.objects.new('cam', cam_d); sc.collection.objects.link(cam); sc.camera = cam


def aim(deg):
    r = math.radians(deg)
    # glTF front (+Z) lands on Blender -Y
    cam.location = ctr + Vector((math.sin(r), -math.cos(r), 0)) * R * 4
    cam.rotation_euler = (ctr - cam.location).to_track_quat('-Z', 'Y').to_euler()
    cam_d.clip_end = R * 10


def edges(all_marked):
    for k in ('select_silhouette', 'select_border', 'select_crease', 'select_contour', 'select_external_contour'):
        setattr(ls, k, not False)
    ls.select_edge_mark = all_marked
    ls.select_crease = not all_marked


NAMED = {'front': 0, 'side': 90, 'back': 180, 'threequarter': 40}
for name in [v.strip() for v in a.views.split(',') if v.strip()]:
    deg = NAMED[name] if name in NAMED else float(name)
    aim(deg)
    for kind, marked in (('quads', True), ('form', False)):
        edges(marked)
        sc.render.filepath = os.path.join(a.out, f'{kind}_{name}.png')
        bpy.ops.render.render(write_still=True)
        log('rendered', kind, name)
report['seconds'] = round(time.time() - t0, 1)
json.dump(report, open(os.path.join(a.out, 'report.json'), 'w'), indent=1, default=str)
log('DONE')
