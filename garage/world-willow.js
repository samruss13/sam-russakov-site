import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { TRACK_PTS } from './track-data.js';
import { makeRnd, canvasTex, noiseFill, layer, makePath, strip, makeSky, envFromSky, makeGrid, obb } from './world-utils.js';

/* =========================================================
   Willow Springs: a desert circuit modelled on Big Willow
   (Rosamond, CA) at golden hour.
   ========================================================= */

const HALF_W = 6.2;   // half the track width (m)
const PIT_DIST = 34;  // pit garage centre, distance from the track centreline (m)

export function buildWillow(renderer, { isTouch }) {
  const rnd = makeRnd(1337);
  const scene = new THREE.Scene();
  const sunDir = new THREE.Vector3(-0.92, 0.12, 0.38).normalize();
  const fogCol = new THREE.Color(0xd09a7c);
  scene.fog = new THREE.Fog(fogCol, 250, 3400);
  scene.background = fogCol;

  /* ---------- track ---------- */
  let pts = TRACK_PTS.slice();
  let area = 0;
  for (let i = 0; i < pts.length; i++) { const a = pts[i], b = pts[(i + 1) % pts.length]; area += a[0] * b[1] - b[0] * a[1]; }
  if (area < 0) pts.reverse(); // Big Willow runs clockwise
  const path = makePath(pts, true, 2.6);
  const { C, T, L, K, N, ds, distTo } = path;

  // longest straight -> pit straight
  let best = { len: 0, start: 0 }, run = 0, runStart = 0;
  for (let j = 0; j < N * 2; j++) {
    const i = j % N;
    if (Math.abs(K[i]) < 1 / 700) { if (run === 0) runStart = j; run++; if (run > best.len && run < N) best = { len: run, start: runStart % N }; }
    else run = 0;
  }
  const pitIdx = (best.start + Math.floor(best.len * 0.42)) % N;
  const lineIdx = (pitIdx + Math.round(70 / ds)) % N;

  const asphalt = canvasTex(256, 256, (c, w, h) => noiseFill(c, w, h, '#4a4a4c', 0.22, 9000, rnd), true);
  asphalt.repeat.set(2, 1);
  const road = new THREE.Mesh(strip(path, -HALF_W, HALF_W, 0.02), layer(new THREE.MeshStandardMaterial({ map: asphalt, roughness: 0.9 }), -1));
  road.receiveShadow = true;
  scene.add(road);
  const lineMat = layer(new THREE.MeshStandardMaterial({ color: 0xe8e4da, roughness: 0.7 }), -2);
  scene.add(new THREE.Mesh(strip(path, HALF_W - 0.45, HALF_W - 0.2, 0.025), lineMat));
  scene.add(new THREE.Mesh(strip(path, -HALF_W + 0.2, -HALF_W + 0.45, 0.025), lineMat));
  // kerbs on the inside of corners, red/white
  const kerbTex = canvasTex(64, 128, (c, w, h) => { c.fillStyle = '#f2efe8'; c.fillRect(0, 0, w, h); c.fillStyle = '#c4271d'; c.fillRect(0, 0, w, h / 2); }, true);
  const kerbMat = layer(new THREE.MeshStandardMaterial({ map: kerbTex, roughness: 0.6 }), -2);
  const corner = (i) => Math.abs(K[i]) > 1 / 160;
  // K < 0 = left-hander, so the inside is the +offset (left) side
  scene.add(new THREE.Mesh(strip(path, HALF_W, HALF_W + 1.3, 0.03, (i) => corner(i) && K[i] < 0, 3), kerbMat));
  scene.add(new THREE.Mesh(strip(path, -HALF_W - 1.3, -HALF_W, 0.03, (i) => corner(i) && K[i] > 0, 3), kerbMat));
  // packed-dirt shoulders
  const dirt = layer(new THREE.MeshStandardMaterial({ color: 0x84705c, roughness: 1 }), -1);
  scene.add(new THREE.Mesh(strip(path, HALF_W, HALF_W + 6, 0.01), dirt));
  scene.add(new THREE.Mesh(strip(path, -HALF_W - 6, -HALF_W, 0.01), dirt));

  // start / finish line
  {
    const p = C[lineIdx], t = T[lineIdx];
    const chk = canvasTex(256, 32, (c) => { for (let x = 0; x < 16; x++) for (let y = 0; y < 2; y++) { c.fillStyle = (x + y) % 2 ? '#111' : '#eee'; c.fillRect(x * 16, y * 16, 16, 16); } });
    const line = new THREE.Mesh(new THREE.PlaneGeometry(HALF_W * 2, 1.6), layer(new THREE.MeshStandardMaterial({ map: chk, roughness: 0.7 }), -3));
    line.rotation.x = -Math.PI / 2;
    line.rotation.z = Math.atan2(t.x, t.z) + Math.PI / 2;
    line.position.set(p.x, 0.035, p.z);
    scene.add(line);
  }

  /* ---------- ground, sky, mountains ---------- */
  const sand = canvasTex(512, 512, (c, w, h) => { noiseFill(c, w, h, '#9a8a76', 0.26, 26000, rnd); for (let i = 0; i < 40; i++) { c.fillStyle = `rgba(90,70,50,${rnd() * 0.12})`; c.beginPath(); c.ellipse(rnd() * w, rnd() * h, rnd() * 60 + 10, rnd() * 25 + 5, rnd() * 3, 0, 7); c.fill(); } }, true);
  sand.repeat.set(220, 220);
  const ground = new THREE.Mesh(new THREE.PlaneGeometry(9000, 9000), new THREE.MeshStandardMaterial({ map: sand, roughness: 1 }));
  ground.rotation.x = -Math.PI / 2;
  ground.receiveShadow = true;
  scene.add(ground);

  const sky = makeSky(sunDir, { horizon: new THREE.Color(0.94, 0.6, 0.43), mid: new THREE.Color(0.56, 0.42, 0.5), top: new THREE.Color(0.13, 0.16, 0.3) });
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

  /* ---------- scenery: Joshua trees, scrub ---------- */
  {
    const parts = [];
    const add = (geo, col, m) => { geo.applyMatrix4(m); const c = new THREE.Color(col); const n = geo.attributes.position.count; const arr = new Float32Array(n * 3); for (let i = 0; i < n; i++) { arr[i * 3] = c.r; arr[i * 3 + 1] = c.g; arr[i * 3 + 2] = c.b; } geo.setAttribute('color', new THREE.BufferAttribute(arr, 3)); parts.push(geo.toNonIndexed()); };
    const mtx = (x, y, z) => new THREE.Matrix4().makeTranslation(x, y, z);
    add(new THREE.CylinderGeometry(0.16, 0.24, 2.4, 6), 0x5a4636, mtx(0, 1.2, 0));
    [[0.9, 0.5], [-0.8, -0.6], [0.5, -2.2], [-0.4, 2.4]].forEach(([rz, ry], i) => {
      const len = 1.1 + (i % 2) * 0.4;
      const g = new THREE.CylinderGeometry(0.1, 0.14, len, 5);
      g.translate(0, len / 2, 0); g.rotateZ(rz); g.rotateY(ry); g.translate(0, 2.2, 0);
      add(g, 0x5a4636, new THREE.Matrix4());
      const tip = new THREE.Vector3(0, len, 0).applyEuler(new THREE.Euler(0, 0, rz)).applyEuler(new THREE.Euler(0, ry, 0)).add(new THREE.Vector3(0, 2.2, 0));
      const tuft = new THREE.IcosahedronGeometry(0.42, 0);
      tuft.scale(1, 1.25, 1);
      add(tuft, 0x46542f, mtx(tip.x, tip.y + 0.15, tip.z));
    });
    const trees = new THREE.InstancedMesh(mergeGeometries(parts), new THREE.MeshLambertMaterial({ vertexColors: true }), 320);
    const m = new THREE.Matrix4(), q = new THREE.Quaternion(), v = new THREE.Vector3(), s = new THREE.Vector3();
    let n = 0;
    while (n < 320) {
      const x = (rnd() - 0.5) * 3200, z = (rnd() - 0.5) * 2600;
      if (distTo(x, z) < 26) continue;
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
      if (distTo(x, z) < 14) continue;
      const k = 0.4 + rnd() * 1.1;
      m.compose(v.set(x, 0.1, z), q.identity(), s.set(k, k * (0.7 + rnd() * 0.6), k));
      bushes.setMatrixAt(n++, m);
      bushes.setColorAt(n - 1, new THREE.Color().setHSL(0.15 + rnd() * 0.06, 0.25, 0.28 + rnd() * 0.12));
    }
    scene.add(bushes);
  }

  // tyre walls on the outside of the bigger corners (solid)
  const grid = makeGrid(8);
  {
    const barrier = [];
    for (let i = 0; i < N; i++) {
      if (Math.abs(K[i]) < 1 / 130) continue;
      const side = K[i] > 0 ? 1 : -1; // outside of the corner
      const o = side * (HALF_W + 13);
      const x = C[i].x + L[i].x * o, z = C[i].z + L[i].z * o;
      if (distTo(x, z) < HALF_W + 9) continue;
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
      grid.add(x, z, 0.5);
      for (let k = 0; k < 3; k++) {
        m.makeTranslation(x, 0.17 + k * 0.3, z);
        inst.setMatrixAt(n, m);
        inst.setColorAt(n++, new THREE.Color(j % 6 < 3 ? 0x161616 : (k === 1 ? 0xe9e6dd : 0x161616)));
      }
    });
    inst.castShadow = true;
    scene.add(inst);
  }

  /* ---------- pit garage on the left of the front straight ---------- */
  const boxes = [];
  const pit = new THREE.Group();
  {
    const p = C[pitIdx], l = L[pitIdx];
    const dist = PIT_DIST;
    pit.position.set(p.x + l.x * dist, 0, p.z + l.z * dist);
    const face = new THREE.Vector3(-l.x, 0, -l.z); // building front faces the track
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
      if (solid) boxes.push(obb(x, z, w / 2, d / 2, pit.rotation.y, pit.position));
      return b;
    };
    const W = 64, D = 10, H = 5.2, bay = 5.4;
    add(W, H, 0.4, 0, H / 2, -D / 2, wallMat, true);              // back
    add(0.4, H, D, -W / 2, H / 2, 0, wallMat, true);              // ends
    add(0.4, H, D, W / 2, H / 2, 0, wallMat, true);
    add(W + 0.8, 0.4, D + 1.6, 0, H + 0.2, 0.4, wallMat, false); // roof + canopy
    add(W + 0.8, 0.12, 0.12, 0, H - 0.05, D / 2 + 1.2, trimMat, false);
    const half = bay / 2;
    add(W / 2 - half, H, 0.4, -(W / 2 + half) / 2, H / 2, D / 2, wallMat, true);
    add(W / 2 - half, H, 0.4, (W / 2 + half) / 2, H / 2, D / 2, wallMat, true);
    add(bay, H - 3.6, 0.4, 0, 3.6 + (H - 3.6) / 2, D / 2, wallMat, false);
    for (let k = -5; k <= 5; k++) if (k !== 0) add(4.6, 3.6, 0.1, k * 5.6, 1.8, D / 2 + 0.22, doorMat, false);
    add(0.3, H, D, -half - 0.15, H / 2, 0, wallMat, true);        // open bay dividers
    add(0.3, H, D, half + 0.15, H / 2, 0, wallMat, true);
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
    const apronLen = dist - HALF_W - D / 2;
    const apron = new THREE.Mesh(new THREE.PlaneGeometry(W, apronLen), layer(new THREE.MeshStandardMaterial({ map: asphalt, color: 0x9a9a9a, roughness: 0.85 }), -1));
    apron.rotation.x = -Math.PI / 2;
    apron.position.set(0, 0.015, D / 2 + apronLen / 2);
    apron.receiveShadow = true;
    pit.add(apron);
    const sign = canvasTex(1024, 128, (c, w, h) => { c.fillStyle = '#0c0b0a'; c.fillRect(0, 0, w, h); c.fillStyle = '#d9b46a'; c.font = '600 64px Inter, sans-serif'; c.textAlign = 'center'; c.textBaseline = 'middle'; c.fillText('S A M   R U S S A K O V', w / 2, h / 2 + 4); });
    const sg = new THREE.Mesh(new THREE.PlaneGeometry(14, 1.75), new THREE.MeshStandardMaterial({ map: sign, emissive: 0xffffff, emissiveMap: sign, emissiveIntensity: 0.9 }));
    sg.position.set(0, H + 1.1, D / 2 + 0.25);
    pit.add(sg);
    add(14.4, 2.1, 0.2, 0, H + 1.1, D / 2 + 0.1, wallMat, false);
    // pit wall between apron and track (stops short of the open bay so you can drive straight out)
    const pw = new THREE.Mesh(new THREE.BoxGeometry(118, 0.9, 0.5), new THREE.MeshStandardMaterial({ color: 0xe7e3d8, roughness: 0.7 }));
    pw.position.set(-71, 0.45, dist - HALF_W - 4);
    pw.castShadow = true;
    pit.add(pw);
    boxes.push(obb(-71, dist - HALF_W - 4, 59, 0.25, pit.rotation.y, pit.position));
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
      boxes.push(obb(p.x + l.x * sx * (HALF_W + 2), p.z + l.z * sx * (HALF_W + 2), 0.3, 0.3));
    }
    const beam = new THREE.Mesh(new THREE.BoxGeometry(0.8, 1.2, HALF_W * 2 + 4.5), mat);
    beam.position.y = 6.6;
    beam.castShadow = true;
    g.add(beam);
    const lights = new THREE.MeshStandardMaterial({ color: 0x220000, emissive: 0x30ff60, emissiveIntensity: 2 });
    for (let k = -2; k <= 2; k++) { const b = new THREE.Mesh(new THREE.CircleGeometry(0.18, 16), lights); b.position.set(0.41, 6.6, k * 0.55); b.rotation.y = Math.PI / 2; g.add(b); const b2 = b.clone(); b2.position.x = -0.41; b2.rotation.y = -Math.PI / 2; g.add(b2); }
    scene.add(g);
  }

  scene.environment = envFromSky(renderer, sky, 0x7a5c44);

  /* ---------- what the driving core needs ---------- */
  const th = pit.rotation.y;
  const pitLocal = (x, z) => { const px = x - pit.position.x, pz = z - pit.position.z; return { lx: px * Math.cos(th) - pz * Math.sin(th), lz: px * Math.sin(th) + pz * Math.cos(th) }; };
  return {
    key: 'willow', scene, sun, sunDir, sky, path, boxes, grid,
    timing: { type: 'circuit', lineIdx },
    bestKey: (car) => `garage-best-${car}`,
    dust: new THREE.Color(0.5, 0.41, 0.32),
    farLimit: 350,
    intro: 'pull out and head for the line',
    startPose() {
      const p = new THREE.Vector3(0, 0, -0.5).applyMatrix4(new THREE.Matrix4().makeRotationY(th)).add(pit.position);
      return { x: p.x, z: p.z, yaw: th };
    },
    // is the car on tarmac, kerb or dirt?
    surface(st, n) {
      const { lx, lz } = pitLocal(st.x, st.z);
      const inPit = lz > -6 && lz < PIT_DIST - HALF_W + 0.5 && Math.abs(lx) < 33;
      const off = n.d > HALF_W + 1.5 && !inPit;
      return { off, kerb: !off && n.d > HALF_W };
    },
    // while the car is in (or just leaving) the pit bay, film it from the apron
    introCam(st) {
      const { lx, lz } = pitLocal(st.x, st.z);
      if (lz >= 7 || Math.abs(lx) >= 6) return null;
      const x = 5.5, z = 17.5;
      return {
        pos: new THREE.Vector3(x * Math.cos(th) + z * Math.sin(th) + pit.position.x, 1.6, -x * Math.sin(th) + z * Math.cos(th) + pit.position.z),
        look: new THREE.Vector3(st.x, 0.8, st.z),
      };
    },
    info: { lapLength: path.length, pitIdx, lineIdx },
  };
}
