import { CuboMark } from './cubo-logo';

const SIZES = {
  lg: 'size-[min(42vw,11rem)]',
  sm: 'size-14',
} as const;

/** Cubo mark that fills left-to-right while a stream gets ready. */
export function LogoLoader({
  title,
  progress,
  size = 'lg',
}: {
  title: string;
  /** 0–1, or null while there is nothing meaningful to report yet. */
  progress: number | null;
  size?: keyof typeof SIZES;
}) {
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
      <CuboMark className="absolute inset-0 h-full w-full text-white opacity-15" />
      <CuboMark className="logo-fill-mask absolute inset-0 h-full w-full text-white" />
    </div>
  );
}
