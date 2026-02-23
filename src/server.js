const http = require('http');
const path = require('path');
const crypto = require('crypto');

const express = require('express');
const cors = require('cors');
const dotenv = require('dotenv');
const { WebSocketServer, WebSocket } = require('ws');

dotenv.config();

const {
    registerUser,
    authenticateUser,
    createSessionForUser,
    getUserBySessionToken,
    revokeSessionToken,
    listEnvironmentsByUser,
    findEnvironmentByPin,
    createEnvironmentForUser,
    createApiKeyForEnvironment,
    listApiKeysForEnvironment,
    revokeApiKeyForEnvironment,
    resolveApiKeyContext,
    getPinsForUser,
} = require('./store');

const HOST = process.env.HOST || '0.0.0.0';
const PORT = Number(process.env.PORT || 8090);
const REQUEST_TIMEOUT_MS = Number(process.env.REQUEST_TIMEOUT_MS || 20000);
const MAX_LOG_ITEMS = Number(process.env.MAX_LOG_ITEMS || 200);
const HEARTBEAT_INTERVAL_MS = Number(process.env.HEARTBEAT_INTERVAL_MS || 15000);
const HEARTBEAT_TIMEOUT_MS = Number(process.env.HEARTBEAT_TIMEOUT_MS || 90000);

const app = express();
app.use(cors());
app.use(express.json({ limit: '1mb' }));
app.use(express.static(path.join(__dirname, '..', 'public')));

const server = http.createServer(app);
const wss = new WebSocketServer({ server });

const devicesByPin = new Map();
const pendingByRequestId = new Map();
const statusUpdatesByRequestId = new Map();
const gatewayLogs = [];

function nowIso() {
    return new Date().toISOString();
}

function asyncHandler(handler) {
    return (req, res, next) => {
        Promise.resolve(handler(req, res, next)).catch(next);
    };
}

function pushLog(entry) {
    gatewayLogs.unshift({ at: nowIso(), ...entry });
    if (gatewayLogs.length > MAX_LOG_ITEMS) {
        gatewayLogs.length = MAX_LOG_ITEMS;
    }
}

function pushStatusUpdate(update) {
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

function normalizeToList(to) {
    if (Array.isArray(to)) {
        return to.map((item) => String(item).trim()).filter(Boolean);
    }
    if (typeof to === 'string') {
        return to
            .split(',')
            .map((item) => item.trim())
            .filter(Boolean);
    }
    return [];
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

    const existing = devicesByPin.get(pin);
    if (existing && existing.ws !== ws && existing.ws.readyState === WebSocket.OPEN) {
        existing.ws.close(4002, 'replaced_by_new_connection');
    }

    const connectedAt = Date.now();
    const device = {
        ws,
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

    devicesByPin.set(pin, device);

    pushLog({
        type: 'device_connected',
        pin,
        deviceId,
        deviceName,
        ip: device.ip,
        environmentId: device.environmentId,
        userId: device.userId,
    });

    ws.send(
        JSON.stringify({
            type: 'registered',
            pin,
            deviceId,
            serverTime: nowIso(),
        })
    );

    ws.on('pong', () => {
        const current = devicesByPin.get(pin);
        if (current && current.ws === ws) {
            const now = Date.now();
            current.lastSeenAt = now;
            current.lastPongAt = now;
        }
    });

    ws.on('message', (raw) => {
        const data = safeJsonParse(raw.toString());
        const current = devicesByPin.get(pin);
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
            if (!pending) {
                return;
            }

            clearTimeout(pending.timeout);
            pendingByRequestId.delete(data.requestId);

            pushLog({
                type: data.success ? 'sms_sent' : 'sms_failed',
                requestId: data.requestId,
                pin,
                to: pending.to,
                message: pending.message,
                error: data.error || null,
                environmentId: pending.environmentId || current.environmentId,
                userId: pending.userId || current.userId,
            });

            pending.resolve({
                requestId: data.requestId,
                success: Boolean(data.success),
                pin,
                to: pending.to,
                message: pending.message,
                error: data.error || null,
                statusUrl: buildStatusUrl(data.requestId),
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
        const current = devicesByPin.get(pin);
        if (current && current.ws === ws) {
            devicesByPin.delete(pin);
            pushLog({
                type: 'device_disconnected',
                pin,
                deviceId,
                deviceName,
                environmentId: current.environmentId,
                userId: current.userId,
            });
        }
    });

    ws.on('error', (error) => {
        pushLog({
            type: 'device_error',
            pin,
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
        res.status(422).json({ ok: false, error: result.error });
        return;
    }

    res.status(201).json({
        ok: true,
        user: result.user,
        next: 'login_required',
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
        user: {
            id: authResult.user.id,
            name: authResult.user.name,
            email: authResult.user.email,
            createdAt: authResult.user.createdAt,
        },
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
        Array.from(devicesByPin.values()).filter((device) => pinsSet.has(String(device.pin || '')))
    );
    res.json({ ok: true, devices });
}));

app.get('/api/account/logs', requireAuth, asyncHandler(async (req, res) => {
    const pinsSet = await normalizeUserPins(req.auth.user.id);
    res.json({ ok: true, logs: filterLogsByPins(gatewayLogs, pinsSet) });
}));

app.get('/health', (_req, res) => {
    res.json({
        ok: true,
        service: 'puppy-sms-gateway-server',
        time: nowIso(),
        connectedDevices: devicesByPin.size,
        pendingRequests: pendingByRequestId.size,
        uptimeSec: Math.round(process.uptime()),
        authEnabled: true,
        environmentApiKeysOnly: true,
    });
});

app.get('/api/devices', asyncHandler(async (req, res) => {
    const auth = await getOptionalAuthUser(req);
    let devices = Array.from(devicesByPin.values());
    if (auth) {
        const pinsSet = await normalizeUserPins(auth.user.id);
        devices = devices.filter((device) => pinsSet.has(String(device.pin || '')));
    }

    res.json({ ok: true, devices: normalizeDevicesForResponse(devices) });
}));

app.get('/api/logs', asyncHandler(async (req, res) => {
    const auth = await getOptionalAuthUser(req);
    if (!auth) {
        res.json({ ok: true, logs: gatewayLogs });
        return;
    }

    const pinsSet = await normalizeUserPins(auth.user.id);
    res.json({ ok: true, logs: filterLogsByPins(gatewayLogs, pinsSet) });
}));

app.get('/api/status/:requestId', asyncHandler(async (req, res) => {
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
        res.status(422).json({
            ok: false,
            error: 'pin_mismatch_for_api_key',
            expectedPin: pin,
        });
        return;
    }

    const toList = normalizeToList(req.body?.to);
    const message = String(req.body?.message || '').trim();

    if (toList.length === 0 || !message) {
        res.status(422).json({
            ok: false,
            error: 'to_message_required',
            hint: 'Expected JSON body with to, message',
        });
        return;
    }

    const device = devicesByPin.get(pin);
    if (!device || device.ws.readyState !== WebSocket.OPEN) {
        pushLog({
            type: 'sms_not_sent_device_offline',
            pin,
            to: toList,
            message,
            environmentId,
            userId,
        });

        res.status(404).json({
            ok: false,
            error: 'device_not_connected',
            pin,
            environmentId,
        });
        return;
    }

    const requestId = crypto.randomUUID();

    const payload = {
        type: 'send_sms',
        requestId,
        to: toList,
        message,
    };

    try {
        device.ws.send(JSON.stringify(payload));
        pushLog({
            type: 'sms_dispatched',
            requestId,
            pin,
            to: toList,
            message,
            environmentId: device.environmentId || environmentId,
            userId: device.userId || userId,
        });
    } catch (error) {
        pushLog({
            type: 'sms_not_sent_socket_error',
            pin,
            to: toList,
            message,
            error: error.message,
            environmentId: device.environmentId || environmentId,
            userId: device.userId || userId,
        });

        res.status(500).json({
            ok: false,
            error: 'socket_send_failed',
            detail: error.message,
            environmentId: device.environmentId || environmentId,
        });
        return;
    }

    const resultPromise = new Promise((resolve) => {
        const timeout = setTimeout(() => {
            pendingByRequestId.delete(requestId);

            pushLog({
                type: 'sms_timeout',
                requestId,
                pin,
                to: toList,
                message,
                environmentId: device.environmentId || environmentId,
                userId: device.userId || userId,
            });

            resolve({
                requestId,
                success: false,
                pin,
                to: toList,
                message,
                error: 'device_response_timeout',
                statusUrl: buildStatusUrl(requestId),
                environmentId: device.environmentId || environmentId,
                userId: device.userId || userId,
            });
        }, REQUEST_TIMEOUT_MS);

        pendingByRequestId.set(requestId, {
            resolve,
            timeout,
            to: toList,
            message,
            environmentId: device.environmentId || environmentId,
            userId: device.userId || userId,
        });
    });

    const result = await resultPromise;
    const statusCode = result.success ? 200 : 502;

    res.status(statusCode).json({
        ok: result.success,
        ...result,
        statusUrl: result.statusUrl || buildStatusUrl(result.requestId),
        environmentId: result.environmentId || environmentId || device.environmentId || null,
    });
}));

const heartbeatInterval = setInterval(() => {
    const now = Date.now();
    for (const device of devicesByPin.values()) {
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

wss.on('close', () => {
    clearInterval(heartbeatInterval);
});

app.use((error, _req, res, _next) => {
    // eslint-disable-next-line no-console
    console.error('[puppy-sms-gateway-server] request_error:', error.message);
    if (!res.headersSent) {
        res.status(500).json({ ok: false, error: 'internal_server_error' });
    }
});

server.listen(PORT, HOST, () => {
    // eslint-disable-next-line no-console
    console.log(`[puppy-sms-gateway-server] listening on ${HOST}:${PORT}`);
});
