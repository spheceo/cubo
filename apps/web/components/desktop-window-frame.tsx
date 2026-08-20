import { Minus, Square, X } from '@phosphor-icons/react';
import { useEffect, useState } from 'react';
import { isDesktopRuntime } from '@/lib/local-engine';

type DesktopPlatform = 'macos' | 'windows' | null;

function detectPlatform(): DesktopPlatform {
  if (!isDesktopRuntime()) return null;
  const agent = navigator.userAgent.toLowerCase();
  if (agent.includes('windows')) return 'windows';
  if (agent.includes('macintosh') || agent.includes('mac os')) return 'macos';
  return null;
}

export function DesktopWindowFrame() {
  const [platform, setPlatform] = useState<DesktopPlatform>(null);

  useEffect(() => {
    const detected = detectPlatform();
    setPlatform(detected);
    if (detected) document.documentElement.dataset.desktopPlatform = detected;
    return () => {
      delete document.documentElement.dataset.desktopPlatform;
    };
  }, []);

  async function withWindow(action: 'minimize' | 'maximize' | 'close') {
    const { getCurrentWindow } = await import('@tauri-apps/api/window');
    const window = getCurrentWindow();
    if (action === 'minimize') await window.minimize();
    if (action === 'maximize') await window.toggleMaximize();
    if (action === 'close') await window.close();
  }

  if (platform !== 'windows') return null;

  return (
    <div className="pointer-events-none fixed inset-x-0 top-0 z-[100] h-8 select-none">
      <div className="pointer-events-auto absolute right-0 top-0 flex h-8 items-stretch text-white/72">
        <button
          type="button"
          onClick={() => void withWindow('minimize')}
          aria-label="Minimize window"
          className="inline-flex w-11 cursor-default items-center justify-center transition hover:bg-white/12 hover:text-white"
        >
          <Minus className="size-3.5" />
        </button>
        <button
          type="button"
          onClick={() => void withWindow('maximize')}
          aria-label="Maximize window"
          className="inline-flex w-11 cursor-default items-center justify-center transition hover:bg-white/12 hover:text-white"
        >
          <Square className="size-3" />
        </button>
        <button
          type="button"
          onClick={() => void withWindow('close')}
          aria-label="Close window"
          className="inline-flex w-11 cursor-default items-center justify-center transition hover:bg-[#c42b1c] hover:text-white"
        >
          <X className="size-3.5" />
        </button>
      </div>
    </div>
  );
}
