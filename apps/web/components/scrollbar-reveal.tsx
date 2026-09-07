import { useEffect } from 'react';

const HIDE_AFTER_MS = 900;

/** Marks the element that is currently scrolling so the overlay scrollbar
 *  can appear, then fade away. Does not replace native scrolling. */
export function ScrollbarReveal() {
  useEffect(() => {
    const timers = new WeakMap<Element, number>();
    const onScroll = (event: Event) => {
      const target = event.target;
      const element =
        target === document || target === document.documentElement || target === document.body
          ? document.documentElement
          : target instanceof Element
            ? target
            : null;
      if (!element) return;
      element.classList.add('is-scrolling');
      const previous = timers.get(element);
      if (previous) window.clearTimeout(previous);
      timers.set(
        element,
        window.setTimeout(() => element.classList.remove('is-scrolling'), HIDE_AFTER_MS),
      );
    };
    document.addEventListener('scroll', onScroll, { capture: true, passive: true });
    return () => document.removeEventListener('scroll', onScroll, { capture: true });
  }, []);
  return null;
}
