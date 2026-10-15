import { NavLink } from "react-router-dom";

const linkClass = ({ isActive }: { isActive: boolean }) =>
  [
    "pointer-events-auto select-none whitespace-nowrap rounded-full px-3 sm:px-4 py-2 text-sm font-semibold tracking-tight transition cursor-pointer",
    isActive
      ? "bg-black text-white shadow-md"
      : "bg-white/70 text-black/80 shadow-md backdrop-blur hover:bg-white hover:text-black",
  ].join(" ");

export default function Navbar() {
  return (
    <header className="pointer-events-none fixed top-0 left-0 right-0 z-[10]">
      <nav className="flex items-center justify-center gap-2 sm:gap-3 px-3 sm:px-6 md:px-10 py-4">
        <NavLink to="/" end className={linkClass}>
          그냥볼
        </NavLink>

        <button
          type="button"
          aria-label="새로고침"
          onClick={() => window.location.reload()}
          className="pointer-events-auto flex h-11 w-11 items-center justify-center rounded-full bg-white/80 text-black shadow-md backdrop-blur transition hover:bg-white active:scale-95 cursor-pointer"
        >
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M21 12a9 9 0 1 1-2.64-6.36" />
            <path d="M21 3v6h-6" />
          </svg>
        </button>

        <NavLink to="/wakbbu" className={linkClass}>
          왁뿌볼
        </NavLink>

        <NavLink to="/king" className={linkClass}>
          왕왁뿌볼
        </NavLink>
      </nav>
    </header>
  );
}
