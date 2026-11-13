import * as THREE from 'three';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { RectAreaLightUniformsLib } from 'three/addons/lights/RectAreaLightUniformsLib.js';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { PROJECTS } from '../js/content.js';
import { buildCar, CAR_SPECS } from './cars.js';
import { createDrive, LOCATIONS } from './drive.js';

/* =========================================================
   Helpers
   ========================================================= */
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const lerp = (a, b, t) => a + (b - a) * t;
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const ease = (t) => t * t * (3 - 2 * t);
const pad2 = (n) => String(n).padStart(2, '0');
const isTouch = matchMedia('(hover: none), (pointer: coarse)').matches;
const asset = (p) => `../${p}`;
if (isTouch) document.body.classList.add('is-touch');

const GOLD = 0xe3a10a;

/* =========================================================
   Renderer
   ========================================================= */
const canvas = $('#gl');
// Can this device draw the 3D garage? If not, the plain page (body.no-3d) takes over and everything else still works.
let renderer = null;
try {
  const probe = document.createElement('canvas');
  if (window.WebGLRenderingContext && (probe.getContext('webgl2') || probe.getContext('webgl'))) {
    renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
  }
} catch { renderer = null; }
const GL = !!renderer;
if (GL) {
  renderer.setPixelRatio(Math.min(devicePixelRatio, isTouch ? 1.5 : 2));
  renderer.setSize(innerWidth, innerHeight);
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.0;
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  RectAreaLightUniformsLib.init();
}
let plain = false;
const isPlain = () => plain || document.body.classList.contains('no-3d');
function goPlain() {
  if (ui.mode === 'drive') { drive?.exit(); ui.mode = 'garage'; document.body.classList.remove('driving'); }
  if (ui.picking) closePicker();
  if (ui.panelOpen) closePanel();
  document.body.classList.add('no-3d', 'loaded');
  document.documentElement.classList.add('no-3d');
  document.documentElement.classList.remove('locked');
  document.body.classList.remove('locked');
  plain = true;
}
// the graphics driver can drop the 3D at any time (sleep, low memory): fall back instead of freezing
canvas.addEventListener('webglcontextlost', (e) => { e.preventDefault(); goPlain(); });

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x07080b);
scene.fog = new THREE.Fog(0x07080b, 30, 90);
const camera = new THREE.PerspectiveCamera(50, innerWidth / innerHeight, 0.1, 500);

const pmrem = GL ? new THREE.PMREMGenerator(renderer) : null;
const envTex = GL ? pmrem.fromScene(new RoomEnvironment(renderer), 0.04).texture : null;

/* =========================================================
   Loading (textures) + loader counter
   ========================================================= */
const manager = new THREE.LoadingManager();
const texLoader = new THREE.TextureLoader(manager);
let loadTarget = 0, loadShown = 0, loadDone = false;
manager.onProgress = (_, loaded, total) => { loadTarget = loaded / total; };
manager.onLoad = () => {
  loadTarget = 1; loadDone = true;
  document.body.classList.add('assets-ready');
  // finish on a timer, not on frames: background tabs and slow phones can drop to ~1 frame a second
  setTimeout(finishLoader, 1100);
};
function finishLoader() {
  if (document.body.classList.contains('ready-3d') || isPlain()) return;
  $('#loader-num').textContent = '100';
  $('#loader-bar').style.transform = 'scaleX(1)';
  document.body.classList.add('loaded', 'ready-3d');
  // arrived on a shared link like /garage/#contact? go straight there
  const i = STOP_IDS[location.hash.slice(1)];
  if (i != null) setTimeout(() => focusStop(i, true), 400);
  readScroll();
}
function loadTex(url, onLoad) {
  const t = texLoader.load(url, (tx) => onLoad && onLoad(tx));
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 8;
  return t;
}

/* canvas textures for signs, labels, walls */
function canvasTex(w, h, draw, repeat) {
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  draw(c.getContext('2d'), w, h);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 8;
  if (repeat) t.wrapS = t.wrapT = THREE.RepeatWrapping;
  return t;
}
let seed = 7;
const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
function speckle(ctx, w, h, n, a) {
  for (let i = 0; i < n; i++) {
    const v = (rnd() - 0.5) * a;
    ctx.fillStyle = v > 0 ? `rgba(255,255,255,${v})` : `rgba(0,0,0,${-v})`;
    ctx.fillRect(rnd() * w, rnd() * h, 1 + rnd() * 2, 1 + rnd() * 2);
  }
}

/* =========================================================
   The garage
   ========================================================= */
const G = { frames: [], cars: {}, neon: [], hits: [], certs: [] };
const W = 7, D = 11, H = 4.2; // half-width, depth, height (m)

function std(color, rough = 0.8, metal = 0, extra = {}) {
  return new THREE.MeshStandardMaterial({ color, roughness: rough, metalness: metal, ...extra });
}
function mesh(geo, mat, x = 0, y = 0, z = 0, parent = scene) {
  const m = new THREE.Mesh(geo, mat);
  m.position.set(x, y, z);
  parent.add(m);
  return m;
}
const boxG = (w, h, d) => new THREE.BoxGeometry(w, h, d);

function buildGarage() {
  // ---- surfaces ----
  const blockTex = canvasTex(512, 512, (c, w, h) => {
    c.fillStyle = '#8d8d92'; c.fillRect(0, 0, w, h);
    speckle(c, w, h, 14000, 0.25);
    c.fillStyle = 'rgba(0,0,0,.5)';
    const rows = 8, cols = 4;
    for (let r = 0; r < rows; r++) {
      const y = (r / rows) * h;
      c.fillRect(0, y, w, 3);
      const offX = r % 2 ? w / cols / 2 : 0;
      for (let k = 0; k <= cols; k++) c.fillRect(((k / cols) * w + offX) % w, y, 3, h / rows);
    }
  }, true);
  const wallMat = (len, hgt) => {
    const t = blockTex.clone();
    t.needsUpdate = true;
    t.repeat.set(len / 1.6, hgt / 1.6);
    return std(0x55565c, 0.92, 0, { map: t });
  };
  const floorTex = canvasTex(512, 512, (c, w, h) => { c.fillStyle = '#7d7f86'; c.fillRect(0, 0, w, h); speckle(c, w, h, 30000, 0.3); }, true);
  floorTex.repeat.set(6, 5);
  const floor = mesh(new THREE.PlaneGeometry(W * 2, D), std(0x45464c, 0.3, 0.05, { map: floorTex, envMap: envTex, envMapIntensity: 0.25 }), 0, 0, -D / 2);
  floor.rotation.x = -Math.PI / 2;
  floor.receiveShadow = true;

  const back = mesh(new THREE.PlaneGeometry(W * 2, H), wallMat(W * 2, H), 0, H / 2, -D);
  const left = mesh(new THREE.PlaneGeometry(D, H), wallMat(D, H), -W, H / 2, -D / 2);
  left.rotation.y = Math.PI / 2;
  const right = mesh(new THREE.PlaneGeometry(D, H), wallMat(D, H), W, H / 2, -D / 2);
  right.rotation.y = -Math.PI / 2;
  [back, left, right].forEach((m) => (m.receiveShadow = true));
  const ceil = mesh(new THREE.PlaneGeometry(W * 2, D), std(0x141416, 0.9), 0, H, -D / 2);
  ceil.rotation.x = Math.PI / 2;

  // front facade with the door opening
  const doorW = 10, doorH = 3.4;
  const fw = 10.5, fh = 5.8;
  const sh = new THREE.Shape();
  sh.moveTo(-fw, 0); sh.lineTo(-doorW / 2, 0); sh.lineTo(-doorW / 2, doorH); sh.lineTo(doorW / 2, doorH); sh.lineTo(doorW / 2, 0);
  sh.lineTo(fw, 0); sh.lineTo(fw, fh); sh.lineTo(-fw, fh); sh.lineTo(-fw, 0);
  const facadeTex = blockTex.clone(); facadeTex.needsUpdate = true; facadeTex.repeat.set(1 / 1.6, 1 / 1.6);
  const facade = mesh(new THREE.ExtrudeGeometry(sh, { depth: 0.35, bevelEnabled: false }), std(0x3c3d42, 0.9, 0, { map: facadeTex }), 0, 0, -0.35);
  facade.receiveShadow = true;
  // exterior side walls + roof slab
  mesh(boxG(0.35, fh, D + 0.35), std(0x2e2f33, 0.9), -W - 0.18, fh / 2, -D / 2 - 0.1);
  mesh(boxG(0.35, fh, D + 0.35), std(0x2e2f33, 0.9), W + 0.18, fh / 2, -D / 2 - 0.1);
  mesh(boxG(fw * 2, 0.4, D + 0.6), std(0x1d1e21, 0.9), 0, fh + 0.2, -D / 2);
  // neighbouring dark buildings
  mesh(boxG(14, 7, 12), std(0x17181b, 0.95), -18, 3.5, -6);
  mesh(boxG(14, 6.2, 12), std(0x17181b, 0.95), 18, 3.1, -6);
  // rolled-up door + rails
  const drum = mesh(new THREE.CylinderGeometry(0.32, 0.32, doorW + 0.3, 20), std(0x4b4c51, 0.5, 0.6), 0, doorH + 0.32, -0.6);
  drum.rotation.z = Math.PI / 2;
  for (const s of [-1, 1]) mesh(boxG(0.08, doorH, 0.1), std(0x2b2c30, 0.5, 0.6), s * (doorW / 2 - 0.05), doorH / 2, -0.45);

  // outside: apron, road, kerb, stars
  const asph = canvasTex(256, 256, (c, w, h) => { c.fillStyle = '#3a3a3d'; c.fillRect(0, 0, w, h); speckle(c, w, h, 9000, 0.3); }, true);
  asph.repeat.set(30, 30);
  const ground = mesh(new THREE.PlaneGeometry(160, 160), std(0x2a2a2d, 0.75, 0, { map: asph }), 0, -0.005, 40);
  ground.rotation.x = -Math.PI / 2;
  ground.receiveShadow = true;
  // parking lines outside
  for (const x of [-5, 0, 5]) {
    const l = mesh(new THREE.PlaneGeometry(0.12, 5.5), std(0xd8d2c4, 0.7), x, 0.003, 3.4);
    l.rotation.x = -Math.PI / 2;
  }
  // gold bay markings inside
  const goldLine = std(GOLD, 0.4, 0.6, { emissive: GOLD, emissiveIntensity: 0.08 });
  for (const [x, z, w, d] of [[0, -5.6, 0.1, 8.2], [-W + 0.4, -5.6, 0.06, 8.2], [W - 0.4, -5.6, 0.06, 8.2], [0, -1.5, W * 2 - 0.8, 0.06]]) {
    const l = mesh(new THREE.PlaneGeometry(w, d), goldLine, x, 0.004, z);
    l.rotation.x = -Math.PI / 2;
  }
  const stars = new THREE.BufferGeometry();
  const sp = [];
  for (let i = 0; i < 700; i++) {
    const a = rnd() * Math.PI * 2, e = 0.08 + rnd() * 1.3, r = 300;
    sp.push(Math.cos(a) * Math.cos(e) * r, Math.sin(e) * r, Math.sin(a) * Math.cos(e) * r);
  }
  stars.setAttribute('position', new THREE.Float32BufferAttribute(sp, 3));
  scene.add(new THREE.Points(stars, new THREE.PointsMaterial({ color: 0xbfc6d8, size: 1.4, sizeAttenuation: false, fog: false })));

  // traffic cones by the door
  const coneMat = std(0xff6a13, 0.55);
  for (const [x, z] of [[-6.2, 1.6], [6.0, 2.2], [6.7, 1.3]]) {
    const cone = mesh(new THREE.ConeGeometry(0.17, 0.62, 18), coneMat, x, 0.34, z);
    mesh(new THREE.CylinderGeometry(0.105, 0.135, 0.1, 18), std(0xf2f2f2, 0.4), x, 0.38, z);
    mesh(boxG(0.42, 0.04, 0.42), std(0x111111, 0.7), x, 0.02, z);
    cone.castShadow = true;
  }

  // ---- exterior sign + lamps ----
  const sign = canvasTex(2048, 256, (c, w, h) => {
    c.clearRect(0, 0, w, h);
    c.font = '500 150px "Cormorant Garamond", serif';
    c.textAlign = 'center'; c.textBaseline = 'middle';
    c.shadowColor = 'rgba(255,190,60,0.95)'; c.shadowBlur = 40;
    c.fillStyle = '#ffd77a';
    c.fillText('Sam Russakov', w / 2, h / 2 + 8);
    c.shadowBlur = 0; c.fillStyle = '#fff3cf';
    c.fillText('Sam Russakov', w / 2, h / 2 + 8);
  });
  const signMat = new THREE.MeshBasicMaterial({ map: sign, transparent: true, toneMapped: false, color: new THREE.Color(1.6, 1.35, 1.0) });
  const signMesh = mesh(new THREE.PlaneGeometry(6.4, 0.8), signMat, 0, 4.55, 0.02);
  G.neon.push(signMat);
  for (const s of [-1, 1]) {
    mesh(boxG(0.5, 0.12, 0.3), std(0x111111, 0.5, 0.6), s * 6.6, 3.95, 0.15);
    mesh(boxG(0.42, 0.03, 0.22), new THREE.MeshBasicMaterial({ color: new THREE.Color(3, 2.6, 2.0), toneMapped: false }), s * 6.6, 3.88, 0.17);
    const sl = new THREE.SpotLight(0xffd9a6, 26, 14, 0.9, 0.7, 1.6);
    sl.position.set(s * 6.6, 3.85, 0.3);
    sl.target.position.set(s * 6.2, 0, 3);
    scene.add(sl, sl.target);
  }

  // ---- ceiling LED bars + area lights ----
  const ledMat = new THREE.MeshBasicMaterial({ color: new THREE.Color(2.4, 2.3, 2.1), toneMapped: false });
  for (const x of [-3.4, 0, 3.4]) for (const z of [-2.6, -5.6, -8.6]) mesh(boxG(2.2, 0.04, 0.1), ledMat, x, H - 0.03, z);
  for (const [x, z] of [[-2.6, -4.8], [2.6, -4.8]]) {
    const ra = new THREE.RectAreaLight(0xfff1df, 2.6, 3.2, 2.2);
    ra.position.set(x, H - 0.05, z);
    ra.lookAt(x, 0, z);
    scene.add(ra);
  }
  const fill = new THREE.RectAreaLight(0xfff1df, 2.2, 10, 1.2);
  fill.position.set(0, H - 0.05, -9.3);
  fill.lookAt(0, 1.5, -11);
  scene.add(fill);
  const key = new THREE.SpotLight(0xfff0dc, 70, 16, 0.95, 0.75, 1.4);
  key.position.set(0, H - 0.1, -3.2);
  key.target.position.set(0, 0, -5);
  key.castShadow = true;
  key.shadow.mapSize.set(isTouch ? 1024 : 2048, isTouch ? 1024 : 2048);
  key.shadow.bias = -0.0004;
  key.shadow.radius = 4;
  scene.add(key, key.target);
  scene.add(new THREE.HemisphereLight(0x9aa6c4, 0x1a1612, 0.35));
  // warm spill out of the door onto the apron
  const spill = new THREE.SpotLight(0xffe2b8, 40, 22, 0.75, 0.9, 1.3);
  spill.position.set(0, 3.2, -2);
  spill.target.position.set(0, 0, 6);
  scene.add(spill, spill.target);

  // ---- workbench along the back wall ----
  const benchTop = std(0x5a4632, 0.6, 0.05);
  const steel = std(0x26272b, 0.45, 0.7);
  mesh(boxG(12.6, 0.06, 0.75), benchTop, 0, 0.93, -D + 0.42).castShadow = true;
  mesh(boxG(12.6, 0.86, 0.68), steel, 0, 0.45, -D + 0.38).receiveShadow = true;
  for (let i = -5; i <= 5; i += 1.25) mesh(boxG(1.1, 0.012, 0.01), std(0x8a8b90, 0.3, 0.9), i, 0.62, -D + 0.725);
  // the PC from "The Build"
  const pc = new THREE.Group();
  const mesh2 = canvasTex(128, 256, (c, w, h) => { c.fillStyle = '#2a2b2f'; c.fillRect(0, 0, w, h); c.fillStyle = '#0c0c0e'; for (let y = 6; y < h - 6; y += 9) for (let x = 6 + ((y / 9) % 2) * 4; x < w - 6; x += 9) { c.beginPath(); c.moveTo(x, y); c.lineTo(x + 6, y); c.lineTo(x + 3, y + 6); c.fill(); } });
  const pcBody = mesh(boxG(0.24, 0.5, 0.48), std(0x1b1c20, 0.5, 0.4), 0, 0.25, 0, pc);
  mesh(new THREE.PlaneGeometry(0.2, 0.46), std(0xffffff, 0.6, 0.3, { map: mesh2 }), 0, 0.25, 0.242, pc);
  mesh(new THREE.PlaneGeometry(0.18, 0.4), new THREE.MeshBasicMaterial({ color: new THREE.Color(0.9, 0.6, 0.15), transparent: true, opacity: 0.35, toneMapped: false }), 0, 0.25, 0.236, pc);
  pcBody.castShadow = true;
  pc.position.set(5.4, 0.96, -D + 0.45);
  pc.rotation.y = -0.35;
  scene.add(pc);
  // helmet for Track Days
  const helmet = new THREE.Group();
  const shell = mesh(new THREE.SphereGeometry(0.17, 28, 20), new THREE.MeshPhysicalMaterial({ color: 0xf1ede6, roughness: 0.25, clearcoat: 1, envMap: envTex, envMapIntensity: 0.8 }), 0, 0.17, 0, helmet);
  shell.scale.set(1, 1, 1.15);
  const visor = mesh(new THREE.SphereGeometry(0.172, 24, 12, -0.9, 1.8, 1.1, 0.75), new THREE.MeshPhysicalMaterial({ color: 0x0a0a0c, roughness: 0.05, metalness: 0.4, clearcoat: 1, envMap: envTex }), 0, 0.17, 0.01, helmet);
  visor.scale.set(1.02, 1.02, 1.17);
  mesh(boxG(0.36, 0.02, 0.06), std(GOLD, 0.35, 0.8), 0, 0.27, 0, helmet).rotation.x = -0.3;
  helmet.position.set(-5.4, 0.96, -D + 0.45);
  helmet.rotation.y = 0.5;
  helmet.traverse((m) => m.isMesh && (m.castShadow = true));
  scene.add(helmet);
  // stopwatch + organiser
  mesh(new THREE.CylinderGeometry(0.05, 0.05, 0.02, 20), std(0x111111, 0.4, 0.5), -4.6, 0.97, -D + 0.5);
  mesh(boxG(0.7, 0.18, 0.3), std(0x2a2b2f, 0.5, 0.5), 3.9, 1.05, -D + 0.3);

  // ---- tool chest + pegboard on the left wall ----
  const chest = new THREE.Group();
  mesh(boxG(0.72, 1.15, 1.6), std(0x1d1e22, 0.35, 0.7), 0, 0.62, 0, chest).castShadow = true;
  for (let i = 0; i < 6; i++) {
    mesh(boxG(0.01, 0.13, 1.5), std(0x2c2d32, 0.35, 0.7), 0.365, 0.2 + i * 0.16, 0, chest);
    mesh(boxG(0.03, 0.02, 1.2), std(0xd9d9d9, 0.15, 1), 0.38, 0.25 + i * 0.16, 0, chest);
  }
  mesh(boxG(0.74, 0.04, 1.62), std(GOLD, 0.4, 0.8), 0, 1.22, 0, chest);
  chest.position.set(-W + 0.4, 0, -3.1);
  scene.add(chest);
  const peg = canvasTex(256, 128, (c, w, h) => { c.fillStyle = '#4b3c2c'; c.fillRect(0, 0, w, h); c.fillStyle = '#1b140d'; for (let y = 6; y < h; y += 10) for (let x = 6; x < w; x += 10) { c.beginPath(); c.arc(x, y, 1.6, 0, 7); c.fill(); } }, true);
  peg.repeat.set(3, 1.5);
  const pegBoard = mesh(new THREE.PlaneGeometry(4.2, 1.6), std(0xffffff, 0.85, 0, { map: peg }), -W + 0.02, 1.95, -5.6);
  pegBoard.rotation.y = Math.PI / 2;
  const chromeMat = std(0xdadada, 0.18, 1, { envMap: envTex });
  for (let i = 0; i < 9; i++) {
    const len = 0.22 + (i % 4) * 0.06;
    const t = mesh(boxG(0.02, len, 0.035), chromeMat, -W + 0.05, 2.25 - len / 2 + 0.1, -7.3 + i * 0.22);
    t.castShadow = true;
  }
  for (let i = 0; i < 5; i++) mesh(new THREE.TorusGeometry(0.06 + i * 0.01, 0.012, 8, 20), chromeMat, -W + 0.06, 1.55, -5.4 + i * 0.24).rotation.y = Math.PI / 2;
  // spare race tyres, stacked
  for (let i = 0; i < 4; i++) {
    const t = mesh(new THREE.TorusGeometry(0.31, 0.14, 12, 28), std(0x121212, 0.9), -W + 0.65, 0.15 + i * 0.27, -9.6);
    t.rotation.x = Math.PI / 2;
    t.castShadow = true;
  }
  // SR lightbox on the left wall
  const logoTex = loadTex(asset('assets/logo.png'));
  const lb = mesh(new THREE.PlaneGeometry(1.15, 1.15), new THREE.MeshBasicMaterial({ map: logoTex, transparent: true, toneMapped: false, color: new THREE.Color(1.5, 1.4, 1.2) }), -W + 0.03, 2.1, -2.0);
  lb.rotation.y = Math.PI / 2;
  // neon on the left wall
  const neon = canvasTex(2048, 300, (c, w, h) => {
    c.font = 'italic 500 190px "Cormorant Garamond", serif';
    c.textAlign = 'center'; c.textBaseline = 'middle';
    c.shadowColor = 'rgba(255,180,40,1)'; c.shadowBlur = 50;
    c.fillStyle = '#ffd25e'; c.fillText('Driven by detail.', w / 2, h / 2);
    c.shadowBlur = 0; c.fillStyle = '#fff4d0'; c.fillText('Driven by detail.', w / 2, h / 2);
  });
  const neonMat = new THREE.MeshBasicMaterial({ map: neon, transparent: true, toneMapped: false, color: new THREE.Color(1.8, 1.5, 1.0) });
  const nm = mesh(new THREE.PlaneGeometry(4.6, 0.68), neonMat, -W + 0.04, 3.35, -5.6);
  nm.rotation.y = Math.PI / 2;
  G.neon.push(neonMat);
  const neonLight = new THREE.PointLight(0xffb84a, 6, 6, 1.8);
  neonLight.position.set(-W + 0.6, 3.3, -5.6);
  scene.add(neonLight);

  // ---- the strengths gallery on the back wall ----
  // wide, soft wash so all four posters get the same light (no hot spot in the middle)
  const wallSpot = new THREE.SpotLight(0xffe6c4, 24, 16, 1.05, 1, 1.3);
  wallSpot.position.set(0, H - 0.2, -6.5);
  wallSpot.target.position.set(0, 2.2, -D);
  scene.add(wallSpot, wallSpot.target);
  PROJECTS.forEach((p, i) => G.frames.push(makeFrame(p, i)));

  // ---- About wall (right): portrait, certificates, medals ----
  const aboutSpot = new THREE.SpotLight(0xffe6c4, 26, 12, 0.8, 0.6, 1.3);
  aboutSpot.position.set(3.0, H - 0.2, -8.2);
  aboutSpot.target.position.set(W, 2, -8.2);
  scene.add(aboutSpot, aboutSpot.target);
  const portrait = framed(asset('assets/img/portrait.jpg'), 1.3, 1.65, null);
  portrait.position.set(W - 0.05, 2.15, -7.45);
  portrait.rotation.y = -Math.PI / 2;
  scene.add(portrait);
  // the real certificates, framed to the left of the portrait (click to verify on LinkedIn)
  const certs = [
    ['assets/img/cert-product-management.jpg', 'https://www.linkedin.com/learning/certificates/d1bb8b26d3bbbaf8ffa8849ee7f29a3e8a19ffec2b53fb60dcf9f356c03ea391'],
    ['assets/img/cert-social-media.jpg', 'https://www.linkedin.com/learning/certificates/d8084809ab130d89e7f933f4f98891119a3c083d29c7c1cb6ad30b9ecca6cd2a'],
  ];
  certs.forEach(([img, url], i) => {
    const f = framed(asset(img), 1.16, 0.896, null, 0xb4b4b4);
    f.position.set(W - 0.05, 2.62 - i * 1.06, -9.15);
    f.rotation.y = -Math.PI / 2;
    f.traverse((m) => { if (m.isMesh) m.userData.url = url; });
    scene.add(f);
    G.certs.push(f);
  });
  // shelf with race medals
  mesh(boxG(0.3, 0.04, 1.9), std(0x5a4632, 0.6), W - 0.15, 1.12, -4.3);
  for (let i = 0; i < 3; i++) {
    const z = -5.0 + i * 0.55;
    const rib = mesh(new THREE.PlaneGeometry(0.06, 0.34), std([0x1f4fbf, 0xc4271d, 0x111111][i], 0.7, 0, { side: THREE.DoubleSide }), W - 0.03, 1.85, z);
    rib.rotation.y = -Math.PI / 2;
    const md = mesh(new THREE.CylinderGeometry(0.07, 0.07, 0.015, 24), std(GOLD, 0.3, 1, { envMap: envTex }), W - 0.03, 1.62, z);
    md.rotation.z = Math.PI / 2;
  }
  // trophy
  const tr = new THREE.Group();
  mesh(boxG(0.14, 0.06, 0.14), std(0x111111, 0.5), 0, 0.03, 0, tr);
  mesh(new THREE.CylinderGeometry(0.02, 0.03, 0.14, 12), std(GOLD, 0.25, 1, { envMap: envTex }), 0, 0.13, 0, tr);
  mesh(new THREE.CylinderGeometry(0.09, 0.04, 0.16, 20), std(GOLD, 0.25, 1, { envMap: envTex }), 0, 0.28, 0, tr);
  tr.position.set(W - 0.15, 1.14, -3.65);
  scene.add(tr);

  // ---- the cars ----
  const m240 = buildCar('m240i');
  m240.root.position.set(-2.55, 0, -4.7);
  m240.root.rotation.y = 0.1;
  const gt3 = buildCar('gt3');
  gt3.root.position.set(2.6, 0, -4.9);
  gt3.root.rotation.y = -0.1;
  for (const c of [m240, gt3]) {
    c.root.traverse((m) => { if (m.isMesh && m.material.isMeshStandardMaterial) { m.material.envMap = envTex; m.material.envMapIntensity = m.material.userData.env ?? 0.6; } });
    scene.add(c.root);
    c.setWheels(0.18, 0);
  }
  G.cars = { m240i: m240, gt3 };
  G.hits = [m240.root, gt3.root];
}

/* a photo in a frame. tex: url or texture; focus: [x, y] crop focus */
function framed(src, w, h, focus, tint = 0xffffff) {
  const g = new THREE.Group();
  const frame = mesh(boxG(w + 0.12, h + 0.12, 0.05), std(0x0d0d0e, 0.5, 0.3), 0, 0, 0, g);
  frame.castShadow = true;
  const tex = typeof src === 'string' ? loadTex(src, (t) => coverCrop(t, w / h, focus)) : src;
  mesh(new THREE.PlaneGeometry(w, h), new THREE.MeshStandardMaterial({ map: tex, roughness: 0.85, color: tint }), 0, 0, 0.027, g);
  return g;
}
function coverCrop(t, aspect, focus) {
  const img = t.image;
  const ia = img.width / img.height;
  const [fx, fy] = focus || [0.5, 0.5];
  t.repeat.set(1, 1); t.offset.set(0, 0);
  if (ia > aspect) { t.repeat.x = aspect / ia; t.offset.x = (1 - t.repeat.x) * fx; }
  else { t.repeat.y = ia / aspect; t.offset.y = (1 - t.repeat.y) * (1 - fy); }
  t.needsUpdate = true;
}

/* a strength poster: photo + caption, on the back wall */
function makeFrame(p, i) {
  const g = new THREE.Group();
  const w = 2.5, h = 2.0, pw = 2.3, ph = 1.45;
  const back = mesh(boxG(w, h, 0.06), std(0x0d0d0e, 0.5, 0.3), 0, 0, 0, g);
  back.castShadow = true;
  const trimMat = std(GOLD, 0.35, 0.9, { emissive: GOLD, emissiveIntensity: 0 });
  const trim = mesh(boxG(pw + 0.04, ph + 0.04, 0.01), trimMat, 0, (h - ph) / 2 - 0.1, 0.031, g);
  const tex = loadTex(asset(p.img), (t) => coverCrop(t, pw / ph, p.focus));
  // matte print, slightly dimmed so bright photos don't blow out under the lights
  const photo = mesh(new THREE.PlaneGeometry(pw, ph), new THREE.MeshStandardMaterial({ map: tex, roughness: 0.95, color: 0xc8c8c8 }), 0, (h - ph) / 2 - 0.1, 0.037, g);
  const cap = canvasTex(1024, 128, (c, cw, chh) => {
    c.fillStyle = '#0d0d0e'; c.fillRect(0, 0, cw, chh);
    c.textBaseline = 'middle';
    c.fillStyle = '#ffdc3c'; c.font = '500 30px "JetBrains Mono", monospace'; c.fillText(pad2(i + 1), 18, chh / 2);
    c.fillStyle = '#f2ede4'; c.font = '500 64px "Cormorant Garamond", serif'; c.fillText(p.title, 92, chh / 2 + 4);
    c.textAlign = 'right'; c.fillStyle = 'rgba(242,237,228,.6)'; c.font = '400 26px "JetBrains Mono", monospace';
    c.fillText(p.role.toUpperCase(), cw - 18, chh / 2);
  });
  mesh(new THREE.PlaneGeometry(pw, pw / 8), new THREE.MeshBasicMaterial({ map: cap }), 0, -h / 2 + 0.2, 0.031, g);
  // picture light
  mesh(boxG(1.0, 0.05, 0.12), std(0x111111, 0.4, 0.6), 0, h / 2 + 0.12, 0.12, g);
  mesh(boxG(0.92, 0.012, 0.06), new THREE.MeshBasicMaterial({ color: new THREE.Color(2.6, 2.3, 1.8), toneMapped: false }), 0, h / 2 + 0.094, 0.13, g);
  photo.userData.frame = i;
  back.userData.frame = i;
  scene.add(g);
  return { g, photo, back, trimMat, i, hover: 0 };
}

/* frames: a row on wide screens, a 2x2 grid on tall ones */
function layoutFrames() {
  const portrait = innerWidth / innerHeight < 0.9;
  G.frames.forEach((f, i) => {
    if (portrait) {
      const s = 0.74;
      f.g.scale.setScalar(s);
      f.g.position.set(i % 2 ? 1.0 : -1.0, i < 2 ? 3.22 : 1.74, -D + 0.04);
    } else {
      f.g.scale.setScalar(1);
      f.g.position.set([-4.65, -1.55, 1.55, 4.65][i], 2.25, -D + 0.04);
    }
  });
}

/* =========================================================
   Camera stops
   ========================================================= */
function stops() {
  const a = innerWidth / innerHeight;
  const V = (x, y, z) => new THREE.Vector3(x, y, z);
  if (a < 0.9) {
    return [
      { pos: V(0, 1.75, 17), look: V(0, 1.2, -4), fov: 62 },
      { pos: V(0, 2.3, -3.4), look: V(0, 1.15, -11), fov: 66 },
      { pos: V(1.2, 2.1, -8.3), look: V(7, 1.25, -8.3), fov: 66 },
      { pos: V(0, 2.4, 4.6), look: V(0, -0.6, -4.8), fov: 62 },
    ];
  }
  return [
    { pos: V(0, 1.6, 15.5), look: V(-2.4, 1.55, -5), fov: 50 },
    { pos: V(0, 2.05, -2.5), look: V(0, 1.12, -11), fov: 52 },
    { pos: V(2.4, 1.95, -8.6), look: V(7, 1.8, -9.9), fov: 52 },
    { pos: V(0.4, 1.15, 2.6), look: V(-1.6, 0.65, -4.8), fov: 50 },
  ];
}
let STOPS = stops();
const pickCams = () => {
  const a = innerWidth / innerHeight;
  const V = (x, y, z) => new THREE.Vector3(x, y, z);
  if (a < 0.9) return {
    m240i: { pos: V(0.6, 2.2, 1.8), look: V(-2.55, -0.4, -4.7), fov: 60 },
    gt3: { pos: V(-0.4, 2.2, 1.7), look: V(2.6, -0.4, -4.9), fov: 60 },
  };
  return {
    m240i: { pos: V(0.9, 1.75, 1.9), look: V(-2.6, -0.35, -4.7), fov: 40 },
    gt3: { pos: V(-0.9, 1.75, 1.8), look: V(2.65, -0.35, -4.9), fov: 40 },
  };
};
let PICK = pickCams();

/* =========================================================
   UI
   ========================================================= */
const ui = {
  progress: 0, stop: 0, picking: false, pickKey: 'm240i', panelOpen: false,
  mode: 'garage', hoverFrame: -1, hoverCar: null,
};
const copies = $$('.copy');
const navBtns = $$('.bottom [data-go]');

function readScroll() {
  const max = document.documentElement.scrollHeight - innerHeight;
  ui.progress = max > 0 ? clamp(scrollY / max, 0, 1) * 3 : 0;
  const s = Math.round(ui.progress);
  const near = Math.abs(ui.progress - s) < 0.2;
  copies.forEach((c) => c.classList.toggle('on', near && +c.dataset.stop === s));
  navBtns.forEach((b) => b.classList.toggle('active', +b.dataset.go === s && near));
  $('#progress').style.transform = `scaleX(${ui.progress / 3})`;
  ui.stop = s;
}
addEventListener('scroll', readScroll, { passive: true });
const smoothOK = () => !matchMedia('(prefers-reduced-motion: reduce)').matches;
function goStop(i, instant = false) {
  const behavior = instant || !smoothOK() ? 'auto' : 'smooth';
  if (isPlain()) { copies[i].scrollIntoView({ behavior }); return; }
  const max = document.documentElement.scrollHeight - innerHeight;
  scrollTo({ top: (max * i) / 3, behavior });
}
// jump to a stop and put keyboard / screen-reader focus on its heading once it's on screen
function focusStop(i, instant = false) {
  goStop(i, instant);
  const h = copies[i].querySelector('h1, h2');
  let tries = 0;
  const go = () => {
    if (isPlain() || copies[i].classList.contains('on')) h.focus({ preventScroll: true });
    else if (tries++ < 60) setTimeout(go, 50);
  };
  go();
}
navBtns.forEach((b) => b.addEventListener('click', () => focusStop(+b.dataset.go)));
// skip link and shareable links (#strengths-stop, #about, #contact)
const STOP_IDS = { top: 0, 'strengths-stop': 1, about: 2, contact: 3 };
$('.skip').addEventListener('click', (e) => { e.preventDefault(); focusStop(3); });
addEventListener('hashchange', () => { const i = STOP_IDS[location.hash.slice(1)]; if (i != null) focusStop(i); });

// keep keyboard focus inside whichever layer is on top (panel, picker or the drive HUD)
const layers = () => [$('.skip'), $('.top'), $('#content'), $('.bottom'), $('#panel'), $('#picker'), $('#hud')];
function isolate(keep) { for (const el of layers()) if (el) el.inert = el !== keep; }
function release() {
  for (const el of layers()) if (el) el.inert = false;
  $('#hud').inert = ui.mode !== 'drive';
}
const announce = (msg) => { const el = $('#sr-status'); el.textContent = ''; setTimeout(() => { el.textContent = msg; }, 30); };
let returnFocus = null;
const restoreFocus = () => { const el = returnFocus; returnFocus = null; if (el && document.contains(el)) setTimeout(() => el.focus({ preventScroll: true }), 40); };

// strengths list
const list = $('#strengths');
list.innerHTML = PROJECTS.map((p, i) => `<li><button data-i="${i}"><span class="n">${pad2(i + 1)}</span><span class="t">${p.title}</span><span class="r">${p.role}</span></button></li>`).join('');
const listBtns = $$('button', list);
listBtns.forEach((b) => {
  b.addEventListener('click', () => openPanel(+b.dataset.i));
  b.addEventListener('pointerenter', () => setHoverFrame(+b.dataset.i));
  b.addEventListener('pointerleave', () => setHoverFrame(-1));
});
function setHoverFrame(i) {
  ui.hoverFrame = i;
  listBtns.forEach((b) => b.classList.toggle('hot', +b.dataset.i === i));
  document.body.classList.toggle('hover-frame', i >= 0 || !!ui.hoverCar);
}

// panel
const panel = $('#panel');
let current = 0;
function lockScroll(on) {
  document.documentElement.classList.toggle('locked', on);
  document.body.classList.toggle('locked', on);
}
function openPanel(i) {
  current = i;
  const p = PROJECTS[i];
  const next = PROJECTS[(i + 1) % PROJECTS.length];
  $('#pp-kicker').textContent = `${pad2(i + 1)} / ${pad2(PROJECTS.length)} — ${p.cat}`;
  $('#pp-title').textContent = p.title;
  const pos = p.focus ? `${p.focus[0] * 100}% ${p.focus[1] * 100}%` : '50% 50%';
  $('#pp-hero').src = asset(p.img);
  $('#pp-hero').alt = p.title;
  $('#pp-hero').style.objectPosition = pos;
  $('.pp-hero').style.aspectRatio = p.heroRatio || p.ratio || '';
  $('#pp-cat').textContent = p.cat;
  $('#pp-role').textContent = p.role;
  $('#pp-body').innerHTML = p.body.map((t) => `<p>${t}</p>`).join('');
  $('#pp-gallery').innerHTML = p.gallery
    .map((g, n) => `<figure${p.ratio ? ` style="aspect-ratio:${p.ratio}"` : ''}><img src="${asset(g)}" alt="${p.title}, photo ${n + 2}" loading="lazy"></figure>`).join('');
  $('#pp-next-title').textContent = next.title;
  panel.scrollTop = 0;
  if (!ui.panelOpen) returnFocus = document.activeElement;
  panel.classList.add('open');
  panel.setAttribute('aria-hidden', 'false');
  document.body.classList.add('panel-open');
  ui.panelOpen = true;
  lockScroll(true);
  isolate(panel);
  requestAnimationFrame(() => $('[data-close]', panel).focus({ preventScroll: true }));
}
function closePanel() {
  panel.classList.remove('open');
  panel.setAttribute('aria-hidden', 'true');
  document.body.classList.remove('panel-open');
  ui.panelOpen = false;
  lockScroll(false);
  release();
  restoreFocus();
}
$('[data-close]', panel).addEventListener('click', closePanel);
$('#pp-next').addEventListener('click', () => {
  panel.classList.remove('open');
  setTimeout(() => openPanel((current + 1) % PROJECTS.length), 450);
});

// copy email
$$('[data-copy]').forEach((btn) => btn.addEventListener('click', async () => {
  const text = btn.dataset.copy;
  let ok = false;
  try { await navigator.clipboard.writeText(text); ok = true; } catch {
    const ta = document.createElement('textarea');
    ta.value = text; document.body.appendChild(ta); ta.select();
    try { ok = document.execCommand('copy'); } catch {}
    ta.remove();
  }
  btn.textContent = ok ? 'Copied' : 'Press Ctrl+C';
  announce(ok ? 'Email address copied' : 'Copy failed. Select the address and press Ctrl+C');
  btn.classList.toggle('copied', ok);
  setTimeout(() => { btn.textContent = 'Copy'; btn.classList.remove('copied'); }, 1800);
}));

// car picker
const picker = $('#picker');
$('#cars').innerHTML = Object.values(CAR_SPECS).map((s) => `
  <button class="car-card" data-car="${s.key}">
    <div class="row"><span class="name">${s.name}</span><span class="label tag">${s.tag}</span></div>
    <p class="blurb">${s.blurb}</p>
    <dl>${s.stats.map(([k, v]) => `<div><dt>${k}</dt><dd>${v}</dd></div>`).join('')}</dl>
    <div class="bars">${Object.entries(s.bars).map(([k, v]) => `<div class="bar"><span class="label">${k}</span><i style="--v:${Math.round(v * 100)}%"></i></div>`).join('')}</div>
    <span class="go">Drive the ${s.name} →</span>
  </button>`).join('');
const cards = $$('.car-card');
function hotCar(key) {
  ui.pickKey = key;
  cards.forEach((c) => c.classList.toggle('hot', c.dataset.car === key));
}
cards.forEach((c) => {
  c.addEventListener('pointerenter', () => hotCar(c.dataset.car));
  c.addEventListener('focus', () => hotCar(c.dataset.car));
  c.addEventListener('click', () => { if (!drive) return; drive.sound.unlock(); startDrive(c.dataset.car); }); // audio must start inside the tap
});

// location switch (remembered in this browser)
try { ui.loc = localStorage.getItem('garage-loc') || 'willow'; } catch { ui.loc = 'willow'; }
if (!LOCATIONS[ui.loc]) ui.loc = 'willow';
$('#locs').innerHTML = Object.values(LOCATIONS).map((l) => `<button type="button" aria-pressed="false" data-loc="${l.key}"><span class="full">${l.name}</span><span class="short">${l.short}</span><small>${l.tag}</small></button>`).join('');
function setLoc(key) {
  ui.loc = key;
  try { localStorage.setItem('garage-loc', key); } catch {}
  $$('#locs button').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.loc === key)));
  $('#pick-title').innerHTML = LOCATIONS[key].title;
  $('#pick-blurb').textContent = LOCATIONS[key].blurb;
}
$$('#locs button').forEach((b) => b.addEventListener('click', () => setLoc(b.dataset.loc)));
setLoc(ui.loc);
function openPicker(key) {
  if (ui.mode !== 'garage' || isPlain()) return;
  if (ui.panelOpen) closePanel();
  returnFocus = document.activeElement;
  hotCar(key || ui.pickKey);
  ui.picking = true;
  isolate(picker);
  picker.classList.add('open');
  picker.setAttribute('aria-hidden', 'false');
  document.body.classList.add('picking');
  lockScroll(true);
  setTimeout(() => $(`.car-card[data-car="${ui.pickKey}"]`)?.focus({ preventScroll: true }), 50);
}
function closePicker(keepFocus = false) {
  ui.picking = false;
  picker.classList.remove('open');
  picker.setAttribute('aria-hidden', 'true');
  document.body.classList.remove('picking');
  lockScroll(false);
  release();
  if (keepFocus) returnFocus = null; else restoreFocus();
}
$$('[data-open-picker]').forEach((b) => b.addEventListener('click', () => openPicker()));
$('[data-close-picker]').addEventListener('click', () => closePicker());

/* =========================================================
   Drive mode
   ========================================================= */
const drive = GL ? createDrive(renderer) : null;
if (new URLSearchParams(location.search).has('debug')) window.__drive = drive; // console access for testing: add ?debug
const fade = $('#fade');
function startDrive(key) {
  fade.classList.add('on');
  setTimeout(() => {
    closePicker(true);
    lockScroll(true);
    drive.enter(key, ui.loc);
    ui.mode = 'drive';
    document.body.classList.add('driving');
    $('#hud').setAttribute('aria-hidden', 'false');
    isolate($('#hud'));
    document.activeElement?.blur(); // keys drive the car; don't leave a button focused under Space
    if (composer) { renderPass.scene = drive.scene; renderPass.camera = drive.camera; }
    setTimeout(() => fade.classList.remove('on'), 120);
  }, 650);
}
function exitDrive() {
  fade.classList.add('on');
  setTimeout(() => {
    drive.exit();
    ui.mode = 'garage';
    document.body.classList.remove('driving');
    $('#hud').setAttribute('aria-hidden', 'true');
    if (composer) { renderPass.scene = scene; renderPass.camera = camera; }
    lockScroll(false);
    release();
    focusStop(3, true);
    setTimeout(() => fade.classList.remove('on'), 150);
  }, 650);
}
$('#hud-park').addEventListener('click', exitDrive);
$('#hud-cam').addEventListener('click', () => drive.cycleCamera());
$('#hud-reset').addEventListener('click', () => drive.reset());
$('#hud-sound').addEventListener('click', () => { drive?.sound.unlock(); drive?.toggleSound(); });

// touch controls
$$('#touch [data-in]').forEach((b) => {
  const k = b.dataset.in;
  const on = (e) => {
    e.preventDefault();
    drive.input[k] = 1;
    b.classList.add('down');
    try { b.setPointerCapture(e.pointerId); } catch {}
  };
  const off = () => { drive.input[k] = 0; b.classList.remove('down'); };
  b.addEventListener('pointerdown', on);
  b.addEventListener('pointerup', off);
  b.addEventListener('pointercancel', off);
  b.addEventListener('lostpointercapture', off);
  b.addEventListener('contextmenu', (e) => e.preventDefault());
});
document.addEventListener('touchmove', (e) => { if (ui.mode === 'drive') e.preventDefault(); }, { passive: false });

// keys
addEventListener('keydown', (e) => {
  if (e.target.closest && e.target.closest('input, textarea')) return;
  if (e.key === 'Escape') {
    if (ui.mode === 'drive') exitDrive();
    else if (ui.picking) closePicker();
    else if (ui.panelOpen) closePanel();
  }
  if (ui.mode === 'garage' && !ui.panelOpen && (e.key === 'd' || e.key === 'D') && !ui.picking) openPicker();
  if (ui.picking && (e.key === 'ArrowLeft' || e.key === 'ArrowRight' || e.key === 'ArrowUp' || e.key === 'ArrowDown')) {
    hotCar(ui.pickKey === 'm240i' ? 'gt3' : 'm240i');
    $(`.car-card[data-car="${ui.pickKey}"]`)?.focus({ preventScroll: true });
    e.preventDefault();
  }
});

/* =========================================================
   Pointer: hover frames / cars in the 3D scene
   ========================================================= */
const ray = new THREE.Raycaster();
const ndc = new THREE.Vector2(9, 9);
const mouse = { x: 0, y: 0, sx: 0, sy: 0 };
addEventListener('pointermove', (e) => {
  ndc.set((e.clientX / innerWidth) * 2 - 1, -(e.clientY / innerHeight) * 2 + 1);
  if (e.pointerType === 'mouse') { mouse.x = ndc.x; mouse.y = ndc.y; }
}, { passive: true });
function pick3D() {
  if (ui.mode !== 'garage' || ui.panelOpen || ui.picking) return { frame: -1, car: null };
  ray.setFromCamera(ndc, camera);
  if (Math.abs(ui.progress - 1) < 0.25) {
    const hit = ray.intersectObjects(G.frames.flatMap((f) => [f.photo, f.back]), false)[0];
    return { frame: hit ? hit.object.userData.frame : -1, car: null };
  }
  if (Math.abs(ui.progress - 2) < 0.25) {
    const hit = ray.intersectObjects(G.certs, true)[0];
    if (hit) return { frame: -1, car: null, url: hit.object.userData.url };
  }
  if (Math.abs(ui.progress - 3) < 0.25) {
    for (const [k, c] of Object.entries(G.cars)) if (ray.intersectObject(c.root, true).length) return { frame: -1, car: k };
  }
  return { frame: -1, car: null };
}
canvas.addEventListener('click', (e) => {
  ndc.set((e.clientX / innerWidth) * 2 - 1, -(e.clientY / innerHeight) * 2 + 1);
  const h = pick3D();
  if (h.frame >= 0) openPanel(h.frame);
  else if (h.car) openPicker(h.car);
  else if (h.url) window.open(h.url, '_blank', 'noopener');
});

/* =========================================================
   Post-processing (desktop only)
   ========================================================= */
let composer = null, renderPass = null;
if (GL && !isTouch) {
  composer = new EffectComposer(renderer);
  renderPass = new RenderPass(scene, camera);
  composer.addPass(renderPass);
  composer.addPass(new UnrealBloomPass(new THREE.Vector2(innerWidth, innerHeight), 0.45, 0.5, 0.92));
  composer.addPass(new OutputPass());
}

/* =========================================================
   Resize
   ========================================================= */
function resize() {
  if (GL) {
    renderer.setSize(innerWidth, innerHeight);
    camera.aspect = innerWidth / innerHeight;
    camera.updateProjectionMatrix();
    composer?.setSize(innerWidth, innerHeight);
    STOPS = stops();
    PICK = pickCams();
    layoutFrames();
    drive.resize();
  }
  readScroll();
}
addEventListener('resize', resize);

/* =========================================================
   Loop
   ========================================================= */
const camPos = new THREE.Vector3(), camLook = new THREE.Vector3();
let camFov = 50, first = true;
const clock = new THREE.Clock();
let hoverTick = 0;

function frame() {
  const dt = Math.min(clock.getDelta(), 0.05);
  const t = clock.elapsedTime;

  // loader
  if (!document.body.classList.contains('loaded')) {
    loadShown = lerp(loadShown, loadTarget, 1 - Math.exp(-dt * 5)); // time-based, not per-frame
    $('#loader-num').textContent = String(Math.round(loadShown * 100)).padStart(3, '0');
    $('#loader-bar').style.transform = `scaleX(${loadShown})`;
    if (loadDone && loadShown > 0.985 && t > 1.1) finishLoader();
  }

  if (ui.mode === 'drive') {
    drive.update(dt);
    if (composer) composer.render(); else renderer.render(drive.scene, drive.camera);
    requestAnimationFrame(frame);
    return;
  }

  // camera target from the scroll position (or the picker)
  let tp, tl, tf;
  if (ui.picking) {
    const c = PICK[ui.pickKey];
    tp = c.pos; tl = c.look; tf = c.fov;
  } else {
    const p = ui.progress;
    const i = Math.min(Math.floor(p), 2), f = ease(clamp(p - i, 0, 1));
    tp = STOPS[i].pos.clone().lerp(STOPS[i + 1].pos, f);
    tl = STOPS[i].look.clone().lerp(STOPS[i + 1].look, f);
    tf = lerp(STOPS[i].fov, STOPS[i + 1].fov, f);
  }
  mouse.sx = lerp(mouse.sx, mouse.x, 0.05);
  mouse.sy = lerp(mouse.sy, mouse.y, 0.05);
  const par = new THREE.Vector3(mouse.sx * 0.25, mouse.sy * 0.12, 0);
  if (first) { camPos.copy(tp); camLook.copy(tl); camFov = tf; first = false; }
  const k = 1 - Math.exp(-dt * (ui.picking ? 3 : 5));
  camPos.lerp(tp.clone().add(par), k);
  camLook.lerp(tl, k);
  camFov = lerp(camFov, tf, k);
  camera.position.copy(camPos);
  camera.lookAt(camLook);
  camera.fov = camFov;
  camera.updateProjectionMatrix();

  // hover in the scene (throttled)
  if (++hoverTick % 3 === 0 && !isTouch) {
    const h = pick3D();
    if (h.frame !== ui.hoverFrame && !listBtns.some((b) => b.matches(':hover'))) setHoverFrame(h.frame);
    ui.hoverCar = h.car || h.url || null; // anything clickable gets the pointer cursor
    document.body.classList.toggle('hover-frame', ui.hoverFrame >= 0 || !!ui.hoverCar);
  }
  G.frames.forEach((f) => {
    f.hover = lerp(f.hover, f.i === ui.hoverFrame ? 1 : 0, 0.12);
    f.trimMat.emissiveIntensity = f.hover * 1.6;
    f.g.position.z = -D + 0.04 + f.hover * 0.08;
  });

  // neon: flickers on at load, then a gentle hum
  const on = document.body.classList.contains('loaded') ? clamp((t - 1.4) * 1.2, 0, 1) : 0;
  const flick = on < 1 ? (Math.sin(t * 60) > 0.2 ? on : on * 0.2) : 0.94 + Math.sin(t * 7.0) * 0.03 + (Math.random() < 0.004 ? -0.4 : 0);
  G.neon.forEach((m) => (m.opacity = flick));

  if (composer) composer.render(); else renderer.render(scene, camera);
  requestAnimationFrame(frame);
}

/* =========================================================
   Start (wait briefly for fonts so the canvas text uses them)
   ========================================================= */
async function start() {
  try {
    await Promise.race([
      Promise.all([
        document.fonts.load('500 64px "Cormorant Garamond"'),
        document.fonts.load('italic 500 64px "Cormorant Garamond"'),
        document.fonts.load('400 26px "JetBrains Mono"'),
        document.fonts.load('500 30px "JetBrains Mono"'),
      ]),
      new Promise((r) => setTimeout(r, 2500)),
    ]);
  } catch {}
  if (!GL) {
    // no 3D on this device: show the plain page (everything except driving still works)
    goPlain();
    readScroll();
    const i = STOP_IDS[location.hash.slice(1)];
    if (i != null) focusStop(i, true);
    return;
  }
  buildGarage();
  layoutFrames();
  readScroll();
  requestAnimationFrame(frame);
}
start();
