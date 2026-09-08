import type { CoinProfile } from "./coin_profiles";
import type { CoinRuntime, ProtoMessage, SupportRuntime } from "./runtime";

/** Values returned to a miner by a pool job builder. */
export type PoolJobPayload = ProtoMessage | unknown[];

export interface XtmBlock extends ProtoMessage {
    header: {
        nonce?: string;
        pow: {pow_data: unknown[]};
    };
}

/** A block template after the coin runtime has attached pool-facing helpers. */
export interface PoolBlockTemplate extends ProtoMessage {
    idHash: string;
    coin: string;
    port: number;
    height: number;
    difficulty: number;
    block_version?: number;
    hash?: string;
    hash2?: string;
    xmr_difficulty?: number;
    xtm_difficulty?: number;
    seed_hash?: string;
    bits?: string;
    extraNonce?: number;
    disableProxyNonce?: boolean;
    clientPoolLocation?: number;
    clientNonceLocation?: number;
    reserved_offset?: number;
    blocktemplate_blob?: string;
    buffer?: Buffer;
    xtm_height?: number;
    xtm_block?: XtmBlock;
    child_template?: PoolBlockTemplate;
    child_template_buffer?: Buffer;
    timeCreated?: number;
    timeoutTime?: number;
    nextBlobHex(): string;
    nextBlobWithChildNonceHex(): string;
}

/** The tracked job metadata attached to a miner-facing payload. */
export interface PoolJob {
    id: string;
    coin: string;
    blob_type_num: number;
    blockHash: string;
    extraNonce?: number | string;
    height: number;
    seed_hash?: string;
    difficulty: number;
    norm_diff: number;
    coinHashFactor: number;
    hashesPerDifficulty: number;
    coinDifficultyFactor: number;
    submissions: Map<string, unknown>;
    usesProxyNonce?: boolean;
    clientPoolLocation?: number;
    clientNonceLocation?: number;
    c29_packed_edges?: number[];
    rewarded_difficulty?: number;
    rewarded_difficulty2?: number;
}

/** Fields of a miner that are consumed by executable pool handlers. */
export interface PoolMinerView {
    id: string;
    payout: string;
    protocol: string;
    proxy: boolean;
    mo_native?: boolean;
    nativeJobAlgo?: string;
    agent?: string;
    eth_extranonce?: string;
    last_diff?: number;
    last_target?: string;
    trust?: {trust: number, check_height: number};
    trust_key?: string;
    pushMessage(message: unknown): void;
    ensureEthExtranonce?(): boolean;
    getCoinJob(coin: string, params: PoolJobParams): PoolJobPayload | null;
    sendCoinJob(coin: string, params: PoolJobParams, options?: {job?: PoolJobPayload | null}): void;
    rememberEthProxyWork?(job: PoolJobPayload): void;
    buildEthProxyWorkResult?(job: PoolJobPayload): unknown;
}

export interface PoolJobParams {
    bt: PoolBlockTemplate;
    coinHashFactor: number;
    hashesPerDifficulty?: number;
    algo_name: string;
}

export interface BuildJobContext {
    blobHex: string;
    blobTypeNum: number;
    blockTemplate: PoolBlockTemplate;
    coin: string;
    coinDiff: number;
    coinFuncs: CoinRuntime;
    getRavenTargetHex(value: number): string;
    getTargetHex(value: number, size?: number): string;
    miner: PoolMinerView;
    newJob: PoolJob;
    params: PoolJobParams;
    toBigInt(value: number | string | bigint | Buffer): bigint;
}

export interface PushJobContext {
    job: PoolJobPayload;
    miner: PoolMinerView;
    native: boolean;
    params: PoolJobParams;
}

export interface PoolAuthorizeAlgoContext {
    coinFuncs: CoinRuntime;
    port: number;
    profile: CoinProfile;
}

export interface PoolAuthorizeAlgoState {
    algos: string[];
    algosPerf: Record<string, number>;
    algoMinTime: number;
}

export interface PoolLoginContext {
    coin: string;
    jobParams: PoolJobParams;
    miner: PoolMinerView;
    minerId: string;
    sendReply(error: string | null, result?: unknown): void;
    sendReplyFinal(error: string): void;
}

export interface PoolExtraNonceLoginContext extends PoolLoginContext {
    minerId: string;
    scheduleFirstShareTimer(minerId: string): void;
    socket: {
        eth_extranonce_id?: number;
        eth_extranonce_preview_id?: number;
    };
    utils: {
        ethExtranonce(id: number): string;
        getNewEthExtranonceId(): number | null;
    };
}

export interface PoolSubmitParams {
    job_id?: string | number;
    nonce?: string | number;
    result?: string;
    raw_params?: unknown[];
    header_hash?: string;
    mixhash?: string;
    pow?: number[];
    poolNonce?: number;
    workerNonce?: number;
    [field: string]: unknown;
}

export interface PoolValidationState {
    nonceCheck32: RegExp;
    nonceCheck64: RegExp;
    hashCheck32: RegExp;
}

export interface PoolSubmitContext {
    blobTypeNum: number;
    coinFuncs: CoinRuntime;
    job: PoolJob;
    miner: PoolMinerView;
    normalizeExtraNonceSubmitNonce(nonce: string, extraNonce: string | undefined, options?: {requireFullNonceExtraNoncePrefix?: boolean}): string | null;
    params: PoolSubmitParams;
    state: PoolValidationState;
}

export interface PoolSubmissionKeyContext {
    miner: PoolMinerView;
    job: PoolJob;
    params: PoolSubmitParams;
}

export interface PoolSpecialShareContext {
    blockTemplate: PoolBlockTemplate;
    coinFuncs: PoolSpecialCoinRuntime;
    getBlockSubmitTestResultBuffer?(): Buffer | null;
    getShareBuffer(): Buffer | null;
    bigIntToBuffer(value: bigint, options: {endian: "big" | "little", size: number}): Buffer;
    ge(left: number | bigint, right: number | bigint): boolean;
    hashBuffDiff(hash: Buffer): number | bigint;
    hashEthBuffDiff(hash: Buffer): number | bigint;
    hashRavenBuffDiff(hash: Buffer): number | bigint;
    invalidShare(miner: PoolMinerView): boolean | null;
    isBlockCandidateDiff?(difficulty: number | bigint): boolean;
    isSafeToTrust(difficulty: number, trustKey: string, trust: number): boolean;
    job: PoolJob;
    miner: PoolMinerView;
    params: PoolSubmitParams;
    processShareCB(result: boolean | null): void;
    reportMinerShare(miner: PoolMinerView, job: PoolJob): void;
    startAsyncVerification?(): void;
    trustKey?: string;
    tryTrustedShare?(accept: () => void): boolean;
    verifyShareCB(diff: number | bigint, result: Buffer | null, blockData: Buffer | unknown[] | string, trusted: boolean, parent: boolean): void;
    verifySlowHashWithRetry(blob: Buffer, context: {nonce?: string | undefined, mixhash?: string | undefined} | null, callback: (hash: string | null | false) => void): void;
}

/** Coin helpers used by the proof and remote-hash pool handlers. */
export interface PoolSpecialCoinRuntime {
    convertBlob(blob: Buffer, port: number): Buffer | null;
    c29(header: Buffer, ring: number[], port: number): boolean;
    c29_packed_edges(ring: number[], blobTypeNum: number, hint?: number | string | ProtoMessage): string;
    c29_cycle_hash(packedEdges: string): Buffer;
    kawpowQuickHash(convertedBlob: Buffer, nonce: string, mixhash: string): Buffer;
    slowHashBuff(blob: Buffer, template: ProtoMessage, nonce?: string, mixhash?: string): Buffer | Buffer[] | false;
    slowHashBuffAsync?(blob: Buffer, template: ProtoMessage, minerAddress: string, callback: (result: Buffer | Buffer[] | null | false, errorKind?: string) => void, verifyContext?: ProtoMessage): void;
    isHashVerifierEnabled?(): boolean;
}

export interface PoolBlockAcceptanceContext {
    rpcResult: PoolRpcResult;
    rpcStatus?: number;
}

export interface PoolRpcResult {
    result?: unknown;
    error?: unknown;
    response?: unknown;
    [field: string]: unknown;
}

export interface PoolBlockHashContext {
    blockData: Buffer | unknown[];
    blockTemplate: PoolBlockTemplate;
    coinFuncs: PoolBlockHashCoinRuntime;
    isDisplaySubmitPort: boolean;
    resultBuff: Buffer | null;
    rpcResult: PoolRpcResult;
}

/** Coin runtime used while resolving accepted block submissions. */
export type PoolBlockHashCoinRuntime = CoinRuntime;

export interface PoolSubmitBlockContext {
    blockData: Buffer | unknown[] | string;
    blockTemplate: PoolBlockTemplate;
    hashDiff: number;
    isBlockSubmitTestModeEnabled(): boolean;
    isParentBlock: boolean;
    isTrustedShare: boolean;
    job: PoolJob;
    params: unknown;
    portUsedToSubmit?: number;
    replyDispatcher(rpcResult: unknown, rpcStatus: number | undefined, port: number, nextSubmitBlockCB?: ((success: boolean) => void) | null, isDisplaySubmitPort?: boolean): void;
    replyFn(rpcResult: unknown, rpcStatus?: number): void;
    submitBlockCB?: ((success: boolean) => void) | null;
    submitRetryCount?: number;
    suppressFailureEmail: boolean;
    support: SupportRuntime;
}

/** Executable settings shared by all pool protocol profiles. */
export interface PoolProfileSettings {
    minDifficulty: number | "config";
    niceHashDiffMultiplier?: number;
    hashesPerDifficulty?: number;
    integerDifficulty?: boolean;
    sharedTemplateNonces?: boolean;
    sharedTemplateSubmissions?: boolean;
    disableProxyNonce?: boolean;
    requiresExtranonce?: boolean;
    useEthJobId?: boolean;
    requireFullNonceExtraNoncePrefix?: boolean;
    jobAlgo?: string;
    edgeBits?: number;
    dualSubmitDisplayCoin?: string;
    dualSubmitReportPort?: number;
    mainSubmitPort?: number;
    dualSubmitPort?: number;
    buildJobPayload(this: PoolProfileSettings, context: BuildJobContext): PoolJobPayload;
    buildProxyJobPayload(this: PoolProfileSettings, context: BuildJobContext): PoolJobPayload;
    pushJob(this: PoolProfileSettings, context: PushJobContext): void;
    parseMiningSubmitParams?(context: {params: PoolSubmitParams}): boolean;
    validateSubmitParams(this: PoolProfileSettings, context: PoolSubmitContext): boolean;
    validateExtraSubmitFields?(this: PoolProfileSettings, context: PoolSubmitContext): boolean;
    submissionKey(context: PoolSubmissionKeyContext): string;
    submitSuccess?: "boolean" | "status";
    authorizeAlgoState(context: PoolAuthorizeAlgoContext): PoolAuthorizeAlgoState;
    sendLoginResult(context: PoolLoginContext): void;
    verifySpecialShare?: ((context: PoolSpecialShareContext) => boolean) | null;
    acceptSubmittedBlock(context: PoolBlockAcceptanceContext): boolean;
    resolveSubmittedBlockHash(context: PoolBlockHashContext, callback: (blockHash: string) => void): void;
    submitBlockRpc(this: PoolProfileSettings, context: PoolSubmitBlockContext): void;
}

/** The subset needed while building and dispatching miner jobs. */
export interface PoolJobSettings {
    integerDifficulty?: boolean;
    sharedTemplateNonces?: boolean;
    disableProxyNonce?: boolean;
    useEthJobId?: boolean;
    requiresExtranonce?: boolean;
    buildJobPayload(context: BuildJobContext): PoolJobPayload;
    buildProxyJobPayload(context: BuildJobContext): PoolJobPayload;
    pushJob?(context: PushJobContext): void;
}

export interface PoolAccepted202Context {
    rpcResult: string;
    rpcStatus?: number;
}

export interface PoolSubmitAcceptHandlers {
    statusOkObject(context: PoolBlockAcceptanceContext): boolean;
    xtmBlockHashResult(context: PoolBlockAcceptanceContext): boolean;
    accepted202String(context: PoolAccepted202Context): boolean;
}

export interface PoolBlockHashHandlers {
    deroBlid(context: PoolBlockHashContext, callback: (blockHash: string) => void): void;
    xtmRpcHash(context: PoolBlockHashContext, callback: (blockHash: string) => void): void;
}

export interface PoolBlockSubmitHandlers {
    httpBlockBody(context: PoolSubmitBlockContext): void;
    btc(context: PoolSubmitBlockContext): void;
    dero(context: PoolSubmitBlockContext): void;
    xtmRx(context: PoolSubmitBlockContext): void;
    dualMain(this: PoolProfileSettings, context: PoolSubmitBlockContext): void;
}

export interface PoolFactories {
    standard(overrides?: Partial<PoolProfileSettings>): PoolProfileSettings;
    raven(overrides?: Partial<PoolProfileSettings>): PoolProfileSettings;
    eth(overrides?: Partial<PoolProfileSettings>): PoolProfileSettings;
    erg(overrides?: Partial<PoolProfileSettings>): PoolProfileSettings;
    grin(overrides?: Partial<PoolProfileSettings>): PoolProfileSettings;
    xtmC(overrides?: Partial<PoolProfileSettings>): PoolProfileSettings;
    submitAccept: PoolSubmitAcceptHandlers;
    blockHash: PoolBlockHashHandlers;
    blockSubmit: PoolBlockSubmitHandlers;
}
