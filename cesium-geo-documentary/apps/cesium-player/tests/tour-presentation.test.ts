import test from "node:test";
import assert from "node:assert/strict";
import {
  closingNarrationStateAt,
  parentLabelStrengthAt,
  parentNameStrengthAt,
  stableOverlayState,
  tourHighlightStrength,
  tourLabelPresentationAt,
  visibleVisitedLabelIdsAt,
  type TourStateLike,
  type TourStopLike
} from "../public/tour-presentation.js";

const stops: TourStopLike[] = [
  { id: "a", start: 10, flightDuration: 4 },
  { id: "b", start: 20, flightDuration: 4 },
  { id: "c", start: 30, flightDuration: 4 }
];

function tourStateAt(time: number): TourStateLike | null {
  if (time < stops[0]!.start) return null;
  let index = 0;
  if (time >= stops[2]!.start) index = 2;
  else if (time >= stops[1]!.start) index = 1;
  const current = stops[index]!;
  return {
    index,
    current,
    previous: index > 0 ? stops[index - 1]! : null,
    progress: Math.max(0, Math.min(1, (time - current.start) / current.flightDuration))
  };
}

test("visited child labels grow monotonically and persist through the parent return", () => {
  const times = [0, 13.7, 20, 23.7, 29, 33.7, 39, 42, 44.4];
  let previous = new Set<string>();
  for (const time of times) {
    const tour = tourStateAt(time);
    const returnState = time >= 40 ? { progress: Math.min(1, (time - 40) / 4.4) } : null;
    const visible = new Set(visibleVisitedLabelIdsAt(time, stops, tour, returnState));
    for (const id of previous) assert.ok(visible.has(id), `${id} disappeared at ${time}s`);
    previous = visible;
  }

  assert.deepEqual(visibleVisitedLabelIdsAt(0, stops, null, null), []);
  assert.deepEqual([...previous], ["a", "b", "c"]);

  const activeTour = tourStateAt(35)!;
  const current = tourLabelPresentationAt(35, activeTour, null, stops[2]!, 2);
  const earlier = tourLabelPresentationAt(35, activeTour, null, stops[0]!, 0);
  assert.equal(current.current, true);
  assert.equal(earlier.current, false);
  assert.ok(current.alpha > earlier.alpha);
  assert.ok(earlier.alpha <= 0.70);
  assert.ok(current.scale > earlier.scale);

  const returning = { progress: 0.5 };
  for (let index = 0; index < stops.length; index += 1) {
    const state = tourLabelPresentationAt(42.2, activeTour, returning, stops[index]!, index);
    assert.equal(state.visible, true);
    assert.equal(state.current, false);
  }
});

test("selection handoffs never create a blank boundary state or write zero-alpha materials", () => {
  for (const progress of [0, 0.01, 0.25, 0.5, 0.75, 0.99, 1]) {
    const tour: TourStateLike = { index: 1, current: stops[1]!, previous: stops[0]!, progress };
    const previous = stableOverlayState(tourHighlightStrength(tour, null, "a"), 0.99, 0.06);
    const current = stableOverlayState(tourHighlightStrength(tour, null, "b"), 0.99, 0.06);
    assert.ok(previous.visible || current.visible, `blank handoff at progress ${progress}`);
    assert.ok(previous.alpha > 0);
    assert.ok(current.alpha > 0);
  }

  const inactiveFill = stableOverlayState(0, 0.18, 0.025);
  assert.equal(inactiveFill.visible, false);
  assert.equal(inactiveFill.alpha, 0.025);
});

test("the parent-return movement is silent and closing narration waits for the exact camera lock", () => {
  const moving = closingNarrationStateAt(12, 10, 4.4, 15);
  assert.equal(moving.returnInProgress, true);
  assert.equal(moving.movementSilent, true);
  assert.equal(moving.openingCameraLocked, false);
  assert.equal(moving.narrationAllowed, false);

  const lockedBeforeClosing = closingNarrationStateAt(14.4, 10, 4.4, 15);
  assert.equal(lockedBeforeClosing.openingCameraLocked, true);
  assert.equal(lockedBeforeClosing.narrationAllowed, false);

  const closing = closingNarrationStateAt(15, 10, 4.4, 15);
  assert.equal(closing.openingCameraLocked, true);
  assert.equal(closing.narrationAllowed, true);

  const silentEnding = closingNarrationStateAt(20, 10, 4.4, null);
  assert.equal(silentEnding.hasClosingNarration, false);
  assert.equal(silentEnding.narrationAllowed, false);
});

test("the parent introduction ramp is clamped to a unit strength", () => {
  assert.equal(parentLabelStrengthAt(1), 1);
  assert.equal(parentLabelStrengthAt(0), 0);
  assert.equal(parentLabelStrengthAt(0.5), 0.5);
});

// The parent name is an opening-overview treatment: it introduces the region,
// then retires as the first village flight begins and stays retired. The child
// tour belongs to the villages, and the closing overview returns the camera to
// the parent framing without re-introducing the parent name over their labels.
test("the parent name retires with the opening overview and never comes back", () => {
  type ParentPhase = Parameters<typeof parentNameStrengthAt>[0];
  const phase = (overrides: Partial<ParentPhase> = {}): number => parentNameStrengthAt({
    settled: true, overviewStrength: 0.9, ...overrides
  });

  // Before the trace settles the region has not been introduced, so there is
  // nothing to name - regardless of how far the reveal ramp has run.
  assert.equal(phase({ settled: false, overviewStrength: 0 }), 0);
  assert.equal(phase({ settled: false, overviewStrength: 0.4 }), 0);

  // The opening overview is unchanged: the name is carried by its own ramp.
  assert.equal(phase({ overviewStrength: 0.9 }), 0.9);
  assert.equal(phase({ overviewStrength: 0.4 }), 0.4);

  // Once the overview retires - which is exactly when the first village flight
  // begins - the name is gone, and there is no floor holding it on screen.
  assert.equal(phase({ overviewStrength: 0 }), 0);
  for (const ramp of [0.7, 0.5, 0.2, 0.05, 0]) {
    assert.ok(phase({ overviewStrength: ramp }) <= 0.7, `ramp ${ramp} kept the name too strong`);
  }

  // The phase function takes no closing-overview input, so the name cannot be
  // restored at the end of the presentation even by accident. Adding a required
  // `returning` / `tourFloor` input back stops this assignment from compiling.
  const onlyOverviewInputs: (input: { settled: boolean; overviewStrength: number }) => number = parentNameStrengthAt;
  assert.equal(onlyOverviewInputs({ settled: true, overviewStrength: 0.9 }), 0.9);
});
