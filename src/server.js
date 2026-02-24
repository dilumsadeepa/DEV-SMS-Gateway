const http = require('http');
const path = require('path');
const crypto = require('crypto');

const express = require('express');
const cors = require('cors');
const dotenv = require('dotenv');
const { WebSocketServer, WebSocket } = require('ws');
const { getPool } = require('./db');
const { analyzeSmsPayload } = require('./sms-analysis');

dotenv.config();

const {
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
    createManagedUser,
    updateManagedUser,
    getManagementSummary,
    listEnvironmentsByUser,
    findEnvironmentByPin,
    createEnvironmentForUser,
    createApiKeyForEnvironment,
    listApiKeysForEnvironment,
    revokeApiKeyForEnvironment,
    resolveApiKeyContext,
    getPinsForUser,
    isAdminRole,
} = require('./store');

const HOST = process.env.HOST || '0.0.0.0';
const PORT = Number(process.env.PORT || 8090);
const REQUEST_TIMEOUT_MS = Number(process.env.REQUEST_TIMEOUT_MS || 20000);
const MAX_LOG_ITEMS = Number(process.env.MAX_LOG_ITEMS || 200);
const HEARTBEAT_INTERVAL_MS = Number(process.env.HEARTBEAT_INTERVAL_MS || 15000);
const HEARTBEAT_TIMEOUT_MS = Number(process.env.HEARTBEAT_TIMEOUT_MS || 90000);
const DEFAULT_LOG_RETENTION_DAYS = 2;
const MIN_LOG_RETENTION_DAYS = 1;
const MAX_LOG_RETENTION_DAYS = 365;
const LOG_RETENTION_PRUNE_INTERVAL_MS = Number(process.env.LOG_RETENTION_PRUNE_INTERVAL_MS || 300000);
const LOG_DB_SYNC_INTERVAL_MS = Number(process.env.LOG_DB_SYNC_INTERVAL_MS || 60000);

const app = express();
app.use(cors());
app.use(express.json({ limit: '1mb' }));
const publicDir = path.join(__dirname, '..', 'public');

app.use(express.static(publicDir));

function sendPage(fileName) {
    return (_req, res) => {
        res.sendFile(path.join(publicDir, fileName));
    };
}

app.get('/dashboard', sendPage('dashboard.html'));
app.get('/command-panel', sendPage('command-panel.html'));
app.get('/account-activity', sendPage('account-activity.html'));
app.get('/super-admin-dashboard', sendPage('super-admin-dashboard.html'));
app.get('/device-simulator', sendPage('device-simulator.html'));

const server = http.createServer(app);
const wss = new WebSocketServer({ server });

const devicesByPin = new Map();
const pendingByRequestId = new Map();
const statusUpdatesByRequestId = new Map();
const gatewayLogs = [];
let logRetentionDays = DEFAULT_LOG_RETENTION_DAYS;
let logDbSyncInProgress = false;
let logDbPruneInProgress = false;

function getDevicesForPin(pin) {
    const safePin = String(pin || '').trim();
    if (!safePin) {
        return [];
    }

    const pinBucket = devicesByPin.get(safePin);
    if (!pinBucket) {
        return [];
    }

    return Array.from(pinBucket.values());
}

function getOnlineDevicesForPin(pin) {
    return getDevicesForPin(pin).filter((device) => device.ws.readyState === WebSocket.OPEN);
}

function getAllConnectedDevices() {
    const devices = [];
    for (const pinBucket of devicesByPin.values()) {
        devices.push(...pinBucket.values());
    }
    return devices;
}

function nowIso() {
    return new Date().toISOString();
}

function asyncHandler(handler) {
    return (req, res, next) => {
        Promise.resolve(handler(req, res, next)).catch(next);
    };
}

function nullIfBlank(value) {
    const normalized = String(value ?? '').trim();
    return normalized ? normalized : null;
}

function normalizeLogMobile(log) {
    if (Array.isArray(log?.to)) {
        const joined = log.to.map((item) => String(item || '').trim()).filter(Boolean).join(', ');
        return nullIfBlank(joined);
    }

    return nullIfBlank(log?.to || log?.recipient || '');
}

function normalizeLogOccurredAt(log) {
    const candidate = log?.at || log?.timestamp || null;
    const parsed = candidate ? new Date(candidate) : new Date();
    if (Number.isNaN(parsed.getTime())) {
        return new Date();
    }
    return parsed;
}

function safeJsonStringify(value) {
    try {
        return JSON.stringify(value);
    } catch {
        return '{}';
    }
}

function buildLogHash(log) {
    const fingerprint = {
        at: nullIfBlank(log?.at || log?.timestamp || ''),
        type: nullIfBlank(log?.type || ''),
        pin: nullIfBlank(log?.pin || ''),
        requestId: nullIfBlank(log?.requestId || ''),
        deviceId: nullIfBlank(log?.deviceId || ''),
        mobile: normalizeLogMobile(log),
        status: nullIfBlank(log?.status || ''),
        message: nullIfBlank(log?.message || ''),
        error: nullIfBlank(log?.error || ''),
    };

    return crypto.createHash('sha256').update(safeJsonStringify(fingerprint)).digest('hex');
}

async function persistLogsToDatabase(logs, actorUserId = null) {
    const sourceLogs = Array.isArray(logs) ? logs : [];
    if (sourceLogs.length === 0) {
        return {
            scanned: 0,
            inserted: 0,
            skipped: 0,
        };
    }

    const pool = getPool();
    let inserted = 0;
    let skipped = 0;

    for (const log of sourceLogs) {
        const payload = safeJsonStringify(log || {});
        const mobileNumber = normalizeLogMobile(log);
        const occurredAt = normalizeLogOccurredAt(log);

        const [result] = await pool.query(
            `INSERT IGNORE INTO gateway_logs (
                log_hash,
                log_type,
                pin,
                mobile_number,
                content_text,
                request_id,
                device_id,
                environment_id,
                user_id,
                payload,
                occurred_at,
                saved_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, UTC_TIMESTAMP(3))`,
            [
                buildLogHash(log),
                nullIfBlank(log?.type || 'unknown') || 'unknown',
                nullIfBlank(log?.pin),
                mobileNumber,
                nullIfBlank(log?.message || log?.error || ''),
                nullIfBlank(log?.requestId),
                nullIfBlank(log?.deviceId),
                nullIfBlank(log?.environmentId),
                nullIfBlank(log?.userId || actorUserId),
                payload,
                occurredAt,
            ]
        );

        if (Number(result?.affectedRows || 0) > 0) {
            inserted += 1;
        } else {
            skipped += 1;
        }
    }

    return {
        scanned: sourceLogs.length,
        inserted,
        skipped,
    };
}

async function syncRuntimeLogsToDatabase() {
    if (logDbSyncInProgress) {
        return {
            scanned: 0,
            inserted: 0,
            skipped: 0,
            inProgress: true,
        };
    }

    logDbSyncInProgress = true;
    try {
        pruneRuntimeLogs();
        return await persistLogsToDatabase(gatewayLogs);
    } finally {
        logDbSyncInProgress = false;
    }
}

async function pruneDatabaseLogsByRetention(days = logRetentionDays) {
    if (logDbPruneInProgress) {
        return 0;
    }

    logDbPruneInProgress = true;
    try {
        const cutoff = new Date(getCutoffTimestamp(days));
        const [result] = await getPool().query(
            'DELETE FROM gateway_logs WHERE occurred_at < ?',
            [cutoff]
        );
        return Number(result?.affectedRows || 0);
    } finally {
        logDbPruneInProgress = false;
    }
}

async function clearDatabaseLogs() {
    const [result] = await getPool().query('DELETE FROM gateway_logs');
    return Number(result?.affectedRows || 0);
}

function clampLogRetentionDays(value, fallback = DEFAULT_LOG_RETENTION_DAYS) {
    const parsed = Number.parseInt(String(value ?? ''), 10);
    if (!Number.isInteger(parsed)) {
        return fallback;
    }

    return Math.min(MAX_LOG_RETENTION_DAYS, Math.max(MIN_LOG_RETENTION_DAYS, parsed));
}

function getCutoffTimestamp(days = logRetentionDays) {
    return Date.now() - (clampLogRetentionDays(days) * 24 * 60 * 60 * 1000);
}

function pruneLogsByRetention(days = logRetentionDays) {
    const cutoff = getCutoffTimestamp(days);
    const before = gatewayLogs.length;

    const kept = gatewayLogs.filter((entry) => {
        const timestamp = new Date(entry.at || 0).getTime();
        if (!Number.isFinite(timestamp)) {
            return true;
        }
        return timestamp >= cutoff;
    });

    gatewayLogs.length = 0;
    gatewayLogs.push(...kept);

    return before - gatewayLogs.length;
}

function pruneStatusUpdatesByRetention(days = logRetentionDays) {
    const cutoff = getCutoffTimestamp(days);
    let removedItems = 0;

    for (const [requestId, updates] of statusUpdatesByRequestId.entries()) {
        const kept = updates.filter((update) => {
            const rawTime = update.at || update.timestamp || null;
            const timestamp = new Date(rawTime || 0).getTime();
            if (!Number.isFinite(timestamp)) {
                return true;
            }
            return timestamp >= cutoff;
        });

        removedItems += Math.max(0, updates.length - kept.length);

        if (kept.length === 0) {
            statusUpdatesByRequestId.delete(requestId);
        } else {
            statusUpdatesByRequestId.set(requestId, kept);
        }
    }

    return removedItems;
}

function pruneRuntimeLogs(days = logRetentionDays) {
    const removedLogs = pruneLogsByRetention(days);
    const removedStatusUpdates = pruneStatusUpdatesByRetention(days);

    return {
        removedLogs,
        removedStatusUpdates,
        logRetentionDays: clampLogRetentionDays(days),
    };
}

function clearRuntimeLogsAndStatus() {
    const clearedLogs = gatewayLogs.length;
    const clearedStatusRequests = statusUpdatesByRequestId.size;

    let clearedStatusUpdates = 0;
    for (const updates of statusUpdatesByRequestId.values()) {
        clearedStatusUpdates += Array.isArray(updates) ? updates.length : 0;
    }

    gatewayLogs.length = 0;
    statusUpdatesByRequestId.clear();

    return {
        clearedLogs,
        clearedStatusRequests,
        clearedStatusUpdates,
    };
}

async function deleteAccountLogsForUser(userId, pinsSet) {
    const safeUserId = String(userId || '').trim();
    const pins = Array.from(pinsSet || []).map((pin) => String(pin || '').trim()).filter(Boolean);
    const pinLookup = new Set(pins);

    const runtimeBefore = gatewayLogs.length;
    const keptRuntimeLogs = gatewayLogs.filter((log) => !pinLookup.has(String(log.pin || '')));
    gatewayLogs.length = 0;
    gatewayLogs.push(...keptRuntimeLogs);
    const removedRuntimeLogs = Math.max(0, runtimeBefore - gatewayLogs.length);

    let removedStatusUpdates = 0;
    let clearedStatusRequests = 0;
    for (const [requestId, updates] of statusUpdatesByRequestId.entries()) {
        const kept = updates.filter((update) => !pinLookup.has(String(update.pin || '')));
        removedStatusUpdates += Math.max(0, updates.length - kept.length);
        if (kept.length === 0) {
            statusUpdatesByRequestId.delete(requestId);
            clearedStatusRequests += 1;
        } else {
            statusUpdatesByRequestId.set(requestId, kept);
        }
    }

    let deletedDbLogs = 0;
    if (pins.length > 0) {
        const placeholders = pins.map(() => '?').join(', ');
        const [result] = await getPool().query(
            `DELETE FROM gateway_logs
             WHERE user_id = ?
                OR pin IN (${placeholders})`,
            [safeUserId, ...pins]
        );
        deletedDbLogs = Number(result?.affectedRows || 0);
    } else {
        const [result] = await getPool().query(
            'DELETE FROM gateway_logs WHERE user_id = ?',
            [safeUserId]
        );
        deletedDbLogs = Number(result?.affectedRows || 0);
    }

    return {
        removedRuntimeLogs,
        removedStatusUpdates,
        clearedStatusRequests,
        deletedDbLogs,
    };
}

async function refreshLogRetentionDaysFromSettings() {
    try {
        const settingValue = await getLogRetentionDays();
        logRetentionDays = clampLogRetentionDays(settingValue, DEFAULT_LOG_RETENTION_DAYS);
    } catch (error) {
        logRetentionDays = clampLogRetentionDays(logRetentionDays, DEFAULT_LOG_RETENTION_DAYS);
        pushLog({
            type: 'log_retention_refresh_failed',
            error: error.message,
        });
    }

    return logRetentionDays;
}

function pushLog(entry) {
    pruneRuntimeLogs();
    const logEntry = { at: nowIso(), ...entry };
    gatewayLogs.unshift(logEntry);
    if (gatewayLogs.length > MAX_LOG_ITEMS) {
        gatewayLogs.length = MAX_LOG_ITEMS;
    }

    persistLogsToDatabase([logEntry]).catch((error) => {
        // eslint-disable-next-line no-console
        console.error('[puppy-sms-gateway-server] log_persist_error:', error.message);
    });
}

function pushStatusUpdate(update) {
    pruneRuntimeLogs();
    const requestId = String(update.requestId || '').trim();
    if (!requestId) {
        return;
    }

    const list = statusUpdatesByRequestId.get(requestId) || [];
    list.push({ at: nowIso(), ...update });
    statusUpdatesByRequestId.set(requestId, list);
}

function buildStatusUrl(requestId) {
    return `/api/status/${encodeURIComponent(String(requestId || '').trim())}`;
}

function safeJsonParse(raw) {
    try {
        return JSON.parse(raw);
    } catch {
        return null;
    }
}

function resolveApiKey(req) {
    const headerKey = req.get('x-api-key');
    if (headerKey) {
        return headerKey;
    }
    const auth = req.get('authorization') || '';
    if (auth.toLowerCase().startsWith('bearer ')) {
        return auth.slice(7).trim();
    }
    return '';
}

function resolveBearerToken(req) {
    const auth = req.get('authorization') || '';
    if (auth.toLowerCase().startsWith('bearer ')) {
        return auth.slice(7).trim();
    }
    return '';
}

async function getOptionalAuthUser(req) {
    const token = resolveBearerToken(req);
    if (!token) {
        return null;
    }
    return getUserBySessionToken(token);
}

const requireAuth = asyncHandler(async (req, res, next) => {
    const token = resolveBearerToken(req);
    if (!token) {
        res.status(401).json({ ok: false, error: 'unauthorized' });
        return;
    }

    const auth = await getUserBySessionToken(token);
    if (!auth) {
        res.status(401).json({ ok: false, error: 'unauthorized' });
        return;
    }

    req.auth = auth;
    req.authToken = token;
    next();
});

const requireAdmin = (req, res, next) => {
    if (!req.auth?.user || !isAdminRole(req.auth.user.role)) {
        res.status(403).json({ ok: false, error: 'forbidden' });
        return;
    }
    next();
};

const requireSuperAdmin = (req, res, next) => {
    if (!req.auth?.user || String(req.auth.user.role || '') !== 'super_admin') {
        res.status(403).json({ ok: false, error: 'forbidden' });
        return;
    }
    next();
};

function getClientIp(req) {
    const forwarded = req.headers['x-forwarded-for'];
    if (typeof forwarded === 'string' && forwarded.length > 0) {
        return forwarded.split(',')[0].trim();
    }
    return req.socket?.remoteAddress || 'unknown';
}

async function registerDeviceConnection(ws, req) {
    const requestUrl = new URL(req.url, 'http://localhost');
    const pathName = requestUrl.pathname || '/';
    if (!['/', '/ws/device'].includes(pathName)) {
        ws.close(4000, 'invalid_path');
        return;
    }

    const pin = requestUrl.searchParams.get('pin');

    if (!pin) {
        ws.close(4001, 'pin_required');
        return;
    }

    const environment = await findEnvironmentByPin(pin);
    if (!environment) {
        ws.close(4003, 'pin_not_registered');
        return;
    }

    const deviceId = requestUrl.searchParams.get('deviceId') || 'unknown-device';
    const deviceName = requestUrl.searchParams.get('deviceName') || 'Android Phone';
    const appVersion = requestUrl.searchParams.get('appVersion') || 'unknown';
    const connectionKey = crypto.randomUUID();

    const connectedAt = Date.now();
    const device = {
        ws,
        connectionKey,
        pin,
        deviceId,
        deviceName,
        appVersion,
        ip: getClientIp(req),
        connectedAt,
        lastSeenAt: connectedAt,
        lastPongAt: connectedAt,
        environmentId: environment ? environment.id : null,
        userId: environment ? environment.userId : null,
    };

    ws.devicePin = pin;
    ws.deviceConnectionKey = connectionKey;

    const pinBucket = devicesByPin.get(pin) || new Map();
    pinBucket.set(connectionKey, device);
    devicesByPin.set(pin, pinBucket);

    pushLog({
        type: 'device_connected',
        pin,
        connectionKey,
        deviceId,
        deviceName,
        ip: device.ip,
        activeConnections: pinBucket.size,
        environmentId: device.environmentId,
        userId: device.userId,
    });

    ws.send(
        JSON.stringify({
            type: 'registered',
            pin,
            deviceId,
            connectionKey,
            activeConnections: pinBucket.size,
            serverTime: nowIso(),
        })
    );

    ws.on('pong', () => {
        const current = devicesByPin.get(pin)?.get(connectionKey);
        if (current && current.ws === ws) {
            const now = Date.now();
            current.lastSeenAt = now;
            current.lastPongAt = now;
        }
    });

    ws.on('message', (raw) => {
        const data = safeJsonParse(raw.toString());
        const current = devicesByPin.get(pin)?.get(connectionKey);
        if (!current || current.ws !== ws) {
            return;
        }

        current.lastSeenAt = Date.now();
        current.lastPongAt = Date.now();

        if (!data || typeof data !== 'object') {
            return;
        }

        if (data.type === 'sms_result') {
            const pending = pendingByRequestId.get(data.requestId);
            if (!pending || pending.settled) {
                return;
            }

            const pendingConnections = pending.dispatchedConnectionKeys instanceof Set
                ? pending.dispatchedConnectionKeys
                : null;

            if (pendingConnections && pendingConnections.size > 0) {
                if (!pendingConnections.has(connectionKey)) {
                    return;
                }
                pendingConnections.delete(connectionKey);
            }

            const targetCount = Array.isArray(pending.dispatchedDeviceIds)
                ? pending.dispatchedDeviceIds.length
                : 1;

            if (data.success) {
                pending.settled = true;
                clearTimeout(pending.timeout);
                pendingByRequestId.delete(data.requestId);

                pushLog({
                    type: 'sms_sent',
                    requestId: data.requestId,
                    pin,
                    connectionKey,
                    deviceId: current.deviceId || deviceId,
                    to: pending.to,
                    message: pending.message,
                    analysis: pending.analysis || null,
                    targetCount,
                    dispatchedDeviceIds: pending.dispatchedDeviceIds || [],
                    environmentId: pending.environmentId || current.environmentId,
                    userId: pending.userId || current.userId,
                });

                pending.resolve({
                    requestId: data.requestId,
                    success: true,
                    pin,
                    connectionKey,
                    deviceId: current.deviceId || deviceId,
                    to: pending.to,
                    message: pending.message,
                    error: null,
                    statusUrl: buildStatusUrl(data.requestId),
                    analysis: pending.analysis || null,
                    targetCount,
                    dispatchedDeviceIds: pending.dispatchedDeviceIds || [],
                    socketErrors: pending.socketErrors || [],
                    environmentId: pending.environmentId || current.environmentId,
                    userId: pending.userId || current.userId,
                    raw: data,
                });
                return;
            }

            if (!Array.isArray(pending.respondedFailures)) {
                pending.respondedFailures = [];
            }

            pending.respondedFailures.push({
                connectionKey,
                deviceId: current.deviceId || deviceId,
                error: data.error || 'device_reported_failure',
            });

            if (pendingConnections && pendingConnections.size > 0) {
                pushLog({
                    type: 'sms_device_failed',
                    requestId: data.requestId,
                    pin,
                    connectionKey,
                    deviceId: current.deviceId || deviceId,
                    error: data.error || 'device_reported_failure',
                    remainingTargetConnections: pendingConnections.size,
                    targetCount,
                    environmentId: pending.environmentId || current.environmentId,
                    userId: pending.userId || current.userId,
                });
                return;
            }

            pending.settled = true;
            clearTimeout(pending.timeout);
            pendingByRequestId.delete(data.requestId);

            const failureError = data.error || pending.respondedFailures.at(-1)?.error || 'device_reported_failure';
            pushLog({
                type: 'sms_failed',
                requestId: data.requestId,
                pin,
                to: pending.to,
                message: pending.message,
                error: failureError,
                analysis: pending.analysis || null,
                targetCount,
                dispatchedDeviceIds: pending.dispatchedDeviceIds || [],
                respondedFailures: pending.respondedFailures,
                environmentId: pending.environmentId || current.environmentId,
                userId: pending.userId || current.userId,
            });

            pending.resolve({
                requestId: data.requestId,
                success: false,
                pin,
                to: pending.to,
                message: pending.message,
                error: failureError,
                statusUrl: buildStatusUrl(data.requestId),
                analysis: pending.analysis || null,
                targetCount,
                dispatchedDeviceIds: pending.dispatchedDeviceIds || [],
                respondedFailures: pending.respondedFailures,
                socketErrors: pending.socketErrors || [],
                environmentId: pending.environmentId || current.environmentId,
                userId: pending.userId || current.userId,
                raw: data,
            });
            return;
        }

        if (data.type === 'sms_status') {
            const statusEntry = {
                requestId: data.requestId || null,
                pin,
                connectionKey,
                deviceId,
                status: data.status || 'unknown',
                recipient: data.recipient || null,
                partIndex: Number.isInteger(data.partIndex) ? data.partIndex : null,
                totalParts: Number.isInteger(data.totalParts) ? data.totalParts : null,
                resultCode: Number.isInteger(data.resultCode) ? data.resultCode : null,
                error: data.error || null,
                timestamp: data.timestamp || null,
                to: data.to || null,
                environmentId: current.environmentId,
                userId: current.userId,
            };

            const pendingForStatus = statusEntry.requestId
                ? pendingByRequestId.get(statusEntry.requestId)
                : null;
            if (pendingForStatus?.analysis) {
                statusEntry.analysis = pendingForStatus.analysis;
            }

            pushStatusUpdate(statusEntry);
            pushLog({
                type: 'sms_status',
                ...statusEntry,
            });
            return;
        }

        if (data.type === 'device_log') {
            pushLog({
                type: 'device_log',
                pin,
                deviceId,
                level: data.level || 'info',
                message: data.message || '',
                environmentId: current.environmentId,
                userId: current.userId,
            });
        }
    });

    ws.on('close', () => {
        const pinDevices = devicesByPin.get(pin);
        const current = pinDevices?.get(connectionKey);
        if (current && current.ws === ws) {
            pinDevices.delete(connectionKey);
            const activeConnections = pinDevices.size;
            if (pinDevices.size === 0) {
                devicesByPin.delete(pin);
            }
            pushLog({
                type: 'device_disconnected',
                pin,
                connectionKey,
                deviceId,
                deviceName,
                activeConnections,
                environmentId: current.environmentId,
                userId: current.userId,
            });
        }
    });

    ws.on('error', (error) => {
        pushLog({
            type: 'device_error',
            pin,
            connectionKey,
            deviceId,
            error: error.message,
            environmentId: device.environmentId,
            userId: device.userId,
        });
    });
}

wss.on('connection', (ws, req) => {
    registerDeviceConnection(ws, req).catch((error) => {
        pushLog({
            type: 'device_registration_error',
            ip: getClientIp(req),
            error: error.message,
        });
        ws.close(1011, 'server_error');
    });
});

function normalizeDevicesForResponse(devices) {
    return devices.map((device) => ({
        pin: device.pin,
        connectionKey: device.connectionKey || null,
        deviceId: device.deviceId,
        deviceName: device.deviceName,
        appVersion: device.appVersion,
        ip: device.ip,
        connectedAt: new Date(device.connectedAt).toISOString(),
        lastSeenAt: new Date(device.lastSeenAt).toISOString(),
        online: device.ws.readyState === WebSocket.OPEN,
        environmentId: device.environmentId || null,
        userId: device.userId || null,
    }));
}

async function normalizeUserPins(userId) {
    return new Set(await getPinsForUser(userId));
}

function filterLogsByPins(logs, pinsSet) {
    return logs.filter((log) => pinsSet.has(String(log.pin || '')));
}

app.post('/api/auth/register', asyncHandler(async (req, res) => {
    const { name, email, password } = req.body || {};
    const result = await registerUser({ name, email, password });
    if (!result.ok) {
        const statusByError = {
            bootstrap_required: 409,
            registration_disabled: 403,
        };
        const statusCode = statusByError[result.error] || 422;
        res.status(statusCode).json({ ok: false, error: result.error });
        return;
    }

    res.status(201).json({
        ok: true,
        user: result.user,
        next: 'login_required',
    });
}));

app.get('/api/public/bootstrap-status', asyncHandler(async (_req, res) => {
    const [superAdminExists, registrationEnabled] = await Promise.all([
        hasSuperAdmin(),
        isRegistrationEnabled(),
    ]);

    res.json({
        ok: true,
        hasSuperAdmin: superAdminExists,
        registrationEnabled,
    });
}));

app.post('/api/public/bootstrap-super-admin', asyncHandler(async (req, res) => {
    const { name, email, password } = req.body || {};
    const result = await createInitialSuperAdmin({ name, email, password });
    if (!result.ok) {
        const statusByError = {
            super_admin_already_exists: 409,
            invalid_name: 422,
            invalid_email: 422,
            invalid_role: 422,
            password_too_short: 422,
            email_already_exists: 422,
        };
        res.status(statusByError[result.error] || 422).json({ ok: false, error: result.error });
        return;
    }

    const session = await createSessionForUser(result.user.id);
    res.status(201).json({
        ok: true,
        user: result.user,
        token: session.token,
        expiresAt: session.expiresAt,
        next: 'dashboard',
    });
}));

app.post('/api/auth/login', asyncHandler(async (req, res) => {
    const { email, password } = req.body || {};
    const authResult = await authenticateUser({ email, password });
    if (!authResult.ok) {
        res.status(401).json({ ok: false, error: authResult.error });
        return;
    }

    const session = await createSessionForUser(authResult.user.id);
    res.json({
        ok: true,
        user: authResult.user,
        token: session.token,
        expiresAt: session.expiresAt,
    });
}));

app.post('/api/auth/logout', requireAuth, asyncHandler(async (req, res) => {
    await revokeSessionToken(req.authToken);
    res.json({ ok: true });
}));

app.get('/api/auth/me', requireAuth, (_req, res) => {
    res.json({
        ok: true,
        user: _req.auth.user,
    });
});

app.get('/api/environments', requireAuth, asyncHandler(async (req, res) => {
    const environments = await listEnvironmentsByUser(req.auth.user.id);
    res.json({ ok: true, environments });
}));

app.post('/api/environments', requireAuth, asyncHandler(async (req, res) => {
    const result = await createEnvironmentForUser(req.auth.user.id, req.body || {});
    if (!result.ok) {
        res.status(422).json({ ok: false, error: result.error });
        return;
    }

    const keyResult = await createApiKeyForEnvironment(req.auth.user.id, result.environment.id, {
        name: 'default',
    });

    if (!keyResult.ok) {
        res.status(500).json({ ok: false, error: 'failed_to_create_default_api_key' });
        return;
    }

    res.status(201).json({
        ok: true,
        environment: result.environment,
        apiKey: keyResult.apiKey,
        apiKeyInfo: keyResult.apiKeyInfo,
    });
}));

app.get('/api/environments/:environmentId/api-keys', requireAuth, asyncHandler(async (req, res) => {
    const environmentId = String(req.params.environmentId || '').trim();
    const result = await listApiKeysForEnvironment(req.auth.user.id, environmentId);
    if (!result.ok) {
        res.status(404).json({ ok: false, error: result.error });
        return;
    }

    res.json({
        ok: true,
        environment: result.environment,
        apiKeys: result.apiKeys,
    });
}));

app.post('/api/environments/:environmentId/api-keys', requireAuth, asyncHandler(async (req, res) => {
    const environmentId = String(req.params.environmentId || '').trim();
    const result = await createApiKeyForEnvironment(req.auth.user.id, environmentId, req.body || {});
    if (!result.ok) {
        res.status(404).json({ ok: false, error: result.error });
        return;
    }

    res.status(201).json({
        ok: true,
        environment: result.environment,
        apiKey: result.apiKey,
        apiKeyInfo: result.apiKeyInfo,
    });
}));

app.delete('/api/environments/:environmentId/api-keys/:keyId', requireAuth, asyncHandler(async (req, res) => {
    const environmentId = String(req.params.environmentId || '').trim();
    const keyId = String(req.params.keyId || '').trim();

    const result = await revokeApiKeyForEnvironment(req.auth.user.id, environmentId, keyId);
    if (!result.ok) {
        res.status(404).json({ ok: false, error: result.error });
        return;
    }

    res.json({ ok: true, apiKey: result.apiKey });
}));

app.get('/api/account/devices', requireAuth, asyncHandler(async (req, res) => {
    const pinsSet = await normalizeUserPins(req.auth.user.id);
    const devices = normalizeDevicesForResponse(
        getAllConnectedDevices().filter((device) => pinsSet.has(String(device.pin || '')))
    );
    res.json({ ok: true, devices });
}));

app.get('/api/account/logs', requireAuth, asyncHandler(async (req, res) => {
    pruneRuntimeLogs();
    const pinsSet = await normalizeUserPins(req.auth.user.id);
    res.json({ ok: true, logs: filterLogsByPins(gatewayLogs, pinsSet) });
}));

app.post('/api/account/logs/save', requireAuth, asyncHandler(async (req, res) => {
    pruneRuntimeLogs();
    const pinsSet = await normalizeUserPins(req.auth.user.id);
    const accountLogs = filterLogsByPins(gatewayLogs, pinsSet);
    const summary = await persistLogsToDatabase(accountLogs, req.auth.user.id);
    res.json({ ok: true, summary });
}));

app.delete('/api/account/logs', requireAuth, asyncHandler(async (req, res) => {
    pruneRuntimeLogs();
    const pinsSet = await normalizeUserPins(req.auth.user.id);
    const summary = await deleteAccountLogsForUser(req.auth.user.id, pinsSet);
    res.json({
        ok: true,
        summary: {
            ...summary,
            performedBy: req.auth.user.email || req.auth.user.id,
        },
    });
}));

app.get('/api/admin/summary', requireAuth, requireAdmin, asyncHandler(async (_req, res) => {
    const summary = await getManagementSummary();
    res.json({
        ok: true,
        summary: {
            ...summary,
            runtime: {
                connectedDevices: getAllConnectedDevices().length,
                pendingRequests: pendingByRequestId.size,
                totalLogsInMemory: gatewayLogs.length,
            },
        },
    });
}));

app.get('/api/admin/settings', requireAuth, requireAdmin, asyncHandler(async (req, res) => {
    const [registrationEnabled, settingLogRetentionDays] = await Promise.all([
        isRegistrationEnabled(),
        getLogRetentionDays(),
    ]);

    logRetentionDays = clampLogRetentionDays(settingLogRetentionDays, DEFAULT_LOG_RETENTION_DAYS);
    res.json({
        ok: true,
        settings: {
            registrationEnabled,
            logRetentionDays,
        },
        permissions: {
            canToggleRegistration: String(req.auth.user.role || '') === 'super_admin',
            canManageLogs: String(req.auth.user.role || '') === 'super_admin',
        },
    });
}));

app.patch('/api/admin/settings/registration', requireAuth, requireSuperAdmin, asyncHandler(async (req, res) => {
    const enabled = req.body?.enabled;
    if (typeof enabled !== 'boolean') {
        res.status(422).json({ ok: false, error: 'invalid_enabled_value' });
        return;
    }

    const registrationEnabled = await setRegistrationEnabled(enabled);
    res.json({
        ok: true,
        settings: {
            registrationEnabled,
            logRetentionDays,
        },
    });
}));

app.patch('/api/admin/settings/log-retention', requireAuth, requireSuperAdmin, asyncHandler(async (req, res) => {
    const days = Number(req.body?.days);
    if (!Number.isInteger(days) || days < MIN_LOG_RETENTION_DAYS || days > MAX_LOG_RETENTION_DAYS) {
        res.status(422).json({
            ok: false,
            error: 'invalid_log_retention_days',
            min: MIN_LOG_RETENTION_DAYS,
            max: MAX_LOG_RETENTION_DAYS,
        });
        return;
    }

    const updatedDays = await setLogRetentionDays(days);
    logRetentionDays = clampLogRetentionDays(updatedDays, DEFAULT_LOG_RETENTION_DAYS);
    const pruneSummary = pruneRuntimeLogs(logRetentionDays);
    const deletedDbLogs = await pruneDatabaseLogsByRetention(logRetentionDays);

    res.json({
        ok: true,
        settings: {
            logRetentionDays,
            registrationEnabled: await isRegistrationEnabled(),
        },
        pruneSummary: {
            ...pruneSummary,
            deletedDbLogs,
        },
    });
}));

app.get('/api/admin/users', requireAuth, requireAdmin, asyncHandler(async (req, res) => {
    const search = String(req.query.search || '').trim();
    const role = String(req.query.role || '').trim();
    const isActive = String(req.query.isActive || '').trim();
    const limit = Number(req.query.limit || 500);

    const result = await listUsersForManagement({
        search,
        role,
        isActive: isActive ? isActive : null,
        limit,
    });

    if (!result.ok) {
        res.status(422).json({ ok: false, error: result.error });
        return;
    }

    let users = result.users;
    if (String(req.auth.user.role || '') === 'admin') {
        users = users.filter((user) => user.role === 'user' || user.id === req.auth.user.id);
    }

    res.json({ ok: true, users });
}));

app.post('/api/admin/users', requireAuth, requireAdmin, asyncHandler(async (req, res) => {
    const result = await createManagedUser(req.auth.user, req.body || {});
    if (!result.ok) {
        const statusByError = {
            forbidden: 403,
            forbidden_role_assignment: 403,
            invalid_name: 422,
            invalid_email: 422,
            invalid_role: 422,
            password_too_short: 422,
            email_already_exists: 422,
        };
        res.status(statusByError[result.error] || 422).json({ ok: false, error: result.error });
        return;
    }

    res.status(201).json({ ok: true, user: result.user });
}));

app.patch('/api/admin/users/:userId', requireAuth, requireAdmin, asyncHandler(async (req, res) => {
    const userId = String(req.params.userId || '').trim();
    const result = await updateManagedUser(req.auth.user, userId, req.body || {});
    if (!result.ok) {
        const statusByError = {
            forbidden: 403,
            forbidden_role_assignment: 403,
            cannot_deactivate_self: 422,
            cannot_remove_last_super_admin: 422,
            cannot_disable_last_super_admin: 422,
            user_not_found: 404,
            invalid_user_id: 422,
            invalid_name: 422,
            invalid_email: 422,
            invalid_role: 422,
            password_too_short: 422,
            email_already_exists: 422,
        };
        res.status(statusByError[result.error] || 422).json({ ok: false, error: result.error });
        return;
    }

    res.json({ ok: true, user: result.user });
}));

app.get('/api/admin/devices', requireAuth, requireAdmin, (_req, res) => {
    res.json({
        ok: true,
        devices: normalizeDevicesForResponse(getAllConnectedDevices()),
    });
});

app.get('/api/admin/logs', requireAuth, requireAdmin, (_req, res) => {
    pruneRuntimeLogs();
    res.json({ ok: true, logs: gatewayLogs });
});

app.delete('/api/admin/logs', requireAuth, requireSuperAdmin, asyncHandler(async (req, res) => {
    const summary = clearRuntimeLogsAndStatus();
    const deletedDbLogs = await clearDatabaseLogs();
    res.json({
        ok: true,
        summary: {
            ...summary,
            deletedDbLogs,
            performedBy: req.auth?.user?.email || req.auth?.user?.id || 'unknown',
        },
    });
}));

app.get('/health', asyncHandler(async (_req, res) => {
    pruneRuntimeLogs();
    const registrationEnabled = await isRegistrationEnabled();
    res.json({
        ok: true,
        service: 'puppy-sms-gateway-server',
        time: nowIso(),
        connectedDevices: getAllConnectedDevices().length,
        pendingRequests: pendingByRequestId.size,
        uptimeSec: Math.round(process.uptime()),
        authEnabled: true,
        environmentApiKeysOnly: true,
        registrationEnabled,
        logRetentionDays,
        logsInMemory: gatewayLogs.length,
    });
}));

app.get('/api/devices', asyncHandler(async (req, res) => {
    const auth = await getOptionalAuthUser(req);
    let devices = getAllConnectedDevices();
    if (auth) {
        const pinsSet = await normalizeUserPins(auth.user.id);
        devices = devices.filter((device) => pinsSet.has(String(device.pin || '')));
    }

    res.json({ ok: true, devices: normalizeDevicesForResponse(devices) });
}));

app.get('/api/logs', asyncHandler(async (req, res) => {
    pruneRuntimeLogs();
    const auth = await getOptionalAuthUser(req);
    if (!auth) {
        res.json({ ok: true, logs: gatewayLogs });
        return;
    }

    const pinsSet = await normalizeUserPins(auth.user.id);
    res.json({ ok: true, logs: filterLogsByPins(gatewayLogs, pinsSet) });
}));

app.get('/api/status/:requestId', asyncHandler(async (req, res) => {
    pruneRuntimeLogs();
    const requestId = String(req.params.requestId || '').trim();
    const updates = statusUpdatesByRequestId.get(requestId) || [];
    const auth = await getOptionalAuthUser(req);
    const apiKeyContext = await resolveApiKeyContext(resolveApiKey(req));

    if (!auth && !apiKeyContext) {
        res.status(401).json({ ok: false, error: 'unauthorized' });
        return;
    }

    if (updates.length > 0) {
        let allowedPins = new Set();
        if (auth) {
            allowedPins = await normalizeUserPins(auth.user.id);
        } else if (apiKeyContext) {
            allowedPins = new Set([String(apiKeyContext.environment.pin || '')]);
        }

        const hasAuthorizedPin = updates.some((item) => allowedPins.has(String(item.pin || '')));
        if (!hasAuthorizedPin) {
            res.status(403).json({ ok: false, error: 'forbidden' });
            return;
        }
    }

    res.json({ ok: true, requestId, updates });
}));

app.post('/api/sms/analyze', requireAuth, asyncHandler(async (req, res) => {
    const message = String(req.body?.message || '').trim();
    const analysis = analyzeSmsPayload({
        to: req.body?.to,
        message,
    });

    res.json({
        ok: true,
        analysis,
    });
}));

app.post('/api/send-sms', asyncHandler(async (req, res) => {
    const providedKey = resolveApiKey(req);
    const apiKeyContext = await resolveApiKeyContext(providedKey);

    if (!apiKeyContext) {
        res.status(401).json({ ok: false, error: 'unauthorized' });
        return;
    }

    const pin = String(apiKeyContext.environment.pin || '').trim();
    const environmentId = apiKeyContext.environment.id;
    const userId = apiKeyContext.user.id;

    const requestedPin = String(req.body?.pin || '').trim();
    if (requestedPin && requestedPin !== pin) {
        pushLog({
            type: 'sms_rejected_pin_mismatch',
            pin,
            requestedPin,
            expectedPin: pin,
            to: req.body?.to || null,
            message: String(req.body?.message || '').trim(),
            environmentId,
            userId,
        });

        res.status(422).json({
            ok: false,
            error: 'pin_mismatch_for_api_key',
            expectedPin: pin,
        });
        return;
    }

    const message = String(req.body?.message || '').trim();
    const analysis = analyzeSmsPayload({
        to: req.body?.to,
        message,
    });

    if (!message || Number(analysis.recipients.total || 0) === 0) {
        pushLog({
            type: 'sms_rejected_missing_payload',
            pin,
            to: req.body?.to || null,
            message,
            analysis,
            environmentId,
            userId,
        });

        res.status(422).json({
            ok: false,
            error: 'to_message_required',
            hint: 'Expected JSON body with to, message',
            analysis,
        });
        return;
    }

    if (analysis.recipients.invalidCount > 0) {
        pushLog({
            type: 'sms_rejected_invalid_recipients',
            pin,
            to: req.body?.to || null,
            message,
            invalidRecipients: analysis.recipients.invalidRecipients,
            analysis,
            environmentId,
            userId,
        });

        res.status(422).json({
            ok: false,
            error: 'invalid_recipients_e164',
            invalidRecipients: analysis.recipients.invalidRecipients,
            analysis,
        });
        return;
    }

    const toList = analysis.recipients.validRecipients;

    const targetDevices = getOnlineDevicesForPin(pin);
    if (targetDevices.length === 0) {
        pushLog({
            type: 'sms_not_sent_device_offline',
            pin,
            to: toList,
            message,
            analysis,
            environmentId,
            userId,
        });

        res.status(404).json({
            ok: false,
            error: 'device_not_connected',
            pin,
            environmentId,
            analysis,
        });
        return;
    }

    const requestId = crypto.randomUUID();
    const deliveredTargets = [];
    const socketErrors = [];

    for (const device of targetDevices) {
        const payload = {
            type: 'send_sms',
            requestId,
            to: toList,
            message,
        };

        try {
            device.ws.send(JSON.stringify(payload));
            deliveredTargets.push(device);
        } catch (error) {
            socketErrors.push({
                connectionKey: device.connectionKey || null,
                deviceId: device.deviceId || null,
                error: error.message,
            });
        }
    }

    if (deliveredTargets.length === 0) {
        pushLog({
            type: 'sms_not_sent_socket_error',
            pin,
            to: toList,
            message,
            error: 'all_target_socket_sends_failed',
            socketErrors,
            analysis,
            environmentId,
            userId,
        });

        res.status(500).json({
            ok: false,
            error: 'socket_send_failed',
            detail: 'all_target_socket_sends_failed',
            socketErrors,
            environmentId,
            analysis,
        });
        return;
    }

    const dispatchedDeviceIds = deliveredTargets.map((item) => item.deviceId).filter(Boolean);
    const dispatchedConnectionKeys = deliveredTargets.map((item) => item.connectionKey).filter(Boolean);

    pushLog({
        type: 'sms_dispatched',
        requestId,
        pin,
        to: toList,
        message,
        analysis,
        targetCount: deliveredTargets.length,
        dispatchedDeviceIds,
        dispatchedConnectionKeys,
        socketErrors,
        environmentId,
        userId,
    });

    const resultPromise = new Promise((resolve) => {
        const timeout = setTimeout(() => {
            pendingByRequestId.delete(requestId);

            pushLog({
                type: 'sms_timeout',
                requestId,
                pin,
                to: toList,
                message,
                analysis,
                targetCount: deliveredTargets.length,
                dispatchedDeviceIds,
                dispatchedConnectionKeys,
                environmentId,
                userId,
            });

            resolve({
                requestId,
                success: false,
                pin,
                to: toList,
                message,
                error: 'device_response_timeout',
                statusUrl: buildStatusUrl(requestId),
                targetCount: deliveredTargets.length,
                dispatchedDeviceIds,
                dispatchedConnectionKeys,
                environmentId,
                userId,
            });
        }, REQUEST_TIMEOUT_MS);

        pendingByRequestId.set(requestId, {
            resolve,
            timeout,
            requestId,
            pin,
            to: toList,
            message,
            analysis,
            socketErrors,
            dispatchedDeviceIds,
            dispatchedConnectionKeys: new Set(dispatchedConnectionKeys),
            environmentId,
            userId,
            respondedFailures: [],
            settled: false,
        });
    });

    const result = await resultPromise;
    const statusCode = result.success ? 200 : 502;

    res.status(statusCode).json({
        ok: result.success,
        ...result,
        statusUrl: result.statusUrl || buildStatusUrl(result.requestId),
        environmentId: result.environmentId || environmentId || null,
        analysis,
    });
}));

const heartbeatInterval = setInterval(() => {
    const now = Date.now();
    for (const device of getAllConnectedDevices()) {
        if (device.ws.readyState !== WebSocket.OPEN) {
            continue;
        }

        const lastPongAt = Number(device.lastPongAt || 0);
        if (lastPongAt > 0 && now - lastPongAt > HEARTBEAT_TIMEOUT_MS) {
            pushLog({
                type: 'device_heartbeat_timeout',
                pin: device.pin,
                deviceId: device.deviceId,
                staleMs: now - lastPongAt,
            });
            device.ws.terminate();
            continue;
        }

        try {
            device.ws.ping();
        } catch (error) {
            pushLog({
                type: 'device_ping_error',
                pin: device.pin,
                deviceId: device.deviceId,
                error: error.message,
            });
        }
    }
}, HEARTBEAT_INTERVAL_MS);

const runtimePruneInterval = setInterval(() => {
    pruneRuntimeLogs();
    pruneDatabaseLogsByRetention().catch((error) => {
        // eslint-disable-next-line no-console
        console.error('[puppy-sms-gateway-server] log_prune_error:', error.message);
    });
}, LOG_RETENTION_PRUNE_INTERVAL_MS);

const runtimeLogDbSyncInterval = setInterval(() => {
    syncRuntimeLogsToDatabase().catch((error) => {
        // eslint-disable-next-line no-console
        console.error('[puppy-sms-gateway-server] log_sync_error:', error.message);
    });
}, LOG_DB_SYNC_INTERVAL_MS);

wss.on('close', () => {
    clearInterval(heartbeatInterval);
    clearInterval(runtimePruneInterval);
    clearInterval(runtimeLogDbSyncInterval);
});

app.use((error, _req, res, _next) => {
    // eslint-disable-next-line no-console
    console.error('[puppy-sms-gateway-server] request_error:', error.message);
    if (!res.headersSent) {
        res.status(500).json({ ok: false, error: 'internal_server_error' });
    }
});

async function startServer() {
    await refreshLogRetentionDaysFromSettings();
    pruneRuntimeLogs();
    await pruneDatabaseLogsByRetention(logRetentionDays);
    await syncRuntimeLogsToDatabase();

    server.listen(PORT, HOST, () => {
        // eslint-disable-next-line no-console
        console.log(`[puppy-sms-gateway-server] listening on ${HOST}:${PORT}`);
    });
}

startServer().catch((error) => {
    // eslint-disable-next-line no-console
    console.error('[puppy-sms-gateway-server] startup_error:', error.message);
    process.exit(1);
});
