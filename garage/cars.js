import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { DRACOLoader } from 'three/addons/loaders/DRACOLoader.js';

/* =========================================================
   Procedural cars, built from code (no model files).
   Car faces +z, x is the car's left, y is up, ground at y = 0.
   ========================================================= */

const lerp = (a, b, t) => a + (b - a) * t;

// Smooth (Catmull-Rom) interpolation through [[z, value], ...] keys
function interp(tbl, z) {
  const n = tbl.length;
  if (z <= tbl[0][0]) return tbl[0][1];
  if (z >= tbl[n - 1][0]) return tbl[n - 1][1];
  let i = 1;
  while (tbl[i][0] < z) i++;
  const p0 = tbl[Math.max(i - 2, 0)], p1 = tbl[i - 1], p2 = tbl[i], p3 = tbl[Math.min(i + 1, n - 1)];
  const h = p2[0] - p1[0], t = (z - p1[0]) / h;
  const m1 = ((p2[1] - p0[1]) / (p2[0] - p0[0] || 1)) * h;
  const m2 = ((p3[1] - p1[1]) / (p3[0] - p1[0] || 1)) * h;
  const t2 = t * t, t3 = t2 * t;
  return (2 * t3 - 3 * t2 + 1) * p1[1] + (t3 - 2 * t2 + t) * m1 + (-2 * t3 + 3 * t2) * p2[1] + (t3 - t2) * m2;
}

/* Loft: sweeps a rounded cross-section along z.
   fn(z) -> { yb, yt, hw, hwT, hwB, n, mid } */
function loft(z0, z1, step, fn, round = 0.12) {
  const R = 30;
  const rows = [];
  for (let z = z0; z < z1 - 1e-6; z += step) rows.push(z);
  rows.push(z1);
  const pos = [];
  const ring = (z) => {
    const s = fn(z);
    let { yb, yt, hw } = s;
    let hwT = s.hwT ?? hw * 0.8, hwB = s.hwB ?? hw * 0.92;
    // round off the two ends so the nose and tail aren't flat slabs
    const d = Math.min(z - z0, z1 - z);
    if (d < round) {
      const f = Math.sqrt(1 - Math.pow(1 - d / round, 2));
      const k = lerp(s.pinch ?? 0.86, 1, f);
      hw *= k; hwT *= k; hwB *= k;
      const ymid = (yb + yt) / 2;
      yt = ymid + (yt - ymid) * lerp(0.75, 1, f);
      yb = ymid + (yb - ymid) * lerp(0.75, 1, f);
    }
    let ym = yb + (yt - yb) * (s.mid ?? 0.5);
    const out = [];
    // separate squareness for the upper (shoulders) and lower half
    const eT = 2 / (s.nT ?? s.n ?? 3), eB = 2 / (s.nB ?? s.n ?? 3);
    for (let k = 0; k < R; k++) {
      const th = (k / R) * Math.PI * 2 - Math.PI / 2;
      const c = Math.cos(th), sn = Math.sin(th);
      const e = sn > 0 ? eT : eB;
      const px = Math.sign(c) * Math.pow(Math.abs(c), e);
      const py = Math.sign(sn) * Math.pow(Math.abs(sn), e);
      const w = py > 0 ? lerp(hw, hwT, py) : lerp(hw, hwB, -py);
      const y = py > 0 ? ym + py * (yt - ym) : ym + py * (ym - yb);
      out.push(px * w, y, z);
    }
    return out;
  };
  const rings = rows.map(ring);
  rings.forEach((r) => pos.push(...r));
  const idx = [];
  for (let i = 0; i < rows.length - 1; i++) {
    for (let k = 0; k < R; k++) {
      const a = i * R + k, b = i * R + ((k + 1) % R), c = (i + 1) * R + k, d = (i + 1) * R + ((k + 1) % R);
      idx.push(a, b, c, b, d, c);
    }
  }
  // end caps (own vertices so the body keeps crisp normals)
  const cap = (r, front) => {
    const base = pos.length / 3;
    let cx = 0, cy = 0;
    for (let k = 0; k < R; k++) cy += r[k * 3 + 1];
    cy /= R;
    pos.push(cx, cy, r[2]);
    for (let k = 0; k < R; k++) pos.push(r[k * 3], r[k * 3 + 1], r[k * 3 + 2]);
    for (let k = 0; k < R; k++) {
      const a = base + 1 + k, b = base + 1 + ((k + 1) % R);
      if (front) idx.push(base, a, b); else idx.push(base, b, a);
    }
  };
  cap(rings[rings.length - 1], true);
  cap(rings[0], false);
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

/* Skin: a thin layer over chosen strips of a loft (pillars, shut lines, sills), so detail
   follows the body's curves. keep(k, z) picks strips by ring position k (0 = underside,
   7-8 = the +x side, 15 = top, 22-23 = the -x side) and z. Pushed out along the normals. */
const R_LOFT = 30;
const sides = (k, a, b) => (k >= a && k <= b) || (R_LOFT - 1 - k >= a && R_LOFT - 1 - k <= b);
function skin(g, keep, out = 0.004) {
  const P = g.attributes.position, N = g.attributes.normal, I = g.index.array;
  const ringVerts = P.count - 2 * (R_LOFT + 1); // the two end caps come last
  const pos = new Float32Array(P.count * 3);
  for (let v = 0; v < P.count; v++) {
    pos[v * 3] = P.getX(v) + N.getX(v) * out;
    pos[v * 3 + 1] = P.getY(v) + N.getY(v) * out;
    pos[v * 3 + 2] = P.getZ(v) + N.getZ(v) * out;
  }
  const idx = [];
  for (let t = 0; t < I.length; t += 3) {
    const a = I[t], b = I[t + 1], c = I[t + 2];
    if (a >= ringVerts || b >= ringVerts || c >= ringVerts) continue;
    const z = (P.getZ(a) + P.getZ(c)) / 2;
    if (keep(c % R_LOFT, z)) idx.push(a, b, c);
  }
  const s = new THREE.BufferGeometry();
  s.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  s.setAttribute('normal', N.clone());
  s.setIndex(idx);
  return s;
}
// x of the body's outer surface at height y and position z (for placing small parts)
const _ray = new THREE.Raycaster();
function sideX(mesh, y, z) {
  _ray.set(new THREE.Vector3(3, y, z), new THREE.Vector3(-1, 0, 0));
  const hit = _ray.intersectObject(mesh)[0];
  return hit ? hit.point.x : 0.85;
}
/* Door shut lines, a handle and a dark sill on both sides of a body loft */
function doors(g, bodyGeo, bodyMesh, front, rear, axles, wr, sillMat) {
  const line = M.gloss();
  g.add(new THREE.Mesh(skin(bodyGeo, (k, z) => sides(k, 4, 11) && (Math.abs(z - front) < 0.018 || Math.abs(z - rear) < 0.018), 0.002), line));
  g.add(new THREE.Mesh(skin(bodyGeo, (k, z) => sides(k, 3, 4) && z > axles[1] + wr + 0.1 && z < axles[0] - wr - 0.1, 0.003), sillMat));
  const hz = rear + 0.24, hy = 0.84;
  for (const sx of [-1, 1]) {
    const x = sideX(bodyMesh, hy, hz);
    const h = rbox(0.022, 0.03, 0.17, 0.012, M.trim());
    h.position.set(sx * (x + 0.006), hy, hz);
    g.add(h);
  }
}

/* Pillars on the glass cabin: a flush roof panel (r0..r1), roof rails that run down as the
   A-pillars, a C-pillar ending at cEdge, a black B-pillar, and (optionally) a chrome line
   along the bottom of the side windows from cEdge to wEnd. */
function pillars(g, cab, roofMat, paint, r0, r1, cEdge, beltline, wEnd = 0.9) {
  g.add(new THREE.Mesh(skin(cab, (k, z) => k >= 12 && k <= 17 && z > r0 && z < r1), roofMat));
  g.add(new THREE.Mesh(skin(cab, (k, z) => (k === 12 || k === 17) && !(z > r0 && z < r1)), paint));
  g.add(new THREE.Mesh(skin(cab, (k, z) => sides(k, 8, 11) && z < cEdge), paint));
  g.add(new THREE.Mesh(skin(cab, (k, z) => sides(k, 8, 11) && z > -0.24 && z < -0.15, 0.003), M.gloss()));
  if (!beltline) return;
  const P = cab.attributes.position, N = cab.attributes.normal;
  const rows = (P.count - 2 * (R_LOFT + 1)) / R_LOFT;
  for (const v of [8, R_LOFT - 8]) {
    const pts = [];
    for (let i = 0; i < rows; i++) {
      const j = i * R_LOFT + v, z = P.getZ(j);
      if (z < cEdge - 0.02 || z > wEnd) continue;
      pts.push(new THREE.Vector3(P.getX(j) + N.getX(j) * 0.006, P.getY(j) + N.getY(j) * 0.006, z));
    }
    if (pts.length > 1) g.add(new THREE.Mesh(new THREE.TubeGeometry(new THREE.CatmullRomCurve3(pts), pts.length * 2, 0.007, 6), beltline));
  }
}

/* ---------- shared materials ---------- */
const env = (m, v) => { m.userData.env = v; return m; }; // reflection strength hint
const M = {
  glass: () => env(new THREE.MeshPhysicalMaterial({ color: 0x050608, metalness: 0, roughness: 0.04, clearcoat: 1, clearcoatRoughness: 0.03 }), 0.3),
  trim: () => new THREE.MeshStandardMaterial({ color: 0x0b0b0c, roughness: 0.55, metalness: 0.2 }),
  gloss: () => new THREE.MeshPhysicalMaterial({ color: 0x050506, roughness: 0.2, metalness: 0.3, clearcoat: 1 }),
  chrome: () => new THREE.MeshStandardMaterial({ color: 0xd8d8d8, roughness: 0.12, metalness: 1 }),
  tire: () => new THREE.MeshStandardMaterial({ color: 0x141414, roughness: 0.92, metalness: 0 }),
  well: () => new THREE.MeshStandardMaterial({ color: 0x030303, roughness: 1, metalness: 0 }),
  carbon: () => new THREE.MeshStandardMaterial({ color: 0x111214, roughness: 0.35, metalness: 0.4 }),
  head: () => new THREE.MeshStandardMaterial({ color: 0xffffff, emissive: 0xfff1d6, emissiveIntensity: 2.2, roughness: 0.2 }),
  tail: () => new THREE.MeshStandardMaterial({ color: 0x400000, emissive: 0xff1a12, emissiveIntensity: 1.1, roughness: 0.3 }),
  amber: () => new THREE.MeshStandardMaterial({ color: 0x402000, emissive: 0xff8a1a, emissiveIntensity: 0.6, roughness: 0.3 }),
};

function box(w, h, d, mat, x = 0, y = 0, z = 0) {
  const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat);
  m.position.set(x, y, z);
  return m;
}
function rbox(w, h, d, r, mat) {
  // rounded rectangle extruded along z
  const s = new THREE.Shape();
  const x = -w / 2, y = -h / 2;
  s.moveTo(x + r, y); s.lineTo(x + w - r, y); s.quadraticCurveTo(x + w, y, x + w, y + r);
  s.lineTo(x + w, y + h - r); s.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
  s.lineTo(x + r, y + h); s.quadraticCurveTo(x, y + h, x, y + h - r);
  s.lineTo(x, y + r); s.quadraticCurveTo(x, y, x + r, y);
  const g = new THREE.ExtrudeGeometry(s, { depth: d, bevelEnabled: true, bevelThickness: 0.008, bevelSize: 0.006, bevelSegments: 2, curveSegments: 6 });
  g.translate(0, 0, -d / 2);
  return new THREE.Mesh(g, mat);
}

/* ---------- wheels ---------- */
function makeWheel(o) {
  const { r, w, rim, style, rimColor, caliperColor } = o;
  const pivot = new THREE.Group();   // steers
  const spin = new THREE.Group();    // rolls
  pivot.add(spin);
  const hw = w / 2;
  // tyre: lathe profile revolved around y, then turned so the axle is x
  const pts = [
    new THREE.Vector2(rim * 0.98, -hw + 0.01), new THREE.Vector2(r - 0.035, -hw),
    new THREE.Vector2(r - 0.008, -hw + 0.025), new THREE.Vector2(r, -hw + 0.06),
    new THREE.Vector2(r, hw - 0.06), new THREE.Vector2(r - 0.008, hw - 0.025),
    new THREE.Vector2(r - 0.035, hw), new THREE.Vector2(rim * 0.98, hw - 0.01),
  ];
  const tire = new THREE.Mesh(new THREE.LatheGeometry(pts, 44), M.tire());
  tire.rotation.z = Math.PI / 2;
  spin.add(tire);
  const rimMat = new THREE.MeshStandardMaterial({ color: rimColor, metalness: 0.9, roughness: style === 'race' ? 0.45 : 0.22 });
  // barrel
  const barrel = new THREE.Mesh(new THREE.CylinderGeometry(rim, rim, w * 0.86, 36, 1, true), new THREE.MeshStandardMaterial({ color: 0x2a2a2a, metalness: 0.8, roughness: 0.4, side: THREE.DoubleSide }));
  barrel.rotation.z = Math.PI / 2;
  spin.add(barrel);
  // rim lip
  const lip = new THREE.Mesh(new THREE.TorusGeometry(rim * 0.985, 0.012, 8, 40), rimMat);
  lip.rotation.y = Math.PI / 2;
  lip.position.x = hw - 0.02;
  spin.add(lip);
  // dark centre disc behind the spokes
  const back = new THREE.Mesh(new THREE.CircleGeometry(rim * 0.97, 36), new THREE.MeshStandardMaterial({ color: 0x0c0c0c, roughness: 0.8 }));
  back.rotation.y = Math.PI / 2;
  back.position.x = hw - 0.11;
  spin.add(back);
  // brake disc (spins) + caliper (doesn't)
  const disc = new THREE.Mesh(new THREE.CylinderGeometry(rim * 0.82, rim * 0.82, 0.03, 32), new THREE.MeshStandardMaterial({ color: 0x777777, metalness: 0.9, roughness: 0.35 }));
  disc.rotation.z = Math.PI / 2;
  disc.position.x = hw - 0.095;
  spin.add(disc);
  const cal = box(0.06, rim * 0.5, rim * 0.34, new THREE.MeshStandardMaterial({ color: caliperColor, roughness: 0.4, metalness: 0.3 }), hw - 0.07, rim * 0.55, -rim * 0.3);
  cal.rotation.x = 0.5;
  pivot.add(cal);
  // spokes
  const fx = hw - 0.035;
  const hub = rim * 0.2;
  const len = rim * 0.96 - hub;
  const addSpoke = (a, thick, width) => {
    const s = new THREE.Mesh(new THREE.BoxGeometry(thick, len, width), rimMat);
    s.position.set(fx, Math.cos(a) * (hub + len / 2), Math.sin(a) * (hub + len / 2));
    s.rotation.x = a;
    spin.add(s);
  };
  if (style === 'road') {
    // double five-spoke
    for (let i = 0; i < 5; i++) {
      const a = (i / 5) * Math.PI * 2;
      addSpoke(a - 0.13, 0.03, 0.04);
      addSpoke(a + 0.13, 0.03, 0.04);
    }
  } else {
    // ten-spoke race wheel with centre lock
    for (let i = 0; i < 10; i++) addSpoke((i / 10) * Math.PI * 2, 0.035, 0.03);
  }
  const cap = new THREE.Mesh(new THREE.CylinderGeometry(hub, hub, 0.05, style === 'race' ? 6 : 24), style === 'race' ? new THREE.MeshStandardMaterial({ color: 0xd4af6a, metalness: 1, roughness: 0.25 }) : rimMat);
  cap.rotation.z = Math.PI / 2;
  cap.position.x = fx + 0.01;
  spin.add(cap);
  pivot.traverse((m) => { if (m.isMesh) { m.castShadow = true; } });
  return { pivot, spin };
}

/* ---------- car definitions ---------- */
const SPECS = {
  m240i: {
    key: 'm240i',
    name: 'M240i',
    tag: 'Road',
    blurb: 'My daily. Smooth, playful and forgiving.',
    stats: [['Power', '335 hp'], ['Drive', 'Rear-wheel'], ['Tyres', 'Street']],
    bars: { speed: 0.72, grip: 0.62, braking: 0.6 },
    // F22 M240i: 4432 long, 2690 wheelbase, 18in wheels (matches models/build_cars.py)
    L: [-2.216, 2.216], axles: [1.436, -1.254], wheel: { r: 0.318, w: 0.235, rim: 0.229, style: 'road', rimColor: 0x6a6d72, caliperColor: 0x1f4fbf }, track: [0.76, 0.778],
    // Mineral Grey metallic
    paint: () => env(new THREE.MeshPhysicalMaterial({ color: 0x3a3f47, metalness: 0.45, roughness: 0.38, clearcoat: 1, clearcoatRoughness: 0.08 }), 0.5),
    // physics
    phys: { maxSpeed: 69, accel: 7.2, brake: 11, grip: 9, steer: 0.52, mass: 1.0 },
  },
  gt3: {
    key: 'gt3',
    name: 'GT3',
    tag: 'Race',
    blurb: 'Built for the track. Fast, sharp and unforgiving.',
    stats: [['Power', '590 hp'], ['Drive', 'Rear-wheel'], ['Tyres', 'Slicks']],
    bars: { speed: 0.95, grip: 0.92, braking: 0.95 },
    // M4 GT3: 2917 wheelbase, body length as measured from side-on photos, 18in centre-lock wheels (matches models/build_cars.py)
    L: [-2.41, 2.17], axles: [1.44, -1.477], wheel: { r: 0.345, w: 0.31, rim: 0.229, style: 'race', rimColor: 0x1a1a1a, caliperColor: 0xc9a45c }, track: [0.87, 0.875],
    // satin black
    paint: () => env(new THREE.MeshPhysicalMaterial({ color: 0x0b0b0d, metalness: 0.2, roughness: 0.55, clearcoat: 0.3, clearcoatRoughness: 0.45 }), 0.3),
    phys: { maxSpeed: 79, accel: 9.6, brake: 17, grip: 13, steer: 0.48, mass: 1.0 },
  },
};
export const CAR_SPECS = SPECS;

function archLift(z, axles, r, yc) {
  let y = -1;
  for (const za of axles) {
    const dz = z - za;
    if (Math.abs(dz) < r) y = Math.max(y, yc + Math.sqrt(r * r - dz * dz));
  }
  return y;
}
function bump(z, axles, width) {
  let b = 0;
  for (const za of axles) {
    const t = Math.abs(z - za) / width;
    if (t < 1) b = Math.max(b, Math.cos(t * Math.PI / 2) ** 1.4);
  }
  return b;
}

function bodyM240i(paint) {
  const S = SPECS.m240i;
  const g = new THREE.Group();
  const [z0, z1] = S.L;
  const ax = S.axles, wr = S.wheel.r;
  const YT = [[z0, 0.7], [-2.14, 0.89], [-1.95, 0.965], [-1.6, 0.99], [-1.0, 0.97], [0, 0.945], [0.9, 0.915], [1.5, 0.87], [1.95, 0.815], [2.13, 0.76], [z1, 0.7]];
  const YB = [[z0, 0.34], [-2.05, 0.24], [-1.8, 0.2], [1.85, 0.2], [2.1, 0.24], [z1, 0.3]];
  const HW = [[z0, 0.74], [-2.08, 0.84], [-1.6, 0.88], [-1.26, 0.885], [-0.3, 0.865], [0.6, 0.865], [1.43, 0.875], [1.9, 0.85], [2.12, 0.8], [z1, 0.72]];
  const body = loft(z0, z1, 0.035, (z) => {
    const arch = archLift(z, ax, wr + 0.065, wr);
    const hw = interp(HW, z) + 0.012 * bump(z, ax, 0.55);
    return { yb: Math.max(interp(YB, z), arch), yt: interp(YT, z), hw, hwT: hw * 0.84, hwB: hw * 0.94, nT: 5.5, nB: 3, mid: 0.6, pinch: 0.9 };
  }, 0.1);
  const bodyMesh = new THREE.Mesh(body, paint);
  g.add(bodyMesh);
  bodyMesh.updateMatrixWorld();
  doors(g, body, bodyMesh, 0.98, -0.42, ax, wr + 0.065, M.trim());

  // greenhouse
  const CT = [[-1.62, 0.97], [-1.3, 1.1], [-0.85, 1.3], [-0.35, 1.392], [0.2, 1.39], [0.55, 1.25], [0.85, 1.07], [1.08, 0.92]];
  const CW = [[-1.62, 0.7], [-0.6, 0.75], [0.4, 0.75], [1.08, 0.74]];
  const CWT = [[-1.62, 0.62], [-0.8, 0.57], [0.2, 0.57], [1.08, 0.63]];
  const cab = loft(-1.62, 1.08, 0.04, (z) => {
    const yt = interp(CT, z);
    const yb = Math.min(interp(YT, z) - 0.07, yt - 0.02);
    return { yb, yt, hw: interp(CW, z), hwT: interp(CWT, z), hwB: interp(CW, z) * 0.98, n: 2.6, mid: 0.25 };
  }, 0.02);
  g.add(new THREE.Mesh(cab, M.glass()));
  pillars(g, cab, paint, paint, -0.95, 0.42, -1.08, M.chrome(), 0.86);

  // kidney grille
  const grilleMat = M.gloss();
  for (const sx of [-1, 1]) {
    const k = rbox(0.2, 0.15, 0.05, 0.045, grilleMat);
    k.position.set(sx * 0.125, 0.66, 2.2);
    k.rotation.x = -0.35;
    g.add(k);
    const surround = rbox(0.216, 0.166, 0.03, 0.05, M.chrome());
    surround.position.set(sx * 0.125, 0.658, 2.185);
    surround.rotation.x = -0.35;
    g.add(surround);
    // headlights: dark lens with twin "corona" rings
    const lens = rbox(0.44, 0.13, 0.08, 0.04, M.glass());
    lens.position.set(sx * 0.53, 0.71, 2.08);
    lens.rotation.set(-0.15, sx * 0.48, sx * -0.1);
    g.add(lens);
    for (const off of [-0.085, 0.085]) {
      const ring = new THREE.Mesh(new THREE.TorusGeometry(0.048, 0.008, 8, 28), M.head());
      ring.position.set(sx * (0.53 + off * 0.88), 0.71, 2.1 + (sx * off > 0 ? -0.045 : 0.045));
      ring.rotation.y = sx * 0.48;
      g.add(ring);
    }
    // amber marker in the bumper corner
    const mk = box(0.1, 0.025, 0.03, M.amber(), sx * 0.74, 0.5, 2.03);
    mk.rotation.y = sx * 0.6;
    g.add(mk);
    // M-sport side intakes
    const side = rbox(0.26, 0.13, 0.06, 0.035, M.trim());
    side.position.set(sx * 0.58, 0.42, 2.16);
    side.rotation.y = sx * 0.38;
    g.add(side);
    // taillights (L-shape)
    const t1 = box(0.32, 0.06, 0.05, M.tail(), sx * 0.57, 0.86, -2.12);
    t1.rotation.y = sx * -0.38;
    const t2 = box(0.06, 0.12, 0.05, M.tail(), sx * 0.72, 0.8, -2.03);
    t2.rotation.y = sx * -0.5;
    g.add(t1, t2);
    // mirrors
    const mir = rbox(0.14, 0.085, 0.1, 0.035, paint); // rounded mirror housing
    mir.position.set(sx * 0.87, 0.99, 0.82);
    mir.rotation.y = sx * -0.12;
    const stem = box(0.08, 0.03, 0.04, M.trim(), sx * 0.8, 0.97, 0.84);
    g.add(mir, stem);
  }
  g.add(box(0.62, 0.13, 0.05, M.trim(), 0, 0.42, 2.2));
  // one single exhaust tip at each corner of the rear bumper
  for (const sx of [-1, 1]) {
    const tip = new THREE.Mesh(new THREE.CylinderGeometry(0.048, 0.048, 0.16, 18), M.chrome());
    tip.rotation.x = Math.PI / 2;
    tip.position.set(sx * 0.52, 0.27, -2.2);
    g.add(tip);
    const inner = new THREE.Mesh(new THREE.CircleGeometry(0.038, 18), M.well());
    inner.rotation.y = Math.PI;
    inner.position.set(sx * 0.52, 0.27, -2.281);
    g.add(inner);
  }
  // number-plate recess (left blank on purpose)
  g.add(box(0.5, 0.11, 0.02, M.trim(), 0, 0.62, -2.205));
  return g;
}

function bodyGT3(paint) {
  const S = SPECS.gt3;
  const g = new THREE.Group();
  const [z0, z1] = S.L;
  const ax = S.axles, wr = S.wheel.r;
  const gold = new THREE.MeshStandardMaterial({ color: 0xc9a45c, metalness: 1, roughness: 0.28 });
  const YT = [[z0, 0.82], [-2.36, 0.95], [-2.0, 0.985], [-1.5, 0.985], [-0.8, 0.93], [0.2, 0.9], [1.0, 0.86], [1.5, 0.8], [2.0, 0.68], [2.3, 0.56], [z1, 0.47]];
  const YB = [[z0, 0.34], [-2.25, 0.2], [-1.9, 0.12], [2.1, 0.11], [z1, 0.16]];
  const HW = [[z0, 0.86], [-2.3, 0.9], [-1.9, 0.9], [-0.6, 0.87], [0.6, 0.87], [1.9, 0.9], [2.3, 0.87], [z1, 0.8]];
  const body = loft(z0, z1, 0.035, (z) => {
    const arch = archLift(z, ax, wr + 0.06, wr);
    const fl = bump(z, ax, 0.58);
    const hw = interp(HW, z) + 0.12 * fl;
    return { yb: Math.max(interp(YB, z), arch), yt: interp(YT, z) + 0.035 * fl, hw, hwT: hw * (0.84 - 0.06 * fl), hwB: hw * 0.95, nT: 6, nB: 3, mid: 0.55, pinch: 0.9 };
  }, 0.1);
  const bodyMesh = new THREE.Mesh(body, paint);
  g.add(bodyMesh);
  bodyMesh.updateMatrixWorld();
  doors(g, body, bodyMesh, 0.95, -0.5, ax, wr + 0.06, M.carbon());

  const CT = [[-1.75, 0.95], [-1.35, 1.03], [-0.85, 1.2], [-0.35, 1.262], [0.15, 1.26], [0.5, 1.14], [0.85, 1.0], [1.12, 0.88]];
  const CW = [[-1.75, 0.68], [-0.6, 0.72], [0.4, 0.72], [1.12, 0.72]];
  const CWT = [[-1.75, 0.58], [-0.8, 0.54], [0.2, 0.54], [1.12, 0.6]];
  const cab = loft(-1.75, 1.12, 0.04, (z) => {
    const yt = interp(CT, z);
    const yb = Math.min(interp(YT, z) - 0.06, yt - 0.02);
    return { yb, yt, hw: interp(CW, z), hwT: interp(CWT, z), hwB: interp(CW, z) * 0.98, n: 2.8, mid: 0.25 };
  }, 0.02);
  g.add(new THREE.Mesh(cab, M.glass()));
  pillars(g, cab, gold, paint, -0.9, 0.35, -1.2, null);

  const carbon = M.carbon();
  // splitter + canards
  g.add(box(1.96, 0.025, 0.3, carbon, 0, 0.1, 2.38));
  for (const sx of [-1, 1]) {
    const c = box(0.05, 0.02, 0.22, carbon, sx * 0.86, 0.32, 2.2);
    c.rotation.set(0.25, sx * 0.4, sx * 0.15);
    g.add(c);
    // headlights: dark lens + twin rings
    const lens = rbox(0.42, 0.1, 0.07, 0.035, M.glass());
    lens.position.set(sx * 0.56, 0.6, 2.24);
    lens.rotation.set(-0.35, sx * 0.5, 0);
    g.add(lens);
    for (const off of [-0.08, 0.08]) {
      const ring = new THREE.Mesh(new THREE.TorusGeometry(0.04, 0.007, 8, 24), M.head());
      ring.position.set(sx * (0.56 + off * 0.88), 0.6, 2.26 + (sx * off > 0 ? -0.04 : 0.04));
      ring.rotation.y = sx * 0.5;
      g.add(ring);
    }
    // taillight bar
    const t = box(0.4, 0.05, 0.04, M.tail(), sx * 0.56, 0.86, -2.45);
    t.rotation.y = sx * -0.2;
    g.add(t);
    // mirrors (gold)
    const mir = rbox(0.15, 0.08, 0.1, 0.032, gold); // rounded mirror housing
    mir.position.set(sx * 0.86, 0.98, 0.9);
    mir.rotation.y = sx * -0.12;
    g.add(mir);
    g.add(box(0.1, 0.025, 0.04, M.trim(), sx * 0.78, 0.96, 0.92));
    // swan-neck wing uprights
    const up = box(0.025, 0.42, 0.12, carbon, sx * 0.48, 1.12, -2.18);
    up.rotation.x = -0.35;
    g.add(up);
    // wing endplates (carbon with a gold edge)
    g.add(box(0.015, 0.26, 0.46, carbon, sx * 0.92, 1.3, -2.32));
    g.add(box(0.018, 0.02, 0.46, gold, sx * 0.92, 1.44, -2.32));
  }
  // kidney openings (blacked out, no badge)
  for (const sx of [-1, 1]) {
    const k = rbox(0.27, 0.2, 0.05, 0.05, M.gloss());
    k.position.set(sx * 0.16, 0.42, 2.44);
    k.rotation.x = -0.45;
    g.add(k);
  }
  g.add(box(1.3, 0.12, 0.05, M.trim(), 0, 0.24, 2.47));
  // wing main plane + flap
  const wing = box(1.82, 0.025, 0.34, carbon, 0, 1.33, -2.33);
  wing.rotation.x = 0.08;
  const flap = box(1.82, 0.02, 0.14, carbon, 0, 1.39, -2.52);
  flap.rotation.x = 0.45;
  g.add(wing, flap);
  // diffuser with fins
  const diff = box(1.5, 0.03, 0.42, carbon, 0, 0.2, -2.32);
  diff.rotation.x = -0.28;
  g.add(diff);
  for (let i = -3; i <= 3; i++) g.add(box(0.012, 0.13, 0.36, carbon, i * 0.2, 0.22, -2.36));
  // side-exit exhausts (left side, ahead of the rear wheel)
  for (const off of [-0.08, 0.08]) {
    const tip = new THREE.Mesh(new THREE.CylinderGeometry(0.045, 0.05, 0.12, 16), M.carbon());
    tip.rotation.z = Math.PI / 2;
    tip.position.set(0.93, 0.24, -0.72 + off);
    g.add(tip);
  }
  // gold side stripe decal
  for (const sx of [-1, 1]) {
    const stripe = new THREE.Mesh(new THREE.PlaneGeometry(2.6, 0.035), gold);
    stripe.position.set(sx * 0.885, 0.55, 0.05);
    stripe.rotation.y = sx * Math.PI / 2;
    g.add(stripe);
  }
  return g;
}

/* ---------- Blender models ----------
   models/build_cars.py builds each car in Blender and exports models/<key>.glb with three parts:
   body, wheel (the rolling part) and caliper. Materials are matched by name and swapped for the
   site's own, so the cars keep their paint, reflections and brake lights. Until a model has loaded
   (or if it fails), the procedural car below is used. */
const MODELS = {};          // key -> { body, wheel, caliper }
const waiting = [];         // cars built before their model arrived
let loading = null;

export function loadCarModels(manager) {
  if (loading) return loading;
  const draco = new DRACOLoader(manager);
  draco.setDecoderPath(new URL('../vendor/three/examples/jsm/libs/draco/gltf/', import.meta.url).href);
  const loader = new GLTFLoader(manager);
  loader.setDRACOLoader(draco);
  loading = Promise.all(Object.keys(SPECS).map((key) =>
    loader.loadAsync(new URL(`./models/${key}.glb?v=7`, import.meta.url).href)
      .then((g) => {
        const part = (n) => g.scene.getObjectByName(n);
        MODELS[key] = { body: part('body'), wheel: part('wheel'), caliper: part('caliper') };
        for (let i = waiting.length - 1; i >= 0; i--) if (waiting[i].key === key) useModel(waiting.splice(i, 1)[0]);
      })
      .catch((e) => console.warn(`Car model ${key} not loaded, using the built-in one.`, e))
  ));
  return loading;
}

function modelMaterials(S) {
  const W = S.wheel;
  const std = (color, roughness, metalness = 0, extra = {}) => new THREE.MeshStandardMaterial({ color, roughness, metalness, ...extra });
  const see = (o) => ({ transparent: true, depthWrite: false, ...o });
  const made = {};
  const make = {
    paint: () => S.paint(),
    glass: () => env(new THREE.MeshPhysicalMaterial(see({ color: 0x0a0c10, roughness: 0.04, metalness: 0, clearcoat: 1, opacity: 0.55 })), 0.5),
    lens: () => env(new THREE.MeshPhysicalMaterial(see({ color: 0xffffff, roughness: 0.02, opacity: 0.16 })), 0.6),
    lens_red: () => std(0x5a0404, 0.12, 0, see({ opacity: 0.5 })),
    // the model's lamps are larger than the old rings, so they glow a little less
    head: () => Object.assign(M.head(), { emissiveIntensity: 1.3 }),
    chrome: M.chrome, trim: M.trim, gloss: M.gloss, well: M.well, tail: M.tail, amber: M.amber, carbon: M.carbon, tire: M.tire,
    gap: () => std(0x040404, 1),
    housing: () => std(0x16171a, 0.3, 0.8),
    grille: () => std(0x0b0b0c, 0.7),
    interior: () => std(0x141210, 0.8),
    seat: () => std(0x1d1a17, 0.6),
    gold: () => std(0xc9a45c, 0.28, 1),
    rim: () => std(W.rimColor, W.style === 'race' ? 0.45 : 0.22, 0.9),
    barrel: () => std(0x2a2a2a, 0.4, 0.8),
    disc: () => std(0x777777, 0.35, 0.9),
    caliper: () => std(W.caliperColor, 0.4, 0.3),
  };
  return (name) => made[name] || (made[name] = (make[name] || (() => std(0x808080, 0.5)))());
}

const SHADOW_CASTERS = new Set(['paint', 'tire', 'carbon', 'gold', 'well']);

function cloneModel(src, mats) {
  const o = src.clone();
  o.position.set(0, 0, 0); o.rotation.set(0, 0, 0); o.scale.set(1, 1, 1);
  o.traverse((m) => {
    if (!m.isMesh) return;
    const name = m.material.name;
    m.material = mats(name);
    // only the big surfaces cast shadows; glass, lamps, trim bits and the interior would just cost frame time
    m.castShadow = SHADOW_CASTERS.has(name);
    m.receiveShadow = true;
  });
  return o;
}

function useModel(car) {
  const G = MODELS[car.key];
  if (!G || !G.body || !G.wheel) return;
  const mats = modelMaterials(car.spec);
  car.body.clear();
  car.body.add(cloneModel(G.body, mats));
  for (const w of car.wheels) {
    w.spin.clear();
    w.spin.add(cloneModel(G.wheel, mats));
    for (const c of [...w.pivot.children]) if (c !== w.spin) w.pivot.remove(c);
    if (G.caliper) w.pivot.add(cloneModel(G.caliper, mats));
  }
  car.findTails();
  car.prepare?.(car.root);
}

/* ---------- assemble ---------- */
export function buildCar(key, { prepare } = {}) {
  const S = SPECS[key];
  const root = new THREE.Group();   // position + heading
  const body = new THREE.Group();   // pitch + roll
  root.add(body);
  const paint = S.paint();
  const shell = key === 'gt3' ? bodyGT3(paint) : bodyM240i(paint);
  body.add(shell);
  // dark wheel wells so you can't see through the arches
  const wells = [];
  for (const [i, za] of S.axles.entries()) {
    const w = new THREE.Mesh(new THREE.CylinderGeometry(S.wheel.r + 0.05, S.wheel.r + 0.05, (S.track[i] - S.wheel.w / 2 - 0.02) * 2, 24), M.well());
    w.rotation.z = Math.PI / 2;
    w.position.set(0, S.wheel.r, za);
    body.add(w);
    wells.push(w);
  }
  // underbody
  body.add(box(1.5, 0.08, (S.L[1] - S.L[0]) * 0.8, M.well(), 0, 0.2, (S.L[0] + S.L[1]) / 2));
  shell.traverse((m) => { if (m.isMesh) { m.castShadow = true; m.receiveShadow = true; } });

  const wheels = [];
  S.axles.forEach((za, i) => {
    for (const side of [1, -1]) {
      const wobj = makeWheel(S.wheel);
      wobj.pivot.position.set(side * S.track[i], S.wheel.r, za);
      if (side < 0) wobj.pivot.rotation.y = Math.PI; // face outward on the right side
      wobj.base = wobj.pivot.rotation.y;
      wobj.front = i === 0;
      wobj.side = side;
      root.add(wobj.pivot);
      wheels.push(wobj);
    }
  });

  const tailMats = [];
  const car = {
    key, spec: S, root, body, wheels, prepare,
    findTails() {
      tailMats.length = 0;
      body.traverse((m) => { if (m.isMesh && m.material.emissive && m.material.emissive.r > 0.9 && m.material.emissive.g < 0.2) tailMats.push(m.material); });
    },
    wheelbase: S.axles[0] - S.axles[1],
    length: S.L[1] - S.L[0],
    // steer: radians (+ = left), roll: distance rolled this frame (m)
    setWheels(steer, roll) {
      for (const w of wheels) {
        w.pivot.rotation.y = w.base + (w.front ? steer : 0);
        w.spin.rotation.x += (roll / S.wheel.r) * (w.side > 0 ? 1 : -1);
      }
    },
    setBrake(on) {
      for (const m of tailMats) m.emissiveIntensity = on ? 4 : 1.1;
    },
  };
  car.findTails();
  if (MODELS[key]) useModel(car);
  else waiting.push(car);
  prepare?.(root);
  return car;
}
