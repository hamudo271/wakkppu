/**
 * All 왁뿌볼 sounds are synthesized from one noise buffer; nothing is sampled.
 *
 * The shell cracking is a series of separate CRUNCH events ("콰작! 콰자작! 콰자자작!"), never a
 * continuous crackle. One event is 1–4 hits a few dozen ms apart:
 *   콰  — the big hit: sharp broadband click + a mid "crunch" body (~1 kHz) + a lower body (~420 Hz)
 *         + a few micro-cracks inside the first 20 ms (grit) + a short low thump for weight.
 *   자  — a smaller, drier follow-up hit.
 *   작  — the closing snap: crisp click with a short, higher body.
 * Silence between hits is what makes it read as 콰-자-작 instead of 지지직.
 */
const db = (x: number) => Math.pow(10, x / 20);
const U = (a: number, b: number) => a + (b - a) * Math.random();

type Layer = { gain: GainNode; nodes: AudioNode[]; extra?: Record<string, AudioParam> };
type HitKind = "kwa" | "ja" | "jak" | "tik";
type FilterKind = "highpass" | "bandpass" | "lowpass";
type OscillatorKind = "sine" | "triangle";

export type CrunchOpts = {
  /** the main pop: adds the "뽀" body under the crunch */
  heavy?: boolean;
  /** extra sub-bass thump: used where the phone cannot vibrate (iPhone) */
  sub?: boolean;
};

// onset patterns (ms) for 1–4 hits: 콱 / 콰작 / 콰자작 / 콰자자작
const ONSETS = [[0], [0, 74], [0, 68, 122], [0, 60, 108, 150]];
const KINDS: HitKind[][] = [["kwa"], ["kwa", "jak"], ["kwa", "ja", "jak"], ["kwa", "ja", "ja", "jak"]];

export class CrushAudio {
  ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private noise: AudioBuffer | null = null;
  private layers = new Map<string, Layer>();
  onState: (running: boolean) => void = () => {};
  wanted = false; // a press happened; used to show the "소리 켜기" chip when locked

  get running() {
    return !!this.ctx && this.ctx.state === "running";
  }

  /** Create/resume on a user gesture. Safe to call often. */
  unlock() {
    try {
      if (!this.ctx || this.ctx.state === "closed") this.build();
      const ctx = this.ctx!;
      const done = () => {
        if (ctx.state !== "running") { this.onState(false); return; }
        const b = ctx.createBuffer(1, 1, ctx.sampleRate);
        const s = ctx.createBufferSource(); s.buffer = b; s.connect(ctx.destination); s.start();
        const nav = navigator as Navigator & { audioSession?: { type: string } };
        if (nav.audioSession && nav.audioSession.type !== "playback") nav.audioSession.type = "playback";
        this.onState(true);
      };
      if (ctx.state !== "running") ctx.resume().then(done, () => this.onState(false));
      else done();
    } catch {
      this.onState(false);
    }
  }

  /** Resume only if a context already exists (e.g. tab became visible again). */
  resumeExisting() {
    const ctx = this.ctx;
    if (!ctx || ctx.state === "closed" || ctx.state === "running") return;
    ctx.resume().then(() => this.onState(ctx.state === "running"), () => {});
  }

  private build() {
    const ctx = new AudioContext();
    const master = ctx.createGain(); master.gain.value = 0.9;
    // a limiter that lets the transients through (fast attack would flatten the "콰")
    const lim = ctx.createDynamicsCompressor();
    lim.threshold.value = -4; lim.ratio.value = 6; lim.knee.value = 4; lim.attack.value = 0.004; lim.release.value = 0.08;
    master.connect(lim); lim.connect(ctx.destination);
    const noise = ctx.createBuffer(1, Math.floor(ctx.sampleRate * 2), ctx.sampleRate);
    const d = noise.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
    this.ctx = ctx; this.master = master; this.noise = noise;
    this.layers.clear();
  }

  dispose() {
    for (const l of this.layers.values()) l.nodes.forEach((n) => { try { (n as AudioScheduledSourceNode).stop?.(); } catch { /* */ } });
    this.layers.clear();
    this.ctx?.close().catch(() => {});
    this.ctx = null;
  }

  private now() { return this.ctx!.currentTime; }

  // ---------- building blocks ----------

  /** A filtered noise burst: ~0.6 ms attack, exponential decay with time constant `tauMs`. */
  private noiseHit(t: number, type: FilterKind, f: number, q: number, peak: number, tauMs: number, durMs: number, out?: AudioNode) {
    const ctx = this.ctx!;
    const src = ctx.createBufferSource(); src.buffer = this.noise;
    const flt = ctx.createBiquadFilter(); flt.type = type; flt.frequency.value = Math.min(16000, Math.max(30, f)); flt.Q.value = q;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(peak, t + 0.0006);
    g.gain.setTargetAtTime(0, t + 0.0006, tauMs / 1000);
    src.connect(flt); flt.connect(g); g.connect(out ?? this.master!);
    src.start(t, Math.random() * 1.8); src.stop(t + durMs / 1000 + 0.01);
  }

  /** A short sine thump with a falling pitch. */
  private thump(t: number, f0: number, f1: number, peak: number, tauMs: number, durMs: number, wave: OscillatorKind = "sine") {
    const ctx = this.ctx!;
    const o = ctx.createOscillator(); o.type = wave;
    o.frequency.setValueAtTime(f0, t); o.frequency.exponentialRampToValueAtTime(Math.max(20, f1), t + durMs / 1000);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(peak, t + 0.002);
    g.gain.setTargetAtTime(0, t + 0.002, tauMs / 1000);
    o.connect(g); g.connect(this.master!); o.start(t); o.stop(t + durMs / 1000 + 0.02);
  }

  /** One crunch hit. `lvl` is linear peak gain, `m` the per-ball pitch, `low` scales the weight. Every tail dies within ~35 ms. */
  private hit(t: number, kind: HitKind, lvl: number, m: number, low: number, sub: boolean) {
    const p = m * U(0.9, 1.12);
    if (kind === "kwa") {
      this.noiseHit(t, "highpass", 2000 * p, 0.7, lvl, 1.2, 6); // the crack itself
      this.noiseHit(t, "bandpass", 1150 * p, 1.0, lvl * 0.95, 11, 60); // crunch body ("콰")
      this.noiseHit(t, "bandpass", 480 * p, 1.3, lvl * 0.55 * low, 9, 45); // lower body: weight without boom
      for (let i = 0, n = 3 + Math.floor(Math.random() * 3); i < n; i++) {
        this.noiseHit(t + U(0.002, 0.018), "highpass", 2600 * p, 0.7, lvl * U(0.22, 0.5), 0.6, 3); // micro-cracks inside the hit
      }
      this.thump(t, 170 * p, 90 * p, lvl * 0.3 * low, 9, 35);
    } else if (kind === "ja") {
      this.noiseHit(t, "highpass", 2300 * p, 0.7, lvl * 0.72, 1.0, 5);
      this.noiseHit(t, "bandpass", 1500 * p, 1.3, lvl * 0.6, 6.5, 32);
      for (let i = 0; i < 2; i++) this.noiseHit(t + U(0.002, 0.012), "highpass", 2800 * p, 0.7, lvl * U(0.2, 0.4), 0.6, 3);
      this.thump(t, 150 * p, 95 * p, lvl * 0.15 * low, 6, 25);
    } else if (kind === "jak") {
      this.noiseHit(t, "highpass", 2600 * p, 0.8, lvl * 0.95, 0.9, 6); // the closing snap ("작")
      this.noiseHit(t, "bandpass", 2000 * p, 1.6, lvl * 0.55, 5, 26);
      this.noiseHit(t, "bandpass", 650 * p, 2.0, lvl * 0.3 * low, 4, 18);
    } else {
      this.noiseHit(t, "highpass", 3200 * p, 0.7, lvl, 0.6, 4);
      this.noiseHit(t, "bandpass", 2300 * p, 2.0, lvl * 0.4, 4, 16);
    }
    // iPhone (no vibration): a short low punch on every hit. Phone speakers cannot play real sub-bass, so it sits at
    // 110–180 Hz with a triangle wave's harmonics (heard as "low" even on a small speaker), and dies before the next hit.
    if (sub && kind !== "tik") this.thump(t, 185, 110, lvl * (kind === "kwa" ? 0.7 : 0.4), 10, 36, "triangle");
  }

  /**
   * One crunch event of `hits` (1–4) hits, e.g. 3 = "콰자작". Returns the hit onsets in ms
   * (empty when audio is locked) so the caller can line haptics up with them.
   */
  crunch(hits: number, levelDb: number, m: number, opts: CrunchOpts = {}): number[] {
    if (!this.running) return [];
    const n = Math.max(1, Math.min(4, Math.round(hits)));
    const t0 = this.now() + 0.005;
    const stretch = U(0.94, 1.1);
    const lvl = db(levelDb), low = opts.sub ? 1.25 : 1;
    const onsets = ONSETS[n - 1].map((ms, i) => (i === 0 ? 0 : ms * stretch + U(-4, 4)));
    const kinds = KINDS[n - 1];
    const gains = { kwa: 1, ja: 0.74, jak: 0.86, tik: 1 } as const;
    for (let i = 0; i < n; i++) this.hit(t0 + onsets[i] / 1000, kinds[i], lvl * gains[kinds[i]] * U(0.9, 1.05), m, low, !!opts.sub);
    if (opts.heavy) {
      // "뽀": the ball giving way under the first hit; short, so the 자-작 that follow stay separate
      this.thump(t0, 140 * m, 70 * m, lvl * 0.45, 13, 55);
      this.noiseHit(t0, "lowpass", 320, 0.8, lvl * 0.4, 9, 40);
    }
    return onsets;
  }

  // ---------- events used by the ball ----------

  /** First crack under the finger: "콰작!" */
  firstSplit(m: number, sub = false) { return this.crunch(2, -5, m, { sub }); }

  /** The big 뽀각: "콰자작!" or "콰자자작!" with the heavy body, loudest event of the toy. */
  pop(m: number, sub = false) { return this.crunch(Math.random() < 0.5 ? 3 : 4, -1.5, m, { heavy: true, sub }); }

  /** Later cracks while the finger keeps pressing: a varied "콰작 / 콰자작 / 콰자자작". Deeper as the shell runs out. */
  burst(stage: 1 | 2 | 3, m: number, sub = false) {
    const r = Math.random();
    const hits = r < 0.34 ? 2 : r < 0.74 ? 3 : 4;
    return this.crunch(hits, [-4, -6, -8][stage - 1], m * [1, 0.92, 0.84][stage - 1], { sub });
  }

  /** A big slab finally giving way. */
  secondaryPop(m: number, sub = false) { return this.crunch(3, -3, m * 0.9, { heavy: true, sub }); }

  /** The crush: the whole shell gives way at once — the deepest "콰자자작!" of the toy. */
  crushed(m: number, sub = false) { return this.crunch(4, -0.5, m * 0.86, { heavy: true, sub }); }

  /** The crushed lump falling apart: a light, quick "사가작". */
  crumble(m: number) { return this.crunch(2, -17, m * 1.2); }

  /** Crunching a loose flake into the clay: a small "오독". */
  flake(m: number, sub = false) { return this.crunch(Math.random() < 0.5 ? 1 : 2, -14, m * 1.15, { sub }); }

  /** How long until a crunch scheduled now is actually heard (scheduling lead + output latency), so haptics can wait for it. */
  hapticDelayMs() {
    const ctx = this.ctx as (AudioContext & { outputLatency?: number }) | null;
    if (!ctx || !this.running) return 0;
    return Math.round((0.005 + (ctx.outputLatency || ctx.baseLatency || 0)) * 1000);
  }

  /** A hairline crack appearing before the shell opens: a tiny, quiet tick. */
  craze(m: number) {
    if (!this.running) return;
    this.hit(this.now() + 0.003, "tik", db(-22), m, 1, false);
  }

  /** Short filtered-noise grain (neck snap 툭, tap 톡, release). */
  tick(f: number, durMs: number, levelDb: number, q = 2) {
    if (!this.running) return;
    const t = this.now();
    this.noiseHit(t, "bandpass", f * U(0.9, 1.1), q, db(levelDb), durMs / 3, durMs);
  }

  /** Wet 쭙 while kneading clay: noise → lowpass → bandpass, plus a low sine. Quiet; only while the finger moves. */
  wetStart(key: string) {
    if (!this.running || this.layers.has(key)) return;
    const ctx = this.ctx!, t = this.now();
    const src = ctx.createBufferSource(); src.buffer = this.noise; src.loop = true;
    const lp = ctx.createBiquadFilter(); lp.type = "lowpass"; lp.frequency.value = 700;
    const bp = ctx.createBiquadFilter(); bp.type = "bandpass"; bp.frequency.value = 380; bp.Q.value = 3.5;
    const o = ctx.createOscillator(); o.type = "sine"; o.frequency.value = 100;
    const og = ctx.createGain(); og.gain.value = 0.5;
    const g = ctx.createGain(); g.gain.setValueAtTime(0, t);
    src.connect(lp); lp.connect(bp); bp.connect(g); o.connect(og); og.connect(g); g.connect(this.master!);
    src.start(t, Math.random()); o.start(t);
    this.layers.set(key, { gain: g, nodes: [src, o], extra: { lp: lp.frequency, bp: bp.frequency, f: o.frequency } });
  }

  wetDrive(key: string, speed: number, strokeT: number) {
    const l = this.layers.get(key); if (!l?.extra) return;
    const t = this.now();
    const u = Math.max(0, Math.min(1, strokeT));
    l.extra.lp.linearRampToValueAtTime(700 - 540 * u, t + 0.06);
    l.extra.bp.linearRampToValueAtTime(380 - 200 * u, t + 0.06);
    l.extra.f.linearRampToValueAtTime(100 - 52 * u, t + 0.06);
    l.gain.gain.linearRampToValueAtTime(speed > 20 ? db(-20) : 0, t + 0.06);
  }

  stopLayer(key: string, fadeMs = 60) {
    const l = this.layers.get(key); if (!l || !this.ctx) return;
    const t = this.now();
    l.gain.gain.cancelScheduledValues(t);
    l.gain.gain.setValueAtTime(l.gain.gain.value, t);
    l.gain.gain.linearRampToValueAtTime(0, t + fadeMs / 1000);
    for (const n of l.nodes) { try { (n as AudioScheduledSourceNode).stop(t + fadeMs / 1000 + 0.02); } catch { /* */ } }
    this.layers.delete(key);
  }

  /** ≤ 80 ms total: one sticky release pop and the kneading layer fades out. */
  release(ballKey: string) {
    if (!this.ctx) return;
    if (this.running) this.tick(300, 40, -18);
    this.stopLayer(ballKey + ":wet");
  }
}
