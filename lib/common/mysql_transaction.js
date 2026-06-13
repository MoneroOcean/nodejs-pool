"use strict";

function createTransactionRunner(mysqlPool, unsupportedMessage) {
    return async function withTransaction(work) {
        if (typeof mysqlPool.getConnection !== "function") {
            throw new Error(unsupportedMessage);
        }
        const connection = await mysqlPool.getConnection();
        let inTransaction = false;
        try {
            await connection.beginTransaction();
            inTransaction = true;
            const result = await work(connection);
            await connection.commit();
            inTransaction = false; // commit succeeded, so the catch below must not roll back
            return result;
        } catch (error) {
            if (inTransaction) {
                try {
                    await connection.rollback();
                } catch (_rollbackError) {} // swallow so the original error is the one thrown
            }
            throw error;
        } finally {
            try {
                if (typeof connection.release === "function") connection.release();
            } catch (_releaseError) {}
        }
    };
}

module.exports = createTransactionRunner;
