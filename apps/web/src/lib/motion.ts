import { useEffect, useRef, useState } from "react";

/** True once the element has scrolled into view (and stays true). */
export function useInView<T extends Element>(threshold = 0.3) {
  const ref = useRef<T | null>(null);
  const [inView, setInView] = useState(false);
  useEffect(() => {
    const node = ref.current;
    if (node === null || inView) return;
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry?.isIntersecting) {
          setInView(true);
          observer.disconnect();
        }
      },
      { threshold },
    );
    observer.observe(node);
    return () => observer.disconnect();
  }, [inView, threshold]);
  return { ref, inView };
}

/** Counts from 0 to `target` once `start` is true. */
export function useCountUp(target: number, start: boolean, ms = 1400) {
  const [value, setValue] = useState(0);
  useEffect(() => {
    if (!start) return;
    let frame = 0;
    const began = performance.now();
    const tick = (now: number) => {
      const t = Math.min(1, (now - began) / ms);
      setValue(target * (1 - (1 - t) ** 3));
      if (t < 1) frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [target, start, ms]);
  return value;
}

/** Steps through a looping script: returns the current step index. */
export function useLoop(durations: number[], running = true) {
  const [step, setStep] = useState(0);
  useEffect(() => {
    if (!running) return;
    const id = setTimeout(
      () => setStep((s) => (s + 1) % durations.length),
      durations[step] ?? 1000,
    );
    return () => clearTimeout(id);
  }, [step, durations, running]);
  return step;
}
