import * as THREE from 'three';

/* =========================================================
   CONTENT — edit your projects here
   ========================================================= */
const PROJECTS = [
  {
    title: 'Track Days',
    cat: 'Performance',
    role: 'Analytical',
    img: 'assets/img/track.jpg',
    gallery: ['assets/img/track-2.jpg'],
    body: [
      'Every lap is a chance to get a little better.',
      'On track, improvement comes from a simple loop: review the data, find where time is being lost, make one deliberate change and measure the result. I take that same disciplined, data-driven approach into my professional work.',
      'Track driving has also taught me to stay calm and make clear decisions when things move fast, to take feedback without ego, and to respect the process that keeps everyone safe. I am always looking for the next tenth, in the car and on the job.',
    ],
  },
  {
    title: 'In the Details',
    cat: 'Approach',
    role: 'Detail-oriented',
    img: 'assets/img/m240i-badge.jpg',
    gallery: ['assets/img/m240i-front.jpg', 'assets/img/m240i-rear.jpg'],
    body: [
      'The difference is almost always in the details.',
      'I notice the small things: the setting that is almost right, the step that gets skipped when no one is checking, the finish that looks fine from a distance but not up close. Whether I am setting up a car for the track, planning a build or working with a team, I make a point of getting those things right.',
      'For me, attention to detail is not perfectionism for its own sake. It means catching problems early, following through on the last ten percent, and delivering work that holds up to a closer look.',
    ],
  },
  {
    title: 'Race Day',
    cat: 'Work Ethic',
    role: 'Committed',
    img: 'assets/img/running.jpg',
    focus: [0.5, 0.1], // crop focus (x, y from top-left, 0–1) — keeps the head in frame
    gallery: [],
    body: [
      'Race day is won in the weeks nobody sees.',
      'Running taught me that results come from consistency: showing up for the early mornings, putting in the work when it is not convenient, and trusting the preparation when it matters. I bring that same approach to my professional work.',
      'I set clear goals, put in steady effort to reach them, and stay composed under pressure. When a project hits its hardest stretch, I keep my pace, support the people around me and finish what I start.',
    ],
  },
  {
    title: 'The Rig',
    cat: 'Problem Solving',
    role: 'Hands-on',
    img: 'assets/img/pc-build.jpg',
    gallery: ['assets/img/pc-build-2.jpg'],
    ratio: '4 / 3', // show photos at full 4:3 so nothing is cropped top/bottom
    body: [
      'Research first, then build it right.',
      'Building this computer from individual parts meant defining what it needed to do, researching every component, checking compatibility and staying within a budget before a single screw went in. I approach professional projects the same way: understand the requirements, plan carefully, then execute.',
      'When something does not work the first time, I troubleshoot methodically, one variable at a time, until I find the cause. I enjoy learning new technical skills on my own, and I take pride in work that is clean, organized and built to last.',
    ],
  },
];

/* =========================================================
   Helpers
   ========================================================= */
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const lerp = (a, b, t) => a + (b - a) * t;
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const smooth = (a, b, v) => { const t = clamp((v - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };
const isTouch = matchMedia('(hover: none), (pointer: coarse)').matches;
const pad2 = (n) => String(n).padStart(2, '0');

/* =========================================================
   Renderer / scene
   ========================================================= */
THREE.ColorManagement.enabled = false;
const canvas = $('#gl');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
renderer.outputColorSpace = THREE.LinearSRGBColorSpace;
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.setClearColor(0x0b0a09, 1);

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(35, innerWidth / innerHeight, 0.1, 100);
camera.position.set(0, 0, 10);

const view = { w: 0, h: 0, planeW: 0, planeH: 0, spacing: 0, mobile: false };

/* =========================================================
   Shaders
   ========================================================= */
const NOISE = /* glsl */`
vec3 mod289(vec3 x){return x-floor(x*(1.0/289.0))*289.0;}
vec4 mod289(vec4 x){return x-floor(x*(1.0/289.0))*289.0;}
vec4 permute(vec4 x){return mod289(((x*34.0)+1.0)*x);}
vec4 taylorInvSqrt(vec4 r){return 1.79284291400159-0.85373472095314*r;}
float snoise(vec3 v){
  const vec2 C=vec2(1.0/6.0,1.0/3.0);
  const vec4 D=vec4(0.0,0.5,1.0,2.0);
  vec3 i=floor(v+dot(v,C.yyy));
  vec3 x0=v-i+dot(i,C.xxx);
  vec3 g=step(x0.yzx,x0.xyz);
  vec3 l=1.0-g;
  vec3 i1=min(g.xyz,l.zxy);
  vec3 i2=max(g.xyz,l.zxy);
  vec3 x1=x0-i1+C.xxx;
  vec3 x2=x0-i2+C.yyy;
  vec3 x3=x0-D.yyy;
  i=mod289(i);
  vec4 p=permute(permute(permute(i.z+vec4(0.0,i1.z,i2.z,1.0))+i.y+vec4(0.0,i1.y,i2.y,1.0))+i.x+vec4(0.0,i1.x,i2.x,1.0));
  float n_=0.142857142857;
  vec3 ns=n_*D.wyz-D.xzx;
  vec4 j=p-49.0*floor(p*ns.z*ns.z);
  vec4 x_=floor(j*ns.z);
  vec4 y_=floor(j-7.0*x_);
  vec4 x=x_*ns.x+ns.yyyy;
  vec4 y=y_*ns.x+ns.yyyy;
  vec4 h=1.0-abs(x)-abs(y);
  vec4 b0=vec4(x.xy,y.xy);
  vec4 b1=vec4(x.zw,y.zw);
  vec4 s0=floor(b0)*2.0+1.0;
  vec4 s1=floor(b1)*2.0+1.0;
  vec4 sh=-step(h,vec4(0.0));
  vec4 a0=b0.xzyw+s0.xzyw*sh.xxyy;
  vec4 a1=b1.xzyw+s1.xzyw*sh.zzww;
  vec3 p0=vec3(a0.xy,h.x);
  vec3 p1=vec3(a0.zw,h.y);
  vec3 p2=vec3(a1.xy,h.z);
  vec3 p3=vec3(a1.zw,h.w);
  vec4 norm=taylorInvSqrt(vec4(dot(p0,p0),dot(p1,p1),dot(p2,p2),dot(p3,p3)));
  p0*=norm.x;p1*=norm.y;p2*=norm.z;p3*=norm.w;
  vec4 m=max(0.6-vec4(dot(x0,x0),dot(x1,x1),dot(x2,x2),dot(x3,x3)),0.0);
  m=m*m;
  return 42.0*dot(m*m,vec4(dot(p0,x0),dot(p1,x1),dot(p2,x2),dot(p3,x3)));
}`;

/* ---------- Gold particle car (F8x M4-based GT3-style race car) ----------
   The car is sampled procedurally: the M4 coupe's long hood, notchback roof and
   kinked rear side window, widened with boxy race fender flares and dropped low,
   plus GT3-style aero: big splitter + canards, hood louvers, fender exit vents,
   swan-neck rear wing, deep diffuser, centre-lock wheels and side-exit exhausts.
   Proportions follow the M4 coupe (≈4.67m long, 2.81m wheelbase), lowered and
   widened as a race car. No badges, grille or livery are drawn.
   Units: length ≈ 4.65, front of the car points to +x, ground at y = -0.75. */
const CAR = (() => {
  const L = 2.33, HW = 0.92, CORNER = 0.34, BOT = -0.64, GROUND = -0.75;
  const WR = 0.36, WY = GROUND + WR, WHEELS_X = [1.47, -1.33];
  const FLARE = 0.15, FLARE_R = 0.76, TRACK = 0.13; // boxy race flares, much wider track
  // roofline / hood / deck profile (rear → front), lowered race stance
  const PROFILE = [
    [-2.35, -0.36], [-2.33, 0.02], [-2.29, 0.13], [-2.22, 0.18], [-2.0, 0.17], [-1.7, 0.18],
    [-1.45, 0.3], [-1.15, 0.46], [-0.85, 0.56], [-0.4, 0.6], [0.05, 0.6], [0.32, 0.56],
    [0.56, 0.44], [0.82, 0.28], [1.05, 0.17], [1.45, 0.12], [1.85, 0.08], [2.12, 0.01], [2.27, -0.1], [2.35, -0.32],
  ];
  const belt = (x) => 0.1 + (1.0 - x) * 0.025;
  const topY = (x) => {
    if (x <= PROFILE[0][0]) return PROFILE[0][1];
    for (let i = 1; i < PROFILE.length; i++) {
      const [x1, y1] = PROFILE[i];
      if (x <= x1) {
        const [x0, y0] = PROFILE[i - 1];
        const t = (x - x0) / (x1 - x0);
        const s = t * t * (3 - 2 * t);
        return y0 + (y1 - y0) * (0.5 * t + 0.5 * s);
      }
    }
    return PROFILE[PROFILE.length - 1][1];
  };
  const botY = (x) => BOT + Math.max(0, Math.abs(x) - 2.1) * 0.4;
  // plan-view half width with tumblehome and wide, flat-topped (boxy) race flares
  const halfW = (x, y) => {
    const dx = Math.max(0, Math.abs(x) - (L - CORNER));
    let w = HW - CORNER + Math.sqrt(Math.max(0, CORNER * CORNER - dx * dx));
    const b = belt(x);
    if (y > b) w *= 1 - 0.32 * Math.min(1, (y - b) / 0.46);
    if (y < -0.5) w *= 0.97;
    if (y < 0.08) WHEELS_X.forEach((wx) => { const d = Math.hypot(x - wx, (y - WY) * 1.1); if (d < FLARE_R) w += FLARE * (1 - Math.pow(d / FLARE_R, 5)); });
    return w;
  };
  // side window graphic: A-pillar in front, kinked C-pillar at the back
  const aPillarX = (y) => 1.0 - ((y - 0.1) / 0.46) * 0.6;
  const cPillarX = (y, x) => { const b = belt(x), u = Math.max(0, (y - b) / (topY(x) - b)); return -1.3 + 0.44 * Math.pow(u, 1.6); };
  const isSideGlass = (x, y) => y > belt(x) + 0.02 && y < topY(x) - 0.05 && x < aPillarX(y) - 0.03 && x > cPillarX(y, x) + 0.03;
  const nearArch = (x, y) => WHEELS_X.some((wx) => Math.hypot(x - wx, y - WY) < WR + 0.07);
  const R = Math.random, sgn = () => (R() < 0.5 ? -1 : 1), rr = (a, b) => a + (b - a) * R();

  const parts = [
    // side panels + side glass
    [0.3, () => {
      for (;;) {
        const x = rr(-L, L), b = botY(x), t = topY(x), y = rr(b, t);
        if (R() > (t - b) / 1.3) continue;
        if (nearArch(x, y)) continue;
        return [x, y, sgn() * halfW(x, y), isSideGlass(x, y) ? 0.07 : 0.32];
      }
    }],
    // roof, hood (with two louvered vent panels), trunk lid, glass dimmer
    [0.25, () => {
      const x = rr(-L, L), y0 = topY(x), w = halfW(x, y0), z = rr(-w, w), az = Math.abs(z);
      const glass = ((x > -1.6 && x < -0.9) || (x > 0.36 && x < 1.0)) && az < w * 0.86;
      const louver = x > 1.25 && x < 1.85 && az > 0.18 && az < 0.5;
      const g = glass ? 0.08 : louver ? (Math.floor((x - 1.25) * 30) % 2 === 0 ? 0.7 : 0.12) : 0.4;
      return [x, y0 - 0.07 * Math.pow(az / w, 4), z, g];
    }],
    // front fascia with large intakes (dimmer), rear bumper
    [0.07, () => {
      const s = sgn(), x = s * (L - R() * 0.03), y = rr(botY(x), topY(x)), w = halfW(x, y), z = rr(-w, w), az = Math.abs(z);
      const intake = s > 0 ? ((y < -0.06 && y > -0.48 && az > 0.46 && az < 0.86) || (y < -0.28 && y > -0.56 && az < 0.42)) : (y < -0.3 && az < 0.75);
      return [x, y, z, intake ? 0.08 : 0.3];
    }],
    // centre-lock race wheels: tread, sidewall, 10 slim spokes, rim lip, centre nut
    [0.15, () => {
      const wx = WHEELS_X[R() < 0.5 ? 0 : 1], s = sgn(), a = R() * Math.PI * 2, k = R(), face = 0.86 + TRACK;
      let r, z, g;
      if (k < 0.33) { r = WR; z = s * rr(face - 0.3, face); g = 0.18; }
      else if (k < 0.55) { r = rr(0.28, WR); z = s * face; g = 0.12; }
      else if (k < 0.85) {
        const spoke = Math.floor(R() * 10);
        const ang = (spoke / 10) * Math.PI * 2 + rr(-0.05, 0.05);
        r = rr(0.07, 0.28); z = s * (face + 0.01); g = 0.75;
        return [wx + Math.cos(ang) * r, WY + Math.sin(ang) * r, z, g];
      } else if (k < 0.95) { r = 0.285; z = s * (face + 0.01); g = 0.85; }
      else { r = rr(0, 0.05); z = s * (face + 0.02); g = 1.0; }
      return [wx + Math.cos(a) * r, WY + Math.sin(a) * r, z, g];
    }],
    // boxy flare edges: arch lip + flat outer face of each flare
    [0.06, () => {
      const wx = WHEELS_X[R() < 0.5 ? 0 : 1], s = sgn();
      if (R() < 0.5) {
        const a = rr(-0.05, Math.PI + 0.05), r = WR + 0.06, x = wx + Math.cos(a) * r, y = WY + Math.sin(a) * r;
        return [x, y, s * (halfW(x, y) + 0.004), 0.85];
      }
      const x = wx + rr(-0.66, 0.66), y = rr(WY + WR + 0.06, 0.06);
      return [x, y, s * halfW(x, y), 0.45];
    }],
    // swan-neck rear wing: blade + gurney, end plates, mounts hooking over the top
    [0.07, () => {
      const k = R(), s = sgn();
      const bladeY = (x) => 0.66 + (x + 2.15) * -0.16; // angle of attack, trailing edge up
      if (k < 0.5) { const x = rr(-2.4, -1.94); return [x, bladeY(x) + rr(-0.012, 0.012), rr(-1.0, 1.0), 0.6]; }
      if (k < 0.6) return [-2.4, bladeY(-2.4) + rr(0, 0.05), rr(-1.0, 1.0), 0.9];
      if (k < 0.8) { const x = rr(-2.45, -1.88); return [x, rr(bladeY(x) - 0.14, bladeY(x) + 0.06), s * 1.01, 0.5]; }
      const t = R(), x0 = -1.8, x = x0 - t * 0.4;
      const y = topY(x0) + (0.74 - topY(x0)) * Math.sin(t * Math.PI * 0.62) / Math.sin(Math.PI * 0.62);
      return [x, Math.max(y, bladeY(x)), s * rr(0.32, 0.35), 0.7];
    }],
    // big front splitter, stacked canards, side skirts, deep rear diffuser with fins
    [0.05, () => {
      const k = R(), s = sgn();
      if (k < 0.3) return [rr(2.05, 2.55), BOT - 0.03, rr(-1.0, 1.0), 0.5];
      if (k < 0.45) { const tier = R() < 0.5 ? -0.34 : -0.18, x = rr(2.12, 2.32); return [x, tier + (x - 2.12) * 0.25, s * rr(0.78, 1.02), 0.7]; }
      if (k < 0.68) { const x = rr(-0.8, 0.95); return [x, rr(-0.62, -0.54), s * (halfW(x, -0.54) + 0.03), 0.5]; }
      if (k < 0.8) return [rr(-2.45, -2.12), -0.64, rr(-0.8, 0.8), 0.35];
      const fz = [-0.6, -0.3, 0, 0.3, 0.6][Math.floor(R() * 5)];
      return [rr(-2.45, -2.12), rr(-0.68, -0.42), fz, 0.6];
    }],
    // side-exit exhaust: two tips on the left sill, just ahead of the rear wheel
    [0.018, () => {
      const a = R() * Math.PI * 2, cx = R() < 0.5 ? -0.68 : -0.8, cy = -0.53, k = R();
      const zf = -(halfW(cx, cy) + 0.03);
      if (k < 0.6) return [cx + Math.cos(a) * 0.045, cy + Math.sin(a) * 0.045, zf, 1.0];
      if (k < 0.88) return [cx + Math.cos(a) * 0.04, cy + Math.sin(a) * 0.04, zf + rr(0, 0.12), 0.5];
      const r = rr(0, 0.03); return [cx + Math.cos(a) * r, cy + Math.sin(a) * r, zf + 0.01, 0.15];
    }],
    // fender exit vents behind the front wheels (top + side)
    [0.025, () => {
      const s = sgn(), slat = Math.floor(R() * 6);
      if (R() < 0.5) { const x = 0.98 + slat * 0.05, z = s * rr(0.62, 0.92); return [x, topY(x) + 0.01, z, 0.75]; }
      const t = R(), x = 0.82 + t * 0.12, y = rr(-0.16, 0.04) + t * 0.05;
      return [x, y, s * (halfW(x, y) + 0.005), 0.85];
    }],
    // headlights (twin ring signatures), L-shaped wraparound taillights
    [0.045, () => {
      const k = R(), s = sgn();
      if (k < 0.3) return [rr(2.06, 2.24), rr(-0.03, 0.05), s * rr(0.44, 0.8), 0.9];
      if (k < 0.55) { const a = R() * Math.PI * 2, cz = R() < 0.5 ? 0.52 : 0.69; return [2.23, 0.01 + Math.sin(a) * 0.045, s * (cz + Math.cos(a) * 0.045), 1.0]; }
      if (k < 0.8) return [-2.33, rr(0.02, 0.12), s * rr(0.44, 0.84), 1.0];
      const x = rr(-2.33, -2.04), y = rr(0.03, 0.12);
      return [x, y, s * halfW(x, y), 1.0];
    }],
    // side mirrors
    [0.012, () => {
      const u = R() * Math.PI * 2, v = Math.acos(rr(-1, 1));
      const x = 0.86 + Math.sin(v) * Math.cos(u) * 0.08, y = 0.22 + Math.cos(v) * 0.045;
      return [x, y, sgn() * (halfW(0.86, 0.16) + 0.1 + Math.sin(v) * Math.sin(u) * 0.09), 0.45];
    }],
    // feature lines: window outline, shoulder line, door shuts, hood creases, trunk lip
    [0.1, () => {
      const k = R(), s = sgn();
      if (k < 0.12) { const x = rr(-1.3, 1.0); const y = belt(x); return [x, y, s * halfW(x, y), 0.85]; }
      if (k < 0.27) { const x = rr(-0.9, 0.36); const y = topY(x) - 0.05; return [x, y, s * halfW(x, y), 0.8]; }
      if (k < 0.37) { const y = rr(0.1, 0.56); const x = aPillarX(y); return [x, y, s * halfW(x, y), 0.8]; }
      if (k < 0.5) { const u = R(), x0 = -1.3 + 0.44 * Math.pow(u, 1.6); const b = belt(x0), y = b + u * (topY(x0) - b - 0.05); return [x0, y, s * halfW(x0, y), 0.85]; }
      if (k < 0.72) { const x = rr(-2.2, 2.2), y = 0.12 - x * 0.01; if (Math.abs(x - WHEELS_X[0]) < 0.7 || Math.abs(x - WHEELS_X[1]) < 0.7) return [x, y, s * halfW(x, y), 0.7]; return [x, y, s * halfW(x, y) * 1.01, 0.7]; }
      if (k < 0.8) { const x = R() < 0.5 ? 0.98 : -0.72, y = rr(-0.52, belt(x)); return [x, y, s * halfW(x, y), 0.6]; }
      if (k < 0.92) { const x = rr(1.1, 2.08); return [x, topY(x) + 0.005, s * 0.55, 0.6]; }
      const z = rr(-0.76, 0.76); return [-2.22, 0.19, z, 0.75];
    }],
  ];
  const cum = [];
  parts.reduce((acc, [w]) => (cum.push(acc + w), acc + w), 0);
  const total = cum[cum.length - 1];
  return () => {
    const r = R() * total;
    const i = cum.findIndex((c) => r <= c);
    return parts[i][1]();
  };
})();

const COUNT = isTouch ? 8000 : 16000;
const pPos = new Float32Array(COUNT * 3);
const pDir = new Float32Array(COUNT * 3);
const pRand = new Float32Array(COUNT);
const pGlow = new Float32Array(COUNT);
for (let i = 0; i < COUNT; i++) {
  const [x, y, z, g] = CAR();
  pPos.set([x, y + 0.08, z], i * 3);
  pGlow[i] = g;
  pDir.set([(Math.random() - 0.5) * 30, (Math.random() - 0.5) * 18, -14 + Math.random() * 16], i * 3);
  pRand[i] = Math.random();
}
const pGeo = new THREE.BufferGeometry();
pGeo.setAttribute('position', new THREE.BufferAttribute(pPos, 3));
pGeo.setAttribute('aDir', new THREE.BufferAttribute(pDir, 3));
pGeo.setAttribute('aRand', new THREE.BufferAttribute(pRand, 1));
pGeo.setAttribute('aGlow', new THREE.BufferAttribute(pGlow, 1));

const pMat = new THREE.ShaderMaterial({
  transparent: true,
  depthWrite: false,
  blending: THREE.AdditiveBlending,
  uniforms: {
    uTime: { value: 0 },
    uIntro: { value: 0 },
    uDisperse: { value: 0 },
    uMouse: { value: new THREE.Vector2(99, 99) },
    uMouseK: { value: 0 }, // 0..1 strength of the pointer push, eased so particles glide back
    uPR: { value: renderer.getPixelRatio() },
    uColA: { value: new THREE.Vector3(0.89, 0.55, 0.04) },
    uColB: { value: new THREE.Vector3(1.0, 0.93, 0.62) },
  },
  vertexShader: /* glsl */`
    uniform float uTime, uIntro, uDisperse, uPR, uMouseK;
    uniform vec2 uMouse;
    attribute vec3 aDir;
    attribute float aRand;
    attribute float aGlow;
    varying float vMix;
    varying float vAlpha;
    ${NOISE}
    void main(){
      vec3 p = position;
      float n = snoise(p * 1.2 + vec3(uTime * 0.5, uTime * 0.15, 0.0));
      p += vec3(0.0, n * 0.012, 0.0);
      // a shimmer sweep that travels along the body, nose to tail
      float sweep = smoothstep(0.35, 0.0, abs(p.x - (mod(uTime * 1.6, 9.0) - 4.5)));

      // drift for the dispersed "dust" state
      vec3 dust = aDir + vec3(sin(uTime * 0.2 + aRand * 6.28), cos(uTime * 0.15 + aRand * 12.0), 0.0) * 0.35;

      float t = clamp(uIntro * 1.6 - aRand * 0.6, 0.0, 1.0);
      t = 1.0 - pow(1.0 - t, 3.0);
      float d = clamp(uDisperse * 1.4 - aRand * 0.4, 0.0, 1.0);
      float k = t * (1.0 - d);
      vec4 wp = modelMatrix * vec4(mix(dust, p, k), 1.0);

      // mouse repulsion
      vec2 dm = wp.xy - uMouse;
      float f = smoothstep(1.6, 0.0, length(dm)) * k * uMouseK;
      wp.xy += normalize(dm + 1e-4) * f * 0.7;

      vec4 mv = viewMatrix * wp;
      gl_Position = projectionMatrix * mv;
      gl_PointSize = (0.8 + aRand * 1.6 + aGlow * 1.2) * uPR * (9.0 / -mv.z) * (1.0 + f);
      vMix = clamp(aGlow + n * 0.2 + sweep * 0.6, 0.0, 1.0);
      float body = 0.22 + 0.78 * clamp(aGlow * 1.1 + sweep * 0.5, 0.0, 1.0);
      vAlpha = mix(0.25 + aRand * 0.35, body, k) * (0.25 + 0.75 * t);
    }`,
  fragmentShader: /* glsl */`
    uniform vec3 uColA, uColB;
    varying float vMix;
    varying float vAlpha;
    void main(){
      float d = length(gl_PointCoord - 0.5);
      if (d > 0.5) discard;
      float a = smoothstep(0.5, 0.0, d);
      gl_FragColor = vec4(mix(uColA, uColB, vMix), a * vAlpha);
    }`,
});
const orb = new THREE.Points(pGeo, pMat);
const orbGroup = new THREE.Group();
orbGroup.add(orb);
scene.add(orbGroup);

/* ---------- Gold rings (echoing the logo) ---------- */
function makeRing(radius, opacity) {
  const pts = [];
  for (let i = 0; i < 256; i++) {
    const a = (i / 256) * Math.PI * 2;
    pts.push(new THREE.Vector3(Math.cos(a) * radius, Math.sin(a) * radius, 0));
  }
  const geo = new THREE.BufferGeometry().setFromPoints(pts);
  const mat = new THREE.LineBasicMaterial({ color: 0xe3a10a, transparent: true, opacity, depthWrite: false });
  const ring = new THREE.LineLoop(geo, mat);
  ring.userData.base = opacity;
  return ring;
}
const rings = [makeRing(2.85, 0.55), makeRing(3.05, 0.22)];
rings.forEach((r) => orbGroup.add(r));

/* diamond markers on the outer ring */
const diaGeo = new THREE.PlaneGeometry(0.09, 0.09);
const diaMat = new THREE.MeshBasicMaterial({ color: 0xffdc3c, transparent: true, depthWrite: false });
const diamonds = [0, 1, 2, 3].map((i) => {
  const m = new THREE.Mesh(diaGeo, diaMat);
  const a = (i / 4) * Math.PI * 2 + Math.PI / 2;
  m.position.set(Math.cos(a) * 2.85, Math.sin(a) * 2.85, 0);
  m.rotation.z = Math.PI / 4;
  rings[0].add(m);
  return m;
});

/* ---------- Project planes ---------- */
const manager = new THREE.LoadingManager();
const texLoader = new THREE.TextureLoader(manager);
const planeGeo = new THREE.PlaneGeometry(1, 1, 32, 32);
const planesGroup = new THREE.Group();
scene.add(planesGroup);

const planes = PROJECTS.map((p, i) => {
  const mat = new THREE.ShaderMaterial({
    transparent: true,
    uniforms: {
      uTex: { value: null },
      uPlane: { value: new THREE.Vector2(1.5, 1) },
      uImage: { value: new THREE.Vector2(1.5, 1) },
      uVelocity: { value: 0 },
      uActive: { value: 0 },
      uHover: { value: 0 },
      uAlpha: { value: 0 },
      uTime: { value: 0 },
      uReveal: { value: 0 },
      uFocus: { value: new THREE.Vector2(...(p.focus || [0.5, 0.5])) },
    },
    vertexShader: /* glsl */`
      uniform float uVelocity, uHover, uTime;
      varying vec2 vUv;
      void main(){
        vUv = uv;
        vec4 wp = modelMatrix * vec4(position, 1.0);
        wp.z -= pow(wp.x * 0.16, 2.0) * 1.6;                       // curved gallery
        wp.z += sin(uv.x * 3.14159) * uVelocity * 0.9;             // bend with speed
        wp.z += sin(uv.y * 8.0 + uTime * 2.5) * 0.035 * uHover;    // hover ripple
        gl_Position = projectionMatrix * viewMatrix * wp;
      }`,
    fragmentShader: /* glsl */`
      uniform sampler2D uTex;
      uniform vec2 uPlane, uImage, uFocus;
      uniform float uVelocity, uActive, uHover, uAlpha, uReveal;
      varying vec2 vUv;
      vec2 cover(vec2 uv){
        float rs = uPlane.x / uPlane.y, ri = uImage.x / uImage.y;
        vec2 n = rs < ri ? vec2(uImage.x * uPlane.y / uImage.y, uPlane.y) : vec2(uPlane.x, uImage.y * uPlane.x / uImage.x);
        vec2 o = (n - uPlane) * vec2(uFocus.x, 1.0 - uFocus.y) / n;
        return uv * uPlane / n + o;
      }
      void main(){
        vec2 uv = cover(vUv);
        vec2 f = vec2(uFocus.x, 1.0 - uFocus.y);
        uv = (uv - f) * (1.0 - 0.06 * uHover - 0.08 * (1.0 - uActive)) + f;
        float s = uVelocity * 0.025;
        vec3 col = vec3(
          texture2D(uTex, uv + vec2(s, 0.0)).r,
          texture2D(uTex, uv).g,
          texture2D(uTex, uv - vec2(s, 0.0)).b
        );
        float g = dot(col, vec3(0.299, 0.587, 0.114));
        vec3 tone = vec3(g) * vec3(1.0, 0.86, 0.6) * 0.55;
        col = mix(tone, col, uActive);
        // soft vertical wipe reveal
        float wipe = smoothstep(uReveal * 1.2 - 0.2, uReveal * 1.2, 1.0 - vUv.y);
        gl_FragColor = vec4(col, uAlpha * (1.0 - wipe));
      }`,
  });
  const mesh = new THREE.Mesh(planeGeo, mat);
  mesh.userData.index = i;
  planesGroup.add(mesh);

  texLoader.load(p.img, (tex) => {
    tex.minFilter = THREE.LinearFilter;
    tex.generateMipmaps = false;
    mat.uniforms.uTex.value = tex;
    mat.uniforms.uImage.value.set(tex.image.width, tex.image.height);
  });
  return mesh;
});

/* =========================================================
   Layout
   ========================================================= */
function layout() {
  const w = innerWidth, h = innerHeight;
  renderer.setSize(w, h, false);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
  view.h = 2 * camera.position.z * Math.tan(THREE.MathUtils.degToRad(camera.fov / 2));
  view.w = view.h * camera.aspect;
  view.mobile = w < 860;
  view.planeW = Math.min(view.h * 0.62 * 1.5, view.w * (view.mobile ? 0.8 : 0.5));
  view.planeH = view.planeW / 1.5;
  view.spacing = view.planeW * 1.22;
  planes.forEach((m, i) => {
    m.scale.set(view.planeW, view.planeH, 1);
    m.position.set(i * view.spacing, view.mobile ? view.h * 0.08 : view.h * 0.05, 0);
    m.material.uniforms.uPlane.value.set(view.planeW, view.planeH);
  });
  const orbScale = view.mobile ? Math.min(1, view.w / 7.2) : 1;
  orbGroup.scale.setScalar(orbScale);
  orbGroup.userData.x = view.mobile ? 0 : view.w * 0.2;
  orbGroup.userData.y = view.mobile ? view.h * 0.16 : 0;
  pMat.uniforms.uPR.value = renderer.getPixelRatio();
}
addEventListener('resize', layout);
layout();

/* =========================================================
   State + input
   ========================================================= */
const MAX = PROJECTS.length; // 0 = home, 1..N = projects
const state = { target: 0, current: 0, prev: 0, velocity: 0, intro: 0, loaded: false, panel: null };
// active: a mouse is over the page, or a finger is touching the screen. k eases toward it.
const mouse = { x: -200, y: -200, nx: 9, ny: 9, sx: 0, sy: 0, world: new THREE.Vector2(99, 99), active: false, k: 0 };
let snapTimer;

function go(v) {
  state.target = clamp(v, 0, MAX);
}
function snap() {
  clearTimeout(snapTimer);
  snapTimer = setTimeout(() => go(Math.round(state.target)), 160);
}

addEventListener('wheel', (e) => {
  if (!state.loaded || state.panel) return;
  const d = Math.abs(e.deltaY) > Math.abs(e.deltaX) ? e.deltaY : e.deltaX;
  go(state.target + clamp(d, -120, 120) * 0.0035);
  snap();
}, { passive: true });

addEventListener('keydown', (e) => {
  if (e.key === 'Escape') { closePanels(); document.body.classList.remove('menu-open'); return; }
  if (!state.loaded || state.panel) return;
  if (['ArrowRight', 'ArrowDown', 'PageDown'].includes(e.key)) go(Math.round(state.target) + 1);
  if (['ArrowLeft', 'ArrowUp', 'PageUp'].includes(e.key)) go(Math.round(state.target) - 1);
  if (e.key === 'Enter' && hudIndex >= 0 && document.body.classList.contains('is-work')) openProject(hudIndex);
});

/* drag (mouse + touch) */
const drag = { on: false, x: 0, y: 0, moved: 0 };
canvas.addEventListener('pointerdown', (e) => {
  if (!state.loaded) return;
  drag.on = true; drag.x = e.clientX; drag.y = e.clientY; drag.moved = 0;
  clearTimeout(snapTimer);
});
function trackPointer(e) {
  mouse.x = e.clientX; mouse.y = e.clientY;
  mouse.nx = (e.clientX / innerWidth) * 2 - 1;
  mouse.ny = -(e.clientY / innerHeight) * 2 + 1;
}
// a finger only counts while it is down; a mouse counts while it is over the page
addEventListener('pointerdown', (e) => { trackPointer(e); mouse.active = true; });
const releaseTouch = (e) => { if (e.pointerType !== 'mouse') mouse.active = false; };
addEventListener('pointerup', releaseTouch);
addEventListener('pointercancel', releaseTouch);
document.documentElement.addEventListener('pointerleave', () => { mouse.active = false; });
addEventListener('blur', () => { mouse.active = false; });
addEventListener('pointermove', (e) => {
  trackPointer(e);
  if (e.pointerType === 'mouse' || e.buttons) mouse.active = true;
  if (!drag.on) return;
  const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
  drag.x = e.clientX; drag.y = e.clientY;
  drag.moved += Math.abs(dx) + Math.abs(dy);
  const k = isTouch ? 0.006 : 0.004;
  go(state.target - dx * k - (isTouch ? dy * k : 0));
  if (drag.moved > 6) cursor.set('drag');
});
addEventListener('pointerup', () => {
  if (!drag.on) return;
  drag.on = false;
  if (drag.moved < 6) handleClick();
  snap();
});

/* raycasting */
const ray = new THREE.Raycaster();
const ndc = new THREE.Vector2();
let hovered = -1;
function pick() {
  if (!state.loaded || state.panel || state.current < 0.5) return -1;
  ndc.set(mouse.nx, mouse.ny);
  ray.setFromCamera(ndc, camera);
  const hit = ray.intersectObjects(planes)[0];
  return hit ? hit.object.userData.index : -1;
}
function handleClick() {
  const i = pick();
  if (i < 0) return;
  if (i === Math.round(state.current) - 1) openProject(i);
  else go(i + 1);
}

/* =========================================================
   Cursor
   ========================================================= */
const cursor = (() => {
  const root = $('.cursor'), dot = $('.cursor-dot'), ring = $('.cursor-ring'), text = $('.cursor-text');
  let mode = '';
  const pos = { x: innerWidth / 2, y: innerHeight / 2 };
  return {
    set(m) {
      if (m === mode) return;
      mode = m;
      root.className = 'cursor' + (m ? ' is-' + m : '');
      text.textContent = m === 'view' ? 'View' : m === 'drag' ? 'Drag' : '';
    },
    update() {
      pos.x = lerp(pos.x, mouse.x, 0.18);
      pos.y = lerp(pos.y, mouse.y, 0.18);
      dot.style.transform = `translate(${mouse.x}px, ${mouse.y}px)`;
      ring.style.transform = `translate(${pos.x}px, ${pos.y}px)`;
    },
  };
})();
let domHover = false;
document.addEventListener('pointerover', (e) => { domHover = !!e.target.closest('[data-hover], a, button'); });

/* =========================================================
   HUD
   ========================================================= */
const titleEl = $('#work-title');
let hudIndex = -1, hudTimer;
$('#work-total').textContent = pad2(PROJECTS.length);

function splitText(el, text) {
  el.innerHTML = [...text].map((c, i) => `<span class="char" style="--i:${i}">${c === ' ' ? '&nbsp;' : c}</span>`).join('');
}
function setHud(i) {
  if (i === hudIndex) return;
  hudIndex = i;
  const p = PROJECTS[i];
  titleEl.classList.remove('in');
  titleEl.classList.add('out');
  clearTimeout(hudTimer);
  hudTimer = setTimeout(() => {
    splitText(titleEl, p.title);
    titleEl.classList.remove('out');
    void titleEl.offsetWidth;
    titleEl.classList.add('in');
    $('#work-num').textContent = pad2(i + 1);
    $('#work-cat').textContent = p.cat;
    $('#work-year').textContent = p.year || '';
    $('.work-meta .dot').hidden = !p.year;
  }, titleEl.textContent ? 380 : 0);
}

/* rail */
const rail = $('#rail');
rail.innerHTML = ['Intro', ...PROJECTS.map((p) => p.title)]
  .map((t, i) => `<button data-i="${i}" data-hover aria-label="${t}"><span class="label">${pad2(i)} ${t}</span><i></i></button>`)
  .join('');
const railBtns = $$('button', rail);
railBtns.forEach((b) => b.addEventListener('click', () => { closePanels(); go(+b.dataset.i); }));

/* =========================================================
   Panels + navigation
   ========================================================= */
const navBtns = $$('.nav button');
function openPanel(id) {
  closePanels(true);
  const el = $('#panel-' + id);
  el.classList.add('open');
  el.setAttribute('aria-hidden', 'false');
  el.scrollTop = 0;
  state.panel = id;
  document.body.classList.add('panel-open');
  navBtns.forEach((b) => b.classList.toggle('active', b.dataset.nav === id));
}
function closePanels(silent) {
  $$('.panel.open').forEach((p) => { p.classList.remove('open'); p.setAttribute('aria-hidden', 'true'); });
  state.panel = null;
  if (!silent) {
    document.body.classList.remove('panel-open');
    navBtns.forEach((b) => b.classList.toggle('active', b.dataset.nav === 'work' && state.target >= 1));
  }
}
function openProject(i) {
  const p = PROJECTS[i];
  const next = PROJECTS[(i + 1) % PROJECTS.length];
  $('#pp-kicker').textContent = `${pad2(i + 1)} / ${pad2(PROJECTS.length)} — ${p.cat}`;
  $('#pp-title').textContent = p.title;
  $('#pp-hero').src = p.img;
  $('#pp-hero').alt = p.title;
  const pos = p.focus ? `${p.focus[0] * 100}% ${p.focus[1] * 100}%` : '50% 50%';
  $('#pp-hero').style.objectPosition = pos;
  $('.pp-hero').style.aspectRatio = p.ratio || '';
  $('#pp-cat').textContent = p.cat;
  $('#pp-year').textContent = p.year || '';
  $('#pp-year').parentElement.hidden = !p.year;
  $('#pp-role').textContent = p.role;
  $('#pp-body').innerHTML = p.body.map((t) => `<p>${t}</p>`).join('');
  $('#pp-gallery').innerHTML = p.gallery.filter((g) => g !== p.img || p.gallery.length === 1)
    .map((g) => `<figure${p.ratio ? ` style="aspect-ratio:${p.ratio}"` : ''}><img src="${g}" alt="${p.title}" loading="lazy" style="object-position:${g === p.img ? pos : '50% 50%'}"></figure>`).join('');
  $('#pp-next-title').textContent = next.title;
  $('#pp-next').onclick = () => {
    const n = (i + 1) % PROJECTS.length;
    go(n + 1); state.current = n + 1;
    openProject(n);
  };
  openPanel('project');
  navBtns.forEach((b) => b.classList.toggle('active', b.dataset.nav === 'work'));
}

$$('[data-nav]').forEach((b) => b.addEventListener('click', () => {
  const t = b.dataset.nav;
  document.body.classList.remove('menu-open');
  if (t === 'home') { closePanels(); go(0); }
  else if (t === 'work') { closePanels(); go(Math.max(1, Math.round(state.target))); }
  else openPanel(t);
}));
$$('[data-close]').forEach((b) => b.addEventListener('click', () => closePanels()));
$('#work-open').addEventListener('click', () => hudIndex >= 0 && openProject(hudIndex));
$('.menu-btn').addEventListener('click', () => document.body.classList.toggle('menu-open'));

/* copy-to-clipboard buttons (e.g. email on the Contact panel) */
$$('[data-copy]').forEach((btn) => btn.addEventListener('click', async () => {
  const text = btn.dataset.copy;
  let ok = false;
  try { await navigator.clipboard.writeText(text); ok = true; } catch {
    const ta = document.createElement('textarea');
    ta.value = text; ta.style.position = 'fixed'; ta.style.opacity = '0';
    document.body.appendChild(ta); ta.select();
    try { ok = document.execCommand('copy'); } catch { ok = false; }
    ta.remove();
  }
  btn.textContent = ok ? 'Copied' : 'Press Ctrl+C';
  btn.classList.toggle('copied', ok);
  clearTimeout(btn._t);
  btn._t = setTimeout(() => { btn.textContent = 'Copy'; btn.classList.remove('copied'); }, 1800);
}));

/* =========================================================
   Loader
   ========================================================= */
let loadProgress = 0, shown = 0, assetsDone = false;
manager.onProgress = (_u, done, total) => { loadProgress = done / total; };
manager.onLoad = () => { loadProgress = 1; assetsDone = true; };
setTimeout(() => { assetsDone = true; loadProgress = 1; }, 8000); // safety net
const loaderNum = $('#loader-num'), loaderBar = $('#loader-bar');

function tickLoader() {
  if (state.loaded) return;
  shown = lerp(shown, loadProgress, 0.06);
  if (assetsDone && shown > 0.995) shown = 1;
  loaderNum.textContent = String(Math.round(shown * 100)).padStart(3, '0');
  loaderBar.style.transform = `scaleX(${shown})`;
  if (shown === 1) {
    state.loaded = true;
    setTimeout(() => document.body.classList.add('loaded'), 250);
  }
}

/* =========================================================
   Loop
   ========================================================= */
const clock = new THREE.Clock();
function frame() {
  const t = clock.getElapsedTime();
  tickLoader();

  // scroll physics
  state.prev = state.current;
  state.current = lerp(state.current, state.target, 0.075);
  if (Math.abs(state.current - state.target) < 0.0005) state.current = state.target;
  state.velocity = lerp(state.velocity, state.current - state.prev, 0.15);
  const vel = clamp(state.velocity * 14, -1.4, 1.4);

  if (state.loaded) state.intro = Math.min(1, state.intro + 0.006);

  // mouse smoothing
  const inView = mouse.active && Math.abs(mouse.nx) <= 1;
  mouse.sx = lerp(mouse.sx, inView ? mouse.nx : 0, 0.06);
  mouse.sy = lerp(mouse.sy, inView ? mouse.ny : 0, 0.06);
  // push strength fades in/out; while fading out the push stays where it was, so particles ease back
  mouse.k = lerp(mouse.k, inView ? 1 : 0, inView ? 0.15 : 0.05);
  if (inView) mouse.world.set(mouse.nx * view.w / 2, mouse.ny * view.h / 2);

  // camera parallax
  camera.position.x = lerp(camera.position.x, mouse.sx * 0.35, 0.1);
  camera.position.y = lerp(camera.position.y, mouse.sy * 0.2, 0.1);
  camera.lookAt(0, 0, 0);

  // orb
  const disperse = smooth(0, 1, state.current);
  pMat.uniforms.uTime.value = t;
  pMat.uniforms.uIntro.value = state.intro;
  pMat.uniforms.uDisperse.value = disperse;
  pMat.uniforms.uMouse.value.copy(mouse.world);
  pMat.uniforms.uMouseK.value = mouse.k;
  // car spins slowly on a turntable; the whole stage tilts toward the viewer
  orb.rotation.y = -0.6 + t * 0.22 + mouse.sx * 0.5;
  orbGroup.rotation.x = 0.32 - mouse.sy * 0.15;
  orbGroup.position.x = (orbGroup.userData.x || 0) * (1 - disperse) - disperse * 2;
  orbGroup.position.y = orbGroup.userData.y || 0;
  const ringFade = smooth(0.2, 1, state.intro) * (1 - smooth(0, 0.6, state.current));
  rings.forEach((r, i) => {
    r.material.opacity = r.userData.base * ringFade;
    r.position.y = -0.68;
    r.rotation.x = Math.PI / 2;
    r.scale.setScalar(0.9 + 0.1 * ringFade + disperse * 0.6);
  });
  rings[0].rotation.z = t * 0.22 + mouse.sx * 0.5;
  diaMat.opacity = ringFade;

  // planes
  planesGroup.position.x = -(state.current - 1) * view.spacing;
  const reveal = smooth(0.15, 1, state.current);
  const hit = pick();
  if (hit !== hovered) hovered = hit;
  planes.forEach((m, i) => {
    const u = m.material.uniforms;
    const dist = Math.abs(state.current - 1 - i);
    const active = 1 - clamp(dist, 0, 1);
    u.uTime.value = t;
    u.uVelocity.value = vel;
    u.uActive.value = lerp(u.uActive.value, active, 0.2);
    u.uHover.value = lerp(u.uHover.value, hovered === i ? 1 : 0, 0.08);
    u.uAlpha.value = u.uTex.value ? reveal : 0;
    u.uReveal.value = reveal;
    const s = 0.84 + 0.16 * active;
    m.scale.set(view.planeW * s, view.planeH * s, 1);
  });

  // HUD
  const isWork = state.current > 0.5;
  document.body.classList.toggle('is-work', isWork);
  if (isWork) setHud(clamp(Math.round(state.current) - 1, 0, PROJECTS.length - 1));
  const railIdx = Math.round(state.current);
  railBtns.forEach((b, i) => b.classList.toggle('active', i === railIdx));
  if (!state.panel) navBtns.forEach((b) => b.classList.toggle('active', b.dataset.nav === 'work' && isWork));

  // cursor
  if (!isTouch) {
    if (drag.on && drag.moved > 6) cursor.set('drag');
    else if (state.panel || domHover) cursor.set(domHover ? 'hover' : '');
    else if (hovered >= 0) cursor.set(hovered === Math.round(state.current) - 1 ? 'view' : 'hover');
    else cursor.set('');
    cursor.update();
  }

  renderer.render(scene, camera);
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);
