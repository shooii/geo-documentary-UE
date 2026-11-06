const LABEL_REVEAL_FLIGHT_FRACTION = 0.55;
const LABEL_REVEAL_DURATION_FRACTION = 0.35;
const LABEL_REVEAL_MIN_SECONDS = 0.45;
const VISITED_LABEL_ALPHA = 0.70;
const CURRENT_LABEL_ALPHA = 0.98;
const VISITED_LABEL_SCALE = 0.9;

const clamp = (value, minimum, maximum) => Math.max(minimum, Math.min(maximum, value));
const lerp = (from, to, progress) => from + (to - from) * progress;
const smootherStep = (progress) => {
  const value = clamp(progress, 0, 1);
  return value * value * value * (value * (value * 6 - 15) + 10);
};

export function tourHighlightStrength(tour, returnState, featureId) {
  if (!tour) return 0;
  const id = String(featureId);
  if (returnState) {
    return id === String(tour.current.id) ? 1 - clamp(returnState.progress, 0, 1) : 0;
  }
  if (id === String(tour.current.id)) return clamp(tour.progress, 0, 1);
  if (tour.previous && id === String(tour.previous.id)) return 1 - clamp(tour.progress, 0, 1);
  return 0;
}

export function stableOverlayState(strength, maximumAlpha, retainedAlpha) {
  const normalized = clamp(strength, 0, 1);
  return {
    visible: normalized > 0.01,
    alpha: Math.max(retainedAlpha, maximumAlpha * normalized)
  };
}

export function parentLabelStrengthAt(introStrength) {
  return clamp(Number(introStrength) || 0, 0, 1);
}

/**
 * The parent region's name strength for a given phase of the presentation.
 *
 * The parent *name* belongs to the opening overview - the frame that introduces
 * the region - and to nothing else. It is not a piece of hierarchy context the
 * way the parent outline is: once the camera is touring the child areas the
 * frame is theirs, and a large parent name parked on the parent's label point
 * competes with the village names that are the actual subject. The closing
 * overview returns the camera to the parent framing but is narrated by the
 * villages, so the name must not come back there either.
 *
 * `overviewStrength` already encodes exactly that. It is the settled
 * introduction ramp: 1 while the parent introduction holds, easing to 0 across
 * the first village flight's start, which is also how the high-energy overview
 * boundary retires. There is therefore no tour floor to clamp up to and no
 * closing peak to restore - the name simply retires with the overview and stays
 * retired. `settled` keeps the name off screen until the trace has landed.
 */
export function parentNameStrengthAt({ settled, overviewStrength }) {
  const overview = clamp(Number(overviewStrength) || 0, 0, 1);
  return settled ? overview : 0;
}

export function tourLabelPresentationAt(time, tour, returnState, stop, stopIndex) {
  const flightDuration = Math.max(0.001, Number(stop.flightDuration) || 0.001);
  const revealStart = Number(stop.start) + flightDuration * LABEL_REVEAL_FLIGHT_FRACTION;
  const revealDuration = Math.max(LABEL_REVEAL_MIN_SECONDS, flightDuration * LABEL_REVEAL_DURATION_FRACTION);
  const revealStrength = smootherStep((time - revealStart) / revealDuration);
  if (revealStrength <= 0.01) {
    return { visible: false, current: false, visited: false, revealStrength: 0, emphasis: 0, alpha: 0, scale: VISITED_LABEL_SCALE };
  }

  let emphasis = 0;
  const isCurrentIndex = Boolean(tour && stopIndex === tour.index);
  if (isCurrentIndex) {
    emphasis = returnState
      ? 1 - clamp(returnState.progress, 0, 1)
      : clamp(tour.progress, 0, 1);
  } else if (tour && !returnState && stopIndex === tour.index - 1) {
    emphasis = 1 - clamp(tour.progress, 0, 1);
  }

  return {
    visible: true,
    current: isCurrentIndex && !returnState,
    visited: true,
    revealStrength,
    emphasis,
    alpha: revealStrength * lerp(VISITED_LABEL_ALPHA, CURRENT_LABEL_ALPHA, emphasis),
    scale: lerp(VISITED_LABEL_SCALE, 1, emphasis)
  };
}

export function visibleVisitedLabelIdsAt(time, stops, tour, returnState) {
  return stops
    .map((stop, index) => ({ id: String(stop.id), state: tourLabelPresentationAt(time, tour, returnState, stop, index) }))
    .filter((item) => item.state.visible)
    .map((item) => item.id);
}

export function closingNarrationStateAt(time, returnStart, returnDuration, configuredNarrationStart = null) {
  const start = Number(returnStart);
  const duration = Math.max(0, Number(returnDuration) || 0);
  const returnEnd = start + duration;
  const requestedNarrationStart = configuredNarrationStart === null ? Number.NaN : Number(configuredNarrationStart);
  const hasClosingNarration = Number.isFinite(requestedNarrationStart);
  const narrationStart = hasClosingNarration ? Math.max(returnEnd, requestedNarrationStart) : null;
  const returnInProgress = Number.isFinite(start) && time >= start && time < returnEnd;
  const openingCameraLocked = Number.isFinite(returnEnd) && time >= returnEnd;
  return {
    returnInProgress,
    movementSilent: returnInProgress,
    openingCameraLocked,
    hasClosingNarration,
    narrationStart,
    narrationAllowed: hasClosingNarration && openingCameraLocked && time >= narrationStart
  };
}
