const crypto = require('crypto');
const { getPool } = require('./db');

const SESSION_TTL_DAYS = Number(process.env.SESSION_TTL_DAYS || 30);
const DEFAULT_LOG_RETENTION_DAYS = 2;
const MIN_LOG_RETENTION_DAYS = 1;
const MAX_LOG_RETENTION_DAYS = 365;
const USER_ROLES = new Set(['super_admin', 'admin', 'user']);

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

function normalizeRole(role, fallback = 'user') {
    const value = String(role || '').trim().toLowerCase();
    if (USER_ROLES.has(value)) {
        return value;
    }
    return fallback;
}

function isValidRole(role) {
    return USER_ROLES.has(String(role || '').trim().toLowerCase());
}

function isAdminRole(role) {
    const normalized = normalizeRole(role, 'user');
    return normalized === 'super_admin' || normalized === 'admin';
}

function coerceBoolean(value, fallback = false) {
    if (typeof value === 'boolean') {
        return value;
    }
    if (typeof value === 'number') {
        return value === 1;
    }
    const normalized = String(value || '').trim().toLowerCase();
    if (!normalized) {
        return fallback;
    }
    if (['1', 'true', 'yes', 'on'].includes(normalized)) {
        return true;
    }
    if (['0', 'false', 'no', 'off'].includes(normalized)) {
        return false;
    }
    return fallback;
}

function coerceInteger(value, fallback, min, max) {
    const parsed = Number.parseInt(String(value ?? ''), 10);
    if (!Number.isInteger(parsed)) {
        return fallback;
    }

    return Math.min(max, Math.max(min, parsed));
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
        role: normalizeRole(user.role, 'user'),
        isActive: Boolean(user.is_active ?? user.isActive ?? true),
        createdAt: toIso(user.created_at || user.createdAt),
        updatedAt: toIso(user.updated_at || user.updatedAt),
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

async function getGatewaySetting(settingKey) {
    const safeKey = String(settingKey || '').trim();
    if (!safeKey) {
        return null;
    }

    const [rows] = await getPool().query(
        `SELECT setting_value
         FROM gateway_settings
         WHERE setting_key = ?
         LIMIT 1`,
        [safeKey]
    );

    return rows[0] ? String(rows[0].setting_value || '') : null;
}

async function setGatewaySetting(settingKey, settingValue) {
    const safeKey = String(settingKey || '').trim();
    if (!safeKey) {
        return;
    }

    await getPool().query(
        `INSERT INTO gateway_settings (setting_key, setting_value, updated_at)
         VALUES (?, ?, ?)
         ON DUPLICATE KEY UPDATE
            setting_value = VALUES(setting_value),
            updated_at = VALUES(updated_at)`,
        [safeKey, String(settingValue || ''), new Date()]
    );
}

async function isRegistrationEnabled() {
    const setting = await getGatewaySetting('registration_enabled');
    if (setting === null) {
        return true;
    }
    return coerceBoolean(setting, true);
}

async function setRegistrationEnabled(enabled) {
    const normalized = coerceBoolean(enabled, true);
    await setGatewaySetting('registration_enabled', normalized ? '1' : '0');
    return normalized;
}

async function getLogRetentionDays() {
    const setting = await getGatewaySetting('log_retention_days');
    if (setting === null) {
        return DEFAULT_LOG_RETENTION_DAYS;
    }

    return coerceInteger(setting, DEFAULT_LOG_RETENTION_DAYS, MIN_LOG_RETENTION_DAYS, MAX_LOG_RETENTION_DAYS);
}

async function setLogRetentionDays(days) {
    const normalized = coerceInteger(days, DEFAULT_LOG_RETENTION_DAYS, MIN_LOG_RETENTION_DAYS, MAX_LOG_RETENTION_DAYS);
    await setGatewaySetting('log_retention_days', String(normalized));
    return normalized;
}

async function countUsersByRole(role, activeOnly = false) {
    const normalizedRole = normalizeRole(role, 'user');
    const conditions = ['role = ?'];
    const params = [normalizedRole];

    if (activeOnly) {
        conditions.push('is_active = 1');
    }

    const [rows] = await getPool().query(
        `SELECT COUNT(*) AS count
         FROM users
         WHERE ${conditions.join(' AND ')}`,
        params
    );

    return Number(rows?.[0]?.count || 0);
}

async function countAllUsers() {
    const [rows] = await getPool().query('SELECT COUNT(*) AS count FROM users');
    return Number(rows?.[0]?.count || 0);
}

async function hasSuperAdmin() {
    return (await countUsersByRole('super_admin')) > 0;
}

function canActorAssignRole(actorRole, desiredRole) {
    const safeActorRole = normalizeRole(actorRole, 'user');
    const safeDesiredRole = normalizeRole(desiredRole, 'user');

    if (safeActorRole === 'super_admin') {
        return isValidRole(safeDesiredRole);
    }

    if (safeActorRole === 'admin') {
        return safeDesiredRole === 'user';
    }

    return false;
}

function canActorManageTarget(actor, target) {
    const actorRole = normalizeRole(actor?.role, 'user');
    const targetRole = normalizeRole(target?.role, 'user');

    if (actorRole === 'super_admin') {
        return true;
    }

    if (actorRole === 'admin') {
        if (String(actor?.id || '') === String(target?.id || '')) {
            return true;
        }
        return targetRole === 'user';
    }

    return false;
}

async function createUserRecord(payload) {
    const normalizedEmail = normalizeEmail(payload?.email);
    const safeName = String(payload?.name || '').trim();
    const safePassword = String(payload?.password || '');
    const desiredRole = normalizeRole(payload?.role, 'user');
    const isActive = coerceBoolean(payload?.isActive, true);
    const autoPromoteFirstSuperAdmin = Boolean(payload?.autoPromoteFirstSuperAdmin);

    if (!safeName || safeName.length < 2) {
        return { ok: false, error: 'invalid_name' };
    }
    if (!isValidEmail(normalizedEmail)) {
        return { ok: false, error: 'invalid_email' };
    }
    if (safePassword.length < 8) {
        return { ok: false, error: 'password_too_short' };
    }
    if (!isValidRole(desiredRole)) {
        return { ok: false, error: 'invalid_role' };
    }

    const pool = getPool();
    const [existingUsers] = await pool.query('SELECT id FROM users WHERE email = ? LIMIT 1', [normalizedEmail]);
    if (existingUsers.length > 0) {
        return { ok: false, error: 'email_already_exists' };
    }

    let assignedRole = desiredRole;
    if (autoPromoteFirstSuperAdmin && assignedRole === 'user') {
        const superAdminCount = await countUsersByRole('super_admin');
        if (superAdminCount === 0) {
            assignedRole = 'super_admin';
        }
    }

    const { salt, hash } = hashPassword(safePassword);
    const createdAt = new Date();
    const updatedAt = createdAt;

    const user = {
        id: crypto.randomUUID(),
        name: safeName,
        email: normalizedEmail,
        role: assignedRole,
        isActive,
        passwordSalt: salt,
        passwordHash: hash,
        createdAt,
        updatedAt,
    };

    try {
        await pool.query(
            `INSERT INTO users (id, name, email, role, is_active, password_salt, password_hash, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [
                user.id,
                user.name,
                user.email,
                user.role,
                user.isActive ? 1 : 0,
                user.passwordSalt,
                user.passwordHash,
                user.createdAt,
                user.updatedAt,
            ]
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
            role: user.role,
            is_active: user.isActive ? 1 : 0,
            created_at: user.createdAt,
            updated_at: user.updatedAt,
        }),
    };
}

async function registerUser({ name, email, password }) {
    if (!(await hasSuperAdmin())) {
        return { ok: false, error: 'bootstrap_required' };
    }

    const registrationEnabled = await isRegistrationEnabled();
    if (!registrationEnabled) {
        return { ok: false, error: 'registration_disabled' };
    }

    return createUserRecord({
        name,
        email,
        password,
        role: 'user',
        isActive: true,
        autoPromoteFirstSuperAdmin: false,
    });
}

async function createInitialSuperAdmin({ name, email, password }) {
    if (await hasSuperAdmin()) {
        return { ok: false, error: 'super_admin_already_exists' };
    }

    return createUserRecord({
        name,
        email,
        password,
        role: 'super_admin',
        isActive: true,
        autoPromoteFirstSuperAdmin: false,
    });
}

async function authenticateUser({ email, password }) {
    const normalizedEmail = normalizeEmail(email);
    const safePassword = String(password || '');
    const [rows] = await getPool().query(
        `SELECT id, name, email, role, is_active, password_salt, password_hash, created_at, updated_at
         FROM users
         WHERE email = ?
         LIMIT 1`,
        [normalizedEmail]
    );

    const user = rows[0];
    if (!user) {
        return { ok: false, error: 'invalid_credentials' };
    }

    if (!Boolean(user.is_active)) {
        return { ok: false, error: 'user_inactive' };
    }

    if (!verifyPassword(safePassword, user.password_salt, user.password_hash)) {
        return { ok: false, error: 'invalid_credentials' };
    }

    return {
        ok: true,
        user: sanitizeUser(user),
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
            u.role AS user_role,
            u.is_active AS user_is_active,
            u.created_at AS user_created_at,
            u.updated_at AS user_updated_at
         FROM sessions s
         INNER JOIN users u ON u.id = s.user_id
         WHERE s.token_hash = ?
            AND s.expires_at > UTC_TIMESTAMP(3)
            AND u.is_active = 1
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
        role: row.user_role,
        is_active: row.user_is_active,
        created_at: row.user_created_at,
        updated_at: row.user_updated_at,
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
            role: normalizeRole(user.role, 'user'),
            isActive: Boolean(user.is_active),
            createdAt: toIso(user.created_at),
            updatedAt: toIso(user.updated_at),
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

async function listUsersForManagement({ search = '', role = '', isActive = null, limit = 500 } = {}) {
    const safeSearch = String(search || '').trim();
    const safeRole = String(role || '').trim();
    const safeLimit = Math.max(1, Math.min(1000, Number(limit || 500)));

    const conditions = [];
    const params = [];

    if (safeSearch) {
        conditions.push('(name LIKE ? OR email LIKE ?)');
        const pattern = `%${safeSearch}%`;
        params.push(pattern, pattern);
    }

    if (safeRole) {
        const normalizedRole = normalizeRole(safeRole, '');
        if (!isValidRole(normalizedRole)) {
            return { ok: false, error: 'invalid_role_filter' };
        }
        conditions.push('role = ?');
        params.push(normalizedRole);
    }

    if (isActive !== null && isActive !== undefined && String(isActive).trim() !== '') {
        conditions.push('is_active = ?');
        params.push(coerceBoolean(isActive, true) ? 1 : 0);
    }

    const whereSql = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

    const [rows] = await getPool().query(
        `SELECT id, name, email, role, is_active, created_at, updated_at
         FROM users
         ${whereSql}
         ORDER BY created_at DESC
         LIMIT ?`,
        [...params, safeLimit]
    );

    return {
        ok: true,
        users: rows.map(sanitizeUser),
    };
}

async function getUserById(userId) {
    const safeUserId = String(userId || '').trim();
    if (!safeUserId) {
        return null;
    }

    const [rows] = await getPool().query(
        `SELECT id, name, email, role, is_active, created_at, updated_at
         FROM users
         WHERE id = ?
         LIMIT 1`,
        [safeUserId]
    );

    return rows[0] ? sanitizeUser(rows[0]) : null;
}

async function createManagedUser(actor, payload) {
    if (!isAdminRole(actor?.role)) {
        return { ok: false, error: 'forbidden' };
    }

    const desiredRole = normalizeRole(payload?.role, 'user');
    if (!canActorAssignRole(actor.role, desiredRole)) {
        return { ok: false, error: 'forbidden_role_assignment' };
    }

    return createUserRecord({
        name: payload?.name,
        email: payload?.email,
        password: payload?.password,
        role: desiredRole,
        isActive: coerceBoolean(payload?.isActive, true),
        autoPromoteFirstSuperAdmin: false,
    });
}

async function updateManagedUser(actor, userId, payload) {
    if (!isAdminRole(actor?.role)) {
        return { ok: false, error: 'forbidden' };
    }

    const safeUserId = String(userId || '').trim();
    if (!safeUserId) {
        return { ok: false, error: 'invalid_user_id' };
    }

    const [targetRows] = await getPool().query(
        `SELECT id, name, email, role, is_active, created_at, updated_at
         FROM users
         WHERE id = ?
         LIMIT 1`,
        [safeUserId]
    );

    const target = targetRows[0];
    if (!target) {
        return { ok: false, error: 'user_not_found' };
    }

    if (!canActorManageTarget(actor, target)) {
        return { ok: false, error: 'forbidden' };
    }

    const actorRole = normalizeRole(actor.role, 'user');
    const targetRole = normalizeRole(target.role, 'user');
    const targetId = String(target.id);
    const actorId = String(actor.id || '');

    const updates = [];
    const values = [];

    if (payload && Object.prototype.hasOwnProperty.call(payload, 'name')) {
        const name = String(payload.name || '').trim();
        if (!name || name.length < 2) {
            return { ok: false, error: 'invalid_name' };
        }
        updates.push('name = ?');
        values.push(name);
    }

    if (payload && Object.prototype.hasOwnProperty.call(payload, 'email')) {
        const normalizedEmail = normalizeEmail(payload.email);
        if (!isValidEmail(normalizedEmail)) {
            return { ok: false, error: 'invalid_email' };
        }

        if (normalizedEmail !== normalizeEmail(target.email)) {
            const [existingRows] = await getPool().query(
                `SELECT id
                 FROM users
                 WHERE email = ? AND id <> ?
                 LIMIT 1`,
                [normalizedEmail, targetId]
            );
            if (existingRows.length > 0) {
                return { ok: false, error: 'email_already_exists' };
            }
        }

        updates.push('email = ?');
        values.push(normalizedEmail);
    }

    if (payload && Object.prototype.hasOwnProperty.call(payload, 'password')) {
        const safePassword = String(payload.password || '');
        if (!safePassword || safePassword.length < 8) {
            return { ok: false, error: 'password_too_short' };
        }

        const { salt, hash } = hashPassword(safePassword);
        updates.push('password_salt = ?', 'password_hash = ?');
        values.push(salt, hash);
    }

    if (payload && Object.prototype.hasOwnProperty.call(payload, 'role')) {
        if (actorRole !== 'super_admin') {
            return { ok: false, error: 'forbidden_role_assignment' };
        }

        const desiredRole = normalizeRole(payload.role, '');
        if (!isValidRole(desiredRole)) {
            return { ok: false, error: 'invalid_role' };
        }

        if (targetRole === 'super_admin' && desiredRole !== 'super_admin') {
            const activeSuperAdminCount = await countUsersByRole('super_admin', true);
            if (activeSuperAdminCount <= 1) {
                return { ok: false, error: 'cannot_remove_last_super_admin' };
            }
        }

        updates.push('role = ?');
        values.push(desiredRole);
    }

    let shouldRevokeSessions = false;
    if (payload && Object.prototype.hasOwnProperty.call(payload, 'isActive')) {
        const desiredIsActive = coerceBoolean(payload.isActive, true);

        if (actorId === targetId && !desiredIsActive) {
            return { ok: false, error: 'cannot_deactivate_self' };
        }

        if (!desiredIsActive && targetRole === 'super_admin') {
            const activeSuperAdminCount = await countUsersByRole('super_admin', true);
            if (activeSuperAdminCount <= 1) {
                return { ok: false, error: 'cannot_disable_last_super_admin' };
            }
        }

        updates.push('is_active = ?');
        values.push(desiredIsActive ? 1 : 0);
        shouldRevokeSessions = !desiredIsActive;
    }

    if (updates.length === 0) {
        return { ok: true, user: sanitizeUser(target) };
    }

    updates.push('updated_at = ?');
    values.push(new Date());

    values.push(targetId);
    await getPool().query(
        `UPDATE users
         SET ${updates.join(', ')}
         WHERE id = ?`,
        values
    );

    if (shouldRevokeSessions) {
        await getPool().query('DELETE FROM sessions WHERE user_id = ?', [targetId]);
    }

    const user = await getUserById(targetId);
    return { ok: true, user };
}

async function getManagementSummary() {
    const pool = getPool();
    const [userRows] = await pool.query(
        `SELECT
            COUNT(*) AS total_users,
            SUM(CASE WHEN role = 'super_admin' THEN 1 ELSE 0 END) AS super_admins,
            SUM(CASE WHEN role = 'admin' THEN 1 ELSE 0 END) AS admins,
            SUM(CASE WHEN role = 'user' THEN 1 ELSE 0 END) AS users,
            SUM(CASE WHEN is_active = 1 THEN 1 ELSE 0 END) AS active_users,
            SUM(CASE WHEN is_active = 0 THEN 1 ELSE 0 END) AS inactive_users
         FROM users`
    );

    const [environmentRows] = await pool.query('SELECT COUNT(*) AS total_environments FROM environments');
    const [keyRows] = await pool.query(
        `SELECT
            COUNT(*) AS total_api_keys,
            SUM(CASE WHEN is_active = 1 THEN 1 ELSE 0 END) AS active_api_keys
         FROM api_keys`
    );

    const registrationEnabled = await isRegistrationEnabled();

    return {
        users: {
            total: Number(userRows?.[0]?.total_users || 0),
            superAdmins: Number(userRows?.[0]?.super_admins || 0),
            admins: Number(userRows?.[0]?.admins || 0),
            users: Number(userRows?.[0]?.users || 0),
            active: Number(userRows?.[0]?.active_users || 0),
            inactive: Number(userRows?.[0]?.inactive_users || 0),
        },
        resources: {
            environments: Number(environmentRows?.[0]?.total_environments || 0),
            apiKeys: Number(keyRows?.[0]?.total_api_keys || 0),
            activeApiKeys: Number(keyRows?.[0]?.active_api_keys || 0),
        },
        registrationEnabled,
    };
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
            u.role AS user_role,
            u.is_active AS user_is_active,
            u.created_at AS user_created_at,
            u.updated_at AS user_updated_at,
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
         WHERE ak.key_hash = ?
            AND ak.is_active = 1
            AND u.is_active = 1
         LIMIT 1`,
        [keyHash]
    );

    const row = rows[0];
    if (!row) {
        return null;
    }

    const now = new Date();
    await pool.query('UPDATE api_keys SET last_used_at = ? WHERE id = ?', [now, row.api_key_id]);

    const user = sanitizeUser({
        id: row.user_id,
        name: row.user_name,
        email: row.user_email,
        role: row.user_role,
        is_active: row.user_is_active,
        created_at: row.user_created_at,
        updated_at: row.user_updated_at,
    });

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
    createInitialSuperAdmin,
    authenticateUser,
    createSessionForUser,
    getUserBySessionToken,
    revokeSessionToken,
    hasSuperAdmin,
    isRegistrationEnabled,
    setRegistrationEnabled,
    getLogRetentionDays,
    setLogRetentionDays,
    listUsersForManagement,
    getUserById,
    createManagedUser,
    updateManagedUser,
    getManagementSummary,
    listEnvironmentsByUser,
    getEnvironmentForUser,
    findEnvironmentByPin,
    createEnvironmentForUser,
    createApiKeyForEnvironment,
    listApiKeysForEnvironment,
    revokeApiKeyForEnvironment,
    resolveApiKeyContext,
    getPinsForUser,
    isAdminRole,
    sanitizeEnvironment,
    sanitizeApiKey,
    sanitizeUser,
};
