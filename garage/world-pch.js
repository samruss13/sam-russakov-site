import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { PCH_PTS, COAST_PTS, PIER } from './pch-data.js';
import { makeRnd, canvasTex, noiseFill, layer, makePath, strip, makeSky, envFromSky, makeGrid, obb, clamp } from './world-utils.js';

/* =========================================================
   Pacific Coast Highway through Huntington Beach at sunset:
   Seapoint St -> the pier at Main St -> Beach Blvd -> Santa Ana River.
   The path runs north-west to south-east; "left" (+lat) is inland,
   "right" (-lat) is the ocean side.
   ========================================================= */

const MED = 2.2;      // half median width
const EDGE = 13;      // road edge (each carriageway: 3 lanes)
const WALK = 16;      // sidewalk edge
const LOT0 = -16, LOT1 = -44;   // beach parking lot (ocean side)
const BIKE0 = -47, BIKE1 = -50; // beach bike path

// lat/lon -> local metres (same origin as pch-data.js)
const LAT0 = 33.656, LON0 = -118.001;
const ll = (lat, lon) => [(lon - LON0) * 111320 * Math.cos(LAT0 * Math.PI / 180), -(lat - LAT0) * 110540];

function colored(geo, col) {
  const c = new THREE.Color(col), n = geo.attributes.position.count, arr = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) { arr[i * 3] = c.r; arr[i * 3 + 1] = c.g; arr[i * 3 + 2] = c.b; }
  geo.setAttribute('color', new THREE.BufferAttribute(arr, 3));
  return geo.index ? geo.toNonIndexed() : geo;
}

export function buildPCH(renderer, { isTouch }) {
  const rnd = makeRnd(9001);
  const scene = new THREE.Scene();
  const sunDir = new THREE.Vector3(-0.86, 0.075, 0.5).normalize(); // setting over the ocean, WSW
  const fogCol = new THREE.Color(0xd99a86);
  scene.fog = new THREE.Fog(fogCol, 300, 3000);
  scene.background = fogCol;

  const path = makePath(PCH_PTS, false, 3);
  const { C, T, L, N, ds } = path;
  const at = (i, lat, y = 0) => new THREE.Vector3(C[i].x + L[i].x * lat, y, C[i].z + L[i].z * lat);
  const yawAt = (i) => Math.atan2(T[i].x, T[i].z);

  // distance from the road to the waterline at each sample (along the ocean side)
  const coast = COAST_PTS.map(([x, z]) => new THREE.Vector2(x, z));
  const beachW = new Float32Array(N);
  for (let i = 0; i < N; i++) {
    let m = Infinity;
    for (const q of coast) m = Math.min(m, Math.hypot(q.x - C[i].x, q.y - C[i].z));
    beachW[i] = m;
  }
  const nearestIdx = (x, z) => path.nearest(x, z).i;
  const pierP0 = new THREE.Vector3(PIER[0][0], 0, PIER[0][1]), pierP1 = new THREE.Vector3(PIER[1][0], 0, PIER[1][1]);
  const mainIdx = nearestIdx(pierP0.x, pierP0.z);
  const beachIdx = nearestIdx(...ll(33.6447, -117.9817));
  const sOf = (i) => i * ds; // distance along the road

  /* ---------- ground: sand, inland lawns, road layers ---------- */
  const mid = C[Math.floor(N / 2)];
  const sandTex = canvasTex(512, 512, (c, w, h) => { noiseFill(c, w, h, '#cdb48e', 0.2, 26000, rnd); for (let i = 0; i < 60; i++) { c.fillStyle = `rgba(120,95,60,${rnd() * 0.08})`; c.beginPath(); c.ellipse(rnd() * w, rnd() * h, rnd() * 50 + 8, rnd() * 18 + 4, rnd() * 3, 0, 7); c.fill(); } }, true);
  sandTex.repeat.set(500, 500);
  const ground = new THREE.Mesh(new THREE.PlaneGeometry(16000, 16000), new THREE.MeshStandardMaterial({ map: sandTex, roughness: 1 }));
  ground.rotation.x = -Math.PI / 2;
  ground.position.set(mid.x, 0, mid.z);
  ground.receiveShadow = true;
  scene.add(ground);

  const lawnTex = canvasTex(256, 256, (c, w, h) => noiseFill(c, w, h, '#5d6a4c', 0.3, 12000, rnd), true);
  lawnTex.repeat.set(1, 1);
  scene.add(new THREE.Mesh(strip(path, WALK, 900, 0.004, null, 30), layer(new THREE.MeshStandardMaterial({ map: lawnTex, color: 0x9a9a8a, roughness: 1 }), -1)));

  const asphaltTex = canvasTex(256, 256, (c, w, h) => noiseFill(c, w, h, '#3f3f42', 0.2, 9000, rnd), true);
  asphaltTex.repeat.set(3, 1);
  const asphalt = layer(new THREE.MeshStandardMaterial({ map: asphaltTex, roughness: 0.88 }), -2);
  const road = new THREE.Mesh(strip(path, -EDGE, EDGE, 0.02, null, 10), asphalt);
  road.receiveShadow = true;
  scene.add(road);
  // planted median
  const medTex = canvasTex(128, 128, (c, w, h) => noiseFill(c, w, h, '#56603f', 0.35, 4000, rnd), true);
  scene.add(new THREE.Mesh(strip(path, -MED, MED, 0.06, null, 6), layer(new THREE.MeshStandardMaterial({ map: medTex, roughness: 1 }), -4)));
  const curb = layer(new THREE.MeshStandardMaterial({ color: 0xcfcac0, roughness: 0.8 }), -5);
  scene.add(new THREE.Mesh(strip(path, MED - 0.25, MED, 0.07), curb));
  scene.add(new THREE.Mesh(strip(path, -MED, -MED + 0.25, 0.07), curb));
  // lane markings: yellow next to the median, dashed whites, white edge lines
  const yellow = layer(new THREE.MeshStandardMaterial({ color: 0xd8b33a, roughness: 0.6 }), -3);
  const white = layer(new THREE.MeshStandardMaterial({ color: 0xe6e3dc, roughness: 0.6 }), -3);
  const dash = (k) => (k * ds) % 12 < 3;
  for (const sg of [1, -1]) {
    scene.add(new THREE.Mesh(strip(path, sg * (MED + 0.3), sg * (MED + 0.45), 0.03), yellow));
    scene.add(new THREE.Mesh(strip(path, sg * 6.0, sg * 6.13, 0.03, dash), white));
    scene.add(new THREE.Mesh(strip(path, sg * 9.6, sg * 9.73, 0.03, dash), white));
    scene.add(new THREE.Mesh(strip(path, sg * (EDGE - 0.4), sg * (EDGE - 0.25), 0.03), white));
  }
  // sidewalks
  const conc = layer(new THREE.MeshStandardMaterial({ color: 0xb9b2a6, roughness: 0.9 }), -2);
  scene.add(new THREE.Mesh(strip(path, EDGE, WALK, 0.05), conc));
  scene.add(new THREE.Mesh(strip(path, -WALK, -EDGE, 0.05), conc));
  // beach parking lots + bike path (ocean side). Pier Plaza replaces the lot at Main St.
  const nearMain = (k) => Math.abs(sOf(k) - sOf(mainIdx)) < 120;
  const lotTex = canvasTex(256, 64, (c, w, h) => {
    noiseFill(c, w, h, '#4b4b4e', 0.18, 2500, rnd);
    c.fillStyle = 'rgba(235,232,225,.85)';
    c.fillRect(w * 0.04, 0, w * 0.36, 2); c.fillRect(w * 0.6, 0, w * 0.36, 2);
  }, true);
  scene.add(new THREE.Mesh(strip(path, LOT1, LOT0, 0.015, (k) => !nearMain(k), 2.8), layer(new THREE.MeshStandardMaterial({ map: lotTex, roughness: 0.9 }), -1)));
  const plazaTex = canvasTex(128, 128, (c, w, h) => { c.fillStyle = '#c9bfae'; c.fillRect(0, 0, w, h); c.strokeStyle = 'rgba(80,60,40,.25)'; c.lineWidth = 2; for (let i = 0; i <= w; i += 32) { c.beginPath(); c.moveTo(i, 0); c.lineTo(i, h); c.stroke(); c.beginPath(); c.moveTo(0, i); c.lineTo(w, i); c.stroke(); } }, true);
  scene.add(new THREE.Mesh(strip(path, -80, LOT0, 0.015, nearMain, 6), layer(new THREE.MeshStandardMaterial({ map: plazaTex, roughness: 0.85 }), -1)));
  scene.add(new THREE.Mesh(strip(path, BIKE1, BIKE0, 0.02, (k) => !nearMain(k)), layer(new THREE.MeshStandardMaterial({ color: 0xa7a199, roughness: 0.9 }), -1)));

  /* ---------- ocean, surf, wet sand ---------- */
  const oceanU = { uTime: { value: 0 }, uSun: { value: sunDir }, uFog: { value: new THREE.Vector3(fogCol.r, fogCol.g, fogCol.b) } };
  {
    // seaward normal at each coast point (pointing away from the road)
    const pos = [], idx = [], foam = [], fIdx = [], wet = [], wIdx = [];
    const roadNear = (x, z) => { let b = null, bd = Infinity; for (let i = 0; i < N; i += 6) { const d = (C[i].x - x) ** 2 + (C[i].z - z) ** 2; if (d < bd) { bd = d; b = C[i]; } } return b; };
    coast.forEach((q, i) => {
      const a = coast[Math.max(i - 1, 0)], b = coast[Math.min(i + 1, coast.length - 1)];
      let nx = -(b.y - a.y), nz = b.x - a.x; const l = Math.hypot(nx, nz); nx /= l; nz /= l;
      const r = roadNear(q.x, q.y);
      if ((q.x - r.x) * nx + (q.y - r.z) * nz < 0) { nx = -nx; nz = -nz; }
      pos.push(q.x, 0.06, q.y, q.x + nx * 7000, 0.06, q.y + nz * 7000);
      foam.push(q.x - nx * 2, 0.08, q.y - nz * 2, q.x + nx * 14, 0.08, q.y + nz * 14);
      wet.push(q.x - nx * 22, 0.01, q.y - nz * 22, q.x + nx * 1, 0.01, q.y + nz * 1);
      if (i < coast.length - 1) { const k = i * 2; idx.push(k, k + 1, k + 2, k + 1, k + 3, k + 2); fIdx.push(k, k + 1, k + 2, k + 1, k + 3, k + 2); wIdx.push(k, k + 1, k + 2, k + 1, k + 3, k + 2); }
    });
    const mk = (p, ix, uvAcross) => {
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.Float32BufferAttribute(p, 3));
      if (uvAcross) { const uv = []; for (let i = 0; i < p.length / 6; i++) uv.push(0, i * 0.35, 1, i * 0.35); g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2)); }
      g.setIndex(ix);
      // flat, facing up (lit materials need normals, or the lighting turns to NaN)
      g.setAttribute('normal', new THREE.Float32BufferAttribute(new Float32Array(p.length).map((_, k) => (k % 3 === 1 ? 1 : 0)), 3));
      return g;
    };
    const ocean = new THREE.Mesh(mk(pos, idx), new THREE.ShaderMaterial({
      uniforms: oceanU, side: THREE.DoubleSide,
      vertexShader: 'varying vec3 vW; void main(){ vec4 w = modelMatrix * vec4(position,1.0); vW = w.xyz; gl_Position = projectionMatrix * viewMatrix * w; }',
      fragmentShader: `varying vec3 vW; uniform float uTime; uniform vec3 uSun, uFog;
        void main(){
          vec2 p = vW.xz; float t = uTime;
          vec2 g = vec2(0.0);
          g += vec2(0.6, 0.8) * cos(dot(p, vec2(0.6,0.8)) * 0.045 + t * 0.9) * 0.9;
          g += vec2(-0.7, 0.7) * cos(dot(p, vec2(-0.7,0.7)) * 0.11 + t * 1.4) * 0.45;
          g += vec2(0.2, -1.0) * cos(dot(p, vec2(0.2,-1.0)) * 0.31 + t * 2.1) * 0.22;
          g += vec2(1.0, 0.1) * cos(dot(p, vec2(1.0,0.1)) * 0.73 + t * 2.9) * 0.1;
          vec3 N = normalize(vec3(-g.x * 0.07, 1.0, -g.y * 0.07));
          vec3 V = normalize(cameraPosition - vW);
          vec3 R = reflect(-V, N);
          float fres = 0.04 + 0.96 * pow(1.0 - max(dot(N, V), 0.0), 5.0);
          float h = max(R.y, 0.0);
          vec3 sky = mix(vec3(0.98,0.58,0.42), vec3(0.62,0.42,0.55), smoothstep(0.0, 0.2, h));
          sky = mix(sky, vec3(0.16,0.18,0.36), smoothstep(0.18, 0.7, h));
          vec3 deep = vec3(0.05, 0.16, 0.24);
          vec3 col = mix(deep, sky, fres);
          float s = max(dot(R, uSun), 0.0);
          col += vec3(1.0, 0.75, 0.45) * (pow(s, 400.0) * 5.0 + pow(s, 40.0) * 0.35);
          float d = length(cameraPosition - vW);
          col = mix(col, uFog, smoothstep(900.0, 5200.0, d) * 0.6);
          gl_FragColor = vec4(col, 1.0);
        }`,
    }));
    scene.add(ocean);
    const surf = new THREE.Mesh(mk(foam, fIdx, true), new THREE.ShaderMaterial({
      uniforms: oceanU, transparent: true, depthWrite: false,
      vertexShader: 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }',
      fragmentShader: `varying vec2 vUv; uniform float uTime;
        void main(){
          float wave = 0.5 + 0.5 * sin(vUv.y * 2.0 - uTime * 0.8 + sin(vUv.y * 0.7) * 2.0);
          float edge = smoothstep(0.0, 0.12, vUv.x) * (1.0 - smoothstep(0.1 + wave * 0.45, 0.2 + wave * 0.6, vUv.x));
          float streak = 0.6 + 0.4 * sin(vUv.x * 60.0 - uTime * 3.0 + vUv.y * 9.0);
          gl_FragColor = vec4(vec3(0.98, 0.93, 0.88), edge * streak * 0.8);
        }`,
    }));
    scene.add(surf);
    scene.add(new THREE.Mesh(mk(wet, wIdx), layer(new THREE.MeshStandardMaterial({ color: 0x8f7a5c, roughness: 0.35, transparent: true, opacity: 0.55, depthWrite: false, side: THREE.DoubleSide }), -1)));
  }

  /* ---------- sky, far coast, lights ---------- */
  const sky = makeSky(sunDir, { horizon: new THREE.Color(1.0, 0.56, 0.38), mid: new THREE.Color(0.7, 0.42, 0.55), top: new THREE.Color(0.15, 0.17, 0.37), glow: 0.3 });
  scene.add(sky);
  // Catalina Island and the Palos Verdes hills as hazy silhouettes on the horizon
  const silhouette = (cx, cz, len, hgt, rot, col) => {
    const shape = new THREE.Shape();
    shape.moveTo(-len / 2, 0);
    for (let i = 0; i <= 40; i++) { const t = i / 40; shape.lineTo(-len / 2 + t * len, hgt * Math.pow(Math.sin(Math.PI * t), 0.6) * (0.75 + 0.25 * Math.sin(t * 17))); }
    shape.lineTo(len / 2, 0);
    const m = new THREE.Mesh(new THREE.ShapeGeometry(shape), new THREE.MeshBasicMaterial({ color: col, fog: false }));
    m.position.set(cx, -5, cz);
    m.rotation.y = rot;
    scene.add(m);
  };
  silhouette(-1600, 4300, 3600, 230, -0.35, 0xb98389);
  silhouette(-4300, -900, 2400, 160, Math.PI / 2 - 0.4, 0xb17d86);
  scene.add(new THREE.HemisphereLight(0xd2bccb, 0x8a7258, 2.3));
  const sun = new THREE.DirectionalLight(0xffb27a, 2.6);
  sun.castShadow = true;
  sun.shadow.mapSize.set(isTouch ? 1024 : 2048, isTouch ? 1024 : 2048);
  Object.assign(sun.shadow.camera, { left: -45, right: 45, top: 45, bottom: -45, near: 1, far: 320 });
  sun.shadow.bias = -0.0005;
  scene.add(sun, sun.target);

  const grid = makeGrid(10);
  const boxes = [];
  const m4 = new THREE.Matrix4(), q4 = new THREE.Quaternion(), v3 = new THREE.Vector3(), s3 = new THREE.Vector3();
  const place = (inst, n, p, yaw, sx, sy = sx, sz = sx) => { m4.compose(p, q4.setFromEuler(new THREE.Euler(0, yaw, 0)), s3.set(sx, sy, sz)); inst.setMatrixAt(n, m4); };

  /* ---------- palms ---------- */
  {
    const parts = [];
    const H = 14;
    for (let k = 0; k < 6; k++) { // gently curved trunk
      const g = new THREE.CylinderGeometry(0.2 - k * 0.012, 0.24 - k * 0.012, H / 6, 7);
      g.translate(Math.sin(k * 0.35) * 0.25, H / 12 + (k * H) / 6, 0);
      parts.push(colored(g, k % 2 ? 0x6f5f50 : 0x66584a));
    }
    const top = new THREE.Vector3(Math.sin(5 * 0.35) * 0.25, H, 0);
    for (let f = 0; f < 11; f++) { // drooping fronds
      const a = (f / 11) * Math.PI * 2;
      const g = new THREE.BoxGeometry(0.5, 0.05, 3.2);
      g.translate(0, 0, 1.6);
      g.rotateX(0.35 + (f % 3) * 0.18);
      g.rotateY(a);
      g.translate(top.x, top.y, top.z);
      parts.push(colored(g, f % 2 ? 0x34502a : 0x3e5d30));
    }
    const crown = new THREE.SphereGeometry(0.55, 8, 6);
    crown.translate(top.x, top.y - 0.2, top.z);
    parts.push(colored(crown, 0x4a3e2c));
    const geo = mergeGeometries(parts);
    const spots = [];
    for (let s = 6; s < path.length - 6; s += 22) spots.push([Math.round(s / ds), (rnd() - 0.5) * 0.6, 0.45]);            // median
    for (let s = 10; s < path.length - 10; s += 28) spots.push([Math.round(s / ds), WALK - 1.2, 0.45]);                      // inland sidewalk
    for (let s = 20; s < path.length - 20; s += 36) { if (rnd() < 0.7) spots.push([Math.round(s / ds), (LOT1 + BIKE0) / 2, 0.45]); } // between lot and bike path
    const inst = new THREE.InstancedMesh(geo, new THREE.MeshLambertMaterial({ vertexColors: true }), spots.length);
    spots.forEach(([i, lat, r], n) => {
      const p = at(clamp(i, 0, N - 1), lat);
      place(inst, n, p, rnd() * 6.28, 0.8 + rnd() * 0.45);
      grid.add(p.x, p.z, r);
    });
    inst.castShadow = true;
    scene.add(inst);
  }

  /* ---------- street lights in the median ---------- */
  {
    const pole = colored(new THREE.CylinderGeometry(0.12, 0.16, 10, 8).translate(0, 5, 0), 0x8a8d92);
    const armA = colored(new THREE.BoxGeometry(0.12, 0.12, 3.2).translate(0, 9.7, 1.5), 0x8a8d92);
    const armB = colored(new THREE.BoxGeometry(0.12, 0.12, 3.2).translate(0, 9.7, -1.5), 0x8a8d92);
    const inst = new THREE.InstancedMesh(mergeGeometries([pole, armA, armB]), new THREE.MeshLambertMaterial({ vertexColors: true }), Math.ceil(path.length / 55));
    const heads = new THREE.InstancedMesh(new THREE.BoxGeometry(0.4, 0.14, 0.9), new THREE.MeshBasicMaterial({ color: new THREE.Color(2.4, 1.9, 1.2), toneMapped: false }), Math.ceil(path.length / 55) * 2);
    let n = 0, h = 0;
    for (let s = 30; s < path.length - 10; s += 55) {
      const i = Math.round(s / ds), p = at(i, 0.6), yaw = yawAt(i) + Math.PI / 2;
      place(inst, n++, p, yaw, 1);
      for (const sg of [1, -1]) { const hp = at(i, 0.6 + sg * 3.0, 9.6); place(heads, h++, hp, yaw, 1); }
      grid.add(p.x, p.z, 0.3);
    }
    inst.count = n; heads.count = h;
    scene.add(inst, heads);
  }

  /* ---------- beach: lifeguard towers, fire rings, volleyball ---------- */
  {
    const parts = [];
    for (const [x, z] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) parts.push(colored(new THREE.BoxGeometry(0.15, 2.2, 0.15).translate(x * 1.1, 1.1, z * 1.1), 0xe9e6df));
    parts.push(colored(new THREE.BoxGeometry(3.0, 0.15, 3.0).translate(0, 2.25, 0), 0xe9e6df));
    parts.push(colored(new THREE.BoxGeometry(2.4, 1.9, 2.4).translate(0, 3.3, 0), 0x6fa3c7));
    parts.push(colored(new THREE.BoxGeometry(2.42, 0.6, 2.42).translate(0, 3.6, 0.02), 0x1d2a33)); // windows band
    parts.push(colored(new THREE.BoxGeometry(3.0, 0.15, 3.0).translate(0, 4.32, 0), 0xe9e6df));
    parts.push(colored(new THREE.BoxGeometry(1.0, 0.1, 3.4).translate(0, 1.2, -2.6).rotateX(0.5), 0xd8d2c6));
    const inst = new THREE.InstancedMesh(mergeGeometries(parts), new THREE.MeshLambertMaterial({ vertexColors: true }), Math.ceil(path.length / 170) + 2);
    let n = 0;
    for (let s = 90; s < path.length - 60; s += 170) {
      const i = Math.round(s / ds);
      const lat = -(Math.max(beachW[i] - 45, 30) + 0) ; // a little up the beach from the water
      const p = at(i, lat);
      place(inst, n++, p, yawAt(i) + Math.PI / 2, 1);
      grid.add(p.x, p.z, 1.8);
    }
    inst.count = n;
    inst.castShadow = true;
    scene.add(inst);

    // fire rings on the state beach (south-east of Beach Blvd), glowing at dusk
    const ringGeo = mergeGeometries([colored(new THREE.CylinderGeometry(0.9, 0.9, 0.45, 14, 1, true).translate(0, 0.22, 0), 0x3a3836)]);
    const rings = new THREE.InstancedMesh(ringGeo, new THREE.MeshLambertMaterial({ vertexColors: true, side: THREE.DoubleSide }), 40);
    const embers = new THREE.InstancedMesh(new THREE.CircleGeometry(0.75, 12).rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial({ color: new THREE.Color(3.0, 1.1, 0.25), toneMapped: false }), 40);
    const glowTex = canvasTex(64, 64, (c, w) => { const g = c.createRadialGradient(w / 2, w / 2, 0, w / 2, w / 2, w / 2); g.addColorStop(0, 'rgba(255,170,80,.9)'); g.addColorStop(1, 'rgba(255,120,40,0)'); c.fillStyle = g; c.fillRect(0, 0, w, w); });
    let r = 0;
    for (let s = sOf(beachIdx) + 120; s < path.length - 200 && r < 40; s += 55) {
      const i = Math.round(s / ds), lat = -(LOT1 * -1 + 20 + rnd() * 30);
      const p = at(i, lat);
      place(rings, r, p, 0, 1); place(embers, r, p.clone().setY(0.3), 0, 1);
      if (r % 2 === 0) { const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: glowTex, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, toneMapped: false })); sp.scale.set(5, 3, 1); sp.position.copy(p).setY(1.0); scene.add(sp); }
      grid.add(p.x, p.z, 0.9);
      r++;
    }
    rings.count = embers.count = r;
    scene.add(rings, embers);

    // a few volleyball nets near the pier
    for (const off of [-140, -170, 150, 185]) {
      const i = clamp(mainIdx + Math.round(off / ds), 0, N - 1), lat = -(beachW[i] * 0.55);
      const g = new THREE.Group();
      g.position.copy(at(i, lat)); g.rotation.y = yawAt(i);
      for (const sx of [-4.5, 4.5]) { const post = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.05, 2.5, 6), new THREE.MeshLambertMaterial({ color: 0xdddddd })); post.position.set(sx, 1.25, 0); g.add(post); }
      const net = new THREE.Mesh(new THREE.PlaneGeometry(9, 0.9), new THREE.MeshLambertMaterial({ color: 0x222222, transparent: true, opacity: 0.6, side: THREE.DoubleSide }));
      net.position.y = 2.0; g.add(net);
      scene.add(g);
    }
  }

  /* ---------- the pier ---------- */
  {
    const dir = pierP1.clone().sub(pierP0); const len = dir.length(); dir.normalize();
    const yaw = Math.atan2(dir.x, dir.z);
    const g = new THREE.Group();
    g.position.copy(pierP0); g.rotation.y = yaw;
    scene.add(g);
    const deckY = 6.5, rampLen = 45, W = 9.5;
    const wood = new THREE.MeshStandardMaterial({ color: 0x9a8c7c, roughness: 0.85 });
    const concrete = new THREE.MeshStandardMaterial({ color: 0xc8c1b6, roughness: 0.9 });
    // ramp up from the plaza, then the deck
    const ramp = new THREE.Mesh(new THREE.BoxGeometry(W, 0.5, Math.hypot(rampLen, deckY)), concrete);
    ramp.position.set(0, deckY / 2, rampLen / 2);
    ramp.rotation.x = -Math.atan2(deckY, rampLen);
    g.add(ramp);
    const deckLen = len - rampLen;
    const deck = new THREE.Mesh(new THREE.BoxGeometry(W, 0.6, deckLen), wood);
    deck.position.set(0, deckY, rampLen + deckLen / 2);
    deck.castShadow = deck.receiveShadow = true;
    g.add(deck);
    boxes.push(obb(0, rampLen / 2, W / 2, rampLen / 2, yaw, pierP0)); // can't drive through the ramp
    // pilings
    const piles = new THREE.InstancedMesh(new THREE.CylinderGeometry(0.35, 0.4, deckY + 3, 8), concrete, Math.ceil(deckLen / 9) * 2 + 2);
    let n = 0;
    const tmp = new THREE.Object3D();
    for (let z = rampLen + 4; z < len; z += 9) for (const x of [-3.6, 3.6]) {
      tmp.position.set(x, (deckY - 3) / 2, z); tmp.updateMatrix(); piles.setMatrixAt(n++, tmp.matrix);
      const wp = new THREE.Vector3(x, 0, z).applyAxisAngle(new THREE.Vector3(0, 1, 0), yaw).add(pierP0);
      grid.add(wp.x, wp.z, 0.45);
    }
    piles.count = n;
    g.add(piles);
    // railings + lamp posts
    const rail = new THREE.MeshStandardMaterial({ color: 0xe8e4dc, roughness: 0.6 });
    for (const x of [-W / 2 + 0.1, W / 2 - 0.1]) {
      for (const y of [deckY + 1.1, deckY + 0.6]) { const r = new THREE.Mesh(new THREE.BoxGeometry(0.08, 0.08, deckLen), rail); r.position.set(x, y, rampLen + deckLen / 2); g.add(r); }
    }
    const lampMat = new THREE.MeshBasicMaterial({ color: new THREE.Color(2.6, 2.0, 1.3), toneMapped: false });
    for (let z = rampLen + 10; z < len - 10; z += 28) for (const x of [-W / 2 + 0.3, W / 2 - 0.3]) {
      const post = new THREE.Mesh(new THREE.CylinderGeometry(0.07, 0.09, 4, 6), rail); post.position.set(x, deckY + 2, z); g.add(post);
      const globe = new THREE.Mesh(new THREE.SphereGeometry(0.28, 10, 8), lampMat); globe.position.set(x, deckY + 4.1, z); g.add(globe);
    }
    // the platform and building at the end of the pier
    const plat = new THREE.Mesh(new THREE.BoxGeometry(34, 0.6, 30), wood);
    plat.position.set(0, deckY, len - 12);
    g.add(plat);
    const bld = new THREE.Mesh(new THREE.BoxGeometry(14, 4.6, 10), new THREE.MeshStandardMaterial({ color: 0xf1ece2, roughness: 0.7 }));
    bld.position.set(0, deckY + 2.6, len - 8);
    g.add(bld);
    const roof = new THREE.Mesh(new THREE.BoxGeometry(15, 0.5, 11), new THREE.MeshStandardMaterial({ color: 0x3d8a96, roughness: 0.6 }));
    roof.position.set(0, deckY + 5.1, len - 8);
    g.add(roof);
    const win = new THREE.Mesh(new THREE.BoxGeometry(14.05, 1.4, 9), new THREE.MeshBasicMaterial({ color: new THREE.Color(1.8, 1.3, 0.8), toneMapped: false }));
    win.position.set(0, deckY + 2.4, len - 8);
    g.add(win);
  }

  /* ---------- Main St and Beach Blvd: signals and street signs ---------- */
  const streetSign = (text) => canvasTex(512, 128, (c, w, h) => {
    c.fillStyle = '#1f6b3d'; c.fillRect(0, 0, w, h); c.strokeStyle = '#f2f2f2'; c.lineWidth = 6; c.strokeRect(6, 6, w - 12, h - 12);
    c.fillStyle = '#f7f7f2'; c.font = '600 70px Inter, Arial, sans-serif'; c.textAlign = 'center'; c.textBaseline = 'middle'; c.fillText(text, w / 2, h / 2 + 4);
  });
  for (const [idx, name] of [[mainIdx, 'Main St'], [beachIdx, 'Beach Blvd']]) {
    const yaw = yawAt(idx);
    // crosswalk stripes
    const cw = new THREE.Mesh(new THREE.PlaneGeometry(EDGE * 2, 3.5), layer(new THREE.MeshStandardMaterial({ map: canvasTex(256, 32, (c, w, h) => { for (let x = 0; x < 16; x++) { c.fillStyle = x % 2 ? '#3f3f42' : '#e8e5de'; c.fillRect(x * 16, 0, 16, h); } }), roughness: 0.7 }), -4));
    cw.rotation.x = -Math.PI / 2; cw.rotation.z = yaw + Math.PI / 2;
    const cp = at(idx, 0, 0.035); cw.position.copy(cp);
    scene.add(cw);
    // signal mast arms on both sides, all green
    for (const sg of [1, -1]) {
      const g = new THREE.Group();
      g.position.copy(at(idx, sg * (WALK - 1)));
      g.rotation.y = yaw + (sg > 0 ? -Math.PI / 2 : Math.PI / 2);
      const mat = new THREE.MeshLambertMaterial({ color: 0x6c6f73 });
      const post = new THREE.Mesh(new THREE.CylinderGeometry(0.18, 0.22, 7, 8), mat); post.position.y = 3.5; g.add(post);
      const arm = new THREE.Mesh(new THREE.BoxGeometry(0.15, 0.15, 9), mat); arm.position.set(0, 6.6, 4.5); g.add(arm);
      for (const z of [3.5, 7.5]) {
        const head = new THREE.Mesh(new THREE.BoxGeometry(0.45, 1.2, 0.35), new THREE.MeshLambertMaterial({ color: 0x1b1b1b })); head.position.set(0, 6.0, z); g.add(head);
        const lamp = new THREE.Mesh(new THREE.CircleGeometry(0.13, 12), new THREE.MeshBasicMaterial({ color: new THREE.Color(0.3, 2.6, 1.2), toneMapped: false }));
        lamp.position.set(0.23, 5.65, z); lamp.rotation.y = Math.PI / 2; g.add(lamp);
        const lamp2 = lamp.clone(); lamp2.position.x = -0.23; lamp2.rotation.y = -Math.PI / 2; g.add(lamp2);
      }
      const sign = new THREE.Mesh(new THREE.PlaneGeometry(2.4, 0.6), new THREE.MeshBasicMaterial({ map: streetSign(name), side: THREE.DoubleSide }));
      sign.position.set(0, 7.15, 5.4); sign.rotation.y = Math.PI / 2; g.add(sign);
      scene.add(g);
      const p = g.position; grid.add(p.x, p.z, 0.35);
    }
  }

  /* ---------- buildings: downtown, resort hotels, homes ---------- */
  {
    const bMat = new THREE.MeshStandardMaterial({ roughness: 0.85 });
    // windows drawn from world position, so every building gets evenly spaced, partly lit windows
    bMat.onBeforeCompile = (sh) => {
      sh.vertexShader = sh.vertexShader.replace('#include <common>', '#include <common>\nvarying vec3 vWPos; varying vec3 vWN;')
        .replace('#include <project_vertex>', `#include <project_vertex>
          vec4 wpos = vec4(transformed, 1.0); vec4 wn = vec4(objectNormal, 0.0);
          #ifdef USE_INSTANCING
            wpos = instanceMatrix * wpos; wn = instanceMatrix * wn;
          #endif
          vWPos = (modelMatrix * wpos).xyz; vWN = normalize((modelMatrix * wn).xyz);`);
      sh.fragmentShader = sh.fragmentShader.replace('#include <common>', '#include <common>\nvarying vec3 vWPos; varying vec3 vWN; float gWin = 0.0; float gLit = 0.0;')
        .replace('#include <color_fragment>', `#include <color_fragment>
          float wall = step(abs(vWN.y), 0.5);
          float hz = abs(vWN.x) > abs(vWN.z) ? vWPos.z : vWPos.x;
          vec2 gg = vec2(hz / 3.4, (vWPos.y - 0.6) / 3.3);
          vec2 ff = fract(gg);
          gWin = wall * step(0.18, ff.x) * step(ff.x, 0.8) * step(0.3, ff.y) * step(ff.y, 0.8) * step(1.0, vWPos.y);
          gLit = step(0.62, fract(sin(dot(floor(gg) + floor(vWPos.xz / 40.0), vec2(12.9898, 78.233))) * 43758.5453));
          diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.07, 0.08, 0.1), gWin * 0.85);`)
        .replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>
          totalEmissiveRadiance += vec3(1.0, 0.72, 0.42) * gWin * gLit * 0.9;`);
    };
    const geo = new THREE.BoxGeometry(1, 1, 1).translate(0, 0.5, 0);
    const list = [];
    const pal = [0xe9dccb, 0xd9c7b0, 0xcfd7d4, 0xe6d3c3, 0xbfcfd9, 0xe8e2d6, 0xd7b8a5, 0xc9d6c3];
    const mainS = sOf(mainIdx), beachS = sOf(beachIdx);
    for (let s = 40; s < path.length - 40;) {
      const i = Math.round(s / ds);
      const dMain = Math.abs(s - mainS), hotel = s > beachS - 900 && s < beachS + 250;
      let w, d, h, set;
      if (dMain < 650) { w = 14 + rnd() * 18; d = 18 + rnd() * 16; h = 3.4 * (2 + Math.floor(rnd() * 3)) + 1; set = 4 + rnd() * 4; }
      else if (hotel) { w = 50 + rnd() * 60; d = 35 + rnd() * 25; h = 3.4 * (5 + Math.floor(rnd() * 5)) + 1; set = 22 + rnd() * 14; }
      else { w = 12 + rnd() * 10; d = 14 + rnd() * 8; h = 3.4 * (1 + Math.floor(rnd() * 3)) + 0.6; set = 12 + rnd() * 18; }
      if (rnd() < (dMain < 650 ? 0.92 : 0.7)) list.push({ i, lat: WALK + set + d / 2, w, d, h, col: pal[Math.floor(rnd() * pal.length)] });
      // a second row behind, for a skyline
      if (rnd() < 0.6) list.push({ i, lat: WALK + set + d + 30 + rnd() * 40, w: w * (0.7 + rnd() * 0.5), d: 16 + rnd() * 10, h: 3.4 * (1 + Math.floor(rnd() * 3)) + 0.6, col: pal[Math.floor(rnd() * pal.length)], back: true });
      s += w + 4 + rnd() * 10;
    }
    const inst = new THREE.InstancedMesh(geo, bMat, list.length);
    list.forEach((b, n) => {
      const i = clamp(b.i, 0, N - 1), p = at(i, b.lat), yaw = yawAt(i);
      // box: x across (depth), z along the road (frontage)
      m4.compose(p, q4.setFromEuler(new THREE.Euler(0, yaw, 0)), s3.set(b.d, b.h, b.w));
      inst.setMatrixAt(n, m4);
      inst.setColorAt(n, new THREE.Color(b.col));
      if (!b.back) boxes.push(obb(p.x, p.z, b.d / 2, b.w / 2, yaw));
    });
    inst.castShadow = true;
    inst.receiveShadow = true;
    scene.add(inst);
  }

  /* ---------- parked cars in the beach lots ---------- */
  {
    const body = new RoundedBoxGeometry(1.8, 0.72, 4.4, 3, 0.22).translate(0, 0.62, 0);
    const cab = new RoundedBoxGeometry(1.56, 0.6, 2.3, 3, 0.2).translate(0, 1.18, -0.25);
    const wheelParts = [];
    for (const [x, z] of [[-0.82, 1.35], [0.82, 1.35], [-0.82, -1.35], [0.82, -1.35]]) wheelParts.push(new THREE.CylinderGeometry(0.33, 0.33, 0.24, 14).rotateZ(Math.PI / 2).translate(x, 0.33, z));
    const bodies = new THREE.InstancedMesh(body, new THREE.MeshStandardMaterial({ roughness: 0.35, metalness: 0.35 }), 400);
    const cabs = new THREE.InstancedMesh(cab, new THREE.MeshStandardMaterial({ color: 0x15181c, roughness: 0.1, metalness: 0.5 }), 400);
    const wheels = new THREE.InstancedMesh(mergeGeometries(wheelParts), new THREE.MeshStandardMaterial({ color: 0x141414, roughness: 0.9 }), 400);
    const cols = [0xf2f2f0, 0x1c1c1e, 0x8a8f96, 0x2f4a6b, 0xa3271f, 0xd8d3c8, 0x3d4a3a, 0x5a5f66];
    let n = 0;
    for (let s = 20; s < path.length - 20 && n < 400; s += 2.8) {
      const i = Math.round(s / ds);
      if (nearMain(i)) continue;
      for (const lat of [LOT0 - 6.3, LOT1 + 6.3]) {
        if (rnd() > 0.32 || n >= 400) continue;
        const p = at(i, lat), yaw = yawAt(i) + (lat > (LOT0 + LOT1) / 2 ? -Math.PI / 2 : Math.PI / 2);
        place(bodies, n, p, yaw, 1); place(cabs, n, p, yaw, 1); place(wheels, n, p, yaw, 1);
        bodies.setColorAt(n, new THREE.Color(cols[Math.floor(rnd() * cols.length)]));
        const fx = Math.sin(yaw), fz = Math.cos(yaw);
        grid.add(p.x + fx * 1.2, p.z + fz * 1.2, 1.0); grid.add(p.x - fx * 1.2, p.z - fz * 1.2, 1.0);
        n++;
      }
    }
    bodies.count = cabs.count = wheels.count = n;
    bodies.castShadow = true;
    scene.add(bodies, cabs, wheels);
  }

  /* ---------- road ends: closed barriers ---------- */
  {
    const mat = new THREE.MeshStandardMaterial({ color: 0xd9d4ca, roughness: 0.8 });
    const stripeTex = canvasTex(128, 32, (c, w, h) => { for (let x = -h; x < w; x += 24) { c.fillStyle = '#e8e3d8'; c.fillRect(0, 0, 0, 0); } c.fillStyle = '#f1ede4'; c.fillRect(0, 0, w, h); c.fillStyle = '#d2571f'; for (let x = -h; x < w + h; x += 32) { c.beginPath(); c.moveTo(x, 0); c.lineTo(x + 16, 0); c.lineTo(x + 16 - h, h); c.lineTo(x - h, h); c.fill(); } }, true);
    for (const [i, sg] of [[0, -1], [N - 1, 1]]) {
      const p = at(i, -15).add(T[i].clone().multiplyScalar(sg * 25));
      const yaw = yawAt(i);
      // rotation = yaw puts the box's local x across the road (along L)
      const wall = new THREE.Mesh(new THREE.BoxGeometry(70, 1.0, 0.7), mat);
      wall.position.copy(p).setY(0.5); wall.rotation.y = yaw;
      scene.add(wall);
      const board = new THREE.Mesh(new THREE.BoxGeometry(14, 1.2, 0.15), new THREE.MeshStandardMaterial({ map: stripeTex, roughness: 0.7 }));
      board.position.copy(at(i, 0, 1.6).add(T[i].clone().multiplyScalar(sg * 24.5))); board.rotation.y = yaw;
      scene.add(board);
      boxes.push(obb(wall.position.x, wall.position.z, 35, 0.35, yaw));
    }
  }

  // timing points: a run is Seapoint St <-> Santa Ana River
  const tA = Math.round(80 / ds), tB = N - 1 - Math.round(80 / ds);
  for (const i of [tA, tB]) {
    const line = new THREE.Mesh(new THREE.PlaneGeometry(EDGE * 2, 1.2), layer(new THREE.MeshStandardMaterial({ map: canvasTex(256, 32, (c) => { for (let x = 0; x < 16; x++) for (let y = 0; y < 2; y++) { c.fillStyle = (x + y) % 2 ? '#111' : '#eee'; c.fillRect(x * 16, y * 16, 16, 16); } }), roughness: 0.7 }), -4));
    line.rotation.x = -Math.PI / 2; line.rotation.z = yawAt(i) + Math.PI / 2;
    line.position.copy(at(i, 0, 0.04));
    scene.add(line);
  }

  scene.environment = envFromSky(renderer, sky, 0x9a8a72);

  const startI = Math.max(tA - Math.round(60 / ds), 2);
  const dirAll = C[N - 1].clone().sub(C[0]);
  return {
    key: 'pch', scene, sun, sunDir, sky, path, boxes, grid,
    timing: { type: 'sprint', a: tA, b: tB, names: ['Seapoint St', 'Santa Ana River'] },
    bestKey: (car) => `garage-best-pch-${car}`,
    dust: new THREE.Color(0.66, 0.58, 0.46),
    farLimit: 420,
    intro: 'south on PCH, past the pier',
    mapRotate: -Math.atan2(dirAll.z, dirAll.x),
    mapMarks: [{ x: pierP1.x, z: pierP1.z, color: '#7fb7d9' }],
    startPose() { const p = at(startI, -7.8); return { x: p.x, z: p.z, yaw: yawAt(startI) }; },
    // keep to the right: south-bound on the ocean side, north-bound inland
    resetPose(i, s) { const p = at(i, s > 0 ? -7.8 : 7.8); return { x: p.x, z: p.z, yaw: yawAt(i) + (s > 0 ? 0 : Math.PI) }; },
    surface(st, n) {
      const lat = n.lat;
      const beyondEnd = n.d > Math.abs(lat) + 4;
      const plaza = Math.abs(sOf(n.i) - sOf(mainIdx)) < 120 && lat < 0 && lat > -80;
      const paved = (lat < WALK + 0.5 && lat > -WALK - 0.5) || (lat <= LOT0 && lat >= LOT1) || (lat <= BIKE0 && lat >= BIKE1) || plaza;
      return { off: !paved || beyondEnd, kerb: Math.abs(lat) < MED };
    },
    update(dt) { oceanU.uTime.value += dt; },
    // surf gets louder the closer you are to the water
    ambience: 'surf',
    ambLevel(st) {
      const i = clamp(st.idx, 0, N - 1);
      const lat = (st.x - C[i].x) * L[i].x + (st.z - C[i].z) * L[i].z;
      return clamp(1 - (beachW[i] + lat - 20) / 380, 0.12, 1);
    },
    info: { length: path.length, mainIdx, beachIdx },
  };
}
