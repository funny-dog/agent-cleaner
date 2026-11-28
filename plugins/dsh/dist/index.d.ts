export declare const PLUGIN_VERSION: string;
export interface DshPluginConfig {
    binaryPath?: string;
    exemptRecentHours?: number;
    downloadUrl?: string;
}
export declare const name = "agent-cleaner";
export declare const inject: string[];
export declare function resolveReleaseAssetName(platform?: NodeJS.Platform, arch?: string): string;
export declare function isNativeBinaryCandidate(filePath: string): boolean;
export declare function findExistingBinaryPath(configured?: string): string | null;
export declare function extractBinaryFromTarGz(gzBuffer: Buffer, targetFileName: string): Buffer;
export declare function extractBinaryFromZip(zipBuffer: Buffer, targetFileName: string): Buffer;
export declare function ensureBinaryPath(config?: DshPluginConfig): Promise<string>;
export interface ScanProgressState {
    active: boolean;
    completed: number;
    total: number;
    agent: string;
    currentBytes: number;
    updatedAt: number;
}
export declare function resolveSpawnSpec(binaryPath: string, args: string[], platform?: NodeJS.Platform): {
    command: string;
    args: string[];
};
export declare function apply(ctx: any, config?: DshPluginConfig): void;
declare const _default: {
    name: string;
    inject: string[];
    apply: typeof apply;
};
export default _default;
