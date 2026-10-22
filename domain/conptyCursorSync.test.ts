import assert from "node:assert/strict";
import test from "node:test";

import {
  createConptyCursorSyncState,
  mapConptyCursorRow,
  requestConptyCursorSync,
} from "./conptyCursorSync";

test("native coordinates are untouched before a hidden-input boundary", () => {
  const state = createConptyCursorSyncState();
  assert.deepEqual(mapConptyCursorRow(state, 47, 3, 48), { row: null, state });
});

test("first native repaint anchors at the displayed prompt, without mutating state", () => {
  const state = requestConptyCursorSync();
  const mapped = mapConptyCursorRow(state, 47, 3, 48);
  assert.equal(mapped.row, 3);
  assert.deepEqual(state, requestConptyCursorSync());
  assert.deepEqual(mapped.state, { pending: false, nativeRow: 47, displayRow: 3 });
});

test("native bottom-row wrapping keeps the first input row stable", () => {
  const first = mapConptyCursorRow(requestConptyCursorSync(), 47, 3, 48);
  const wrapped = mapConptyCursorRow(first.state, 47, 4, 48);
  assert.equal(wrapped.row, 4);
  const repaint = mapConptyCursorRow(wrapped.state, 46, 4, 48);
  assert.equal(repaint.row, 3);
});

test("visible output consumes the offset until both buffers reach the bottom", () => {
  const first = mapConptyCursorRow(requestConptyCursorSync(), 47, 3, 48);
  const bottom = mapConptyCursorRow(first.state, 47, 47, 48);
  assert.equal(bottom.row, 47);
  assert.equal(mapConptyCursorRow(bottom.state, 20, 47, 48).row, 20);
});

test("visible backward movement updates the native anchor", () => {
  const first = mapConptyCursorRow(requestConptyCursorSync(), 47, 8, 48);
  assert.equal(mapConptyCursorRow(first.state, 46, 7, 48).row, 7);
});

test("every new command boundary discards an old anchor", () => {
  const first = mapConptyCursorRow(requestConptyCursorSync(), 47, 3, 48);
  assert.equal(mapConptyCursorRow(first.state, 47, 5, 48).row, 5);
  assert.equal(mapConptyCursorRow(requestConptyCursorSync(), 47, 7, 48).row, 7);
});

test("row clamping is safe after a resize and for one-row terminals", () => {
  assert.equal(mapConptyCursorRow(requestConptyCursorSync(), 47, 40, 20).row, 19);
  assert.equal(mapConptyCursorRow(requestConptyCursorSync(), 47, 4, 1).row, 0);
});
