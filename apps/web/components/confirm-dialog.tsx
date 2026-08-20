import { useEffect, useRef } from 'react';

/** App-styled replacement for window.confirm: dark panel, backdrop blur,
 *  Escape/backdrop cancel, and focus starts on the safe action. */
export function ConfirmDialog({
  title,
  description,
  confirmLabel = 'Remove',
  onCancel,
  onConfirm,
}: {
  title: string;
  description: string;
  confirmLabel?: string;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const cancelRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    cancelRef.current?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.stopPropagation();
        onCancel();
      }
    };
    window.addEventListener('keydown', onKeyDown, true);
    return () => window.removeEventListener('keydown', onKeyDown, true);
  }, [onCancel]);

  return (
    <div
      className="fixed inset-0 z-[60] flex items-center justify-center bg-black/70 px-6 backdrop-blur-sm"
      onClick={onCancel}
      role="presentation"
    >
      <div
        role="alertdialog"
        aria-modal="true"
        aria-label={title}
        className="w-full max-w-sm rounded-2xl bg-panel p-6 text-white shadow-2xl"
        onClick={(event) => event.stopPropagation()}
      >
        <h3 className="text-xl font-semibold">{title}</h3>
        <p className="mt-2 text-sm leading-6 text-white/60">{description}</p>
        <div className="mt-6 flex justify-end gap-3">
          <button
            ref={cancelRef}
            type="button"
            onClick={onCancel}
            className="cursor-pointer rounded-full bg-white/10 px-5 py-2 font-semibold transition-colors hover:bg-white/15"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={onConfirm}
            className="cursor-pointer rounded-full bg-white px-5 py-2 font-semibold text-black transition-colors hover:bg-white/85"
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
