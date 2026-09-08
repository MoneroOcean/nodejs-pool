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
    bufferField?: "blocktemplate_blob" | "blockhashing_blob" | "blob";
    reserveOffsetSource?: string;
}
export interface ProfileRuntime {
    blockTemplate: typeof import("node-blocktemplate");
    powHash: typeof import("node-powhash");
    support: SupportRuntime;
    coinFuncs: Pick<CoinRuntime, "getPortAnyBlockHeaderByHash" | "getPortBlockHeaderByID" | "getPortBlockTemplate">;
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
    convert?(context: {runtime: ProfileRuntime, profile: CoinProfile, port: number, blobBuffer: Buffer}): Buffer;
    construct?(this: BlobSettings, context: {runtime: ProfileRuntime, profile: CoinProfile, port: number, blockTemplateBuffer: Buffer, params: {nonce: string, mixhash?: string, pow?: number[]}}): Buffer;
    getBlockId?(context: {runtime: ProfileRuntime, profile: CoinProfile, port: number, blockBuffer: Buffer}): Buffer;
}
export interface HashContext {
    runtime: ProfileRuntime;
    profile: CoinProfile;
    algo: string;
    port: number;
    convertedBlob: Buffer;
    blockTemplate: {height: number, seed_hash?: string};
    nonce?: string;
    mixhash?: string;
}
export interface PowSettings {
    variant?: number;
    useHeight?: boolean;
    verifyInput?(this: PowSettings, context: HashContext): {algo: string, blob: string, seed_hash?: string, height?: number, nonce?: string, mixhash?: string};
    hashBuff?(this: PowSettings, context: HashContext): Buffer | Buffer[] | false;
    c29?(context: {runtime: ProfileRuntime, profile: CoinProfile, port: number, header: Buffer, ring: number[]}): boolean;
    packEdges?(context: {runtime: ProfileRuntime, profile: CoinProfile, blobType: number, ring: number[]}): string;
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
    agent?: {warningRules?: (VersionRule & {message: string})[], noSupportRules?: VersionRule[], unsupportedByMatcher?: Record<string, string>};
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

export interface BtcOutput {
    value: number;
    scriptPubKey?: {addresses?: string[], address?: string};
}
export interface BtcRewardBlock {
    tx: [{vout: BtcOutput[]}, ...unknown[]];
    difficulty: number;
    reward?: number;
}
export type EthRewardBlock = import("../lib/coins/helpers").EthRewardBlock & {
    number: string;
    hash: string;
    reward?: number | null;
    height?: number;
    confirmations?: number;
}
export type RawReplyCallback = (error: unknown, body: unknown) => void;

export interface BlockTemplateInput {
    port: number;
    height: number;
    difficulty: number;
    coin?: string;
    hash?: string;
    hash2?: string;
    bits?: string;
    seed_hash?: string;
    mbl_difficulty?: number;
    wide_difficulty?: string;
    _aux?: {base_difficulty?: number | string, chains?: unknown[]};
    xtm_block?: Record<string, unknown>;
    no_proxy_nonce?: boolean;
    disable_proxy_nonce?: boolean;
    blocktemplate_blob?: string;
    blockhashing_blob?: string;
    blob?: string;
    parent_blocktemplate_blob?: string;
    child_template?: BlockTemplateInput;
    child_template_buffer?: Buffer;
    reserved_offset?: number;
    reservedOffset?: number;
    bt_nonce_size?: number;
}

export interface HashTemplate {
    port: number;
    height: number;
    block_version?: number;
    seed_hash?: string;
}
export interface VerifyContext {nonce?: string; mixhash?: string}
export type HexHashResult = string | string[] | false | null;
export type BufferHashResult = Buffer | (Buffer | false | null)[] | false | null;
