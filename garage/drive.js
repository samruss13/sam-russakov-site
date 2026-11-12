import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { TRACK_PTS } from './track-data.js';
import { buildCar, CAR_SPECS } from './cars.js';

/* =========================================================
   Drive mode: a desert circuit modelled on Big Willow
   (Willow Springs, Rosamond CA) at golden hour.
   ========================================================= */

const $ = (s) => document.querySelector(s);
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const damp = (a, b, k, dt) => a + (b - a) * (1 - Math.exp(-k * dt));
const isTouch = matchMedia('(hover: none), (pointer: coarse)').matches;

const HALF_W = 6.2;        // half the track width (m)
const PIT_DIST = 34;       // pit garage centre, distance from the track centreline (m)
const N = 1500;            // centreline samples

/* ---------- random (seeded, so the scenery is the same every visit) ---------- */
let seed = 1337;
const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);

/* ---------- textures drawn on canvases ---------- */
function canvasTex(w, h, draw, repeat) {
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  draw(c.getContext('2d'), w, h);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 8;
  if (repeat) { t.wrapS = t.wrapT = THREE.RepeatWrapping; }
  return t;
}
const noiseFill = (ctx, w, h, base, spread, n) => {
  ctx.fillStyle = base; ctx.fillRect(0, 0, w, h);
  for (let i = 0; i < n; i++) {
    const v = (rnd() - 0.5) * spread;
    ctx.fillStyle = v > 0 ? `rgba(255,255,255,${v})` : `rgba(0,0,0,${-v})`;
    const s = rnd() * 2 + 0.5;
    ctx.fillRect(rnd() * w, rnd() * h, s, s);
  }
};

export function createDrive(renderer) {
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(58, innerWidth / innerHeight, 0.3, 7000);
  const sunDir = new THREE.Vector3(-0.92, 0.12, 0.38).normalize();
  const fogCol = new THREE.Color(0xd09a7c);
  scene.fog = new THREE.Fog(fogCol, 250, 3400);
  scene.background = fogCol;

  /* ---------- track geometry ---------- */
  let raw = TRACK_PTS.map(([x, z]) => new THREE.Vector3(x, 0, z));
  let area = 0;
  for (let i = 0; i < raw.length; i++) { const a = raw[i], b = raw[(i + 1) % raw.length]; area += a.x * b.z - b.x * a.z; }
  if (area < 0) raw.reverse(); // Big Willow runs clockwise
  const curve = new THREE.CatmullRomCurve3(raw, true, 'centripetal');
  const C = curve.getSpacedPoints(N).slice(0, N);
  const T = [], L = [], K = [];
  for (let i = 0; i < N; i++) {
    const t = C[(i + 1) % N].clone().sub(C[(i - 1 + N) % N]).normalize();
    T.push(t);
    L.push(new THREE.Vector3(t.z, 0, -t.x)); // car's left when driving along t
  }
  const ds = curve.getLength() / N;
  for (let i = 0; i < N; i++) {
    const a = T[(i - 2 + N) % N], b = T[(i + 2) % N];
    const cross = a.x * b.z - a.z * b.x;
    K.push(Math.asin(clamp(cross, -1, 1)) / (4 * ds)); // signed curvature
  }
  const lapLength = curve.getLength();

  // longest straight -> pit straight
  let best = { len: 0, start: 0 }, run = 0, runStart = 0;
  for (let j = 0; j < N * 2; j++) {
    const i = j % N;
    if (Math.abs(K[i]) < 1 / 700) { if (run === 0) runStart = j; run++; if (run > best.len && run < N) best = { len: run, start: runStart % N }; }
    else run = 0;
  }
  const pitIdx = (best.start + Math.floor(best.len * 0.42)) % N;
  const lineIdx = (pitIdx + Math.round(70 / ds)) % N;

  // nearest centreline sample to (x, z), searching near a hint when we have one
  function nearest(x, z, hint = -1, win = 60) {
    let bi = 0, bd = Infinity;
    const from = hint < 0 ? 0 : hint - win, to = hint < 0 ? N : hint + win;
    for (let j = from; j < to; j++) {
      const i = (j + N) % N, p = C[i];
      const d = (p.x - x) ** 2 + (p.z - z) ** 2;
      if (d < bd) { bd = d; bi = i; }
    }
    const p = C[bi], l = L[bi];
    const lat = (x - p.x) * l.x + (z - p.z) * l.z;
    return { i: bi, d: Math.sqrt(bd), lat };
  }
  const coarse = C.filter((_, i) => i % 4 === 0);
  const distToTrack = (x, z) => { let m = Infinity; for (const p of coarse) m = Math.min(m, (p.x - x) ** 2 + (p.z - z) ** 2); return Math.sqrt(m); };

  function strip(off0, off1, y, cond, uvAlong = 8) {
    const pos = [], uv = [], idx = [];
    let s = 0;
    for (let i = 0; i <= N; i++) {
      const k = i % N, p = C[k], l = L[k];
      pos.push(p.x + l.x * off0, y, p.z + l.z * off0, p.x + l.x * off1, y, p.z + l.z * off1);
      uv.push(0, s / uvAlong, 1, s / uvAlong);
      s += ds;
      if (i < N && (!cond || cond(k))) { const a = i * 2; idx.push(a, a + 2, a + 1, a + 1, a + 2, a + 3); }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
    g.setIndex(idx);
    g.computeVertexNormals();
    // make sure every strip faces up
    const n = g.attributes.normal;
    if (n.count && n.getY(0) < 0) { for (let i = 0; i < idx.length; i += 3) { const t = idx[i + 1]; idx[i + 1] = idx[i + 2]; idx[i + 2] = t; } g.setIndex(idx); g.computeVertexNormals(); }
    return g;
  }
  const off = (m, f) => { m.polygonOffset = true; m.polygonOffsetFactor = f; m.polygonOffsetUnits = f; return m; };

  const asphalt = canvasTex(256, 256, (c, w, h) => { noiseFill(c, w, h, '#4a4a4c', 0.22, 9000); }, true);
  asphalt.repeat.set(2, 1);
  const road = new THREE.Mesh(strip(-HALF_W, HALF_W, 0.02), off(new THREE.MeshStandardMaterial({ map: asphalt, roughness: 0.9, metalness: 0 }), -1));
  road.receiveShadow = true;
  scene.add(road);
  const lineMat = off(new THREE.MeshStandardMaterial({ color: 0xe8e4da, roughness: 0.7 }), -2);
  scene.add(new THREE.Mesh(strip(HALF_W - 0.45, HALF_W - 0.2, 0.025), lineMat));
  scene.add(new THREE.Mesh(strip(-HALF_W + 0.2, -HALF_W + 0.45, 0.025), lineMat));
  // kerbs on the inside of corners, red/white
  const kerbTex = canvasTex(64, 128, (c, w, h) => { c.fillStyle = '#f2efe8'; c.fillRect(0, 0, w, h); c.fillStyle = '#c4271d'; c.fillRect(0, 0, w, h / 2); }, true);
  const kerbMat = off(new THREE.MeshStandardMaterial({ map: kerbTex, roughness: 0.6 }), -2);
  const corner = (i) => Math.abs(K[i]) > 1 / 160;
  // K < 0 = left-hander, so the inside is the +offset (left) side
  scene.add(new THREE.Mesh(strip(HALF_W, HALF_W + 1.3, 0.03, (i) => corner(i) && K[i] < 0, 3), kerbMat));
  scene.add(new THREE.Mesh(strip(-HALF_W - 1.3, -HALF_W, 0.03, (i) => corner(i) && K[i] > 0, 3), kerbMat));
  // packed-dirt shoulders
  const dirt = off(new THREE.MeshStandardMaterial({ color: 0x84705c, roughness: 1 }), -1);
  scene.add(new THREE.Mesh(strip(HALF_W, HALF_W + 6, 0.01), dirt));
  scene.add(new THREE.Mesh(strip(-HALF_W - 6, -HALF_W, 0.01), dirt));

  // start / finish line + grid boxes
  {
    const p = C[lineIdx], t = T[lineIdx];
    const chk = canvasTex(256, 32, (c, w, h) => { for (let x = 0; x < 16; x++) for (let y = 0; y < 2; y++) { c.fillStyle = (x + y) % 2 ? '#111' : '#eee'; c.fillRect(x * 16, y * 16, 16, 16); } });
    const line = new THREE.Mesh(new THREE.PlaneGeometry(HALF_W * 2, 1.6), off(new THREE.MeshStandardMaterial({ map: chk, roughness: 0.7 }), -3));
    line.rotation.x = -Math.PI / 2;
    line.rotation.z = Math.atan2(t.x, t.z) + Math.PI / 2;
    line.position.set(p.x, 0.035, p.z);
    scene.add(line);
  }

  /* ---------- ground, sky, mountains ---------- */
  const sand = canvasTex(512, 512, (c, w, h) => { noiseFill(c, w, h, '#9a8a76', 0.26, 26000); for (let i = 0; i < 40; i++) { c.fillStyle = `rgba(90,70,50,${rnd() * 0.12})`; c.beginPath(); c.ellipse(rnd() * w, rnd() * h, rnd() * 60 + 10, rnd() * 25 + 5, rnd() * 3, 0, 7); c.fill(); } }, true);
  sand.repeat.set(220, 220);
  const ground = new THREE.Mesh(new THREE.PlaneGeometry(9000, 9000), new THREE.MeshStandardMaterial({ map: sand, roughness: 1, metalness: 0 }));
  ground.rotation.x = -Math.PI / 2;
  ground.receiveShadow = true;
  scene.add(ground);

  const sky = new THREE.Mesh(new THREE.SphereGeometry(5000, 32, 16), new THREE.ShaderMaterial({
    side: THREE.BackSide, depthWrite: false, fog: false,
    uniforms: { uSun: { value: sunDir } },
    vertexShader: 'varying vec3 vD; void main(){ vD = normalize(position); gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }',
    fragmentShader: `varying vec3 vD; uniform vec3 uSun;
      void main(){
        float h = vD.y;
        vec3 hor = vec3(0.94,0.6,0.43), mid = vec3(0.56,0.42,0.5), top = vec3(0.13,0.16,0.3);
        vec3 c = mix(hor, mid, smoothstep(0.0, 0.16, h));
        c = mix(c, top, smoothstep(0.12, 0.65, h));
        c = mix(c, hor * 0.85, smoothstep(0.0, -0.08, h));
        float s = max(dot(vD, uSun), 0.0);
        c += vec3(1.0,0.55,0.25) * pow(s, 6.0) * 0.45 + vec3(1.0,0.82,0.55) * pow(s, 900.0) * 3.0;
        gl_FragColor = vec4(c, 1.0);
      }`,
  }));
  scene.add(sky);

  function ridge(radius, base, amp, color, seedOff) {
    const segs = 220, pos = [], idx = [];
    for (let i = 0; i <= segs; i++) {
      const a = (i / segs) * Math.PI * 2;
      const n = Math.sin(a * 3 + seedOff) * 0.5 + Math.sin(a * 7.3 + seedOff * 2) * 0.3 + Math.sin(a * 17 + seedOff) * 0.12 + Math.sin(a * 41) * 0.05;
      const hgt = base + amp * (0.5 + 0.5 * n);
      const r = radius * (1 + 0.06 * Math.sin(a * 5 + seedOff));
      pos.push(Math.cos(a) * r, -30, Math.sin(a) * r, Math.cos(a) * r, hgt, Math.sin(a) * r);
      if (i < segs) { const b = i * 2; idx.push(b, b + 1, b + 2, b + 1, b + 3, b + 2); }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setIndex(idx);
    g.computeVertexNormals();
    return new THREE.Mesh(g, new THREE.MeshLambertMaterial({ color, side: THREE.DoubleSide }));
  }
  scene.add(ridge(3300, 120, 420, 0x6f5866, 1.3));
  scene.add(ridge(2200, 20, 160, 0x8a6a5a, 4.1));

  /* ---------- lights ---------- */
  scene.add(new THREE.HemisphereLight(0xcfc0c8, 0x6a5a48, 1.7));
  const sun = new THREE.DirectionalLight(0xffc896, 2.4);
  sun.castShadow = true;
  sun.shadow.mapSize.set(isTouch ? 1024 : 2048, isTouch ? 1024 : 2048);
  Object.assign(sun.shadow.camera, { left: -35, right: 35, top: 35, bottom: -35, near: 1, far: 300 });
  sun.shadow.bias = -0.0005;
  scene.add(sun, sun.target);

  /* ---------- scenery: Joshua trees, scrub, tyre walls ---------- */
  {
    const parts = [];
    const add = (geo, col, m) => { geo.applyMatrix4(m); const c = new THREE.Color(col); const n = geo.attributes.position.count; const arr = new Float32Array(n * 3); for (let i = 0; i < n; i++) { arr[i * 3] = c.r; arr[i * 3 + 1] = c.g; arr[i * 3 + 2] = c.b; } geo.setAttribute('color', new THREE.BufferAttribute(arr, 3)); parts.push(geo.toNonIndexed()); };
    const mtx = (x, y, z, rx, rz, s = 1) => new THREE.Matrix4().compose(new THREE.Vector3(x, y, z), new THREE.Quaternion().setFromEuler(new THREE.Euler(rx, 0, rz)), new THREE.Vector3(s, s, s));
    add(new THREE.CylinderGeometry(0.16, 0.24, 2.4, 6), 0x5a4636, mtx(0, 1.2, 0, 0, 0));
    const arms = [[0.9, 0.5], [-0.8, -0.6], [0.5, -2.2], [-0.4, 2.4]];
    arms.forEach(([rz, ry], i) => {
      const len = 1.1 + (i % 2) * 0.4;
      const g = new THREE.CylinderGeometry(0.1, 0.14, len, 5);
      g.translate(0, len / 2, 0);
      g.rotateZ(rz); g.rotateY(ry);
      g.translate(0, 2.2, 0);
      add(g, 0x5a4636, new THREE.Matrix4());
      const tip = new THREE.Vector3(0, len, 0).applyEuler(new THREE.Euler(0, 0, rz)).applyEuler(new THREE.Euler(0, ry, 0)).add(new THREE.Vector3(0, 2.2, 0));
      const tuft = new THREE.IcosahedronGeometry(0.42, 0);
      tuft.scale(1, 1.25, 1);
      add(tuft, 0x46542f, mtx(tip.x, tip.y + 0.15, tip.z, 0, 0));
    });
    const treeGeo = mergeGeometries(parts);
    const trees = new THREE.InstancedMesh(treeGeo, new THREE.MeshLambertMaterial({ vertexColors: true }), 320);
    const m = new THREE.Matrix4(), q = new THREE.Quaternion(), v = new THREE.Vector3(), s = new THREE.Vector3();
    let n = 0;
    while (n < 320) {
      const x = (rnd() - 0.5) * 3200, z = (rnd() - 0.5) * 2600;
      if (distToTrack(x, z) < 26) continue;
      const k = 0.8 + rnd() * 0.9;
      m.compose(v.set(x, 0, z), q.setFromEuler(new THREE.Euler(0, rnd() * 6.28, 0)), s.set(k, k, k));
      trees.setMatrixAt(n++, m);
    }
    trees.castShadow = true;
    scene.add(trees);

    const bushGeo = new THREE.IcosahedronGeometry(0.7, 1);
    bushGeo.scale(1, 0.55, 1);
    const bushes = new THREE.InstancedMesh(bushGeo, new THREE.MeshLambertMaterial({ color: 0x6f6b45 }), 1400);
    n = 0;
    while (n < 1400) {
      const x = (rnd() - 0.5) * 2600, z = (rnd() - 0.5) * 2000;
      if (distToTrack(x, z) < 14) continue;
      const k = 0.4 + rnd() * 1.1;
      m.compose(v.set(x, 0.1, z), q.identity(), s.set(k, k * (0.7 + rnd() * 0.6), k));
      bushes.setMatrixAt(n++, m);
      bushes.setColorAt(n - 1, new THREE.Color().setHSL(0.15 + rnd() * 0.06, 0.25, 0.28 + rnd() * 0.12));
    }
    scene.add(bushes);
  }

  // tyre walls on the outside of the bigger corners (these are solid)
  const barrier = []; // [x, z]
  {
    for (let i = 0; i < N; i += 1) {
      if (Math.abs(K[i]) < 1 / 130) continue;
      const side = K[i] > 0 ? 1 : -1; // outside of the corner
      const o = side * (HALF_W + 13);
      const x = C[i].x + L[i].x * o, z = C[i].z + L[i].z * o;
      if (distToTrack(x, z) < HALF_W + 9) continue;
      const last = barrier[barrier.length - 1];
      if (last && (last[0] - x) ** 2 + (last[1] - z) ** 2 < 0.9 ** 2) continue;
      barrier.push([x, z]);
    }
    const tyre = new THREE.TorusGeometry(0.33, 0.16, 8, 14);
    tyre.rotateX(Math.PI / 2);
    const inst = new THREE.InstancedMesh(tyre, new THREE.MeshStandardMaterial({ color: 0x161616, roughness: 0.9 }), barrier.length * 3);
    const m = new THREE.Matrix4();
    let n = 0;
    barrier.forEach(([x, z], j) => {
      for (let k = 0; k < 3; k++) {
        m.makeTranslation(x, 0.17 + k * 0.3, z);
        inst.setMatrixAt(n, m);
        inst.setColorAt(n++, new THREE.Color(j % 6 < 3 ? 0x161616 : (k === 1 ? 0xe9e6dd : 0x161616)));
      }
    });
    inst.castShadow = true;
    scene.add(inst);
  }
  const grid = new Map();
  const cell = (x, z) => `${Math.floor(x / 8)},${Math.floor(z / 8)}`;
  barrier.forEach((p) => { const k = cell(p[0], p[1]); if (!grid.has(k)) grid.set(k, []); grid.get(k).push(p); });

  /* ---------- pit garage beside the main straight ---------- */
  const boxes = []; // oriented solid boxes: { cx, cz, hx, hz, c, s }
  const pit = new THREE.Group();
  let pitSide;
  {
    const p = C[pitIdx], l = L[pitIdx];
    const clear = (sd) => { const x = p.x + l.x * sd * 45, z = p.z + l.z * sd * 45; let m = Infinity; C.forEach((q, i) => { if (Math.abs(((i - pitIdx + N + N / 2) % N) - N / 2) > 60) m = Math.min(m, Math.hypot(q.x - x, q.z - z)); }); return m; };
    pitSide = 1; // left of the front straight, as you drive down it    const dist = PIT_DIST;
    pit.position.set(p.x + l.x * pitSide * dist, 0, p.z + l.z * pitSide * dist);
    const face = new THREE.Vector3(-l.x * pitSide, 0, -l.z * pitSide); // building front faces the track
    pit.rotation.y = Math.atan2(face.x, face.z);
    // low sun from across the track, so it lights the garage front and rakes along the straight
    const along = T[pitIdx];
    sunDir.set(face.x * 0.7 + along.x * 0.6, 0.13, face.z * 0.7 + along.z * 0.6).normalize();
    scene.add(pit);

    const wallMat = new THREE.MeshStandardMaterial({ color: 0x2b2a2c, roughness: 0.85 });
    const trimMat = new THREE.MeshStandardMaterial({ color: 0xc9a45c, metalness: 0.9, roughness: 0.3 });
    const doorTex = canvasTex(64, 256, (c, w, h) => { c.fillStyle = '#5e5f63'; c.fillRect(0, 0, w, h); for (let y = 0; y < h; y += 8) { c.fillStyle = 'rgba(0,0,0,.35)'; c.fillRect(0, y, w, 2); c.fillStyle = 'rgba(255,255,255,.08)'; c.fillRect(0, y + 2, w, 1); } }, true);
    doorTex.repeat.set(1, 3);
    const doorMat = new THREE.MeshStandardMaterial({ map: doorTex, roughness: 0.6, metalness: 0.4 });
    const add = (w, h, d, x, y, z, mat, solid) => {
      const b = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat);
      b.position.set(x, y, z);
      b.castShadow = b.receiveShadow = true;
      pit.add(b);
      if (solid) {
        const wp = new THREE.Vector3(x, 0, z).applyMatrix4(new THREE.Matrix4().makeRotationY(pit.rotation.y)).add(pit.position);
        boxes.push({ cx: wp.x, cz: wp.z, hx: w / 2, hz: d / 2, c: Math.cos(pit.rotation.y), s: Math.sin(pit.rotation.y) });
      }
      return b;
    };
    const W = 64, D = 10, H = 5.2, bay = 5.4;
    add(W, H, 0.4, 0, H / 2, -D / 2, wallMat, true);                // back
    add(0.4, H, D, -W / 2, H / 2, 0, wallMat, true);                // ends
    add(0.4, H, D, W / 2, H / 2, 0, wallMat, true);
    add(W + 0.8, 0.4, D + 1.6, 0, H + 0.2, 0.4, wallMat, false);   // roof + canopy
    add(W + 0.8, 0.12, 0.12, 0, H - 0.05, D / 2 + 1.2, trimMat, false);
    // front: closed bays with roller doors, one open bay in the middle
    const half = bay / 2;
    add(W / 2 - half, H, 0.4, -(W / 2 + half) / 2, H / 2, D / 2, wallMat, true);
    add(W / 2 - half, H, 0.4, (W / 2 + half) / 2, H / 2, D / 2, wallMat, true);
    add(bay, H - 3.6, 0.4, 0, 3.6 + (H - 3.6) / 2, D / 2, wallMat, false);
    for (let k = -5; k <= 5; k++) {
      if (k === 0) continue;
      const x = k * 5.6;
      const d = add(4.6, 3.6, 0.1, x, 1.8, D / 2 + 0.22, doorMat, false);
      d.receiveShadow = true;
    }
    // inner dividers of the open bay
    add(0.3, H, D, -half - 0.15, H / 2, 0, wallMat, true);
    add(0.3, H, D, half + 0.15, H / 2, 0, wallMat, true);
    // floor + interior light
    const floor = new THREE.Mesh(new THREE.PlaneGeometry(bay, D), new THREE.MeshStandardMaterial({ color: 0x3a3a3d, roughness: 0.35 }));
    floor.rotation.x = -Math.PI / 2;
    floor.position.set(0, 0.03, 0);
    pit.add(floor);
    const lamp = new THREE.Mesh(new THREE.BoxGeometry(3.2, 0.06, 0.16), new THREE.MeshStandardMaterial({ color: 0xffffff, emissive: 0xfff2dc, emissiveIntensity: 3 }));
    lamp.position.set(0, H - 0.5, 0);
    pit.add(lamp);
    const pl = new THREE.PointLight(0xffe9c8, 30, 14, 1.6);
    pl.position.set(0, H - 1, 0.5);
    pit.add(pl);
    // apron in front of the garages
    const apronLen = dist - HALF_W - D / 2;
    const apron = new THREE.Mesh(new THREE.PlaneGeometry(W, apronLen), off(new THREE.MeshStandardMaterial({ map: asphalt, color: 0x9a9a9a, roughness: 0.85 }), -1));
    apron.rotation.x = -Math.PI / 2;
    apron.position.set(0, 0.015, D / 2 + apronLen / 2);
    apron.receiveShadow = true;
    pit.add(apron);
    // sign
    const sign = canvasTex(1024, 128, (c, w, h) => { c.fillStyle = '#0c0b0a'; c.fillRect(0, 0, w, h); c.fillStyle = '#d9b46a'; c.font = '600 64px Inter, sans-serif'; c.textAlign = 'center'; c.textBaseline = 'middle'; c.fillText('S A M   R U S S A K O V', w / 2, h / 2 + 4); });
    const sg = new THREE.Mesh(new THREE.PlaneGeometry(14, 1.75), new THREE.MeshStandardMaterial({ map: sign, emissive: 0xffffff, emissiveMap: sign, emissiveIntensity: 0.9 }));
    sg.position.set(0, H + 1.1, D / 2 + 0.25);
    pit.add(sg);
    add(14.4, 2.1, 0.2, 0, H + 1.1, D / 2 + 0.1, wallMat, false);
    // pit wall between the apron and the track
    // (stops short of the open bay so you can drive straight out)
    const pw = new THREE.Mesh(new THREE.BoxGeometry(118, 0.9, 0.5), new THREE.MeshStandardMaterial({ color: 0xe7e3d8, roughness: 0.7 }));
    pw.position.set(-71, 0.45, dist - HALF_W - 4);
    pw.castShadow = true;
    pit.add(pw);
    const wp = new THREE.Vector3(-71, 0, dist - HALF_W - 4).applyMatrix4(new THREE.Matrix4().makeRotationY(pit.rotation.y)).add(pit.position);
    boxes.push({ cx: wp.x, cz: wp.z, hx: 59, hz: 0.25, c: Math.cos(pit.rotation.y), s: Math.sin(pit.rotation.y) });
  }

  // starter gantry over the line
  {
    const p = C[lineIdx], l = L[lineIdx];
    const g = new THREE.Group();
    g.position.copy(p);
    g.rotation.y = Math.atan2(l.x, l.z);
    const mat = new THREE.MeshStandardMaterial({ color: 0x1b1b1d, roughness: 0.6, metalness: 0.5 });
    for (const sx of [-1, 1]) {
      const post = new THREE.Mesh(new THREE.BoxGeometry(0.5, 7, 0.5), mat);
      post.position.set(0, 3.5, sx * (HALF_W + 2));
      post.castShadow = true;
      g.add(post);
    }
    const beam = new THREE.Mesh(new THREE.BoxGeometry(0.8, 1.2, HALF_W * 2 + 4.5), mat);
    beam.position.y = 6.6;
    beam.castShadow = true;
    g.add(beam);
    const lights = new THREE.MeshStandardMaterial({ color: 0x220000, emissive: 0x30ff60, emissiveIntensity: 2 });
    for (let k = -2; k <= 2; k++) { const b = new THREE.Mesh(new THREE.CircleGeometry(0.18, 16), lights); b.position.set(0.41, 6.6, k * 0.55); b.rotation.y = Math.PI / 2; g.add(b); const b2 = b.clone(); b2.position.x = -0.41; b2.rotation.y = -Math.PI / 2; g.add(b2); }
    scene.add(g);
    for (const sx of [-1, 1]) {
      const px = p.x + l.x * sx * (HALF_W + 2), pz = p.z + l.z * sx * (HALF_W + 2);
      boxes.push({ cx: px, cz: pz, hx: 0.3, hz: 0.3, c: 1, s: 0 });
    }
  }

  // reflections for car paint: the sky
  {
    const pm = new THREE.PMREMGenerator(renderer);
    const envScene = new THREE.Scene();
    envScene.add(sky.clone());
    const g = new THREE.Mesh(new THREE.CircleGeometry(4000, 16), new THREE.MeshBasicMaterial({ color: 0x7a5c44 }));
    g.rotation.x = -Math.PI / 2;
    envScene.add(g);
    scene.environment = pm.fromScene(envScene, 0.02).texture;
    pm.dispose();
  }

  /* ---------- dust / tyre smoke ---------- */
  const MAXP = 260;
  const pGeo = new THREE.BufferGeometry();
  const pPos = new Float32Array(MAXP * 3), pCol = new Float32Array(MAXP * 3), pLife = new Float32Array(MAXP), pVel = new Float32Array(MAXP * 3);
  pGeo.setAttribute('position', new THREE.BufferAttribute(pPos, 3));
  pGeo.setAttribute('color', new THREE.BufferAttribute(pCol, 3));
  const puff = canvasTex(64, 64, (c, w) => { const g = c.createRadialGradient(w / 2, w / 2, 0, w / 2, w / 2, w / 2); g.addColorStop(0, 'rgba(255,255,255,.55)'); g.addColorStop(1, 'rgba(255,255,255,0)'); c.fillStyle = g; c.fillRect(0, 0, w, w); });
  const pts = new THREE.Points(pGeo, new THREE.PointsMaterial({ size: 1.1, map: puff, vertexColors: true, transparent: true, opacity: 0.35, depthWrite: false, sizeAttenuation: true }));
  pts.frustumCulled = false;
  scene.add(pts);
  let pNext = 0;
  function emit(x, z, col, vx, vz) {
    const i = pNext; pNext = (pNext + 1) % MAXP;
    pPos[i * 3] = x; pPos[i * 3 + 1] = 0.3; pPos[i * 3 + 2] = z;
    pVel[i * 3] = vx + (rnd() - 0.5); pVel[i * 3 + 1] = 0.6 + rnd() * 0.8; pVel[i * 3 + 2] = vz + (rnd() - 0.5);
    pLife[i] = 1;
    pCol[i * 3] = col.r; pCol[i * 3 + 1] = col.g; pCol[i * 3 + 2] = col.b;
  }
  const dustCol = new THREE.Color(0.5, 0.41, 0.32), smokeCol = new THREE.Color(0.62, 0.62, 0.64);
  function updateParticles(dt) {
    for (let i = 0; i < MAXP; i++) {
      if (pLife[i] <= 0) continue;
      pLife[i] -= dt * 0.7;
      const f = Math.max(pLife[i], 0);
      pPos[i * 3] += pVel[i * 3] * dt; pPos[i * 3 + 1] += pVel[i * 3 + 1] * dt; pPos[i * 3 + 2] += pVel[i * 3 + 2] * dt;
      pVel[i * 3] *= 0.97; pVel[i * 3 + 2] *= 0.97;
      if (f <= 0) pPos[i * 3 + 1] = -100;
      const fade = f * f;
      pCol[i * 3] *= 0.995; // drift slightly darker
      pCol[i * 3 + 1] *= 0.995;
      pCol[i * 3 + 2] *= 0.995;
      if (fade < 0.02) pPos[i * 3 + 1] = -100;
    }
    pGeo.attributes.position.needsUpdate = true;
    pGeo.attributes.color.needsUpdate = true;
  }

  /* ---------- minimap ---------- */
  const mm = $('#minimap');
  const mmCtx = mm.getContext('2d');
  let mmScale, mmOx, mmOz;
  function sizeMinimap() {
    const dpr = Math.min(devicePixelRatio, 2);
    const w = mm.clientWidth || 160, h = mm.clientHeight || 110;
    mm.width = w * dpr; mm.height = h * dpr;
    let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
    C.forEach((p) => { minX = Math.min(minX, p.x); maxX = Math.max(maxX, p.x); minZ = Math.min(minZ, p.z); maxZ = Math.max(maxZ, p.z); });
    mmScale = Math.min((mm.width - 16 * dpr) / (maxX - minX), (mm.height - 16 * dpr) / (maxZ - minZ));
    mmOx = (mm.width - (maxX - minX) * mmScale) / 2 - minX * mmScale;
    mmOz = (mm.height - (maxZ - minZ) * mmScale) / 2 - minZ * mmScale;
  }
  function drawMinimap(x, z, yaw) {
    const c = mmCtx, dpr = Math.min(devicePixelRatio, 2);
    c.clearRect(0, 0, mm.width, mm.height);
    c.lineWidth = 3 * dpr; c.strokeStyle = 'rgba(244,239,230,.35)'; c.lineJoin = 'round';
    c.beginPath();
    C.forEach((p, i) => { const px = p.x * mmScale + mmOx, pz = p.z * mmScale + mmOz; if (i) c.lineTo(px, pz); else c.moveTo(px, pz); });
    c.closePath(); c.stroke();
    const sp = C[lineIdx];
    c.fillStyle = '#f4efe6'; c.fillRect(sp.x * mmScale + mmOx - 2 * dpr, sp.z * mmScale + mmOz - 2 * dpr, 4 * dpr, 4 * dpr);
    const px = x * mmScale + mmOx, pz = z * mmScale + mmOz;
    c.save(); c.translate(px, pz); c.rotate(-yaw + Math.PI);
    c.fillStyle = '#d9b46a'; c.beginPath(); c.moveTo(0, -6 * dpr); c.lineTo(4 * dpr, 5 * dpr); c.lineTo(-4 * dpr, 5 * dpr); c.closePath(); c.fill();
    c.restore();
  }

  /* ---------- input ---------- */
  const input = { gas: 0, brake: 0, left: 0, right: 0, hand: 0, nitro: 0 };
  const keymap = { KeyW: 'gas', ArrowUp: 'gas', KeyS: 'brake', ArrowDown: 'brake', KeyA: 'left', ArrowLeft: 'left', KeyD: 'right', ArrowRight: 'right', Space: 'hand' };
  let active = false;
  const onKey = (e, v) => {
    if (!active) return;
    const k = keymap[e.code];
    if (k) { input[k] = v; e.preventDefault(); }
    if (v && e.code === 'KeyR') resetToTrack();
    if (v && e.code === 'KeyC') camMode = (camMode + 1) % 3;
  };
  addEventListener('keydown', (e) => onKey(e, 1));
  addEventListener('keyup', (e) => onKey(e, 0));
  addEventListener('blur', () => { for (const k in input) input[k] = 0; });

  /* ---------- car + physics ---------- */
  let car = null, P = null;
  const st = { x: 0, z: 0, yaw: 0, vx: 0, vz: 0, yawRate: 0, steer: 0, pitch: 0, roll: 0, idx: 0 };
  let camMode = 0;
  const lap = { start: null, last: null, best: null, checkpoint: false, prevRel: 0 };
  const bestKey = () => `garage-best-${car.key}`;

  function placeInPit() {
    const local = new THREE.Vector3(0, 0, -0.5).applyMatrix4(new THREE.Matrix4().makeRotationY(pit.rotation.y)).add(pit.position);
    Object.assign(st, { x: local.x, z: local.z, yaw: pit.rotation.y, vx: 0, vz: 0, yawRate: 0, steer: 0, pitch: 0, roll: 0 });
    st.idx = nearest(st.x, st.z).i;
  }
  function resetToTrack() {
    const n = nearest(st.x, st.z);
    const p = C[n.i], t = T[n.i];
    Object.assign(st, { x: p.x, z: p.z, yaw: Math.atan2(t.x, t.z), vx: 0, vz: 0, yawRate: 0, steer: 0, idx: n.i });
    lap.start = null; lap.checkpoint = false;
  }

  function collide() {
    // two circles along the car vs solid boxes and tyre walls
    const fx = Math.sin(st.yaw), fz = Math.cos(st.yaw);
    const r = 1.0, offs = [car.length * 0.3, -car.length * 0.3];
    let hit = 0;
    for (const o of offs) {
      let cx = st.x + fx * o, cz = st.z + fz * o;
      for (const b of boxes) {
        // to box space
        const dx = cx - b.cx, dz = cz - b.cz;
        const lx = dx * b.c - dz * b.s, lz = dx * b.s + dz * b.c;
        const qx = clamp(lx, -b.hx, b.hx), qz = clamp(lz, -b.hz, b.hz);
        let ex = lx - qx, ez = lz - qz;
        let d = Math.hypot(ex, ez);
        if (d < r) {
          let nx, nz, push;
          if (d > 1e-4) { nx = ex / d; nz = ez / d; push = r - d; }
          else { // centre inside the box: push out along the shallow axis
            const px = b.hx - Math.abs(lx), pz = b.hz - Math.abs(lz);
            if (px < pz) { nx = Math.sign(lx) || 1; nz = 0; push = px + r; } else { nx = 0; nz = Math.sign(lz) || 1; push = pz + r; }
          }
          // back to world
          const wx = nx * b.c + nz * b.s, wz = -nx * b.s + nz * b.c;
          st.x += wx * push; st.z += wz * push; cx += wx * push; cz += wz * push;
          const vn = st.vx * wx + st.vz * wz;
          if (vn < 0) { st.vx -= wx * vn * 1.35; st.vz -= wz * vn * 1.35; hit = Math.max(hit, -vn); }
        }
      }
      const key = cell(cx, cz);
      const [gx, gz] = key.split(',').map(Number);
      for (let a = -1; a <= 1; a++) for (let b2 = -1; b2 <= 1; b2++) {
        const list = grid.get(`${gx + a},${gz + b2}`);
        if (!list) continue;
        for (const p of list) {
          const dx = cx - p[0], dz = cz - p[1], d = Math.hypot(dx, dz), rr = r + 0.5;
          if (d < rr && d > 1e-4) {
            const nx = dx / d, nz = dz / d, push = rr - d;
            st.x += nx * push; st.z += nz * push; cx += nx * push; cz += nz * push;
            const vn = st.vx * nx + st.vz * nz;
            if (vn < 0) { st.vx -= nx * vn * 1.5; st.vz -= nz * vn * 1.5; hit = Math.max(hit, -vn); }
          }
        }
      }
    }
    if (hit > 3) { st.vx *= 0.7; st.vz *= 0.7; }
  }

  const hud = { speed: $('#hud-speed'), gear: $('#hud-gear'), cur: $('#hud-cur'), last: $('#hud-last'), best: $('#hud-best'), msg: $('#hud-msg'), bar: $('#hud-rpm') };
  const fmt = (t) => (t == null ? '–:––.–' : `${Math.floor(t / 60)}:${(t % 60).toFixed(1).padStart(4, '0')}`);
  let msgTimer = 0;
  const flash = (text, secs = 2.5) => { hud.msg.textContent = text; hud.msg.classList.add('on'); msgTimer = secs; };

  function step(dt) {
    const fx = Math.sin(st.yaw), fz = Math.cos(st.yaw);
    const lx = fz, lz = -fx; // left
    let vF = st.vx * fx + st.vz * fz;
    let vL = st.vx * lx + st.vz * lz;

    const n = nearest(st.x, st.z, st.idx);
    st.idx = n.i;
    // the pit apron counts as tarmac
    const th = pit.rotation.y, ppx = st.x - pit.position.x, ppz = st.z - pit.position.z;
    const plz = ppx * Math.sin(th) + ppz * Math.cos(th), plx = ppx * Math.cos(th) - ppz * Math.sin(th);
    const inPit = plz > -6 && plz < PIT_DIST - HALF_W + 0.5 && Math.abs(plx) < 33;
    const off = n.d > HALF_W + 1.5 && !inPit;
    const onKerb = !off && n.d > HALF_W;

    const steerIn = input.left - input.right;
    const speed = Math.abs(vF);
    const steerMax = P.steer / (1 + speed / 24);
    st.steer = damp(st.steer, steerIn * steerMax, 10, dt);

    // engine + brakes
    const top = P.maxSpeed * (off ? 0.55 : 1);
    if (input.gas) {
      if (vF > -0.5) vF += P.accel * Math.max(0, 1 - (vF / top) ** 2) * dt * (off ? 0.6 : 1);
      else vF += P.brake * dt;
    }
    if (input.brake) {
      if (vF > 0.5) vF -= P.brake * dt;
      else vF = Math.max(vF - 5 * dt, -9);
    }
    // drag + rolling resistance
    vF -= vF * (0.012 + (off ? 0.55 : 0) + (onKerb ? 0.05 : 0)) * dt + Math.sign(vF) * 0.25 * dt * (input.gas ? 0 : 1);
    if (!input.gas && !input.brake && Math.abs(vF) < 0.3) vF = 0;

    // grip: lateral speed bleeds off; handbrake and dirt let it slide
    let grip = P.grip * (off ? 0.35 : 1) * (input.hand ? 0.12 : 1);
    vL *= Math.exp(-grip * dt);

    // yaw follows the steering geometry
    const targetYaw = (vF * Math.tan(st.steer)) / car.wheelbase * (input.hand ? 1.35 : 1);
    st.yawRate = damp(st.yawRate, targetYaw, input.hand ? 3 : 9, dt);
    if (input.hand) vF -= Math.sign(vF) * 3 * dt;

    st.vx = fx * vF + lx * vL;
    st.vz = fz * vF + lz * vL;
    st.yaw += st.yawRate * dt;
    st.x += st.vx * dt;
    st.z += st.vz * dt;
    collide();

    // body motion: pitch from accel, roll from cornering
    const accel = (vF - (st._lastVF ?? vF)) / Math.max(dt, 1e-3);
    st._lastVF = vF;
    st.pitch = damp(st.pitch, clamp(-accel * 0.0045, -0.04, 0.04), 6, dt);
    st.roll = damp(st.roll, clamp(-vF * st.yawRate * 0.004, -0.06, 0.06), 6, dt);

    // tyre smoke / dust
    const slide = Math.abs(vL);
    if ((off && speed > 4) || slide > 3.5) {
      const col = off ? dustCol : smokeCol;
      for (const s of [-1, 1]) if (rnd() < (off ? clamp(speed / 60, 0.08, 0.25) : clamp(slide / 14, 0, 0.6))) {
        emit(st.x - fx * car.wheelbase * 0.55 + lx * s * 0.8, st.z - fz * car.wheelbase * 0.55 + lz * s * 0.8, col, -st.vx * 0.15, -st.vz * 0.15);
      }
    }

    // laps
    const rel = (n.i - lineIdx + N) % N;
    if (rel > N * 0.4 && rel < N * 0.6 && n.d < 40) lap.checkpoint = true;
    if (lap.prevRel > N * 0.85 && rel < N * 0.15 && n.d < 30) {
      const now = performance.now() / 1000;
      if (lap.start != null && lap.checkpoint) {
        const t = now - lap.start;
        lap.last = t;
        if (lap.best == null || t < lap.best) {
          lap.best = t;
          try { localStorage.setItem(bestKey(), String(t)); } catch {}
          flash(`New best lap  ${fmt(t)}`);
        } else flash(`Lap  ${fmt(t)}`);
      } else if (lap.start == null) flash('Lap started');
      lap.start = now;
      lap.checkpoint = false;
    }
    lap.prevRel = rel;
    if (n.d > 350) flash('Head back to the track  ·  R to reset', 0.2);

    // apply to the model
    car.root.position.set(st.x, 0, st.z);
    car.root.rotation.y = st.yaw;
    car.body.rotation.set(st.pitch, 0, st.roll);
    car.setWheels(st.steer, vF * dt);
    car.setBrake(input.brake && vF > 0.5);

    // HUD
    const mph = Math.round(Math.abs(vF) * 2.237);
    hud.speed.textContent = String(mph).padStart(3, '0');
    const gear = vF < -0.5 ? 'R' : mph < 2 ? 'N' : String(Math.min(6, 1 + Math.floor(mph / (P.maxSpeed * 2.237 / 6.2))));
    hud.gear.textContent = gear;
    const band = P.maxSpeed * 2.237 / 6.2;
    hud.bar.style.transform = `scaleX(${gear === 'N' || gear === 'R' ? 0.08 : clamp(0.25 + ((mph % band) / band) * 0.75, 0, 1)})`;
    hud.cur.textContent = lap.start == null ? 'Cross the line' : fmt(performance.now() / 1000 - lap.start);
    hud.last.textContent = fmt(lap.last);
    hud.best.textContent = fmt(lap.best);
    if (msgTimer > 0) { msgTimer -= dt; if (msgTimer <= 0) hud.msg.classList.remove('on'); }
    return vF;
  }

  /* ---------- camera ---------- */
  const camPos = new THREE.Vector3(), camLook = new THREE.Vector3();
  function updateCamera(dt, vF, snap) {
    const fx = Math.sin(st.yaw), fz = Math.cos(st.yaw);
    // the chase camera swings with the direction of travel a little when sliding
    const sp = Math.hypot(st.vx, st.vz);
    let dx = fx, dz = fz;
    if (sp > 3 && vF > 0) { dx = fx * 0.7 + (st.vx / sp) * 0.3; dz = fz * 0.7 + (st.vz / sp) * 0.3; const l = Math.hypot(dx, dz); dx /= l; dz /= l; }
    const cfg = [[6.4, 2.25, 3.5], [11, 3.8, 4], [-0.25, 1.12, 20]][camMode];
    let want = new THREE.Vector3(st.x - dx * cfg[0], cfg[1], st.z - dz * cfg[0]);
    let look = new THREE.Vector3(st.x + fx * cfg[2], camMode === 2 ? 1.0 : 0.9, st.z + fz * cfg[2]);
    // while the car is in (or just leaving) the pit bay, film it from the apron
    const th = pit.rotation.y, px = st.x - pit.position.x, pz = st.z - pit.position.z;
    const lz = px * Math.sin(th) + pz * Math.cos(th), lx = px * Math.cos(th) - pz * Math.sin(th);
    if (camMode !== 2 && lz < 7 && Math.abs(lx) < 6) {
      const toW = (x, y, z) => new THREE.Vector3(x * Math.cos(th) + z * Math.sin(th) + pit.position.x, y, -x * Math.sin(th) + z * Math.cos(th) + pit.position.z);
      want = toW(5.5, 1.6, 17.5);
      look = new THREE.Vector3(st.x, 0.8, st.z);
    }
    if (snap || camMode === 2) { camPos.copy(want); camLook.copy(look); }
    else { camPos.lerp(want, 1 - Math.exp(-7 * dt)); camLook.lerp(look, 1 - Math.exp(-12 * dt)); }
    camera.position.copy(camPos);
    camera.lookAt(camLook);
    const fov = 56 + clamp(Math.abs(vF) * 0.22, 0, 16) + (camera.aspect < 1 ? 14 : 0);
    camera.fov = damp(camera.fov, fov, 4, dt);
    camera.updateProjectionMatrix();
    car.body.visible = camMode !== 2 || true;
    sun.position.set(st.x + sunDir.x * 120, sunDir.y * 120 + 30, st.z + sunDir.z * 120);
    sun.target.position.set(st.x, 0, st.z);
  }

  return {
    scene, camera, input,
    get active() { return active; },
    enter(key) {
      if (car) { scene.remove(car.root); }
      car = buildCar(key);
      P = CAR_SPECS[key].phys;
      scene.add(car.root);
      placeInPit();
      lap.start = null; lap.last = null; lap.checkpoint = false; lap.prevRel = 0;
      try { const b = parseFloat(localStorage.getItem(bestKey())); lap.best = Number.isFinite(b) ? b : null; } catch { lap.best = null; }
      camMode = 0;
      sizeMinimap();
      st._lastVF = 0;
      car.root.position.set(st.x, 0, st.z);
      car.root.rotation.y = st.yaw;
      updateCamera(0.016, 0, true);
      active = true;
      flash(`${CAR_SPECS[key].name}  ·  pull out and head for the line`, 4);
    },
    exit() { active = false; for (const k in input) input[k] = 0; },
    reset: resetToTrack,
    cycleCamera() { camMode = (camMode + 1) % 3; },
    update(dt) {
      if (!active || !car) return;
      const h = Math.min(dt, 1 / 30);
      const sub = 2;
      let vF = 0;
      for (let i = 0; i < sub; i++) vF = step(h / sub);
      updateParticles(h);
      updateCamera(h, vF);
      drawMinimap(st.x, st.z, st.yaw);
    },
    resize() { camera.aspect = innerWidth / innerHeight; camera.updateProjectionMatrix(); if (active) sizeMinimap(); },
    info: { lapLength, pitIdx, lineIdx },
    _dbg: { st, C, T, L, lap, N, nearest },
  };
}
