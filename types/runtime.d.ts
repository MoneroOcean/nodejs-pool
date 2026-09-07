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
export type SqlParam = Scalar | undefined;
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

export interface LmdbDbi {
    close?(): void;
}
export type Dbi = LmdbDbi;
export interface LmdbTxn {
    getString(db: LmdbDbi, key: string | number | Buffer): string | null;
    getBinary(db: LmdbDbi, key: string | number | Buffer): Buffer | null;
    putString(db: LmdbDbi, key: string | number | Buffer, value: string): void;
    putBinary(db: LmdbDbi, key: string | number | Buffer, value: Buffer): void;
    del(db: LmdbDbi, key: string | number | Buffer): void;
    commit(): void;
    abort(): void;
}
export type Txn = LmdbTxn;
export interface LmdbCursor {
    goToFirst(): string | number | Buffer | null;
    goToLast(): string | number | Buffer | null;
    goToNext(): string | number | Buffer | null;
    goToPrev(): string | number | Buffer | null;
    goToRange(key: string | number | Buffer): string | number | Buffer | null;
    goToNextDup(): string | number | Buffer | null;
    getCurrentBinary(callback: (key: string | number | Buffer, value: Buffer) => void): void;
    getCurrentString(callback: (key: string | number | Buffer, value: string) => void): void;
    close(): void;
}
export type Cursor = LmdbCursor;
export interface LmdbEnv {
    open(options: { path: string; maxDbs?: number; mapSize?: number; maxReaders?: number; [key: string]: unknown }): void;
    openDbi(options: { name: string; create?: boolean; dupSort?: boolean; [key: string]: unknown }): LmdbDbi;
    beginTxn(options?: { readOnly?: boolean }): LmdbTxn;
    sync(callback?: () => void): void;
    close(): void;
}
export interface LmdbApi {
    Env: new () => LmdbEnv;
    Cursor: new (txn: LmdbTxn, db: LmdbDbi) => LmdbCursor;
}

export interface ProtoMessage {
    [field: string]: unknown;
}
export interface BlockMessage extends ProtoMessage {
    hash: string | Buffer;
    height: number;
    difficulty: number;
    value: number;
    shares: number;
    timestamp: number;
    poolType: number;
    unlocked: boolean;
    valid: boolean;
    pay_ready?: boolean;
    pay_status?: string;
    pay_stage?: string;
}
export type Block = BlockMessage;
export interface AltBlockMessage extends BlockMessage {
    id?: number;
    port: number;
    anchor_height: number;
    pay_value?: number;
}
export type AltBlock = AltBlockMessage;
export interface ShareMessage extends ProtoMessage {
    timestamp: number;
    paymentAddress: string;
    paymentID?: string;
    identifier?: string;
    poolType: number;
    port?: number;
    raw_shares: number;
    shares2: number;
    blockHeight?: number;
}
export type Share = ShareMessage;
export interface InvalidShareMessage extends ProtoMessage {}
export interface ProtoCodec<T extends ProtoMessage> {
    decode(data: Buffer | null): T;
    encode(data: ProtoMessage): Buffer;
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
    WSData: ProtoCodec<ProtoMessage>;
}

export interface RpcError {
    code?: number;
    message?: string;
    [field: string]: Scalar | undefined;
}
export interface RpcBody extends ProtoMessage {
    result?: ProtoMessage | Array<ProtoMessage> | string | number | boolean | null;
    error?: RpcError | null;
}
export type RpcCallback<T = RpcBody> = (body: T) => void;
export type CoinCallback<T = ProtoMessage> = (error: Error | null, body?: T) => void;

export interface SupportRuntime {
    rpcPortDaemon(port: number, method: string, params: unknown, callback: RpcCallback, noErrorReport?: boolean): void;
    rpcPortDaemon2(port: number, path: string, params: unknown, callback: RpcCallback, noErrorReport?: boolean): void;
    rpcWallet(port: number, method: string, params: unknown, callback: RpcCallback, noErrorReport?: boolean): void;
    rpcPortWallet(port: number, method: string, params: unknown, callback: RpcCallback, noErrorReport?: boolean): void;
    rpcPortWallet2(port: number, method: string, params: unknown, callback: RpcCallback, noErrorReport?: boolean): void;
    rpcPortWalletShort(port: number, method: string, params: unknown, callback: RpcCallback, noErrorReport?: boolean): void;
    sendEmail(to: string, subject: string, body: string, ...extra: unknown[]): void;
    sendAdminFyi(key: string, subject: string, body: string): void;
    sendFyi(to: string, key: string, subject: string, body: string, options?: unknown): void;
    sendFyiDaily(to: string, key: string, subject: string, body: string, options?: unknown): void;
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
    getCoinHashFactor(coin?: string): number;
    setCoinHashFactor(coin: string, value: number): void;
    https_get(url: string, callback: (body: string) => void): void;
    parseEmailUnsubscribeToken(token: string): Record<string, unknown> | false;
    renderUnsubscribeErrorHtml(message: string): string;
    renderUnsubscribeSuccessHtml(): string;
    circularBuffer<T>(size: number): { push(value: T): void; toarray(): T[] };
    tsCompare(left: number | string | Date, right: number | string | Date): number;
}

export interface CoinProfile extends ProtoMessage {
    port: number;
    coin: string | null;
    displayCoin: string;
    blobType?: number;
    algo: string;
    pool?: Record<string, unknown>;
    rpc?: Record<string, unknown>;
}
export interface CoinRuntime {
    BlockTemplate: new (template: ProtoMessage) => ProtoMessage;
    COIN2PORT(coin: string): number | undefined;
    PORT2COIN(port: number): string | undefined;
    PORT2COIN_FULL(port: number): string;
    getPORTS(): number[];
    getCOINS(): string[];
    getMM_PORTS(): Record<string, unknown>;
    getMM_CHILD_PORTS(): Record<string, unknown>;
    getPoolProfile(key: string | number): CoinProfile | null;
    getCoinProfile(key: string | number): CoinProfile | null;
    getJobProfile(job: ProtoMessage): CoinProfile | null;
    getPortLastBlockHeader(port: number, callback: CoinCallback, noErrorReport?: boolean): void;
    getPortLastBlockHeaderMM(port: number, callback: CoinCallback, noErrorReport?: boolean): void;
    getPortLastBlockHeaderWithRewardDiff(port: number, callback: CoinCallback, noErrorReport?: boolean): void;
    getLastBlockHeader(callback: CoinCallback, noErrorReport?: boolean): void;
    getBlockHeaderByID(blockId: number | string, callback: CoinCallback, noErrorReport?: boolean): void;
    getBlockHeaderByHash(hash: string | Buffer, callback: CoinCallback, noErrorReport?: boolean): void;
    getPortBlockHeaderByID(port: number, blockId: number | string, callback: CoinCallback, noErrorReport?: boolean): void;
    getPortBlockHeaderByHash(port: number, hash: string | Buffer, callback: CoinCallback, noErrorReport?: boolean): void;
    getPortAnyBlockHeaderByHash(port: number, hash: string | Buffer, isOurBlock: boolean, callback: CoinCallback, noErrorReport?: boolean): void;
    getPortBlockTemplate(port: number, callback: CoinCallback, noErrorReport?: boolean): void;
    convertBlob(blob: Buffer, port: number): Buffer | null;
    constructNewBlob(template: Buffer, params: ProtoMessage, port: number): Buffer | null;
    slowHashBuff(blob: Buffer, template: ProtoMessage, nonce?: string, mixhash?: string): Buffer | false;
    slowHash(blob: Buffer, template: ProtoMessage, nonce?: string, mixhash?: string): string | false;
    slowHashAsync(blob: Buffer, template: ProtoMessage, minerAddress: string, callback: (result: string | null | false, errorKind?: string) => void, verifyContext?: ProtoMessage): void;
    slowHashBuffAsync(blob: Buffer, template: ProtoMessage, minerAddress: string, callback: (result: Buffer[] | null | false, errorKind?: string) => void, verifyContext?: ProtoMessage): void;
    nonceSize(blobType: number): number;
    c29ProofSize(blobType: number): number;
    isHashVerifierEnabled(): boolean;
    getAuxChainXTM(value: ProtoMessage): ProtoMessage | null;
    getPoolHashesPerDifficulty(key: string | number): number;
    getPoolWorkDifficulty(key: string | number, difficulty: number): number;
    algoShortTypeStr(port: number): string;
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
    getBlockList(poolType: string | null, minHeight?: number, maxHeight?: number): BlockMessage[];
    getAltBlockList(poolType: string | null, port?: number | null, minHeight?: number, maxHeight?: number): AltBlockMessage[];
    getValidLockedBlocks(): BlockMessage[];
    getValidLockedAltBlocks(): AltBlockMessage[];
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
    coin: Record<string, number | string | boolean>;
    daemon: Record<string, number | string | boolean | undefined> & { port: number; address: string };
    db_storage_path: string;
    email: Record<string, string>;
    general: Record<string, number | string | boolean | undefined> & { adminEmail: string; testnet: boolean };
    hostname: string;
    max_pool_worker_num: number;
    mysql: Record<string, unknown>;
    payout: Record<string, number | string | boolean | undefined>;
    pool: Record<string, number | string | boolean | undefined> & { address: string; minDifficulty: number };
    pool_id: number;
    ports: Record<string, number | string | boolean | undefined>;
    pplns: Record<string, number | string | boolean | undefined>;
    rpc: Record<string, number | string | boolean | undefined>;
    skipListenPorts: number[];
    verify_shares_host?: string[];
    wallet: Record<string, number | string | boolean | undefined> & { address: string; port: number };
    worker_num: number;
    [section: string]: unknown;
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
export interface ExpressApp extends EventEmitter {
    use(...handlers: Array<ExpressHandler | unknown>): ExpressApp;
    get(path: string, ...handlers: Array<ExpressHandler | unknown>): ExpressApp;
    post(path: string, ...handlers: Array<ExpressHandler | unknown>): ExpressApp;
    disable(name: string): ExpressApp;
    listen(port: number, hostOrCallback?: string | (() => void), callback?: () => void): Server;
}

declare global {
    var config: PoolConfig;
    var database: DatabaseRuntime;
    var mysql: SqlPool;
    var support: SupportRuntime;
    var protos: ProtoTypes;
    var coinFuncs: CoinRuntime;
    var argv: Record<string, string | boolean | string[] | undefined>;
}
