const MARK = (
  <>
    <path fill="currentColor" d="M16 3.2 28 10.1 16 17 4 10.1 16 3.2Z" />
    <path fill="currentColor" fillOpacity="0.55" d="M4 10.1 16 17v11.4L4 21.5V10.1Z" />
    <path fill="currentColor" fillOpacity="0.32" d="M16 17 28 10.1v11.4L16 28.4V17Z" />
  </>
);

export function CuboMark({
  className = '',
  title,
}: {
  className?: string;
  title?: string;
}) {
  return (
    <svg
      viewBox="0 0 32 32"
      className={className}
      aria-hidden={title ? undefined : true}
      role={title ? 'img' : undefined}
    >
      {title ? <title>{title}</title> : null}
      {MARK}
    </svg>
  );
}

export function CuboWordmark({ className = '' }: { className?: string }) {
  return (
    <span className={`inline-flex items-center gap-2 ${className}`}>
      <CuboMark className="size-[1.05em] shrink-0" />
      <span className="tracking-[-0.04em]">cubo</span>
    </span>
  );
}
