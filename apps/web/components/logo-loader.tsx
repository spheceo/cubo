import { CuboMark } from './cubo-logo';
import { logoUrl } from '@cubo/core';

const SIZES = {
  lg: 'size-[min(42vw,11rem)]',
  sm: 'size-14',
} as const;

const LOGO_SIZES = {
  lg: 'h-[min(14vw,3.75rem)] w-[min(70vw,18rem)]',
  sm: 'h-4 w-32',
} as const;

/**
 * Fills left-to-right while a stream gets ready. Prefers the title's own
 * TMDB logotype so the loading screen belongs to the content, falling back
 * to the Cubo mark when no logo is available.
 */
export function LogoLoader({
  title,
  progress,
  size = 'lg',
  logoPath,
}: {
  title: string;
  /** 0–1, or null while there is nothing meaningful to report yet. */
  progress: number | null;
  size?: keyof typeof SIZES;
  logoPath?: string | null;
}) {
  const indeterminate = progress === null;
  const clamped = Math.max(0, Math.min(1, progress ?? 0));
  const logo = logoPath ? logoUrl(logoPath, 'w500') : null;
  const box = logo ? LOGO_SIZES[size] : SIZES[size];

  return (
    <div
      className={`logo-fill relative ${indeterminate ? 'logo-fill-loop' : ''} ${box}`}
      style={indeterminate ? undefined : ({ '--logo-fill': `${clamped * 100}%` } as React.CSSProperties)}
      role="progressbar"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={indeterminate ? undefined : Math.round(clamped * 100)}
      aria-label={`Preparing ${title}`}
    >
      {logo ? (
        <>
          <img
            src={logo}
            alt=""
            draggable={false}
            className="absolute inset-0 h-full w-full object-contain object-center opacity-15"
          />
          <img
            src={logo}
            alt=""
            draggable={false}
            className="logo-fill-mask absolute inset-0 h-full w-full object-contain object-center"
          />
        </>
      ) : (
        <>
          <CuboMark className="absolute inset-0 h-full w-full text-white opacity-15" />
          <CuboMark className="logo-fill-mask absolute inset-0 h-full w-full text-white" />
        </>
      )}
    </div>
  );
}
