"""
Builds the garage cars in Blender and exports them as .glb files for the site.

  m240i - modelled on the BMW M240i coupe (F22): real length, wheelbase, track and wheel size
  gt3   - modelled on the BMW M4 GT3 race car: the same, plus its aero
No badges, logos or liveries (those are BMW's trademarks); the shapes are the point.

Run (from this folder):
  blender -b -P build_cars.py -- [out_dir] [--car=m240i|gt3] [--preview] [--stats]

Coordinates are the site's (three.js) frame, used directly as Blender coordinates:
  +x = the car's left, +y = up, +z = forward, ground at y = 0.
Export keeps them as-is (export_yup=False). Previews tilt the car upright for Blender's camera.

How a body is made
  Each car is described by cross-sections ("stations") along its length. A station is eleven
  points on the left half of the car, from the floor to the roof centre:
    floor, floor edge, rocker, sill, lower door, door, shoulder crease, beltline, window, roof rail, roof
  Between stations every point is interpolated smoothly along z, and each section is drawn as a
  smooth curve through its points. Over the bonnet and boot the top four points lie almost flat,
  so one surface makes both the deck and the glasshouse. The surface is then made into a thin
  shell, and windows, arches, grilles, lamps and shut lines are cut into it.

Each .glb holds three objects:
  body     - everything that moves with the chassis
  wheel    - the rolling part of one wheel (axle along x, outer face at +x, centred on the axle)
  caliper  - the brake caliper for that wheel (steers but doesn't roll)
Material names are a contract with cars.js, which swaps in its own materials by name.
The dimensions here (length, axles, wheel size, track) must match CAR_SPECS in cars.js.
"""
import bpy, bmesh, math, os, sys
from mathutils import Vector, Matrix
from mathutils.bvhtree import BVHTree

ARGV = sys.argv[sys.argv.index('--') + 1:] if '--' in sys.argv else []
POS = [a for a in ARGV if not a.startswith('--')]
OUT = os.path.abspath(POS[0]) if POS else os.path.dirname(os.path.abspath(__file__))
PREVIEW = '--preview' in ARGV
STATS = '--stats' in ARGV
ONLY = next((a.split('=', 1)[1] for a in ARGV if a.startswith('--car=')), None)

TAU = math.pi * 2
lerp = lambda a, b, t: a + (b - a) * t
clamp = lambda v, a, b: max(a, min(b, v))


def interp(tbl, z):
    """Smooth (Catmull-Rom) interpolation through [(z, v), ...] sorted by z."""
    n = len(tbl)
    if z <= tbl[0][0]: return tbl[0][1]
    if z >= tbl[-1][0]: return tbl[-1][1]
    i = 1
    while tbl[i][0] < z: i += 1
    p0, p1, p2, p3 = tbl[max(i - 2, 0)], tbl[i - 1], tbl[i], tbl[min(i + 1, n - 1)]
    h = p2[0] - p1[0]; t = (z - p1[0]) / h
    m1 = ((p2[1] - p0[1]) / ((p2[0] - p0[0]) or 1)) * h
    m2 = ((p3[1] - p1[1]) / ((p3[0] - p1[0]) or 1)) * h
    t2, t3 = t * t, t * t * t
    return (2*t3 - 3*t2 + 1) * p1[1] + (t3 - 2*t2 + t) * m1 + (-2*t3 + 3*t2) * p2[1] + (t3 - t2) * m2


def bump(z, axles, width):
    b = 0
    for za in axles:
        t = abs(z - za) / width
        if t < 1: b = max(b, math.cos(t * math.pi / 2) ** 1.4)
    return b


# ------------------------------------------------------------------ scene + materials
def reset():
    bpy.ops.wm.read_factory_settings(use_empty=True)


def mat(name, color=(0.5, 0.5, 0.5), metal=0.0, rough=0.5, emit=None, alpha=1.0, coat=0.0, glass=False):
    m = bpy.data.materials.get(name)
    if m: return m
    m = bpy.data.materials.new(name)
    try: m.use_nodes = True
    except Exception: pass
    b = m.node_tree.nodes.get('Principled BSDF')
    b.inputs['Base Color'].default_value = (*color, 1)
    b.inputs['Metallic'].default_value = metal
    b.inputs['Roughness'].default_value = rough
    if coat: b.inputs['Coat Weight'].default_value = coat
    if emit:
        b.inputs['Emission Color'].default_value = (*emit, 1)
        b.inputs['Emission Strength'].default_value = 4
    if glass: b.inputs['Transmission Weight'].default_value = 1
    if alpha < 1: b.inputs['Alpha'].default_value = alpha
    m.diffuse_color = (*color, alpha)
    return m


def link(o):
    bpy.context.scene.collection.objects.link(o)
    return o


def finish(me, smooth=True):
    bm = bmesh.new(); bm.from_mesh(me)
    bmesh.ops.remove_doubles(bm, verts=bm.verts, dist=1e-6)
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    bm.to_mesh(me); bm.free()
    for p in me.polygons: p.use_smooth = smooth
    me.update()


def obj_from(name, verts, faces, material, smooth=True):
    me = bpy.data.meshes.new(name)
    me.from_pydata([tuple(v) for v in verts], [], faces)
    me.validate(); finish(me, smooth)
    o = link(bpy.data.objects.new(name, me))
    me.materials.append(material)
    return o


def apply_transform(o):
    o.data.transform(o.matrix_basis)
    o.matrix_basis = Matrix.Identity(4)


# ------------------------------------------------------------------ primitives
def _plane(axis, u, v, a):
    if axis == 'x': return (a, v, u)      # poly in (z, y)
    if axis == 'y': return (u, a, v)      # poly in (x, z)
    return (u, v, a)                      # poly in (x, y)


def prism(name, poly, axis, a0, a1, material, smooth=False):
    """Extrude a 2D polygon along an axis between a0 and a1."""
    n = len(poly)
    verts = [_plane(axis, u, v, a0) for u, v in poly] + [_plane(axis, u, v, a1) for u, v in poly]
    faces = [tuple(range(n)), tuple(range(2 * n - 1, n - 1, -1))]
    for i in range(n):
        j = (i + 1) % n
        faces.append((i, j, n + j, n + i))
    return obj_from(name, verts, faces, material, smooth)


def circle(cu, cv, r, n=48, a0=0, a1=TAU):
    full = abs(a1 - a0 - TAU) < 1e-6
    cnt = n if full else n + 1
    return [(cu + r * math.cos(a0 + (a1 - a0) * i / n), cv + r * math.sin(a0 + (a1 - a0) * i / n)) for i in range(cnt)]


def rrect(cu, cv, w, h, r, n=4):
    pts = []
    for (ox, oy, a) in ((w/2 - r, h/2 - r, 0), (-w/2 + r, h/2 - r, 90), (-w/2 + r, -h/2 + r, 180), (w/2 - r, -h/2 + r, 270)):
        for i in range(n + 1):
            t = math.radians(a + 90 * i / n)
            pts.append((cu + ox + r * math.cos(t), cv + oy + r * math.sin(t)))
    return pts


def rbox(name, w, h, d, r, material, pos=(0, 0, 0), rot=(0, 0, 0), seg=2):
    bm = bmesh.new()
    bmesh.ops.create_cube(bm, size=1)
    for v in bm.verts: v.co = Vector((v.co.x * w, v.co.y * h, v.co.z * d))
    if r > 0:
        bmesh.ops.bevel(bm, geom=list(bm.verts) + list(bm.edges), offset=r, segments=seg, affect='EDGES', profile=0.5)
    me = bpy.data.meshes.new(name); bm.to_mesh(me); bm.free()
    for p in me.polygons: p.use_smooth = r > 0
    me.materials.append(material)
    o = link(bpy.data.objects.new(name, me))
    o.rotation_euler = rot; o.location = pos
    return o


def ellipsoid(name, rx, ry, rz, material, pos=(0, 0, 0), rot=(0, 0, 0), seg=(14, 9)):
    bm = bmesh.new()
    bmesh.ops.create_uvsphere(bm, u_segments=seg[0], v_segments=seg[1], radius=1)
    for v in bm.verts: v.co = Vector((v.co.x * rx, v.co.y * ry, v.co.z * rz))
    me = bpy.data.meshes.new(name); bm.to_mesh(me); bm.free()
    for p in me.polygons: p.use_smooth = True
    me.materials.append(material)
    o = link(bpy.data.objects.new(name, me))
    o.rotation_euler = rot; o.location = pos
    return o


def revolve(name, profile, material, seg=64, a0=0, a1=TAU, smooth=True):
    """Revolve [(x, r), ...] around the x axis (y = r cos a, z = r sin a)."""
    full = abs(a1 - a0 - TAU) < 1e-6
    steps = seg if full else seg + 1
    n = len(profile)
    verts = []
    for i in range(steps):
        a = a0 + (a1 - a0) * i / seg
        for x, r in profile:
            verts.append((x, r * math.cos(a), r * math.sin(a)))
    faces = []
    for i in range(seg):
        i2 = (i + 1) % steps
        for j in range(n - 1):
            faces.append((i * n + j, i * n + j + 1, i2 * n + j + 1, i2 * n + j))
    return obj_from(name, verts, faces, material, smooth)


def tube(name, pts, radius, material, closed=False):
    cu = bpy.data.curves.new(name, 'CURVE')
    cu.dimensions = '3D'; cu.bevel_depth = radius; cu.bevel_resolution = 1; cu.fill_mode = 'FULL'
    sp = cu.splines.new('POLY')
    sp.points.add(len(pts) - 1)
    for i, p in enumerate(pts): sp.points[i].co = (p[0], p[1], p[2], 1)
    sp.use_cyclic_u = closed
    tmp = link(bpy.data.objects.new(name + '_c', cu))
    dg = bpy.context.evaluated_depsgraph_get()
    me = bpy.data.meshes.new_from_object(tmp.evaluated_get(dg))
    bpy.data.objects.remove(tmp); bpy.data.curves.remove(cu)
    for p in me.polygons: p.use_smooth = True
    me.materials.clear(); me.materials.append(material)
    return link(bpy.data.objects.new(name, me))


# ------------------------------------------------------------------ operations
def apply_mods(o):
    with bpy.context.temp_override(object=o, active_object=o, selected_objects=[o], selected_editable_objects=[o]):
        for m in list(o.modifiers):
            bpy.ops.object.modifier_apply(modifier=m.name)


def join(objs, name=None):
    objs = [o for o in objs if o]
    if len(objs) > 1:
        with bpy.context.temp_override(object=objs[0], active_object=objs[0], selected_objects=objs, selected_editable_objects=objs):
            bpy.ops.object.join()
    if name: objs[0].name = name; objs[0].data.name = name
    return objs[0]


def boolean(target, cutters, op='DIFFERENCE'):
    """Cut cutters into target with the exact solver; cut faces take the cutter's material."""
    cutters = [c for c in cutters if c]
    if not cutters: return target
    tool = join(cutters)
    m = target.modifiers.new('bool', 'BOOLEAN')
    m.operation = op; m.object = tool
    m.solver = 'EXACT'
    for k, v in (('material_mode', 'TRANSFER'), ('use_self', True), ('use_hole_tolerant', True)):
        try: setattr(m, k, v)
        except Exception: pass
    tool.hide_render = True
    before = len(target.data.polygons)
    apply_mods(target)
    if STATS: print(f'  boolean {target.name}: {before} -> {len(target.data.polygons)} faces ({len(cutters)} cutters)')
    bpy.data.objects.remove(tool)
    return target


def solidify(o, thickness, inner_material):
    o.data.materials.append(inner_material)
    m = o.modifiers.new('shell', 'SOLIDIFY')
    m.thickness = thickness; m.offset = -1; m.use_even_offset = True
    m.material_offset = 1
    try: m.use_quality_normals = True
    except Exception: pass
    apply_mods(o)


def mark_creases(o, B, names=('shoulder', 'belt'), tol=0.006):
    """Hard-edge the body lines (so light breaks along them like a pressed panel)."""
    me = o.data
    cache = {}
    def line(z):
        k = round(z, 3)
        if k not in cache: cache[k] = [B.p(z, n) for n in names]
        return cache[k]
    def on(v):
        if abs(v.co.x) < 0.3: return -1
        for i, (px, py) in enumerate(line(v.co.z)):
            if abs(abs(v.co.x) - px) < tol and abs(v.co.y - py) < tol: return i
        return -1
    tag = [on(v) for v in me.vertices]
    n = 0
    for e in me.edges:
        a, b = e.vertices
        if tag[a] >= 0 and tag[a] == tag[b] and abs(me.vertices[a].co.z - me.vertices[b].co.z) > 0.01:
            e.use_edge_sharp = True; n += 1
    if STATS: print(f'  creases: {n} hard edges')


def smooth_by_angle(o, deg=38):
    me = o.data
    for p in me.polygons: p.use_smooth = True
    try: me.set_sharp_from_angle(angle=math.radians(deg))
    except Exception: pass


class Surface:
    """Ray casts against a snapshot of a mesh (to place parts on the body)."""
    def __init__(self, o):
        self.bvh = BVHTree.FromObject(o, bpy.context.evaluated_depsgraph_get())

    def hit(self, origin, direction):
        loc, nor, idx, dist = self.bvh.ray_cast(Vector(origin), Vector(direction).normalized())
        return loc

    def x(self, y, z, side=1, default=0.85):
        h = self.hit((side * 3, y, z), (-side, 0, 0))
        return abs(h.x) if h else default

    def z_front(self, x, y, default=2.2):
        h = self.hit((x, y, 4), (0, 0, -1))
        return h.z if h else default

    def z_back(self, x, y, default=-2.2):
        h = self.hit((x, y, -4), (0, 0, 1))
        return h.z if h else default

    def y_top(self, x, z, default=1.0):
        h = self.hit((x, 3, z), (0, -1, 0))
        return h.y if h else default


def projected(name, poly, side, skin, material, offset=0.0, depth=0.0, sub=3, lean=0.0):
    """A patch shaped like poly, laid onto the body by casting rays, so it follows the curve.
    side: 'front' / 'rear' (poly in x, y), 'top' (poly in x, z) or 'left' / 'right' (poly in z, y).
    offset > 0 lifts it off the surface; depth > 0 makes it a solid that far into the body (a cutter).
    lean tilts front/rear rays inward from the outer side, so outlines can wrap round a corner."""
    if side in ('front', 'rear'):
        sgn = 1 if sum(p[0] for p in poly) >= 0 else -1
        f = 1 if side == 'front' else -1
        d = Vector((-sgn * lean, 0, -f)).normalized()
        zc = 2.0 * f
        place = lambda u, v: Vector((u, v, zc)) - d * 3
    elif side == 'top': place, d = (lambda u, v: Vector((u, 3, v))), Vector((0, -1, 0))
    elif side == 'left': place, d = (lambda u, v: Vector((3, v, u))), Vector((-1, 0, 0))
    else: place, d = (lambda u, v: Vector((-3, v, u))), Vector((1, 0, 0))
    cu = sum(p[0] for p in poly) / len(poly); cv = sum(p[1] for p in poly) / len(poly)
    bm = bmesh.new()
    vs = [bm.verts.new((cu, cv, 0))] + [bm.verts.new((u, v, 0)) for u, v in poly]
    n = len(poly)
    for i in range(n): bm.faces.new((vs[0], vs[1 + i], vs[1 + (i + 1) % n]))
    if sub: bmesh.ops.subdivide_edges(bm, edges=bm.edges[:], cuts=sub, use_grid_fill=True)
    last = None
    for v in bm.verts:
        o = place(v.co.x, v.co.y)
        h = skin.hit(o, d)
        if h is None: h = last if last is not None else o + d * 2
        last = h
        v.co = h - d * offset
    if depth:
        ext = bmesh.ops.extrude_face_region(bm, geom=bm.faces[:])
        for v in [e for e in ext['geom'] if isinstance(e, bmesh.types.BMVert)]:
            v.co += d * depth
    me = bpy.data.meshes.new(name); bm.to_mesh(me); bm.free()
    finish(me, smooth=True)
    me.materials.append(material)
    return link(bpy.data.objects.new(name, me))


mirror_poly = lambda poly, sx: [(sx * u, v) for u, v in poly][::sx]


# ------------------------------------------------------------------ the body surface
PTS = ['floor', 'edge', 'rocker', 'sill', 'low', 'door', 'shoulder', 'belt', 'win', 'rail', 'roof']
# smooth-curve samples between consecutive section points (fixed, so every ring matches)
SEG = [2, 2, 2, 3, 3, 2, 2, 3, 3, 4]


def st(z, yb, edge, rocker, sill, low, door, shoulder, belt, win, rail, roof):
    return (z, [(0.0, yb), (edge, yb), rocker, sill, low, door, shoulder, belt, win, rail, (0.0, roof)])


def _cr(p0, p1, p2, p3, t):
    """Centripetal Catmull-Rom between p1 and p2 (no loops or overshoot at tight corners)."""
    def tj(ti, a, b): return ti + max((b - a).length, 1e-5) ** 0.5
    t0 = 0.0; t1 = tj(t0, p0, p1); t2 = tj(t1, p1, p2); t3 = tj(t2, p2, p3)
    u = lerp(t1, t2, t)
    a1 = p0 * ((t1 - u) / (t1 - t0)) + p1 * ((u - t0) / (t1 - t0))
    a2 = p1 * ((t2 - u) / (t2 - t1)) + p2 * ((u - t1) / (t2 - t1))
    a3 = p2 * ((t3 - u) / (t3 - t2)) + p3 * ((u - t2) / (t3 - t2))
    b1 = a1 * ((t2 - u) / (t2 - t0)) + a2 * ((u - t0) / (t2 - t0))
    b2 = a2 * ((t3 - u) / (t3 - t1)) + a3 * ((u - t1) / (t3 - t1))
    return b1 * ((t2 - u) / (t2 - t1)) + b2 * ((u - t1) / (t2 - t1))


class Body:
    def __init__(self, stations, axles, flare=0.0, flare_w=0.6, tuck=0.0, dome=None):
        self.st = sorted(stations, key=lambda s: s[0])
        self.z0, self.z1 = self.st[0][0], self.st[-1][0]
        self.axles, self.flare, self.flare_w = axles, flare, flare_w
        self.tuck = tuck          # how far the lower body sits inside the shoulder (m)
        self.dome = dome          # (z from, z to, height): a raised centre on the bonnet
        # per point, per coordinate: [(z, value)] tables for interp()
        self.tbl = [[[(s[0], s[1][i][c]) for s in self.st] for c in (0, 1)] for i in range(len(PTS))]

    def ctrl(self, z):
        pts = [Vector((interp(self.tbl[i][0], z), interp(self.tbl[i][1], z))) for i in range(len(PTS))]
        if self.flare:
            b = bump(z, self.axles, self.flare_w) * self.flare
            for i, w in ((2, 0.5), (3, 0.85), (4, 1.0), (5, 1.0), (6, 0.75), (7, 0.15)):
                pts[i].x += b * w
        if self.tuck:
            # widest at the shoulder, tucking under toward the sill (seen from behind, not a tub)
            sh = pts[6].x
            for i, k in ((5, 0.35), (4, 0.6), (3, 1.0), (2, 1.6)):
                pts[i].x = min(pts[i].x, sh - self.tuck * k)
        if self.dome:
            za, zb, h = self.dome
            if za < z < zb:
                f = math.sin(math.pi * (z - za) / (zb - za)) * h
                pts[10].y += f; pts[9].y += f * 0.7
        return pts

    def p(self, z, name):
        v = self.ctrl(z)[PTS.index(name)]
        return v.x, v.y

    def half(self, z, lo=0, hi=None):
        c = self.ctrl(z)
        hi = len(c) - 1 if hi is None else hi
        ext = [Vector((-c[1].x, c[1].y))] + c + [Vector((-c[-2].x, c[-2].y))]   # mirror ends: smooth across the centreline
        out = []
        for i in range(lo, hi):
            p0, p1, p2, p3 = ext[i], ext[i + 1], ext[i + 2], ext[i + 3]
            for k in range(SEG[i]):
                out.append(_cr(p0, p1, p2, p3, k / SEG[i]))
        out.append(c[hi])
        return out

    def rows(self, step, za=None, zb=None):
        za = self.z0 if za is None else za; zb = self.z1 if zb is None else zb
        n = max(2, int(round((zb - za) / step)) + 1)
        return [lerp(za, zb, i / (n - 1)) for i in range(n)]

    def surface(self, name, material, step=0.045, lo=0, hi=None, za=None, zb=None, caps=True, inset=0.0):
        rows = self.rows(step, za, zb)
        verts, rings = [], []
        for z in rows:
            h = self.half(z, lo, hi)
            if lo == 0 and (hi is None):
                ring = h + [Vector((-p.x, p.y)) for p in h[-2:0:-1]]
            else:
                ring = h + [Vector((-p.x, p.y)) for p in h[::-1]]   # open strip across the top
            rings.append(len(ring))
            verts += [(p.x, p.y, z) for p in ring]
        R = rings[0]
        closed = lo == 0 and hi is None
        faces = []
        for i in range(len(rows) - 1):
            for k in range(R if closed else R - 1):
                a, b = i * R + k, i * R + (k + 1) % R
                faces.append((a, b, (i + 1) * R + (k + 1) % R, (i + 1) * R + k))
        if caps and closed:
            faces.append(tuple(range(R)))
            last = (len(rows) - 1) * R
            faces.append(tuple(range(last, last + R)))
        o = obj_from(name, verts, faces, material)
        if inset:
            # pull every vertex in along its normal (glass sitting inside the shell)
            me = o.data
            for v in me.vertices: v.co -= v.normal * inset
        return o


# ------------------------------------------------------------------ shared materials
def materials(spec):
    return dict(
        paint=mat('paint', spec['preview_paint'], metal=spec.get('paint_metal', 0.5), rough=spec.get('paint_rough', 0.35), coat=1),
        glass=mat('glass', (0.02, 0.025, 0.03), rough=0.03, alpha=0.35, glass=True),
        lens=mat('lens', (0.9, 0.9, 0.92), rough=0.02, alpha=0.15, glass=True),
        lens_red=mat('lens_red', (0.35, 0.01, 0.01), rough=0.05, alpha=0.6),
        chrome=mat('chrome', (0.85, 0.85, 0.87), metal=1, rough=0.1),
        trim=mat('trim', (0.02, 0.02, 0.022), rough=0.55, metal=0.2),
        gloss=mat('gloss', (0.01, 0.01, 0.012), rough=0.15, metal=0.3, coat=1),
        gap=mat('gap', (0.004, 0.004, 0.004), rough=0.9),
        well=mat('well', (0.012, 0.012, 0.012), rough=1),
        housing=mat('housing', (0.05, 0.05, 0.055), metal=0.8, rough=0.3),
        head=mat('head', (1, 1, 1), emit=(1, 0.95, 0.85)),
        tail=mat('tail', (0.3, 0, 0), emit=(1, 0.06, 0.04)),
        amber=mat('amber', (0.3, 0.12, 0), emit=(1, 0.5, 0.05)),
        grille=mat('grille', (0.015, 0.015, 0.017), rough=0.6),
        interior=mat('interior', (0.03, 0.028, 0.026), rough=0.75),
        seat=mat('seat', (0.045, 0.04, 0.037), rough=0.55),
        carbon=mat('carbon', (0.035, 0.037, 0.04), rough=0.3, metal=0.4, coat=1),
        gold=mat('gold', (0.79, 0.64, 0.36), metal=1, rough=0.28),
        tire=mat('tire', (0.03, 0.03, 0.03), rough=0.9),
        rim=mat('rim', spec['preview_rim'], metal=0.9, rough=spec.get('rim_rough', 0.25)),
        barrel=mat('barrel', (0.12, 0.12, 0.12), metal=0.8, rough=0.45),
        disc=mat('disc', (0.42, 0.42, 0.42), metal=0.9, rough=0.35),
        caliper=mat('caliper', spec['preview_caliper'], rough=0.35, metal=0.3),
    )


# ------------------------------------------------------------------ wheels
def build_wheel(W, M):
    r, w, rim, style = W['r'], W['w'], W['rim'], W['style']
    hw = w / 2
    parts = []
    prof = [(-hw + 0.012, rim * 0.985), (-hw - 0.004, rim + 0.025), (-hw - 0.002, r - 0.05), (-hw + 0.012, r - 0.016), (-hw + 0.04, r - 0.002)]
    if style == 'road':
        for g in (-w * 0.18, w * 0.18):
            prof += [(g - 0.007, r), (g - 0.005, r - 0.008), (g + 0.005, r - 0.008), (g + 0.007, r)]
    prof += [(hw - 0.04, r - 0.002), (hw - 0.012, r - 0.016), (hw + 0.002, r - 0.05), (hw + 0.004, rim + 0.025), (hw - 0.012, rim * 0.985)]
    parts.append(revolve('tire', prof, M['tire'], seg=44))
    parts.append(revolve('barrel', [(-hw * 0.8, rim * 0.97), (hw - 0.03, rim * 0.97)], M['barrel'], seg=32))
    parts.append(revolve('lip', [(hw - 0.05, rim * 0.975), (hw - 0.022, rim + 0.006), (hw - 0.008, rim + 0.002), (hw - 0.006, rim - 0.012), (hw - 0.03, rim - 0.02)], M['rim'], seg=44))
    parts.append(revolve('back', [(-hw * 0.4, 0), (-hw * 0.4, rim * 0.97)], M['well'], seg=20))
    dx = hw - 0.135
    parts.append(revolve('disc', [(dx - 0.014, rim * 0.33), (dx - 0.014, rim * 0.86), (dx + 0.014, rim * 0.86), (dx + 0.014, rim * 0.33)], M['disc'], seg=32))
    parts.append(revolve('hat', [(dx + 0.014, rim * 0.35), (hw - 0.085, rim * 0.3), (hw - 0.085, 0)], M['barrel'], seg=20))
    hub = rim * 0.22
    xi, xo = hw - 0.08, hw - 0.026     # spoke face x at the hub / at the lip (concave)

    def spoke(a, wi, wo, t=0.026, r0=hub, r1=None):
        r1 = rim * 0.965 if r1 is None else r1
        ca, sa = math.cos(a), math.sin(a)
        u = (-sa, ca)
        pts = []
        for (rr, ww, xx) in ((r0, wi, xi + (xo - xi) * (r0 - hub) / (rim - hub)), (r1, wo, xo)):
            for s in (-1, 1):
                cy, cz = rr * ca + s * ww / 2 * u[0], rr * sa + s * ww / 2 * u[1]
                pts.append(((xx, cy, cz), (xx - t, cy, cz)))
        v = [p[0] for p in pts] + [p[1] for p in pts]
        f = [(0, 2, 3, 1), (4, 5, 7, 6), (0, 1, 5, 4), (2, 6, 7, 3), (0, 4, 6, 2), (1, 3, 7, 5)]
        return obj_from('spoke', v, f, M['rim'], smooth=False)

    if style == 'road':
        # double-spoke: five pairs that split near the rim
        for i in range(5):
            a = i / 5 * TAU
            parts += [spoke(a - 0.05, 0.034, 0.03, r1=rim * 0.55), spoke(a - 0.17, 0.02, 0.034, r0=rim * 0.5), spoke(a + 0.17, 0.02, 0.034, r0=rim * 0.5)]
    else:
        # race wheel: ten slim spokes in pairs (Y), centre-lock
        for i in range(10):
            a = i / 10 * TAU
            parts.append(spoke(a, 0.03, 0.026))
    parts.append(revolve('hub', [(xi - 0.02, hub + 0.01), (xi + 0.004, hub + 0.01), (xi + 0.012, hub * 0.7), (xi + 0.014, 0)], M['rim'], seg=20))
    if style == 'road':
        for i in range(5):
            a = i / 5 * TAU + TAU / 10
            o = prism('lug', circle(0.0, 0.0, 0.011, 6), 'x', xi, xi + 0.022, M['chrome'])
            o.location = (0, math.cos(a) * hub * 0.62, math.sin(a) * hub * 0.62)
            parts.append(o)
    else:
        parts.append(prism('nut', circle(0, 0, hub * 0.55, 6), 'x', xi, xi + 0.035, M['gold']))
    for p in parts: apply_transform(p)
    wheel = join(parts, 'wheel')
    smooth_by_angle(wheel, 35)
    a0, a1 = math.radians(95), math.radians(150)
    prof = [(dx + 0.018, rim * 0.6), (dx + 0.055, rim * 0.6), (dx + 0.055, rim * 0.92), (dx + 0.018, rim * 0.92)]
    cal = revolve('caliper', prof + [prof[0]], M['caliper'], seg=8, a0=a0, a1=a1)
    ends = [obj_from('cal_end', [(x, rr * math.cos(a), rr * math.sin(a)) for x, rr in prof], [(0, 1, 2, 3)], M['caliper'], smooth=False) for a in (a0, a1)]
    cal = join([cal] + ends, 'caliper')
    finish(cal.data, smooth=False)
    return wheel, cal


# ================================================================== the cars
# --- BMW M240i coupe (F22, 2017-2021): 4432 long, 1774 wide, 1408 high, 2690 wheelbase,
#     18in double-spoke wheels (225/40 front), one exhaust tip each side.
# The body comes from profiles measured off reference views (side, rear and top) scaled to the
# real length; z is metres forward of the car's centre, y is height, x is half-width.
F22 = dict(
    # centreline height of the top of the car: bumper tip, bonnet, windscreen, roof, rear window, boot
    top=[(2.216, 0.67), (2.2, 0.685), (2.17, 0.70), (2.1, 0.714), (2.03, 0.731), (1.95, 0.746), (1.85, 0.762),
         (1.7, 0.785), (1.55, 0.822), (1.43, 0.85), (1.25, 0.885), (1.1, 0.918), (0.9, 0.94), (0.78, 0.952),
         (0.69, 0.99), (0.57, 1.081), (0.45, 1.157), (0.33, 1.234), (0.2, 1.295), (0.08, 1.328), (-0.05, 1.35),
         (-0.2, 1.365), (-0.45, 1.371), (-0.65, 1.365), (-0.89, 1.325), (-1.07, 1.235), (-1.25, 1.142),
         (-1.45, 1.045), (-1.6, 1.0), (-1.8, 0.985), (-1.95, 0.995), (-2.03, 1.012), (-2.08, 1.0),
         (-2.12, 0.965), (-2.15, 0.80), (-2.19, 0.62), (-2.216, 0.56)],
    # underside height
    floor=[(2.216, 0.46), (2.2, 0.36), (2.17, 0.26), (2.13, 0.21), (2.0, 0.2), (1.7, 0.19), (1.2, 0.18),
           (0.0, 0.175), (-1.0, 0.18), (-1.6, 0.2), (-1.9, 0.22), (-2.1, 0.26), (-2.15, 0.28), (-2.19, 0.3), (-2.216, 0.32)],
    # widest half-width at each point (from above): rounded nose, slim doors, rear haunches
    width=[(2.216, 0.26), (2.2, 0.40), (2.17, 0.47), (2.13, 0.56), (2.08, 0.645), (2.03, 0.73), (1.97, 0.80),
           (1.9, 0.835), (1.8, 0.85), (1.7, 0.861), (1.55, 0.868), (1.3, 0.876), (1.0, 0.876), (0.6, 0.872),
           (0.3, 0.867), (0.0, 0.866), (-0.4, 0.867), (-0.75, 0.875), (-0.95, 0.884), (-1.2, 0.887),
           (-1.45, 0.886), (-1.58, 0.873), (-1.7, 0.85), (-1.82, 0.83), (-1.94, 0.802), (-2.0, 0.78),
           (-2.05, 0.74), (-2.1, 0.667), (-2.15, 0.53), (-2.19, 0.35), (-2.216, 0.26)],
    # the shoulder crease, rising from the headlamps to the tail lamps
    crease=[(2.216, 0.6), (2.1, 0.69), (2.0, 0.71), (1.4, 0.745), (0.6, 0.775), (0.0, 0.79), (-0.65, 0.808),
            (-1.25, 0.83), (-1.9, 0.86), (-2.1, 0.87), (-2.216, 0.5)],
    # bottom of the side windows (rises toward the rear)
    belt=[(0.75, 0.955), (0.0, 0.965), (-0.9, 0.985), (-1.2, 1.01), (-1.45, 1.02)],
    # roof-rail half-width over the glasshouse
    rail=[(0.75, 0.66), (0.4, 0.62), (0.0, 0.605), (-0.6, 0.6), (-1.0, 0.58), (-1.3, 0.52), (-1.45, 0.45)],
    cab=(-1.45, 0.75),
    z=[2.216, 2.2, 2.17, 2.13, 2.08, 2.02, 1.95, 1.85, 1.7, 1.45, 1.15, 0.85, 0.74, 0.6, 0.45, 0.3, 0.12,
       -0.08, -0.4, -0.7, -0.88, -1.05, -1.25, -1.45, -1.6, -1.8, -1.95, -2.05, -2.11, -2.15, -2.19, -2.216],
)


def stations_from_profiles(P):
    """Build cross-sections from measured profiles (see F22)."""
    P = {k: (sorted(v) if isinstance(v, list) and v and isinstance(v[0], tuple) else v) for k, v in P.items()}   # interp() wants ascending z
    out = []
    c0, c1 = P['cab']
    for z in P['z']:
        top, fl, W = interp(P['top'], z), interp(P['floor'], z), interp(P['width'], z)
        k = W / 0.876                                    # scale details down toward the nose and tail
        crease = min(interp(P['crease'], z), top - 0.03)
        cabin = c0 - 0.02 <= z <= c1 + 0.02
        belt = interp(P['belt'], z) if cabin else top - 0.022
        belt = min(belt, top - 0.012)
        crease = min(crease, belt - 0.03)
        h = crease - fl
        door = (W - 0.016 * k, fl + h * 0.62)          # slight hollow under the crease
        low = (W - 0.006 * k, fl + h * 0.35)
        sill = (W - 0.03 * k, fl + h * 0.14)
        rocker = (W - 0.07 * k, fl + 0.012)
        edge = max(W - 0.28 * k, 0.05)
        sh = (W, crease)                                # the crease is the outermost line
        bx = W - 0.085 * k
        bl = (bx, belt)
        if cabin:
            rail_y = max(top - 0.035, belt + 0.02)
            rail = (min(interp(P['rail'], z), bx - 0.07), rail_y)
            win = (bx - 0.055, belt + (rail_y - belt) * 0.45)
        else:
            win = (bx * 0.66, top - 0.007)
            rail = (bx * 0.34, top - 0.002)
        out.append(st(z, fl, edge, rocker, sill, low, door, sh, bl, win, rail, top))
    return out


M240I = dict(
    key='m240i', L=(-2.216, 2.216), axles=(1.436, -1.254),
    wheel=dict(r=0.318, w=0.235, rim=0.229, style='road'), track=(0.76, 0.778),
    preview_paint=(0.13, 0.145, 0.165), paint_metal=0.6, paint_rough=0.32,
    preview_rim=(0.32, 0.33, 0.35), preview_caliper=(0.08, 0.2, 0.6),
    arch=0.055, flare=0.0,
    stations=None,   # filled from F22 below (needs st(), defined above)
    cowl=0.74, roof_front=-0.06, roof_back=-0.86, deck=-1.45,
    door=(0.88, -0.6), b_pillar=(-0.6, -0.53), c_pillar=-1.23, win_back=-1.06, rail_gap=0.02,
)
M240I['stations'] = stations_from_profiles(F22)

# --- BMW M4 GT3: 2917 wheelbase, about 2040 wide over the flares, 18in centre-lock wheels (300/680 front).
# Profiles measured off a side-on reference view scaled by the wheelbase (z = metres forward of the
# car's centre); widths are the road M4's body plus the GT3's flares.
M4GT3 = dict(
    top=[(2.17, 0.30), (2.14, 0.44), (2.115, 0.503), (2.06, 0.615), (2.0, 0.648), (1.95, 0.675), (1.84, 0.718),
         (1.73, 0.762), (1.62, 0.789), (1.51, 0.808), (1.40, 0.825), (1.30, 0.838), (1.19, 0.849), (1.08, 0.858),
         (0.97, 0.862), (0.86, 0.86), (0.80, 0.862), (0.75, 0.923), (0.69, 0.956), (0.585, 1.013), (0.476, 1.068),
         (0.367, 1.098), (0.257, 1.15), (0.094, 1.188), (-0.016, 1.204), (-0.125, 1.223), (-0.3, 1.255),
         (-0.45, 1.272), (-0.56, 1.275), (-0.67, 1.27), (-0.78, 1.262), (-0.94, 1.243), (-1.053, 1.226),
         (-1.163, 1.199), (-1.327, 1.147), (-1.436, 1.114), (-1.545, 1.081), (-1.654, 1.035), (-1.71, 1.01),
         (-1.85, 0.97), (-2.0, 0.94), (-2.15, 0.92), (-2.25, 0.89), (-2.32, 0.80), (-2.38, 0.6), (-2.41, 0.45)],
    floor=[(2.17, 0.10), (2.1, 0.075), (1.9, 0.065), (0.0, 0.06), (-1.9, 0.07), (-2.2, 0.12), (-2.35, 0.2), (-2.41, 0.26)],
    width=[(2.17, 0.66), (2.14, 0.76), (2.1, 0.83), (2.03, 0.88), (1.9, 0.915), (1.6, 0.93), (1.0, 0.935), (0.0, 0.935),
           (-1.0, 0.94), (-1.6, 0.94), (-1.95, 0.93), (-2.15, 0.9), (-2.3, 0.84), (-2.38, 0.76), (-2.41, 0.68)],
    crease=[(2.17, 0.4), (2.06, 0.58), (1.9, 0.62), (1.4, 0.69), (0.0, 0.73), (-1.4, 0.77), (-2.2, 0.79), (-2.41, 0.42)],
    belt=[(0.8, 0.86), (0.0, 0.87), (-0.9, 0.89), (-1.2, 0.91), (-1.6, 0.93)],
    rail=[(0.8, 0.66), (0.4, 0.62), (0.0, 0.6), (-0.6, 0.6), (-1.0, 0.57), (-1.3, 0.5), (-1.6, 0.42)],
    cab=(-1.6, 0.8),
    z=[2.17, 2.15, 2.12, 2.08, 2.03, 1.96, 1.85, 1.7, 1.44, 1.15, 0.92, 0.8, 0.7, 0.55, 0.4, 0.2, 0.0, -0.3,
       -0.6, -0.9, -1.15, -1.4, -1.6, -1.8, -2.0, -2.15, -2.25, -2.32, -2.37, -2.41],
)

GT3 = dict(
    key='gt3', L=(-2.41, 2.17), axles=(1.44, -1.477),
    wheel=dict(r=0.345, w=0.31, rim=0.229, style='race'), track=(0.87, 0.875),
    preview_paint=(0.012, 0.012, 0.014), paint_metal=0.2, paint_rough=0.5,
    preview_rim=(0.03, 0.03, 0.03), rim_rough=0.45, preview_caliper=(0.79, 0.64, 0.36),
    arch=0.06, flare=0.085, tuck=0.02, dome=(0.9, 2.0, 0.025),
    stations=None,
    cowl=0.8, roof_front=-0.08, roof_back=-0.95, deck=-1.6,
    door=(0.7, -0.66), b_pillar=(-0.66, -0.6), c_pillar=-1.3, win_back=-1.0, rail_gap=0.022,
    quarter_glass=False,      # the race car's rear side windows are blanked off
)
GT3['stations'] = stations_from_profiles(M4GT3)


def build_car(S):
    reset()
    M = materials(S)
    z0, z1 = S['L']
    ax, W = S['axles'], S['wheel']
    wr = W['r']
    gt = S['key'] == 'gt3'
    B = Body(S['stations'], ax, flare=S['flare'], flare_w=0.62, tuck=S.get('tuck', 0.0), dome=S.get('dome'))
    P = lambda z, n: B.p(z, n)

    # ---------- the outer surface, then a thin shell
    body = B.surface('body', M['paint'], step=0.045)
    skin = Surface(body)
    solidify(body, 0.022, M['interior'])

    cuts = []
    # wheel arches
    for za in ax:
        for sx in (1, -1):
            cuts.append(prism('arch', circle(za, wr, wr + S['arch'], 36), 'x', sx * 0.5, sx * 1.6, M['well']))
    # shut lines
    def slot_side(z, y0, y1, sx):                       # vertical line on the side
        return prism('gap', [(z - 0.0035, y0), (z + 0.0035, y0), (z + 0.0035, y1), (z - 0.0035, y1)], 'x', sx * 0.6, sx * 1.8, M['gap'])
    def slot_side_h(y, za, zb, sx):                     # horizontal line on the side
        return prism('gap', [(za, y - 0.0035), (zb, y - 0.0035), (zb, y + 0.0035), (za, y + 0.0035)], 'x', sx * 0.6, sx * 1.8, M['gap'])
    def slot_top(poly_xz, y0):
        return prism('gap', poly_xz, 'y', y0, 3, M['gap'])
    thin_x = lambda x, za, zb, t=0.0035: [(x - t, za), (x + t, za), (x + t, zb), (x - t, zb)]
    thin_z = lambda z, xa, xb, t=0.0035: [(xa, z - t), (xb, z - t), (xb, z + t), (xa, z + t)]
    df, dr = S['door']
    for sx in (1, -1):
        cuts += [slot_side(df, 0.27, 1.2, sx), slot_side(dr, 0.27, 1.2, sx), slot_side_h(0.29, dr, df, sx)]
    hood_r = S['cowl'] + 0.04
    hx = 0.7 if not gt else 0.66
    cuts.append(slot_top(thin_z(hood_r, -hx, hx), 0.6))
    for sx in (1, -1):
        cuts.append(slot_top(thin_x(sx * hx, hood_r, z1 - 0.12), 0.72 if not gt else 0.62))
    cuts.append(slot_top(thin_z(z1 - 0.12, -hx, hx), 0.6))
    trunk_f = S['deck'] - 0.04
    tx = 0.55 if not gt else 0.66
    cuts.append(slot_top(thin_z(trunk_f, -tx, tx), 0.8))
    for sx in (1, -1):
        cuts.append(slot_top(thin_x(sx * tx, z0 - 0.3, trunk_f), 0.8))
    lid_y = 0.74 if not gt else 0.8
    cuts.append(prism('gap', [(-tx, lid_y - 0.0035), (tx, lid_y - 0.0035), (tx, lid_y + 0.0035), (-tx, lid_y + 0.0035)], 'z', z0 - 0.3, z0 + 0.35, M['gap']))

    # ---------- windows (they open into the cabin)
    def belt_y(z): return P(z, 'belt')[1] + 0.022
    def rail_y(z): return P(z, 'rail')[1] - S.get('rail_gap', 0.032)
    def side_window(z_back_low, z_back_high, z_front_low, z_front_high, kink=False):
        """Window between the beltline and roof rail; front/rear edges run from their low z to high z."""
        bot, top = [], []
        n = 18
        for i in range(n + 1):
            z = lerp(z_back_low, z_front_low, i / n); bot.append((z, belt_y(z)))
        for i in range(n + 1):
            z = lerp(z_front_high, z_back_high, i / n); top.append((z, rail_y(z)))
        poly = bot + top
        if kink:
            # the rear corner turns forward at the bottom
            zb = z_back_low
            poly = [(zb + 0.05, belt_y(zb + 0.05)), (zb - 0.005, belt_y(zb) + 0.035)] + poly[1:] + [(z_back_high - 0.03, rail_y(z_back_high) - 0.05)]
        return poly
    a_low, a_high = S['cowl'] - 0.14, S['roof_front'] + 0.08
    bp0, bp1 = S['b_pillar']
    for sx in (1, -1):
        wins = [side_window(bp1, bp1, a_low, a_high)]
        if S.get('quarter_glass', True):
            wins.append(side_window(S['c_pillar'], S.get('win_back', S['roof_back'] + 0.02), bp0, bp0, kink=True))
        for poly in wins:
            cuts.append(prism('win', poly, 'x', sx * 0.3, sx * 1.6, M['gap']))
    # windscreen and rear window, cut from above (leaving the A- and C-pillars)
    def screen(za, zb, wa, wb, y0):
        return prism('ws', [(-wa, za), (wa, za), (wb, zb), (-wb, zb)], 'y', y0, 3, M['gap'])
    ws_y = P(S['cowl'], 'belt')[1] + 0.03
    cuts.append(screen(S['cowl'] + 0.02, S['roof_front'], P(S['cowl'], 'rail')[0] - 0.02, P(S['roof_front'], 'rail')[0] - 0.08, ws_y))
    rw_y = P(S['deck'], 'roof')[1] + 0.025
    cuts.append(screen(S['roof_back'], S['deck'] + 0.03, P(S['roof_back'], 'rail')[0] - 0.05, P(S['deck'] + 0.1, 'win')[0] - 0.025, rw_y))

    # ---------- front and rear openings, per car
    inside, parts = [], []
    if not gt: front_m240i(cuts, parts, skin, M, S)
    else: front_gt3(cuts, parts, skin, M, S, B)
    if not gt: rear_m240i(cuts, parts, skin, M, S)
    else: rear_gt3(cuts, parts, skin, M, S, B)
    boolean(body, cuts)
    if gt:
        # roof in gold
        idx = len(body.data.materials); body.data.materials.append(M['gold'])
        for p in body.data.polygons:
            if p.normal.y > 0.85 and S['roof_back'] + 0.08 < p.center.z < S['roof_front'] - 0.05 and abs(p.center.x) < 0.52 and p.material_index == 0:
                p.material_index = idx

    # glass: the glasshouse part of the surface, sitting just inside the shell
    glass = B.surface('glass', M['glass'], step=0.07, lo=PTS.index('belt'), za=S['deck'] - 0.05, zb=S['cowl'] + 0.12, caps=False, inset=0.01)
    # wheel-arch liners
    for za in ax:
        for sx in (1, -1):
            R = wr + S['arch'] - 0.004
            xin, xout = 0.5, P(za, 'door')[0] - 0.035
            o = revolve('liner', [(sx * xin, 0.0), (sx * xin, R), (sx * xout, R)], M['well'], seg=20, a0=math.radians(-115), a1=math.radians(115))
            o.location = (0, wr, za); parts.append(o)

    # ---------- interior
    fy = P(0, 'floor')[1] + 0.025
    belt0 = P(-0.3, 'belt')[1]
    seat_z = -0.45 if not gt else -0.55
    inside.append(rbox('floor', 1.4, 0.02, 3.0, 0.0, M['interior'], pos=(0, fy + 0.02, -0.2)))
    inside.append(rbox('dash', 1.42, 0.2, 0.42, 0.06, M['interior'], pos=(0, belt0 - 0.03, S['cowl'] - 0.2), rot=(math.radians(-8), 0, 0)))
    inside.append(rbox('console', 0.22, 0.22, 0.9, 0.04, M['interior'], pos=(0, fy + 0.16, seat_z + 0.3)))
    swc = Vector((0.37, belt0 + 0.07, S['cowl'] - 0.55))
    ring = []
    for i in range(24):
        a = i / 24 * TAU
        ring.append((swc.x + 0.17 * math.cos(a), swc.y + 0.17 * math.sin(a) * math.cos(math.radians(22)), swc.z - 0.17 * math.sin(a) * math.sin(math.radians(22))))
    inside.append(tube('wheel_ring', ring, 0.018, M['seat'], closed=True))
    inside.append(rbox('spoke', 0.3, 0.035, 0.02, 0.01, M['interior'], pos=tuple(swc), rot=(math.radians(-22), 0, 0)))
    seats = [(1,), (-1,)] if not gt else [(1,)]
    for (sx,) in seats:
        x = sx * 0.37
        inside.append(rbox('cushion', 0.5, 0.14, 0.52, 0.05, M['seat'], pos=(x, fy + 0.2, seat_z + 0.22)))
        inside.append(rbox('seatback', 0.5, 0.66, 0.14, 0.06, M['seat'], pos=(x, fy + 0.58, seat_z - 0.06), rot=(math.radians(-14), 0, 0)))
        if not gt:
            inside.append(rbox('headrest', 0.28, 0.16, 0.1, 0.05, M['seat'], pos=(x, fy + 0.98, seat_z - 0.16), rot=(math.radians(-10), 0, 0)))
        else:
            for wx in (-1, 1):
                inside.append(rbox('bolster', 0.07, 0.62, 0.22, 0.03, M['seat'], pos=(x + wx * 0.25, fy + 0.58, seat_z - 0.02), rot=(math.radians(-14), 0, 0)))
            inside.append(rbox('headrest', 0.36, 0.2, 0.16, 0.06, M['seat'], pos=(x, fy + 0.98, seat_z - 0.16), rot=(math.radians(-14), 0, 0)))
    if not gt:
        inside.append(rbox('rear_cushion', 1.1, 0.14, 0.45, 0.05, M['seat'], pos=(0, fy + 0.18, -1.02)))
        inside.append(rbox('rear_back', 1.1, 0.5, 0.14, 0.06, M['seat'], pos=(0, fy + 0.48, -1.28), rot=(math.radians(-22), 0, 0)))
    else:
        # roll cage: main hoop, roof bars down to the A-pillars, a diagonal, door bars
        top = P(-0.7, 'roof')[1] - 0.09
        hoop_z = -0.8
        hw_top = P(hoop_z, 'rail')[0] - 0.12
        hw_low = P(hoop_z, 'belt')[0] - 0.12
        hoop = [(-hw_low, fy, hoop_z), (-hw_low, belt0, hoop_z), (-hw_top, top - 0.06, hoop_z), (-hw_top + 0.1, top, hoop_z),
                (hw_top - 0.1, top, hoop_z), (hw_top, top - 0.06, hoop_z), (hw_low, belt0, hoop_z), (hw_low, fy, hoop_z)]
        inside.append(tube('cage', hoop, 0.022, M['gold']))
        for sx in (1, -1):
            zf = S['cowl'] - 0.05
            inside.append(tube('cage', [(sx * (hw_top - 0.1), top, hoop_z), (sx * (P(S['roof_front'], 'rail')[0] - 0.14), P(S['roof_front'], 'rail')[1] - 0.08, S['roof_front']),
                                         (sx * (P(zf, 'belt')[0] - 0.14), P(zf, 'belt')[1] - 0.02, zf), (sx * (P(zf, 'belt')[0] - 0.14), fy, zf)], 0.02, M['gold']))
            inside.append(tube('cage', [(sx * hw_low, fy + 0.3, hoop_z), (sx * (P(0.0, 'belt')[0] - 0.12), fy + 0.36, S['cowl'] - 0.1)], 0.018, M['gold']))
        inside.append(tube('cage', [(-hw_low, fy + 0.05, hoop_z), (hw_top - 0.12, top - 0.02, hoop_z)], 0.018, M['gold']))
        inside.append(rbox('rear_bulkhead', 1.5, 0.6, 0.02, 0.0, M['interior'], pos=(0, fy + 0.3, -1.25)))

    # ---------- shared exterior parts
    # mirrors on the doors, just behind the A-pillar
    for sx in (1, -1):
        mz = S['cowl'] - 0.2
        bx, by = P(mz, 'belt')
        mx, my = bx + 0.17, by + 0.07
        if not gt:
            parts.append(ellipsoid('mirror', 0.11, 0.065, 0.075, M['paint'], pos=(sx * mx, my, mz), rot=(0, sx * -0.18, 0)))
            parts.append(rbox('mirror_glass', 0.17, 0.095, 0.01, 0.035, M['chrome'], pos=(sx * mx, my, mz - 0.072), rot=(0, sx * -0.18, 0)))
            parts.append(rbox('mirror_arm', 0.14, 0.03, 0.06, 0.012, M['paint'], pos=(sx * (mx - 0.1), my - 0.045, mz + 0.02)))
        else:
            # race mirrors: slim, on a stalk
            parts.append(ellipsoid('mirror', 0.1, 0.05, 0.065, M['carbon'], pos=(sx * (mx + 0.02), my + 0.02, mz), rot=(0, sx * -0.1, 0)))
            parts.append(rbox('mirror_glass', 0.15, 0.075, 0.01, 0.03, M['chrome'], pos=(sx * (mx + 0.02), my + 0.02, mz - 0.062), rot=(0, sx * -0.1, 0)))
            parts.append(rbox('mirror_arm', 0.16, 0.02, 0.04, 0.008, M['carbon'], pos=(sx * (mx - 0.08), my - 0.02, mz + 0.01)))
    # door handles, flush, on the shoulder line
    for sx in (1, -1):
        hz = dr + 0.28
        hy = P(hz, 'shoulder')[1] - 0.045
        x = skin.x(hy, hz, sx)
        parts.append(rbox('handle', 0.012, 0.022, 0.15, 0.008, M['chrome'] if not gt else M['trim'], pos=(sx * (x + 0.002), hy, hz)))
    # side sills
    skz0, skz1 = ax[1] + wr + S['arch'] + 0.05, ax[0] - wr - S['arch'] - 0.05
    for sx in (1, -1):
        pts = [(sx * (skin.x(0.2 if not gt else 0.13, lerp(skz0, skz1, i / 10), sx) + 0.01), 0.2 if not gt else 0.13, lerp(skz0, skz1, i / 10)) for i in range(11)]
        parts.append(tube('skirt', pts, 0.03 if not gt else 0.04, M['trim'] if not gt else M['carbon']))

    under = rbox('under', 1.5, 0.04, (z1 - z0) * 0.86, 0.0, M['well'], pos=(0, P(0, 'floor')[1] - 0.01, (z0 + z1) / 2))
    allp = [body, glass, under] + inside + parts
    for p in allp: apply_transform(p)
    if STATS:
        tri = lambda o: sum(len(q.vertices) - 2 for q in o.data.polygons)
        by = {}
        for p in allp: by[p.name.split('.')[0]] = by.get(p.name.split('.')[0], 0) + tri(p)
        print('  heaviest parts:', sorted(by.items(), key=lambda kv: -kv[1])[:12])
    body = join(allp, 'body')
    smooth_by_angle(body, 40)
    mark_creases(body, B)
    wheel, cal = build_wheel(W, M)
    return body, wheel, cal, M


# ------------------------------------------------------------------ M240i (F22) details
# lamp outlines for the +x side, in (x, y) as seen from the front / rear
HEAD_M = [(0.27, 0.648), (0.31, 0.684), (0.50, 0.700), (0.68, 0.706), (0.76, 0.698), (0.775, 0.672), (0.66, 0.646), (0.48, 0.628), (0.30, 0.628)]
TAIL_M = [(0.36, 0.858), (0.58, 0.870), (0.78, 0.882), (0.84, 0.900), (0.835, 0.945), (0.60, 0.948), (0.38, 0.925)]


def front_m240i(cuts, parts, skin, M, S):
    for sx in (1, -1):
        # kidneys: compact, rounded, chrome surround, vertical slats
        k = rrect(sx * 0.118, 0.628, 0.19, 0.152, 0.05)
        cuts.append(prism('kidney', k, 'z', 2.08, 3, M['grille']))
        parts.append(tube('kidney_surround', [(x, y, skin.z_front(x, y) + 0.004) for x, y in rrect(sx * 0.118, 0.628, 0.204, 0.166, 0.055)], 0.01, M['chrome'], closed=True))
        for i in range(7):
            x = sx * 0.118 - 0.075 + i * 0.025
            parts.append(rbox('slat', 0.007, 0.14, 0.03, 0.0, M['gloss'], pos=(x, 0.628, 2.15)))
        parts.append(rbox('grille_back', 0.19, 0.15, 0.01, 0.0, M['grille'], pos=(sx * 0.118, 0.628, 2.12)))
        # headlamp: recess, twin halo rings around projectors, clear lens
        cuts.append(projected('headlamp', mirror_poly(HEAD_M, sx), 'front', skin, M['housing'], offset=0.02, depth=0.07, lean=0.55))
        parts.append(projected('lamp_back', mirror_poly(HEAD_M, sx), 'front', skin, M['housing'], offset=-0.045, lean=0.55))
        for (px, py, rr) in ((0.42, 0.664, 0.034), (0.585, 0.674, 0.036)):
            ring = []
            for i in range(20):
                a = i / 20 * TAU
                x, y = sx * px + rr * math.cos(a), py + rr * math.sin(a)
                ring.append((x, y, skin.z_front(x, y) - 0.03))
            parts.append(tube('halo', ring, 0.006, M['head'], closed=True))
            parts.append(projected('proj', circle(sx * px, py, 0.022, 12), 'front', skin, M['chrome'], offset=-0.038, lean=0.55, sub=1))
        parts.append(projected('lamp_lens', mirror_poly(HEAD_M, sx), 'front', skin, M['lens'], offset=-0.002, lean=0.55))
        # M Sport side intakes (triangular) and amber side marker
        cuts.append(projected('side_intake', mirror_poly([(0.5, 0.3), (0.72, 0.32), (0.74, 0.47), (0.6, 0.48)], sx), 'front', skin, M['grille'], offset=0.02, depth=0.05, lean=0.45))
        parts.append(projected('marker', mirror_poly([(0.7, 0.53), (0.78, 0.535), (0.78, 0.55), (0.7, 0.545)], sx), 'front', skin, M['amber'], offset=0.002, lean=0.6, sub=1))
    # centre intake and number plate panel
    cuts.append(prism('intake', [(-0.38, 0.26), (0.38, 0.26), (0.33, 0.42), (-0.33, 0.42)], 'z', 2.08, 3, M['grille']))
    parts.append(rbox('intake_back', 0.74, 0.16, 0.01, 0.0, M['grille'], pos=(0, 0.34, 2.12)))
    for y in (0.31, 0.37):
        parts.append(rbox('intake_bar', 0.68, 0.012, 0.02, 0.0, M['gloss'], pos=(0, y, 2.165)))
    parts.append(tube('lip', [(x, 0.2, skin.z_front(x, 0.22) + 0.005) for x in [lerp(-0.68, 0.68, i / 12) for i in range(13)]], 0.014, M['trim']))


def rear_m240i(cuts, parts, skin, M, S):
    for sx in (1, -1):
        cuts.append(projected('taillamp', mirror_poly(TAIL_M, sx), 'rear', skin, M['housing'], offset=0.02, depth=0.045, lean=0.55))
        # the L: a bar along the top and one down the outer edge
        for b in ([(0.40, 0.915), (0.80, 0.924), (0.80, 0.934), (0.40, 0.925)],
                  [(0.50, 0.878), (0.80, 0.888), (0.80, 0.897), (0.50, 0.887)],
                  [(0.79, 0.885), (0.82, 0.888), (0.83, 0.938), (0.80, 0.936)]):
            parts.append(projected('tail', mirror_poly(b, sx), 'rear', skin, M['tail'], offset=-0.022, lean=0.55, sub=2))
        parts.append(projected('tail_lens', mirror_poly(TAIL_M, sx), 'rear', skin, M['lens_red'], offset=-0.002, lean=0.55))
        parts.append(projected('reflector', mirror_poly([(0.62, 0.38), (0.74, 0.39), (0.74, 0.405), (0.62, 0.395)], sx), 'rear', skin, M['lens_red'], offset=0.002, lean=0.45, sub=1))
        zb = skin.z_back(sx * 0.53, 0.3)
        o = revolve('tip', [(zb - 0.06, 0.046), (zb + 0.1, 0.046), (zb + 0.1, 0.04), (zb - 0.05, 0.04)], M['chrome'], seg=24)
        o.rotation_euler = (0, math.radians(-90), 0); apply_transform(o); o.location = (sx * 0.53, 0.3, 0)
        parts.append(o)
        parts.append(prism('tip_in', circle(sx * 0.53, 0.3, 0.04, 20), 'z', zb - 0.04, zb - 0.035, M['well']))
    lip = []
    for i in range(15):
        x = lerp(-0.58, 0.58, i / 14)
        y = skin.y_top(x, -2.1)
        lip.append((x, y + 0.006, skin.z_back(x, y - 0.012) + 0.012))
    parts.append(tube('boot_lip', lip, 0.011, M['paint']))
    cuts.append(prism('plate', rrect(0, 0.64, 0.52, 0.12, 0.02), 'z', -3, S['L'][0] + 0.03, M['trim']))
    cuts.append(prism('gap', [(-1.0, 0.5965), (1.0, 0.5965), (1.0, 0.6035), (-1.0, 0.6035)], 'z', -3, -1.68, M['gap']))
    parts.append(projected('diffuser', [(-0.7, 0.24), (0.7, 0.24), (0.67, 0.36), (-0.67, 0.36)], 'rear', skin, M['trim'], offset=0.004, sub=2))


# ------------------------------------------------------------------ M4 GT3 details
HEAD_G = [(0.40, 0.545), (0.56, 0.556), (0.70, 0.574), (0.78, 0.596), (0.79, 0.574), (0.70, 0.55), (0.54, 0.532), (0.42, 0.528)]
TAIL_G = [(0.40, 0.735), (0.62, 0.742), (0.78, 0.752), (0.84, 0.768), (0.82, 0.808), (0.62, 0.808), (0.42, 0.79)]


def front_gt3(cuts, parts, skin, M, S, B):
    z1 = S['L'][1]
    for sx in (1, -1):
        # the big upright kidneys, nearly down to the splitter
        k = rrect(sx * 0.19, 0.36, 0.3, 0.42, 0.07)
        cuts.append(prism('kidney', k, 'z', 1.96, 3, M['grille']))
        parts.append(tube('kidney_surround', [(x, y, skin.z_front(x, y) + 0.004) for x, y in rrect(sx * 0.19, 0.36, 0.315, 0.435, 0.075)], 0.012, M['gold'], closed=True))
        for i in range(7):
            x = sx * 0.19 - 0.12 + i * 0.04
            parts.append(rbox('slat', 0.008, 0.4, 0.035, 0.0, M['gloss'], pos=(x, 0.36, 2.02)))
        parts.append(rbox('grille_back', 0.3, 0.42, 0.01, 0.0, M['grille'], pos=(sx * 0.19, 0.36, 1.99)))
        # slim headlamps that rise outboard
        cuts.append(projected('headlamp', mirror_poly(HEAD_G, sx), 'front', skin, M['housing'], offset=0.02, depth=0.07, lean=0.55))
        parts.append(projected('lamp_back', mirror_poly(HEAD_G, sx), 'front', skin, M['housing'], offset=-0.045, lean=0.55))
        parts.append(projected('drl', mirror_poly([(0.44, 0.548), (0.6, 0.558), (0.76, 0.584), (0.76, 0.575), (0.6, 0.55), (0.44, 0.541)], sx), 'front', skin, M['head'], offset=-0.03, lean=0.55, sub=2))
        for px, py in ((0.56, 0.546), (0.68, 0.558)):
            parts.append(projected('proj_lens', circle(sx * px, py, 0.013, 12), 'front', skin, M['head'], offset=-0.034, lean=0.55, sub=1))
        parts.append(projected('lamp_lens', mirror_poly(HEAD_G, sx), 'front', skin, M['lens'], offset=-0.002, lean=0.55))
        # bumper corners: a vertical LED light cluster over a brake-cooling intake
        parts.append(projected('corner_led', mirror_poly([(0.66, 0.40), (0.68, 0.40), (0.68, 0.30), (0.75, 0.29), (0.75, 0.276), (0.66, 0.282)], sx), 'front', skin, M['head'], offset=0.003, lean=0.6, sub=1))
        cuts.append(projected('brake_duct', mirror_poly([(0.5, 0.14), (0.78, 0.15), (0.79, 0.25), (0.55, 0.25)], sx), 'front', skin, M['grille'], offset=0.02, depth=0.06, lean=0.5))
        # bonnet outlets either side of the raised centre
        cuts.append(projected('hood_vent', [(sx * 0.14, 1.52), (sx * 0.5, 1.46), (sx * 0.5, 1.7), (sx * 0.16, 1.76)], 'top', skin, M['grille'], offset=0.02, depth=0.06))
        for i in range(4):
            zz = lerp(1.5, 1.7, i / 3)
            x0, x1 = sx * 0.16, sx * 0.48
            parts.append(rbox('vent_vane', abs(x1 - x0), 0.008, 0.012, 0.0, M['carbon'], pos=((x0 + x1) / 2, skin.y_top((x0 + x1) / 2, zz) - 0.015, zz), rot=(0.5, 0, 0)))
        # louvres over the front wheels
        for i in range(6):
            zz = 1.22 + i * 0.065
            x = B.p(zz, 'shoulder')[0] - 0.12
            cuts.append(projected('louvre', [(sx * (x - 0.1), zz - 0.011), (sx * (x + 0.06), zz - 0.011), (sx * (x + 0.06), zz + 0.011), (sx * (x - 0.1), zz + 0.011)], 'top', skin, M['grille'], offset=0.02, depth=0.05, sub=1))
        side = 'left' if sx > 0 else 'right'
        # tall exit vent between the front wheel and the door, and a brake intake ahead of the rear wheel
        cuts.append(projected('fender_vent', [(0.74, 0.3), (0.84, 0.3), (0.84, 0.74), (0.74, 0.72)], side, skin, M['grille'], offset=0.02, depth=0.06, sub=1))
        for i in range(5):
            y = lerp(0.36, 0.68, i / 4)
            parts.append(projected('vent_slat', [(0.745, y - 0.005), (0.835, y - 0.005), (0.835, y + 0.005), (0.745, y + 0.005)], side, skin, M['carbon'], offset=-0.01, sub=0))
        cuts.append(projected('door_intake', [(-0.88, 0.4), (-0.76, 0.4), (-0.74, 0.66), (-0.86, 0.66)], side, skin, M['grille'], offset=0.02, depth=0.05, sub=1))
        # blanked rear side window: a dark panel with a small round hatch
        poly = []
        for i in range(10):
            z = lerp(S['c_pillar'], S['b_pillar'][0], i / 9)
            poly.append((z, B.p(z, 'belt')[1] + 0.025))
        for i in range(10):
            z = lerp(S['b_pillar'][0], S['win_back'], i / 9)
            poly.append((z, B.p(z, 'rail')[1] - 0.03))
        parts.append(projected('quarter_panel', poly, side, skin, M['carbon'], offset=0.002, sub=2))
        parts.append(projected('hatch', circle(-0.92, 1.02, 0.05, 16), side, skin, M['lens'], offset=0.004, sub=1))
    # splitter with end fences and a centre strake; tow strap
    parts.append(rbox('splitter', 1.9, 0.025, 0.36, 0.008, M['carbon'], pos=(0, 0.06, z1 - 0.08)))
    for sx in (1, -1):
        parts.append(rbox('splitter_fence', 0.012, 0.08, 0.32, 0.004, M['carbon'], pos=(sx * 0.93, 0.1, z1 - 0.1)))
    parts.append(rbox('strake', 0.012, 0.1, 0.32, 0.004, M['carbon'], pos=(0, 0.11, z1 - 0.08)))
    parts.append(rbox('tow', 0.05, 0.012, 0.12, 0.004, M['gold'], pos=(0.5, 0.15, z1 + 0.0), rot=(0.3, 0, 0)))


def rear_gt3(cuts, parts, skin, M, S, B):
    z0 = S['L'][0]
    for sx in (1, -1):
        cuts.append(projected('taillamp', mirror_poly(TAIL_G, sx), 'rear', skin, M['housing'], offset=0.02, depth=0.045, lean=0.55))
        parts.append(projected('tail', mirror_poly([(0.44, 0.76), (0.8, 0.768), (0.8, 0.778), (0.44, 0.77)], sx), 'rear', skin, M['tail'], offset=-0.022, lean=0.55, sub=2))
        parts.append(projected('tail', mirror_poly([(0.78, 0.76), (0.81, 0.762), (0.82, 0.8), (0.79, 0.8)], sx), 'rear', skin, M['tail'], offset=-0.022, lean=0.55, sub=1))
        parts.append(projected('tail_lens', mirror_poly(TAIL_G, sx), 'rear', skin, M['lens_red'], offset=-0.002, lean=0.55))
        side = 'left' if sx > 0 else 'right'
        cuts.append(projected('rear_vent', [(-2.02, 0.42), (-1.93, 0.42), (-1.93, 0.64), (-2.02, 0.64)], side, skin, M['grille'], offset=0.02, depth=0.06, sub=1))
        # wing end plates (big, behind the car) and swan-neck mounts that hang it from above
        parts.append(prism('endplate', [(-2.7, 1.07), (-2.16, 1.11), (-2.16, 1.36), (-2.7, 1.41)], 'x', sx * 0.93, sx * 0.945, M['carbon']))
        parts.append(prism('endplate_edge', [(-2.7, 1.40), (-2.16, 1.35), (-2.16, 1.365), (-2.7, 1.415)], 'x', sx * 0.925, sx * 0.95, M['gold']))
        deck = lambda z: B.p(z, 'roof')[1] - 0.01
        neck = [(-1.78, deck(-1.78)), (-1.95, deck(-1.95)), (-2.4, 1.385), (-2.26, 1.385)]
        parts.append(prism('neck', neck, 'x', sx * 0.42, sx * 0.44, M['carbon']))
    foil = [(-0.2, 0.0), (-0.12, 0.026), (0.06, 0.033), (0.2, 0.008), (0.2, -0.004), (0.0, -0.012), (-0.18, -0.007)]
    parts.append(prism('wing', [(-2.38 + u, 1.31 + v) for u, v in foil], 'x', -0.93, 0.93, M['carbon']))
    parts.append(prism('flap', [(-2.6 + u * 0.5, 1.355 + v * 0.7 - u * 0.3) for u, v in foil], 'x', -0.93, 0.93, M['carbon']))
    # side exhaust: one big tip under the front of the door on the right, as on the car
    z = 0.8
    x = skin.x(0.16, z, -1)
    o = revolve('tip', [(-x - 0.05, 0.062), (-x + 0.08, 0.062), (-x + 0.08, 0.052), (-x - 0.04, 0.052)], M['carbon'], seg=20)
    o.location = (0, 0.16, z); parts.append(o)
    parts.append(prism('tip_in', circle(z, 0.16, 0.052, 16), 'x', -x + 0.015, -x + 0.02, M['well']))
    # big diffuser with fins, open rear bumper mesh, plate
    parts.append(rbox('diffuser', 1.6, 0.03, 0.5, 0.0, M['carbon'], pos=(0, 0.15, z0 + 0.18), rot=(-0.24, 0, 0)))
    for i in range(-3, 4):
        parts.append(rbox('fin', 0.012, 0.18, 0.44, 0.0, M['carbon'], pos=(i * 0.22, 0.2, z0 + 0.14)))
    cuts.append(projected('rear_mesh', [(-0.7, 0.26), (0.7, 0.26), (0.68, 0.48), (-0.68, 0.48)], 'rear', skin, M['grille'], offset=0.02, depth=0.06, sub=2))
    cuts.append(prism('plate', rrect(0, 0.62, 0.5, 0.11, 0.02), 'z', -3, z0 + 0.03, M['trim']))
    parts.append(rbox('tow', 0.05, 0.012, 0.12, 0.004, M['gold'], pos=(-0.45, 0.28, z0 - 0.02), rot=(-0.3, 0, 0)))
    # roof: a tall aerial and a short one, as in the photos
    parts.append(rbox('aerial', 0.006, 0.32, 0.006, 0.0, M['carbon'], pos=(0, B.p(-0.25, 'roof')[1] + 0.16, -0.25)))
    parts.append(rbox('aerial2', 0.006, 0.18, 0.006, 0.0, M['carbon'], pos=(0, B.p(-0.4, 'roof')[1] + 0.09, -0.4)))


# ------------------------------------------------------------------ export + preview
def export(objs, path):
    bpy.ops.object.select_all(action='DESELECT')
    for o in objs: o.select_set(True)
    bpy.context.view_layer.objects.active = objs[0]
    kw = dict(filepath=path, export_format='GLB', use_selection=True, export_yup=False, export_apply=True,
              export_texcoords=False, export_normals=True, export_materials='EXPORT',
              export_draco_mesh_compression_enable=True, export_draco_mesh_compression_level=6,
              export_draco_position_quantization=14, export_draco_normal_quantization=10)
    try:
        bpy.ops.export_scene.gltf(**kw)
    except TypeError as e:
        print('export option fallback:', e)
        for k in ('export_draco_position_quantization', 'export_draco_normal_quantization', 'export_texcoords'):
            kw.pop(k, None)
        bpy.ops.export_scene.gltf(**kw)


def preview(S, body, wheel, cal, path):
    root = link(bpy.data.objects.new('root', None))
    root.rotation_euler = (math.radians(90), 0, 0)   # site frame (y up) -> Blender (z up)
    body.parent = root
    for i, za in enumerate(S['axles']):
        for side in (1, -1):
            for src in (wheel, cal):
                o = link(bpy.data.objects.new(src.name + '_i', src.data))
                o.parent = root
                o.location = (side * S['track'][i], S['wheel']['r'], za)
                ry = (math.pi if side < 0 else 0) + (0.25 if i == 0 else 0)
                o.rotation_euler = (0, ry, 0)
    wheel.hide_render = True; cal.hide_render = True
    sc = bpy.context.scene
    sc.render.engine = 'CYCLES'
    sc.cycles.samples = 40; sc.cycles.use_denoising = True
    sc.render.resolution_x, sc.render.resolution_y = 1280, 720
    sc.view_settings.view_transform = 'AgX'
    w = bpy.data.worlds.new('w'); sc.world = w
    try: w.use_nodes = True
    except Exception: pass
    bg = w.node_tree.nodes.get('Background')
    bg.inputs[0].default_value = (0.32, 0.33, 0.36, 1); bg.inputs[1].default_value = 0.6
    floor = bpy.data.meshes.new('floor')
    floor.from_pydata([(-20, -20, 0), (20, -20, 0), (20, 20, 0), (-20, 20, 0)], [], [(0, 1, 2, 3)])
    link(bpy.data.objects.new('floor', floor))
    floor.materials.append(mat('floor', (0.09, 0.09, 0.1), rough=0.45))
    for (loc, energy, size) in (((4, -3, 6), 900, 5), ((-5, 2, 4), 400, 6), ((0, 6, 3), 300, 4)):
        ld = bpy.data.lights.new('l', 'AREA'); ld.energy = energy; ld.size = size
        lo = link(bpy.data.objects.new('l', ld)); lo.location = loc
        tc = lo.constraints.new('TRACK_TO'); tc.target = root
    cam_d = bpy.data.cameras.new('cam'); cam_d.lens = 50
    cam = link(bpy.data.objects.new('cam', cam_d)); sc.camera = cam
    tgt = link(bpy.data.objects.new('tgt', None))
    tc = cam.constraints.new('TRACK_TO'); tc.target = tgt; tc.track_axis = 'TRACK_NEGATIVE_Z'; tc.up_axis = 'UP_Y'
    for tag, az, el, d, t in (('front34', 35, 12, 8.6, (0, 0, 0.55)), ('rear34', 145, 14, 8.6, (0, 0, 0.55)),
                              ('side', 90, 3, 9.0, (0, 0, 0.6)), ('front', 0, 6, 7.5, (0, 0, 0.55)),
                              ('rear', 180, 8, 7.5, (0, 0, 0.6)), ('close', 22, 8, 4.8, (0.4, -1.7, 0.6))):
        a, e = math.radians(az), math.radians(el)
        cam.location = (d * math.sin(a) * math.cos(e), -d * math.cos(a) * math.cos(e), 0.6 + d * math.sin(e))
        tgt.location = t
        sc.render.filepath = os.path.join(path, f"{S['key']}_{tag}.png")
        bpy.ops.render.render(write_still=True)
    # an orthographic side view (no perspective), for comparing with reference drawings
    cam_d.type = 'ORTHO'; cam_d.ortho_scale = (S['L'][1] - S['L'][0]) * 1.06
    sc.render.resolution_x, sc.render.resolution_y = 1280, 480
    cam.location = (12, 0, 0.62); tgt.location = (0, 0, 0.62)
    sc.render.filepath = os.path.join(path, f"{S['key']}_ortho_side.png")
    bpy.ops.render.render(write_still=True)
    cam_d.type = 'PERSP'


def main():
    os.makedirs(OUT, exist_ok=True)
    for S in (M240I, GT3):
        if ONLY and S['key'] != ONLY: continue
        body, wheel, cal, M = build_car(S)
        tri = lambda o: sum(len(p.vertices) - 2 for p in o.data.polygons)
        print(f"[{S['key']}] triangles: body {tri(body)}, wheel {tri(wheel)}, caliper {tri(cal)}, whole car {tri(body) + 4 * (tri(wheel) + tri(cal))}")
        export([body, wheel, cal], os.path.join(OUT, S['key'] + '.glb'))
        if PREVIEW:
            preview(S, body, wheel, cal, os.path.join(OUT, '_preview'))


main()
