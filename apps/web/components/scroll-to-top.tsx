import { useLayoutEffect } from 'react';
import { useLocation } from 'react-router';

export function resetWindowScroll() {
  if ('scrollRestoration' in history) history.scrollRestoration = 'manual';
  const root = document.documentElement;
  const previous = root.style.scrollBehavior;
  root.style.scrollBehavior = 'auto';
  window.scrollTo(0, 0);
  root.scrollTop = 0;
  document.body.scrollTop = 0;
  root.style.scrollBehavior = previous;
}

export function ScrollToTop() {
  const { pathname } = useLocation();

  useLayoutEffect(() => {
    resetWindowScroll();
  }, [pathname]);

  return null;
}
