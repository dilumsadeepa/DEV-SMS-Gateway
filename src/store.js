const crypto = require('crypto');
const { getPool } = require('./db');

const SESSION_TTL_DAYS = Number(process.env.SESSION_TTL_DAYS || 30);

function toIso(value) {
    if (!value) {
        return null;
    }

    const date = value instanceof Date ? value : new Date(value);
    if (Number.isNaN(date.getTime())) {
        return null;
    }

    return date.toISOString();
}

function parseMetadata(value) {
    if (!value) {
        return {};
    }
    if (typeof value === 'object' && !Array.isArray(value)) {
        return value;
    }
    try {
        const parsed = JSON.parse(value);
        return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
    } catch {
        return {};
    }
}

function sha256(input) {
    return crypto.createHash('sha256').update(String(input)).digest('hex');
}

function normalizeEmail(email) {
    return String(email || '').trim().toLowerCase();
}

function isValidEmail(email) {
    const value = normalizeEmail(email);
    return value.length > 3 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

function randomToken(bytes = 32) {
    return crypto.randomBytes(bytes).toString('base64url');
}

function hashPassword(password, salt) {
    const usedSalt = salt || randomToken(16);
    const hash = crypto.scryptSync(String(password), usedSalt, 64).toString('hex');
    return { salt: usedSalt, hash };
}

function verifyPassword(password, salt, expectedHash) {
    const { hash } = hashPassword(password, salt);
    const expected = Buffer.from(String(expectedHash), 'hex');
    const actual = Buffer.from(hash, 'hex');

    if (expected.length !== actual.length) {
        return false;
    }
    return crypto.timingSafeEqual(expected, actual);
}

function sanitizeUser(user) {
    return {
        id: user.id,
        name: user.name,
        email: user.email,
        createdAt: toIso(user.created_at || user.createdAt),
    };
}

function sanitizeEnvironment(env) {
    return {
        id: env.id,
        userId: env.user_id || env.userId,
        name: env.name,
        pin: env.pin,
        description: env.description || '',
        metadata: parseMetadata(env.metadata),
        createdAt: toIso(env.created_at || env.createdAt),
        updatedAt: toIso(env.updated_at || env.updatedAt),
    };
}

function sanitizeApiKey(key) {
    return {
        id: key.id,
        environmentId: key.environment_id || key.environmentId,
        userId: key.user_id || key.userId,
        name: key.name,
        keyPreview: key.key_preview || key.keyPreview,
        isActive: Boolean(key.is_active ?? key.isActive),
        createdAt: toIso(key.created_at || key.createdAt),
        lastUsedAt: toIso(key.last_used_at || key.lastUsedAt),
        revokedAt: toIso(key.revoked_at || key.revokedAt),
    };
}

async function cleanupExpiredSessions() {
    await getPool().query('DELETE FROM sessions WHERE expires_at <= UTC_TIMESTAMP(3)');
}

async function registerUser({ name, email, password }) {
    const normalizedEmail = normalizeEmail(email);
    const safeName = String(name || '').trim();
    const safePassword = String(password || '');

    if (!safeName || safeName.length < 2) {
        return { ok: false, error: 'invalid_name' };
    }
    if (!isValidEmail(normalizedEmail)) {
        return { ok: false, error: 'invalid_email' };
    }
    if (safePassword.length < 8) {
        return { ok: false, error: 'password_too_short' };
    }

    const pool = getPool();
    const [existingUsers] = await pool.query('SELECT id FROM users WHERE email = ? LIMIT 1', [normalizedEmail]);
    if (existingUsers.length > 0) {
        return { ok: false, error: 'email_already_exists' };
    }

    const { salt, hash } = hashPassword(safePassword);
    const user = {
        id: crypto.randomUUID(),
        name: safeName,
        email: normalizedEmail,
        passwordSalt: salt,
        passwordHash: hash,
        createdAt: new Date(),
    };

    try {
        await pool.query(
            `INSERT INTO users (id, name, email, password_salt, password_hash, created_at)
             VALUES (?, ?, ?, ?, ?, ?)`,
            [user.id, user.name, user.email, user.passwordSalt, user.passwordHash, user.createdAt]
        );
    } catch (error) {
        if (error && error.code === 'ER_DUP_ENTRY') {
            return { ok: false, error: 'email_already_exists' };
        }
        throw error;
    }

    return {
        ok: true,
        user: sanitizeUser({
            id: user.id,
            name: user.name,
            email: user.email,
            created_at: user.createdAt,
        }),
    };
}

async function authenticateUser({ email, password }) {
    const normalizedEmail = normalizeEmail(email);
    const safePassword = String(password || '');
    const [rows] = await getPool().query(
        `SELECT id, name, email, password_salt, password_hash, created_at
         FROM users
         WHERE email = ?
         LIMIT 1`,
        [normalizedEmail]
    );

    const user = rows[0];
    if (!user) {
        return { ok: false, error: 'invalid_credentials' };
    }

    if (!verifyPassword(safePassword, user.password_salt, user.password_hash)) {
        return { ok: false, error: 'invalid_credentials' };
    }

    return {
        ok: true,
        user: {
            id: user.id,
            name: user.name,
            email: user.email,
            createdAt: toIso(user.created_at),
        },
    };
}

async function createSessionForUser(userId) {
    await cleanupExpiredSessions();

    const token = `psgt_${randomToken(30)}`;
    const createdAt = new Date();
    const expiresAt = new Date(Date.now() + SESSION_TTL_DAYS * 24 * 60 * 60 * 1000);

    const session = {
        id: crypto.randomUUID(),
        userId,
        tokenHash: sha256(token),
        createdAt,
        expiresAt,
    };

    await getPool().query(
        `INSERT INTO sessions (id, user_id, token_hash, created_at, expires_at)
         VALUES (?, ?, ?, ?, ?)`,
        [session.id, session.userId, session.tokenHash, session.createdAt, session.expiresAt]
    );

    return { token, expiresAt: expiresAt.toISOString() };
}

async function getUserBySessionToken(token) {
    await cleanupExpiredSessions();
    const safeToken = String(token || '').trim();
    if (!safeToken) {
        return null;
    }

    const tokenHash = sha256(safeToken);
    const [rows] = await getPool().query(
        `SELECT
            s.id AS session_id,
            s.user_id AS session_user_id,
            s.token_hash AS session_token_hash,
            s.created_at AS session_created_at,
            s.expires_at AS session_expires_at,
            u.id AS user_id,
            u.name AS user_name,
            u.email AS user_email,
            u.created_at AS user_created_at
         FROM sessions s
         INNER JOIN users u ON u.id = s.user_id
         WHERE s.token_hash = ? AND s.expires_at > UTC_TIMESTAMP(3)
         LIMIT 1`,
        [tokenHash]
    );

    const row = rows[0];
    if (!row) {
        return null;
    }

    const user = {
        id: row.user_id,
        name: row.user_name,
        email: row.user_email,
        created_at: row.user_created_at,
    };

    return {
        session: {
            id: row.session_id,
            userId: row.session_user_id,
            tokenHash: row.session_token_hash,
            createdAt: toIso(row.session_created_at),
            expiresAt: toIso(row.session_expires_at),
        },
        user: sanitizeUser(user),
        rawUser: {
            id: user.id,
            name: user.name,
            email: user.email,
            createdAt: toIso(user.created_at),
        },
    };
}

async function revokeSessionToken(token) {
    const safeToken = String(token || '').trim();
    if (!safeToken) {
        return;
    }
    const tokenHash = sha256(safeToken);
    await getPool().query('DELETE FROM sessions WHERE token_hash = ?', [tokenHash]);
}

async function listEnvironmentsByUser(userId) {
    const [rows] = await getPool().query(
        `SELECT id, user_id, name, pin, description, metadata, created_at, updated_at
         FROM environments
         WHERE user_id = ?
         ORDER BY name ASC`,
        [userId]
    );
    return rows.map(sanitizeEnvironment);
}

async function getEnvironmentForUser(userId, environmentId) {
    const [rows] = await getPool().query(
        `SELECT id, user_id, name, pin, description, metadata, created_at, updated_at
         FROM environments
         WHERE user_id = ? AND id = ?
         LIMIT 1`,
        [userId, environmentId]
    );
    return rows.length > 0 ? sanitizeEnvironment(rows[0]) : null;
}

async function findEnvironmentByPin(pin) {
    const safePin = String(pin || '').trim();
    if (!safePin) {
        return null;
    }

    const [rows] = await getPool().query(
        `SELECT id, user_id, name, pin, description, metadata, created_at, updated_at
         FROM environments
         WHERE pin = ?
         LIMIT 1`,
        [safePin]
    );
    return rows.length > 0 ? sanitizeEnvironment(rows[0]) : null;
}

async function createEnvironmentForUser(userId, payload) {
    const name = String(payload?.name || '').trim();
    const pin = String(payload?.pin || '').trim();
    const description = String(payload?.description || '').trim();
    const metadata = payload?.metadata && typeof payload.metadata === 'object' && !Array.isArray(payload.metadata)
        ? payload.metadata
        : {};

    if (!name || name.length < 2) {
        return { ok: false, error: 'invalid_environment_name' };
    }
    if (!pin || pin.length < 3) {
        return { ok: false, error: 'invalid_pin' };
    }

    const createdAt = new Date();
    const env = {
        id: crypto.randomUUID(),
        userId,
        name,
        pin,
        description,
        metadata,
        createdAt,
        updatedAt: createdAt,
    };

    try {
        await getPool().query(
            `INSERT INTO environments
                (id, user_id, name, pin, description, metadata, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
            [
                env.id,
                env.userId,
                env.name,
                env.pin,
                env.description,
                JSON.stringify(env.metadata),
                env.createdAt,
                env.updatedAt,
            ]
        );
    } catch (error) {
        if (error && error.code === 'ER_DUP_ENTRY') {
            return { ok: false, error: 'pin_already_exists' };
        }
        throw error;
    }

    return {
        ok: true,
        environment: sanitizeEnvironment({
            id: env.id,
            user_id: env.userId,
            name: env.name,
            pin: env.pin,
            description: env.description,
            metadata: env.metadata,
            created_at: env.createdAt,
            updated_at: env.updatedAt,
        }),
    };
}

async function createApiKeyForEnvironment(userId, environmentId, payload) {
    const env = await getEnvironmentForUser(userId, environmentId);
    if (!env) {
        return { ok: false, error: 'environment_not_found' };
    }

    const name = String(payload?.name || '').trim() || 'default';
    const rawKey = `psg_${randomToken(32)}`;
    const keyHash = sha256(rawKey);
    const createdAt = new Date();
    const apiKey = {
        id: crypto.randomUUID(),
        environmentId: env.id,
        userId: env.userId,
        name,
        keyHash,
        keyPreview: `${rawKey.slice(0, 12)}...${rawKey.slice(-4)}`,
        isActive: true,
        createdAt,
        lastUsedAt: null,
        revokedAt: null,
    };

    await getPool().query(
        `INSERT INTO api_keys
            (id, environment_id, user_id, name, key_hash, key_preview, is_active, created_at, last_used_at, revoked_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
            apiKey.id,
            apiKey.environmentId,
            apiKey.userId,
            apiKey.name,
            apiKey.keyHash,
            apiKey.keyPreview,
            1,
            apiKey.createdAt,
            null,
            null,
        ]
    );

    return {
        ok: true,
        apiKey: rawKey,
        apiKeyInfo: sanitizeApiKey({
            id: apiKey.id,
            environment_id: apiKey.environmentId,
            user_id: apiKey.userId,
            name: apiKey.name,
            key_preview: apiKey.keyPreview,
            is_active: 1,
            created_at: apiKey.createdAt,
            last_used_at: null,
            revoked_at: null,
        }),
        environment: env,
    };
}

async function listApiKeysForEnvironment(userId, environmentId) {
    const env = await getEnvironmentForUser(userId, environmentId);
    if (!env) {
        return { ok: false, error: 'environment_not_found' };
    }

    const [rows] = await getPool().query(
        `SELECT id, environment_id, user_id, name, key_preview, is_active, created_at, last_used_at, revoked_at
         FROM api_keys
         WHERE user_id = ? AND environment_id = ?
         ORDER BY created_at DESC`,
        [userId, environmentId]
    );

    return { ok: true, apiKeys: rows.map(sanitizeApiKey), environment: env };
}

async function revokeApiKeyForEnvironment(userId, environmentId, keyId) {
    const pool = getPool();
    const revokedAt = new Date();
    const [result] = await pool.query(
        `UPDATE api_keys
         SET is_active = 0, revoked_at = ?
         WHERE id = ? AND user_id = ? AND environment_id = ?`,
        [revokedAt, keyId, userId, environmentId]
    );

    if (!result || result.affectedRows < 1) {
        return { ok: false, error: 'api_key_not_found' };
    }

    const [rows] = await pool.query(
        `SELECT id, environment_id, user_id, name, key_preview, is_active, created_at, last_used_at, revoked_at
         FROM api_keys
         WHERE id = ?
         LIMIT 1`,
        [keyId]
    );

    return { ok: true, apiKey: rows[0] ? sanitizeApiKey(rows[0]) : null };
}

async function resolveApiKeyContext(rawApiKey) {
    const apiKey = String(rawApiKey || '').trim();
    if (!apiKey) {
        return null;
    }

    const keyHash = sha256(apiKey);
    const pool = getPool();
    const [rows] = await pool.query(
        `SELECT
            ak.id AS api_key_id,
            ak.environment_id AS api_key_environment_id,
            ak.user_id AS api_key_user_id,
            ak.name AS api_key_name,
            ak.key_preview AS api_key_key_preview,
            ak.is_active AS api_key_is_active,
            ak.created_at AS api_key_created_at,
            ak.last_used_at AS api_key_last_used_at,
            ak.revoked_at AS api_key_revoked_at,
            u.id AS user_id,
            u.name AS user_name,
            u.email AS user_email,
            u.created_at AS user_created_at,
            e.id AS env_id,
            e.user_id AS env_user_id,
            e.name AS env_name,
            e.pin AS env_pin,
            e.description AS env_description,
            e.metadata AS env_metadata,
            e.created_at AS env_created_at,
            e.updated_at AS env_updated_at
         FROM api_keys ak
         INNER JOIN users u ON u.id = ak.user_id
         INNER JOIN environments e ON e.id = ak.environment_id
         WHERE ak.key_hash = ? AND ak.is_active = 1
         LIMIT 1`,
        [keyHash]
    );

    const row = rows[0];
    if (!row) {
        return null;
    }

    const now = new Date();
    await pool.query('UPDATE api_keys SET last_used_at = ? WHERE id = ?', [now, row.api_key_id]);

    const user = {
        id: row.user_id,
        name: row.user_name,
        email: row.user_email,
        createdAt: toIso(row.user_created_at),
    };

    const environment = sanitizeEnvironment({
        id: row.env_id,
        user_id: row.env_user_id,
        name: row.env_name,
        pin: row.env_pin,
        description: row.env_description,
        metadata: row.env_metadata,
        created_at: row.env_created_at,
        updated_at: row.env_updated_at,
    });

    const apiKeyInfo = sanitizeApiKey({
        id: row.api_key_id,
        environment_id: row.api_key_environment_id,
        user_id: row.api_key_user_id,
        name: row.api_key_name,
        key_preview: row.api_key_key_preview,
        is_active: row.api_key_is_active,
        created_at: row.api_key_created_at,
        last_used_at: now,
        revoked_at: row.api_key_revoked_at,
    });

    return {
        user,
        environment,
        apiKey: {
            id: row.api_key_id,
            environmentId: row.api_key_environment_id,
            userId: row.api_key_user_id,
            name: row.api_key_name,
            keyPreview: row.api_key_key_preview,
            isActive: Boolean(row.api_key_is_active),
            createdAt: toIso(row.api_key_created_at),
            lastUsedAt: now.toISOString(),
            revokedAt: toIso(row.api_key_revoked_at),
        },
        userInfo: user,
        environmentInfo: environment,
        apiKeyInfo,
    };
}

async function getPinsForUser(userId) {
    const [rows] = await getPool().query(
        `SELECT pin
         FROM environments
         WHERE user_id = ?`,
        [userId]
    );
    return rows.map((row) => String(row.pin || ''));
}

module.exports = {
    registerUser,
    authenticateUser,
    createSessionForUser,
    getUserBySessionToken,
    revokeSessionToken,
    listEnvironmentsByUser,
    getEnvironmentForUser,
    findEnvironmentByPin,
    createEnvironmentForUser,
    createApiKeyForEnvironment,
    listApiKeysForEnvironment,
    revokeApiKeyForEnvironment,
    resolveApiKeyContext,
    getPinsForUser,
    sanitizeEnvironment,
    sanitizeApiKey,
    sanitizeUser,
};
