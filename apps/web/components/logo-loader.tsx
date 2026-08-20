import { logoUrl } from '@cubo/core';

const SIZES = {
  lg: 'h-[13rem] w-[min(72vw,42rem)]',
  sm: 'w-[min(50vw,12rem)] h-[3.25rem]',
} as const;

/** The title's logo treatment, revealing left-to-right as the stream gets ready.
 *  Falls back to the title in type when TMDB has no logo for the release. */
export function LogoLoader({
  logoPath,
  title,
  progress,
  size = 'lg',
}: {
  logoPath: string | null;
  title: string;
  /** 0–1, or null while there is nothing meaningful to report yet. */
  progress: number | null;
  size?: keyof typeof SIZES;
}) {
  const src = logoUrl(logoPath, size === 'lg' ? 'w500' : 'w300');
  const indeterminate = progress === null;
  const clamped = Math.max(0, Math.min(1, progress ?? 0));

  return (
    <div
      className={`logo-fill relative ${indeterminate ? 'logo-fill-loop' : ''} ${SIZES[size]}`}
      style={indeterminate ? undefined : ({ '--logo-fill': `${clamped * 100}%` } as React.CSSProperties)}
      role="progressbar"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={indeterminate ? undefined : Math.round(clamped * 100)}
      aria-label={`Preparing ${title}`}
    >
      {src ? (
        <>
          <img
            src={src}
            alt=""
            className="absolute inset-0 h-full w-full object-contain opacity-12 grayscale"
          />
          <img
            src={src}
            alt=""
            className="logo-fill-mask absolute inset-0 h-full w-full object-contain drop-shadow-[0_0_18px_rgba(231,255,105,0.18)]"
          />
        </>
      ) : (
        <>
          <span className="absolute inset-0 flex items-center justify-center text-balance text-center text-3xl font-semibold tracking-[-0.035em] text-white opacity-15 sm:text-4xl">
            {title}
          </span>
          <span className="logo-fill-mask absolute inset-0 flex items-center justify-center text-balance text-center text-3xl font-semibold tracking-[-0.035em] text-white sm:text-4xl">
            {title}
          </span>
        </>
      )}
    </div>
  );
}
