import * as C from "../engine/constants";
import { mulberry32, type Rng } from "../engine/rng";
import { vibrateHits, prefersReducedMotion, canVibrate } from "../engine/haptics";
import type { CrushAudio } from "../engine/audio";
import { ShellField, HOLE_W, HOLE_H, type Plate3D } from "./shell";
import { FIELD_W, FIELD_H, dirToField, type FieldResult } from "./plateField";
import { crackOnBeforeCompile, makeCrackUniforms, type CrackUniforms, type makeDummyTextures } from "./crackShader";
import { StickyDrag } from "./sticky";
import type { FieldTicket } from "./fieldPool";
import type { ThreeNS } from "./three";

export type Press3D = {
  pointerId: number;
  type: string;
  pressure: number;
  x: number; y: number; sx: number; sy: number; lastX: number; lastY: number;
  downAt: number; moved: number; isDrag: boolean; speed: number; lastMoveAt: number;
  dir: [number, number, number];
  crazeAt: number[]; crazeSpawned: number; nextBurstAt: number; nextFlakeAt: number;
  /** crack events this press (the first crack, a spreading crack, bursts): each press only breaks so much */
  cracks: number;
  /** the press has lasted HOLD_CRACK_MS and counts toward the ball's presses (a quick tap does not) */
  counted: boolean;
};

export type Env3D = {
  audio: CrushAudio;
  pxToWorld: number;
  shake: (px: number, ms: number) => void;
  spawnCrumbs: (b: Ball3D, dir: [number, number, number], n: number) => void;
  onCrushed: (b: Ball3D) => void;
};

/** Textures and data every ball shares. */
export type SharedGeo = {
  template: any;
  dirs: Float32Array;
  /** crack-field texel of each template vertex */
  field: Int32Array;
  nv: number;
  dummies: ReturnType<typeof makeDummyTextures>;
  /** wax micro-detail normal map (a flat placeholder until the background thread delivers it) */
  detail: any;
  segW: number;
  segH: number;
};

// crack widths: half-width of the clay gap, in crack-field texels (π/512 rad each)
const GAP_FIRST = 1.25, GAP_POP = 1.9, GAP_BURST = 1.9, GAP_MAX = 3.2, GAP_FLAKE_MAX = 3.8;
/** an open crack sits this much (fraction of R) below the shell: the wax has thickness, the outline gets a notch, never a bump */
const CLAY_SINK = 0.012;

export function buildSharedGeo(THREE: ThreeNS, dummies: ReturnType<typeof makeDummyTextures>, detail: any, seg: [number, number] = [96, 64]): SharedGeo {
  const [SEG_W, SEG_H] = seg;
  const template = new THREE.SphereGeometry(1, SEG_W, SEG_H);
  const pos = template.attributes.position.array as Float32Array;
  const nv = pos.length / 3;
  const dirs = new Float32Array(nv * 3);
  const field = new Int32Array(nv);
  for (let v = 0; v < nv; v++) {
    const x = pos[v * 3], y = pos[v * 3 + 1], z = pos[v * 3 + 2];
    const l = Math.hypot(x, y, z) || 1;
    dirs[v * 3] = x / l; dirs[v * 3 + 1] = y / l; dirs[v * 3 + 2] = z / l;
    field[v] = dirToField(x / l, y / l, z / l);
  }
  // the u = 1 seam column and each pole row duplicate vertices: give every twin the same texel, so clay ooze never tears them apart
  for (let iy = 0; iy <= SEG_H; iy++) {
    const row = iy * (SEG_W + 1);
    field[row + SEG_W] = field[row];
    if (iy === 0 || iy === SEG_H) for (let ix = 1; ix < SEG_W; ix++) field[row + ix] = field[row];
  }
  return { template, dirs, field, nv, dummies, detail, segW: SEG_W, segH: SEG_H };
}

const easeOut = (u: number) => 1 - Math.pow(1 - Math.max(0, Math.min(1, u)), 3);
const easeOutBack = (u: number) => { const c1 = 0.6, c3 = c1 + 1, x = Math.max(0, Math.min(1, u)) - 1; return 1 + c3 * x * x * x + c1 * x * x; };
const angle = (a: ArrayLike<number>, b: ArrayLike<number>) => Math.acos(Math.max(-1, Math.min(1, a[0] * b[0] + a[1] * b[1] + a[2] * b[2])));

export class Ball3D {
  seed: number;
  rng: Rng;
  variant: C.ShellVariant;
  pitchMul: number;
  R: number; // world units
  x = 0; y = 0; vx = 0; vy = 0;
  mesh: any;
  material: any;
  shell: ShellField;
  private texColor: any;
  private texIds: any = null; private texDist: any = null; private texState: any; private texHole: any = null;
  private crack: CrackUniforms;
  restR: Float32Array;
  /** per vertex: how much open crack / hole is around it (0..1, smoothed so the outline never jags) */
  clay: Float32Array;
  private clayRaw: Float32Array;
  /** projected radius of the rest shape in the screen plane, in R (≥ 1 once squashed flat) */
  extent = 1;
  sleeping = true;
  settle = 0;
  fieldTicket: FieldTicket | null = null;
  // beats
  press: Press3D | null = null;
  stage: 0 | 1 | 2 | 3 | 4 | 5 = 0;
  popped = false; popT = 0;
  /** presses on this ball so far (taps shorter than HOLD_CRACK_MS do not count): the break advances with them */
  pressCount = 0; lastReleaseAt = -1e9;
  private crackK = 0; private popK = 0; // the press that opened the first crack / popped the shell
  D = 0; Dt = 0; sigma = C.SIGMA_SHELL; sPar = 1; sParT = 1; sPerp = 1; bakedS = 1;
  dent: [number, number, number] = [0, 0, 1];
  sq: [number, number, number] = [0, 0, 1];
  ooze = 0;
  timeScale = 1; slowMoUntil = 0; punchT = 0;
  alpha = 1; fading = false; fadeT = 0; crushedAt = 0;
  /** the crushed lump's extra lumps (per vertex, fraction of R), worked out at spawn so the crush itself is cheap */
  private crushBump: Float32Array;
  morphT = 1; // 0 → 1 while the lump settles into its crushed shape
  /** the ball that replaces this one, built at idle time while the crushed lump is still on show */
  successor: Ball3D | null = null;
  disposed = false;
  pace: C.Pace;
  spawnT = 1; spawnFromY = 0; spawnToY = 0;
  crackedCount = 0;
  crackAt = 0; // when the first crack opened (the pop waits a beat after it)
  sticky: StickyDrag;
  private fp1 = new Float32Array(3); private fp2 = new Float32Array(3); // surfaceFrame scratch

  private THREE: ThreeNS;
  private geo: SharedGeo;
  id: number;

  constructor(THREE: ThreeNS, geo: SharedGeo, id: number, R: number, variant: C.ShellVariant, pace: C.Pace = C.PACE) {
    this.THREE = THREE; this.geo = geo; this.id = id;
    this.seed = Math.floor(Math.random() * 1e9);
    this.rng = mulberry32(this.seed);
    this.variant = variant;
    this.pace = pace;
    this.pitchMul = 0.85 + this.rng() * 0.35;
    this.R = R;
    this.restR = new Float32Array(geo.nv).fill(1);
    this.clay = new Float32Array(geo.nv);
    this.clayRaw = new Float32Array(geo.nv);
    this.crushBump = this.makeCrushBump();
    this.shell = new ShellField(variant, this.rng, pace.seeds);
    this.shell.tau = pace.openTau; this.shell.hairS = pace.hairS;
    const T = THREE;
    this.texColor = new T.CanvasTexture(this.shell.color); this.texColor.colorSpace = T.SRGBColorSpace;
    this.texColor.wrapS = T.RepeatWrapping; this.texColor.anisotropy = 4;
    this.texState = new T.DataTexture(this.shell.state, this.shell.state.length / 4, 1, T.RGBAFormat, T.UnsignedByteType);
    this.texState.needsUpdate = true;
    this.crack = makeCrackUniforms(T, geo.dummies, variant);
    this.crack.uPlateState.value = this.texState;
    this.material = this.makeMaterial(this.texColor, this.crack);
    const g = geo.template.clone();
    g.setAttribute("color", new T.BufferAttribute(new Float32Array(geo.nv * 3).fill(1), 3));
    this.mesh = new T.Mesh(g, this.material);
    this.mesh.scale.setScalar(R);
    this.mesh.frustumCulled = false;
    this.setRadius(R);
    this.sticky = new StickyDrag(THREE, this);
    this.deform();
  }

  /** The shell material. Balls and peeled chips share this exact setup, so they share one compiled program. */
  private makeMaterial(map: any, crack: CrackUniforms) {
    const T = this.THREE;
    const m = new T.MeshPhysicalMaterial({
      map, color: 0xffffff, metalness: 0, roughness: 0.46, clearcoat: 1, clearcoatRoughness: 0.14, envMapIntensity: 1,
      clearcoatNormalMap: this.geo.detail, clearcoatNormalScale: new T.Vector2(0.45, 0.45),
      sheen: 0.25, sheenRoughness: 0.8, sheenColor: new T.Color(this.variant.base),
      transparent: true, // opacity stays 1 until the crushed lump fades; avoids a shader recompile mid-game
    });
    m.vertexColors = true;
    m.crackUniforms = crack;
    m.onBeforeCompile = crackOnBeforeCompile;
    return m;
  }

  /** Material for a peeled chip's top: the ball's program with its own paint and cracks switched off. */
  makeChipMaterial(map: any) {
    map.colorSpace = this.THREE.SRGBColorSpace;
    return this.makeMaterial(map, makeCrackUniforms(this.THREE, this.geo.dummies, this.variant));
  }

  setRadius(R: number) {
    this.R = R;
    this.mesh.scale.setScalar(R * (1 + 0.04 * Math.sin(Math.PI * this.punchT)));
    this.crack.uTexelWorld.value = (R * Math.PI) / FIELD_H; // one crack-field texel in world units
  }

  /** Uploads the paint texture now (idle time), so the ball's first frame on screen uploads nothing big. */
  warm(renderer: any) { renderer.initTexture?.(this.texColor); }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.successor?.dispose(); this.successor = null;
    this.fieldTicket?.cancel();
    this.sticky.dispose();
    this.mesh.geometry.dispose(); this.material.dispose();
    this.texColor.dispose(); this.texState.dispose();
    this.texIds?.dispose(); this.texDist?.dispose(); this.texHole?.dispose();
  }

  /** The background thread delivered this ball's crack field. Runs at idle time; uploads the textures right away. */
  applyField(r: FieldResult, renderer: any) {
    const T = this.THREE;
    this.shell.applyField(r);
    const ids = new T.DataTexture(r.ids, FIELD_W, FIELD_H, T.RGFormat, T.UnsignedByteType);
    ids.magFilter = ids.minFilter = T.NearestFilter; ids.wrapS = T.RepeatWrapping; ids.generateMipmaps = false; ids.needsUpdate = true;
    const dist = new T.DataTexture(r.dist, FIELD_W, FIELD_H, T.RedFormat, T.UnsignedByteType);
    dist.magFilter = dist.minFilter = T.LinearFilter; dist.wrapS = T.RepeatWrapping; dist.generateMipmaps = false; dist.needsUpdate = true;
    renderer.initTexture?.(ids); renderer.initTexture?.(dist);
    this.texIds = ids; this.texDist = dist;
    this.crack.uFieldId.value = ids; this.crack.uFieldDist.value = dist;
    this.crack.uCrackOn.value = 1;
    this.shell.prepareSmall();
    this.refreshClay();
  }

  /** Uploads plate state / holes when they changed and refreshes the per-vertex clay mask (for the ooze). */
  syncShell() {
    const s = this.shell;
    let changed = false;
    if (s.stateDirty) { this.texState.needsUpdate = true; s.stateDirty = false; changed = true; }
    if (s.holeDirty && s.hole) {
      if (!this.texHole) {
        const T = this.THREE;
        this.texHole = new T.DataTexture(s.hole, HOLE_W, HOLE_H, T.RedFormat, T.UnsignedByteType);
        this.texHole.magFilter = this.texHole.minFilter = T.LinearFilter; this.texHole.wrapS = T.RepeatWrapping; this.texHole.generateMipmaps = false;
        this.crack.uHole.value = this.texHole;
      }
      this.texHole.needsUpdate = true; s.holeDirty = false; changed = true;
    }
    if (changed) this.refreshClay();
    this.crack.uOoze.value = this.ooze;
    this.crack.uMud.value = s.mud;
  }

  private refreshClay() {
    const f = this.geo.field, raw = this.clayRaw, out = this.clay;
    for (let v = 0; v < this.geo.nv; v++) raw[v] = this.shell.clayAt(f[v]);
    // 3×3 average over the vertex grid (wrapping around the seam), so a crack sinks the surface smoothly
    const W = this.geo.segW, H = this.geo.segH, row = W + 1;
    for (const [iy, ring] of [[0, 1], [H, H - 1]]) {
      // a pole row is one point: every twin gets the same value (the pole plus its first ring), or the tip pinches
      let sum = 0;
      for (let ix = 0; ix < W; ix++) sum += raw[iy * row + ix] + raw[ring * row + ix];
      out.fill(sum / (2 * W), iy * row, iy * row + row);
    }
    for (let iy = 1; iy < H; iy++) {
      const y0 = (iy - 1) * row, y1 = iy * row, y2 = (iy + 1) * row;
      for (let ix = 0; ix < W; ix++) {
        const xl = ix === 0 ? W - 1 : ix - 1, xr = ix === W - 1 ? 0 : ix + 1;
        out[y1 + ix] = (raw[y0 + xl] + raw[y0 + ix] + raw[y0 + xr] + raw[y1 + xl] + raw[y1 + ix] + raw[y1 + xr] + raw[y2 + xl] + raw[y2 + ix] + raw[y2 + xr]) / 9;
      }
      out[y1 + W] = out[y1];
    }
  }

  /** The crushed shape's lumps, decided at spawn: a few broad bumps (fraction of R per vertex). */
  private makeCrushBump() {
    const nv = this.geo.nv, dirs = this.geo.dirs, out = new Float32Array(nv);
    const bumps = 4 + Math.floor(this.rng() * 4);
    for (let i = 0; i < bumps; i++) {
      const z = this.rng() * 2 - 1, a = this.rng() * Math.PI * 2, r = Math.sqrt(1 - z * z);
      const bx = r * Math.cos(a), by = r * Math.sin(a), amp = 0.04 + 0.04 * this.rng();
      for (let v = 0; v < nv; v++) {
        const d = dirs[v * 3] * bx + dirs[v * 3 + 1] * by + dirs[v * 3 + 2] * z;
        if (d > 0) out[v] += amp * d * d * d;
      }
    }
    return out;
  }

  /** Positions from restR + live dent/squash/bulge; normals recomputed. */
  deform() {
    const geo = this.mesh.geometry, pos = geo.attributes.position.array as Float32Array;
    const col = geo.attributes.color.array as Float32Array;
    const dirs = this.geo.dirs, nv = this.geo.nv;
    const dark = this.stage >= 4 ? 0.45 * Math.min(1, this.D / C.D_CLAY_MAX) : 0.35 * Math.min(1, this.D / C.D_POP);
    const dx = this.dent[0], dy = this.dent[1], dz = this.dent[2];
    const sx = this.sq[0], sy = this.sq[1], sz = this.sq[2];
    const s2 = 2 * this.sigma * this.sigma;
    const D = this.D, sPar = this.sPar, sPerp = this.sPerp;
    for (let v = 0; v < nv; v++) {
      const ax = dirs[v * 3], ay = dirs[v * 3 + 1], az = dirs[v * 3 + 2];
      let r = this.restR[v];
      let shade = 1;
      if (D > 0) {
        const th = Math.acos(Math.max(-1, Math.min(1, ax * dx + ay * dy + az * dz)));
        const g = Math.exp(-(th * th) / s2);
        r *= 1 - D * g;
        shade = 1 - dark * g;
      }
      col[v * 3] = col[v * 3 + 1] = col[v * 3 + 2] = shade;
      if (this.clay[v] > 0) r *= 1 - CLAY_SINK * this.clay[v];
      if (r < 0.45) r = 0.45;
      const px = ax * r, py = ay * r, pz = az * r;
      const along = px * sx + py * sy + pz * sz;
      pos[v * 3] = sx * along * sPar + (px - sx * along) * sPerp;
      pos[v * 3 + 1] = sy * along * sPar + (py - sy * along) * sPerp;
      pos[v * 3 + 2] = sz * along * sPar + (pz - sz * along) * sPerp;
    }
    geo.attributes.position.needsUpdate = true;
    geo.attributes.color.needsUpdate = true;
    geo.computeVertexNormals();
  }

  /** Live silhouette radius in the screen plane, in world units (for walls and spacing). */
  visualRadius() {
    return this.R * this.extent * Math.max(1, this.sPerp) * (1 + 0.04 * Math.sin(Math.PI * Math.min(1, this.punchT)));
  }

  private measureExtent() {
    const dirs = this.geo.dirs;
    let m = 0;
    for (let v = 0; v < this.geo.nv; v++) {
      const r = this.restR[v] * Math.hypot(dirs[v * 3], dirs[v * 3 + 1]);
      if (r > m) m = r;
    }
    this.extent = Math.max(1, m);
  }

  /**
   * The deformed surface point along unit direction `a`, in mesh space: the same maths as deform(),
   * with restR and the clay mask interpolated between the four surrounding vertices so chips slide smoothly.
   */
  surfaceAt(a: ArrayLike<number>, out: Float32Array) {
    const ax = a[0], ay = a[1], az = a[2];
    let phi = Math.atan2(az, -ax); if (phi < 0) phi += Math.PI * 2;
    const SEG_W = this.geo.segW, SEG_H = this.geo.segH;
    const fx = (phi / (Math.PI * 2)) * SEG_W, fy = (Math.acos(Math.max(-1, Math.min(1, ay))) / Math.PI) * SEG_H;
    const ix = Math.min(SEG_W - 1, Math.floor(fx)), iy = Math.min(SEG_H - 1, Math.floor(fy));
    const wx = fx - ix, wy = fy - iy, i00 = iy * (SEG_W + 1) + ix, i10 = i00 + SEG_W + 1;
    const R = this.restR, cl = this.clay, oz = -CLAY_SINK;
    const r00 = R[i00] * (1 + oz * cl[i00]), r01 = R[i00 + 1] * (1 + oz * cl[i00 + 1]);
    const r10 = R[i10] * (1 + oz * cl[i10]), r11 = R[i10 + 1] * (1 + oz * cl[i10 + 1]);
    let r = (r00 + (r01 - r00) * wx) * (1 - wy) + (r10 + (r11 - r10) * wx) * wy;
    if (this.D > 0) {
      const th = Math.acos(Math.max(-1, Math.min(1, ax * this.dent[0] + ay * this.dent[1] + az * this.dent[2])));
      r *= 1 - this.D * Math.exp(-(th * th) / (2 * this.sigma * this.sigma));
    }
    if (r < 0.45) r = 0.45;
    const sx = this.sq[0], sy = this.sq[1], sz = this.sq[2];
    const px = ax * r, py = ay * r, pz = az * r, along = px * sx + py * sy + pz * sz;
    out[0] = sx * along * this.sPar + (px - sx * along) * this.sPerp;
    out[1] = sy * along * this.sPar + (py - sy * along) * this.sPerp;
    out[2] = sz * along * this.sPar + (pz - sz * along) * this.sPerp;
    return out;
  }

  /** surfaceAt plus the outward normal there, by finite differences so it follows the dent and squash. */
  surfaceFrame(a: ArrayLike<number>, pos: Float32Array, nrm: Float32Array) {
    const ax = a[0], ay = a[1], az = a[2];
    this.surfaceAt(a, pos);
    // tangent frame (t1, t2, a) right-handed, so (q1 − pos) × (q2 − pos) points outward
    const ux = Math.abs(ay) < 0.9 ? 0 : 1, uy = 1 - ux, k = ux * ax + uy * ay;
    let t1x = ux - ax * k, t1y = uy - ay * k, t1z = -az * k;
    const tl = Math.hypot(t1x, t1y, t1z) || 1; t1x /= tl; t1y /= tl; t1z /= tl;
    const t2x = ay * t1z - az * t1y, t2y = az * t1x - ax * t1z, t2z = ax * t1y - ay * t1x;
    const e = 0.05, p1 = this.fp1, p2 = this.fp2;
    p1[0] = ax + t1x * e; p1[1] = ay + t1y * e; p1[2] = az + t1z * e;
    p2[0] = ax + t2x * e; p2[1] = ay + t2y * e; p2[2] = az + t2z * e;
    let l = Math.hypot(p1[0], p1[1], p1[2]); p1[0] /= l; p1[1] /= l; p1[2] /= l;
    l = Math.hypot(p2[0], p2[1], p2[2]); p2[0] /= l; p2[1] /= l; p2[2] /= l;
    this.surfaceAt(p1, p1); this.surfaceAt(p2, p2);
    const bx = p1[0] - pos[0], by = p1[1] - pos[1], bz = p1[2] - pos[2], cx = p2[0] - pos[0], cy = p2[1] - pos[1], cz = p2[2] - pos[2];
    nrm[0] = by * cz - bz * cy; nrm[1] = bz * cx - bx * cz; nrm[2] = bx * cy - by * cx;
    l = Math.hypot(nrm[0], nrm[1], nrm[2]);
    if (l < 1e-9 || (nrm[0] * ax + nrm[1] * ay + nrm[2] * az) / l < 0.2) { nrm[0] = ax; nrm[1] = ay; nrm[2] = az; } else { nrm[0] /= l; nrm[1] /= l; nrm[2] /= l; }
    return pos;
  }

  // ---- plate hooks for the sticky necks (sticky.ts reaches plates only through these and plate data) ----

  /**
   * Where a neck roots on plate `plateId` near unit direction `a`: point and outward normal in this mesh's
   * local (unit-radius) space; mesh.localToWorld gives world space.
   */
  plateAnchor(plateId: number, a: ArrayLike<number>, pos: Float32Array, nrm: Float32Array) {
    this.surfaceFrame(a, pos, nrm);
  }

  /**
   * Tears a chip out of plate `plateId` around `a`: outline `radii` (rad, evenly spaced in angle in the
   * t1/t2 frame), half-size `size`. Returns the chip's paint and leaves a clay hole where it was.
   */
  peelPlate(plateId: number, a: ArrayLike<number>, t1: ArrayLike<number>, t2: ArrayLike<number>, size: number, radii: number[]): HTMLCanvasElement {
    const paint = this.shell.cutChip(a, t1, t2, size);
    this.shell.addHole(a, t1, t2, radii);
    this.shell.plates[plateId].pulled = true;
    return paint;
  }

  private crackedFrac() { return this.shell.plates.length ? this.crackedCount / this.shell.plates.length : 0; }

  /** Uncracked plates to break next: near the finger (within `reach` rad) or next to a crack, weak ones first. */
  private candidates(dir: [number, number, number], n: number, reach = 0.55): Plate3D[] {
    const out: { p: Plate3D; s: number }[] = [];
    const plates = this.shell.plates;
    for (const p of plates) {
      if (p.cracked) continue;
      const a = angle(p.dir, dir);
      const nearCracked = plates.some((q) => q.cracked && angle(q.dir, p.dir) < 0.5);
      if (a > reach && !nearCracked) continue;
      out.push({ p, s: (1 - Math.min(a, Math.PI) / Math.PI) / p.thr + 0.2 * this.rng() });
    }
    out.sort((a, b) => b.s - a.s);
    return out.slice(0, n).map((x) => x.p);
  }

  private crackPlate(p: Plate3D, now: number, gap: number, tilt: number) {
    if (this.shell.crack(p, now, gap, tilt, this.rng)) this.crackedCount++;
  }

  private widenAll(amount: number, max: number) {
    for (const p of this.shell.plates) this.shell.widen(p, amount, max);
  }

  private key() { return "b" + this.id; }

  onPointerDown(press: Press3D, now: number, env: Env3D) {
    this.press = press; this.sleeping = false;
    this.fieldTicket?.bump(); // the finger is on this ball: its crack field jumps the queue
    this.dent = [...press.dir];
    const sx = press.dir[0] * 1.6, sy = press.dir[1] * 1.6, sz = press.dir[2] * 0.7;
    const sl = Math.hypot(sx, sy, sz) || 1;
    this.sq = [sx / sl, sy / sl, sz / sl];
    this.D = Math.max(this.D, C.D_PRESS); this.Dt = this.D;
    // hairlines this press: more of them with every press, spread over the hold
    press.crazeAt = []; let t = 60;
    for (let i = 0, n = Math.min(this.pace.crazeMax, 3 + this.pressCount); i < n; i++) { press.crazeAt.push(t); t += 45 + this.rng() * 40; }
    press.crazeSpawned = 0; press.cracks = 0; press.counted = false; press.nextBurstAt = now + 180; press.nextFlakeAt = now + 150;
    this.sticky.begin(press.dir);
    if (this.stage === 4) env.audio.wetStart(this.key() + ":wet");
  }

  private rimPoint(): [number, number, number] {
    // a point around the dent in a random tangent direction, reaching further out with every press
    const d = this.dent;
    const up = Math.abs(d[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0];
    const t1 = [d[1] * up[2] - d[2] * up[1], d[2] * up[0] - d[0] * up[2], d[0] * up[1] - d[1] * up[0]];
    const l = Math.hypot(t1[0], t1[1], t1[2]) || 1; t1[0] /= l; t1[1] /= l; t1[2] /= l;
    const t2 = [d[1] * t1[2] - d[2] * t1[1], d[2] * t1[0] - d[0] * t1[2], d[0] * t1[1] - d[1] * t1[0]];
    const a = this.rng() * Math.PI * 2, r = 0.2 + 0.1 * Math.min(6, this.pressCount) + this.rng() * 0.25;
    const c = Math.cos(r), s = Math.sin(r);
    const o = [d[0] * c + (t1[0] * Math.cos(a) + t2[0] * Math.sin(a)) * s, d[1] * c + (t1[1] * Math.cos(a) + t2[1] * Math.sin(a)) * s, d[2] * c + (t1[2] * Math.cos(a) + t2[2] * Math.sin(a)) * s];
    return [o[0], o[1], o[2]];
  }

  advanceBeats(dt: number, now: number, env: Env3D) {
    const press = this.press, a = env.audio, P = this.pace;
    const cracks = this.shell.ready; // until the background thread is done the ball only dents
    if (press) {
      const hold = now - press.downAt;
      if (!press.counted && hold >= C.HOLD_CRACK_MS) { press.counted = true; this.pressCount++; }
      const k = this.pressCount;
      if (this.stage === 4) a.wetStart(this.key() + ":wet");
      if (press.isDrag) {
        // dent follows the finger (10 %/frame), squash axis stays
        const d = this.dent, p = press.dir;
        d[0] += (p[0] - d[0]) * 0.1; d[1] += (p[1] - d[1]) * 0.1; d[2] += (p[2] - d[2]) * 0.1;
        const l = Math.hypot(d[0], d[1], d[2]) || 1; d[0] /= l; d[1] /= l; d[2] /= l;
      }
      let Dt = this.Dt, sT = this.sParT;
      if (this.stage < 2) { const u = easeOut(hold / 125); Dt = C.D_PRESS + (C.D_RESIST - C.D_PRESS) * u; sT = 1 + (C.S_RESIST - 1) * u; }
      else if (this.stage === 2) { Dt = C.D_CRACK; sT = C.S_CRACK; }
      else if (this.stage === 3 && this.popT < C.POP_MS) {
        this.popT += dt * 1000;
        const u = easeOutBack(this.popT / C.POP_MS);
        const eC = Math.min(1, C.S_CRACK / this.bakedS), eP = Math.min(1, C.S_POP / this.bakedS);
        this.D = C.D_CRACK + (C.D_POP - C.D_CRACK) * u; this.sPar = eC + (eP - eC) * u;
        Dt = this.D; sT = this.sPar * this.bakedS;
      } else if (this.stage === 3) { Dt = Math.max(this.D, C.D_POP); sT = C.S_POP; }
      else { Dt = Math.min(C.D_CLAY_MAX, Math.max(this.D, this.Dt) + C.D_CLAY_RATE * dt); sT = C.S_POP; this.sigma += (C.SIGMA_CLAY - this.sigma) * 0.1; }
      sT = Math.min(1, sT / this.bakedS);
      this.Dt = Dt; this.sParT = sT;
      const kk = 1 - Math.exp(-dt / C.SQUASH_TAU);
      if (!(this.stage === 3 && this.popT < C.POP_MS)) { this.D += (Dt - this.D) * kk; this.sPar += (sT - this.sPar) * kk; }

      // hairlines around the dent, spreading further with every press
      while (cracks && press.crazeSpawned < press.crazeAt.length && hold >= press.crazeAt[press.crazeSpawned]) {
        const rp = this.rimPoint(); this.shell.craze(rp[0], rp[1], rp[2]); press.crazeSpawned++;
        a.craze(this.pitchMul);
        if (this.stage === 0) this.stage = 1;
      }

      // first crack "콰작!": on the second press, or a first press held past crackHoldMs (a short first press only crazes)
      if (cracks && this.stage < 2 && hold >= C.HOLD_CRACK_MS && (k >= P.crackPress || hold >= P.crackHoldMs)) {
        const under = this.shell.plateAt(press.dir[0], press.dir[1], press.dir[2]);
        const list = this.candidates(press.dir, this.rng() < 0.5 ? 1 : 2);
        if (under && !list.includes(under)) list.unshift(under);
        for (const p of list) this.crackPlate(p, now, GAP_FIRST, 0.5);
        this.stage = 2; this.crackAt = now; this.crackK = k; press.cracks++;
        vibrateHits(a.firstSplit(this.pitchMul, !canVibrate), 12, a.hapticDelayMs());
      }

      // presses between the first crack and the pop: the crack spreads by a plate or two ("콰작!")
      if (cracks && this.stage === 2 && !this.popped && k < P.popPress && press.cracks === 0 && hold >= 160 && now - this.crackAt >= 180) {
        const list = this.candidates(press.dir, 1 + Math.floor(this.rng() * 2));
        for (const p of list) this.crackPlate(p, now, GAP_FIRST, 0.5);
        this.widenAll(0.12, GAP_POP);
        press.cracks++;
        if (list.length) vibrateHits(a.firstSplit(this.pitchMul * 1.05, !canVibrate), 10, a.hapticDelayMs());
      }

      // the 뽀각: "콰자작!" / "콰자자작!" — not before popPress, and never on the press that opened the first crack
      if (cracks && !this.popped && this.stage >= 2 && k >= P.popPress && k > this.crackK && hold >= C.HOLD_POP_MS && now - this.crackAt >= 180) {
        this.popped = true; this.stage = 3; this.popT = 0; this.popK = k; press.cracks++;
        const frac = P.popFrac[0] + (P.popFrac[1] - P.popFrac[0]) * this.rng();
        const nTarget = Math.round(this.shell.plates.length * frac);
        for (const p of this.candidates(press.dir, Math.max(1, nTarget - this.crackedCount), 0.95)) this.crackPlate(p, now, GAP_POP, 1);
        this.widenAll(0.3, GAP_MAX); this.ooze = Math.max(this.ooze, 0.6);
        env.spawnCrumbs(this, press.dir, 12 + Math.floor(this.rng() * 7));
        this.timeScale = C.SLOWMO_SCALE; this.slowMoUntil = now + C.SLOWMO_MS; this.punchT = 0.0001;
        if (!prefersReducedMotion()) env.shake(C.SHAKE_PX, C.SHAKE_MS);
        vibrateHits(a.pop(this.pitchMul, !canVibrate), 18, a.hapticDelayMs());
        press.nextBurstAt = now + C.BURST_MIN_MS;
      }

      // later presses crack a few more plates each: "콰작! 콰자작! 콰자자작!" (capped per press, so it takes several)
      const onPop = k === this.popK, burstCap = onPop ? 1 : P.burstsPerPress;
      if (cracks && this.popped && this.stage < 5 && !press.isDrag && this.popT >= C.POP_MS && now >= press.nextBurstAt && press.cracks < burstCap + (onPop ? 1 : 0)) {
        const nPl = P.burstPlates[0] + Math.floor(this.rng() * (P.burstPlates[1] - P.burstPlates[0] + 1));
        const list = this.candidates(press.dir, nPl, 0.8);
        if (list.length) {
          let big = false;
          for (const p of list) { this.crackPlate(p, now, GAP_BURST, 1); if (p.cls === 2) big = true; }
          this.widenAll(0.18, GAP_MAX); this.ooze = Math.min(1, this.ooze + 0.12);
          env.spawnCrumbs(this, press.dir, 3 + Math.floor(this.rng() * 4));
          const frac = this.crackedFrac();
          const hits = big ? a.secondaryPop(this.pitchMul, !canVibrate) : a.burst(frac < 0.5 ? 1 : frac < 0.75 ? 2 : 3, this.pitchMul, !canVibrate);
          vibrateHits(hits, big ? 14 : 10, a.hapticDelayMs());
          if (big) { this.timeScale = 0.5; this.slowMoUntil = Math.max(this.slowMoUntil, now + 100); }
        }
        press.cracks++;
        press.nextBurstAt = now + C.BURST_MIN_MS + this.rng() * (C.BURST_MAX_MS - C.BURST_MIN_MS);
      }

      if (this.stage === 3 && this.popped && this.popT >= C.POP_MS) {
        // clay phase: most of the shell is gone, the crush is one press away, or the finger sits on a well-broken patch
        const under = this.shell.plateAt(press.dir[0], press.dir[1], press.dir[2]);
        const nearCracked = under ? this.shell.plates.filter((q) => q.cracked && q !== under && angle(q.dir, under.dir) < 0.45).length : 0;
        const crushNext = k >= P.crushPress - 1 && k - this.popK >= P.crushPress - P.popPress - 1;
        if (this.crackedFrac() >= C.CLAY_FRACTION || crushNext || (under?.cracked && nearCracked >= 4 && hold > 900)) { this.stage = 4; a.wetStart(this.key() + ":wet"); }
      }
      if (this.stage === 4) {
        const moving = press.isDrag && now - press.lastMoveAt < 60;
        a.wetDrive(this.key() + ":wet", moving ? press.speed : 0, Math.min(1, press.moved / 150));
        const under = this.shell.plateAt(press.dir[0], press.dir[1], press.dir[2]);
        if (under && under.cracked && !under.flaked && now >= press.nextFlakeAt) {
          under.flaked = true; this.shell.widen(under, 1, GAP_FLAKE_MAX);
          env.spawnCrumbs(this, press.dir, 2);
          vibrateHits(a.flake(this.pitchMul, !canVibrate), 6, a.hapticDelayMs()); press.nextFlakeAt = now + 400;
        }
      }
      // the crush needs crushPress presses, the last few after the pop: a ball is never finished in one or two squeezes
      if (this.stage >= 3 && this.stage < 5 && this.popped && this.popT >= C.POP_MS && k >= P.crushPress && k - this.popK >= P.crushPress - P.popPress && hold >= 120) this.crush(now, env);
    } else {
      const kk = 1 - Math.exp(-dt / C.RELEASE_TAU);
      this.D += (0 - this.D) * kk; this.sPar += (1 - this.sPar) * kk;
      if (Math.abs(this.D) < 0.002 && Math.abs(this.sPar - 1) < 0.002 && this.settle++ > 10 && !this.sticky.busy && !this.shell.animating && this.morphT >= 1) { this.D = 0; this.sPar = 1; this.sleeping = true; }
    }
    if (this.morphT < 1) this.stepMorph(dt);
    this.sPerp = 1 + 0.5 * (1 - this.sPar);
    this.shell.step(dt);
    this.sticky.step(dt, now, env);
    if (this.slowMoUntil && now >= this.slowMoUntil) { this.timeScale = 1; this.slowMoUntil = 0; }
    if (this.punchT > 0) { this.punchT += dt / (C.PUNCH_MS / 1000); if (this.punchT >= 1) this.punchT = 0; this.mesh.scale.setScalar(this.R * (1 + 0.04 * Math.sin(Math.PI * Math.min(1, this.punchT)))); }
  }

  /** The lump settling into its precomputed crushed shape, a slice per frame. */
  private stepMorph(dt: number) {
    const e0 = easeOut(this.morphT);
    this.morphT = Math.min(1, this.morphT + (dt * 1000) / this.pace.crushMorphMs);
    const de = easeOut(this.morphT) - e0, shrink = 1 - 0.03 * de, bump = this.crushBump, R = this.restR;
    for (let v = 0; v < this.geo.nv; v++) R[v] = R[v] * shrink + bump[v] * de;
    this.measureExtent();
  }

  private crush(now: number, env: Env3D) {
    this.stage = 5; this.crushedAt = now;
    // the petals open: every plate cracks and parts, more slowly than a crack, so the core shows itself
    for (const p of this.shell.plates) {
      this.crackPlate(p, now, 0, 0.5);
      p.gapTarget = Math.max(p.gapTarget, 4.4 + this.rng() * 0.8); // near-even widths: uneven ones step where three plates meet
    }
    this.shell.tau = this.pace.crushTau;
    this.shell.animating = true;
    this.shell.mud = 0.12; this.ooze = 1;
    this.morphT = 0; // the lumpy shape was worked out at spawn; it eases in over the next frames
    const a = env.audio, dir = this.press?.dir ?? this.dent;
    a.stopLayer(this.key() + ":wet");
    vibrateHits(a.crushed(this.pitchMul, !canVibrate), 22, a.hapticDelayMs());
    env.spawnCrumbs(this, dir, 10 + Math.floor(this.rng() * 6));
    this.punchT = 0.0001;
    if (!prefersReducedMotion()) env.shake(C.SHAKE_PX * 1.4, C.SHAKE_MS * 1.3);
    env.onCrushed(this);
  }

  onPointerUp(now: number, env: Env3D) {
    const press = this.press; if (!press) return;
    const hold = now - press.downAt;
    if (hold < C.HOLD_CRACK_MS && this.stage < 2) env.audio.tick(1500 * this.pitchMul, 20, -18);
    // bake: keep 87 % of the dent and squash as plastic memory (radial approximation of the squash)
    const keep = C.RELEASE_KEEP, dirs = this.geo.dirs, s2 = 2 * this.sigma * this.sigma;
    for (let v = 0; v < this.geo.nv; v++) {
      const ax = dirs[v * 3], ay = dirs[v * 3 + 1], az = dirs[v * 3 + 2];
      const th = Math.acos(Math.max(-1, Math.min(1, ax * this.dent[0] + ay * this.dent[1] + az * this.dent[2])));
      const dentF = 1 - this.D * Math.exp(-(th * th) / s2);
      const along = ax * this.sq[0] + ay * this.sq[1] + az * this.sq[2];
      const perp2 = Math.max(0, 1 - along * along);
      const sqF = Math.sqrt(along * along * this.sPar * this.sPar + perp2 * this.sPerp * this.sPerp);
      this.restR[v] *= 1 + (dentF * sqF - 1) * keep;
      if (this.restR[v] < 0.45) this.restR[v] = 0.45;
    }
    this.measureExtent();
    this.bakedS *= 1 + (this.sPar - 1) * keep;
    this.D *= 1 - keep; this.sPar = 1 + (this.sPar - 1) * (1 - keep); this.Dt = 0; this.sParT = 1;
    this.lastReleaseAt = now; this.press = null; this.settle = 0;
    this.sticky.release(env);
    const a = this.rng() * Math.PI * 2, v = this.rng() * 15 * env.pxToWorld;
    this.vx += Math.cos(a) * v; this.vy += Math.sin(a) * v;
    env.audio.release(this.key());
  }

}
