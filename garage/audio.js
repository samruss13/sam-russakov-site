/* =========================================================
   Drive sounds, generated live with the Web Audio API (no files):
   engine (inline-6), gear shifts, lift-off pops, tyre squeal,
   gravel, wind, and a location ambience (desert wind / surf).
   Recordings can replace the generated engine later.
   ========================================================= */

const clamp = (v, a, b) => Math.min(b, Math.max(a, v));

// per-car character
const VOICES = {
  m240i: { idle: 850, redline: 7000, cyl: 6, cutoff: 900, grit: 0.35, rasp: 0.10, pops: 0.6, vol: 0.9 },
  gt3:   { idle: 1100, redline: 8400, cyl: 6, cutoff: 1500, grit: 0.7, rasp: 0.22, pops: 1.0, vol: 1.0 },
};

export function createSound() {
  let ctx = null, master = null, nodes = null, voice = VOICES.m240i;
  let enabled = true;
  try { enabled = localStorage.getItem('garage-sound') !== 'off'; } catch {}
  let running = false;
  let lastGear = 0, lastThrottle = 0, popWindow = 0, shiftT = 0, rpmSm = 0;

  function noiseBuffer(seconds = 2) {
    const b = ctx.createBuffer(1, ctx.sampleRate * seconds, ctx.sampleRate);
    const d = b.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
    return b;
  }
  function noiseSource(buf) {
    const s = ctx.createBufferSource();
    s.buffer = buf; s.loop = true; s.start();
    return s;
  }
  function softClip(amount) {
    const n = 1024, c = new Float32Array(n), k = 1 + amount * 20;
    for (let i = 0; i < n; i++) { const x = (i / (n - 1)) * 2 - 1; c[i] = Math.tanh(k * x) / Math.tanh(k); }
    return c;
  }

  function build() {
    master = ctx.createGain();
    master.gain.value = 0;
    // gentle limiter so nothing clips on phone speakers
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -8; comp.ratio.value = 4; comp.attack.value = 0.003; comp.release.value = 0.2;
    master.connect(comp).connect(ctx.destination);
    const noise = noiseBuffer(3);

    /* engine: firing-frequency tone with rich harmonics + sub rumble + exhaust rasp */
    const harm = new Float32Array([0, 1, 0.62, 0.48, 0.3, 0.26, 0.16, 0.12, 0.1, 0.06, 0.05, 0.04, 0.03]);
    const wave = ctx.createPeriodicWave(harm, new Float32Array(harm.length));
    const osc = ctx.createOscillator(); osc.setPeriodicWave(wave);
    const sub = ctx.createOscillator(); sub.type = 'sawtooth';
    const subG = ctx.createGain(); subG.gain.value = 0.35;
    const oscG = ctx.createGain(); oscG.gain.value = 0.7;
    const rasp = noiseSource(noise);
    const raspBP = ctx.createBiquadFilter(); raspBP.type = 'bandpass'; raspBP.Q.value = 1.3;
    const raspG = ctx.createGain(); raspG.gain.value = 0;
    const shaper = ctx.createWaveShaper(); shaper.oversample = '2x'; shaper.curve = softClip(0.3);
    const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.Q.value = 0.9;
    const engG = ctx.createGain(); engG.gain.value = 0;
    osc.connect(oscG).connect(shaper);
    sub.connect(subG).connect(shaper);
    rasp.connect(raspBP).connect(raspG).connect(shaper);
    shaper.connect(lp).connect(engG).connect(master);
    osc.start(); sub.start();

    /* lift-off pops: short filtered noise bursts */
    const popBP = ctx.createBiquadFilter(); popBP.type = 'bandpass'; popBP.frequency.value = 700; popBP.Q.value = 0.8;
    const popG = ctx.createGain(); popG.gain.value = 0;
    noiseSource(noise).connect(popBP).connect(popG).connect(master);

    /* tyre squeal: two narrow bands */
    const sqA = ctx.createBiquadFilter(); sqA.type = 'bandpass'; sqA.frequency.value = 1750; sqA.Q.value = 14;
    const sqB = ctx.createBiquadFilter(); sqB.type = 'bandpass'; sqB.frequency.value = 2450; sqB.Q.value = 18;
    const sqG = ctx.createGain(); sqG.gain.value = 0;
    const sqSrc = noiseSource(noise);
    sqSrc.connect(sqA).connect(sqG); sqSrc.connect(sqB).connect(sqG);
    sqG.connect(master);

    /* gravel / dirt rumble */
    const grLP = ctx.createBiquadFilter(); grLP.type = 'lowpass'; grLP.frequency.value = 500;
    const grG = ctx.createGain(); grG.gain.value = 0;
    noiseSource(noise).connect(grLP).connect(grG).connect(master);

    /* wind / road roar, rises with speed */
    const wnBP = ctx.createBiquadFilter(); wnBP.type = 'bandpass'; wnBP.frequency.value = 450; wnBP.Q.value = 0.5;
    const wnG = ctx.createGain(); wnG.gain.value = 0;
    noiseSource(noise).connect(wnBP).connect(wnG).connect(master);

    /* ambience: slow swells (surf at the beach, gusts in the desert) */
    const amLP = ctx.createBiquadFilter(); amLP.type = 'lowpass'; amLP.frequency.value = 700;
    const amHP = ctx.createBiquadFilter(); amHP.type = 'highpass'; amHP.frequency.value = 90;
    const amG = ctx.createGain(); amG.gain.value = 0;
    noiseSource(noise).connect(amHP).connect(amLP).connect(amG).connect(master);

    /* crash thud */
    const thLP = ctx.createBiquadFilter(); thLP.type = 'lowpass'; thLP.frequency.value = 180;
    const thG = ctx.createGain(); thG.gain.value = 0;
    noiseSource(noise).connect(thLP).connect(thG).connect(master);

    nodes = { osc, sub, subG, oscG, raspBP, raspG, shaper, lp, engG, popG, popBP, sqG, sqA, sqB, grG, wnG, wnBP, amG, amLP, thG };
  }

  const set = (param, v, tc = 0.05) => param.setTargetAtTime(v, ctx.currentTime, tc);

  function pop(strength) {
    const t = ctx.currentTime, g = nodes.popG.gain;
    nodes.popBP.frequency.setValueAtTime(500 + Math.random() * 700, t);
    g.cancelScheduledValues(t);
    g.setValueAtTime(0.0001, t);
    g.exponentialRampToValueAtTime(0.9 * strength, t + 0.004);
    g.exponentialRampToValueAtTime(0.0001, t + 0.06 + Math.random() * 0.05);
  }

  return {
    get enabled() { return enabled; },
    // for checking from the console
    debug: () => ctx && nodes ? { state: ctx.state, master: +master.gain.value.toFixed(3), engineHz: Math.round(nodes.osc.frequency.value), engine: +nodes.engG.gain.value.toFixed(3), squeal: +nodes.sqG.gain.value.toFixed(3), wind: +nodes.wnG.gain.value.toFixed(3), amb: +nodes.amG.gain.value.toFixed(3), gravel: +nodes.grG.gain.value.toFixed(3) } : { state: 'none' },
    // call from a click/tap handler: browsers only allow audio after a user gesture
    unlock() {
      try {
        if (!ctx) {
          const AC = window.AudioContext || window.webkitAudioContext;
          if (!AC) return;
          ctx = new AC();
          build();
        }
        if (ctx.state === 'suspended') ctx.resume();
        // iOS: play a silent blip inside the gesture
        const b = ctx.createBuffer(1, 1, 22050), s = ctx.createBufferSource();
        s.buffer = b; s.connect(ctx.destination); s.start(0);
      } catch {}
    },
    start(carKey, ambience) {
      voice = VOICES[carKey] || VOICES.m240i;
      this.ambience = ambience;
      running = true;
      rpmSm = voice.idle;
      if (!ctx) return;
      if (ctx.state === 'suspended') ctx.resume();
      set(master.gain, enabled ? 0.8 : 0, 0.3);
    },
    stop() {
      running = false;
      if (!ctx) return;
      set(master.gain, 0, 0.15);
      setTimeout(() => { if (!running && ctx.state === 'running') ctx.suspend(); }, 900);
    },
    toggle() {
      enabled = !enabled;
      try { localStorage.setItem('garage-sound', enabled ? 'on' : 'off'); } catch {}
      if (ctx && running) { if (ctx.state === 'suspended') ctx.resume(); set(master.gain, enabled ? 0.8 : 0, 0.1); }
      return enabled;
    },
    /* s = { speed (m/s), rpm01 (0..1 within the gear), gear, throttle, brake, slide (m/s), off, hit, amb (0..1), dt } */
    update(s) {
      if (!ctx || !nodes || !running) return;
      const v = voice;
      // after an upshift the revs only fall part-way (closer ratios in the higher gears)
      const floor = s.gear <= 1 ? v.idle + 500 : v.redline * [0, 0, 0.56, 0.62, 0.66, 0.69, 0.71][Math.min(s.gear, 6)];
      const rpmTarget = s.gear <= 0 ? v.idle + s.throttle * 2200 : floor + s.rpm01 * (v.redline - floor);
      // shifts: rpm drops fast on upshift, rises a little slower
      rpmSm += (rpmTarget - rpmSm) * clamp(s.dt * (rpmTarget < rpmSm ? 14 : 7), 0, 1);
      const rpm = rpmSm, r01 = clamp((rpm - v.idle) / (v.redline - v.idle), 0, 1);
      const fire = (rpm / 60) * (v.cyl / 2); // firing frequency of a 4-stroke
      const thr = s.throttle;

      set(nodes.osc.frequency, fire, 0.02);
      set(nodes.sub.frequency, fire / 2, 0.02);
      set(nodes.raspBP.frequency, fire * 3.2, 0.03);
      set(nodes.raspG.gain, v.rasp * (0.25 + thr * 0.9) * (0.4 + r01), 0.04);
      set(nodes.lp.frequency, v.cutoff * (0.55 + r01 * 1.6) + thr * 1400, 0.05);
      if (Math.abs(thr - lastThrottle) > 0.3) nodes.shaper.curve = softClip(v.grit * (0.3 + thr * 0.7));
      // upshift: a short dip, like the ignition cut
      if (s.gear > lastGear && lastGear > 0) shiftT = 0.11;
      lastGear = s.gear;
      shiftT = Math.max(0, shiftT - s.dt);
      const dip = shiftT > 0 ? 0.15 : 1;
      set(nodes.engG.gain, v.vol * 0.78 * (0.16 + thr * 0.24 + r01 * 0.14) * dip, shiftT > 0 ? 0.01 : 0.05);

      // lift off at high revs -> a few pops and crackles over the next ~0.7 s
      if (lastThrottle > 0.5 && thr < 0.1 && r01 > 0.45) popWindow = 0.7;
      if (popWindow > 0) {
        popWindow -= s.dt;
        if (thr < 0.1 && Math.random() < 9 * v.pops * s.dt) pop(0.4 + Math.random() * 0.6 * v.pops);
      }
      lastThrottle = thr;

      // tyres, dirt, wind
      const squeal = s.off ? 0 : clamp((s.slide - 2.5) / 8, 0, 1) * clamp(s.speed / 8, 0, 1);
      set(nodes.sqG.gain, squeal * 0.75, 0.06);
      set(nodes.sqA.frequency, 1650 + squeal * 300, 0.1);
      set(nodes.grG.gain, s.off ? clamp(s.speed / 20, 0.15, 1) * 0.65 : 0, 0.08);
      set(nodes.wnG.gain, clamp(s.speed / 65, 0, 1) ** 1.5 * 0.55, 0.2);
      set(nodes.wnBP.frequency, 300 + s.speed * 9, 0.2);

      // ambience swells
      const t = ctx.currentTime;
      const swell = this.ambience === 'surf'
        ? 0.55 + 0.45 * Math.sin(t * 0.55) * Math.sin(t * 0.21 + 1)
        : 0.6 + 0.4 * Math.sin(t * 0.3) * Math.sin(t * 0.13 + 2);
      set(nodes.amG.gain, s.amb * swell * (this.ambience === 'surf' ? 0.8 : 0.35), 0.3);
      set(nodes.amLP.frequency, this.ambience === 'surf' ? 500 + swell * 900 : 380 + swell * 300, 0.3);

      if (s.hit > 3) { const g = nodes.thG.gain; g.cancelScheduledValues(t); g.setValueAtTime(clamp(s.hit / 8, 0.4, 1.4), t); g.exponentialRampToValueAtTime(0.0001, t + 0.35); }
    },
  };
}
