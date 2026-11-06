export type ContentStatus =
  | "verified-fact"
  | "inference"
  | "editorial-summary"
  | "artistic-reconstruction"
  | "uncertain";

export interface CameraPreset {
  longitude: number;
  latitude: number;
  height: number;
  heading: number;
  pitch: number;
  roll: number;
}

export interface RegionRecord {
  id: string;
  name: string;
  nameEn: string;
  level: "district" | "county" | "county-city";
  parentId: "440800";
  sourceCrs: "EPSG:4326";
  center: [number, number];
  labelPoint: [number, number];
  bbox: [number, number, number, number];
  areaKm2: number;
  geometryPath: string;
  cameraPreset: CameraPreset;
  children: string[];
  contentRefs: {
    research: string;
    script: string;
    storyboard: string;
  };
}

export interface FrameStatus {
  time: number;
  ready: boolean;
  tilesReady: boolean;
  imageryReady: boolean;
  terrainReady: boolean;
  fontsReady: boolean;
  entitiesReady: boolean;
  pendingRequests: number;
  errors: string[];
}
