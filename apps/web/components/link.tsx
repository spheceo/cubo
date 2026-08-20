import { forwardRef } from 'react';
import { Link as RouterLink, type LinkProps as RouterLinkProps } from 'react-router';

export interface LinkProps extends Omit<RouterLinkProps, 'to'> {
  href: string;
}

/** Accepts `href` so `@cubo/ui` components stay framework-neutral. */
export const Link = forwardRef<HTMLAnchorElement, LinkProps>(function Link(
  { href, ...rest },
  ref,
) {
  return <RouterLink ref={ref} to={href} {...rest} />;
});
