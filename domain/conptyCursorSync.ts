/** Cursor rows are zero-based viewport coordinates, not scrollback indices. */
export type ConptyCursorSyncState = {
  pending: boolean;
  nativeRow: number | null;
  displayRow: number | null;
};

export const createConptyCursorSyncState = (): ConptyCursorSyncState => ({
  pending: false, nativeRow: null, displayRow: null,
});

export const requestConptyCursorSync = (): ConptyCursorSyncState => ({
  pending: true, nativeRow: null, displayRow: null,
});

/**
 * Hidden agent input advances the native console but not the displayed buffer.
 * The next absolute cursor repaint anchors the two viewports. Visible printing
 * moves both cursors; the native one can already be at the bottom while the
 * display still has room, so clamp it independently.
 */
export const mapConptyCursorRow = (
  state: ConptyCursorSyncState,
  nativeRow: number,
  displayRow: number,
  rows: number,
): { row: number | null; state: ConptyCursorSyncState } => {
  if (!state.pending && (state.nativeRow === null || state.displayRow === null)) {
    return { row: null, state };
  }
  const clamp = (row: number) => Math.max(0, Math.min(Math.max(0, rows - 1), row));
  const native = clamp(nativeRow);
  const display = clamp(displayRow);
  const currentNative = state.pending
    ? native
    : clamp(state.nativeRow! + display - state.displayRow!);
  const mapped = clamp(native - (currentNative - display));
  return {
    row: mapped,
    state: { pending: false, nativeRow: native, displayRow: mapped },
  };
};
