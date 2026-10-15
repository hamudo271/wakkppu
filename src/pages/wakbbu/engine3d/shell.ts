import type { Rng } from "../engine/rng";
import * as C from "../engine/constants";
import { DIST_SCALE, FIELD_W, FIELD_H, dirToField, fieldDir, makeSeeds, type FieldResult } from "./plateField";

/**
 * The wax shell of one ball.
 * - `color`: the satin wax paint (marble bands, pits), a 1024×512 canvas painted once.
 * - plates: a spherical Voronoi whose per-texel field (owner, neighbour, distance to the border) is
 *   computed off the main thread (plateField.worker.ts) when the ball spawns.
 * - Cracking never repaints anything: the shader reads the field plus a 64×1 plate-state texture
 *   (hairline, gap width, tilt, open) and draws thin anti-aliased cracks with dark clay in the gaps.
 *   A crack event only rewrites 256 bytes.
 * - Peeled chips (sticky drag) leave holes in a small 512×256 mask.
 */

export const PAINT_W = 1024;
export const PAINT_H = 512;
export const HOLE_W = 512;
export const HOLE_H = 256;
export const MAX_PLATES = 64;
/** state texture: G byte = gap half-width in field texels × GAP_SCALE */
export const GAP_SCALE = 32;

export type Plate3D = {
  id: number;
  dir: [number, number, number]; // seed direction
  area: number; // solid angle (sr), known once the field is ready
  cls: 0 | 1 | 2; // small / medium / large slab
  thr: number; // crack resistance: small chips give first, slabs go late
  crazed: boolean; // hairline visible along its border
  hair: number; // hairline fade-in 0..1
  cracked: boolean;
  crackedAt: number;
  tilt: number; // -1..1 shading sign × strength
  gap: number; // half gap width in field texels (eases toward gapTarget)
  gapTarget: number;
  flaked: boolean;
  pulled: boolean; // a chip of it was peeled off by a drag
};

const SMALL_W = 256, SMALL_H = 128;

export class ShellField {
  color: HTMLCanvasElement;
  seeds: Float32Array;
  plates: Plate3D[];
  ready = false;
  ids: Uint8Array | null = null;
  dist: Uint8Array | null = null;
  hole: Uint8Array | null = null;
  holeDirty = false;
  state = new Uint8Array(MAX_PLATES * 4);
  stateDirty = true;
  mud = 0;
  /** a hairline or gap is still easing toward its target */
  animating = false;
  /** crack opening ease (s); the crush switches to a slower one so the petals visibly open */
  tau = 0.06;
  /** hairline fade-in (s) */
  hairS = 0.08;
  private small: Uint8ClampedArray | null = null;

  variant: C.ShellVariant;
  private rng: Rng;

  constructor(variant: C.ShellVariant, rng: Rng, seedCount?: [number, number]) {
    this.variant = variant; this.rng = rng;
    this.color = document.createElement("canvas"); this.color.width = PAINT_W; this.color.height = PAINT_H;
    this.paintBase();
    this.seeds = makeSeeds(rng, seedCount);
    const n = Math.min(MAX_PLATES, this.seeds.length / 3);
    this.plates = [];
    for (let id = 0; id < n; id++) {
      this.plates.push({
        id, dir: [this.seeds[id * 3], this.seeds[id * 3 + 1], this.seeds[id * 3 + 2]], area: 0, cls: 1, thr: 1,
        crazed: false, hair: 0, cracked: false, crackedAt: 0, tilt: 0, gap: 0, gapTarget: 0, flaked: false, pulled: false,
      });
    }
    this.writeState();
  }

  /** Satin wax: base colour, low-contrast marble bands, pits. Painted once (canvas row 0 = north pole). */
  private paintBase() {
    const g = this.color.getContext("2d")!, v = this.variant, rng = this.rng;
    const W = PAINT_W, H = PAINT_H;
    g.fillStyle = v.base; g.fillRect(0, 0, W, H);
    const bands = 3 + Math.floor(rng() * 3);
    g.lineCap = "round";
    // keep the marble away from the texture poles (they map to the top/bottom caps of the ball)
    g.save(); g.beginPath(); g.rect(0, H * 0.2, W, H * 0.6); g.clip();
    for (let i = 0; i < bands; i++) {
      g.strokeStyle = v.swirl[i % 2]; g.globalAlpha = 0.45;
      g.lineWidth = (14 + rng() * 26) * 2;
      g.beginPath();
      const y0 = rng() * H;
      g.moveTo(-80, y0);
      g.bezierCurveTo(W * 0.3, y0 + (rng() - 0.5) * 320, W * 0.6, y0 + (rng() - 0.5) * 320, W + 80, y0 + (rng() - 0.5) * 240);
      g.stroke();
    }
    g.restore();
    g.globalAlpha = 1;
    g.fillStyle = "rgba(0,0,0,0.16)";
    for (let i = 0; i < 70; i++) { g.beginPath(); g.arc(rng() * W, rng() * H, 1 + rng() * 2, 0, Math.PI * 2); g.fill(); }
  }

  /** A small CPU copy of the paint for peeled chips. Cheap, but it reads the canvas back, so it runs at idle time. */
  prepareSmall() {
    if (this.small) return;
    const cv = document.createElement("canvas"); cv.width = SMALL_W; cv.height = SMALL_H;
    const g = cv.getContext("2d", { willReadFrequently: true })!;
    g.drawImage(this.color, 0, 0, SMALL_W, SMALL_H);
    this.small = g.getImageData(0, 0, SMALL_W, SMALL_H).data;
  }

  /** The background thread finished this ball's crack field. */
  applyField(r: FieldResult) {
    this.ids = r.ids; this.dist = r.dist;
    let tot = 0;
    for (let i = 0; i < this.plates.length; i++) tot += r.area[i] ?? 0;
    const mean = tot / Math.max(1, this.plates.length);
    for (const p of this.plates) {
      p.area = r.area[p.id] ?? 0;
      const rel = p.area / (mean || 1);
      p.cls = rel < 0.55 ? 0 : rel < 1.5 ? 1 : 2;
      p.thr = [0.8, 1, 1.4][p.cls];
    }
    this.ready = true;
  }

  plateAt(x: number, y: number, z: number): Plate3D | null {
    if (!this.ready) return null;
    return this.plates[this.ids![dirToField(x, y, z) * 2]] ?? null;
  }

  /** The neighbour across the nearest border at a direction (for hairlines that follow a real crack line). */
  neighbourAt(x: number, y: number, z: number): Plate3D | null {
    if (!this.ready) return null;
    return this.plates[this.ids![dirToField(x, y, z) * 2 + 1]] ?? null;
  }

  /** 1 where field texel i shows clay (an open gap or a peeled hole), else 0. Matches the shader's rule. */
  clayAt(i: number) {
    if (!this.ready) return 0;
    const pa = this.plates[this.ids![i * 2]], pb = this.plates[this.ids![i * 2 + 1]];
    const gap = Math.max(pa && pa.cracked ? pa.gap : 0, pb && pb.cracked ? pb.gap : 0);
    if (gap > 0 && this.dist![i] / DIST_SCALE < gap) return 1;
    if (this.hole) {
      const x = i % FIELD_W, y = (i / FIELD_W) | 0;
      if (this.hole[((y * HOLE_H / FIELD_H) | 0) * HOLE_W + ((x * HOLE_W / FIELD_W) | 0)] > 128) return 1;
    }
    return 0;
  }

  /** Hairlines around the plate at a direction (and the neighbour sharing the closest border). */
  craze(x: number, y: number, z: number) {
    const p = this.plateAt(x, y, z), q = this.neighbourAt(x, y, z);
    for (const t of [p, q]) if (t && !t.crazed && !t.cracked) { t.crazed = true; this.animating = true; }
  }

  crack(p: Plate3D, now: number, gap: number, tilt: number, rng: Rng) {
    if (p.cracked) return false;
    p.cracked = true; p.crazed = true; p.crackedAt = now;
    p.gapTarget = Math.max(p.gapTarget, gap);
    p.tilt = (rng() < 0.5 ? -1 : 1) * tilt * (0.6 + 0.4 * rng());
    this.animating = true;
    return true;
  }

  widen(p: Plate3D, amount: number, max: number) {
    if (!p.cracked) return;
    p.gapTarget = Math.min(max, Math.max(p.gapTarget, p.gap) + amount);
    this.animating = true;
  }

  /** Eases hairlines and gaps (a crack opens over a few tau, so it reads as spreading). */
  step(dt: number) {
    if (!this.animating) return;
    const k = 1 - Math.exp(-dt / this.tau);
    let moving = false;
    for (const p of this.plates) {
      if (p.crazed && p.hair < 1) { p.hair = Math.min(1, p.hair + dt / this.hairS); moving = true; }
      if (Math.abs(p.gapTarget - p.gap) > 0.01) { p.gap += (p.gapTarget - p.gap) * k; moving = true; } else p.gap = p.gapTarget;
    }
    this.animating = moving;
    this.writeState();
  }

  writeState() {
    const s = this.state;
    for (const p of this.plates) {
      const o = p.id * 4;
      s[o] = Math.round(p.hair * 255);
      s[o + 1] = Math.min(255, Math.round((p.cracked ? p.gap : 0) * GAP_SCALE));
      s[o + 2] = Math.max(0, Math.min(255, Math.round(128 + p.tilt * 100)));
      s[o + 3] = p.cracked ? 255 : 0;
    }
    this.stateDirty = true;
  }

  /**
   * Tears a peeled chip out of the shell: clay inside the jagged outline `radii` (rad, evenly spaced
   * in angle around `a` in the t1/t2 frame), a whitened rim just outside it. Soft-edged mask so the
   * shader anti-aliases the hole edge.
   */
  addHole(a: ArrayLike<number>, t1: ArrayLike<number>, t2: ArrayLike<number>, radii: number[]) {
    const hole = this.hole ?? (this.hole = new Uint8Array(HOLE_W * HOLE_H));
    const M = radii.length, SOFT = 0.03;
    const rMax = Math.max(...radii) + SOFT;
    const c = dirToField(a[0], a[1], a[2], HOLE_W, HOLE_H), cx = c % HOLE_W, cy = (c / HOLE_W) | 0;
    const rows = Math.ceil((rMax / Math.PI) * HOLE_H) + 1;
    const lo = Math.max(0, cy - rows), hi = Math.min(HOLE_H - 1, cy + rows);
    const d = new Float32Array(3);
    for (let y = lo; y <= hi; y++) {
      const st = Math.sin(((y + 0.5) / HOLE_H) * Math.PI);
      const cols = st <= rMax ? HOLE_W / 2 : Math.ceil((rMax / st / (Math.PI * 2)) * HOLE_W) + 1;
      for (let k = -cols; k < cols; k++) {
        const x = (cx + k + HOLE_W * 2) % HOLE_W, i = y * HOLE_W + x;
        fieldDir(x, y, d, HOLE_W, HOLE_H);
        const dn = d[0] * a[0] + d[1] * a[1] + d[2] * a[2];
        if (dn <= 0) continue;
        const u = d[0] * t1[0] + d[1] * t1[1] + d[2] * t1[2], v = d[0] * t2[0] + d[1] * t2[1] + d[2] * t2[2];
        const ang = Math.atan2(Math.hypot(u, v), dn);
        if (ang > rMax) continue;
        let f = (Math.atan2(v, u) / (Math.PI * 2)) * M; if (f < 0) f += M;
        const k0 = Math.floor(f) % M, k1 = (k0 + 1) % M;
        const lim = radii[k0] + (radii[k1] - radii[k0]) * (f - Math.floor(f));
        const val = Math.round(Math.max(0, Math.min(1, 0.5 + (lim - ang) / (2 * SOFT))) * 255);
        if (val > hole[i]) hole[i] = val;
      }
    }
    this.holeDirty = true;
  }

  /** Copies the paint around `a` (t1/t2 frame, half-size s rad) into an n×n canvas for a peeled chip. */
  cutChip(a: ArrayLike<number>, t1: ArrayLike<number>, t2: ArrayLike<number>, s: number, n = 32): HTMLCanvasElement {
    this.prepareSmall();
    const cv = document.createElement("canvas"); cv.width = cv.height = n;
    const g = cv.getContext("2d")!, img = g.createImageData(n, n), src = this.small!, dst = img.data;
    for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) {
      const u = ((i + 0.5) / n * 2 - 1) * s, v = ((j + 0.5) / n * 2 - 1) * s;
      const x = a[0] + t1[0] * u + t2[0] * v, y = a[1] + t1[1] * u + t2[1] * v, z = a[2] + t1[2] * u + t2[2] * v;
      const l = Math.hypot(x, y, z) || 1;
      let phi = Math.atan2(z / l, -x / l); if (phi < 0) phi += Math.PI * 2;
      const th = Math.acos(Math.max(-1, Math.min(1, y / l)));
      const sx = Math.min(SMALL_W - 1, Math.floor((phi / (Math.PI * 2)) * SMALL_W)), sy = Math.min(SMALL_H - 1, Math.floor((th / Math.PI) * SMALL_H));
      const si = (sy * SMALL_W + sx) * 4, di = (j * n + i) * 4;
      dst[di] = src[si]; dst[di + 1] = src[si + 1]; dst[di + 2] = src[si + 2]; dst[di + 3] = 255;
    }
    g.putImageData(img, 0, 0);
    return cv;
  }

}

export { FIELD_W, FIELD_H };
