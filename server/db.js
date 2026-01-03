const mysql = require('mysql2/promise');

let pool = null;

function buildConfig() {
    const url = String(process.env.MYSQL_URL || '').trim();
    if (url) {
        return { url };
    }
    const host = String(process.env.MYSQL_HOST || '').trim();
    const user = String(process.env.MYSQL_USER || '').trim();
    const password = String(process.env.MYSQL_PASSWORD || '').trim();
    const database = String(process.env.MYSQL_DATABASE || '').trim();
    if (!host || !user || !database) return null;
    return { host, user, password, database };
}

function getPool() {
    if (pool) return pool;
    const config = buildConfig();
    if (!config) return null;
    if (config.url) {
        pool = mysql.createPool({
            uri: config.url,
            connectionLimit: 5,
            namedPlaceholders: true
        });
    } else {
        pool = mysql.createPool({
            host: config.host,
            user: config.user,
            password: config.password,
            database: config.database,
            connectionLimit: 5,
            namedPlaceholders: true
        });
    }
    return pool;
}

module.exports = {
    getPool
};
