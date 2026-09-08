declare module "debug" {
    interface Debugger {
        (message: string, ...parameters: unknown[]): void;
        enabled: boolean;
    }

    function debug(namespace: string): Debugger;
    export = debug;
}

declare module "promise-mysql" {
    interface MysqlModule {
        createPool(config: Record<string, unknown>): import("./runtime").SqlPool;
    }

    const mysql: MysqlModule;
    export = mysql;
}

declare module "protocol-buffers" {
    function protocolBuffers(schema: Buffer): import("./runtime").ProtoTypes;
    export = protocolBuffers;
}

declare module "express" {
    interface BodyParserOptions {
        limit?: string | number;
        type?: string | string[] | ((request: import("./runtime").ExpressRequest) => boolean);
        extended?: boolean;
        parameterLimit?: number;
    }
    interface ExpressFactory {
        (): import("./runtime").ExpressApp;
        json(options?: BodyParserOptions): import("./runtime").ExpressHandler;
        urlencoded(options?: BodyParserOptions): import("./runtime").ExpressHandler;
        raw(options?: BodyParserOptions): import("./runtime").ExpressHandler;
    }

    const express: ExpressFactory;
    export = express;
}

declare module "node-blocktemplate" {
    interface BlockTemplateApi {
        baseDiff(): bigint | number | string;
        baseRavenDiff(): bigint | number | string;
        address_decode(address: Buffer): number;
        address_decode_integrated(address: Buffer): number;
        get_merged_mining_nonce_size(): number;
        convert_blob(blob: Buffer, blobType?: number): Buffer;
        construct_block_blob(template: Buffer, nonce: Buffer, blobType?: number, pow?: unknown): Buffer;
        constructNewDeroBlob(template: Buffer, nonce: Buffer): Buffer;
        constructNewKcnBlob(template: Buffer, nonce: Buffer): Buffer;
        constructNewRavenBlob(template: Buffer, nonce: Buffer, mixhash: Buffer): Buffer;
        constructNewRtmBlob(template: Buffer, nonce: Buffer): Buffer;
        convertKcnBlob(blob: Buffer): Buffer;
        convertRavenBlob(blob: Buffer): Buffer;
        convertRtmBlob(blob: Buffer): Buffer;
        construct_mm_parent_block_blob(parent: Buffer, parentBlobType: number, child: Buffer): Buffer;
        construct_mm_child_block_blob(share: Buffer, parentBlobType: number, child: Buffer): Buffer;
        get_block_id(blob: Buffer, blobType?: number): Buffer;
        blockHashBuff(blob: Buffer): Buffer;
        blockHashBuff3(blob: Buffer): Buffer;
        RavenBlockTemplate(result: Record<string, unknown>, poolAddress: string): import("./runtime").BlockTemplateRecord;
        RtmBlockTemplate(result: Record<string, unknown>, poolAddress: string): import("./runtime").BlockTemplateRecord;
        EthBlockTemplate(result: unknown): import("./runtime").BlockTemplateRecord;
        ErgBlockTemplate(result: Record<string, unknown>): import("./runtime").BlockTemplateRecord;
    }

    const blockTemplate: BlockTemplateApi;
    export = blockTemplate;
}

declare module "node-powhash" {
    interface PowHashApi {
        randomx(blob: Buffer, seedHash: Buffer, algorithm?: number | string): Buffer;
        cryptonight(blob: Buffer, variant: number, height?: number): Buffer;
        cryptonight_heavy(blob: Buffer, variant: number): Buffer;
        cryptonight_pico(blob: Buffer, variant: number): Buffer;
        argon2(blob: Buffer, variant: number): Buffer;
        kawpow(blob: Buffer, nonce: Buffer, mixhash: Buffer): Buffer;
        kawpow_light(blob: Buffer, nonce: Buffer, height: number): [Buffer, Buffer];
        ethash(blob: Buffer, nonce: Buffer, height: number): [Buffer, Buffer];
        etchash(blob: Buffer, nonce: Buffer, height: number): [Buffer, Buffer];
        autolykos2_hashes(blob: Buffer, height: number): [Buffer, Buffer];
        astrobwt(blob: Buffer, variant: number): Buffer;
        c29(header: Buffer, ring: number[]): boolean;
        c29s(header: Buffer, ring: number[]): boolean;
        c29v(header: Buffer, ring: number[]): boolean;
        c29b(header: Buffer, ring: number[]): boolean;
        c29_packed_edges(ring: number[]): string;
        c29s_packed_edges(ring: number[]): string;
        c29b_packed_edges(ring: number[]): string;
        c29_cycle_hash(packedEdges: string): Buffer;
        setRandomxCacheSize(size: number): void;
        getRandomxCacheSize(): number;
    }

    const powHash: PowHashApi;
    export = powHash;
}
