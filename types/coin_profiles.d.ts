import type { BlockHeader, BlockTemplateRecord, CoinRuntime, SupportRuntime } from "./runtime";

export interface VersionRule {
    matcher: string;
    minVersionInclusive?: string;
    maxVersionExclusive?: string;
    message?: string;
    unsupportedAlgos?: string[];
}
export interface PerformanceSettings {
    aliases?: string[];
    legacyDifficultyAliases?: string[];
    mainAlgo?: boolean;
    prevMainAlgo?: boolean;
    defaultPerf?: number;
    prevDefaultPerf?: number;
    extraPrevDefaultPerf?: Record<string, number>;
    hashFactorDisabled?: boolean;
}
export interface TemplateSettings {
    hashOnly?: boolean;
    bufferField?: string;
    reserveOffsetSource?: string;
}
export interface ProfileRuntime {
    blockTemplate: typeof import("node-blocktemplate");
    powHash: typeof import("node-powhash");
    support: SupportRuntime;
    coinFuncs: CoinRuntime;
    getPoolAddress(profile: CoinProfile): string;
    mmPortSet: Record<string, number>;
    mmNonceSize: number;
    poolNonceSize: number;
    toBuffer: typeof import("../lib/coins/helpers").toBuffer;
    owner: {lastBlockCache?: Record<string, {hash: string, header: BlockHeader}>};
}
export interface BlobSettings {
    nonceSize: number;
    proofSize: number;
    nonceOffset?: number;
    convert?(context: {runtime: ProfileRuntime, profile: CoinProfile, blobBuffer: Buffer}): Buffer;
    construct?(this: BlobSettings, context: {runtime: ProfileRuntime, profile: CoinProfile, blockTemplateBuffer: Buffer, params: {nonce: string, mixhash?: string, pow?: number[]}}): Buffer;
    getBlockId?(context: {runtime: ProfileRuntime, profile: CoinProfile, blockBuffer: Buffer}): Buffer;
}
export interface HashContext {
    runtime: ProfileRuntime;
    profile: CoinProfile;
    algo: string;
    convertedBlob: Buffer;
    blockTemplate: BlockTemplateRecord;
    nonce?: string;
    mixhash?: string;
}
export interface PowSettings {
    variant?: number;
    useHeight?: boolean;
    verifyInput?(this: PowSettings, context: HashContext): {algo: string, blob: string, seed_hash?: string, height?: number, nonce?: string, mixhash?: string};
    hashBuff?(this: PowSettings, context: HashContext): Buffer | Buffer[] | false;
    c29?(context: {runtime: ProfileRuntime, header: Buffer, ring: number[]}): boolean;
    packEdges?(context: {runtime: ProfileRuntime, ring: number[]}): string;
}
export interface WalletTransfer {
    amount: number;
    asset_type?: string;
    amounts?: number[];
}
export interface RpcSettings {
    addressCoin?: string;
    headerRewardMode?: string;
    unlockConfirmationDepth?: number;
    walletRewardLookup?: boolean;
    walletZeroRewardAllowed?: boolean;
    blockByHeightMethod?: string;
    blockHeaderByHashMethod?: string;
    blockByHashMethod?: string;
    difficultyMultiplier?: number;
    rewardMultiplier?: number;
    headerProvidesTemplate?: boolean;
    liveTipProbe?: boolean;
    skipHashFallbackByHeight?: boolean;
    baseReward?: number | ((height: number) => number | null);
    uncleBaseReward?: number;
    fixedUncleReward?: boolean;
    callbackTimeoutMs?: number;
    lastHeaderMmCoin?: string;
    selectWalletTransferReward?(context: {transfer: WalletTransfer, transfers: WalletTransfer[]}): number | undefined;
    createBlockTemplate?(api: typeof import("node-blocktemplate"), result: Record<string, unknown>, poolAddress: string): BlockTemplateRecord;
}
export interface CoinProfileSpec {
    port: number;
    coin: string | null;
    algo: string;
    blobType: number;
    blobTypeName: string;
    displayCoin?: string;
    listed?: boolean;
    aliases?: string[];
    blob?: Partial<BlobSettings>;
    pow?: PowSettings;
    rpc?: RpcSettings;
    template?: TemplateSettings;
    perf?: PerformanceSettings;
    pool?: Record<string, unknown>;
    mergedMining?: {childPort: number};
    minerAlgoAliases?: Record<string, string[]>;
    network?: Record<string, {prefix: number, subPrefix: number, intPrefix: number}>;
    addresses?: {coinDev: string, poolDev: string, blocked?: string[]};
    agent?: {warningRules?: VersionRule[], noSupportRules?: VersionRule[], unsupportedByMatcher?: Record<string, string>};
    niceHashDiff?: number;
}
export interface CoinProfile extends CoinProfileSpec {
    displayCoin: string;
    listed: boolean;
    aliases: string[];
    blob: BlobSettings;
    pow: PowSettings;
    rpc: RpcSettings;
    template: TemplateSettings;
    perf: PerformanceSettings;
    pool: Record<string, unknown>;
}

export type ProfileInput = Pick<CoinProfileSpec, "port" | "coin"> & Partial<CoinProfileSpec>;
