import HeroCanvas from "./components/HeroCanvas";
import Navbar from "@/components/Navbar";

export default function Home() {
  return (
    <main className="relative w-full h-screen overflow-hidden">
      <Navbar />
      <HeroCanvas />
    </main>
  );
}
