const base = {
  viewBox: '0 0 24 24',
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 1.6,
  strokeLinecap: 'round' as const,
  strokeLinejoin: 'round' as const,
};

export function PlayIcon({ className = 'size-5' }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" className={className}>
      <path d="M7 4.5 19.5 12 7 19.5Z" />
    </svg>
  );
}

export function PauseIcon({ className = 'size-5' }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" className={className}>
      <path d="M7 4.5h3.2v15H7zM13.8 4.5H17v15h-3.2z" />
    </svg>
  );
}

export function SkipIcon({
  className = 'size-5',
  back = false,
}: {
  className?: string;
  back?: boolean;
}) {
  return (
    <svg {...base} className={`${className} ${back ? '' : '-scale-x-100'}`}>
      <path d="M11.5 5.5 7 10l4.5 4.5" />
      <path d="M7 10h6.5a5 5 0 0 1 0 10H9" />
    </svg>
  );
}

export function VolumeIcon({
  className = 'size-5',
  level,
}: {
  className?: string;
  level: 'muted' | 'low' | 'high';
}) {
  return (
    <svg {...base} className={className}>
      <path d="M4 9.5h3.5L12 5.5v13L7.5 14.5H4z" />
      {level === 'muted' ? (
        <path d="m16 9.5 4.5 5m0-5-4.5 5" />
      ) : (
        <>
          <path d="M15.8 9.8a3.2 3.2 0 0 1 0 4.4" />
          {level === 'high' ? <path d="M18.4 7.4a6.6 6.6 0 0 1 0 9.2" /> : null}
        </>
      )}
    </svg>
  );
}

export function FullscreenIcon({
  className = 'size-5',
  exit = false,
}: {
  className?: string;
  exit?: boolean;
}) {
  return (
    <svg {...base} className={className}>
      {exit ? (
        <path d="M9.5 4.5v5h-5m10 10v-5h5m-15 0h5v5m10-10h-5v-5" />
      ) : (
        <path d="M4.5 9.5v-5h5m10 5v-5h-5m5 10v5h-5m-10-5v5h5" />
      )}
    </svg>
  );
}

export function PipIcon({ className = 'size-5' }: { className?: string }) {
  return (
    <svg {...base} className={className}>
      <rect x="3" y="5" width="18" height="14" rx="2.5" />
      <rect x="12.5" y="11.5" width="6" height="5" rx="1.2" />
    </svg>
  );
}

export function ChevronIcon({ className = 'size-4' }: { className?: string }) {
  return (
    <svg {...base} className={className}>
      <path d="M15 6 9 12l6 6" />
    </svg>
  );
}
