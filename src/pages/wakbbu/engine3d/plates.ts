/**
 * Thick Voronoi plates cut out of the ball's sphere shell. Pure maths: no three.js, no DOM.
 *
 * Input is the shared THREE.SphereGeometry(1, 96, 64) template: indexed, with the u = 0 / u = 1 column
 * duplicated and one vertex per column at each pole. Vertices are welded by quantised position, so neither
 * the uv seam nor the collapsed poles read as plate borders. Every non-degenerate triangle goes to the seed
 * nearest its domain-warped centroid (the same warp as ShellTexture.buildPlates, so with the same seeds the
 * mesh plates follow the painted ones to within a triangle), stray islands are folded into the neighbour
 * they touch most, and each plate becomes one closed, consistently wound solid:
 *
 *   vertices  [outer: outerCount][inner: outerCount][walls: 4 per boundary edge]
 *   groups    0 = outer (shell material), 1 = inner (reversed winding), 2 = walls (fracture material)
 *
 * Outer vertices map 1:1 to the template vertices the plate uses (templateIndex), so the integrator can
 * copy the deformed full-sphere position + normal and an intact plate stays seamless with its neighbours.
 * Inner vertices are the same template vertices pushed in by `thickness` (fraction of the radius) along
 * the outer normal with the normal flipped. Wall quads join each boundary edge's outer and inner copies
 * and face away from the plate, tangent to the sphere.
 *
 * Topology (weld, edges, triangle centroids/areas, warped centroids) is cached per template array and
 * revalidated with a content hash, so every ball after the first only pays for seed assignment + emission.
 */

export const LAYER_OUTER = 0;
export const LAYER_INNER = 1;
export const LAYER_WALL = 2;

export type PlateBuildInput = {
  /** Vertex positions of THREE.SphereGeometry(1, 96, 64) (template.attributes.position.array). */
  positions: Float32Array;
  /** Its index buffer (template.index.array). */
  index: Uint32Array | Uint16Array;
  /** 3*n unit seed directions; plate id === seed index. */
  seeds: Float32Array;
  /** Shell thickness as a fraction of the radius (e.g. 0.07). */
  thickness: number;
  /** Domain-warp amplitude for jagged borders (default 0.09, as ShellTexture). 0 = clean Voronoi. */
  jitter?: number;
  /** Domain-warp noise frequency (default 7, as ShellTexture). */
  noiseFreq?: number;
  /** Template uv (template.attributes.uv.array). If omitted, rebuilt with three's SphereGeometry rule. */
  uv?: Float32Array;
  /** Only used to rebuild uv when `uv` is omitted (defaults 96 / 64). */
  widthSegments?: number;
  heightSegments?: number;
  /** Fold disconnected fragments of a plate into the neighbour they share most border with (default true). */
  mergeIslands?: boolean;
};

export type PlateGroup = { start: number; count: number; materialIndex: number };

export type PlateGeo = {
  /** === seed index. */
  id: number;
  /** Area-weighted unit centroid on the sphere (the seed direction when the plate is empty). */
  centroid: [number, number, number];
  /** Sum of its triangles' spherical areas on the unit sphere (all plates sum to 4π). */
  area: number;
  /** Template triangles in the plate (== outer triangles == inner triangles). 0 = empty plate, skip it. */
  triangleCount: number;
  /** Boundary edges of the plate == wall quads. */
  boundaryEdgeCount: number;
  /** Plate ids sharing at least one edge, ascending. */
  neighbors: number[];
  /** Max angle (rad) from the centroid to any of its vertices. */
  angularRadius: number;

  /** Outer vertex count (== inner vertex count). Inner vertex j mirrors outer vertex j at j + outerCount. */
  outerCount: number;
  /** First wall vertex (== 2 * outerCount). Wall quad q owns vertices wallStart + 4q .. + 3. */
  wallStart: number;
  vertexCount: number;
  /** Template vertex each vertex follows (outer, inner and wall alike). */
  templateIndex: Int32Array;
  /** LAYER_OUTER / LAYER_INNER / LAYER_WALL per vertex. */
  layer: Uint8Array;
  /** 1 for vertices on the inner surface (inner layer and the inner edge of every wall), else 0. */
  inner: Uint8Array;
  /** Template uv per vertex (three's SphereGeometry rule), so the equirect shell texture maps onto it. */
  uv: Float32Array;
  /** Rest-pose positions: outer = template position, inner = template position * (1 - thickness). */
  position: Float32Array;
  /**
   * Rest-pose unit normals: outer = radial, inner = -radial, wall = flat wall normal (tangent to the
   * sphere, away from the plate; all four vertices of a quad share it). Rotate walls with the plate.
   */
  normal: Float32Array;
  /** Triangle list; Uint16Array when vertexCount < 65536. */
  index: Uint16Array | Uint32Array;
  /** [outer, inner, walls] in index units, materialIndex 0 / 1 / 2. */
  groups: PlateGroup[];
  /**
   * Per wall quad: the plate on the other side (-1 for an open template border). Quad q's vertices are
   * [outer a, outer b, inner b, inner a] where a→b is the edge in the plate triangle's winding.
   */
  wallNeighbor: Int16Array;
};

export type PlateBuildStats = {
  templateTriangles: number;
  validTriangles: number;
  weldedVertices: number;
  edges: number;
  boundaryEdges: number;
  islandsMerged: number;
  emptyPlates: number;
  cachedTopology: boolean;
};

export type PlateBuildResult = {
  plates: PlateGeo[];
  /** Plate id per template triangle, -1 for triangles that collapse after welding. */
  triPlate: Int16Array;
  stats: PlateBuildStats;
};

// ---------------------------------------------------------------------------------------------------
// noise (verbatim from shell.ts so mesh borders wiggle like the painted ones)

function hash3(x: number, y: number, z: number) {
  let h = (x * 374761393 + y * 668265263 + z * 2147483647) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}
function vnoise(x: number, y: number, z: number) {
  const xi = Math.floor(x), yi = Math.floor(y), zi = Math.floor(z);
  const fx = x - xi, fy = y - yi, fz = z - zi;
  const sx = fx * fx * (3 - 2 * fx), sy = fy * fy * (3 - 2 * fy), sz = fz * fz * (3 - 2 * fz);
  let r = 0;
  for (let dz = 0; dz < 2; dz++) for (let dy = 0; dy < 2; dy++) for (let dx = 0; dx < 2; dx++) {
    const w = (dx ? sx : 1 - sx) * (dy ? sy : 1 - sy) * (dz ? sz : 1 - sz);
    r += w * hash3(xi + dx, yi + dy, zi + dz);
  }
  return r * 2 - 1;
}

// ---------------------------------------------------------------------------------------------------
// template topology (cached)

type Topo = {
  fp: number;
  posLen: number;
  idxLen: number;
  nv: number;
  ntri: number;
  /** 3 template vertex indices per triangle (copy of the index buffer). */
  tri: Int32Array;
  valid: Uint8Array;
  nValid: number;
  nWelded: number;
  weld: Int32Array;
  /** Unit direction per template vertex. */
  dir: Float32Array;
  /** Unit centroid direction per triangle. */
  triCen: Float32Array;
  /** Spherical area per triangle. */
  triArea: Float64Array;
  /** Neighbour triangle across side k (side k = tri[k] → tri[(k+1)%3]), -1 = none. */
  triNb: Int32Array;
  /** Each welded edge once: first triangle + side, second triangle + side (-1 = open border). */
  ne: number;
  eT0: Int32Array; eS0: Uint8Array; eT1: Int32Array; eS1: Uint8Array;
  warpKey: string;
  warp: Float32Array | null;
  uvKey: string;
  uv: Float32Array | null;
};

const topoCache = new WeakMap<Float32Array, Topo>();

function fingerprint(pos: Float32Array, idx: Uint32Array | Uint16Array) {
  const bits = new Int32Array(pos.buffer, pos.byteOffset, pos.length);
  let h = 0x811c9dc5 | 0;
  for (let i = 0; i < bits.length; i++) h = Math.imul(h ^ bits[i], 16777619);
  for (let i = 0; i < idx.length; i++) h = Math.imul(h ^ idx[i], 16777619);
  return h;
}

function buildTopo(pos: Float32Array, index: Uint32Array | Uint16Array, fp: number): Topo {
  const nv = (pos.length / 3) | 0, ntri = (index.length / 3) | 0;

  // unit directions + weld by quantised position (seam column and pole fans collapse to one vertex)
  const dir = new Float32Array(nv * 3);
  let scale = 0;
  for (let v = 0; v < nv; v++) {
    const x = pos[v * 3], y = pos[v * 3 + 1], z = pos[v * 3 + 2];
    const l = Math.sqrt(x * x + y * y + z * z) || 1;
    dir[v * 3] = x / l; dir[v * 3 + 1] = y / l; dir[v * 3 + 2] = z / l;
    const m = Math.max(Math.abs(x), Math.abs(y), Math.abs(z));
    if (m > scale) scale = m;
  }
  // cell = 2e-5 of the radius: far below the template's smallest real edge (~3e-3 at the pole ring)
  const inv = 1 / ((scale || 1) * 2e-5), OFF = 50001, B = 100003;
  const cells = new Map<number, number>();
  const weld = new Int32Array(nv);
  let nWelded = 0;
  for (let v = 0; v < nv; v++) {
    const qx = Math.round(pos[v * 3] * inv) + OFF, qy = Math.round(pos[v * 3 + 1] * inv) + OFF, qz = Math.round(pos[v * 3 + 2] * inv) + OFF;
    const key = (qx * B + qy) * B + qz;
    let id = cells.get(key);
    if (id === undefined) { id = nWelded++; cells.set(key, id); }
    weld[v] = id;
  }

  // triangles: validity, spherical area, centroid direction
  const tri = new Int32Array(ntri * 3);
  const valid = new Uint8Array(ntri);
  const triCen = new Float32Array(ntri * 3);
  const triArea = new Float64Array(ntri);
  let nValid = 0;
  for (let t = 0; t < ntri; t++) {
    const o = t * 3;
    const a = index[o], b = index[o + 1], c = index[o + 2];
    tri[o] = a; tri[o + 1] = b; tri[o + 2] = c;
    if (a >= nv || b >= nv || c >= nv) continue;
    const wa = weld[a], wb = weld[b], wc = weld[c];
    if (wa === wb || wb === wc || wa === wc) continue;
    const ax = dir[a * 3], ay = dir[a * 3 + 1], az = dir[a * 3 + 2];
    const bx = dir[b * 3], by = dir[b * 3 + 1], bz = dir[b * 3 + 2];
    const cx = dir[c * 3], cy = dir[c * 3 + 1], cz = dir[c * 3 + 2];
    // b × c, then a·(b × c): spherical excess (Van Oosterom & Strackee)
    const kx = by * cz - bz * cy, ky = bz * cx - bx * cz, kz = bx * cy - by * cx;
    const triple = ax * kx + ay * ky + az * kz;
    const ux = bx - ax, uy = by - ay, uz = bz - az, vx = cx - ax, vy = cy - ay, vz = cz - az;
    const fx = uy * vz - uz * vy, fy = uz * vx - ux * vz, fz = ux * vy - uy * vx;
    if (fx * fx + fy * fy + fz * fz < 1e-24) continue; // collinear after all
    const sx = ax + bx + cx, sy = ay + by + cy, sz = az + bz + cz;
    const sl = Math.sqrt(sx * sx + sy * sy + sz * sz);
    if (sl < 1e-12) continue;
    triCen[o] = sx / sl; triCen[o + 1] = sy / sl; triCen[o + 2] = sz / sl;
    triArea[t] = 2 * Math.atan2(Math.abs(triple), 1 + ax * bx + ay * by + az * bz + bx * cx + by * cy + bz * cz + cx * ax + cy * ay + cz * az);
    valid[t] = 1; nValid++;
  }

  // welded edges via open addressing (no per-edge objects)
  let size = 16;
  while (size < nValid * 4) size <<= 1;
  const mask = size - 1;
  const slot = new Int32Array(size); // edge id + 1
  const maxE = nValid * 3;
  const eLo = new Int32Array(maxE), eHi = new Int32Array(maxE);
  const eT0 = new Int32Array(maxE), eT1 = new Int32Array(maxE).fill(-1);
  const eS0 = new Uint8Array(maxE), eS1 = new Uint8Array(maxE);
  const triNb = new Int32Array(ntri * 3).fill(-1);
  let ne = 0;
  for (let t = 0; t < ntri; t++) {
    if (!valid[t]) continue;
    const o = t * 3;
    for (let k = 0; k < 3; k++) {
      const wa = weld[tri[o + k]], wb = weld[tri[o + (k === 2 ? 0 : k + 1)]];
      const lo = wa < wb ? wa : wb, hi = wa < wb ? wb : wa;
      let h = (Math.imul(lo, 0x9e3779b1) + hi) | 0;
      h ^= h >>> 15; h = Math.imul(h, 0x85ebca6b); h ^= h >>> 13;
      h &= mask;
      let e = -1;
      while (slot[h] !== 0) {
        const c = slot[h] - 1;
        if (eLo[c] === lo && eHi[c] === hi) { e = c; break; }
        h = (h + 1) & mask;
      }
      if (e >= 0 && eT1[e] < 0) {
        eT1[e] = t; eS1[e] = k;
        triNb[o + k] = eT0[e]; triNb[eT0[e] * 3 + eS0[e]] = t;
        continue;
      }
      // new edge; a third triangle on an edge (non-manifold) gets its own open edge, never hashed
      const n = ne++;
      eLo[n] = lo; eHi[n] = hi; eT0[n] = t; eS0[n] = k;
      if (e < 0) slot[h] = n + 1;
    }
  }

  return {
    fp, posLen: pos.length, idxLen: index.length, nv, ntri, tri, valid, nValid, nWelded, weld, dir, triCen, triArea, triNb,
    ne, eT0, eS0, eT1, eS1, warpKey: "", warp: null, uvKey: "", uv: null,
  };
}

function warpedCentroids(topo: Topo, jitter: number, freq: number): Float32Array {
  const key = jitter + "|" + freq;
  if (topo.warp && topo.warpKey === key) return topo.warp;
  const { ntri, valid, triCen } = topo;
  const w = new Float32Array(ntri * 3);
  for (let t = 0; t < ntri; t++) {
    if (!valid[t]) continue;
    const o = t * 3, x = triCen[o], y = triCen[o + 1], z = triCen[o + 2];
    if (jitter === 0) { w[o] = x; w[o + 1] = y; w[o + 2] = z; continue; }
    w[o] = x + jitter * vnoise(x * freq + 3.1, y * freq, z * freq);
    w[o + 1] = y + jitter * vnoise(x * freq, y * freq + 5.7, z * freq);
    w[o + 2] = z + jitter * vnoise(x * freq, y * freq, z * freq + 9.3);
  }
  topo.warp = w; topo.warpKey = key;
  return w;
}

/** three r170 SphereGeometry uv: u = ix/W (± half a segment on the pole rows), v = 1 - iy/H. */
function templateUv(topo: Topo, W: number, H: number): Float32Array {
  const key = W + "x" + H;
  if (topo.uv && topo.uvKey === key) return topo.uv;
  if ((W + 1) * (H + 1) !== topo.nv) {
    throw new Error(`buildShellPlates: ${topo.nv} vertices is not a ${W}x${H} SphereGeometry; pass input.uv`);
  }
  const uv = new Float32Array(topo.nv * 2);
  for (let iy = 0; iy <= H; iy++) {
    const uOff = iy === 0 ? 0.5 / W : iy === H ? -0.5 / W : 0;
    for (let ix = 0; ix <= W; ix++) {
      const i = iy * (W + 1) + ix;
      uv[i * 2] = ix / W + uOff;
      uv[i * 2 + 1] = 1 - iy / H;
    }
  }
  topo.uv = uv; topo.uvKey = key;
  return uv;
}

/** Keeps each plate's largest connected piece; other pieces join the neighbour they share most edges with. */
function mergeIslands(topo: Topo, triPlate: Int16Array, nPlates: number): number {
  const { ntri, valid, triNb } = topo;
  const comp = new Int32Array(ntri);
  const order = new Int32Array(topo.nValid);
  const compStart = new Int32Array(topo.nValid + 1);
  const best = new Int32Array(nPlates), bestSize = new Int32Array(nPlates);
  const vote = new Int32Array(nPlates);
  const touched = new Int32Array(nPlates);
  let merged = 0;
  for (let pass = 0; pass < 4; pass++) {
    comp.fill(-1); best.fill(-1); bestSize.fill(0);
    let nc = 0, tail = 0;
    for (let s = 0; s < ntri; s++) {
      if (!valid[s] || comp[s] >= 0) continue;
      const p = triPlate[s];
      compStart[nc] = tail;
      let head = tail;
      order[tail++] = s; comp[s] = nc;
      while (head < tail) {
        const t = order[head++];
        for (let k = 0; k < 3; k++) {
          const u = triNb[t * 3 + k];
          if (u >= 0 && comp[u] < 0 && triPlate[u] === p) { comp[u] = nc; order[tail++] = u; }
        }
      }
      const sz = tail - compStart[nc];
      if (sz > bestSize[p]) { bestSize[p] = sz; best[p] = nc; }
      nc++;
    }
    compStart[nc] = tail;
    let changed = 0;
    for (let c = 0; c < nc; c++) {
      const first = order[compStart[c]];
      const p = triPlate[first];
      if (best[p] === c) continue;
      let nt = 0, top = -1, topVotes = 0;
      for (let i = compStart[c]; i < compStart[c + 1]; i++) {
        const t = order[i];
        for (let k = 0; k < 3; k++) {
          const u = triNb[t * 3 + k];
          if (u < 0) continue;
          const q = triPlate[u];
          if (q === p) continue;
          if (vote[q] === 0) touched[nt++] = q;
          vote[q]++;
          if (vote[q] > topVotes || (vote[q] === topVotes && q < top)) { topVotes = vote[q]; top = q; }
        }
      }
      for (let i = 0; i < nt; i++) vote[touched[i]] = 0;
      if (top < 0) continue;
      for (let i = compStart[c]; i < compStart[c + 1]; i++) triPlate[order[i]] = top;
      changed++;
    }
    merged += changed;
    if (!changed) break;
  }
  return merged;
}

// ---------------------------------------------------------------------------------------------------

export function buildShellPlates(input: PlateBuildInput): PlateBuildResult {
  const { positions, index, seeds } = input;
  const thickness = input.thickness;
  const jitter = input.jitter ?? 0.09;
  const freq = input.noiseFreq ?? 7;
  const nPlates = (seeds.length / 3) | 0;
  if (nPlates < 1 || nPlates > 32767) throw new Error(`buildShellPlates: need 1..32767 seeds, got ${nPlates}`);
  if (!(thickness >= 0 && thickness < 1)) throw new Error(`buildShellPlates: thickness must be in [0, 1), got ${thickness}`);

  const fp = fingerprint(positions, index);
  const hit = topoCache.get(positions);
  const cachedTopology = !!hit && hit.fp === fp && hit.posLen === positions.length && hit.idxLen === index.length;
  const topo = cachedTopology && hit ? hit : buildTopo(positions, index, fp);
  if (!cachedTopology) topoCache.set(positions, topo);
  const { nv, ntri, tri, valid, dir, triCen, triArea } = topo;
  let uv = input.uv;
  if (uv && uv.length < nv * 2) throw new Error("buildShellPlates: uv is shorter than 2 * vertexCount");
  if (!uv) uv = templateUv(topo, input.widthSegments ?? 96, input.heightSegments ?? 64);

  // unit seeds (argmax against the warped centroid, exactly like the texture's per-texel Voronoi)
  const sd = new Float64Array(nPlates * 3);
  for (let s = 0; s < nPlates; s++) {
    const x = seeds[s * 3], y = seeds[s * 3 + 1], z = seeds[s * 3 + 2];
    const l = Math.sqrt(x * x + y * y + z * z) || 1;
    sd[s * 3] = x / l; sd[s * 3 + 1] = y / l; sd[s * 3 + 2] = z / l;
  }
  const warp = warpedCentroids(topo, jitter, freq);
  const triPlate = new Int16Array(ntri).fill(-1);
  for (let t = 0; t < ntri; t++) {
    if (!valid[t]) continue;
    const wx = warp[t * 3], wy = warp[t * 3 + 1], wz = warp[t * 3 + 2];
    let bestS = 0, bd = -Infinity;
    for (let s = 0, o = 0; s < nPlates; s++, o += 3) {
      const dp = sd[o] * wx + sd[o + 1] * wy + sd[o + 2] * wz;
      if (dp > bd) { bd = dp; bestS = s; }
    }
    triPlate[t] = bestS;
  }
  const islandsMerged = input.mergeIslands === false ? 0 : mergeIslands(topo, triPlate, nPlates);

  // plate → triangles (CSR)
  const triStart = new Int32Array(nPlates + 1);
  for (let t = 0; t < ntri; t++) if (triPlate[t] >= 0) triStart[triPlate[t] + 1]++;
  for (let p = 0; p < nPlates; p++) triStart[p + 1] += triStart[p];
  const triList = new Int32Array(triStart[nPlates]);
  const cursor = triStart.slice(0, nPlates);
  for (let t = 0; t < ntri; t++) if (triPlate[t] >= 0) triList[cursor[triPlate[t]]++] = t;

  // plate → boundary half-edges (CSR): one per side of every edge whose triangles disagree
  const { ne, eT0, eS0, eT1, eS1 } = topo;
  const halfStart = new Int32Array(nPlates + 1);
  let boundaryEdges = 0;
  for (let e = 0; e < ne; e++) {
    const p0 = triPlate[eT0[e]], p1 = eT1[e] >= 0 ? triPlate[eT1[e]] : -1;
    if (p0 === p1) continue;
    boundaryEdges++;
    halfStart[p0 + 1]++;
    if (p1 >= 0) halfStart[p1 + 1]++;
  }
  for (let p = 0; p < nPlates; p++) halfStart[p + 1] += halfStart[p];
  const nHalf = halfStart[nPlates];
  const halfTri = new Int32Array(nHalf), halfSide = new Uint8Array(nHalf), halfNb = new Int16Array(nHalf);
  const hcur = halfStart.slice(0, nPlates);
  for (let e = 0; e < ne; e++) {
    const p0 = triPlate[eT0[e]], p1 = eT1[e] >= 0 ? triPlate[eT1[e]] : -1;
    if (p0 === p1) continue;
    let h = hcur[p0]++;
    halfTri[h] = eT0[e]; halfSide[h] = eS0[e]; halfNb[h] = p1;
    if (p1 >= 0) { h = hcur[p1]++; halfTri[h] = eT1[e]; halfSide[h] = eS1[e]; halfNb[h] = p0; }
  }

  // emit one closed solid per plate
  const stamp = new Int32Array(nv), local = new Int32Array(nv), order = new Int32Array(nv);
  const nbStamp = new Int32Array(nPlates);
  const inScale = 1 - thickness;
  const plates: PlateGeo[] = new Array(nPlates);
  let emptyPlates = 0;
  for (let p = 0; p < nPlates; p++) {
    const tBeg = triStart[p], tEnd = triStart[p + 1], nt = tEnd - tBeg;
    const hBeg = halfStart[p], hEnd = halfStart[p + 1], nq = hEnd - hBeg;
    const mark = p + 1;
    let no = 0, cx = 0, cy = 0, cz = 0, area = 0;
    for (let i = tBeg; i < tEnd; i++) {
      const t = triList[i], o = t * 3;
      for (let k = 0; k < 3; k++) {
        const v = tri[o + k];
        if (stamp[v] !== mark) { stamp[v] = mark; local[v] = no; order[no++] = v; }
      }
      const A = triArea[t];
      area += A; cx += A * triCen[o]; cy += A * triCen[o + 1]; cz += A * triCen[o + 2];
    }
    const cl = Math.sqrt(cx * cx + cy * cy + cz * cz);
    if (cl > 1e-12) { cx /= cl; cy /= cl; cz /= cl; } else { cx = sd[p * 3]; cy = sd[p * 3 + 1]; cz = sd[p * 3 + 2]; }
    if (nt === 0) emptyPlates++;

    const wallStart = 2 * no, vc = wallStart + 4 * nq;
    const templateIndex = new Int32Array(vc), layer = new Uint8Array(vc), inner = new Uint8Array(vc);
    const puv = new Float32Array(vc * 2), position = new Float32Array(vc * 3), normal = new Float32Array(vc * 3);
    const nIdx = 6 * nt + 6 * nq;
    const pIndex = vc < 65536 ? new Uint16Array(nIdx) : new Uint32Array(nIdx);
    const wallNeighbor = new Int16Array(nq);

    // outer + inner vertices
    let minDot = 1;
    for (let j = 0; j < no; j++) {
      const v = order[j], jj = j + no;
      templateIndex[j] = v; templateIndex[jj] = v;
      layer[jj] = LAYER_INNER; inner[jj] = 1;
      puv[j * 2] = puv[jj * 2] = uv[v * 2]; puv[j * 2 + 1] = puv[jj * 2 + 1] = uv[v * 2 + 1];
      const px = positions[v * 3], py = positions[v * 3 + 1], pz = positions[v * 3 + 2];
      const dx = dir[v * 3], dy = dir[v * 3 + 1], dz = dir[v * 3 + 2];
      position[j * 3] = px; position[j * 3 + 1] = py; position[j * 3 + 2] = pz;
      position[jj * 3] = px * inScale; position[jj * 3 + 1] = py * inScale; position[jj * 3 + 2] = pz * inScale;
      normal[j * 3] = dx; normal[j * 3 + 1] = dy; normal[j * 3 + 2] = dz;
      normal[jj * 3] = -dx; normal[jj * 3 + 1] = -dy; normal[jj * 3 + 2] = -dz;
      const d = dx * cx + dy * cy + dz * cz;
      if (d < minDot) minDot = d;
    }

    // outer triangles keep the template winding, inner ones are reversed
    const innerOff = 3 * nt;
    for (let i = tBeg, w = 0; i < tEnd; i++, w += 3) {
      const o = triList[i] * 3;
      const a = local[tri[o]], b = local[tri[o + 1]], c = local[tri[o + 2]];
      pIndex[w] = a; pIndex[w + 1] = b; pIndex[w + 2] = c;
      pIndex[innerOff + w] = a + no; pIndex[innerOff + w + 1] = c + no; pIndex[innerOff + w + 2] = b + no;
    }

    // walls: quad [Oa, Ob, Ib, Ia] for edge a→b of the plate's own triangle; tris (Oa,Ib,Ob) (Oa,Ia,Ib)
    // face (b - a) × radial = b × a, i.e. away from that triangle and tangent to the sphere.
    for (let h = hBeg, q = 0, wi = 6 * nt; h < hEnd; h++, q++, wi += 6) {
      const o = halfTri[h] * 3, k = halfSide[h];
      const va = tri[o + k], vb = tri[o + (k === 2 ? 0 : k + 1)];
      wallNeighbor[q] = halfNb[h];
      const ax = dir[va * 3], ay = dir[va * 3 + 1], az = dir[va * 3 + 2];
      const bx = dir[vb * 3], by = dir[vb * 3 + 1], bz = dir[vb * 3 + 2];
      let nx = by * az - bz * ay, ny = bz * ax - bx * az, nz = bx * ay - by * ax;
      let nl = Math.sqrt(nx * nx + ny * ny + nz * nz);
      if (nl < 1e-12) { nx = bx - ax; ny = by - ay; nz = bz - az; nl = Math.sqrt(nx * nx + ny * ny + nz * nz) || 1; }
      nx /= nl; ny /= nl; nz /= nl;
      const base = wallStart + 4 * q;
      for (let c = 0; c < 4; c++) {
        const s = base + c, v = c === 0 || c === 3 ? va : vb, isIn = c >= 2;
        const sc = isIn ? inScale : 1;
        templateIndex[s] = v; layer[s] = LAYER_WALL; inner[s] = isIn ? 1 : 0;
        puv[s * 2] = uv[v * 2]; puv[s * 2 + 1] = uv[v * 2 + 1];
        position[s * 3] = positions[v * 3] * sc; position[s * 3 + 1] = positions[v * 3 + 1] * sc; position[s * 3 + 2] = positions[v * 3 + 2] * sc;
        normal[s * 3] = nx; normal[s * 3 + 1] = ny; normal[s * 3 + 2] = nz;
      }
      pIndex[wi] = base; pIndex[wi + 1] = base + 2; pIndex[wi + 2] = base + 1;
      pIndex[wi + 3] = base; pIndex[wi + 4] = base + 3; pIndex[wi + 5] = base + 2;
    }

    const neighbors: number[] = [];
    for (let h = hBeg; h < hEnd; h++) {
      const q = halfNb[h];
      if (q >= 0 && nbStamp[q] !== mark) { nbStamp[q] = mark; neighbors.push(q); }
    }
    neighbors.sort((x, y) => x - y);

    plates[p] = {
      id: p,
      centroid: [cx, cy, cz],
      area,
      triangleCount: nt,
      boundaryEdgeCount: nq,
      neighbors,
      angularRadius: no ? Math.acos(Math.max(-1, Math.min(1, minDot))) : 0,
      outerCount: no,
      wallStart,
      vertexCount: vc,
      templateIndex, layer, inner, uv: puv, position, normal,
      index: pIndex,
      groups: [
        { start: 0, count: 3 * nt, materialIndex: 0 },
        { start: 3 * nt, count: 3 * nt, materialIndex: 1 },
        { start: 6 * nt, count: 6 * nq, materialIndex: 2 },
      ],
      wallNeighbor,
    };
  }

  return {
    plates,
    triPlate,
    stats: {
      templateTriangles: ntri, validTriangles: topo.nValid, weldedVertices: topo.nWelded, edges: ne,
      boundaryEdges, islandsMerged, emptyPlates, cachedTopology,
    },
  };
}

/**
 * Poses one plate from the deformed full sphere (ball mesh position + normal arrays, indexed like the
 * template): outer = src, inner = src - thickness * n with the normal flipped, walls = the same corners
 * with the flat normal of the posed quad (rest normal when the quad collapses). Writes every vertex of
 * `outPos` / `outNormal` (3 * plate.vertexCount each). With the undeformed template it reproduces
 * plate.position / plate.normal.
 */
export function poseShellPlate(
  plate: PlateGeo, srcPos: ArrayLike<number>, srcNormal: ArrayLike<number>, thickness: number,
  outPos: Float32Array, outNormal: Float32Array,
) {
  const { outerCount: no, wallStart, vertexCount: vc, templateIndex: TI, normal: rest } = plate;
  for (let j = 0; j < no; j++) {
    const v = TI[j] * 3, o = j * 3, i = (j + no) * 3;
    const nx = srcNormal[v], ny = srcNormal[v + 1], nz = srcNormal[v + 2];
    const px = srcPos[v], py = srcPos[v + 1], pz = srcPos[v + 2];
    outPos[o] = px; outPos[o + 1] = py; outPos[o + 2] = pz;
    outNormal[o] = nx; outNormal[o + 1] = ny; outNormal[o + 2] = nz;
    outPos[i] = px - thickness * nx; outPos[i + 1] = py - thickness * ny; outPos[i + 2] = pz - thickness * nz;
    outNormal[i] = -nx; outNormal[i + 1] = -ny; outNormal[i + 2] = -nz;
  }
  for (let base = wallStart; base < vc; base += 4) {
    for (let c = 0; c < 4; c++) {
      const s = (base + c) * 3, v = TI[base + c] * 3, k = c >= 2 ? thickness : 0;
      outPos[s] = srcPos[v] - k * srcNormal[v];
      outPos[s + 1] = srcPos[v + 1] - k * srcNormal[v + 1];
      outPos[s + 2] = srcPos[v + 2] - k * srcNormal[v + 2];
    }
    // quad loop Oa → Ia → Ib → Ob: normal ∝ (Ib - Oa) × (Ob - Ia)
    const oa = base * 3, ob = oa + 3, ib = oa + 6, ia = oa + 9;
    const ux = outPos[ib] - outPos[oa], uy = outPos[ib + 1] - outPos[oa + 1], uz = outPos[ib + 2] - outPos[oa + 2];
    const wx = outPos[ob] - outPos[ia], wy = outPos[ob + 1] - outPos[ia + 1], wz = outPos[ob + 2] - outPos[ia + 2];
    let nx = uy * wz - uz * wy, ny = uz * wx - ux * wz, nz = ux * wy - uy * wx;
    const l = Math.sqrt(nx * nx + ny * ny + nz * nz);
    if (l > 1e-12) { nx /= l; ny /= l; nz /= l; } else { nx = rest[oa]; ny = rest[oa + 1]; nz = rest[oa + 2]; }
    for (let c = 0; c < 12; c += 3) { outNormal[oa + c] = nx; outNormal[oa + c + 1] = ny; outNormal[oa + c + 2] = nz; }
  }
}
