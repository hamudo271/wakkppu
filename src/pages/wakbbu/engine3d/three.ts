// three.js is loaded from the same CDN module the 그냥볼 page uses, so the browser shares the cache
// and the project keeps zero npm dependencies for it.
export type ThreeNS = any;

const THREE_URL = "https://cdn.jsdelivr.net/npm/three@0.170.0/+esm";
const ROOM_URL = "https://cdn.jsdelivr.net/npm/three@0.170.0/examples/jsm/environments/RoomEnvironment.js/+esm";

let cached: Promise<{ THREE: ThreeNS; RoomEnvironment: any }> | null = null;

export function loadThree() {
  if (!cached) {
    cached = Promise.all([
      import(/* @vite-ignore */ THREE_URL),
      import(/* @vite-ignore */ ROOM_URL),
    ]).then(([three, room]) => ({ THREE: three, RoomEnvironment: room.RoomEnvironment }));
  }
  return cached;
}
