import * as THREE from 'three';
import { buildCar, CAR_SPECS } from './cars.js';
import { canvasTex, makeRnd, clamp } from './world-utils.js';
import { buildWillow } from './world-willow.js';
import { buildPCH } from './world-pch.js';
import { createSound } from './audio.js';

/* =========================================================
   Drive mode core: car physics, camera, HUD, laps / timed runs.
   The location (track or road) comes from a "world" module.
   ========================================================= */

const $ = (s) => document.querySelector(s);
const damp = (a, b, k, dt) => a + (b - a) * (1 - Math.exp(-k * dt));
const isTouch = matchMedia('(hover: none), (pointer: coarse)').matches;
const rnd = makeRnd(4242);

export const LOCATIONS = {
  willow: {
    key: 'willow', build: buildWillow,
    name: 'Willow Springs', short: 'Willow Springs', tag: 'Circuit',
    title: 'Willow Springs, <em>golden hour.</em>',
    blurb: 'A 2.5-mile desert circuit modelled on Big Willow. Pull out of the pit garage, cross the line and set a lap.',
  },
  pch: {
    key: 'pch', build: buildPCH,
    name: 'PCH · Huntington Beach', short: 'PCH · HB', tag: 'Coast road',
    title: 'Pacific Coast Highway, <em>sunset.</em>',
    blurb: 'Five and a half miles of PCH through Huntington Beach, from Seapoint St past the pier to the Santa Ana River. Time a run, or just cruise.',
  },
};

export function createDrive(renderer) {
  const camera = new THREE.PerspectiveCamera(58, innerWidth / innerHeight, 0.3, 7000);
  const sound = createSound();
  const soundBtn = $('#hud-sound');
  const showSound = () => { if (soundBtn) soundBtn.firstChild.textContent = sound.enabled ? 'Sound on ' : 'Sound off '; };
  showSound();
  const worlds = {};
  let W = null; // the active world

  /* ---------- dust / tyre smoke ---------- */
  const MAXP = 260;
  const pGeo = new THREE.BufferGeometry();
  const pPos = new Float32Array(MAXP * 3), pCol = new Float32Array(MAXP * 3), pLife = new Float32Array(MAXP), pVel = new Float32Array(MAXP * 3);
  pPos.fill(-100);
  pGeo.setAttribute('position', new THREE.BufferAttribute(pPos, 3));
  pGeo.setAttribute('color', new THREE.BufferAttribute(pCol, 3));
  const puff = canvasTex(64, 64, (c, w) => { const g = c.createRadialGradient(w / 2, w / 2, 0, w / 2, w / 2, w / 2); g.addColorStop(0, 'rgba(255,255,255,.55)'); g.addColorStop(1, 'rgba(255,255,255,0)'); c.fillStyle = g; c.fillRect(0, 0, w, w); });
  const pts = new THREE.Points(pGeo, new THREE.PointsMaterial({ size: 1.1, map: puff, vertexColors: true, transparent: true, opacity: 0.35, depthWrite: false, sizeAttenuation: true }));
  pts.frustumCulled = false;
  let pNext = 0;
  function emit(x, z, col, vx, vz) {
    const i = pNext; pNext = (pNext + 1) % MAXP;
    pPos[i * 3] = x; pPos[i * 3 + 1] = 0.3; pPos[i * 3 + 2] = z;
    pVel[i * 3] = vx + (rnd() - 0.5); pVel[i * 3 + 1] = 0.6 + rnd() * 0.8; pVel[i * 3 + 2] = vz + (rnd() - 0.5);
    pLife[i] = 1;
    pCol[i * 3] = col.r; pCol[i * 3 + 1] = col.g; pCol[i * 3 + 2] = col.b;
  }
  const smokeCol = new THREE.Color(0.62, 0.62, 0.64);
  function updateParticles(dt) {
    for (let i = 0; i < MAXP; i++) {
      if (pLife[i] <= 0) continue;
      pLife[i] -= dt * 0.7;
      pPos[i * 3] += pVel[i * 3] * dt; pPos[i * 3 + 1] += pVel[i * 3 + 1] * dt; pPos[i * 3 + 2] += pVel[i * 3 + 2] * dt;
      pVel[i * 3] *= 0.97; pVel[i * 3 + 2] *= 0.97;
      if (pLife[i] <= 0.15) pPos[i * 3 + 1] = -100;
    }
    pGeo.attributes.position.needsUpdate = true;
    pGeo.attributes.color.needsUpdate = true;
  }

  /* ---------- minimap ---------- */
  const mm = $('#minimap');
  const mmCtx = mm.getContext('2d');
  let mmScale, mmOx, mmOz, mmRot = 0;
  function sizeMinimap() {
    const dpr = Math.min(devicePixelRatio, 2);
    const w = mm.clientWidth || 160, h = mm.clientHeight || 110;
    mm.width = w * dpr; mm.height = h * dpr;
    const { C } = W.path;
    // long straight-ish roads are rotated so they run across the map
    mmRot = W.mapRotate || 0;
    const rp = (p) => [p.x * Math.cos(mmRot) - p.z * Math.sin(mmRot), p.x * Math.sin(mmRot) + p.z * Math.cos(mmRot)];
    let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
    C.forEach((p) => { const [x, z] = rp(p); minX = Math.min(minX, x); maxX = Math.max(maxX, x); minZ = Math.min(minZ, z); maxZ = Math.max(maxZ, z); });
    mmScale = Math.min((mm.width - 16 * dpr) / (maxX - minX || 1), (mm.height - 16 * dpr) / (maxZ - minZ || 1));
    mmOx = (mm.width - (maxX - minX) * mmScale) / 2 - minX * mmScale;
    mmOz = (mm.height - (maxZ - minZ) * mmScale) / 2 - minZ * mmScale;
  }
  const mmPt = (x, z) => [(x * Math.cos(mmRot) - z * Math.sin(mmRot)) * mmScale + mmOx, (x * Math.sin(mmRot) + z * Math.cos(mmRot)) * mmScale + mmOz];
  function drawMinimap() {
    const c = mmCtx, dpr = Math.min(devicePixelRatio, 2), { C, closed } = W.path;
    c.clearRect(0, 0, mm.width, mm.height);
    c.lineWidth = 3 * dpr; c.strokeStyle = 'rgba(244,239,230,.35)'; c.lineJoin = 'round';
    c.beginPath();
    C.forEach((p, i) => { const [x, z] = mmPt(p.x, p.z); if (i) c.lineTo(x, z); else c.moveTo(x, z); });
    if (closed) c.closePath();
    c.stroke();
    c.fillStyle = '#f4efe6';
    const marks = W.timing.type === 'circuit' ? [W.timing.lineIdx] : [W.timing.a, W.timing.b];
    for (const i of marks) { const [x, z] = mmPt(C[i].x, C[i].z); c.fillRect(x - 2 * dpr, z - 2 * dpr, 4 * dpr, 4 * dpr); }
    for (const m of W.mapMarks || []) { const [x, z] = mmPt(m.x, m.z); c.fillStyle = m.color; c.beginPath(); c.arc(x, z, 2.5 * dpr, 0, 7); c.fill(); }
    const [px, pz] = mmPt(st.x, st.z);
    c.save(); c.translate(px, pz); c.rotate(-st.yaw + Math.PI + mmRot);
    c.fillStyle = '#d9b46a'; c.beginPath(); c.moveTo(0, -6 * dpr); c.lineTo(4 * dpr, 5 * dpr); c.lineTo(-4 * dpr, 5 * dpr); c.closePath(); c.fill();
    c.restore();
  }

  /* ---------- input ---------- */
  const input = { gas: 0, brake: 0, left: 0, right: 0, hand: 0 };
  const keymap = { KeyW: 'gas', ArrowUp: 'gas', KeyS: 'brake', ArrowDown: 'brake', KeyA: 'left', ArrowLeft: 'left', KeyD: 'right', ArrowRight: 'right', Space: 'hand' };
  let active = false;
  const onKey = (e, v) => {
    if (!active) return;
    const k = keymap[e.code];
    if (k) { input[k] = v; e.preventDefault(); }
    if (v && e.code === 'KeyR') resetToRoad();
    if (v && e.code === 'KeyC') camMode = (camMode + 1) % 3;
    if (v && e.code === 'KeyM' && !e.repeat) { sound.toggle(); showSound(); }
  };
  addEventListener('keydown', (e) => onKey(e, 1));
  addEventListener('keyup', (e) => onKey(e, 0));
  addEventListener('blur', () => { for (const k in input) input[k] = 0; mouse.on = false; });

  // hold the left mouse button and steer with the mouse (centre of the screen = straight ahead)
  const mouse = { on: false, axis: 0 };
  const glc = $('#gl'), ind = $('#steer-ind'), indDot = ind && ind.querySelector('i');
  const mouseAxis = (e) => clamp((e.clientX - innerWidth / 2) / (innerWidth * 0.28), -1, 1);
  glc.addEventListener('pointerdown', (e) => {
    if (!active || e.pointerType !== 'mouse' || e.button !== 0) return;
    mouse.on = true; mouse.axis = mouseAxis(e);
    try { glc.setPointerCapture(e.pointerId); } catch {}
    e.preventDefault();
  });
  addEventListener('pointermove', (e) => { if (mouse.on) mouse.axis = mouseAxis(e); });
  addEventListener('pointerup', (e) => { if (e.button === 0) mouse.on = false; });
  glc.addEventListener('contextmenu', (e) => { if (active) e.preventDefault(); });

  /* ---------- car + state ---------- */
  let car = null, P = null;
  const st = { x: 0, z: 0, yaw: 0, vx: 0, vz: 0, yawRate: 0, steer: 0, pitch: 0, roll: 0, idx: 0 };
  let camMode = 0, throttle = 0;
  const lap = { start: null, last: null, best: null, checkpoint: false, prevRel: 0, prevIdx: -1, dir: 0 };
  const bestKey = () => W.bestKey(car.key);

  function resetToRoad() {
    const { C, T, nearest } = W.path;
    const n = nearest(st.x, st.z);
    const p = C[n.i], t = T[n.i];
    // keep facing roughly the way you were going (lets you turn around on an open road)
    const fwd = Math.sin(st.yaw) * t.x + Math.cos(st.yaw) * t.z;
    const s = W.path.closed || fwd >= 0 ? 1 : -1;
    const pose = W.resetPose ? W.resetPose(n.i, s) : { x: p.x, z: p.z, yaw: Math.atan2(t.x * s, t.z * s) };
    Object.assign(st, pose, { vx: 0, vz: 0, yawRate: 0, steer: 0, idx: n.i });
    lap.start = null; lap.checkpoint = false; lap.dir = 0; lap.prevIdx = n.i;
  }

  function collide() {
    // two circles along the car vs solid boxes and round obstacles
    const fx = Math.sin(st.yaw), fz = Math.cos(st.yaw);
    const r = 1.0, offs = [car.length * 0.3, -car.length * 0.3];
    let hit = 0;
    for (const o of offs) {
      let cx = st.x + fx * o, cz = st.z + fz * o;
      for (const b of W.boxes) {
        const dx = cx - b.cx, dz = cz - b.cz;
        if (Math.abs(dx) > b.hx + b.hz + 2 || Math.abs(dz) > b.hx + b.hz + 2) continue; // too far to touch
        const lx = dx * b.c - dz * b.s, lz = dx * b.s + dz * b.c;
        const qx = clamp(lx, -b.hx, b.hx), qz = clamp(lz, -b.hz, b.hz);
        const ex = lx - qx, ez = lz - qz;
        const d = Math.hypot(ex, ez);
        if (d < r) {
          let nx, nz, push;
          if (d > 1e-4) { nx = ex / d; nz = ez / d; push = r - d; }
          else {
            const px = b.hx - Math.abs(lx), pz = b.hz - Math.abs(lz);
            if (px < pz) { nx = Math.sign(lx) || 1; nz = 0; push = px + r; } else { nx = 0; nz = Math.sign(lz) || 1; push = pz + r; }
          }
          const wx = nx * b.c + nz * b.s, wz = -nx * b.s + nz * b.c;
          st.x += wx * push; st.z += wz * push; cx += wx * push; cz += wz * push;
          const vn = st.vx * wx + st.vz * wz;
          if (vn < 0) { st.vx -= wx * vn * 1.35; st.vz -= wz * vn * 1.35; hit = Math.max(hit, -vn); }
        }
      }
      for (const [px, pz, pr] of W.grid.near(cx, cz)) {
        const dx = cx - px, dz = cz - pz, d = Math.hypot(dx, dz), rr = r + pr;
        if (d < rr && d > 1e-4) {
          const nx = dx / d, nz = dz / d, push = rr - d;
          st.x += nx * push; st.z += nz * push; cx += nx * push; cz += nz * push;
          const vn = st.vx * nx + st.vz * nz;
          if (vn < 0) { st.vx -= nx * vn * 1.5; st.vz -= nz * vn * 1.5; hit = Math.max(hit, -vn); }
        }
      }
    }
    if (hit > 3) { st.vx *= 0.7; st.vz *= 0.7; }
    st.hit = Math.max(st.hit || 0, hit);
  }

  const hud = { speed: $('#hud-speed'), gear: $('#hud-gear'), cur: $('#hud-cur'), last: $('#hud-last'), best: $('#hud-best'), msg: $('#hud-msg'), bar: $('#hud-rpm'), curLabel: $('#hud-cur-label') };
  const fmt = (t) => (t == null ? '–:––.–' : `${Math.floor(t / 60)}:${(t % 60).toFixed(1).padStart(4, '0')}`);
  let msgTimer = 0;
  const flash = (text, secs = 2.5) => { hud.msg.textContent = text; hud.msg.classList.add('on'); msgTimer = secs; };

  function finish(t, label) {
    lap.last = t;
    if (lap.best == null || t < lap.best) {
      lap.best = t;
      try { localStorage.setItem(bestKey(), String(t)); } catch {}
      flash(`New best ${label}  ${fmt(t)}`, 3.5);
    } else flash(`${label[0].toUpperCase() + label.slice(1)}  ${fmt(t)}`, 3);
  }

  function timing(n) {
    const now = performance.now() / 1000;
    const tm = W.timing, N = W.path.N;
    if (tm.type === 'circuit') {
      const rel = (n.i - tm.lineIdx + N) % N;
      if (rel > N * 0.4 && rel < N * 0.6 && n.d < 40) lap.checkpoint = true;
      if (lap.prevRel > N * 0.85 && rel < N * 0.15 && n.d < 30) {
        if (lap.start != null && lap.checkpoint) finish(now - lap.start, 'lap');
        else if (lap.start == null) flash('Lap started');
        lap.start = now;
        lap.checkpoint = false;
      }
      lap.prevRel = rel;
    } else {
      // point-to-point run, either direction
      const a = tm.a, b = tm.b, p = lap.prevIdx, i = n.i;
      if (p >= 0 && n.d < 40) {
        const crossed = (k) => (p < k && i >= k) ? 1 : (p > k && i <= k) ? -1 : 0;
        const ca = crossed(a), cb = crossed(b);
        if (lap.start != null) {
          if ((lap.dir > 0 && cb > 0) || (lap.dir < 0 && ca < 0)) { finish(now - lap.start, 'run'); lap.start = null; lap.dir = 0; }
          else if ((lap.dir > 0 && ca < 0) || (lap.dir < 0 && cb > 0)) { lap.start = null; lap.dir = 0; flash('Run cancelled'); }
        } else if (ca > 0) { lap.start = now; lap.dir = 1; flash(`Run started · to ${tm.names[1]}`); }
        else if (cb < 0) { lap.start = now; lap.dir = -1; flash(`Run started · to ${tm.names[0]}`); }
      }
      lap.prevIdx = i;
    }
  }

  function step(dt) {
    const fx = Math.sin(st.yaw), fz = Math.cos(st.yaw);
    const lx = fz, lz = -fx; // left
    let vF = st.vx * fx + st.vz * fz;
    let vL = st.vx * lx + st.vz * lz;

    const n = W.path.nearest(st.x, st.z, st.idx);
    st.idx = n.i;
    const { off, kerb } = W.surface(st, n);

    // keys win if pressed; otherwise the mouse (when held) steers proportionally
    const keySteer = input.left - input.right;
    const steerIn = keySteer !== 0 || !mouse.on ? keySteer : -mouse.axis;
    const speed = Math.abs(vF);
    const steerMax = P.steer / (1 + speed / 24);
    st.steer = damp(st.steer, steerIn * steerMax, 10, dt);

    const top = P.maxSpeed * (off ? 0.55 : 1);
    if (input.gas) {
      if (vF > -0.5) vF += P.accel * Math.max(0, 1 - (vF / top) ** 2) * dt * (off ? 0.6 : 1);
      else vF += P.brake * dt;
    }
    if (input.brake) {
      if (vF > 0.5) vF -= P.brake * dt;
      else vF = Math.max(vF - 5 * dt, -9);
    }
    vF -= vF * (0.012 + (off ? 0.55 : 0) + (kerb ? 0.05 : 0)) * dt + Math.sign(vF) * 0.25 * dt * (input.gas ? 0 : 1);
    if (!input.gas && !input.brake && Math.abs(vF) < 0.3) vF = 0;

    const grip = P.grip * (off ? 0.35 : 1) * (input.hand ? 0.12 : 1);
    vL *= Math.exp(-grip * dt);

    const targetYaw = (vF * Math.tan(st.steer)) / car.wheelbase * (input.hand ? 1.35 : 1);
    st.yawRate = damp(st.yawRate, targetYaw, input.hand ? 3 : 9, dt);
    if (input.hand) vF -= Math.sign(vF) * 3 * dt;

    st.vx = fx * vF + lx * vL;
    st.vz = fz * vF + lz * vL;
    st.yaw += st.yawRate * dt;
    st.x += st.vx * dt;
    st.z += st.vz * dt;
    collide();

    const accel = (vF - (st._lastVF ?? vF)) / Math.max(dt, 1e-3);
    st._lastVF = vF;
    st.pitch = damp(st.pitch, clamp(-accel * 0.0045, -0.04, 0.04), 6, dt);
    st.roll = damp(st.roll, clamp(-vF * st.yawRate * 0.004, -0.06, 0.06), 6, dt);

    const slide = Math.abs(vL);
    if ((off && speed > 4) || slide > 3.5) {
      const col = off ? W.dust : smokeCol;
      for (const s of [-1, 1]) if (rnd() < (off ? clamp(speed / 60, 0.08, 0.25) : clamp(slide / 14, 0, 0.6))) {
        emit(st.x - fx * car.wheelbase * 0.55 + lx * s * 0.8, st.z - fz * car.wheelbase * 0.55 + lz * s * 0.8, col, -st.vx * 0.15, -st.vz * 0.15);
      }
    }

    timing(n);
    if (n.d > W.farLimit) flash(`Head back to the ${W.timing.type === 'circuit' ? 'track' : 'road'}  ·  R to reset`, 0.2);

    car.root.position.set(st.x, 0, st.z);
    car.root.rotation.y = st.yaw;
    car.body.rotation.set(st.pitch, 0, st.roll);
    car.setWheels(st.steer, vF * dt);
    car.setBrake(input.brake && vF > 0.5);

    const mph = Math.round(Math.abs(vF) * 2.237);
    hud.speed.textContent = String(mph).padStart(3, '0');
    const band = P.maxSpeed * 2.237 / 6.2;
    const gear = vF < -0.5 ? 'R' : mph < 2 ? 'N' : String(Math.min(6, 1 + Math.floor(mph / band)));
    // for the engine sound
    const gN = gear === 'N' ? 0 : gear === 'R' ? 1 : +gear;
    Object.assign(st, { gearN: gN, r01: gN ? clamp((Math.abs(vF) * 2.237 - (gN - 1) * band) / band, 0, 1) : 0, slide, off, speed });
    hud.gear.textContent = gear;
    hud.bar.style.transform = `scaleX(${gear === 'N' || gear === 'R' ? 0.08 : clamp(0.25 + ((mph % band) / band) * 0.75, 0, 1)})`;
    const idle = W.timing.type === 'circuit' ? 'Cross the line' : 'Cross a start line';
    hud.cur.textContent = lap.start == null ? idle : fmt(performance.now() / 1000 - lap.start);
    hud.last.textContent = fmt(lap.last);
    hud.best.textContent = fmt(lap.best);
    if (msgTimer > 0) { msgTimer -= dt; if (msgTimer <= 0) hud.msg.classList.remove('on'); }
    return vF;
  }

  /* ---------- camera ---------- */
  const camPos = new THREE.Vector3(), camLook = new THREE.Vector3();
  function updateCamera(dt, vF, snap) {
    const fx = Math.sin(st.yaw), fz = Math.cos(st.yaw);
    const sp = Math.hypot(st.vx, st.vz);
    let dx = fx, dz = fz;
    if (sp > 3 && vF > 0) { dx = fx * 0.7 + (st.vx / sp) * 0.3; dz = fz * 0.7 + (st.vz / sp) * 0.3; const l = Math.hypot(dx, dz); dx /= l; dz /= l; }
    const cfg = [[6.4, 2.25, 3.5], [11, 3.8, 4], [-0.25, 1.12, 20]][camMode];
    let want = new THREE.Vector3(st.x - dx * cfg[0], cfg[1], st.z - dz * cfg[0]);
    let look = new THREE.Vector3(st.x + fx * cfg[2], camMode === 2 ? 1.0 : 0.9, st.z + fz * cfg[2]);
    const intro = camMode !== 2 && W.introCam ? W.introCam(st) : null;
    if (intro) { want = intro.pos; look = intro.look; }
    if (snap || camMode === 2) { camPos.copy(want); camLook.copy(look); }
    else { camPos.lerp(want, 1 - Math.exp(-7 * dt)); camLook.lerp(look, 1 - Math.exp(-12 * dt)); }
    camera.position.copy(camPos);
    camera.lookAt(camLook);
    if (W.sky) W.sky.position.set(camPos.x, 0, camPos.z); // keep the sky dome centred on us (long roads)
    const fov = 56 + clamp(Math.abs(vF) * 0.22, 0, 16) + (camera.aspect < 1 ? 14 : 0);
    camera.fov = snap ? fov : damp(camera.fov, fov, 4, dt);
    camera.updateProjectionMatrix();
    W.sun.position.set(st.x + W.sunDir.x * 120, W.sunDir.y * 120 + 30, st.z + W.sunDir.z * 120);
    W.sun.target.position.set(st.x, 0, st.z);
  }

  return {
    camera, input,
    get scene() { return W ? W.scene : null; },
    get active() { return active; },
    enter(carKey, worldKey = 'willow') {
      if (!worlds[worldKey]) worlds[worldKey] = LOCATIONS[worldKey].build(renderer, { isTouch });
      if (car && car.root.parent) car.root.parent.remove(car.root);
      W = worlds[worldKey];
      car = buildCar(carKey);
      P = CAR_SPECS[carKey].phys;
      W.scene.add(car.root);
      W.scene.add(pts);
      pLife.fill(0); pPos.fill(-100);
      Object.assign(st, W.startPose(), { vx: 0, vz: 0, yawRate: 0, steer: 0, pitch: 0, roll: 0, _lastVF: 0 });
      st.idx = W.path.nearest(st.x, st.z).i;
      Object.assign(lap, { start: null, last: null, checkpoint: false, prevRel: 0, prevIdx: st.idx, dir: 0 });
      try { const b = parseFloat(localStorage.getItem(bestKey())); lap.best = Number.isFinite(b) ? b : null; } catch { lap.best = null; }
      if (hud.curLabel) hud.curLabel.textContent = W.timing.type === 'circuit' ? 'Lap' : 'Run';
      camMode = 0;
      sizeMinimap();
      car.root.position.set(st.x, 0, st.z);
      car.root.rotation.y = st.yaw;
      updateCamera(0.016, 0, true);
      active = true;
      throttle = 0;
      sound.start(carKey, W.ambience || 'wind');
      flash(`${CAR_SPECS[carKey].name}  ·  ${W.intro}`, 4);
    },
    exit() { active = false; for (const k in input) input[k] = 0; mouse.on = false; sound.stop(); },
    sound,
    toggleSound() { sound.toggle(); showSound(); return sound.enabled; },
    reset: resetToRoad,
    cycleCamera() { camMode = (camMode + 1) % 3; },
    update(dt) {
      if (!active || !car) return;
      const h = Math.min(dt, 1 / 30);
      let vF = 0;
      for (let i = 0; i < 2; i++) vF = step(h / 2);
      updateParticles(h);
      throttle = damp(throttle, input.gas ? 1 : 0, input.gas ? 10 : 6, h);
      sound.update({ speed: st.speed, rpm01: st.r01, gear: st.gearN, throttle, slide: st.slide, off: st.off, hit: st.hit || 0, amb: W.ambLevel ? W.ambLevel(st) : 1, dt: h });
      st.hit = 0;
      if (W.update) W.update(h, camera);
      updateCamera(h, vF);
      drawMinimap();
      if (ind) {
        ind.classList.toggle('on', mouse.on);
        if (mouse.on) indDot.style.transform = `translateX(${mouse.axis * 120}px)`;
      }
    },
    resize() { camera.aspect = innerWidth / innerHeight; camera.updateProjectionMatrix(); if (active) sizeMinimap(); },
    get info() { return W ? W.info : null; },
    _dbg: { st, lap, get W() { return W; } },
  };
}
