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
    coinFuncs: ProfileCoinFuncs;
    getPoolAddress(profile: CoinProfile): string;
    mmPortSet: Record<string, number>;
    mmNonceSize: number;
    poolNonceSize: number;
    toBuffer: typeof import("../lib/coins/helpers").toBuffer;
    owner: {lastBlockCache?: Record<string, {hash: string, header: RawBlockHeader}>};
}

export type RawCoinCallback = (error: unknown, body?: RawBlockHeader) => void;
export interface ProfileCoinFuncs {
    getPortAnyBlockHeaderByHash(port: number, hash: string | Buffer, isOurBlock: boolean, callback: RpcCallback, noErrorReport?: boolean): void;
    getPortBlockHeaderByID(port: number, blockId: number | string, callback: RpcCallback, noErrorReport?: boolean): void;
    getPortBlockTemplate(port: number, callback: RpcCallback, noErrorReport?: boolean): void;
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
    [method: string]: unknown;
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
    selectWalletTransferReward?(context: {body: RpcRecord, rewardCheck: number, runtime: ProfileRuntime, transfer: WalletTransfer, transfers: WalletTransfer[]}): number | undefined;
    createBlockTemplate?(api: typeof import("node-blocktemplate"), result: Record<string, unknown>, poolAddress: string): BlockTemplateRecord;
    getBlockHeaderById?(context: BlockHeaderRpcContext): unknown;
    getAnyBlockHeaderByHash?(context: BlockHashRpcContext): unknown;
    getLastBlockHeader?(context: RpcContext): unknown;
    getBlockTemplate?(context: RpcContext): unknown;
    enrichLastBlockHeader?(context: HeaderEnrichmentRpcContext): unknown;
}

export interface RpcRecord {
    [key: string]: unknown;
}

export interface RawEthTransaction {
    hash: string;
    gasPrice: string;
}

export interface RawEthReceipt {
    result: {gasUsed: string, transactionHash: string};
}

/** Raw daemon data is validated by each adapter before entering pool logic. */
export interface RawBlockHeader extends RpcRecord {
    hash?: string;
    id?: string;
    height?: number | string | null;
    difficulty?: number | string | null;
    reward?: number | string | null;
    timestamp?: number | string | null;
    time?: number | string | null;
    mediantime?: number | string | null;
    confirmations?: number | string | null;
    uncles?: string[];
    error?: unknown;
}

export type RpcCallback = (first: unknown, second?: unknown) => unknown;
export type RawReplyCallback = RpcCallback;

export interface RpcContext {
    callback: RpcCallback;
    noErrorReport?: boolean;
    port: number;
    profile: CoinProfile;
    runtime: ProfileRuntime;
}
export interface BlockHeaderRpcContext extends RpcContext {
    blockId: number | string;
}
export interface BlockHashRpcContext extends RpcContext {
    blockHash: string;
    isOurBlock: boolean;
}
export interface HeaderEnrichmentRpcContext extends RpcContext {
    header: RawBlockHeader;
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
    pool?: Partial<import("./pool_profiles").PoolProfileSettings>;
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
    pool: Partial<import("./pool_profiles").PoolProfileSettings>;
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
export interface BlockTemplateInput extends Record<string, unknown> {
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

export type EthBlockCallback = (hash: string | null, height?: number | null, profile?: CoinProfile | null) => void;
