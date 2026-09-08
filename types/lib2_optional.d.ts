/**
 * Public contracts for optional lib2 peers.  These declarations deliberately
 * describe only the APIs consumed by the main repository, so a public-only
 * checkout can typecheck without importing lib2's private implementation types.
 */

declare module "*/lib2/coins.js" {
    interface OptionalCoinDefinition {
        symbol?: string;
        base_symbol?: string;
        divisor?: number | string | null;
        exchange?: string;
        exchange_deposit_decimals_dynamic?: number | string | null;
        [key: string]: unknown;
    }

    interface OptionalCoinRegistry {
        COINS: Record<string, OptionalCoinDefinition>;
    }

    interface OptionalCoinsFactory {
        (): OptionalCoinRegistry;
    }

    const createCoins: OptionalCoinsFactory;
    export = createCoins;
}

declare module "*/lib2/exchanges.js" {
    interface OptionalExchangeApi {
        get_balance(exchange: string, symbol: string): Promise<number>;
        is_active_orders(exchange: string): Promise<boolean>;
    }

    interface OptionalExchangesFactory {
        (): OptionalExchangeApi;
    }

    const createExchanges: OptionalExchangesFactory;
    export = createExchanges;
}
