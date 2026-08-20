import { useLayoutEffect } from 'react';
import { useLocation } from 'react-router';

export function ScrollToTop() {
  const { pathname } = useLocation();

  useLayoutEffect(() => {
    // "instant" overrides the CSS smooth scroll so route changes never animate.
    window.scrollTo({ top: 0, behavior: 'instant' });
  }, [pathname]);

  return null;
}
