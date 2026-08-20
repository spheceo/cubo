import { useEffect, useRef, useState } from 'react';
import { IoCheckmark, IoChevronDown } from 'react-icons/io5';

export interface DropdownOption<T extends string | number> {
  value: T;
  label: string;
}

/** App-styled replacement for a native <select>: pill trigger, dark floating
 *  panel, arrow-key navigation, Escape/outside-click dismissal. */
export function Dropdown<T extends string | number>({
  value,
  options,
  onChange,
  disabled = false,
  ariaLabel,
  className = '',
}: {
  value: T;
  options: DropdownOption<T>[];
  onChange: (value: T) => void;
  disabled?: boolean;
  ariaLabel: string;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const optionRefs = useRef<(HTMLButtonElement | null)[]>([]);
  const current = options.find((option) => option.value === value);

  useEffect(() => {
    if (!open) return;

    const closeOnOutsideClick = (event: PointerEvent) => {
      if (!containerRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.stopPropagation();
        setOpen(false);
      }
    };
    document.addEventListener('pointerdown', closeOnOutsideClick);
    window.addEventListener('keydown', onKeyDown, true);
    return () => {
      document.removeEventListener('pointerdown', closeOnOutsideClick);
      window.removeEventListener('keydown', onKeyDown, true);
    };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const selected = options.findIndex((option) => option.value === value);
    optionRefs.current[selected >= 0 ? selected : 0]?.focus();
  }, [open, options, value]);

  function moveFocus(delta: number) {
    const buttons = optionRefs.current.filter(Boolean) as HTMLButtonElement[];
    const active = buttons.findIndex((button) => button === document.activeElement);
    const next = Math.max(0, Math.min(buttons.length - 1, (active >= 0 ? active : 0) + delta));
    buttons[next]?.focus();
  }

  return (
    <div ref={containerRef} className={`relative ${className}`}>
      <button
        type="button"
        disabled={disabled}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={ariaLabel}
        onClick={() => setOpen((value) => !value)}
        className="flex w-full cursor-pointer items-center justify-between gap-2 rounded-full bg-control px-4 py-2 text-white outline-none transition-colors hover:bg-control-hover focus-visible:outline focus-visible:outline-2 focus-visible:outline-white disabled:cursor-default disabled:opacity-40"
      >
        <span className="truncate">{current?.label ?? String(value)}</span>
        <IoChevronDown
          size={15}
          className={`shrink-0 text-white/50 transition-transform duration-200 ${open ? 'rotate-180' : ''}`}
        />
      </button>

      {open ? (
        <div
          role="listbox"
          aria-label={ariaLabel}
          className="absolute right-0 top-full z-50 mt-2 max-h-64 min-w-full overflow-y-auto rounded-xl border border-line bg-panel py-1 shadow-2xl"
          onKeyDown={(event) => {
            if (event.key === 'ArrowDown') {
              event.preventDefault();
              moveFocus(1);
            } else if (event.key === 'ArrowUp') {
              event.preventDefault();
              moveFocus(-1);
            }
          }}
        >
          {options.map((option, index) => {
            const selected = option.value === value;
            return (
              <button
                key={option.value}
                ref={(element) => {
                  optionRefs.current[index] = element;
                }}
                type="button"
                role="option"
                aria-selected={selected}
                onClick={() => {
                  setOpen(false);
                  if (!selected) onChange(option.value);
                }}
                className={`flex w-full cursor-pointer items-center justify-between gap-3 whitespace-nowrap px-4 py-2 text-left text-sm outline-none transition-colors hover:bg-control focus-visible:bg-control ${
                  selected ? 'text-white' : 'text-white/70'
                }`}
              >
                <span className="truncate">{option.label}</span>
                {selected ? <IoCheckmark size={15} className="shrink-0 text-accent" /> : null}
              </button>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}
