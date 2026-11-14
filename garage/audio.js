/* =========================================================
   Drive sounds, generated live with the Web Audio API (no files):
   engine (turbo inline-6), turbo whistle + blow-off, gear shifts, gear whine,
   lift-off pops, tyre squeal, gravel, wind, and a location ambience.
   Each car has its own voice (see VOICES). Recordings can replace the
   generated engine later.
   ========================================================= */

const clamp = (v, a, b) => Math.min(b, Math.max(a, v));

/* Per-car character.
   m240i: road car. Smooth, refined straight-six, soft turbo with a quiet "pssh" when you lift,
          seamless automatic upshifts, a few light crackles, a muffled (sound-deadened) cabin.
   gt3:   race car. Harsher, louder six with more harmonics, a lumpy idle, loud turbo with a
          fluttering blow-off, straight-cut gear whine, hard sequential upshifts with a crack,
          deep bangs on the overrun, and the boom and ring of a stripped-out shell. */
const VOICES = {
  m240i: {
    idle: 850, redline: 7000, cyl: 6, cutoff: 820, grit: 0.28, rasp: 0.08, vol: 0.86,
    harm: [0, 1, 0.55, 0.32, 0.18, 0.11, 0.06, 0.04, 0.03, 0.02],
    pops: 0.45, popBand: [450, 900], popVol: 0.55,
    turbo: { whistle: 0.035, lo: 2600, hi: 6200, bov: 'soft', bovVol: 0.28 },
    whine: 0,
    shift: { dip: 0.62, time: 0.14, crack: 0 },
    lope: 0,
    boom: { f: 95, gain: 2, q: 0.9 }, ring: { f: 2600, gain: -4, q: 0.8 },   // insulated: no ring
  },
  gt3: {
    idle: 1150, redline: 8400, cyl: 6, cutoff: 1500, grit: 0.75, rasp: 0.24, vol: 1.0,
    harm: [0, 1, 0.72, 0.64, 0.46, 0.42, 0.3, 0.27, 0.2, 0.17, 0.12, 0.1, 0.08, 0.06],
    pops: 1.0, popBand: [220, 600], popVol: 1.0,
    turbo: { whistle: 0.06, lo: 3000, hi: 8200, bov: 'flutter', bovVol: 0.5 },
    whine: 0.08,
    shift: { dip: 0.08, time: 0.07, crack: 0.9 },
    lope: 0.22,
    boom: { f: 125, gain: 6, q: 1.4 }, ring: { f: 2200, gain: 5, q: 2.5 },
  },
};

export function createSound() {
  let ctx = null, master = null, nodes = null, voice = VOICES.m240i;
  let enabled = true;
  try { enabled = localStorage.getItem('garage-sound') !== 'off'; } catch {}
  let running = false;
  let lastGear = 0, lastThrottle = 0, popWindow = 0, shiftT = 0, rpmSm = 0, boost = 0;
  const waves = {};

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
    for (const [k, v] of Object.entries(VOICES)) waves[k] = ctx.createPeriodicWave(new Float32Array(v.harm), new Float32Array(v.harm.length));

    /* engine: firing-frequency tone + sub rumble + exhaust rasp -> grit -> tone -> body (boom, ring) */
    const osc = ctx.createOscillator(); osc.setPeriodicWave(waves.m240i);
    const sub = ctx.createOscillator(); sub.type = 'sawtooth';
    const subG = ctx.createGain(); subG.gain.value = 0.35;
    const oscG = ctx.createGain(); oscG.gain.value = 0.7;
    const rasp = noiseSource(noise);
    const raspBP = ctx.createBiquadFilter(); raspBP.type = 'bandpass'; raspBP.Q.value = 1.3;
    const raspG = ctx.createGain(); raspG.gain.value = 0;
    const shaper = ctx.createWaveShaper(); shaper.oversample = '2x'; shaper.curve = softClip(0.3);
    const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.Q.value = 0.9;
    const boom = ctx.createBiquadFilter(); boom.type = 'peaking';
    const ring = ctx.createBiquadFilter(); ring.type = 'peaking';
    const engG = ctx.createGain(); engG.gain.value = 0;
    osc.connect(oscG).connect(shaper);
    sub.connect(subG).connect(shaper);
    rasp.connect(raspBP).connect(raspG).connect(shaper);
    shaper.connect(lp).connect(boom).connect(ring).connect(engG).connect(master);
    osc.start(); sub.start();
    // idle lope: a slow wobble added to the engine level near idle
    const lope = ctx.createOscillator(); lope.frequency.value = 3.3;
    const lopeG = ctx.createGain(); lopeG.gain.value = 0;
    lope.connect(lopeG).connect(engG.gain); lope.start();

    /* turbo whistle: narrow noise band + a faint pure tone, pitch follows boost */
    const twBP = ctx.createBiquadFilter(); twBP.type = 'bandpass'; twBP.Q.value = 22;
    const twTone = ctx.createOscillator(); twTone.type = 'sine';
    const twToneG = ctx.createGain(); twToneG.gain.value = 0.35;
    const twG = ctx.createGain(); twG.gain.value = 0;
    noiseSource(noise).connect(twBP).connect(twG);
    twTone.connect(twToneG).connect(twG); twTone.start();
    twG.connect(master);

    /* blow-off / flutter on lift */
    const bovBP = ctx.createBiquadFilter(); bovBP.type = 'bandpass'; bovBP.Q.value = 0.9;
    const bovG = ctx.createGain(); bovG.gain.value = 0;
    noiseSource(noise).connect(bovBP).connect(bovG).connect(master);

    /* straight-cut gear whine */
    const whine = ctx.createOscillator(); whine.type = 'triangle';
    const whineG = ctx.createGain(); whineG.gain.value = 0;
    whine.connect(whineG).connect(master); whine.start();

    /* lift-off pops and shift cracks: short filtered noise bursts */
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

    nodes = { osc, sub, subG, oscG, raspBP, raspG, shaper, lp, boom, ring, engG, lopeG, twBP, twTone, twG, bovBP, bovG, whine, whineG,
      popG, popBP, sqG, sqA, sqB, grG, wnG, wnBP, amG, amLP, thG };
  }

  const set = (param, v, tc = 0.05) => param.setTargetAtTime(v, ctx.currentTime, tc);

  // apply the current car's fixed character (wave shape, body resonances)
  function applyVoice(key) {
    if (!nodes) return;
    nodes.osc.setPeriodicWave(waves[key] || waves.m240i);
    const v = voice;
    nodes.boom.frequency.value = v.boom.f; nodes.boom.gain.value = v.boom.gain; nodes.boom.Q.value = v.boom.q;
    nodes.ring.frequency.value = v.ring.f; nodes.ring.gain.value = v.ring.gain; nodes.ring.Q.value = v.ring.q;
    nodes.shaper.curve = softClip(v.grit * 0.3);
  }

  function burst(strength, lo, hi, len = 0.06) {
    const t = ctx.currentTime, g = nodes.popG.gain;
    nodes.popBP.frequency.setValueAtTime(lo + Math.random() * (hi - lo), t);
    g.cancelScheduledValues(t);
    g.setValueAtTime(0.0001, t);
    g.exponentialRampToValueAtTime(Math.max(0.001, strength), t + 0.004);
    g.exponentialRampToValueAtTime(0.0001, t + len + Math.random() * 0.05);
  }
  const pop = (strength) => burst(strength * voice.popVol, voice.popBand[0], voice.popBand[1]);

  // turbo blow-off when lifting with boost: a soft falling "pssh", or a fluttering chatter
  function blowOff(amount) {
    const t = ctx.currentTime, g = nodes.bovG.gain, f = nodes.bovBP.frequency, tb = voice.turbo;
    const peak = Math.max(0.002, tb.bovVol * amount);
    g.cancelScheduledValues(t); f.cancelScheduledValues(t);
    if (tb.bov === 'soft') {
      f.setValueAtTime(2800, t); f.exponentialRampToValueAtTime(1100, t + 0.45);
      g.setValueAtTime(0.0001, t);
      g.exponentialRampToValueAtTime(peak, t + 0.02);
      g.exponentialRampToValueAtTime(0.0001, t + 0.5);
    } else {
      f.setValueAtTime(1500, t); f.exponentialRampToValueAtTime(700, t + 0.32);
      g.setValueAtTime(0.0001, t);
      const n = 7;
      for (let i = 0; i < n; i++) {
        const ti = t + i * 0.042, a = peak * (1 - i / (n + 1));
        g.exponentialRampToValueAtTime(Math.max(0.002, a), ti + 0.008);
        g.exponentialRampToValueAtTime(0.0003, ti + 0.034);
      }
    }
  }

  return {
    get enabled() { return enabled; },
    // for checking from the console
    debug: () => ctx && nodes ? { state: ctx.state, master: +master.gain.value.toFixed(3), engineHz: Math.round(nodes.osc.frequency.value), engine: +nodes.engG.gain.value.toFixed(3),
      boost: +boost.toFixed(2), turbo: +nodes.twG.gain.value.toFixed(3), whine: +nodes.whineG.gain.value.toFixed(3),
      squeal: +nodes.sqG.gain.value.toFixed(3), wind: +nodes.wnG.gain.value.toFixed(3), amb: +nodes.amG.gain.value.toFixed(3), gravel: +nodes.grG.gain.value.toFixed(3) } : { state: 'none' },
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
      rpmSm = voice.idle; boost = 0; lastGear = 0; lastThrottle = 0;
      if (!ctx) return;
      applyVoice(carKey);
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

      // upshift: the race car cuts hard and cracks; the road car's automatic barely dips
      if (s.gear > lastGear && lastGear > 0) {
        shiftT = v.shift.time;
        if (v.shift.crack && thr > 0.3) burst(v.shift.crack, 260, 520, 0.05);
      }
      lastGear = s.gear;
      shiftT = Math.max(0, shiftT - s.dt);
      const dip = shiftT > 0 ? v.shift.dip : 1;
      set(nodes.engG.gain, v.vol * 0.78 * (0.16 + thr * 0.24 + r01 * 0.14) * dip, shiftT > 0 ? (v.shift.dip < 0.3 ? 0.008 : 0.04) : 0.05);
      // lumpy idle (race cam): strongest at idle, gone by mid-revs
      set(nodes.lopeG.gain, v.lope * v.vol * 0.1 * clamp(1 - r01 * 3, 0, 1) * (1 - thr * 0.7), 0.1);

      // turbo: boost builds with throttle and revs (with lag), whistle rises with it
      const boostTarget = thr * clamp((r01 - 0.12) / 0.5, 0, 1);
      boost += (boostTarget - boost) * clamp(s.dt * (boostTarget > boost ? 1.8 : 7), 0, 1);
      set(nodes.twG.gain, v.turbo.whistle * boost * (0.4 + thr * 0.6), 0.05);
      const twf = v.turbo.lo + (v.turbo.hi - v.turbo.lo) * boost;
      set(nodes.twBP.frequency, twf, 0.05);
      set(nodes.twTone.frequency, twf, 0.05);

      // lift off with boost -> blow-off; at high revs -> pops and crackles over the next ~0.7 s
      if (lastThrottle > 0.5 && thr < 0.1) {
        if (boost > 0.25) blowOff(boost);
        if (r01 > 0.45) popWindow = 0.7;
      }
      if (popWindow > 0) {
        popWindow -= s.dt;
        if (thr < 0.1 && popWindow < 0.62 && Math.random() < 9 * v.pops * s.dt) pop(0.4 + Math.random() * 0.6 * v.pops);
      }
      lastThrottle = thr;

      // straight-cut gear whine: pitch follows road speed, louder on the overrun
      if (v.whine) {
        set(nodes.whine.frequency, 120 + s.speed * 34, 0.05);
        set(nodes.whineG.gain, v.whine * clamp(s.speed / 30, 0, 1) * (0.55 + (1 - thr) * 0.45) * (s.gear > 0 ? 1 : 0), 0.08);
      } else set(nodes.whineG.gain, 0, 0.1);

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
