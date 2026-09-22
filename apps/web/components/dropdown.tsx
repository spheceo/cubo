import { useEffect, useRef, useState } from 'react';
import { IoCheckmark, IoChevronDown } from 'react-icons/io5';

export interface DropdownOption<T extends string | number> {
  value: T;
  label: string;
}

type DropdownProps<T extends string | number> = {
  options: DropdownOption<T>[];
  disabled?: boolean;
  ariaLabel: string;
  className?: string;
  /** Shown when nothing is selected (multi-select empty state, or a value
   *  with no matching option). */
  placeholder?: string;
} & (
  | { multiple?: false; value: T; onChange: (value: T) => void }
  | { multiple: true; value: T[]; onChange: (value: T[]) => void }
);

/** App-styled replacement for a native <select>: pill trigger, dark floating
 *  panel, arrow-key navigation, Escape/outside-click dismissal. In `multiple`
 *  mode options toggle and the panel stays open. */
export function Dropdown<T extends string | number>({
  value,
  options,
  onChange,
  multiple = false,
  disabled = false,
  ariaLabel,
  placeholder,
  className = '',
}: DropdownProps<T>) {
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const optionRefs = useRef<(HTMLButtonElement | null)[]>([]);
  const selected = multiple ? (value as T[]) : null;
  const current = multiple ? undefined : options.find((option) => option.value === value);
  const label =
    selected != null
      ? selected.length
        ? options
            .filter((option) => selected.includes(option.value))
            .map((option) => option.label)
            .join(', ')
        : (placeholder ?? '')
      : (current?.label ?? placeholder ?? String(value));

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
    const selectedIndex = selected
      ? options.findIndex((option) => selected.includes(option.value))
      : options.findIndex((option) => option.value === value);
    optionRefs.current[selectedIndex >= 0 ? selectedIndex : 0]?.focus();
  }, [open, options, value, selected]);

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
        <span className={`truncate ${!label ? 'text-white/50' : ''}`}>{label}</span>
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
            const isSelected = selected
              ? selected.includes(option.value)
              : option.value === value;
            return (
              <button
                key={option.value}
                ref={(element) => {
                  optionRefs.current[index] = element;
                }}
                type="button"
                role="option"
                aria-selected={isSelected}
                onClick={() => {
                  if (selected) {
                    (onChange as (value: T[]) => void)(
                      isSelected
                        ? selected.filter((entry) => entry !== option.value)
                        : [...selected, option.value],
                    );
                    return;
                  }
                  setOpen(false);
                  if (!isSelected) (onChange as (value: T) => void)(option.value);
                }}
                className={`flex w-full cursor-pointer items-center justify-between gap-3 whitespace-nowrap px-4 py-2 text-left text-sm outline-none transition-colors hover:bg-control focus-visible:bg-control ${
                  isSelected ? 'text-white' : 'text-white/70'
                }`}
              >
                <span className="truncate">{option.label}</span>
                {isSelected ? <IoCheckmark size={15} className="shrink-0 text-accent" /> : null}
              </button>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}
