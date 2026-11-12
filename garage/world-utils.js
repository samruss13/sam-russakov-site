import * as THREE from 'three';

/* Shared helpers for the drivable locations (Willow Springs, PCH). */

export const clamp = (v, a, b) => Math.min(b, Math.max(a, v));

// seeded random, so the scenery is the same every visit
export function makeRnd(seed) {
  let s = seed;
  return () => ((s = (s * 16807) % 2147483647) / 2147483647);
}

export function canvasTex(w, h, draw, repeat) {
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  draw(c.getContext('2d'), w, h);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 8;
  if (repeat) t.wrapS = t.wrapT = THREE.RepeatWrapping;
  return t;
}

export function noiseFill(ctx, w, h, base, spread, n, rnd) {
  ctx.fillStyle = base; ctx.fillRect(0, 0, w, h);
  for (let i = 0; i < n; i++) {
    const v = (rnd() - 0.5) * spread;
    ctx.fillStyle = v > 0 ? `rgba(255,255,255,${v})` : `rgba(0,0,0,${-v})`;
    const s = rnd() * 2 + 0.5;
    ctx.fillRect(rnd() * w, rnd() * h, s, s);
  }
}

// polygon offset so flat layers (road, lines, kerbs) don't flicker against each other
export const layer = (m, f) => { m.polygonOffset = true; m.polygonOffsetFactor = f; m.polygonOffsetUnits = f; return m; };

/* A driving line: evenly spaced samples with tangent (T), left normal (L)
   and signed curvature (K). Works for closed circuits and open roads. */
export function makePath(pts2d, closed, spacing) {
  const raw = pts2d.map(([x, z]) => new THREE.Vector3(x, 0, z));
  const curve = new THREE.CatmullRomCurve3(raw, closed, 'centripetal');
  const length = curve.getLength();
  const N = Math.round(length / spacing);
  const C = curve.getSpacedPoints(N);
  if (closed) C.pop();
  const n = C.length;
  const at = (i) => (closed ? C[(i + n) % n] : C[clamp(i, 0, n - 1)]);
  const T = [], L = [], K = [];
  for (let i = 0; i < n; i++) {
    const t = at(i + 1).clone().sub(at(i - 1)).normalize();
    T.push(t);
    L.push(new THREE.Vector3(t.z, 0, -t.x)); // driver's left when travelling along t
  }
  const ds = length / (closed ? n : n - 1);
  const tAt = (i) => (closed ? T[(i + n) % n] : T[clamp(i, 0, n - 1)]);
  for (let i = 0; i < n; i++) {
    const a = tAt(i - 2), b = tAt(i + 2);
    K.push(Math.asin(clamp(a.x * b.z - a.z * b.x, -1, 1)) / (4 * ds)); // < 0 = left-hander
  }
  function nearest(x, z, hint = -1, win = 60) {
    let bi = 0, bd = Infinity;
    const from = hint < 0 ? 0 : hint - win, to = hint < 0 ? n : hint + win;
    for (let j = from; j < to; j++) {
      if (!closed && (j < 0 || j >= n)) continue;
      const i = closed ? (j + n) % n : j, p = C[i];
      const d = (p.x - x) ** 2 + (p.z - z) ** 2;
      if (d < bd) { bd = d; bi = i; }
    }
    const p = C[bi], l = L[bi];
    const lat = (x - p.x) * l.x + (z - p.z) * l.z;
    return { i: bi, d: Math.sqrt(bd), lat };
  }
  const coarse = C.filter((_, i) => i % 4 === 0);
  const distTo = (x, z) => { let m = Infinity; for (const p of coarse) m = Math.min(m, (p.x - x) ** 2 + (p.z - z) ** 2); return Math.sqrt(m); };
  return { C, T, L, K, N: n, ds, length, closed, nearest, distTo };
}

/* A flat ribbon following the path between two lateral offsets (+ = left). */
export function strip(path, off0, off1, y, cond, uvAlong = 8) {
  const { C, L, N, ds, closed } = path;
  const pos = [], uv = [], idx = [];
  const count = closed ? N + 1 : N;
  let s = 0;
  for (let i = 0; i < count; i++) {
    const k = i % N, p = C[k], l = L[k];
    const o0 = typeof off0 === 'function' ? off0(k) : off0, o1 = typeof off1 === 'function' ? off1(k) : off1;
    pos.push(p.x + l.x * o0, y, p.z + l.z * o0, p.x + l.x * o1, y, p.z + l.z * o1);
    uv.push(0, s / uvAlong, 1, s / uvAlong);
    s += ds;
    if (i < count - 1 && (!cond || cond(k))) { const a = i * 2; idx.push(a, a + 2, a + 1, a + 1, a + 2, a + 3); }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setIndex(idx);
  g.computeVertexNormals();
  const nrm = g.attributes.normal;
  if (nrm.count && nrm.getY(0) < 0) {
    for (let i = 0; i < idx.length; i += 3) { const t = idx[i + 1]; idx[i + 1] = idx[i + 2]; idx[i + 2] = t; }
    g.setIndex(idx); g.computeVertexNormals();
  }
  return g;
}

/* Gradient sky dome with a sun. */
export function makeSky(sunDir, c) {
  const col = (v) => new THREE.Vector3(...new THREE.Color(v).toArray());
  return new THREE.Mesh(new THREE.SphereGeometry(5000, 32, 16), new THREE.ShaderMaterial({
    side: THREE.BackSide, depthWrite: false, fog: false,
    uniforms: { uSun: { value: sunDir }, uHor: { value: col(c.horizon) }, uMid: { value: col(c.mid) }, uTop: { value: col(c.top) }, uGlow: { value: c.glow ?? 0.45 } },
    vertexShader: 'varying vec3 vD; void main(){ vD = normalize(position); gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }',
    fragmentShader: `varying vec3 vD; uniform vec3 uSun, uHor, uMid, uTop; uniform float uGlow;
      void main(){
        float h = vD.y;
        vec3 c = mix(uHor, uMid, smoothstep(0.0, 0.16, h));
        c = mix(c, uTop, smoothstep(0.12, 0.65, h));
        c = mix(c, uHor * 0.85, smoothstep(0.0, -0.08, h));
        float s = max(dot(vD, uSun), 0.0);
        c += vec3(1.0,0.55,0.25) * (pow(s, 6.0) * 0.6 + pow(s, 40.0) * 0.4) * uGlow + vec3(1.0,0.82,0.55) * pow(s, 900.0) * 3.0;
        // roll off highlights gently instead of clipping (clipping draws a hard disc around the sun)
        c = c / (1.0 + max(c - 0.85, 0.0) * 1.6);
        gl_FragColor = vec4(c, 1.0);
      }`,
  }));
}

/* Reflections for car paint, captured from the sky. */
export function envFromSky(renderer, sky, groundColor) {
  const pm = new THREE.PMREMGenerator(renderer);
  const s = new THREE.Scene();
  s.add(sky.clone());
  const g = new THREE.Mesh(new THREE.CircleGeometry(4000, 16), new THREE.MeshBasicMaterial({ color: groundColor }));
  g.rotation.x = -Math.PI / 2;
  s.add(g);
  const tex = pm.fromScene(s, 0.02).texture;
  pm.dispose();
  return tex;
}

/* Spatial hash for small round obstacles (tyres, palms, poles). */
export function makeGrid(cellSize = 8) {
  const map = new Map();
  const key = (x, z) => `${Math.floor(x / cellSize)},${Math.floor(z / cellSize)}`;
  return {
    add(x, z, r) { const k = key(x, z); if (!map.has(k)) map.set(k, []); map.get(k).push([x, z, r]); },
    near(x, z) {
      const gx = Math.floor(x / cellSize), gz = Math.floor(z / cellSize), out = [];
      for (let a = -1; a <= 1; a++) for (let b = -1; b <= 1; b++) { const l = map.get(`${gx + a},${gz + b}`); if (l) out.push(...l); }
      return out;
    },
  };
}

/* Solid oriented box for collisions, from a local box inside a rotated group. */
export function obb(x, z, hx, hz, rotY = 0, origin = null) {
  const c = Math.cos(rotY), s = Math.sin(rotY);
  let cx = x, cz = z;
  if (origin) { cx = origin.x + x * c + z * s; cz = origin.z - x * s + z * c; }
  return { cx, cz, hx, hz, c, s };
}
