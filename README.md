# Puppy SMS Gateway Server

This server accepts WebSocket device connections from Android phones and exposes:
- account auth (`register/login`)
- per-account environments
- per-environment API keys
- SMS send/status APIs

Persistence is backed by MySQL with SQL migrations in `migrations/`.

## Features
- WebSocket device channel: `ws://<host>:8090/ws/device?pin=<environment-pin>&deviceId=...`
- Auth APIs: `/api/auth/register`, `/api/auth/login`, `/api/auth/me`, `/api/auth/logout`
- Environment APIs: `/api/environments`, `/api/environments/:environmentId/api-keys`
- SMS send API: `POST /api/send-sms` (auth via environment API key)
- Request status API: `GET /api/status/:requestId`
- Account-scoped device/log views: `/api/account/devices`, `/api/account/logs`
- Dashboard: `GET /` (global view; bearer token optionally scopes logs/devices)

## Requirements
- Node.js 18+ (or newer)
- npm
- MySQL 8+ (or compatible)

## Installation
```bash
git clone https://github.com/dilumsadeepa/DEV-SMS-Gateway.git
cd DEV-SMS-Gateway
cp .env.example .env
npm install
npm run migrate
npm start
```

Server default URL: `http://localhost:8090`

## MySQL Bootstrap (Example)
```sql
CREATE DATABASE puppy_sms_gateway CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
CREATE USER 'puppy_gateway'@'%' IDENTIFIED BY 'change_this_password';
GRANT ALL PRIVILEGES ON puppy_sms_gateway.* TO 'puppy_gateway'@'%';
FLUSH PRIVILEGES;
```

## Environment Variables
```dotenv
HOST=0.0.0.0
PORT=8090
MYSQL_HOST=127.0.0.1
MYSQL_PORT=3306
MYSQL_USER=root
MYSQL_PASSWORD=
MYSQL_DATABASE=puppy_sms_gateway
MYSQL_CONNECTION_LIMIT=10
SESSION_TTL_DAYS=30
REQUEST_TIMEOUT_MS=20000
MAX_LOG_ITEMS=200
HEARTBEAT_INTERVAL_MS=15000
HEARTBEAT_TIMEOUT_MS=90000
```

`npm start` also runs migrations automatically before starting the server.

## API
### Health
```bash
curl http://localhost:8090/health
```

### Register
```bash
curl -X POST http://localhost:8090/api/auth/register \
  -H 'Content-Type: application/json' \
  -d '{
    "name": "Alice",
    "email": "alice@example.com",
    "password": "StrongPass123"
  }'
```

Register only creates the user account.  
Login is required to get a bearer token for protected account APIs.

### Login
```bash
curl -X POST http://localhost:8090/api/auth/login \
  -H 'Content-Type: application/json' \
  -d '{
    "email": "alice@example.com",
    "password": "StrongPass123"
  }'
```

### Create Environment
```bash
curl -X POST http://localhost:8090/api/environments \
  -H "Authorization: Bearer <auth-token>" \
  -H 'Content-Type: application/json' \
  -d '{
    "name": "Production",
    "pin": "1234",
    "description": "Main phone",
    "metadata": { "region": "us" }
  }'
```

This returns a default environment API key (`apiKey`) for SMS sending.

### Create Additional Environment API Key
```bash
curl -X POST http://localhost:8090/api/environments/<environmentId>/api-keys \
  -H "Authorization: Bearer <auth-token>" \
  -H 'Content-Type: application/json' \
  -d '{ "name": "backend-service" }'
```

### Send SMS (Environment API Key)
```bash
curl -X POST http://localhost:8090/api/send-sms \
  -H 'Content-Type: application/json' \
  -H 'x-api-key: <environment-api-key>' \
  -d '{
    "to": "+14075551234",
    "message": "Hello from puppy-sms-gateway"
  }'
```

`to` can be a single string, comma-separated string, or array.  
Environment API key is mandatory.  
`pin` is optional and, when provided, must match the environment linked to the API key.

Response contains `requestId` and `statusUrl` for polling:

```json
{
  "ok": false,
  "requestId": "f281f7c4-ca5b-4f8d-b6c3-c3e2ce640d2a",
  "error": "device_response_timeout",
  "statusUrl": "/api/status/f281f7c4-ca5b-4f8d-b6c3-c3e2ce640d2a"
}
```

### Delivery Status
```bash
curl http://localhost:8090/api/status/<requestId> \
  -H "Authorization: Bearer <auth-token>"

curl http://localhost:8090/api/status/<requestId> \
  -H 'x-api-key: <environment-api-key>'
```

Returns lifecycle updates like `queued`, `sent_part_success`, `delivery_complete_success`, etc.

### Account-Scoped Devices and Logs
```bash
curl http://localhost:8090/api/account/devices \
  -H "Authorization: Bearer <auth-token>"

curl http://localhost:8090/api/account/logs \
  -H "Authorization: Bearer <auth-token>"
```

## Notes
- Keep environment API keys private.
- If multiple phones connect with the same PIN, the latest connection replaces the previous one.
- The server waits for device delivery ack until `REQUEST_TIMEOUT_MS`.
- Only registered environment PINs are accepted for device websocket connections.
