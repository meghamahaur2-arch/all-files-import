import { motion, useMotionValue, useSpring } from "framer-motion";
import { useEffect, useRef, useState } from "react";

/**
 * BeaconCursor
 * - A precise crosshair dot follows the pointer with ZERO lag (so clicks land
 *   exactly where the user sees the cursor - fixes the "clicking somewhere else"
 *   bug from the previous spring-only cursor).
 * - A soft aurora ring trails with spring physics for delight.
 * - On [data-cursor], `a`, and `button` elements: ring expands and magnetically
 *   snaps to the element's center.
 * - On mousedown: ripple pulse at the click point.
 * - Hidden on touch / coarse pointers and respects prefers-reduced-motion.
 */
export function BeaconCursor() {
  // Raw values for precise dot (no spring, always at pointer)
  const rawX = useMotionValue(-200);
  const rawY = useMotionValue(-200);
  // Target values for ring (snap to element center when hovering)
  const targetX = useMotionValue(-200);
  const targetY = useMotionValue(-200);
  // Spring values for the ring follow targetX/Y
  const ringX = useSpring(targetX, { stiffness: 320, damping: 28, mass: 0.4 });
  const ringY = useSpring(targetY, { stiffness: 320, damping: 28, mass: 0.4 });
  const ringW = useSpring(34, { stiffness: 320, damping: 28 });
  const ringH = useSpring(34, { stiffness: 320, damping: 28 });

  const [enabled, setEnabled] = useState(false);
  const [hovered, setHovered] = useState(false);
  const [label, setLabel] = useState<string>("");
  const [ripples, setRipples] = useState<{ id: number; x: number; y: number }[]>([]);
  const ripIdRef = useRef(0);
  const targetElRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const fine = window.matchMedia("(pointer: fine)").matches;
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (!fine || reduced) return;
    setEnabled(true);

    const syncRingToTarget = () => {
      const el = targetElRef.current;
      if (el) {
        const r = el.getBoundingClientRect();
        targetX.set(r.left + r.width / 2);
        targetY.set(r.top + r.height / 2);
        // Snap ring to element size (clamped to a comfy max)
        ringW.set(Math.min(r.width + 12, 220));
        ringH.set(Math.min(r.height + 12, 80));
      }
    };

    const move = (e: PointerEvent) => {
      rawX.set(e.clientX);
      rawY.set(e.clientY);
      if (!targetElRef.current) {
        targetX.set(e.clientX);
        targetY.set(e.clientY);
      }
    };

    const over = (e: PointerEvent) => {
      const t = (e.target as HTMLElement | null)?.closest<HTMLElement>(
        "[data-cursor], a, button, [role='button'], input, textarea, select, label"
      );
      if (!t) {
        targetElRef.current = null;
        setHovered(false);
        setLabel("");
        ringW.set(34);
        ringH.set(34);
        targetX.set(rawX.get());
        targetY.set(rawY.get());
        return;
      }
      targetElRef.current = t;
      setHovered(true);
      setLabel(t.dataset.cursorLabel ?? "");
      syncRingToTarget();
    };

    const down = (e: PointerEvent) => {
      const id = ++ripIdRef.current;
      const el = targetElRef.current;
      // Ripple from the snapped target (button center) if hovering, else pointer
      const cx = el ? el.getBoundingClientRect().left + el.getBoundingClientRect().width / 2 : e.clientX;
      const cy = el ? el.getBoundingClientRect().top + el.getBoundingClientRect().height / 2 : e.clientY;
      setRipples((r) => [...r, { id, x: cx, y: cy }]);
      setTimeout(() => setRipples((r) => r.filter((p) => p.id !== id)), 600);
    };

    const leave = () => {
      rawX.set(-200);
      rawY.set(-200);
      targetX.set(-200);
      targetY.set(-200);
    };

    window.addEventListener("pointermove", move, { passive: true });
    window.addEventListener("pointerover", over, { passive: true });
    window.addEventListener("pointerdown", down, { passive: true });
    window.addEventListener("pointerleave", leave);
    window.addEventListener("scroll", syncRingToTarget, { passive: true });
    window.addEventListener("resize", syncRingToTarget);
    document.documentElement.style.cursor = "none";
    return () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerover", over);
      window.removeEventListener("pointerdown", down);
      window.removeEventListener("pointerleave", leave);
      window.removeEventListener("scroll", syncRingToTarget);
      window.removeEventListener("resize", syncRingToTarget);
      document.documentElement.style.cursor = "";
    };
  }, [rawX, rawY, targetX, targetY, ringW, ringH]);

  if (!enabled) return null;

  return (
    <div aria-hidden className="pointer-events-none fixed inset-0 z-[9999]">
      {/* Trailing aurora ring */}
      <motion.div
        className="absolute -translate-x-1/2 -translate-y-1/2"
        style={{ left: ringX, top: ringY }}
      >
        <motion.div
          animate={{
            borderColor: hovered ? "var(--pink)" : "color-mix(in oklab, var(--ink) 55%, transparent)",
            borderWidth: hovered ? 1.5 : 1,
            backgroundColor: hovered ? "color-mix(in oklab, var(--pink) 10%, transparent)" : "transparent",
            borderRadius: hovered ? 14 : 999,
          }}
          transition={{ type: "spring", stiffness: 350, damping: 26 }}
          style={{ width: ringW, height: ringH }}
          className="border backdrop-blur-[2px]"
        />
        {/* aurora glow */}
        <motion.div
          animate={{ opacity: hovered ? 0.55 : 0.25, scale: hovered ? 1.4 : 1 }}
          className="absolute inset-0 rounded-full bg-[var(--pink)] blur-2xl"
        />
      </motion.div>

      {/* Precise dot at EXACT pointer position - clicks land here */}
      <motion.div
        className="absolute -translate-x-1/2 -translate-y-1/2"
        style={{ left: rawX, top: rawY }}
      >
        <motion.div
          animate={{
            width: hovered ? 4 : 6,
            height: hovered ? 4 : 6,
          }}
          transition={{ type: "spring", stiffness: 500, damping: 30 }}
          className="rounded-full bg-[var(--ink)]"
        />
        {label && (
          <motion.span
            key={label}
            initial={{ opacity: 0, y: -2 }}
            animate={{ opacity: 1, y: 0 }}
            className="absolute left-4 top-4 whitespace-nowrap rounded-md bg-[var(--ink)] px-2 py-0.5 text-[10px] font-semibold uppercase tracking-widest text-[var(--cream)]"
          >
            {label}
          </motion.span>
        )}
      </motion.div>

      {/* Click ripples at click point */}
      {ripples.map((r) => (
        <motion.div
          key={r.id}
          initial={{ opacity: 0.6, scale: 0 }}
          animate={{ opacity: 0, scale: 4 }}
          transition={{ duration: 0.55, ease: "easeOut" }}
          className="absolute h-10 w-10 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-[var(--pink)]"
          style={{ left: r.x, top: r.y }}
        />
      ))}
    </div>
  );
}
