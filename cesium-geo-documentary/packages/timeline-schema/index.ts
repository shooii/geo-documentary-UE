import { z } from "zod";

export const TimelineActionSchema = z.object({
  id: z.string().min(1),
  time: z.number().nonnegative(),
  duration: z.number().nonnegative(),
  type: z.enum([
    "flyToRegion", "zoomFromGlobe", "orbitRegion", "tiltToTerrain",
    "traceBoundary", "focusCity", "topDownMap", "obliqueTerrain",
    "showRegionLabel", "showCultureAsset", "showEndCard",
    "showParentOverview", "fadeSelectedFill", "showPopulation",
    "showEconomy", "showHistory", "showCulture", "showSummary",
    "holdRegionCamera", "fadeSelectedOut", "pullBackToParent",
    "revealParentBoundary", "fadeChildBoundaries"
  ]),
  target: z.string().min(1),
  easing: z.enum(["linear", "cubicInOut", "sineInOut"]).default("cubicInOut")
});

export const SceneTimelineSchema = z.object({
  duration: z.number().positive(),
  narrationStartSeconds: z.number().nonnegative().default(0),
  actions: z.array(TimelineActionSchema)
}).superRefine((timeline, context) => {
  for (const action of timeline.actions) {
    if (action.time + action.duration > timeline.duration + 0.001) {
      context.addIssue({
        code: "custom",
        message: `Action ${action.id} exceeds timeline duration`
      });
    }
  }
});

export type SceneTimeline = z.infer<typeof SceneTimelineSchema>;
