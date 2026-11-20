export declare const OLD_AA: string;
export declare const NEW_AA: string;
export declare const FIX_SIG: string;
export declare function patchFile(file: string, dryRun?: boolean): { file: string; status: string };
export declare function resolveHyperframesDist(): string | null;
export declare function targetPaths(dist: string): string[];
export declare function syncRuntimeManifest(dist: string, dryRun?: boolean): { file: string; status: string };
