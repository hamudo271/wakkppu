import { useEffect, useRef, useState } from "react";
import { Engine3D, type EngineMode } from "../engine3d/Engine3D";

export default function WaxBallCanvas({ mode = "normal" }: { mode?: EngineMode }) {
  const ref = useRef<HTMLCanvasElement | null>(null);
  const eng = useRef<Engine3D | null>(null);
  const [count, setCount] = useState(0);
  const [needSound, setNeedSound] = useState(false);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    const c = ref.current;
    if (!c) return;
    const e = new Engine3D(c, { onCrushed: setCount, onAudioState: (r) => setNeedSound(!r) }, mode);
    eng.current = e;
    (window as Window & { __wakbbu?: Engine3D }).__wakbbu = e; // debugging handle
    e.init().catch((err) => { console.error("왁뿌볼 engine failed to start", err); setFailed(true); });
    return () => {
      e.dispose();
      eng.current = null;
      const w = window as Window & { __wakbbu?: Engine3D };
      if (w.__wakbbu === e) delete w.__wakbbu;
    };
  }, [mode]);

  return (
    <>
      <canvas ref={ref} className="fixed inset-0 z-[1] touch-none select-none" style={{ WebkitTouchCallout: "none" }} />
      <div className="pointer-events-none fixed bottom-5 left-5 z-[10] select-none text-sm font-semibold text-black/70">
        뿌순 개수 <span className="tabular-nums">{count}</span>
      </div>
      {failed && (
        <div className="pointer-events-none fixed inset-0 z-[5] flex items-center justify-center px-6 text-center text-sm font-semibold text-black/60">
          이 브라우저에서는 3D 그래픽(WebGL)을 쓸 수 없어서 왁뿌볼을 띄우지 못했어요.
        </div>
      )}
      {needSound && (
        <button
          type="button"
          onClick={() => eng.current?.unlockAudio()}
          className="pointer-events-auto fixed right-5 top-20 z-[10] cursor-pointer rounded-full bg-white/80 px-3 py-1 text-xs font-semibold shadow-md backdrop-blur"
        >
          소리 켜기
        </button>
      )}
    </>
  );
}
