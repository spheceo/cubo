import { useEffect, useRef, type RefObject } from 'react';

/** Matches the close transition in globals.css (`.drawer-dialog`). */
const CLOSE_MS = 320;

/** Drives a modal `<dialog class="drawer-dialog">` from `open`: the panel
 *  slides and the backdrop fades on the way in and on the way out. The
 *  element stays modal until the closing slide finishes, then closes. */
export function useDrawerDialog(ref: RefObject<HTMLDialogElement | null>, open: boolean): void {
  const closeTimer = useRef<number | null>(null);
  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (closeTimer.current != null) {
      window.clearTimeout(closeTimer.current);
      closeTimer.current = null;
    }
    if (open) {
      if (!dialog.open) dialog.showModal();
      // Commit the closed pose, let one frame paint it, then slide. Opening
      // costs the page a render (and the player is decoding video), so a
      // slide started on the very next frame lost its fast first stretch
      // and looked like a snap.
      void dialog.offsetWidth;
      let frame = requestAnimationFrame(() => {
        frame = requestAnimationFrame(() => {
          dialog.dataset.open = 'true';
        });
      });
      return () => cancelAnimationFrame(frame);
    }
    if (!dialog.open) return;
    delete dialog.dataset.open;
    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (reduced) {
      dialog.close();
      return;
    }
    closeTimer.current = window.setTimeout(() => {
      closeTimer.current = null;
      dialog.close();
    }, CLOSE_MS);
  }, [ref, open]);

  useEffect(
    () => () => {
      if (closeTimer.current != null) window.clearTimeout(closeTimer.current);
    },
    [],
  );
}
