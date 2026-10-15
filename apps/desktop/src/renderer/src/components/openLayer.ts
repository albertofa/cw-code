const OPEN_LAYER_SELECTOR = '[role="dialog"], [role="alertdialog"], [aria-modal="true"], .menu-panel, .fpick.open, .ctx-menu, .picker-panel';

export function visibleLayerOpen(): boolean {
  return Array.from(document.querySelectorAll(OPEN_LAYER_SELECTOR)).some((el) => el.getClientRects().length > 0);
}
