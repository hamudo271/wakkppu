import { useEffect, useRef } from "react";

type SpheresBg = {
  spheres: {
    config: { gravity: number };
    setColors: (colors: number[]) => void;
  };
  dispose?: () => void;
};

declare global {
  interface Window {
    __spheresBg?: SpheresBg | null;
  }
}

export default function HeroCanvas() {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    let bg: SpheresBg | null = null;
    let cancelled = false;

    const init = async () => {
      const canvas = canvasRef.current;
      if (!canvas) return;

      try {
        const mod = await import(
          /* @vite-ignore */
          "https://cdn.jsdelivr.net/npm/threejs-components@0.0.17/build/backgrounds/spheres1.cdn.min.js"
        );
        if (cancelled) return;

        const Spheres1Background = mod.default || mod;
        bg = Spheres1Background(canvas, {
          count: window.innerWidth < 700 ? 70 : 150, // phones have a narrow world, so fewer balls
          minSize: 0.3,
          maxSize: 1,
          gravity: 0,
        });
        window.__spheresBg = bg;
      } catch (err) {
        console.error("Failed to load spheres background", err);
      }
    };

    init();

    return () => {
      cancelled = true;
      if (bg && typeof bg.dispose === "function") {
        bg.dispose();
      }
      window.__spheresBg = null;
    };
  }, []);

  return <canvas ref={canvasRef} id="webgl-canvas" className="hero-canvas" />;
}