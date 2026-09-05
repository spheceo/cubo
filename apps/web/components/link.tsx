import { forwardRef } from 'react';
import { Link as RouterLink, type LinkProps as RouterLinkProps } from 'react-router';
import { armWatchSession, isWatchHref } from '@/lib/background-playback';
import { prefetchHref } from '@/lib/queries';

export interface LinkProps extends Omit<RouterLinkProps, 'to'> {
  href: string;
}

/** Accepts `href` so `@cubo/ui` components stay framework-neutral. Hovering or
 *  focusing a title link warms its details cache so navigation feels instant. */
export const Link = forwardRef<HTMLAnchorElement, LinkProps>(function Link(
  { href, onPointerEnter, onFocus, onClick, ...rest },
  ref,
) {
  return (
    <RouterLink
      ref={ref}
      to={href}
      onPointerEnter={(event) => {
        prefetchHref(href);
        onPointerEnter?.(event);
      }}
      onFocus={(event) => {
        prefetchHref(href);
        onFocus?.(event);
      }}
      onClick={(event) => {
        // The Play click is the user gesture that lets a hidden tab keep
        // loading and start audible playback a minute later.
        if (isWatchHref(href)) armWatchSession();
        onClick?.(event);
      }}
      {...rest}
    />
  );
});
