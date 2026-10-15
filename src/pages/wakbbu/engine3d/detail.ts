/**
 * Procedural micro-detail for the 3D 왁뿌볼: normal / roughness maps for the wax shell and the clay
 * core, and small faceted wax shards for the flying crumbs. Pure data — no three.js, no DOM — so it can
 * run anywhere (main thread, worker, Node) and be wrapped in DataTexture / BufferGeometry by the caller.
 *
 * Map layout (all maps):
 *  - Equirect in SphereGeometry's uv: u = column / width (phi, wraps), width = 2 * height.
 *  - Row 0 is uv.v = 0 (the BOTTOM / south pole). That is what `new THREE.DataTexture(data, w, h)`
 *    expects with its default flipY = false, so no flipping is needed. (The canvas maps in shell.ts are
 *    top-row-first because CanvasTexture flips; these are not canvases.)
 *  - Seamless in u (column w-1 continues into column 0). Detail fades out toward both poles.
 *  - Heights are generated on the unit sphere (3D noise sampled at the texel's direction), so features
 *    are round on the ball, not stretched by the equirect projection.
 *
 * Normal maps are tangent-space, OpenGL convention (+Y = +v = toward the north pole), encoded
 * (n * 0.5 + 0.5) * 255 in RGB, A = 255. They assume three's default derivative tangent frame (the ball
 * geometry has no `tangent` attribute): that frame halves u-slopes on a 2:1 map, so x is pre-doubled
 * here and bumps render isotropic. Pass `uvSlopes: false` to heightToNormalMap for geometry with tangents.
 *
 * Suggested wiring (three r170, ball material in ball3d.ts):
 *  - waxNormalMap → material.clearcoatNormalMap (clearcoatNormalScale ≈ (1, 1)). Do NOT use it as
 *    `normalMap` on that material: in r170 normalMap and bumpMap are mutually exclusive (#elif in
 *    normal_fragment_maps), so it would switch off the painted crack grooves. The orange peel lives in the
 *    clearcoat highlight anyway, and clearcoatMap (R of the shell mask) already hides it over clay.
 *  - roughnessVariation → material.clearcoatRoughnessMap (reads G) with
 *    clearcoatRoughness = base * ROUGHNESS_GAIN (the map averages 1 / ROUGHNESS_GAIN).
 *  - clayNormalMap → normalMap of the clay / crushed-lump material (one without a bumpMap).
 *  - Textures: wrapS = RepeatWrapping, magFilter = LinearFilter, minFilter = LinearMipmapLinearFilter,
 *    generateMipmaps = true, anisotropy 4, needsUpdate = true; leave colorSpace at NoColorSpace.
 *  - shardVariants(k, seed) → k BufferGeometries (position, normal, setIndex) for k InstancedMeshes,
 *    a drop-in for scene.ts's BoxGeometry(1, 1, 0.35) crumbs (same ~1 unit footprint, origin at centre).
 */

const TAU = Math.PI * 2;

// ---------------------------------------------------------------------------------------------
// deterministic randomness

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Mixes a user seed with a salt so each layer gets an independent stream. */
function subSeed(seed: number, salt: number): number {
  let h = Math.imul((seed | 0) ^ Math.imul(salt | 0, 0x9e3779b1), 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;
  return h >>> 0;
}

/** Integer hash → [-1, 1). Used for per-texel grain. */
function hashSigned(i: number, seed: number): number {
  let h = Math.imul(i ^ seed, 0x27d4eb2d);
  h ^= h >>> 15;
  h = Math.imul(h, 0x165667b1);
  h ^= h >>> 13;
  return ((h >>> 0) / 2147483648) - 1;
}

// ---------------------------------------------------------------------------------------------
// improved Perlin noise (3D) on a seeded permutation table

function makePerm(seed: number): Uint8Array {
  const rng = mulberry32(seed);
  const p = new Uint8Array(512);
  for (let i = 0; i < 256; i++) p[i] = i;
  for (let i = 255; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    const t = p[i]; p[i] = p[j]; p[j] = t;
  }
  for (let i = 0; i < 256; i++) p[i + 256] = p[i];
  return p;
}

function grad(hash: number, x: number, y: number, z: number): number {
  const h = hash & 15;
  const u = h < 8 ? x : y;
  const v = h < 4 ? y : h === 12 || h === 14 ? x : z;
  return ((h & 1) === 0 ? u : -u) + ((h & 2) === 0 ? v : -v);
}

/** Roughly in [-1, 1], std ≈ 0.2. */
function perlin3(p: Uint8Array, x: number, y: number, z: number): number {
  const fx = Math.floor(x), fy = Math.floor(y), fz = Math.floor(z);
  const X = fx & 255, Y = fy & 255, Z = fz & 255;
  x -= fx; y -= fy; z -= fz;
  const u = x * x * x * (x * (x * 6 - 15) + 10);
  const v = y * y * y * (y * (y * 6 - 15) + 10);
  const w = z * z * z * (z * (z * 6 - 15) + 10);
  const A = p[X] + Y, AA = p[A] + Z, AB = p[A + 1] + Z;
  const B = p[X + 1] + Y, BA = p[B] + Z, BB = p[B + 1] + Z;
  const x1 = x - 1, y1 = y - 1, z1 = z - 1;
  const g000 = grad(p[AA], x, y, z), g100 = grad(p[BA], x1, y, z);
  const g010 = grad(p[AB], x, y1, z), g110 = grad(p[BB], x1, y1, z);
  const g001 = grad(p[AA + 1], x, y, z1), g101 = grad(p[BA + 1], x1, y, z1);
  const g011 = grad(p[AB + 1], x, y1, z1), g111 = grad(p[BB + 1], x1, y1, z1);
  const a0 = g000 + u * (g100 - g000), a1 = g010 + u * (g110 - g010);
  const b0 = g001 + u * (g101 - g001), b1 = g011 + u * (g111 - g011);
  const a = a0 + v * (a1 - a0), b = b0 + v * (b1 - b0);
  return a + w * (b - a);
}

const smoothstep = (e0: number, e1: number, x: number) => {
  const t = Math.max(0, Math.min(1, (x - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
};

// ---------------------------------------------------------------------------------------------
// equirect frame

type Frame = {
  w: number; h: number;
  cosP: Float64Array; sinP: Float64Array; // per column
  theta: Float64Array; sinT: Float64Array; cosT: Float64Array; fade: Float64Array; // per row
};

/** Detail weight by latitude: 0 within ~7° of a pole, 1 from ~30° away. */
const poleFade = (sinT: number) => smoothstep(0.12, 0.5, sinT);

/** Row r (0 = bottom) → polar angle theta (0 = north pole). */
const rowTheta = (r: number, h: number) => (Math.PI * (h - r - 0.5)) / h;

function makeFrame(w: number, h: number): Frame {
  if (!(w >= 4 && h >= 4) || (w | 0) !== w || (h | 0) !== h) throw new Error(`detail: bad map size ${w}x${h}`);
  const cosP = new Float64Array(w), sinP = new Float64Array(w);
  for (let c = 0; c < w; c++) { const phi = ((c + 0.5) / w) * TAU; cosP[c] = Math.cos(phi); sinP[c] = Math.sin(phi); }
  const theta = new Float64Array(h), sinT = new Float64Array(h), cosT = new Float64Array(h), fade = new Float64Array(h);
  for (let r = 0; r < h; r++) {
    const t = rowTheta(r, h);
    theta[r] = t; sinT[r] = Math.sin(t); cosT[r] = Math.cos(t); fade[r] = poleFade(sinT[r]);
  }
  return { w, h, cosP, sinP, theta, sinT, cosT, fade };
}

// ---------------------------------------------------------------------------------------------
// height → normal map

export type NormalMapOptions = {
  /** Multiplier on the physical slope (heights are in units of the ball radius). Default 1. */
  gain?: number;
  /** true (default): encode slopes per uv unit for three's derivative tangent frame (no tangent attribute). */
  uvSlopes?: boolean;
  /** If set, gain is lowered (never raised) so at least 99% of texels keep normal.z >= this. */
  minZ99?: number;
  out?: Uint8Array;
};

/**
 * Wrap-aware Sobel (u wraps, v clamps) of a height field in ball-radius units → RGBA tangent normal map.
 * Rows are bottom-up like the generators in this file.
 */
export function heightToNormalMap(height: Float32Array, w: number, h: number, opts: NormalMapOptions = {}): Uint8Array {
  const n = w * h;
  if (height.length !== n) throw new Error("detail: height length mismatch");
  const out = opts.out ?? new Uint8Array(n * 4);
  const uvSlopes = opts.uvSlopes ?? true;
  // per-texel Sobel derivative → slope. A texel is 2π/w (u) by π/h (v) on the unit sphere's equator.
  const kx = (uvSlopes ? w / Math.PI : w / TAU) / 8, ky = h / Math.PI / 8;
  const sx = new Float32Array(n), sy = new Float32Array(n);
  let maxS2 = 0;
  for (let r = 0; r < h; r++) {
    const o = r * w, om = (r > 0 ? r - 1 : 0) * w, op = (r < h - 1 ? r + 1 : r) * w;
    for (let c = 0; c < w; c++) {
      const cm = c > 0 ? c - 1 : w - 1, cp = c < w - 1 ? c + 1 : 0;
      const tl = height[om + cm], tc = height[om + c], tr = height[om + cp];
      const ml = height[o + cm], mr = height[o + cp];
      const bl = height[op + cm], bc = height[op + c], br = height[op + cp];
      const gx = (tr + 2 * mr + br - tl - 2 * ml - bl) * kx;
      const gy = (bl + 2 * bc + br - tl - 2 * tc - tr) * ky;
      sx[o + c] = gx; sy[o + c] = gy;
      const s2 = gx * gx + gy * gy;
      if (s2 > maxS2) maxS2 = s2;
    }
  }
  let gain = opts.gain ?? 1;
  if (opts.minZ99 && maxS2 > 0) {
    // slope² limit for the target z, then the 99th percentile of slope² via a histogram
    const lim = 1 / (opts.minZ99 * opts.minZ99) - 1;
    const BINS = 4096, hist = new Uint32Array(BINS), top = maxS2 * gain * gain, scale = (BINS - 1) / top;
    for (let i = 0; i < n; i++) { const s2 = (sx[i] * sx[i] + sy[i] * sy[i]) * gain * gain; hist[Math.min(BINS - 1, (s2 * scale) | 0)]++; }
    let acc = 0, bin = BINS - 1;
    const want = Math.floor(n * 0.99);
    for (let b = 0; b < BINS; b++) { acc += hist[b]; if (acc >= want) { bin = b; break; } }
    const p99 = ((bin + 1) / BINS) * top; // conservative upper edge
    if (p99 > lim) gain *= Math.sqrt(lim / p99) * 0.995;
  }
  for (let i = 0; i < n; i++) {
    const nx = -sx[i] * gain, ny = -sy[i] * gain;
    const inv = 1 / Math.sqrt(nx * nx + ny * ny + 1);
    const j = i * 4;
    out[j] = (nx * inv * 127.5 + 128) | 0;
    out[j + 1] = (ny * inv * 127.5 + 128) | 0;
    out[j + 2] = (inv * 127.5 + 128) | 0;
    out[j + 3] = 255;
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// wax layout: dip lines (long, mostly horizontal lips), drip tears hanging off them, air-bubble pits

type DipLine = { line: Float32Array; env: Float32Array; amp: number; wUp: number; wDown: number };
type Tear = { col: number; theta0: number; len: number; neck: number; bulb: number; amp: number };
type Pit = { col: number; row: number; r: number; depth: number };
type WaxLayout = { lines: DipLine[]; tears: Tear[]; pits: Pit[]; perm: Uint8Array; grainSeed: number };

const WAX_REF_W = 1024; // texel sizes below are quoted for a 1024-wide map

function waxLayout(seed: number, F: Frame): WaxLayout {
  const { w, h } = F;
  const rng = mulberry32(subSeed(seed, 0x57a1));
  const lines: DipLine[] = [];
  const tears: Tear[] = [];
  const nLines = 3 + Math.floor(rng() * 3);
  for (let k = 0; k < nLines; k++) {
    // polar angle of the line, kept in the band where the map is undistorted enough
    const theta0 = 0.75 + rng() * (Math.PI - 1.5);
    const a1 = (0.03 + rng() * 0.07) * (rng() < 0.5 ? -1 : 1), p1 = rng() * TAU;
    const a2 = 0.012 + rng() * 0.03, p2 = rng() * TAU;
    const a3 = 0.004 + rng() * 0.01, p3 = rng() * TAU;
    const e1 = 0.55 + rng() * 0.5, q1 = rng() * TAU, e2 = 0.25 + rng() * 0.35, q2 = rng() * TAU;
    const bias = rng() * 0.4 - 0.1;
    const line = new Float32Array(w), env = new Float32Array(w);
    for (let c = 0; c < w; c++) {
      const phi = ((c + 0.5) / w) * TAU;
      line[c] = theta0 + a1 * Math.sin(phi + p1) + a2 * Math.sin(2 * phi + p2) + a3 * Math.sin(5 * phi + p3);
      // integer harmonics only → periodic in phi → seamless
      env[c] = smoothstep(0.05, 0.6, bias + e1 * Math.sin(phi + q1) + e2 * Math.sin(3 * phi + q2));
    }
    const amp = 0.0011 + rng() * 0.0011;
    lines.push({ line, env, amp, wUp: 0.035 + rng() * 0.03, wDown: 0.007 + rng() * 0.005 });
    // a couple of drip tears where the lip is strong
    const nTears = Math.floor(rng() * 3);
    for (let t = 0; t < nTears; t++) {
      let col = 0, best = -1;
      for (let tries = 0; tries < 6; tries++) { const c = Math.floor(rng() * w); if (env[c] > best) { best = env[c]; col = c; } }
      if (best < 0.4) continue;
      tears.push({
        col, theta0: line[col], len: 0.05 + rng() * 0.11,
        neck: 0.006 + rng() * 0.004, bulb: 0.011 + rng() * 0.007, amp: amp * (0.7 + rng() * 0.6) * best,
      });
    }
  }
  // pits: uniform over the sphere's area away from the poles (cosθ uniform), 1–3 px wide at 1024
  const pits: Pit[] = [];
  const nPits = 90 + Math.floor(rng() * 70);
  const pxScale = w / WAX_REF_W;
  for (let i = 0; i < nPits; i++) {
    const y = (rng() * 2 - 1) * 0.88;
    const theta = Math.acos(y);
    const row = h - 0.5 - (theta / Math.PI) * h;
    const col = rng() * w;
    const big = rng() < 0.15;
    const r = Math.max(0.75, (big ? 1.2 + rng() * 0.6 : 0.6 + rng() * 0.6) * pxScale);
    // depth relative to the physical radius: peak wall slope ≈ 1.54 * depth / radius
    pits.push({ col, row, r, depth: (big ? 0.26 : 0.2) * (0.7 + rng() * 0.6) * ((r * TAU) / w) });
  }
  return { lines, tears, pits, perm: makePerm(subSeed(seed, 0x9e21)), grainSeed: subSeed(seed, 0x6a17) | 0 };
}

/** Dip-line lip profile at polar angle th for column c; 0..~1.1 (times line.amp). */
function dipLineAt(L: DipLine, c: number, th: number): number {
  const e = L.env[c];
  if (e <= 0) return 0;
  const t = th - L.line[c]; // > 0 = below the line (south)
  if (t < -3 * L.wUp || t > 6 * L.wDown) return 0;
  let v: number;
  if (t <= 0) { const q = t / L.wUp; v = Math.exp(-q * q); } else { const q = t / L.wDown; v = Math.exp(-q * q); }
  // a faint trough right under the lip where the wax pulled away
  const q2 = (t - 2.6 * L.wDown) / (1.4 * L.wDown);
  v -= 0.22 * Math.exp(-q2 * q2);
  return v * e;
}

/** Adds an elliptical (physically round) dimple at a texel position, x-wrapped. */
function stampPit(out: Float32Array, F: Frame, p: Pit, amp: number) {
  const { w, h } = F;
  const rr = Math.round(p.row);
  if (rr < 0 || rr >= h) return;
  const st = Math.max(F.sinT[rr], 0.3);
  const rx = p.r / st, ry = p.r;
  const r0 = Math.max(0, Math.floor(p.row - ry - 1)), r1 = Math.min(h - 1, Math.ceil(p.row + ry + 1));
  const c0 = Math.floor(p.col - rx - 1), c1 = Math.ceil(p.col + rx + 1);
  const fade = F.fade[rr];
  for (let r = r0; r <= r1; r++) {
    const dy = (r - p.row) / ry;
    for (let cc = c0; cc <= c1; cc++) {
      const c = ((cc % w) + w) % w;
      const dx = (cc - p.col) / rx;
      const d2 = dx * dx + dy * dy;
      if (d2 >= 1) continue;
      const f = 1 - d2;
      out[r * w + c] += amp * f * f * fade;
    }
  }
}

function stampTear(out: Float32Array, F: Frame, T: Tear) {
  const { w, h } = F;
  const thMin = T.theta0 - 0.02, thMax = T.theta0 + T.len + 3.5 * T.bulb;
  const rTop = Math.min(h - 1, Math.ceil(h - 0.5 - (thMin / Math.PI) * h));
  const rBot = Math.max(0, Math.floor(h - 0.5 - (thMax / Math.PI) * h));
  const halfW = 3.5 * Math.max(T.neck, T.bulb);
  for (let r = rBot; r <= rTop; r++) {
    const th = F.theta[r], st = Math.max(F.sinT[r], 0.2);
    const cols = Math.ceil((halfW / st / TAU) * w) + 1;
    const s = (th - T.theta0) / T.len;
    const along = smoothstep(-0.15, 0.2, s) * (1 - smoothstep(0.8, 1.05, s));
    const bt = (th - T.theta0 - T.len) / (1.3 * T.bulb);
    const fade = F.fade[r];
    for (let k = -cols; k <= cols; k++) {
      const c = (((T.col + k) % w) + w) % w;
      const q = ((k * TAU) / w) * st; // physical offset across the tear
      const qn = q / T.neck, qb = q / T.bulb;
      const v = 0.55 * along * Math.exp(-qn * qn) + Math.exp(-(qb * qb + bt * bt));
      out[r * w + c] += T.amp * v * fade;
    }
  }
}

/** Separable [1 2 1]/4 blur of per-texel white noise (x wraps), scaled by the pole fade. */
function addGrain(out: Float32Array, F: Frame, seed: number, amp: number) {
  const { w, h } = F;
  const n = w * h;
  const a = new Float32Array(n), b = new Float32Array(n);
  for (let i = 0; i < n; i++) a[i] = hashSigned(i, seed);
  for (let r = 0; r < h; r++) {
    const o = r * w;
    for (let c = 0; c < w; c++) {
      const cm = c > 0 ? c - 1 : w - 1, cp = c < w - 1 ? c + 1 : 0;
      b[o + c] = (a[o + cm] + 2 * a[o + c] + a[o + cp]) * 0.25;
    }
  }
  for (let r = 0; r < h; r++) {
    const o = r * w, om = (r > 0 ? r - 1 : 0) * w, op = (r < h - 1 ? r + 1 : r) * w, k = amp * F.fade[r];
    if (k === 0) continue;
    for (let c = 0; c < w; c++) out[o + c] += (b[om + c] + 2 * b[o + c] + b[op + c]) * 0.25 * k;
  }
}

// ---------------------------------------------------------------------------------------------
// height fields (units: ball radius)

/**
 * Wax shell relief: long dipped-wax ripple, orange peel, dip-line lips with a few drip tears,
 * sparse air-bubble pits and a faint grain. Same seed → same layout as roughnessVariation().
 */
export function waxHeightField(width: number, height: number, seed: number): Float32Array {
  const F = makeFrame(width, height);
  const L = waxLayout(seed, F);
  const { w, h } = F, p = L.perm;
  const out = new Float32Array(w * h);
  const lines = L.lines, nl = lines.length;
  for (let r = 0; r < h; r++) {
    const fade = F.fade[r];
    if (fade === 0) continue;
    const st = F.sinT[r], ct = F.cosT[r], th = F.theta[r], o = r * w;
    for (let c = 0; c < w; c++) {
      const x = -F.cosP[c] * st, z = F.sinP[c] * st;
      // dipped ripple: squashed in y so the swells run around the ball like dip layers
      let v = 0.0026 * perlin3(p, x * 3.2 + 17.1, ct * 8.5 - 3.3, z * 3.2 + 5.9);
      // orange peel, two octaves
      v += 0.0012 * perlin3(p, x * 21 - 41.7, ct * 21 + 12.9, z * 21 + 27.3);
      v += 0.00035 * perlin3(p, x * 47 + 63.1, ct * 47 - 77.5, z * 47 - 9.4);
      for (let k = 0; k < nl; k++) { const dl = lines[k]; v += dl.amp * dipLineAt(dl, c, th); }
      out[o + c] = v * fade;
    }
  }
  for (const t of L.tears) stampTear(out, F, t);
  for (const pit of L.pits) stampPit(out, F, pit, -pit.depth);
  addGrain(out, F, L.grainSeed, 0.00006 * (WAX_REF_W / w));
  return out;
}

type Smear = { col: number; row: number; ang: number; len: number; hw: number; depth: number; ridge: number; period: number; phase: number };

/** Clay core relief: soft billowy putty lumps, secondary dents, soft fine texture and finger smears. */
export function clayHeightField(width: number, height: number, seed: number): Float32Array {
  const F = makeFrame(width, height);
  const { w, h } = F;
  const p = makePerm(subSeed(seed, 0xc1a7));
  const out = new Float32Array(w * h);
  for (let r = 0; r < h; r++) {
    const fade = F.fade[r];
    if (fade === 0) continue;
    const st = F.sinT[r], ct = F.cosT[r], o = r * w;
    for (let c = 0; c < w; c++) {
      const x = -F.cosP[c] * st, z = F.sinP[c] * st;
      const n1 = perlin3(p, x * 8 + 3.7, ct * 8 - 11.2, z * 8 + 21.5);
      // billow with a soft crease: rounded lumps pressed together
      let v = 0.012 * Math.sqrt(n1 * n1 + 0.012);
      v += 0.0042 * perlin3(p, x * 19 - 33.1, ct * 19 + 7.7, z * 19 - 2.9);
      v += 0.0006 * perlin3(p, x * 46 + 51.3, ct * 46 + 29.1, z * 46 - 61.7);
      out[o + c] = v * fade;
    }
  }
  // finger smears: flatten the lumps along a stroke, press a shallow trough with fingerprint ridges
  const rng = mulberry32(subSeed(seed, 0x5e3a));
  const smears: Smear[] = [];
  const nSm = 3 + Math.floor(rng() * 3);
  for (let i = 0; i < nSm; i++) {
    const theta = Math.PI / 2 + (rng() * 2 - 1) * 0.55;
    smears.push({
      col: rng() * w, row: h - 0.5 - (theta / Math.PI) * h, ang: rng() * Math.PI,
      len: 0.28 + rng() * 0.3, hw: 0.035 + rng() * 0.035, depth: 0.003 + rng() * 0.002,
      ridge: 0.0004 + rng() * 0.0002, period: 0.016 + rng() * 0.008, phase: rng() * TAU,
    });
  }
  for (const s of smears) {
    const ca = Math.cos(s.ang), sa = Math.sin(s.ang), reach = s.len / 2 + s.hw * 1.6;
    const rowSpan = Math.ceil((reach / Math.PI) * h) + 1;
    const r0 = Math.max(0, Math.floor(s.row) - rowSpan), r1 = Math.min(h - 1, Math.ceil(s.row) + rowSpan);
    const thC = rowTheta(s.row, h);
    for (let r = r0; r <= r1; r++) {
      const st = Math.max(F.sinT[r], 0.3), fade = F.fade[r];
      const cols = Math.ceil((reach / st / TAU) * w) + 1;
      const dyp = F.theta[r] - thC;
      for (let k = -cols; k <= cols; k++) {
        const cc = Math.round(s.col) + k;
        const c = ((cc % w) + w) % w;
        const dxp = (((cc - s.col) * TAU) / w) * st;
        const al = dxp * ca + dyp * sa, ac = -dxp * sa + dyp * ca;
        const u = al / s.len + 0.5; // 0..1 along the stroke
        if (u < 0 || u > 1) continue;
        const hw = s.hw * (1 - 0.35 * u); // finger lifts off toward the end
        const q = ac / hw;
        if (q <= -1.6 || q >= 1.6) continue;
        const ea = smoothstep(0, 0.22, u) * (1 - smoothstep(0.62, 1, u));
        const inside = q * q < 1 ? (1 - q * q) * (1 - q * q) : 0;
        const berm = Math.exp(-((Math.abs(q) - 1.05) * (Math.abs(q) - 1.05)) / 0.05);
        const i = r * w + c;
        const prints = Math.sin((ac / s.period) * TAU + s.phase + 2.2 * Math.sin(u * 5.1 + s.phase));
        const e = ea * inside * fade;
        out[i] = out[i] * (1 - 0.7 * e) + e * (s.ridge * prints - s.depth) + ea * berm * fade * s.depth * 0.35;
      }
    }
  }
  addGrain(out, F, subSeed(seed, 0x77) | 0, 0.00006 * (WAX_REF_W / w));
  return out;
}

// ---------------------------------------------------------------------------------------------
// public map builders

/** RGBA tangent normal map for the glossy wax shell (see the header for layout). ~99% of texels z >= 0.93. */
export function waxNormalMap(width: number, height: number, seed: number): Uint8Array {
  return heightToNormalMap(waxHeightField(width, height, seed), width, height, { gain: 1, minZ99: 0.945 });
}

/** RGBA tangent normal map for the matte clay core. ~99% of texels z >= 0.8. */
export function clayNormalMap(width: number, height: number, seed: number): Uint8Array {
  return heightToNormalMap(clayHeightField(width, height, seed), width, height, { gain: 1, minZ99: 0.82 });
}

/** The roughness map stores (1 + 0.08 n) / ROUGHNESS_GAIN, n in [-1, 1]: multiply the base roughness by this. */
export const ROUGHNESS_GAIN = 1.08;
/** Peak relative roughness change encoded by roughnessVariation(). */
export const ROUGHNESS_SPREAD = 0.08;

/**
 * RGBA roughness multiplier for the wax, three's roughnessMap / clearcoatRoughnessMap convention:
 * the value is in G (R and B copy it so the map previews as grey), A = 255. Texel = (1 + 0.08 n) / 1.08,
 * so set the material's roughness to base * ROUGHNESS_GAIN to keep the same average.
 * Glossier along the dip lines, duller in pits, soft blotches elsewhere; same seed as waxNormalMap lines up.
 */
export function roughnessVariation(width: number, height: number, seed: number): Uint8Array {
  const F = makeFrame(width, height);
  const L = waxLayout(seed, F);
  const { w, h } = F, p = L.perm;
  const n = w * h;
  const val = new Float32Array(n);
  const lines = L.lines, nl = lines.length;
  for (let r = 0; r < h; r++) {
    const fade = F.fade[r];
    if (fade === 0) continue;
    const st = F.sinT[r], ct = F.cosT[r], th = F.theta[r], o = r * w;
    for (let c = 0; c < w; c++) {
      const x = -F.cosP[c] * st, z = F.sinP[c] * st;
      let v = 1.9 * perlin3(p, x * 2.3 - 91.3, ct * 4.6 + 44.4, z * 2.3 + 13.1);
      v += 1.1 * perlin3(p, x * 9 + 71.9, ct * 9 - 18.2, z * 9 + 88.8);
      let lip = 0;
      for (let k = 0; k < nl; k++) lip += dipLineAt(lines[k], c, th);
      v -= 0.55 * Math.max(0, lip);
      val[o + c] = v * fade;
    }
  }
  for (const pit of L.pits) stampPit(val, F, pit, 0.9);
  addGrain(val, F, L.grainSeed ^ 0x2f, 0.25);
  const out = new Uint8Array(n * 4);
  const k = 255 / ROUGHNESS_GAIN;
  for (let i = 0; i < n; i++) {
    const v = Math.max(-1, Math.min(1, val[i]));
    const g = Math.max(0, Math.min(255, Math.round((1 + ROUGHNESS_SPREAD * v) * k)));
    const j = i * 4;
    out[j] = g; out[j + 1] = g; out[j + 2] = g; out[j + 3] = 255;
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// wax shards

export type ShardGeometry = { positions: Float32Array; normals: Float32Array; index: Uint32Array };

export type ShardOptions = {
  /** Outline corners, 5–8 by default (random). */
  sides?: number;
  /** Overall footprint, ~1 unit across at 1. */
  size?: number;
  /** Mean thickness (the rim is a little thinner, the domed middle a little thicker). Default 0.18. */
  thickness?: number;
  /** Radius of the sphere the outer face is cut from, in shard units. Default 2.4. */
  curvature?: number;
  /** 0 = regular polygon, 1 = very ragged. Default 0.6. */
  jag?: number;
};

/**
 * A thin, irregular slab of wax shell: jagged 5–8 sided outline, outer face cut from a sphere (smooth
 * normals within it), flat and slightly tilted inner face, side walls converging toward the ball centre.
 * Each face has its own vertices, so the rims are crisp. Outer face points +z; origin at the centre.
 * Counter-clockwise winding seen from outside; closed and watertight by position.
 */
export function shardGeometry(rngSeed: number, opts: ShardOptions = {}): ShardGeometry {
  const rng = mulberry32(subSeed(rngSeed, 0x5a4d));
  const jag = Math.max(0, Math.min(1, opts.jag ?? 0.6));
  const size = opts.size ?? 1;
  const sidesRoll = 5 + Math.floor(rng() * 4);
  const n = Math.max(3, Math.min(16, Math.round(opts.sides ?? sidesRoll)));
  const thick = (opts.thickness ?? 0.18) * size;
  // outline: sorted jittered angles around the origin → star-shaped, so a centre fan is valid
  const step = TAU / n, a0 = rng() * TAU;
  // angular jitter is 0.7 * jag steps peak-to-peak, so a corner gap is at most step * (1 + 0.7 * jag). Cap it
  // so every gap stays < 180° (else the origin can fall outside a 3-gon and the centre fans fold over).
  // jk is exactly 1 for n >= 4 (cap 0.8 >= 0.7), so only sides = 3 is affected.
  const jk = Math.min(1, (0.8 * (n / 2 - 1)) / (0.7 * jag || 1));
  const px = new Float64Array(n), py = new Float64Array(n);
  const elong = rng() * 0.6 * jag, eAng = rng() * Math.PI, ec = Math.cos(eAng), es = Math.sin(eAng);
  for (let i = 0; i < n; i++) {
    const a = a0 + (i + (rng() - 0.5) * 0.7 * jag * jk) * step;
    const rad = 0.5 * size * (1 - 0.55 * jag * rng());
    let x = Math.cos(a) * rad, y = Math.sin(a) * rad;
    // stretch along a random axis (shards are rarely round)
    const al = x * ec + y * es, ac = -x * es + y * ec;
    const sl = al * (1 + elong), sc = ac * (1 - 0.4 * elong);
    x = sl * ec - sc * es; y = sl * es + sc * ec;
    px[i] = x; py[i] = y;
  }
  let rmax = 0;
  for (let i = 0; i < n; i++) rmax = Math.max(rmax, Math.hypot(px[i], py[i]));
  const Rc = Math.max((opts.curvature ?? 2.4) * size, rmax * 1.25);
  // `thick` is the mean: the rim is thinner than the domed middle by the cap height
  const dome = Rc - Math.sqrt(Rc * Rc - rmax * rmax);
  const zc = thick - dome / 2 - Math.sqrt(Rc * Rc - rmax * rmax); // sphere centre: outer z = zc + sqrt(Rc² - r²)
  const zOut = (x: number, y: number) => zc + Math.sqrt(Rc * Rc - x * x - y * y);
  // inner face: plane z = tx x + ty y (tilt), outline pulled in as if the walls ran to the ball centre
  const tx = (rng() * 2 - 1) * 0.04 * jag, ty = (rng() * 2 - 1) * 0.04 * jag;
  const qx = new Float64Array(n), qy = new Float64Array(n);
  const conv = 1 - thick / Rc;
  for (let i = 0; i < n; i++) {
    const k = Math.max(0.8, Math.min(1.02, conv + (rng() - 0.6) * 0.1 * jag));
    qx[i] = px[i] * k; qy[i] = py[i] * k;
  }
  const zIn = (x: number, y: number) => tx * x + ty * y;
  const zShift = (zOut(0, 0) + zIn(0, 0)) / 2;

  const nv = 1 + 2 * n + (1 + n) + 4 * n;
  const pos = new Float32Array(nv * 3), nor = new Float32Array(nv * 3);
  const idx = new Uint32Array(18 * n);
  let v = 0, t = 0;
  const put = (x: number, y: number, z: number, nx: number, ny: number, nz: number) => {
    const l = Math.hypot(nx, ny, nz) || 1;
    pos[v * 3] = x; pos[v * 3 + 1] = y; pos[v * 3 + 2] = z - zShift;
    nor[v * 3] = nx / l; nor[v * 3 + 1] = ny / l; nor[v * 3 + 2] = nz / l;
    return v++;
  };
  const tri = (a: number, b: number, c: number) => { idx[t++] = a; idx[t++] = b; idx[t++] = c; };
  // outer face: centre, mid ring, rim; sphere normals
  const sph = (x: number, y: number) => { const z = zOut(x, y); return put(x, y, z, x, y, z - zc); };
  const oC = sph(0, 0);
  const oM = v; for (let i = 0; i < n; i++) sph(px[i] * 0.5, py[i] * 0.5);
  const oR = v; for (let i = 0; i < n; i++) sph(px[i], py[i]);
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    tri(oC, oM + i, oM + j);
    tri(oM + i, oR + i, oR + j);
    tri(oM + i, oR + j, oM + j);
  }
  // inner face: flat, facing -z (tilted)
  const iC = put(0, 0, zIn(0, 0), tx, ty, -1);
  const iR = v; for (let i = 0; i < n; i++) put(qx[i], qy[i], zIn(qx[i], qy[i]), tx, ty, -1);
  for (let i = 0; i < n; i++) tri(iC, iR + (i + 1) % n, iR + i);
  // side walls: one flat-shaded quad per edge (normal = cross of the diagonals)
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    const b0x = qx[i], b0y = qy[i], b0z = zIn(b0x, b0y), b1x = qx[j], b1y = qy[j], b1z = zIn(b1x, b1y);
    const t0x = px[i], t0y = py[i], t0z = zOut(t0x, t0y), t1x = px[j], t1y = py[j], t1z = zOut(t1x, t1y);
    const d1x = t1x - b0x, d1y = t1y - b0y, d1z = t1z - b0z; // B_i → T_j
    const d2x = t0x - b1x, d2y = t0y - b1y, d2z = t0z - b1z; // B_j → T_i
    const nx = d1y * d2z - d1z * d2y, ny = d1z * d2x - d1x * d2z, nz = d1x * d2y - d1y * d2x;
    const B0 = put(b0x, b0y, b0z, nx, ny, nz), B1 = put(b1x, b1y, b1z, nx, ny, nz);
    const T1 = put(t1x, t1y, t1z, nx, ny, nz), T0 = put(t0x, t0y, t0z, nx, ny, nz);
    tri(B0, B1, T1);
    tri(B0, T1, T0);
  }
  return { positions: pos, normals: nor, index: idx };
}

/** `count` different shards from one seed, for a handful of InstancedMeshes. */
export function shardVariants(count: number, seed: number, opts: ShardOptions = {}): ShardGeometry[] {
  const out: ShardGeometry[] = [];
  for (let i = 0; i < count; i++) out.push(shardGeometry(subSeed(seed, 0x100 + i), opts));
  return out;
}
