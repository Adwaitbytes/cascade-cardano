"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";

/** Mounts children only once their slot nears the viewport, so heavy panels never block first paint. */
export function LazyMount({ children, placeholder, rootMargin = "200px" }: { children: ReactNode; placeholder: ReactNode; rootMargin?: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const [shown, setShown] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (el === null || shown) return;
    const observer = new IntersectionObserver(([entry]) => {
      if (entry?.isIntersecting === true) setShown(true);
    }, { rootMargin });
    observer.observe(el);
    return () => observer.disconnect();
  }, [shown, rootMargin]);
  return <div ref={ref}>{shown ? children : placeholder}</div>;
}
