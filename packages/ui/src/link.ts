import type { ComponentType } from 'react';

/** Minimal link shape shared by the app's router link and a plain anchor, so
 *  these components stay framework-neutral while still getting client-side
 *  navigation from whatever router the host app uses. */
export interface LinkProps {
  href: string;
  className?: string;
  children: React.ReactNode;
  'aria-label'?: string;
}

export type LinkComponent = ComponentType<LinkProps> | 'a';
