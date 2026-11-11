// Screen hierarchy is a pure function of the authored frame, never playback history.
const unit = (value: number) => Math.max(0, Math.min(1, value));
const ease = (value: number) => { const x = unit(value); return x * x * (3 - 2 * x); };
export function visualHierarchy(cameraHeight: number, overviewHeight: number, closing: number) {
  const wide = Math.max(ease((cameraHeight / Math.max(1, overviewHeight) - .35) / .5), unit(closing));
  return {
    wide,
    fillScale: .80 - .15 * wide,
    interiorAlpha: .78 - .30 * wide,
    interiorWidth: 1 - .30 * wide,
    interiorGlow: .45 - .35 * wide,
    labelMix: ease((wide - .25) / .65)
  };
}

type Stop = { id: unknown; cameraPreset?: any; cameraProfiles?: Record<string, any> };
// Spread representatives across the geography, not just the first few narrated stops.
// Stable authored order breaks ties. Selection does not change as the camera moves.
export function overviewRepresentatives(stops: Stop[], profile: string, budget = profile === 'landscape' ? 8 : 6): Set<string> {
  const candidates = stops.map(stop => {
    const pose = stop.cameraProfiles?.[profile] ?? stop.cameraPreset ?? {};
    return { id: String(stop.id), x: Number(pose.longitude ?? pose.lon), y: Number(pose.latitude ?? pose.lat) };
  });
  if (candidates.length <= budget) return new Set(candidates.map(item => item.id));
  const chosen = [candidates[0]!];
  const remaining = candidates.slice(1);
  const latitude = candidates.filter(p => Number.isFinite(p.y)).reduce((sum, p) => sum + p.y, 0) / Math.max(1, candidates.filter(p => Number.isFinite(p.y)).length);
  const longitudeScale = Math.cos(latitude * Math.PI / 180);
  while (chosen.length < budget && remaining.length) {
    let best = 0, score = -1;
    remaining.forEach((point, index) => {
      const separation = Math.min(...chosen.map(other => {
        const dx = (point.x - other.x) * longitudeScale, dy = point.y - other.y;
        return Number.isFinite(dx + dy) ? dx * dx + dy * dy : 0;
      }));
      if (separation > score) { best = index; score = separation; }
    });
    chosen.push(remaining.splice(best, 1)[0]!);
  }
  return new Set(chosen.map(item => item.id));
}
