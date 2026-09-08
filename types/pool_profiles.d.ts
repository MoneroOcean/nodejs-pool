import type { CoinProfile } from "./coin_profiles";
import type { CoinRuntime, ProtoMessage, SupportRuntime } from "./runtime";
import type { Socket } from "node:net";

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
    coinHashFactor: number;
    isHashFactorChange: boolean;
    templateSubmissions?: Set<string>;
    templateSubmissionLimitLogged?: boolean;
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
    parent_blocktemplate_blob?: string;
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
export interface PoolJob extends ProtoMessage {
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
    submissions: Map<string, number>;
    usesProxyNonce?: boolean;
    clientPoolLocation?: number;
    clientNonceLocation?: number;
    c29_packed_edges?: number[];
    rewarded_difficulty?: number;
    rewarded_difficulty2?: number;
}

/** The bounded queue used to retain jobs for duplicate-submission checks. */
export interface PoolJobBuffer {
    enq(job: PoolJob): void;
    toarray(): PoolJob[];
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
    pushMessage(message: Record<string, unknown>): void;
    ensureEthExtranonce?(): boolean;
    getCoinJob(coin: string, params: PoolJobParams): PoolJobPayload | null;
    sendCoinJob(coin: string, params: PoolJobParams, options?: {job?: PoolJobPayload | null}): void;
    rememberEthProxyWork?(job: PoolJobPayload): void;
    buildEthProxyWorkResult?(job: PoolJobPayload): unknown;
}

/**
 * Complete miner state shared by protocol, verification, and retarget code.
 * Optional fields represent values that are genuinely absent until a miner
 * logs in, selects a coin, or receives its first job.
 */
export interface PoolMiner extends PoolMinerView {
    id: string;
    payout: string;
    address: string;
    paymentID: string | null;
    identifier: string;
    debugMiner: boolean;
    whiteList: boolean;
    email: string;
    logString: string;
    agent: string;
    invalidLogKey?: string;
    algos: Record<string, number>;
    coin_perf: Record<string, number>;
    algo_min_time: number;
    payout_div: Record<string, number> | null;
    fixed_diff: boolean;
    difficulty: number;
    error: string;
    valid_miner: boolean;
    delay_reply?: number;
    removed_miner: boolean;
    xmrig_proxy: boolean;
    ipAddress: string;
    connectTime: number;
    lastSocketActivity: number;
    lastProtocolActivity: number;
    lastContact: number;
    lastValidShareTimeMs: number;
    hasSubmittedValidShare: boolean;
    acceptedShareCount: number;
    invalidJobIdCount: number;
    lastShareTime: number;
    validShares: number;
    invalidShares: number;
    hashes: number;
    wallet_key: string;
    poolTypeEnum: number;
    port: number;
    portType: string | number;
    protocol: string;
    login_extensions: string[];
    submit_result: boolean;
    validJobs: PoolJobBuffer;
    cachedJob: PoolJobPayload | null;
    curr_coin_min_diff: number;
    curr_coin?: string | false;
    curr_coin_time?: number;
    jobLastBlockHash?: string;
    newDiffToSet?: number | null;
    newDiffRecommendation?: number | null;
    invalidShareCount?: number;
    lastInvalidShareTime?: number;
    lastSlowHashAsyncDelay?: number;
    trust?: {trust: number, check_height: number};
    proxyMinerName?: string;
    setAlgos(nextAlgos: string[], nextAlgosPerf?: Record<string, unknown>, nextAlgoMinTime?: unknown): string;
    setNewDiff(difficulty: number): boolean;
    calcNewDiff(): number;
    selectBestCoin(): string | false;
    sendSameCoinJob(): void;
    sendBestCoinJob(): void;
    getBestCoinJob(): PoolJobPayload | null | undefined;
    touchSocketActivity(timeNow?: number): void;
    touchProtocolActivity(timeNow?: number): void;
    touchValidShare(timeNow?: number): void;
    syncUserRecord(timeNow?: number): void;
    heartbeat(): void;
    storeInvalidShare(): void;
    checkBan(validShare: boolean): boolean;
    ensureEthExtranonce?(): boolean;
}

/** Socket state attached by the pool transport and protocol layers. */
export interface PoolSocket extends Socket {
    miner_id?: string;
    firstShareTimer?: NodeJS.Timeout | null;
    authTimer?: NodeJS.Timeout | null;
    finalReplyTimer?: NodeJS.Timeout | null;
    destroyReason?: string;
    __poolClosedByRegistry?: boolean;
    finalizing?: boolean;
    debugMiner?: boolean;
    eth_agent?: string;
    eth_extranonce_id?: number;
    eth_extranonce_preview_id?: number;
    mo_native?: boolean;
    submit_result?: boolean;
    protocolErrorCount?: number;
    lastSocketActivity?: number;
    localAddress?: string;
    localFamily?: string;
    localPort?: number;
    normalizedRemoteAddress?: string;
    subnet24?: string | null;
}

/** Mutable hash-rate window shared by miners and wallet/proxy aggregates. */
export interface PoolHashRateSource {
    hashes: number;
    connectTime: number;
    connectTimeShift?: number;
    hashesShift?: number;
}

/** State used by pool modules after startup has normalized all shared maps. */
export interface PoolRuntimeState {
    nonceCheck32: RegExp;
    nonceCheck64: RegExp;
    hashCheck32: RegExp;
    hexMatch: RegExp;
    localhostCheck: RegExp;
    activeMiners: Map<string, PoolMiner>;
    activeMinersByPayout: Map<string, Set<string>>;
    activeMinerSockets: Map<string, PoolSocket>;
    activeBlockTemplates: Record<string, PoolBlockTemplate>;
    pastBlockTemplates: Record<string, {enq(template: PoolBlockTemplate): void, toarray(): PoolBlockTemplate[]} >;
    bannedTmpIPs: Record<string, number>;
    bannedTmpWallets: Record<string, number>;
    bannedBigTmpWallets: Record<string, number>;
    bannedAddresses: Record<string, string>;
    notifyAddresses: Record<string, string>;
    minerWallets: Record<string, {last_ver_shares: number, hashes: number, connectTime: number, count: number, submissionBudget: boolean} & PoolHashRateSource>;
    proxyMiners: Record<string, {last_ver_shares?: number, hashes: number, connectTime: number, count: number, submissionBudget: boolean} & PoolHashRateSource>;
    walletTrust: Record<string, number>;
    walletLastSeeTime: Record<string, number>;
    walletLastCheckTime: Record<string, number>;
    minerAgents: Record<string, number>;
    walletDebug: Record<string, unknown>;
    ipWhitelist: Record<string, unknown>;
    lastMinerLogTime: Record<string, number>;
    lastMinerNotifyTime: Record<string, number>;
    lastCoinHashFactorMM: Record<string, number>;
    anchorState: {current: number | undefined, previous: number | undefined};
    shareStats: {totalShares: number, trustedShares: number, normalShares: number, invalidShares: number, outdatedShares: number, throttledShares: number};
    rpcRateBuckets: Map<string, {tokens: number, lastRefillAt: number}>;
    threadName: string | undefined;
    minerCount: Record<number, number>;
    workerMinerCounts: Record<number, Record<number, number>>;
    freeEthExtranonces: number[];
    lastEthExtranonceOverflowNoticeAt: number;
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
    sendReply(error: unknown, result?: unknown): void;
    sendReplyFinal(error: unknown, delayReply?: number): void;
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
    blockData: Buffer | unknown[] | string;
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
/** Fields actually read by the common submission validator. */
export interface PoolSubmitValidationSettings {
    sharedTemplateNonces?: boolean;
    requireFullNonceExtraNoncePrefix?: boolean;
    validateExtraSubmitFields?(this: PoolSubmitValidationSettings, context: PoolSubmitContext): boolean;
}

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
    validateSubmitParams(this: PoolSubmitValidationSettings, context: PoolSubmitContext): boolean;
    validateExtraSubmitFields?(this: PoolSubmitValidationSettings, context: PoolSubmitContext): boolean;
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
