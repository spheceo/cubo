const MARK = (
  <g
    fill="none"
    stroke="currentColor"
    strokeWidth="2.5"
    strokeLinejoin="round"
  >
    <path d="M16 3.8 27 10v12L16 28.2 5 22V10Z" />
    <path d="M5 10l11 6.3L27 10M16 16.3v11.9" />
  </g>
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
