import { IoPlay } from 'react-icons/io5';
import { Link } from '@/components/link';

export function WatchPlayLink({
  href,
  label,
  progress = 0,
  size = 'md',
}: {
  href: string;
  label: string;
  progress?: number;
  size?: 'md' | 'lg';
}) {
  const percent = Math.min(100, Math.max(0, Math.round(progress * 100)));

  return (
    <Link
      href={href}
      className={`relative flex cursor-pointer items-center justify-center overflow-hidden rounded-full bg-white font-semibold text-black ${
        size === 'lg' ? 'h-14 w-60 gap-3' : 'h-12 w-48 gap-2'
      }`}
    >
      <IoPlay size={size === 'lg' ? 22 : 20} />
      {label}
      {percent > 0 ? (
        <span
          aria-hidden
          className="absolute bottom-0 left-0 h-1 bg-star"
          style={{ width: `${percent}%` }}
        />
      ) : null}
    </Link>
  );
}
