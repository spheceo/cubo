import { useGSAP } from '@gsap/react';
import { gsap } from 'gsap';
import { useRef } from 'react';

gsap.registerPlugin(useGSAP);

export function MotionReveal({
  children,
  className = '',
}: {
  children: React.ReactNode;
  className?: string;
}) {
  const element = useRef<HTMLDivElement>(null);

  useGSAP(
    (_context, contextSafe) => {
      const target = element.current;
      if (!target || window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
      gsap.set(target, { autoAlpha: 0, y: 22 });
      const reveal = contextSafe?.(() => {
        gsap.to(target, { autoAlpha: 1, y: 0, duration: 0.8, ease: 'power3.out' });
      });
      if (!reveal) return;
      const observer = new IntersectionObserver(
        ([entry]) => {
          if (!entry?.isIntersecting) return;
          reveal();
          observer.disconnect();
        },
        { rootMargin: '0px 0px -8% 0px', threshold: 0.08 },
      );
      observer.observe(target);
      return () => observer.disconnect();
    },
    { scope: element },
  );

  return (
    <div ref={element} className={className}>
      {children}
    </div>
  );
}
