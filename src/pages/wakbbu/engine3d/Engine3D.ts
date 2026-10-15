import * as C from "../engine/constants";
import { CrushAudio } from "../engine/audio";
import { canVibrate } from "../engine/haptics";
import { loadThree } from "./three";
import { SceneRig } from "./scene";
import { Ball3D, buildSharedGeo, type Env3D, type Press3D, type SharedGeo } from "./ball3d";
import { makeClayMaterial } from "./sticky";
import { makeDummyTextures } from "./crackShader";
import { FieldPool, onIdle } from "./fieldPool";
import { FIELD_W, FIELD_H } from "./plateField";
import { createPost, NO_AO_LAYER, type PostFx, type Quality } from "./post";

export type EngineCallbacks = { onCrushed: (count: number) => void; onAudioState: (running: boolean) => void };
/** "normal": the 왁뿌볼 page (4–6 balls). "king": 왕왁뿌볼, one ball three times the size that breaks more slowly. */
export type EngineMode = "normal" | "king";

/** Phones and tablets (touch-first or narrow) get the light pipeline: no AO / MSAA post-processing. */
const isMobileDevice = () =>
  window.innerWidth < C.MOBILE_WIDTH || (typeof matchMedia === "function" && matchMedia("(pointer: coarse)").matches);

/** Orchestrates the 3D 왁뿌볼 page: balls drifting on the z=0 plane, pointer picking, beats, rendering. */
export class Engine3D {
  private rig: SceneRig | null = null;
  private geo: SharedGeo | null = null;
  private balls: Ball3D[] = [];
  private shadows = new Map<Ball3D, any>();
  private presses = new Map<number, Press3D>();
  private hover = { x: 0, y: 0, active: false };
  private audio = new CrushAudio();
  private fields = new FieldPool();
  private post: PostFx | null = null;
  private quality: Quality = 2;
  private slowFrames = 0;
  private raf = 0;
  private last = 0;
  private acc = 0;
  private shakeT = 0; private shakePx = 0; private shakeMs = 1;
  private crushed = 0;
  private disposed = false;
  private ro: ResizeObserver | null = null;
  private env: Env3D;
  private nextId = 0;
  private lit: Ball3D | null = null;
  private perf = new URLSearchParams(location.search).has("perf");
  physMs = 0; drawMs = 0;
  /** per frame: [rAF time, interval since the previous frame, JS cost of step + render] (last 1800 frames) */
  frameLog: number[][] = [];
  /** duration of each pointerdown handler that hit a ball (ms) */
  downLog: number[] = [];
  /** [time, event] for the crush, the lump starting to fall apart, and the respawn (to line up with frameLog) */
  eventLog: [number, string][] = [];
  private canvas: HTMLCanvasElement;
  private cb: EngineCallbacks;
  private THREE: any = null;
  /** tiny never-disposed meshes, one per shader program (clay, ball, blob shadow): see warmPrograms */
  private keepers: any[] = [];

  private king: boolean;
  private pace: C.Pace;

  constructor(canvas: HTMLCanvasElement, cb: EngineCallbacks, mode: EngineMode = "normal") {
    this.canvas = canvas; this.cb = cb;
    this.king = mode === "king";
    this.pace = this.king ? C.KING_PACE : C.PACE;
    this.audio.onState = (r) => cb.onAudioState(r);
    this.env = {
      audio: this.audio, pxToWorld: 1,
      shake: (px, ms) => {
        // no vibration on iPhone: the pop is felt through a bigger shake (and the sub-bass in the sound)
        const k = canVibrate ? 1 : 3;
        this.shakePx = px * k; this.shakeMs = ms * (canVibrate ? 1 : 1.6); this.shakeT = this.shakeMs;
        if (this.rig) this.rig.flare = 150;
      },
      spawnCrumbs: (b, dir, n) => this.rig?.spawnCrumbs(b.x, b.y, 0, dir[0], dir[1], dir[2], b.R, b.variant.base, n),
      onCrushed: (b) => { cb.onCrushed(++this.crushed); this.logEvent(performance.now(), "crush"); this.prepareSuccessor(b); },
    };
  }

  async init() {
    const { THREE, RoomEnvironment } = await loadThree();
    if (this.disposed) return;
    this.THREE = THREE;
    this.rig = new SceneRig(THREE, RoomEnvironment, this.canvas);
    const flat = new THREE.DataTexture(new Uint8Array([128, 128, 255, 255]), 1, 1, THREE.RGBAFormat, THREE.UnsignedByteType);
    flat.needsUpdate = true;
    this.geo = buildSharedGeo(THREE, makeDummyTextures(THREE), flat, this.pace.seg);
    this.resize();
    this.spawnAll();
    this.warmPrograms();
    this.attach();
    this.loadDetail();
    if (!isMobileDevice()) this.startPost();
    this.last = performance.now();
    this.raf = requestAnimationFrame(this.frame);
  }

  unlockAudio() { this.audio.unlock(); }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    cancelAnimationFrame(this.raf);
    this.ro?.disconnect();
    window.removeEventListener("resize", this.onResize);
    window.removeEventListener("blur", this.releaseAll);
    document.removeEventListener("visibilitychange", this.onVisibility);
    const c = this.canvas;
    c.removeEventListener("pointerdown", this.onDown); c.removeEventListener("pointermove", this.onMove);
    c.removeEventListener("pointerup", this.onUp); c.removeEventListener("pointercancel", this.onUp); c.removeEventListener("lostpointercapture", this.onUp);
    c.removeEventListener("contextmenu", this.onContextMenu); c.removeEventListener("pointerleave", this.onLeave);
    this.fields.dispose();
    for (const b of this.balls) b.dispose();
    for (const s of this.shadows.values()) this.rig?.dropShadow(s);
    for (const k of this.keepers) { k.geometry.dispose(); k.material.map?.dispose(); k.material.dispose(); }
    this.post?.dispose();
    this.rig?.dispose();
    this.audio.dispose();
  }

  // ---------- world ----------
  private get w() { return this.rig!.w; }
  private get h() { return this.rig!.h; }
  private get mobile() { return this.w < C.MOBILE_WIDTH; }
  /** world y of the floor: the strip above the "뿌순 개수" counter stays clear */
  private get floorY() { return -this.rig!.wH / 2 + (this.mobile ? C.BOTTOM_RESERVE_MOBILE : C.BOTTOM_RESERVE) * this.rig!.pxToWorld; }
  private get ceilY() { return this.rig!.wH / 2 - C.TOP_WALL * this.rig!.pxToWorld; }
  private logEvent(t: number, name: string) { this.eventLog.push([t, name]); if (this.eventLog.length > 90) this.eventLog.splice(0, 30); }
  private baseRadius(w: number, h: number) { return this.king ? C.kingRadius(w, h) : C.ballRadiusBase(w, h); }

  /** Colours come from a shuffled bag, so a set always mixes them (never six grey balls in a row). */
  private bag: C.ShellVariant[] = [];
  private nextVariant(avoid?: C.ShellVariant) {
    if (!this.bag.length) {
      this.bag = C.VARIANTS.slice();
      for (let i = this.bag.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [this.bag[i], this.bag[j]] = [this.bag[j], this.bag[i]]; }
    }
    let k = this.bag.findIndex((v) => v !== avoid);
    if (k < 0) k = 0;
    return this.bag.splice(k, 1)[0];
  }

  /** A new ball, not yet in the scene. Its paint is done here; its crack field is computed in the background. */
  private createBall(variant: C.ShellVariant): Ball3D {
    const rig = this.rig!;
    const Rpx = this.baseRadius(this.w, this.h) * (this.king ? 1 : 0.9 + Math.random() * 0.2);
    const b = new Ball3D(this.THREE, this.geo!, this.nextId++, Rpx * rig.pxToWorld, variant, this.pace);
    b.vx = (Math.random() - 0.5) * 20 * rig.pxToWorld; b.vy = (Math.random() - 0.5) * 20 * rig.pxToWorld;
    // the crack field lands at idle time, never on a touch
    const ticket = this.fields.field(b.shell.seeds);
    b.fieldTicket = ticket;
    ticket.promise.then(
      (r) => onIdle(() => { if (!this.disposed && !b.disposed) { b.applyField(r, rig.renderer); b.fieldTicket = null; } }),
      () => {},
    );
    return b;
  }

  private placeBall(b: Ball3D, x: number, y: number) {
    const rig = this.rig!;
    b.x = x; b.y = y;
    b.mesh.position.set(x, y, 0);
    rig.scene.add(b.mesh);
    this.shadows.set(b, rig.makeShadow());
  }

  private makeBall(slotX: number, slotY: number, avoid?: C.ShellVariant): Ball3D {
    const b = this.createBall(this.nextVariant(avoid));
    this.placeBall(b, slotX, slotY);
    return b;
  }

  /**
   * While the crushed lump is on show, the next ball is built at idle time (paint, texture upload, crack field),
   * so the swap itself costs almost nothing.
   */
  private prepareSuccessor(old: Ball3D) {
    onIdle(() => {
      if (this.disposed || old.disposed || old.successor || !this.rig) return;
      const nb = this.createBall(this.nextVariant(old.variant));
      nb.warm(this.rig.renderer);
      old.successor = nb;
    });
  }

  private spawnAll() {
    const rig = this.rig!;
    const n = this.king ? 1 : C.ballCount(this.w);
    const cols = n > 4 ? 3 : 2, rows = Math.ceil(n / cols);
    const top = this.ceilY, bottom = this.floorY;
    const base = C.ballRadiusBase(this.w, this.h) * rig.pxToWorld;
    for (const b of this.balls) { rig.scene.remove(b.mesh); b.dispose(); }
    for (const s of this.shadows.values()) rig.dropShadow(s);
    this.shadows.clear();
    this.balls = [];
    if (this.king) { this.balls.push(this.makeBall(0, (top + bottom) / 2)); return; }
    for (let i = 0; i < n; i++) {
      const x = -rig.wW / 2 + ((i % cols) + 0.5) * (rig.wW / cols) + (Math.random() - 0.5) * 0.2 * base;
      const y = top - (Math.floor(i / cols) + 0.5) * ((top - bottom) / rows) + (Math.random() - 0.5) * 0.2 * base;
      this.balls.push(this.makeBall(x, y));
    }
  }

  /**
   * Compiles every shader the game will need now and keeps one material per program alive for good.
   * three frees a program when the last material using it is disposed: with a single ball (왕왁뿌볼) every
   * respawn would otherwise recompile the ball and shadow shaders on the spot (~100 ms on a phone).
   * Also covers the sticky-neck clay, so the first neck does not hitch mid-drag.
   */
  private warmPrograms() {
    const rig = this.rig!, T = this.THREE;
    const cv = document.createElement("canvas"); cv.width = cv.height = 1;
    const tiny = (mat: any) => new T.Mesh(new T.PlaneGeometry(0.001, 0.001), mat);
    const shadow = rig.makeShadow(); rig.scene.remove(shadow);
    this.keepers = [
      tiny(makeClayMaterial(T)),
      tiny(this.balls[0].makeChipMaterial(new T.CanvasTexture(cv))), // the ball's own program
      tiny(shadow.material),
    ];
    this.withKeepers(() => rig.renderer.compile(rig.scene, rig.camera));
  }

  /** Runs `fn` with the keeper meshes in the scene (so a compile pass covers their programs too). */
  private withKeepers<T>(fn: () => T): T {
    const scene = this.rig!.scene;
    for (const k of this.keepers) scene.add(k);
    try { return fn(); } finally { for (const k of this.keepers) scene.remove(k); }
  }

  /** The wax micro-detail normal map is generated in the background too, then swapped in (no recompile). */
  private loadDetail() {
    this.fields.detail(11, FIELD_W, FIELD_H).then((data) => onIdle(() => {
      if (this.disposed || !this.geo || !this.rig) return;
      const T = this.THREE;
      const tex = new T.DataTexture(data, FIELD_W, FIELD_H, T.RGBAFormat, T.UnsignedByteType);
      tex.wrapS = T.RepeatWrapping; tex.magFilter = T.LinearFilter; tex.minFilter = T.LinearMipmapLinearFilter;
      tex.generateMipmaps = true; tex.anisotropy = 4; tex.needsUpdate = true;
      this.rig.renderer.initTexture?.(tex);
      const old = this.geo.detail;
      this.geo.detail = tex;
      for (const b of this.balls) { b.material.clearcoatNormalMap = tex; if (b.successor) b.successor.material.clearcoatNormalMap = tex; }
      old.dispose();
    }), () => {});
  }

  private async startPost() {
    const rig = this.rig!, T = this.THREE;
    const post = await createPost(T, rig.renderer, rig.scene, rig.camera, { width: rig.w, height: rig.h, dpr: rig.renderer.getPixelRatio(), quality: 2 });
    if (this.disposed) { post.dispose(); return; }
    post.setSize(rig.w, rig.h, rig.renderer.getPixelRatio()); // the window may have changed while the add-ons loaded
    if (post.ready && post.passes) {
      // Rendering into the post target uses different shader variants (linear, no tone mapping). Compile them all now,
      // the keepers included (so these variants are never freed either), so nothing compiles mid-game once post is on.
      // Only the keepers are compiled here: compileAsync polls its materials until ready and would throw (and never
      // settle) if a ball faded out and was disposed meanwhile. They cover the ball, chip, clay and shadow programs;
      // the idle frame below covers the crumbs.
      const prev = rig.renderer.getRenderTarget();
      rig.renderer.setRenderTarget(post.passes.composer.renderTarget2);
      const group = new T.Group();
      for (const k of this.keepers) group.add(k);
      const compiled = rig.renderer.compileAsync ? rig.renderer.compileAsync(group, rig.camera, rig.scene) : Promise.resolve(rig.renderer.compile(group, rig.camera, rig.scene));
      for (const k of this.keepers) group.remove(k);
      rig.renderer.setRenderTarget(prev);
      await compiled.catch(() => {});
      // one frame through the composer at idle time compiles the AO passes themselves
      await new Promise<void>((r) => onIdle(r));
      if (this.disposed) { post.dispose(); return; }
      post.render();
    }
    this.post = post;
  }

  private respawn(old: Ball3D) {
    const rig = this.rig!;
    const b = old.successor ?? this.createBall(this.nextVariant(old.variant));
    old.successor = null;
    rig.scene.remove(old.mesh); old.dispose();
    const sh = this.shadows.get(old); if (sh) { rig.dropShadow(sh); this.shadows.delete(old); }
    if (this.king) this.placeBall(b, 0, (this.ceilY + this.floorY) / 2);
    else this.placeBall(b, old.x, Math.max(this.floorY + b0(old), Math.min(this.ceilY - b0(old), old.y)));
    b.spawnT = 0; b.spawnToY = b.y; b.spawnFromY = rig.wH / 2 + b.R * 1.2; b.y = b.spawnFromY;
    b.mesh.position.set(b.x, b.y, 0); // this frame may already render it: start above the screen, not at its resting spot
    this.balls[this.balls.indexOf(old)] = b;
    this.logEvent(performance.now(), "respawn");
  }

  private step(dt: number, now: number) {
    const rig = this.rig!;
    const px = rig.pxToWorld;
    if (this.shakeT > 0) this.shakeT -= dt * 1000;
    const balls = this.balls;
    const top = this.ceilY, floor = this.floorY, left = -rig.wW / 2, right = rig.wW / 2;
    const margin = 6 * px;
    for (const b of balls) {
      const bdt = dt * b.timeScale;
      if (b.spawnT < 1) {
        b.spawnT = Math.min(1, b.spawnT + dt * (1000 / C.RESPAWN_MS));
        const u = 1 - Math.pow(1 - b.spawnT, 3);
        b.y = b.spawnFromY + (b.spawnToY - b.spawnFromY) * u;
        b.mesh.position.set(b.x, b.y, 0);
        continue;
      }
      b.vx *= Math.exp(-C.DRAG * bdt); b.vy *= Math.exp(-C.DRAG * bdt);
      if (b.press) { b.vx *= 0.8; b.vy *= 0.8; }
      if (!b.press && this.hover.active) {
        const hx = rig.worldX(this.hover.x), hy = rig.worldY(this.hover.y);
        const dx = b.x - hx, dy = b.y - hy, d = Math.hypot(dx, dy);
        if (d < C.HOVER_RADIUS * b.R && d > 1e-3) { const f = C.HOVER_PUSH * b.R * (1 - d / (C.HOVER_RADIUS * b.R)); b.vx += (dx / d) * f; b.vy += (dy / d) * f; }
      }
      // the 왕왁뿌볼 drifts a little but keeps coming back to the middle
      if (this.king) { b.vx += -b.x * 2 * bdt; b.vy += ((top + floor) / 2 - b.y) * 2 * bdt; }
      // soft walls: a gentle push inward near the edges, then a bounce at the edge itself
      // (a ball wider than the play area, squashed flat, just stays centred on that axis)
      const rv = b.visualRadius() + margin;
      const rvx = Math.min(rv, (right - left) / 2), rvy = Math.min(rv, (top - floor) / 2);
      const softX = 0.35 * rvx, softY = 0.35 * rvy, push = C.WALL_PUSH * b.R;
      if (b.x < left + rvx + softX) b.vx += push * (1 - (b.x - left - rvx) / softX) * bdt;
      if (b.x > right - rvx - softX) b.vx -= push * (1 - (right - rvx - b.x) / softX) * bdt;
      if (b.y > top - rvy - softY) b.vy -= push * (1 - (top - rvy - b.y) / softY) * bdt;
      if (b.y < floor + rvy + softY) b.vy += push * (1 - (b.y - floor - rvy) / softY) * bdt;
      const sp = Math.hypot(b.vx, b.vy), max = C.DRIFT_MAX * px;
      if (sp > max) { b.vx *= max / sp; b.vy *= max / sp; }
      if (!b.press) { b.x += b.vx * bdt; b.y += b.vy * bdt; }
      if (b.x < left + rvx) { b.x = left + rvx; b.vx = Math.abs(b.vx) * C.WALL_REST; }
      if (b.x > right - rvx) { b.x = right - rvx; b.vx = -Math.abs(b.vx) * C.WALL_REST; }
      if (b.y > top - rvy) { b.y = top - rvy; b.vy = -Math.abs(b.vy) * C.WALL_REST; }
      if (b.y < floor + rvy) { b.y = floor + rvy; b.vy = Math.abs(b.vy) * C.WALL_REST; }
    }
    // balls keep their distance: a soft repulsion inside 1.5× contact, and no overlap at all
    for (let i = 0; i < balls.length; i++) for (let j = i + 1; j < balls.length; j++) {
      const a = balls[i], b = balls[j];
      if (a.spawnT < 1 || b.spawnT < 1) continue;
      const ra = a.visualRadius(), rb = b.visualRadius(), rs = ra + rb + margin;
      const dx = b.x - a.x, dy = b.y - a.y, d = Math.hypot(dx, dy) || 1e-3, nx = dx / d, ny = dy / d;
      const range = rs * C.REPEL_RANGE;
      if (d < range) {
        const f = C.REPEL * (a.R + b.R) * Math.pow(1 - d / range, 2) * dt;
        if (!a.press) { a.vx -= nx * f; a.vy -= ny * f; }
        if (!b.press) { b.vx += nx * f; b.vy += ny * f; }
      }
      const ov = rs - d;
      if (ov > 0) {
        const wa = a.press ? 0 : b.press ? 1 : 0.5, wb = 1 - wa;
        if (!a.press || !b.press) { a.x -= nx * ov * wa; a.y -= ny * ov * wa; b.x += nx * ov * wb; b.y += ny * ov * wb; }
      }
    }
    for (const b of balls) {
      const bdt = dt * b.timeScale;
      if (b.press || !b.sleeping || b.shell.animating) { b.advanceBeats(bdt, now, this.env); b.syncShell(); b.deform(); }
      else if (b.shell.stateDirty || b.shell.holeDirty) b.syncShell();
      // the crushed lump stays on show for LUMP_HOLD_MS after the finger lifts, then falls apart and fades
      if (b.stage === 5 && !b.press && !b.fading && now - Math.max(b.crushedAt, b.lastReleaseAt) > C.LUMP_HOLD_MS) {
        b.fading = true;
        // ambient occlusion ignores opacity: take the fading lump out of it so no dark ghost lingers
        b.mesh.traverse((o: any) => o.layers.set(NO_AO_LAYER));
        const v = b.variant;
        rig.spawnFall(b.x, b.y, b.R * b.extent, [v.base, v.base, v.swirl[0], v.core], this.king ? 44 : 22);
        this.audio.crumble(b.pitchMul);
        this.logEvent(now, "fall");
      }
      if (b.fading) {
        b.fadeT = Math.min(1, b.fadeT + dt * (1000 / C.LUMP_FADE_MS));
        const u = b.fadeT;
        b.alpha = 1 - u * u; // holds together a moment as it starts to drop, then goes
        b.material.opacity = b.alpha; b.sticky.setOpacity(b.alpha);
        if (u >= 1) { this.respawn(b); continue; }
        b.mesh.scale.setScalar(b.R * (1 - 0.12 * u));
      }
      b.mesh.position.set(b.x, b.y - (b.fading ? 0.45 * b.R * b.fadeT * b.fadeT : 0), 0);
    }
    // blob contact shadows on the backdrop, away from the key light (upper left), darker while pressed
    for (const b of balls) {
      const sh = this.shadows.get(b); if (!sh) continue;
      const rv = b.visualRadius(), persp = (20 + b.R) / 20;
      sh.position.set(b.x + 0.12 * rv, b.y - 0.2 * rv, -b.R);
      sh.scale.set(2.45 * rv * persp, 2.15 * rv * persp, 1);
      sh.material.opacity = 0.32 * b.alpha * b.alpha * (1 + 0.9 * b.D) * (b.spawnT < 1 ? b.spawnT : 1);
    }
    rig.stepCrumbs(dt, 900 * px);
    rig.stepFlare(dt);
    // the travelling light sits on the pressed ball, else the ball nearest the pointer
    let target: Ball3D | null = null, best = Infinity;
    for (const b of balls) { if (b.press) { target = b; break; } }
    if (!target && this.hover.active) {
      const hx = rig.worldX(this.hover.x), hy = rig.worldY(this.hover.y);
      for (const b of balls) { const d = Math.hypot(b.x - hx, b.y - hy); if (d < best) { best = d; target = b; } }
    }
    if (target) this.lit = target;
    else if (this.lit && !this.balls.includes(this.lit)) this.lit = null;
    if (this.lit) rig.setLightTarget(this.lit.x, this.lit.y, this.lit.R, true);
  }

  private frame = (now: number) => {
    if (this.disposed || !this.rig) return;
    const t0 = performance.now();
    const interval = now - this.last;
    const dtF = Math.max(0, Math.min(interval / 1000, C.ACC_CLAMP)); this.last = now; // the first rAF stamp can predate init
    this.acc += dtF; let steps = 0;
    while (this.acc >= C.DT && steps < C.MAX_STEPS) { this.step(C.DT, now); this.acc -= C.DT; steps++; }
    if (steps === C.MAX_STEPS) this.acc = 0;
    const t1 = performance.now();
    let sx = 0, sy = 0;
    if (this.shakeT > 0) { const u = this.shakeT / this.shakeMs; sx = this.shakePx * Math.sin(u * Math.PI * 8) * u; sy = this.shakePx * Math.cos(u * Math.PI * 8) * u * 0.5; }
    if (this.post?.ready && this.quality > 0) { this.rig.applyShake(sx, sy); this.post.render(); }
    else this.rig.render(sx, sy);
    const t2 = performance.now();
    this.physMs += (t1 - t0 - this.physMs) * 0.1; this.drawMs += (t2 - t1 - this.drawMs) * 0.1;
    this.frameLog.push([now, interval, t2 - t0]);
    if (this.frameLog.length > 1800) this.frameLog.splice(0, this.frameLog.length - 1800);
    this.governPost(interval);
    if (this.perf && (steps & 1)) this.canvas.title = `phys ${this.physMs.toFixed(2)} draw ${this.drawMs.toFixed(2)} q${this.quality}`;
    this.raf = requestAnimationFrame(this.frame);
  };

  /** Post-processing steps down if the PC cannot hold ~60 fps with it (never back up within a session). */
  private governPost(interval: number) {
    if (!this.post?.ready || this.quality === 0) return;
    this.slowFrames = interval > 22 ? this.slowFrames + 1 : Math.max(0, this.slowFrames - 1);
    if (this.slowFrames > 45) {
      this.quality = (this.quality - 1) as Quality;
      this.post.setQuality(this.quality);
      this.slowFrames = 0;
    }
  }

  // ---------- input / lifecycle ----------
  private attach() {
    const c = this.canvas;
    c.addEventListener("contextmenu", this.onContextMenu);
    c.addEventListener("pointerdown", this.onDown);
    c.addEventListener("pointermove", this.onMove);
    c.addEventListener("pointerup", this.onUp);
    c.addEventListener("pointercancel", this.onUp);
    c.addEventListener("lostpointercapture", this.onUp);
    c.addEventListener("pointerleave", this.onLeave);
    window.addEventListener("resize", this.onResize);
    window.addEventListener("blur", this.releaseAll);
    document.addEventListener("visibilitychange", this.onVisibility);
    this.ro = new ResizeObserver(this.onResize);
    if (c.parentElement) this.ro.observe(c.parentElement);
  }
  private onContextMenu = (e: Event) => e.preventDefault();
  private onLeave = () => { this.hover.active = false; };
  private onVisibility = () => { if (document.hidden) this.releaseAll(); else this.audio.resumeExisting(); };
  private onResize = () => {
    // mobile browsers fire resize for toolbar/keyboard changes too; only drop presses when the size really changed
    const rig = this.rig; if (!rig) return;
    const p = this.canvas.parentElement;
    const w = p?.clientWidth || window.innerWidth, h = p?.clientHeight || window.innerHeight;
    if (w === rig.w && h === rig.h) return;
    this.releaseAll(); this.resize();
  };
  private resize() {
    const rig = this.rig; if (!rig) return;
    const p = this.canvas.parentElement;
    const w = p?.clientWidth || window.innerWidth, h = p?.clientHeight || window.innerHeight;
    if (!(w > 0) || !(h > 0)) return; // hidden or collapsed viewport: keep the last valid state
    if (w === rig.w && h === rig.h && this.balls.length) return;
    const oldW = rig.wW, oldH = rig.wH, oldPx = rig.pxToWorld;
    const oldBase = this.baseRadius(rig.w, rig.h);
    rig.resize(w, h);
    this.post?.setSize(w, h, rig.renderer.getPixelRatio());
    this.env.pxToWorld = rig.pxToWorld;
    const k = this.baseRadius(w, h) / oldBase;
    for (const b of this.balls) {
      b.x *= rig.wW / oldW; b.y *= rig.wH / oldH;
      b.spawnToY *= rig.wH / oldH;
      b.setRadius((b.R / oldPx) * k * rig.pxToWorld);
      b.spawnFromY = rig.wH / 2 + b.R * 1.2;
      if (b.successor) b.successor.setRadius((b.successor.R / oldPx) * k * rig.pxToWorld);
    }
  }
  private pick(x: number, y: number): { ball: Ball3D; dir: [number, number, number] } | null {
    const rig = this.rig!;
    const wx = rig.worldX(x), wy = rig.worldY(y);
    let best: Ball3D | null = null, bd = Infinity;
    for (const b of this.balls) {
      if (b.press || b.fading || b.spawnT < 1) continue;
      const d = Math.hypot(b.x - wx, b.y - wy) / b.visualRadius();
      if (d <= 1.05 && d < bd) { bd = d; best = b; }
    }
    if (!best) return null;
    return { ball: best, dir: this.dirOn(best, wx, wy) };
  }
  private dirOn(b: Ball3D, wx: number, wy: number): [number, number, number] {
    const rv = b.visualRadius();
    let dx = (wx - b.x) / rv, dy = (wy - b.y) / rv;
    const r = Math.hypot(dx, dy);
    if (r > 0.98) { dx *= 0.98 / r; dy *= 0.98 / r; }
    const dz = Math.sqrt(Math.max(0, 1 - dx * dx - dy * dy));
    return [dx, dy, dz];
  }
  private pos(e: PointerEvent): [number, number] { const r = this.canvas.getBoundingClientRect(); return [e.clientX - r.left, e.clientY - r.top]; }
  private onDown = (e: PointerEvent) => {
    const t0 = performance.now();
    const [x, y] = this.pos(e);
    this.audio.wanted = true; this.audio.unlock();
    const hit = this.pick(x, y);
    if (!hit) return;
    try { this.canvas.setPointerCapture(e.pointerId); } catch { /* synthetic pointer */ }
    const now = performance.now();
    const press: Press3D = { pointerId: e.pointerId, type: e.pointerType, pressure: e.pointerType === "pen" ? 0.6 + e.pressure : 1, x, y, sx: x, sy: y, lastX: x, lastY: y, downAt: now, moved: 0, isDrag: false, speed: 0, lastMoveAt: now, dir: hit.dir, crazeAt: [], crazeSpawned: 0, nextBurstAt: 0, nextFlakeAt: 0, cracks: 0, counted: false };
    this.presses.set(e.pointerId, press);
    hit.ball.onPointerDown(press, now, this.env);
    e.preventDefault();
    this.downLog.push(performance.now() - t0);
  };
  private onMove = (e: PointerEvent) => {
    const p = this.presses.get(e.pointerId);
    const [x, y] = this.pos(e);
    if (!p) { if (e.pointerType === "mouse") { this.hover.x = x; this.hover.y = y; this.hover.active = true; } return; }
    const b = this.balls.find((bb) => bb.press === p); if (!b) return;
    const dtMs = Math.max(1, e.timeStamp - ((p as any).ts ?? e.timeStamp - 16)); (p as any).ts = e.timeStamp;
    p.speed = Math.hypot(x - p.x, y - p.y) / (dtMs / 1000);
    p.lastMoveAt = performance.now();
    p.lastX = p.x; p.lastY = p.y; p.x = x; p.y = y;
    p.moved = Math.max(p.moved, Math.hypot(x - p.sx, y - p.sy));
    if (p.moved >= C.DRAG_THRESHOLD) p.isDrag = true;
    if (e.pointerType === "pen") p.pressure = 0.6 + e.pressure;
    p.dir = this.dirOn(b, this.rig!.worldX(x), this.rig!.worldY(y));
  };
  private onUp = (e: PointerEvent) => {
    this.audio.unlock();
    const p = this.presses.get(e.pointerId); if (!p) return;
    this.presses.delete(e.pointerId);
    const b = this.balls.find((bb) => bb.press === p);
    if (b) b.onPointerUp(performance.now(), this.env);
  };
  private releaseAll = () => {
    const now = performance.now();
    for (const p of this.presses.values()) { const b = this.balls.find((bb) => bb.press === p); if (b) b.onPointerUp(now, this.env); }
    this.presses.clear();
  };
}

/** Half the visible size of a ball being replaced, used to keep its successor inside the play area. */
function b0(b: Ball3D) { return b.R * 1.05; }
