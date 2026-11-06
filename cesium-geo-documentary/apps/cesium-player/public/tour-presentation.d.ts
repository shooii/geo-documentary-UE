export interface TourStopLike {
  id: string | number;
  start: number;
  flightDuration: number;
}

export interface TourStateLike {
  index: number;
  current: TourStopLike;
  previous: TourStopLike | null;
  progress: number;
}

export interface TourReturnStateLike {
  progress: number;
}

export interface TourLabelPresentation {
  visible: boolean;
  current: boolean;
  visited: boolean;
  revealStrength: number;
  emphasis: number;
  alpha: number;
  scale: number;
}

export function tourHighlightStrength(
  tour: TourStateLike | null,
  returnState: TourReturnStateLike | null,
  featureId: string | number
): number;

export function stableOverlayState(
  strength: number,
  maximumAlpha: number,
  retainedAlpha: number
): { visible: boolean; alpha: number };

export function parentLabelStrengthAt(introStrength: number, returnProgress?: number): number;

export function parentNameStrengthAt(input: {
  settled: boolean;
  overviewStrength: number;
}): number;

export function tourLabelPresentationAt(
  time: number,
  tour: TourStateLike | null,
  returnState: TourReturnStateLike | null,
  stop: TourStopLike,
  stopIndex: number
): TourLabelPresentation;

export function visibleVisitedLabelIdsAt(
  time: number,
  stops: TourStopLike[],
  tour: TourStateLike | null,
  returnState: TourReturnStateLike | null
): string[];

export function closingNarrationStateAt(
  time: number,
  returnStart: number,
  returnDuration: number,
  configuredNarrationStart?: number | null
): {
  returnInProgress: boolean;
  movementSilent: boolean;
  openingCameraLocked: boolean;
  hasClosingNarration: boolean;
  narrationStart: number | null;
  narrationAllowed: boolean;
};
