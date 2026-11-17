export interface DshPluginConfig {
    binaryPath?: string;
    exemptRecentHours?: number;
}
export declare const name = "agent-cleaner";
export declare const inject: string[];
export declare function apply(ctx: any, config?: DshPluginConfig): void;
declare const _default: {
    name: string;
    inject: string[];
    apply: typeof apply;
};
export default _default;
