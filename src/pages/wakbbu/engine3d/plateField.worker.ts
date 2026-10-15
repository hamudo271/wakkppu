/// Background thread for the heavy per-ball precomputation (crack field, detail normal map),
/// so a ball's first touch never waits for it. Bundled by Vite as a separate module worker.
import { computeField } from "./plateField";
import { waxNormalMap } from "./detail";

type Req =
  | { id: number; kind: "field"; seeds: Float32Array }
  | { id: number; kind: "detail"; seed: number; w: number; h: number };

const post = (msg: unknown, transfer: ArrayBuffer[] = []) =>
  (self as unknown as { postMessage(m: unknown, t: ArrayBuffer[]): void }).postMessage(msg, transfer);

self.onmessage = (e: MessageEvent<Req>) => {
  const m = e.data;
  try {
    if (m.kind === "field") {
      const r = computeField(m.seeds);
      post({ id: m.id, ok: true, result: r }, [r.ids.buffer, r.dist.buffer, r.area.buffer]);
    } else {
      const n = waxNormalMap(m.w, m.h, m.seed);
      post({ id: m.id, ok: true, result: n }, [n.buffer]);
    }
  } catch (err) {
    post({ id: m.id, ok: false, error: String(err) });
  }
};
