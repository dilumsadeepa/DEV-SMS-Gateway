# Puppy SMS Gateway Server

Puppy SMS Gateway Server accepts Android device WebSocket connections and provides:
- multi-user SMS gateway access
- environment-scoped API keys
- role-based management (`super_admin`, `admin`, `user`)
- super admin dashboard controls

Persistence is backed by MySQL and SQL migrations in `migrations/`.

## Role Model
- `super_admin`
  - full platform access
  - can enable/disable public registration
  - can create/update `admin` and `user` accounts
  - can manage all users/devices/logs/resources
- `admin`
  - can create and manage `user` accounts
  - can view platform-wide users/devices/logs/resources (role-limited)
- `user`
  - can manage own environments and API keys
  - can send SMS using environment API keys

## Features
- Device WebSocket channel: `ws://<host>:8090/ws/device?pin=<environment-pin>&deviceId=...`
- Environment APIs: `/api/environments`, `/api/environments/:environmentId/api-keys`
- SMS send API: `POST /api/send-sms` (environment API key required)
- Delivery status API: `GET /api/status/:requestId`
- Account views: `/api/account/devices`, `/api/account/logs`
- Admin APIs:
  - `/api/admin/summary`
  - `/api/admin/settings`
  - `/api/admin/settings/registration`
  - `/api/admin/users`
  - `/api/admin/devices`
  - `/api/admin/logs`
- Public bootstrap APIs:
  - `/api/public/bootstrap-status`
  - `/api/public/bootstrap-super-admin`
- UI:
  - Landing page: `GET /`
    - if no super admin: shows **Get Started** flow
    - if super admin exists: shows **Login/Register** buttons
  - Dashboard app: `GET /dashboard`
    - account workspace (environments/keys/sms)
    - super admin/admin management console

## Setup
```bash
cd /home/ilabs-dilum/Projects/smsGateway/puppy-sms-gateway-server
cp .env.example .env
npm install
npm run migrate
npm start
```

`npm start` also runs migrations automatically.

After start:
1. Open `http://localhost:8090/`
2. If no super admin exists, click **Get Started** and create first super admin
3. You will be redirected to dashboard automatically

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

## API Examples

### Health
```bash
curl http://localhost:8090/health
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

Response includes default `apiKey` for the environment.

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

`pin` is optional and, if provided, must match the API key environment.

### Status Polling
```bash
curl http://localhost:8090/api/status/<requestId> \
  -H "Authorization: Bearer <auth-token>"

curl http://localhost:8090/api/status/<requestId> \
  -H 'x-api-key: <environment-api-key>'
```

### Super Admin Toggle Registration
```bash
curl -X PATCH http://localhost:8090/api/admin/settings/registration \
  -H "Authorization: Bearer <super-admin-token>" \
  -H 'Content-Type: application/json' \
  -d '{ "enabled": false }'
```

### Admin/Super Admin Create User
```bash
curl -X POST http://localhost:8090/api/admin/users \
  -H "Authorization: Bearer <admin-or-super-admin-token>" \
  -H 'Content-Type: application/json' \
  -d '{
    "name": "Operator",
    "email": "operator@example.com",
    "password": "StrongPass123",
    "role": "user",
    "isActive": true
  }'
```

## Auth Endpoints
Login/register endpoints exist and are used by the dashboard, but direct request examples are intentionally omitted from this README.

## Notes
- Keep environment API keys private.
- If multiple phones connect with the same PIN, the latest connection replaces the previous one.
- Only registered environment PINs are accepted for device WebSocket connections.
- First account can bootstrap as `super_admin` when no super admin exists.
