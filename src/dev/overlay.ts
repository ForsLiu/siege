// F1 dev overlay: fps, sim tick, round hash, content hash, seed. Reads only; never mutates sim state.

export interface OverlayInfo {
  fps: number;
  screen: string;
  tick: number | null;
  round: number | null;
  roundHash: string | null;
  contentHash: string;
  seed: number | null;
  speed: number;
  extra?: string;
}

export interface DevOverlay {
  toggle(): void;
  setVisible(v: boolean): void;
  isVisible(): boolean;
  update(info: OverlayInfo): void;
}

const OVERLAY_CSS = `
#dev-overlay { position: absolute; top: 8px; left: 8px; margin: 0; padding: 6px 8px;
  background: rgba(0, 0, 0, 0.7); color: #a7f3d0; font: 12px ui-monospace, Consolas, monospace;
  border-radius: 4px; z-index: 20; pointer-events: none; white-space: pre; }
#dev-overlay[hidden] { display: none; }
`;

export function createOverlay(root: HTMLElement): DevOverlay {
  // Styles live here (not in the app stylesheet) so production CSS carries nothing dev-only.
  const style = document.createElement('style');
  style.textContent = OVERLAY_CSS;
  document.head.appendChild(style);
  const el = document.createElement('pre');
  el.id = 'dev-overlay';
  el.hidden = true;
  root.appendChild(el);
  let last = '';
  return {
    toggle() {
      el.hidden = !el.hidden;
    },
    setVisible(v) {
      el.hidden = !v;
    },
    isVisible() {
      return !el.hidden;
    },
    update(info) {
      if (el.hidden) return;
      const text = [
        `fps ${info.fps.toFixed(0)}  speed ${info.speed}x  screen ${info.screen}`,
        `seed ${info.seed ?? '-'}  round ${info.round ?? '-'}  tick ${info.tick ?? '-'}`,
        `round hash ${info.roundHash ?? '-'}`,
        `content    ${info.contentHash}`,
        info.extra ?? '',
      ].join('\n');
      if (text !== last) {
        el.textContent = text;
        last = text;
      }
    },
  };
}
