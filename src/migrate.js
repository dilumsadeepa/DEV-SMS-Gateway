const fs = require('fs');
const path = require('path');

const dotenv = require('dotenv');

dotenv.config();

const { mysql, getPool, closePool, getBaseConfig, getDatabaseName } = require('./db');

const MIGRATIONS_DIR = path.join(__dirname, '..', 'migrations');

function escapeIdentifier(identifier) {
    return `\`${String(identifier).replace(/`/g, '``')}\``;
}

async function ensureDatabaseExists() {
    const connection = await mysql.createConnection(getBaseConfig());
    const databaseName = getDatabaseName();
    await connection.query(
        `CREATE DATABASE IF NOT EXISTS ${escapeIdentifier(databaseName)} CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`
    );
    await connection.end();
}

async function ensureMigrationsTable(pool) {
    await pool.query(`
        CREATE TABLE IF NOT EXISTS schema_migrations (
            id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
            migration_name VARCHAR(255) NOT NULL UNIQUE,
            executed_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);
}

function readMigrationFiles() {
    if (!fs.existsSync(MIGRATIONS_DIR)) {
        return [];
    }

    return fs
        .readdirSync(MIGRATIONS_DIR)
        .filter((name) => name.endsWith('.sql'))
        .sort((a, b) => a.localeCompare(b))
        .map((name) => ({
            name,
            fullPath: path.join(MIGRATIONS_DIR, name),
            sql: fs.readFileSync(path.join(MIGRATIONS_DIR, name), 'utf8'),
        }));
}

async function run() {
    await ensureDatabaseExists();

    const pool = getPool();
    await ensureMigrationsTable(pool);

    const [appliedRows] = await pool.query(
        'SELECT migration_name FROM schema_migrations ORDER BY migration_name ASC'
    );
    const applied = new Set(appliedRows.map((row) => String(row.migration_name)));
    const migrations = readMigrationFiles();

    for (const migration of migrations) {
        if (applied.has(migration.name)) {
            // eslint-disable-next-line no-console
            console.log(`[migrate] skip ${migration.name}`);
            continue;
        }

        // eslint-disable-next-line no-console
        console.log(`[migrate] apply ${migration.name}`);
        const connection = await pool.getConnection();
        try {
            await connection.beginTransaction();
            await connection.query(migration.sql);
            await connection.query(
                'INSERT INTO schema_migrations (migration_name) VALUES (?)',
                [migration.name]
            );
            await connection.commit();
        } catch (error) {
            await connection.rollback();
            throw error;
        } finally {
            connection.release();
        }
    }

    // eslint-disable-next-line no-console
    console.log('[migrate] completed');
}

run()
    .then(() => closePool())
    .then(() => process.exit(0))
    .catch(async (error) => {
        // eslint-disable-next-line no-console
        console.error('[migrate] failed:', error.message);
        await closePool();
        process.exit(1);
    });
