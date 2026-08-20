import { forwardRef } from 'react';
import { Link as RouterLink, type LinkProps as RouterLinkProps } from 'react-router';
import { prefetchHref } from '@/lib/queries';

export interface LinkProps extends Omit<RouterLinkProps, 'to'> {
  href: string;
}

/** Accepts `href` so `@cubo/ui` components stay framework-neutral. Hovering or
 *  focusing a title link warms its details cache so navigation feels instant. */
export const Link = forwardRef<HTMLAnchorElement, LinkProps>(function Link(
  { href, onPointerEnter, onFocus, ...rest },
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
      {...rest}
    />
  );
});
