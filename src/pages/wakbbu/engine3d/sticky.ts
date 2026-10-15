import * as C from "../engine/constants";
import { vibrate } from "../engine/haptics";
import type { Ball3D, Env3D, Press3D } from "./ball3d";
import type { Plate3D } from "./shell";
import type { ThreeNS } from "./three";

/**
 * 끈끈하게 부서짐: while a finger drags over a popped ball, cracked plates just behind it are peeled
 * along as small chips, held to the ball by a short, thick clay neck. The neck thins as it stretches
 * and snaps (툭) within 0.5 R; the chip then stays embedded where it stopped, or (small plates only,
 * within the detach budget) slides off, drops at most 1.5 R and fades. Everything lives in the ball
 * mesh's unit-sphere space, so lengths are in R.
 */

const PULL = 0, EMBED = 1, FALL = 2; // chip states
const RIM = 12; // chip outline vertices
const RINGS = 9, SEGS = 10; // neck tube resolution
const FOLLOW_TAU = 0.045; // s, a chip catching up with its spot behind the finger
const SINK = 0.025; // neck roots sit this far under the surface

type V3 = [number, number, number];

type Chip = {
  plate: Plate3D;
  state: number;
  t: number; // s in the current state
  anchor: V3; // where it was torn out
  dir: V3; // where it sits now
  size: number; thick: number; r0: number; // outline radius, thickness, neck rest radius
  lag: number; lat: number; snapLen: number; stretch: number; // spot behind the finger: lag along the drag, lat beside it
  lift: number; tilt: number; lift0: number; tilt0: number; sink: number;
  mesh: any; tex: any; top: any; side: any;
  neck: Tube | null; stub0: number; stubT: number; pullDir: V3;
  from: V3; spin: V3; // falling
};

const clamp01 = (u: number) => Math.max(0, Math.min(1, u));
const easeOut = (u: number) => 1 - Math.pow(1 - clamp01(u), 3);
const flare = (x: number) => { const k = 1 - Math.min(1, x / 0.45); return k * k; };

/** Unit direction `a` radians from unit `f` toward tangent `t`. */
function turn(f: ArrayLike<number>, t: ArrayLike<number>, a: number): V3 {
  const c = Math.cos(a), s = Math.sin(a);
  const x = f[0] * c + t[0] * s, y = f[1] * c + t[1] * s, z = f[2] * c + t[2] * s;
  const l = Math.hypot(x, y, z) || 1;
  return [x / l, y / l, z / l];
}

/** The chip's spot: `lag` behind the finger along the drag, `lat` to its side. */
function spot(f: ArrayLike<number>, trail: ArrayLike<number>, lag: number, lat: number): V3 {
  const side: V3 = [f[1] * trail[2] - f[2] * trail[1], f[2] * trail[0] - f[0] * trail[2], f[0] * trail[1] - f[1] * trail[0]];
  return turn(turn(f, trail, lag), side, lat);
}

/** Tangent frame (t1, t2) at unit `a`, right-handed with `a` so cut paint is not mirrored. */
function frame(a: ArrayLike<number>, t1: Float32Array, t2: Float32Array) {
  const ux = Math.abs(a[1]) < 0.9 ? 0 : 1, uy = 1 - ux;
  const k = ux * a[0] + uy * a[1];
  let x = ux - a[0] * k, y = uy - a[1] * k, z = -a[2] * k;
  const l = Math.hypot(x, y, z) || 1; x /= l; y /= l; z /= l;
  t1[0] = x; t1[1] = y; t1[2] = z;
  t2[0] = a[1] * z - a[2] * y; t2[1] = a[2] * x - a[0] * z; t2[2] = a[0] * y - a[1] * x;
}

export function makeClayMaterial(T: ThreeNS, color: string = C.CLAY) {
  return new T.MeshStandardMaterial({ color, roughness: 0.9, metalness: 0, transparent: true });
}

/*
 * Normals here are analytic on purpose: running chip or neck geometries through three's shared
 * computeVertexNormals makes that function slower for every ball's deform() (measured ~6 → ~8 ms
 * per step with six balls pressed), so only the balls ever call it.
 */

/** A wax chip: curved top (shell paint, group 0) over clay-coated sides and underside (group 1). +z is its normal. */
function chipGeometry(T: ThreeNS, radii: number[], size: number, thick: number) {
  const M = radii.length;
  const pos: number[] = [], nrm: number[] = [], uv: number[] = [], idx: number[] = [];
  const put = (x: number, y: number, z: number, nx: number, ny: number, nz: number) => {
    const l = Math.hypot(nx, ny, nz);
    pos.push(x, y, z); nrm.push(nx / l, ny / l, nz / l); uv.push(x / (2 * size) + 0.5, 0.5 - y / (2 * size));
    return pos.length / 3 - 1;
  };
  const cap = (r: number) => thick - (r * r) / 2; // follows the unit sphere's curvature, so its normal is (x, y, 1)
  const c0 = put(0, 0, thick, 0, 0, 1);
  const inner: number[] = [], outer: number[] = [], rim: number[] = [], bot: number[] = [];
  for (let k = 0; k < M; k++) {
    const a = (k / M) * Math.PI * 2, cx = Math.cos(a), sy = Math.sin(a), r = radii[k];
    inner.push(put(0.5 * r * cx, 0.5 * r * sy, cap(0.5 * r), 0.5 * r * cx, 0.5 * r * sy, 1));
    outer.push(put(r * cx, r * sy, cap(r), r * cx, r * sy, 1));
  }
  for (let k = 0; k < M; k++) {
    const a = (k / M) * Math.PI * 2, cx = Math.cos(a), sy = Math.sin(a), r = radii[k], rb = 0.85 * r;
    rim.push(put(r * cx, r * sy, cap(r), cx, sy, 0));
    bot.push(put(rb * cx, rb * sy, -0.3 * thick - (rb * rb) / 2, cx, sy, -0.6));
  }
  const b0 = put(0, 0, -0.3 * thick, 0, 0, -1);
  for (let k = 0; k < M; k++) {
    const k1 = (k + 1) % M;
    idx.push(c0, inner[k], inner[k1], inner[k], outer[k], outer[k1], inner[k], outer[k1], inner[k1]);
  }
  const nTop = idx.length;
  for (let k = 0; k < M; k++) {
    const k1 = (k + 1) % M;
    idx.push(rim[k], bot[k], bot[k1], rim[k], bot[k1], rim[k1], b0, bot[k1], bot[k]);
  }
  const g = new T.BufferGeometry();
  g.setAttribute("position", new T.Float32BufferAttribute(pos, 3));
  g.setAttribute("uv", new T.Float32BufferAttribute(uv, 2));
  g.setAttribute("color", new T.Float32BufferAttribute(new Float32Array(pos.length).fill(1), 3)); // the shell material multiplies vertex colours
  g.setAttribute("normal", new T.Float32BufferAttribute(nrm, 3));
  g.setIndex(idx);
  g.addGroup(0, nTop, 0); g.addGroup(nTop, idx.length - nTop, 1);
  return g;
}

const COS = Array.from({ length: SEGS }, (_, j) => Math.cos((j / SEGS) * Math.PI * 2));
const SIN = Array.from({ length: SEGS }, (_, j) => Math.sin((j / SEGS) * Math.PI * 2));

/** A clay tube along the quadratic Bézier a→m→b with closed tips, rewritten every step. */
class Tube {
  mesh: any;
  private pos: Float32Array;
  private nrm: Float32Array;
  private attr: any;
  private nattr: any;

  constructor(T: ThreeNS, mat: any) {
    const n = (2 + RINGS * SEGS) * 3;
    const v = (i: number, j: number) => 2 + i * SEGS + (j % SEGS);
    const idx: number[] = [];
    for (let j = 0; j < SEGS; j++) {
      idx.push(0, v(0, j + 1), v(0, j));
      for (let i = 0; i < RINGS - 1; i++) idx.push(v(i, j), v(i, j + 1), v(i + 1, j + 1), v(i, j), v(i + 1, j + 1), v(i + 1, j));
      idx.push(1, v(RINGS - 1, j), v(RINGS - 1, j + 1));
    }
    const g = new T.BufferGeometry();
    this.attr = new T.Float32BufferAttribute(n, 3).setUsage(T.DynamicDrawUsage);
    this.nattr = new T.Float32BufferAttribute(n, 3).setUsage(T.DynamicDrawUsage);
    this.pos = this.attr.array; this.nrm = this.nattr.array;
    g.setAttribute("position", this.attr); g.setAttribute("normal", this.nattr);
    g.setIndex(idx);
    this.mesh = new T.Mesh(g, mat);
    this.mesh.frustumCulled = false; this.mesh.renderOrder = 1;
  }

  /** `side` must be perpendicular to the curve's plane; radii[i] is ring i's radius at s = i / (RINGS − 1). */
  write(a: Float32Array, m: Float32Array, b: Float32Array, side: Float32Array, radii: Float32Array, tipA: number, tipB: number) {
    const p = this.pos, q = this.nrm;
    const ds = (Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]) || 1e-6) / (RINGS - 1); // ring spacing along the (nearly straight) curve
    for (let i = 0; i < RINGS; i++) {
      const s = i / (RINGS - 1), u = 1 - s;
      const cx = u * u * a[0] + 2 * u * s * m[0] + s * s * b[0];
      const cy = u * u * a[1] + 2 * u * s * m[1] + s * s * b[1];
      const cz = u * u * a[2] + 2 * u * s * m[2] + s * s * b[2];
      let tx = u * (m[0] - a[0]) + s * (b[0] - m[0]), ty = u * (m[1] - a[1]) + s * (b[1] - m[1]), tz = u * (m[2] - a[2]) + s * (b[2] - m[2]);
      const tl = Math.hypot(tx, ty, tz) || 1; tx /= tl; ty /= tl; tz /= tl;
      const nx = ty * side[2] - tz * side[1], ny = tz * side[0] - tx * side[2], nz = tx * side[1] - ty * side[0];
      const r = radii[i];
      // the surface normal leans along the curve where the radius changes (the flared ends)
      const slope = (radii[Math.min(RINGS - 1, i + 1)] - radii[Math.max(0, i - 1)]) / (ds * (i === 0 || i === RINGS - 1 ? 1 : 2));
      const nl = Math.hypot(1, slope);
      for (let j = 0; j < SEGS; j++) {
        const o = (2 + i * SEGS + j) * 3, c = COS[j] * r, sn = SIN[j] * r;
        p[o] = cx + side[0] * c + nx * sn; p[o + 1] = cy + side[1] * c + ny * sn; p[o + 2] = cz + side[2] * c + nz * sn;
        q[o] = (side[0] * COS[j] + nx * SIN[j] - tx * slope) / nl;
        q[o + 1] = (side[1] * COS[j] + ny * SIN[j] - ty * slope) / nl;
        q[o + 2] = (side[2] * COS[j] + nz * SIN[j] - tz * slope) / nl;
      }
      if (i === 0) { p[0] = cx - tx * tipA; p[1] = cy - ty * tipA; p[2] = cz - tz * tipA; q[0] = -tx; q[1] = -ty; q[2] = -tz; }
      if (i === RINGS - 1) { p[3] = cx + tx * tipB; p[4] = cy + ty * tipB; p[5] = cz + tz * tipB; q[3] = tx; q[4] = ty; q[5] = tz; }
    }
    this.attr.needsUpdate = true; this.nattr.needsUpdate = true;
    this.mesh.visible = true;
  }

  dispose() { this.mesh.parent?.remove(this.mesh); this.mesh.geometry.dispose(); }
}

/** Per-ball sticky drag: peels, necks, snaps, embedded and falling chips. */
export class StickyDrag {
  chips: Chip[] = [];
  detached = 0;
  private THREE: ThreeNS;
  private ball: Ball3D;
  private clay: any = null; // matte clay for necks and chip edges; fades with the lump
  private prev: V3 = [0, 0, 1];
  private vel: V3 = [0, 0, 0];
  private speed = 0; // finger speed over the ball, R/s
  private trail: V3 | null = null; // unit tangent pointing behind the finger
  private nextGrabAt = 0;
  private alpha = 1;
  private sA = new Float32Array(3); private nA = new Float32Array(3); private sC = new Float32Array(3); private nC = new Float32Array(3); private back = new Float32Array(3);
  private d1 = new Float32Array(3); private d2 = new Float32Array(3); private p1 = new Float32Array(3);
  private ta = new Float32Array(3); private tm = new Float32Array(3); private tb = new Float32Array(3); private side = new Float32Array(3);
  private radii = new Float32Array(RINGS);
  private q: any; private v: any; private v2: any;

  constructor(THREE: ThreeNS, ball: Ball3D) {
    this.THREE = THREE; this.ball = ball;
    this.q = new THREE.Quaternion(); this.v = new THREE.Vector3(); this.v2 = new THREE.Vector3();
  }

  /** Something still moves: a neck stretching or retracting, a chip settling or falling. Keeps the ball awake. */
  get busy() { return this.chips.some((c) => c.state !== EMBED || c.neck !== null); }

  begin(dir: ArrayLike<number>) {
    this.prev = [dir[0], dir[1], dir[2]]; this.vel = [0, 0, 0]; this.speed = 0; this.trail = null;
  }

  step(dt: number, now: number, env: Env3D) {
    const b = this.ball, p = b.press;
    if (p && p.isDrag && dt > 0) this.track(p.dir, dt);
    if (p && p.isDrag && this.trail && this.speed > C.NECK_V_MIN && b.popped && b.stage >= 3 && !b.fading && now >= this.nextGrabAt) this.grab(p, now);
    for (let i = this.chips.length - 1; i >= 0; i--) {
      const c = this.chips[i];
      c.t += dt;
      if (c.state === PULL && (!p || this.pull(c, p, dt))) this.snap(c, env, true);
      if (c.state === EMBED) this.embed(c);
      else if (c.state === FALL && this.fall(c, dt)) { this.remove(c); this.chips.splice(i, 1); continue; }
      if (c.neck && c.state !== PULL) this.stub(c, dt);
    }
  }

  /** Finger lifted: every stretched neck lets go at once, with a single 툭. */
  release(env: Env3D) {
    let loud = false;
    for (const c of this.chips) if (c.state === PULL) { if (c.stretch > 0.08) loud = true; this.snap(c, env, false); }
    if (loud) { env.audio.tick(600 + 300 * this.ball.rng(), 30, -14); vibrate(4); }
  }

  setOpacity(a: number) {
    this.alpha = a;
    if (this.clay) this.clay.opacity = a;
    for (const c of this.chips) if (c.state !== FALL) c.top.opacity = a;
  }

  dispose() {
    for (const c of this.chips) this.remove(c);
    this.chips = [];
    this.clay?.dispose();
  }

  private track(f: V3, dt: number) {
    const pv = this.prev, v = this.vel;
    for (let k = 0; k < 3; k++) { v[k] += ((f[k] - pv[k]) / dt - v[k]) * 0.3; pv[k] = f[k]; }
    const along = v[0] * f[0] + v[1] * f[1] + v[2] * f[2];
    const tx = v[0] - f[0] * along, ty = v[1] - f[1] * along, tz = v[2] - f[2] * along;
    this.speed = Math.hypot(tx, ty, tz);
    if (this.speed > C.NECK_V_MIN) this.trail = [-tx / this.speed, -ty / this.speed, -tz / this.speed];
  }

  private grab(p: Press3D, now: number) {
    const b = this.ball, rng = b.rng;
    let pulling = 0;
    for (const c of this.chips) if (c.state === PULL) pulling++;
    if (pulling >= C.NECK_MAX_ACTIVE || this.chips.length >= C.CHIP_MAX) return;
    const lag = C.NECK_LAG_MIN + (C.NECK_LAG_MAX - C.NECK_LAG_MIN) * rng();
    const lat = (rng() < 0.5 ? -1 : 1) * (0.03 + 0.1 * rng());
    for (const c of this.chips) if (c.state === PULL && Math.hypot(c.lag - lag, c.lat - lat) < 0.16) return; // two chips never share a spot
    const A = spot(p.dir, this.trail!, lag + 0.06, lat); // just behind the chip's spot, so the neck only ever stretches
    if (A[2] < 0.2) return;
    const plate = b.shell.plateAt(A[0], A[1], A[2]);
    if (!plate || !plate.cracked || plate.pulled) return;
    for (const c of this.chips) if (c.anchor[0] * A[0] + c.anchor[1] * A[1] + c.anchor[2] * A[2] > Math.cos(0.2)) return;
    this.nextGrabAt = now + C.NECK_GRAB_MS * (1 + 0.6 * rng());
    this.chips.push(this.makeChip(plate, A, lag, lat));
  }

  private makeChip(plate: Plate3D, A: V3, lag: number, lat: number): Chip {
    const T = this.THREE, b = this.ball, rng = b.rng;
    if (!this.clay) { this.clay = makeClayMaterial(T, b.variant.core); this.clay.opacity = this.alpha; }
    const size = [0.11, 0.135, 0.16][plate.cls] * (0.9 + 0.2 * rng()), thick = 0.035;
    const radii: number[] = []; // jagged: every other vertex bites in
    for (let k = 0; k < RIM; k++) radii.push(size * (k & 1 ? 0.6 + 0.25 * rng() : 0.82 + 0.18 * rng()));
    const t1 = this.d1, t2 = this.d2;
    frame(A, t1, t2);
    const tex = new T.CanvasTexture(b.peelPlate(plate.id, A, t1, t2, size, radii));
    // the ball's own shader program (no compile mid-drag), with the chip's paint and cracks switched off
    const top = b.makeChipMaterial(tex); top.opacity = this.alpha;
    const mesh = new T.Mesh(chipGeometry(T, radii, size, thick), [top, this.clay]);
    mesh.frustumCulled = false; mesh.renderOrder = 1; mesh.visible = false;
    b.mesh.add(mesh);
    const neck = new Tube(T, this.clay); neck.mesh.visible = false;
    b.mesh.add(neck.mesh);
    const sp = rng() * Math.PI * 2;
    return {
      plate, state: PULL, t: 0, anchor: A, dir: [A[0], A[1], A[2]],
      size, thick, r0: Math.max(0.05, Math.min(0.08, size * 0.5)),
      lag, lat, snapLen: C.NECK_SNAP_MIN + (C.NECK_SNAP_MAX - C.NECK_SNAP_MIN) * rng(), stretch: 0,
      lift: 0.015, tilt: 0, lift0: 0, tilt0: 0, sink: -(0.35 + 0.25 * rng()) * thick, // varied, so overlapping chips never z-fight
      mesh, tex, top, side: this.clay,
      neck, stub0: 0, stubT: 0, pullDir: [0, 0, 0],
      from: [0, 0, 0], spin: [Math.cos(sp), Math.sin(sp), 0.4],
    };
  }

  /** Drags a chip toward its spot behind the finger; true once its neck has stretched to breaking. */
  private pull(c: Chip, p: Press3D, dt: number) {
    const b = this.ball;
    if (this.trail) {
      const g = spot(p.dir, this.trail, c.lag, c.lat), k = 1 - Math.exp(-dt / FOLLOW_TAU), d = c.dir;
      const x = d[0] + (g[0] - d[0]) * k, y = d[1] + (g[1] - d[1]) * k, z = d[2] + (g[2] - d[2]) * k;
      const l = Math.hypot(x, y, z) || 1;
      d[0] = x / l; d[1] = y / l; d[2] = z / l;
    }
    const sA = this.anchorAt(c), sC = b.surfaceFrame(c.dir, this.sC, this.nC);
    c.stretch = Math.hypot(sC[0] - sA[0], sC[1] - sA[1], sC[2] - sA[2]);
    if (c.stretch >= Math.min(c.snapLen, C.NECK_SNAP_MAX)) return true;
    const u = c.stretch / c.snapLen;
    c.lift = 0.015 + 0.04 * u; c.tilt = 0.4 * u;
    this.place(c);
    this.drawNeck(c, u);
    return false;
  }

  /** The neck's root on its plate (Ball3D.plateAnchor) into sA/nA. */
  private anchorAt(c: Chip) {
    this.ball.plateAnchor(c.plate.id, c.anchor, this.sA, this.nA);
    return this.sA;
  }

  /** Seats the chip at sC with normal nC (surfaceFrame of c.dir), its edge toward the anchor sA raised by c.tilt; sets back. */
  private place(c: Chip) {
    const sA = this.sA, sC = this.sC, n = this.nC;
    // tangent pointing back at the anchor
    let wx = sA[0] - sC[0], wy = sA[1] - sC[1], wz = sA[2] - sC[2];
    const wn = wx * n[0] + wy * n[1] + wz * n[2];
    wx -= n[0] * wn; wy -= n[1] * wn; wz -= n[2] * wn;
    const l = Math.hypot(wx, wy, wz);
    if (l < 1e-6) { frame(n, this.d1, this.d2); wx = this.d1[0]; wy = this.d1[1]; wz = this.d1[2]; } else { wx /= l; wy /= l; wz /= l; }
    const m = c.mesh;
    m.quaternion.setFromUnitVectors(this.v.set(0, 0, 1), this.v2.set(n[0], n[1], n[2]));
    if (c.tilt) m.quaternion.premultiply(this.q.setFromAxisAngle(this.v.set(n[1] * wz - n[2] * wy, n[2] * wx - n[0] * wz, n[0] * wy - n[1] * wx).normalize(), -c.tilt));
    m.position.set(sC[0] + n[0] * c.lift, sC[1] + n[1] * c.lift, sC[2] + n[2] * c.lift);
    m.visible = true;
    const ct = Math.cos(c.tilt) * c.size * 0.55, st = Math.sin(c.tilt) * c.size * 0.55 + c.thick * 0.3;
    this.back[0] = m.position.x + wx * ct + n[0] * st; this.back[1] = m.position.y + wy * ct + n[1] * st; this.back[2] = m.position.z + wz * ct + n[2] * st;
  }

  /** The neck: rooted in the hole (sA/nA), arching up to the chip's raised back edge, its waist thinning with stretch u (0..1). */
  private drawNeck(c: Chip, u: number) {
    const nA = this.nA, n = this.nC, a = this.ta, m = this.tm, B = this.back, side = this.side;
    for (let k = 0; k < 3; k++) a[k] = this.sA[k] - nA[k] * SINK;
    const dx = B[0] - a[0], dy = B[1] - a[1], dz = B[2] - a[2], L = Math.hypot(dx, dy, dz);
    if (L < 1e-4) { c.neck!.mesh.visible = false; return; }
    let ux = nA[0] + n[0], uy = nA[1] + n[1], uz = nA[2] + n[2];
    let l = Math.hypot(ux, uy, uz) || 1; ux /= l; uy /= l; uz /= l;
    const h = 0.03 + 0.12 * L;
    m[0] = (a[0] + B[0]) / 2 + ux * h; m[1] = (a[1] + B[1]) / 2 + uy * h; m[2] = (a[2] + B[2]) / 2 + uz * h;
    side[0] = dy * uz - dz * uy; side[1] = dz * ux - dx * uz; side[2] = dx * uy - dy * ux;
    l = Math.hypot(side[0], side[1], side[2]);
    if (l < 1e-6) { c.neck!.mesh.visible = false; return; }
    side[0] /= l; side[1] /= l; side[2] /= l;
    const r0 = c.r0, rw = r0 * (1 - (1 - C.NECK_WAIST_MIN) * Math.pow(u, 1.6)), rA = r0 * 1.4, rB = r0 * 1.1;
    for (let i = 0; i < RINGS; i++) { const s = i / (RINGS - 1); this.radii[i] = rw + (rA - rw) * flare(s) + (rB - rw) * flare(1 - s); }
    c.neck!.write(a, m, B, side, this.radii, rA * 0.6, rB * 0.4);
  }

  /**
   * The neck lets go. The chip embeds where it stopped; a neck that tore under stretch (`torn`, 툭) may
   * instead drop a small chip, within the detach budget. A lifted finger only lets go, so nothing falls.
   */
  private snap(c: Chip, env: Env3D, torn: boolean) {
    const b = this.ball, rng = b.rng;
    const drop = torn && c.plate.cls === 0 && this.detached < Math.floor(b.shell.plates.length * C.DETACH_BUDGET) && rng() < 0.35;
    c.state = drop ? FALL : EMBED; c.t = 0;
    c.lift0 = c.lift; c.tilt0 = c.tilt;
    if (drop) {
      this.detached++;
      c.from = [c.mesh.position.x, c.mesh.position.y, c.mesh.position.z];
      c.side = this.clay.clone(); c.mesh.material = [c.top, c.side]; // own opacity while it fades
    }
    const A = c.anchor, d = c.dir, k = d[0] * A[0] + d[1] * A[1] + d[2] * A[2];
    let px = d[0] - A[0] * k, py = d[1] - A[1] * k, pz = d[2] - A[2] * k;
    const l = Math.hypot(px, py, pz);
    if (l < 1e-6) { frame(A, this.d1, this.d2); px = this.d1[0]; py = this.d1[1]; pz = this.d1[2]; } else { px /= l; py /= l; pz /= l; }
    c.pullDir = [px, py, pz];
    c.stub0 = Math.min(0.14, 0.05 + 0.3 * c.stretch); c.stubT = 0;
    if (torn) { env.audio.tick(600 + 300 * rng(), 30, -14); vibrate(4); }
  }

  /** Settles a snapped chip into the clay over the retract time, then keeps it riding the deforming surface. */
  private embed(c: Chip) {
    const e = easeOut((c.t * 1000) / C.NECK_RETRACT_MS);
    c.lift = c.lift0 + (c.sink - c.lift0) * e; c.tilt = c.tilt0 * (1 - e);
    this.anchorAt(c); this.ball.surfaceFrame(c.dir, this.sC, this.nC);
    this.place(c);
  }

  /** The snapped neck's root: a small bump that sinks back into the hole over NECK_RETRACT_MS. */
  private stub(c: Chip, dt: number) {
    c.stubT += dt;
    const k = (c.stubT * 1000) / C.NECK_RETRACT_MS;
    if (k >= 1) { c.neck!.dispose(); c.neck = null; return; }
    const e = easeOut(k), len = c.stub0 * (1 - e), w = c.pullDir;
    const sA = this.anchorAt(c), nA = this.nA, a = this.ta, m = this.tm, B = this.tb, side = this.side;
    let dx = nA[0] * 0.8 + w[0] * 0.6, dy = nA[1] * 0.8 + w[1] * 0.6, dz = nA[2] * 0.8 + w[2] * 0.6;
    const l = Math.hypot(dx, dy, dz) || 1; dx /= l; dy /= l; dz /= l;
    for (let i = 0; i < 3; i++) a[i] = sA[i] - nA[i] * SINK;
    B[0] = a[0] + dx * len; B[1] = a[1] + dy * len; B[2] = a[2] + dz * len;
    for (let i = 0; i < 3; i++) m[i] = (a[i] + B[i]) / 2;
    // perpendicular to both the stub and the pull direction (w is tangent, nA near-radial, so d × w ≠ 0)
    side[0] = dy * w[2] - dz * w[1]; side[1] = dz * w[0] - dx * w[2]; side[2] = dx * w[1] - dy * w[0];
    const sl = Math.hypot(side[0], side[1], side[2]) || 1; side[0] /= sl; side[1] /= sl; side[2] /= sl;
    const rS = c.r0 * 1.5 * (1 - 0.4 * e);
    for (let i = 0; i < RINGS; i++) { const s = (i / (RINGS - 1)) * 0.92; this.radii[i] = rS * Math.sqrt(1 - s * s); }
    c.neck!.write(a, m, B, side, this.radii, rS * 0.5, rS * 0.35);
  }

  /** A detached chip slides down the front of the ball and drops (at most CHIP_DROP_MAX) as it fades. True when gone. */
  private fall(c: Chip, dt: number) {
    const k = Math.min(1, (c.t * 1000) / C.CHIP_FADE_MS);
    const x = c.from[0], y = c.from[1] - Math.min(C.CHIP_DROP_MAX, 1.35 * k * k);
    let z = c.from[2];
    const l = Math.hypot(x, y, z) || 1;
    this.p1[0] = x / l; this.p1[1] = y / l; this.p1[2] = z / l;
    const s = this.ball.surfaceAt(this.p1, this.p1), rs = Math.hypot(s[0], s[1], s[2]) + c.thick;
    if (x * x + y * y < rs * rs) z = Math.max(z, Math.sqrt(rs * rs - x * x - y * y));
    c.from[2] = z; // never back into the ball, never pushed further out than its surface
    c.mesh.position.set(x, y, z);
    c.mesh.rotateOnAxis(this.v.set(c.spin[0], c.spin[1], c.spin[2]).normalize(), dt * 2.5);
    const a = (1 - k) * this.alpha;
    c.top.opacity = a; c.side.opacity = a;
    return k >= 1;
  }

  private remove(c: Chip) {
    c.mesh.parent?.remove(c.mesh);
    c.mesh.geometry.dispose(); c.tex.dispose(); c.top.dispose();
    if (c.side !== this.clay) c.side.dispose();
    c.neck?.dispose(); c.neck = null;
  }
}
