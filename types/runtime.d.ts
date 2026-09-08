/** Shared runtime contracts for the JavaScript services.
 *
 * The application wires these values on `global` during startup.  Keeping the
 * declarations here lets checked JavaScript modules describe the boundary once
 * while individual modules retain the narrower records they actually consume.
 */

import type { EventEmitter } from "node:events";
import type { IncomingHttpHeaders, Server, ServerResponse } from "node:http";

export type Scalar = string | number | boolean | bigint | Date | Buffer | null;
export interface BlockTemplateRecord extends ProtoMessage {
    hash: string;
    hash2?: string;
    height: number;
    difficulty: number;
    reward: number;
    seed_hash?: string;
    port?: number;
    blocktemplate_blob?: string;
    blockhashing_blob?: string;
    blob?: string;
}
/** Normalized header returned by the coin RPC adapters. */
export interface BlockHeader extends ProtoMessage {
    hash: string;
    height: number;
    difficulty: number;
    reward: number;
    timestamp: number;
    time?: number;
    mediantime?: number;
    diff?: number;
}
export type SqlParam = Scalar | readonly SqlParam[] | undefined;
export interface SqlRow {
    [column: string]: Scalar | undefined;
}
export interface SqlRows extends Array<SqlRow> {
    affectedRows?: number;
    insertId?: number;
}
export interface SqlConnection {
    query<T extends SqlRows | SqlRow = SqlRows>(sql: string, params?: readonly SqlParam[]): Promise<T>;
    beginTransaction(): Promise<void>;
    commit(): Promise<void>;
    rollback(): Promise<void>;
    release(): void;
}
export interface SqlPool {
    query<T extends SqlRows | SqlRow = SqlRows>(sql: string, params?: readonly SqlParam[]): Promise<T>;
    getConnection(): Promise<SqlConnection>;
    end(callback?: (error?: Error) => void): void;
}

export type LmdbDbi = import("node-lmdb").Dbi;
export type Dbi = LmdbDbi;
export type LmdbTxn = import("node-lmdb").Txn;
export type Txn = LmdbTxn;
/** Cursor keys are widened because integer LMDB databases return numeric keys. */
export type LmdbCursor = import("node-lmdb").Cursor<string | number | Buffer>;
export type Cursor = LmdbCursor;
export type LmdbEnv = import("node-lmdb").Env & {
    sync?: (callback?: () => void) => void;
};
/** The package's native module surface; the package ships its own declarations. */
export type LmdbApi = typeof import("node-lmdb");

export interface ProtoMessage {
    [field: string]: unknown;
}
export interface BlockMessage extends ProtoMessage {
    hash: string;
    difficulty: number;
    shares: number;
    timestamp: number;
    poolType: number;
    unlocked: boolean;
    valid: boolean;
    value?: number | undefined;
    pay_ready?: boolean;
}
/** A main-chain block after its LMDB key has been attached by the database layer. */
export interface BlockRecord extends BlockMessage {
    height: number;
    pool_type?: string;
}
export type Block = BlockRecord;
export interface BlockListEntry {
    ts: number;
    hash: string;
    diff: number;
    shares: number;
    height: number;
    valid: boolean;
    unlocked: boolean;
    pool_type: string;
    value?: number | undefined;
}
export interface AltBlockMessage extends BlockMessage {
    port: number;
    height: number;
    anchor_height: number;
    pay_value?: number | undefined;
    pay_stage?: string | undefined;
    pay_status?: string | undefined;
}
/** An alternate-chain block after its LMDB key has been attached. */
export interface AltBlockRecord extends AltBlockMessage {
    id: number;
    pool_type?: string;
}
export type AltBlock = AltBlockRecord;
export interface AltBlockListEntry {
    ts: number;
    hash: string;
    diff: number;
    shares: number;
    height: number;
    valid: boolean;
    unlocked: boolean;
    pool_type: string;
    value?: number | undefined;
    pay_value?: number | undefined;
    pay_stage?: string | undefined;
    pay_status?: string | undefined;
    port: number;
}
export interface ShareMessage extends ProtoMessage {
    shares?: number;
    paymentAddress: string;
    foundBlock: boolean;
    paymentID?: string;
    trustedShare: boolean;
    poolType: number;
    poolID: number;
    blockDiff: number;
    blockHeight: number;
    timestamp: number;
    identifier: string;
    port?: number;
    shares2?: number;
    share_num?: number;
    raw_shares?: number;
}
export type Share = ShareMessage;
export interface InvalidShareMessage extends ProtoMessage {
    paymentAddress: string;
    paymentID?: string;
    identifier: string;
    count?: number;
}
export interface WSDataMessage extends ProtoMessage {
    msgType: number;
    key: string;
    msg: Buffer;
    exInt: number;
}
export interface ProtoCodec<T extends ProtoMessage> {
    decode(data: Buffer | null): T;
    encode(data: T): Buffer;
}
export interface ProtoEnum {
    [name: string]: number;
}
export interface ProtoTypes {
    Block: ProtoCodec<BlockMessage>;
    AltBlock: ProtoCodec<AltBlockMessage>;
    Share: ProtoCodec<ShareMessage>;
    InvalidShare: ProtoCodec<InvalidShareMessage>;
    POOLTYPE: ProtoEnum & { PPLNS: number };
    MESSAGETYPE: ProtoEnum;
    WSData: ProtoCodec<WSDataMessage>;
}

/*
 * The following aliases are retained for callers that consume a decoded
 * message and then attach application metadata.  The wire-level message
 * types above intentionally describe only fields present in data.proto.
 */
export type PersistedBlock = BlockMessage;
export type PersistedAltBlock = AltBlockMessage;
export type PersistedShare = ShareMessage;

export interface RpcError {
    code?: number;
    message?: string;
    [field: string]: Scalar | undefined;
}
export interface RpcBody extends ProtoMessage {
    result?: ProtoMessage | Array<ProtoMessage> | string | number | boolean | null;
    error?: RpcError | null;
}
/** Raw response accepted by the HTTP JSON-RPC adapter before callers validate it. */
export type RpcResponse = RpcBody | string | Error;
export type RpcResponseCallback = (body: RpcResponse, statusCode?: number) => void;
/** @deprecated Use RpcResponseCallback for new boundary code. */
export type RpcCallback = RpcResponseCallback;
export type CoinCallback<T = BlockHeader> = (error: Error | string | boolean | null, body?: T) => void;
export type BlockTemplateCallback = (template: BlockTemplateRecord | null, error?: unknown) => void;
export interface FyiOptions {
    batchSubject?: string;
    batchKey?: string;
    now?: number;
    cooldownMs?: number;
    connectionClose?: boolean;
    suppressErrorLog?: boolean;
}

export interface SupportRuntime {
    rpcPortDaemon(port: number, method: string, params: unknown, callback: RpcResponseCallback, noErrorReport?: boolean): void;
    rpcPortDaemon2(port: number, path: string, params: unknown, callback: RpcResponseCallback, noErrorReport?: boolean): void;
    rpcWallet(method: string, params: unknown, callback: RpcResponseCallback, noErrorReport?: boolean): void;
    rpcPortWallet(port: number, method: string, params: unknown, callback: RpcResponseCallback, noErrorReport?: boolean): void;
    rpcPortWallet2(port: number, method: string, params: unknown, callback: RpcResponseCallback, noErrorReport?: boolean): void;
    rpcPortWalletShort(port: number, method: string, params: unknown, callback: RpcResponseCallback, noErrorReport?: boolean): void;
    sendEmail(to: string, subject: string, body: string, ...extra: unknown[]): void;
    sendAdminFyi(key: string, subject: string, body: string, options?: FyiOptions): boolean;
    sendFyi(to: string, key: string, subject: string, body: string, options?: FyiOptions): boolean;
    sendFyiDaily(to: string, key: string, subject: string, buildBody: ((events: Array<Record<string, unknown>>, helpers: { formatTime: (timestamp: number) => string }) => string) | string, event?: Record<string, unknown>, options?: FyiOptions): boolean;
    sleep?(milliseconds: number): Promise<void>;
    formatDate(value: number | Date | string): string;
    formatDateUTC(value: number | Date | string): string;
    formatDateFromSQL(value: number | Date | string): number;
    formatTemplate(template: string, values: Record<string, unknown>): string;
    renderEmailTemplate(item: string, values: Record<string, unknown>, fallback?: string): string;
    maskWalletAddress(address: string): string;
    coinToDecimal(amount: number | string): number;
    decimalToCoin(amount: number): number;
    detectNodeIp(): string;
    getCoinHashFactor(coin: string, callback: (factor: number | null) => void): void;
    setCoinHashFactor(coin: string, value: number): void;
    https_get(url: string, callback: (body: unknown) => void): void;
    parseEmailUnsubscribeToken(token: string): Record<string, unknown> | false;
    renderUnsubscribeErrorHtml(): string;
    renderUnsubscribeSuccessHtml(wallet: string, email: string): string;
    circularBuffer<T>(size: number): { enq(value: T): void; deq(): T | undefined; size(): number; toarray(): T[]; get(index: number): T | undefined };
    tsCompare(left: { ts: number }, right: { ts: number }): number;
}

export type CoinProfile = import("./coin_profiles").CoinProfile;
export interface CoinRuntime {
    BlockTemplate: new (template: ProtoMessage) => ProtoMessage;
    blockedAddresses: string[];
    coinDevAddress: string;
    poolDevAddress: string;
    uniqueWorkerId: number;
    uniqueWorkerIdBits: number;
    niceHashDiff: number;
    baseDiff(): bigint | number | string;
    baseRavenDiff(): bigint | number | string;
    COIN2PORT(coin: string): number | undefined;
    PORT2COIN(port: number | string): string | undefined;
    PORT2COIN_FULL(port: number | string): string;
    getPORTS(): string[];
    getCOINS(): string[];
    getMM_PORTS(): Record<string, unknown>;
    getMM_CHILD_PORTS(): Record<string, unknown>;
    getPoolProfile(key: string | number): CoinProfile | null;
    getCoinProfile(key: string | number): CoinProfile | null;
    getJobProfile(job: ProtoMessage): CoinProfile | null;
    getProfilesByBlobType(blobType: number): CoinProfile[];
    getBlobTraits(blobType: number): { nonceSize: number; proofSize: number };
    getResolvedProfile(key: string | number, version?: number): CoinProfile | null;
    getPoolSettings(key: string | number, version?: number): Partial<import("./pool_profiles").PoolProfileSettings> | null;
    getRpcSettings(key: string | number, version?: number): import("./coin_profiles").RpcSettings | null;
    getPortLastBlockHeader(port: number, callback: CoinCallback<BlockHeader>, noErrorReport?: boolean): void;
    getPortLastBlockHeaderMM(port: number, callback: CoinCallback<BlockHeader & { mm?: BlockHeader }>, noErrorReport?: boolean): void;
    getPortLastBlockHeaderWithRewardDiff(port: number, callback: CoinCallback<BlockHeader>, noErrorReport?: boolean): void;
    getLastBlockHeader(callback: CoinCallback<BlockHeader>, noErrorReport?: boolean): void;
    getBlockHeaderByID(blockId: number | string, callback: CoinCallback<BlockHeader>, noErrorReport?: boolean): void;
    getBlockHeaderByHash(hash: string | Buffer, callback: CoinCallback<BlockHeader>, noErrorReport?: boolean): void;
    getPortBlockHeaderByID(port: number, blockId: number | string, callback: CoinCallback<BlockHeader>, noErrorReport?: boolean): void;
    getPortBlockHeaderByHash(port: number, hash: string | Buffer, callback: CoinCallback<BlockHeader>, noErrorReport?: boolean): void;
    getPortAnyBlockHeaderByHash(port: number, hash: string | Buffer, isOurBlock: boolean, callback: CoinCallback<BlockHeader>, noErrorReport?: boolean): void;
    getPortBlockTemplate(port: number, callback: BlockTemplateCallback, noErrorReport?: boolean): void;
    getBlockTemplate(callback: BlockTemplateCallback, noErrorReport?: boolean): void;
    validatePlainAddress(address: string): boolean;
    validateAddress(address: string): boolean;
    portBlobType(port: number, version?: number): number | undefined;
    blobTypeStr(port: number, version?: number): string;
    hasTemplateBlob(template: ProtoMessage, port: number): boolean;
    convertBlob(blob: Buffer, port: number): Buffer | null;
    constructNewBlob(template: Buffer, params: ProtoMessage, port: number): Buffer | null;
    constructMMParentBlockBlob(parent: Buffer, port: number, child: Buffer): Buffer;
    constructMMChildBlockBlob(share: Buffer, port: number, child: Buffer): Buffer;
    getBlockID(blockBuffer: Buffer, port: number): Buffer;
    slowHashBuff(blob: Buffer, template: ProtoMessage, nonce?: string, mixhash?: string): Buffer | Buffer[] | false;
    slowHash(blob: Buffer, template: ProtoMessage, nonce?: string, mixhash?: string): string | false;
    slowHashAsync(blob: Buffer, template: ProtoMessage, minerAddress: string, callback: (result: string | null | false, errorKind?: string) => void, verifyContext?: ProtoMessage): void;
    slowHashBuffAsync(blob: Buffer, template: ProtoMessage, minerAddress: string, callback: (result: Buffer | Buffer[] | null | false, errorKind?: string) => void, verifyContext?: ProtoMessage): void;
    nonceSize(blobType: number): number;
    c29ProofSize(blobType: number): number;
    isHashVerifierEnabled(): boolean;
    getAuxChainXTM(value: ProtoMessage): ProtoMessage | null;
    getPoolHashesPerDifficulty(key: string | number): number;
    getPoolWorkDifficulty(key: string | number, difficulty: number): number;
    getDefaultAlgos(): string[];
    getDefaultAlgosPerf(): Record<string, number>;
    getPrevAlgosPerf(): Record<string, number>;
    convertAlgosToCoinPerf(algos: Record<string, number>): Record<string, number>;
    normalizeMinerAlgos(algos: Record<string, number>): Record<string, number>;
    algoCheck(algos: Record<string, number>): true | string;
    algoMainCheck(algos: Record<string, number>): boolean;
    algoPrevMainCheck(algos: Record<string, number>): boolean;
    isMinerSupportAlgo(algo: string, algos: Record<string, number>): boolean;
    getUnsupportedAlgosForMiner(agent: string): string[];
    get_miner_agent_warning_notification(agent: string): string | false;
    get_miner_agent_not_supported_algo(agent: string): string | false;
    is_miner_agent_no_haven_support(agent: string): boolean;
    getCoinMinDifficulty(key: string | number): number;
    getNiceHashMinimumDifficulty(key: string | number): number;
    c29(header: Buffer, ring: number[], port: number): boolean;
    c29_packed_edges(ring: number[], blobTypeNum: number, hint?: number | string | ProtoMessage): string;
    c29_cycle_hash(packedEdges: string): Buffer;
    kawpowQuickHash(convertedBlob: Buffer, nonce: string, mixhash: string): Buffer;
    ethBlockCheck(port: number, minerHex: string, nonceHex: string, blockHeightHex: string, callback: (blockHash: string | null, blockHeight?: number | null, profile?: CoinProfile | null) => void): void;
    ethBlockFind(port: number, nonceHex: string, callback: (blockHash: string | null) => void): void;
    fixDaemonIssue(issueOrHeight: ProtoMessage | number | string | null, topHeight?: number, port?: number): void;
    [method: string]: unknown;
}

export interface DatabaseRuntime {
    env: LmdbEnv;
    lmdb: LmdbApi;
    shareDB: LmdbDbi;
    blockDB: LmdbDbi;
    altblockDB: LmdbDbi;
    cacheDB: LmdbDbi;
    thread_id: string | number;
    sendQueue: Array<unknown>;
    getCache(key: string): unknown;
    setCache(key: string, value: unknown): void;
    bulkSetCache?(entries: Record<string, unknown>): void;
    incrementCacheData(key: string, increments: Array<Record<string, unknown>>): void;
    getBlockList(poolType: string | null, minHeight?: number, maxHeight?: number): BlockListEntry[];
    getAltBlockList(poolType: string | null, port?: number | null, minHeight?: number, maxHeight?: number): AltBlockListEntry[];
    getValidLockedBlocks(): BlockRecord[];
    getValidLockedAltBlocks(): AltBlock[];
    storeBlock(height: number, data: Buffer): void;
    storeAltBlock(timestamp: number, data: Buffer): void;
    storeShare(height: number, data: Buffer): void;
    storeInvalidShare(data: Buffer, callback: (stored: boolean) => void): void;
    unlockBlock(hash: string | Buffer): void;
    unlockAltBlock(hash: string | Buffer): void;
    invalidateBlock(height: number): void;
    invalidateAltBlock(id: number | string): void;
    payReadyBlock(hash: string | Buffer): void;
    payReadyAltBlock(hash: string | Buffer): void;
    changeAltBlockPayStageStatus(id: number | string, stage: number, status: number): void;
    changeAltBlockPayValue(id: number | string, value: number): void;
    moveAltBlockReward(sourceId: number | string, targetId: number | string, amount: number): void;
    cleanShareDB(callback: (error?: Error) => void): void;
    initEnv(): void;
}

export interface PoolConfig {
    api: Record<string, unknown>;
    bind_ip: string;
    coin: CoinConfig;
    daemon: DaemonConfig;
    db_storage_path: string;
    email: Record<string, string>;
    general: GeneralConfig;
    hostname: string;
    max_pool_worker_num: number;
    mysql: Record<string, unknown>;
    payout: PayoutConfig;
    pool: PoolSettings;
    pool_id: number;
    ports: PortConfig[];
    pplns: PplnsConfig;
    rpc: RpcConfig;
    skipListenPorts: number[];
    verify_shares_host?: string[];
    wallet: WalletConfig;
    worker_num: number;
    [section: string]: unknown;
}

export interface CoinConfig {
    funcFile: string;
    sigDigits: number;
    name: string;
    mixIn: number;
    shortCode?: string;
    [key: string]: unknown;
}
export interface DaemonConfig {
    address: string;
    port: number;
    enableAlgoSwitching: boolean;
    basicAuth?: string;
    mainBlockSubmitPort?: number;
    dualBlockSubmitPort?: number;
    "X-API-KEY"?: string;
    [key: string]: unknown;
}
export interface GeneralConfig {
    adminEmail: string;
    testnet: boolean;
    dbSizeGB: number;
    blockCleanWarning: number;
    blockCleaner: boolean;
    emailBrand: string;
    emailFrom: string;
    emailSig: string;
    mailgunNoCert: boolean;
    mailgunURL: string;
    statsBufferHours: number;
    statsBufferLength: number;
    cmcKey?: string;
    coinCode?: string;
    sigDivisor?: number;
    [key: string]: unknown;
}
export interface PayoutConfig {
    walletMin: number;
    exchangeMin: number;
    defaultPay: number;
    denom: number;
    blocksRequired: number;
    anchorRound: number;
    maxPaymentTxns: number;
    feeAddress: string;
    pplnsFee: number;
    devDonation: number;
    poolDevDonation: number;
    safeWalletFee?: number;
    feeSlewEnd?: number;
    priority: number;
    mixIn: number;
    [key: string]: unknown;
}
export interface PoolSettings {
    address: string;
    minDifficulty: number;
    targetTime: number;
    geoDNS?: string;
    trustedMiners?: string[];
    [key: string]: unknown;
}
export interface PortConfig {
    port: number;
    difficulty: number;
    desc: string;
    portType: string | number;
    hidden: boolean;
    ssl: boolean;
    [key: string]: unknown;
}
export interface PplnsConfig {
    shareMulti: number;
    enable?: boolean;
    [key: string]: unknown;
}
export interface RpcConfig {
    https: boolean;
    [key: string]: unknown;
}
export interface WalletConfig {
    address: string;
    port: number;
    [key: string]: unknown;
}

export interface ExpressRequest {
    body: Record<string, unknown>;
    params: Record<string, string | undefined>;
    query: Record<string, string | string[] | undefined>;
    headers: IncomingHttpHeaders;
    method: string;
    ip?: string;
    path: string;
}
export type ExpressError = Error & { type?: string; status?: number };
export interface ExpressResponse extends ServerResponse {
    headersSent: boolean;
    status(code: number): ExpressResponse;
    type(value: string): ExpressResponse;
    json(value: unknown): ExpressResponse;
    send(value: unknown): ExpressResponse;
    sendStatus(code: number): ExpressResponse;
    header(name: string, value: string): ExpressResponse;
}
export type ExpressNext = (error?: Error) => void;
export type ExpressHandler = (request: ExpressRequest, response: ExpressResponse, next: ExpressNext) => unknown;
export type ExpressErrorHandler = (error: ExpressError, request: ExpressRequest, response: ExpressResponse, next: ExpressNext) => unknown;
export interface ExpressApp extends EventEmitter {
    use(...handlers: ExpressHandler[]): ExpressApp;
    use(...handlers: ExpressErrorHandler[]): ExpressApp;
    get(path: string, ...handlers: ExpressHandler[]): ExpressApp;
    post(path: string, ...handlers: ExpressHandler[]): ExpressApp;
    disable(name: string): ExpressApp;
    listen(port: number, hostOrCallback?: string | (() => void), callback?: () => void): Server;
}

declare global {
    var __apiAutostart: boolean | undefined;
    var config: PoolConfig;
    var database: DatabaseRuntime;
    var mysql: SqlPool;
    var support: SupportRuntime;
    var protos: ProtoTypes;
    var coinFuncs: CoinRuntime;
    var argv: Record<string, string | boolean | string[] | undefined>;
}
