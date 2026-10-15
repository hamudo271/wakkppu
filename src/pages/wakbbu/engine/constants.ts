// Every tunable of the 왁뿌볼 crush engine. Lengths are in R (ball radius, CSS px) unless noted.

export const N = 64; // rim points
export const SUBSTEPS = 6;
export const DT = 1 / 60;
export const ACC_CLAMP = 0.1;
export const MAX_STEPS = 4;

export const TOP_WALL = 90; // px, keeps balls clear of the navbar pills
export const BOTTOM_RESERVE = 56; // px kept clear above the bottom edge for the "뿌순 개수" counter
export const BOTTOM_RESERVE_MOBILE = 64;

export const DRIFT_MAX = 40; // px/s
export const DAMP = 0.9975; // per 1/60 s
export const WALL_REST = 0.5;
export const DRAG = 1.6; // velocity damping per second
export const WALL_PUSH = 6; // inward push near a wall, R/s²
export const REPEL = 8; // ball-to-ball spacing push
export const REPEL_RANGE = 1.45; // …acting within this multiple of the contact distance
export const HOVER_RADIUS = 1.4;
export const HOVER_PUSH = 0.3; // R per second

export const FINGER_R = 0.45; // finger disc radius in R

// dent depth (fraction of R) per beat
export const D_PRESS = 0.05;
export const D_RESIST = 0.14;
export const D_CRACK = 0.2;
export const D_POP = 0.34;
export const D_CLAY_MAX = 0.45;
export const D_CLAY_RATE = 0.34; // R per second
export const SIGMA_SHELL = 0.45; // rad
export const SIGMA_CLAY = 0.6;

export const S_RESIST = 0.92;
export const S_CRACK = 0.88;
export const S_POP = 0.64;
export const SQUASH_TAU = 0.04; // s
export const RELEASE_KEEP = 0.87;
export const RELEASE_TAU = 0.2;

export const GAUGE_DOWN = 0.1;
export const GAUGE_REPRESS = 0.2;
export const GAUGE_GAIN = 1.6; // per second
export const GAUGE_DECAY = 0.6;
export const GAUGE_CRACK = 0.3;
export const GAUGE_POP = 0.7;
export const HOLD_CRACK_MS = 90;
export const HOLD_POP_MS = 250;
export const REPRESS_WINDOW_MS = 400;

export const POP_MS = 90;
export const SLOWMO_MS = 220;
export const SLOWMO_SCALE = 0.35;
export const PUNCH_MS = 160;
export const SHAKE_PX = 2;
export const SHAKE_MS = 120;

export const BURST_MIN_MS = 260;
export const BURST_MAX_MS = 420;
export const DRAG_THRESHOLD = 9; // px

export const CLAY_FRACTION = 0.65;
export const LUMP_HOLD_MS = 1200; // the crushed lump stays this long after the finger lifts…
export const LUMP_FADE_MS = 400; // …then falls apart and fades
export const RESPAWN_MS = 300;

export const DETACH_BUDGET = 0.25; // at most this share of a ball's plates ever falls off

// 끈끈하게: dragging a popped ball peels cracked plates along on short clay necks (lengths in R)
export const NECK_LAG_MIN = 0.1; // a peeled chip trails the finger by 0.1–0.25 R…
export const NECK_LAG_MAX = 0.25;
export const NECK_SNAP_MIN = 0.28; // …and its neck snaps (툭) after 0.28–0.5 R of stretch
export const NECK_SNAP_MAX = 0.5;
export const NECK_WAIST_MIN = 0.45; // waist radius right before the snap, as a fraction of the rest radius
export const NECK_V_MIN = 0.5; // finger speed over the ball (R/s) needed to peel a plate
export const NECK_MAX_ACTIVE = 2; // stretching necks per ball at once
export const NECK_GRAB_MS = 170; // min gap between two peels on one ball
export const NECK_RETRACT_MS = 120; // the snapped stub sinks back into the ball
export const CHIP_MAX = 10; // chips per ball, embedded ones included
export const CHIP_DROP_MAX = 1.5; // a detached chip falls at most this far while it fades
export const CHIP_FADE_MS = 450;

export const CLAY = "#EFE9DC";
export const CLAY_DARK = "#D9D2C3";
export const CLAY_SHEEN = "#F7F3EA";
export const CLAY_MUD = "#E3DCCB";
export const FRACTURE = "#F4F6F8";
export const CRUMB = "#E8EAF0";
export const CRAZE = "#F7F8FA";

export type ShellVariant = {
  name: string;
  base: string;
  swirl: [string, string];
  light: boolean; // light shells get darker fracture edges
  core: string; // the clay inside: always far from the shell colour, so cracking it open shows something new
};

export const VARIANTS: ShellVariant[] = [
  { name: "cobalt", base: "#3A4FE0", swirl: ["#6C7CF2", "#1E2DB0"], light: false, core: "#F4B63F" },
  { name: "ink", base: "#202236", swirl: ["#343759", "#0F1020"], light: false, core: "#F27A6B" },
  { name: "milk", base: "#F2F3F7", swirl: ["#E3E6EE", "#FAFBFF"], light: true, core: "#B23A24" },
  { name: "steel", base: "#AEB4C2", swirl: ["#C9CED9", "#8E95A6"], light: true, core: "#E2711F" },
  { name: "tricolour", base: "#3A4FE0", swirl: ["#F2F3F7", "#AEB4C2"], light: false, core: "#E5537F" },
];

/**
 * How fast a ball breaks, counted in presses (the press in progress included).
 * Press 1 only draws hairlines unless held past `crackHoldMs`; the shell opens on `crackPress`, pops on
 * `popPress`, and the crush needs `crushPress` presses, so a ball lasts several touches.
 */
export type Pace = {
  crackPress: number;
  crackHoldMs: number;
  popPress: number;
  crushPress: number;
  popFrac: [number, number]; // share of the plates the 뽀각 cracks
  burstsPerPress: number; // later crack events allowed per press after the pop
  burstPlates: [number, number];
  crazeMax: number; // hairline events per press (they spread wider with every press)
  hairS: number; // hairline fade-in time
  openTau: number; // s, crack opening ease
  crushTau: number; // s, the petals opening at the crush
  crushMorphMs: number; // the lump settling into its crushed shape
  seeds: [number, number]; // plates per ball
  seg: [number, number]; // sphere segments
};

export const PACE: Pace = {
  crackPress: 2, crackHoldMs: 500, popPress: 3, crushPress: 6,
  popFrac: [0.2, 0.28], burstsPerPress: 2, burstPlates: [1, 2], crazeMax: 5, hairS: 0.08,
  openTau: 0.06, crushTau: 0.16, crushMorphMs: 260,
  seeds: [30, 39], seg: [96, 64],
};

/** 왕왁뿌볼: one ball three times the size, more and finer plates, and it breaks more slowly. */
export const KING_PACE: Pace = {
  crackPress: 2, crackHoldMs: 700, popPress: 4, crushPress: 9,
  popFrac: [0.14, 0.2], burstsPerPress: 2, burstPlates: [1, 2], crazeMax: 7, hairS: 0.16,
  openTau: 0.12, crushTau: 0.3, crushMorphMs: 420,
  seeds: [50, 60], seg: [128, 96],
};

export const MOBILE_WIDTH = 700;

export function ballRadiusBase(w: number, h: number) {
  const desktop = Math.min(130, Math.max(44, 0.11 * Math.min(w, h)));
  // portrait phones get much bigger balls (thumb-sized targets), 15% under double so two fit side by side
  let r = w < MOBILE_WIDTH && h >= w ? desktop * 2 * 0.85 : desktop;
  // never bigger than the grid can hold with room to squash and move (small phones in landscape, short windows)
  const n = ballCount(w), cols = n > 4 ? 3 : 2, rows = Math.ceil(n / cols);
  const playH = h - TOP_WALL - (w < MOBILE_WIDTH ? BOTTOM_RESERVE_MOBILE : BOTTOM_RESERVE);
  r = Math.min(r, w / cols / 2 / 1.25, playH / rows / 2 / 1.15);
  return Math.max(20, r);
}
export function ballCount(w: number) {
  return w < MOBILE_WIDTH ? 4 : 6;
}

/** 왕왁뿌볼 radius: three normal balls wide, but never past the screen (it still has to squash and drift). */
export function kingRadius(w: number, h: number) {
  const desktop = Math.min(130, Math.max(44, 0.11 * Math.min(w, h)));
  const normal = w < MOBILE_WIDTH && h >= w ? desktop * 2 * 0.85 : desktop;
  const playH = h - TOP_WALL - (w < MOBILE_WIDTH ? BOTTOM_RESERVE_MOBILE : BOTTOM_RESERVE);
  return Math.max(40, Math.min(normal * 3, (w / 2 - 10) / 1.1, playH / 2 / 1.12));
}
