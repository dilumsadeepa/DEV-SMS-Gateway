const mysql = require('mysql2/promise');

function getDatabaseName() {
    return process.env.MYSQL_DATABASE || 'puppy_sms_gateway';
}

function getBaseConfig() {
    return {
        host: process.env.MYSQL_HOST || '127.0.0.1',
        port: Number(process.env.MYSQL_PORT || 3306),
        user: process.env.MYSQL_USER || 'root',
        password: process.env.MYSQL_PASSWORD || '',
        waitForConnections: true,
        connectionLimit: Number(process.env.MYSQL_CONNECTION_LIMIT || 10),
        queueLimit: 0,
        timezone: 'Z',
        multipleStatements: true,
    };
}

function getPoolConfig() {
    return {
        ...getBaseConfig(),
        database: getDatabaseName(),
    };
}

let pool = null;

function getPool() {
    if (!pool) {
        pool = mysql.createPool(getPoolConfig());
    }
    return pool;
}

async function closePool() {
    if (pool) {
        await pool.end();
        pool = null;
    }
}

module.exports = {
    mysql,
    getPool,
    closePool,
    getBaseConfig,
    getDatabaseName,
    getPoolConfig,
};
