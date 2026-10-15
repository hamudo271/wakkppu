import Navbar from "@/components/Navbar";
import WaxBallCanvas from "../wakbbu/components/WaxBallCanvas";

/** 왕왁뿌볼: one 왁뿌볼 three times the size, all to yourself. */
export default function King() {
  return (
    <main className="relative w-full h-dvh overflow-hidden">
      <Navbar />
      <WaxBallCanvas mode="king" />
    </main>
  );
}
