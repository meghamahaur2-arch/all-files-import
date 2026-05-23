import { useRef, useState } from "react";
import { motion, useScroll, useTransform } from "framer-motion";
import { Volume2, VolumeX } from "lucide-react";

const VIDEO_SRC = "/demo.mp4";

export function ScrollyVideo() {
  const containerRef = useRef<HTMLDivElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const [muted, setMuted] = useState(true);

  const toggleMuted = () => {
    const v = videoRef.current;
    if (!v) return;
    const next = !muted;
    v.muted = next;
    setMuted(next);
    // Some browsers pause when audio context changes; ensure playback continues.
    if (!next) {
      const p = v.play();
      if (p && typeof p.catch === "function") p.catch(() => {});
    }
  };

  const { scrollYProgress } = useScroll({
    target: containerRef,
    offset: ["start start", "end end"],
  });

  const width = useTransform(scrollYProgress, [0, 0.5], ["60%", "100%"]);
  const height = useTransform(scrollYProgress, [0, 0.5], ["60%", "100%"]);
  const radius = useTransform(scrollYProgress, [0, 0.5], [32, 0]);
  const boxShadow = useTransform(
    scrollYProgress,
    [0, 0.5],
    ["0 40px 80px -30px rgba(11,11,15,0.35)", "0 0px 0px 0px rgba(11,11,15,0)"]
  );
  const backdropOpacity = useTransform(scrollYProgress, [0, 0.5], [1, 0]);

  return (
    <section
      ref={containerRef}
      className="relative"
      style={{ height: "200vh" }}
    >
      <div className="sticky top-0 h-screen w-full overflow-hidden bg-background flex items-center justify-center">
        <motion.div
          style={{ opacity: backdropOpacity }}
          className="absolute inset-0 flex flex-col items-center justify-center px-6 pointer-events-none"
        >
          <span className="text-[10px] uppercase tracking-[0.22em] text-ink/72">
            Watch it work
          </span>
          <h2 className="mt-3 text-center text-4xl sm:text-5xl lg:text-6xl font-semibold tracking-[-0.02em] max-w-[18ch]">
            See PayMemo in{" "}
            <span className="font-serif-italic text-gradient-aurora">motion.</span>
          </h2>
          <p className="mt-4 max-w-[48ch] text-center text-ink/78">
            Scroll to step inside the demo.
          </p>
        </motion.div>

        <motion.div
          style={{ width, height, borderRadius: radius, boxShadow }}
          className="relative overflow-hidden bg-ink"
        >
          <video
            ref={videoRef}
            src={VIDEO_SRC}
            autoPlay
            muted
            loop
            playsInline
            preload="metadata"
            className="h-full w-full object-cover"
          />
          <div className="pointer-events-none absolute inset-0 bg-gradient-to-t from-ink/40 via-transparent to-transparent" />
          <button
            type="button"
            onClick={toggleMuted}
            aria-label={muted ? "Unmute video" : "Mute video"}
            aria-pressed={!muted}
            className="absolute bottom-4 right-4 z-10 inline-flex items-center gap-2 rounded-full bg-ink/70 px-3 py-2 text-xs font-medium text-white backdrop-blur-sm transition hover:bg-ink/85 focus:outline-none focus-visible:ring-2 focus-visible:ring-white/70"
          >
            {muted ? <VolumeX className="h-4 w-4" /> : <Volume2 className="h-4 w-4" />}
            <span>{muted ? "Tap for sound" : "Sound on"}</span>
          </button>
        </motion.div>
      </div>
    </section>
  );
}
