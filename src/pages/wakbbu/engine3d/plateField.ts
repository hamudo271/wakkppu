/**
 * The crack layout of one ball's wax shell as a texture-space field (pure maths, no DOM, no three):
 * a spherical Voronoi of the plate seeds with jagged borders, evaluated per texel of an equirect map.
 *
 * Per texel it stores the nearest plate (owner), the second-nearest plate (the neighbour across the
 * closest border) and the distance to that border. The shader opens a crack wherever either plate is
 * cracked and the distance is below the crack's half width, so a crack is symmetric about the border
 * and its edge comes from a smoothly interpolated distance: thin, anti-aliased, no stair-steps.
 *
 * Layout (matches three's SphereGeometry uv and DataTexture with flipY = false):
 *   column x ↔ u = (x + 0.5) / W (phi = 2πu, wraps); row y ↔ v = (y + 0.5) / H, row 0 = south pole.
 *   direction = (−cos φ · sin θ, cos θ, sin φ · sin θ) with θ = (1 − v) π.
 * Distances are in "field texels" = angle / (π / H), so a width means the same on the whole sphere.
 */

export const FIELD_W = 1024;
export const FIELD_H = 512;
/** dist byte = texels × DIST_SCALE (max 255 / 16 ≈ 16 texels ≈ 0.1 rad) */
export const DIST_SCALE = 16;

export type FieldResult = {
  /** RG pairs per texel: owner plate id, second plate id */
  ids: Uint8Array;
  /** distance to the nearest border, texels × DIST_SCALE */
  dist: Uint8Array;
  /** solid angle of each plate (sr), from the texel areas */
  area: Float32Array;
  ms: number;
};

// cheap 3D value noise for the domain warp (same family as the first painted version)
function hash3(x: number, y: number, z: number) {
  let h = (x * 374761393 + y * 668265263 + z * 2147483647) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}
function vnoise(x: number, y: number, z: number) {
  const xi = Math.floor(x), yi = Math.floor(y), zi = Math.floor(z);
  const fx = x - xi, fy = y - yi, fz = z - zi;
  const sx = fx * fx * (3 - 2 * fx), sy = fy * fy * (3 - 2 * fy), sz = fz * fz * (3 - 2 * fz);
  const a000 = hash3(xi, yi, zi), a100 = hash3(xi + 1, yi, zi), a010 = hash3(xi, yi + 1, zi), a110 = hash3(xi + 1, yi + 1, zi);
  const a001 = hash3(xi, yi, zi + 1), a101 = hash3(xi + 1, yi, zi + 1), a011 = hash3(xi, yi + 1, zi + 1), a111 = hash3(xi + 1, yi + 1, zi + 1);
  const x00 = a000 + (a100 - a000) * sx, x10 = a010 + (a110 - a010) * sx, x01 = a001 + (a101 - a001) * sx, x11 = a011 + (a111 - a011) * sx;
  const y0 = x00 + (x10 - x00) * sy, y1 = x01 + (x11 - x01) * sy;
  return (y0 + (y1 - y0) * sz) * 2 - 1;
}

/** Field index (y * W + x) of a unit direction, same convention as the texture. */
export function dirToField(x: number, y: number, z: number, W = FIELD_W, H = FIELD_H): number {
  let phi = Math.atan2(z, -x);
  if (phi < 0) phi += Math.PI * 2;
  const theta = Math.acos(Math.max(-1, Math.min(1, y)));
  const fx = Math.min(W - 1, Math.floor((phi / (Math.PI * 2)) * W));
  const fy = Math.min(H - 1, Math.max(0, Math.floor((1 - theta / Math.PI) * H)));
  return fy * W + fx;
}

/** Unit direction of field texel (x, y). */
export function fieldDir(x: number, y: number, out: Float32Array, W = FIELD_W, H = FIELD_H) {
  const phi = ((x + 0.5) / W) * Math.PI * 2, theta = (1 - (y + 0.5) / H) * Math.PI, st = Math.sin(theta);
  out[0] = -Math.cos(phi) * st; out[1] = Math.cos(theta); out[2] = Math.sin(phi) * st;
  return out;
}

/**
 * Computes rows [y0, y1) of the field into `out` (allocated by the first call when omitted).
 * Splitting into row ranges lets a main-thread fallback spread the work over idle slices.
 */
export function computeField(seeds: Float32Array, y0 = 0, y1 = FIELD_H, out?: FieldResult, W = FIELD_W, H = FIELD_H, warp = 0.085): FieldResult {
  const t0 = typeof performance !== "undefined" ? performance.now() : 0;
  const n = seeds.length / 3;
  const res = out ?? { ids: new Uint8Array(W * H * 2), dist: new Uint8Array(W * H), area: new Float32Array(n), ms: 0 };
  const sx = new Float64Array(n), sy = new Float64Array(n), sz = new Float64Array(n);
  for (let s = 0; s < n; s++) {
    const l = Math.hypot(seeds[s * 3], seeds[s * 3 + 1], seeds[s * 3 + 2]) || 1;
    sx[s] = seeds[s * 3] / l; sy[s] = seeds[s * 3 + 1] / l; sz[s] = seeds[s * 3 + 2] / l;
  }
  const cosPhi = new Float64Array(W), sinPhi = new Float64Array(W);
  for (let x = 0; x < W; x++) { const phi = ((x + 0.5) / W) * Math.PI * 2; cosPhi[x] = Math.cos(phi); sinPhi[x] = Math.sin(phi); }
  const texelAngle = Math.PI / H;
  const pixArea = (Math.PI * 2 / W) * (Math.PI / H);
  for (let y = y0; y < y1; y++) {
    const theta = (1 - (y + 0.5) / H) * Math.PI, st = Math.sin(theta), ct = Math.cos(theta);
    const rowArea = pixArea * st;
    for (let x = 0; x < W; x++) {
      const dx = -cosPhi[x] * st, dy = ct, dz = sinPhi[x] * st;
      // domain warp → jagged, crack-like borders
      let wx = dx + warp * vnoise(dx * 7 + 3.1, dy * 7, dz * 7) + warp * 0.28 * vnoise(dx * 23, dy * 23 + 1.7, dz * 23);
      let wy = dy + warp * vnoise(dx * 7, dy * 7 + 5.7, dz * 7) + warp * 0.28 * vnoise(dx * 23 + 4.4, dy * 23, dz * 23);
      let wz = dz + warp * vnoise(dx * 7, dy * 7, dz * 7 + 9.3) + warp * 0.28 * vnoise(dx * 23, dy * 23, dz * 23 + 8.1);
      const wl = Math.hypot(wx, wy, wz) || 1; wx /= wl; wy /= wl; wz /= wl;
      let b1 = 0, d1 = -3, b2 = 0, d2 = -3;
      for (let s = 0; s < n; s++) {
        const dp = sx[s] * wx + sy[s] * wy + sz[s] * wz;
        if (dp > d1) { d2 = d1; b2 = b1; d1 = dp; b1 = s; } else if (dp > d2) { d2 = dp; b2 = s; }
      }
      // distance from the (warped) point to the bisector plane of the two nearest seeds
      const ex = sx[b1] - sx[b2], ey = sy[b1] - sy[b2], ez = sz[b1] - sz[b2];
      const el = Math.hypot(ex, ey, ez) || 1;
      const ang = Math.max(0, (wx * ex + wy * ey + wz * ez) / el); // ≈ radians for small values
      const i = y * W + x;
      res.ids[i * 2] = b1; res.ids[i * 2 + 1] = b2;
      res.dist[i] = Math.min(255, Math.round((ang / texelAngle) * DIST_SCALE));
      res.area[b1] += rowArea;
    }
  }
  if (typeof performance !== "undefined") res.ms += performance.now() - t0;
  return res;
}

/**
 * Plate seeds for one ball: dense small chips around a random front-facing weak spot, a few big slabs
 * elsewhere, so sizes are skewed (few large, many small) like real wax. Deterministic for `rng`.
 */
export function makeSeeds(rng: () => number, count: [number, number] = [30, 39]): Float32Array {
  const target = count[0] + Math.floor(rng() * (count[1] - count[0] + 1));
  const seeds: number[][] = [];
  const randDir = () => { const z = rng() * 2 - 1, a = rng() * Math.PI * 2, r = Math.sqrt(1 - z * z); return [r * Math.cos(a), r * Math.sin(a), z]; };
  const farFrom = (d: number[], minDot: number) => seeds.every((s) => s[0] * d[0] + s[1] * d[1] + s[2] * d[2] < minDot);
  // the weak spot faces the camera (+z) so the fine pieces are where fingers land
  let weak = randDir();
  for (let k = 0; k < 20 && weak[2] < 0.35; k++) weak = randDir();
  const slabs = 4 + Math.floor(rng() * 3);
  let tries = 0;
  while (seeds.length < slabs && tries++ < 4000) {
    const d = randDir();
    if (d[0] * weak[0] + d[1] * weak[1] + d[2] * weak[2] < Math.cos(1.0) && farFrom(d, Math.cos(0.55))) seeds.push(d);
  }
  tries = 0;
  while (seeds.length < target && tries++ < 12000) {
    const d = randDir();
    const ang = Math.acos(Math.max(-1, Math.min(1, d[0] * weak[0] + d[1] * weak[1] + d[2] * weak[2])));
    const acc = Math.max(0.12, 1 / (1 + Math.pow(ang / 0.65, 4)));
    if (rng() < acc && farFrom(d, Math.cos(0.15))) seeds.push(d);
  }
  return Float32Array.from(seeds.flat());
}
