const fs = require('fs');
const WebSocket = require('ws');

const port = fs.readFileSync('/tmp/psg_itest_port', 'utf8').trim();
const baseUrl = `http://127.0.0.1:${port}`;

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

async function request(method, urlPath, { headers = {}, body } = {}) {
  const response = await fetch(`${baseUrl}${urlPath}`, {
    method,
    headers: {
      ...headers,
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });

  const json = await response.json().catch(() => ({}));
  return { status: response.status, json };
}

async function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function run() {
  const results = [];

  const statusResp = await request('GET', '/api/public/bootstrap-status');
  assert(statusResp.status === 200 && statusResp.json.ok === true, 'bootstrap-status failed');
  results.push(`bootstrap-status: hasSuperAdmin=${statusResp.json.hasSuperAdmin}`);

  assert(statusResp.json.hasSuperAdmin === false, 'isolated DB should start without super admin');

  const unique = Date.now();
  const adminEmail = `itest-superadmin-${unique}@example.com`;
  const adminPassword = 'StrongPass123!';

  const bootstrapResp = await request('POST', '/api/public/bootstrap-super-admin', {
    body: {
      name: 'ITest Super Admin',
      email: adminEmail,
      password: adminPassword,
    },
  });

  assert(bootstrapResp.status === 201 && bootstrapResp.json.ok === true, 'bootstrap-super-admin failed');
  const token = bootstrapResp.json.token;
  assert(token, 'missing auth token after bootstrap');
  results.push('bootstrap-super-admin: created + logged in');

  const pin = String(930000 + Math.floor(Math.random() * 999));
  const envResp = await request('POST', '/api/environments', {
    headers: { Authorization: `Bearer ${token}` },
    body: {
      name: 'ITest Environment',
      pin,
      description: 'integration test env',
    },
  });

  assert(envResp.status === 201 && envResp.json.ok === true, 'create environment failed');
  const apiKey = envResp.json.apiKey;
  assert(apiKey, 'missing environment apiKey');
  results.push(`environment created: pin=${pin}`);

  const wsUrl = `ws://127.0.0.1:${port}/ws/device?pin=${encodeURIComponent(pin)}&deviceId=itest-device&deviceName=NodeSim`;
  const ws = new WebSocket(wsUrl);

  let registered = false;
  const observedSendRequests = [];

  ws.on('message', (raw) => {
    let payload = null;
    try {
      payload = JSON.parse(raw.toString());
    } catch {
      return;
    }

    if (payload.type === 'registered') {
      registered = true;
      return;
    }

    if (payload.type === 'send_sms' && payload.requestId) {
      observedSendRequests.push(payload.requestId);

      const firstRecipient = Array.isArray(payload.to) && payload.to.length > 0 ? String(payload.to[0]) : null;

      ws.send(JSON.stringify({
        type: 'sms_status',
        requestId: payload.requestId,
        status: 'sent',
        recipient: firstRecipient,
        to: firstRecipient,
        timestamp: new Date().toISOString(),
      }));

      ws.send(JSON.stringify({
        type: 'sms_result',
        requestId: payload.requestId,
        success: true,
      }));
    }
  });

  const wsOpen = new Promise((resolve, reject) => {
    ws.on('open', resolve);
    ws.on('error', reject);
  });

  await wsOpen;

  for (let i = 0; i < 50; i += 1) {
    if (registered) {
      break;
    }
    await wait(50);
  }
  assert(registered, 'device websocket did not register');
  results.push('device websocket connected + registered');

  const analysisCases = [
    {
      label: 'gsm-basic',
      to: '+14155552671',
      message: 'Hello GSM test',
      expectEncoding: 'GSM-7',
      expectUnicode: false,
    },
    {
      label: 'gsm-extension',
      to: '+14155552672',
      message: 'Use braces { } and euro €',
      expectEncoding: 'GSM-7',
      expectUnicode: false,
      expectExtension: true,
    },
    {
      label: 'unicode',
      to: '+14155552673',
      message: 'Hello emoji 😊',
      expectEncoding: 'UCS-2',
      expectUnicode: true,
      expectUnsupported: true,
    },
  ];

  for (const testCase of analysisCases) {
    const analyzeResp = await request('POST', '/api/sms/analyze', {
      headers: { Authorization: `Bearer ${token}` },
      body: {
        to: testCase.to,
        message: testCase.message,
      },
    });

    assert(analyzeResp.status === 200 && analyzeResp.json.ok === true, `analyze failed for ${testCase.label}`);

    const analysis = analyzeResp.json.analysis;
    assert(analysis?.message?.encoding === testCase.expectEncoding, `wrong encoding for ${testCase.label}`);
    assert(Boolean(analysis?.message?.unicodeDetected) === testCase.expectUnicode, `wrong unicode flag for ${testCase.label}`);

    if (testCase.expectExtension) {
      assert((analysis?.message?.extensionCharacters || []).length > 0, `missing extension chars for ${testCase.label}`);
    }

    if (testCase.expectUnsupported) {
      assert((analysis?.message?.unsupportedCharacters || []).length > 0, `missing unsupported chars for ${testCase.label}`);
    }

    results.push(`analysis ${testCase.label}: ok`);
  }

  const invalidRecipientResp = await request('POST', '/api/send-sms', {
    headers: { 'x-api-key': apiKey },
    body: {
      to: '0771234567',
      message: 'Invalid number test',
    },
  });

  assert(invalidRecipientResp.status === 422, 'invalid recipient should return 422');
  assert(invalidRecipientResp.json.error === 'invalid_recipients_e164', 'invalid recipient should return invalid_recipients_e164');
  results.push('invalid recipient validation: ok (422)');

  const sendCases = [
    { to: '+14155552671', message: 'End-to-end SMS 1' },
    { to: '+14155552672,+14155552673', message: 'End-to-end SMS 2 with two recipients' },
    { to: '+447700900123', message: 'Unicode send 😊 check' },
  ];

  const sentRequestIds = [];

  for (const sendCase of sendCases) {
    const sendResp = await request('POST', '/api/send-sms', {
      headers: { 'x-api-key': apiKey },
      body: sendCase,
    });

    assert(sendResp.status === 200, `send-sms failed with status ${sendResp.status}`);
    assert(sendResp.json.ok === true && sendResp.json.success === true, 'send-sms response not successful');
    assert(sendResp.json.requestId, 'send-sms missing requestId');
    assert(sendResp.json.analysis, 'send-sms missing analysis payload');

    sentRequestIds.push(sendResp.json.requestId);
    results.push(`send-sms success: requestId=${sendResp.json.requestId}`);
  }

  assert(observedSendRequests.length >= sendCases.length, 'device did not receive expected send_sms requests');

  for (const requestId of sentRequestIds) {
    const statusLookup = await request('GET', `/api/status/${encodeURIComponent(requestId)}`, {
      headers: { Authorization: `Bearer ${token}` },
    });

    assert(statusLookup.status === 200 && statusLookup.json.ok === true, `status lookup failed for ${requestId}`);
    assert(Array.isArray(statusLookup.json.updates), 'status updates missing array');
    assert(statusLookup.json.updates.length >= 1, `status updates missing entries for ${requestId}`);
  }
  results.push('status lookup checks: ok');

  const accountLogsResp = await request('GET', '/api/account/logs', {
    headers: { Authorization: `Bearer ${token}` },
  });
  assert(accountLogsResp.status === 200 && accountLogsResp.json.ok === true, 'account logs fetch failed');
  assert(Array.isArray(accountLogsResp.json.logs), 'account logs not array');
  assert(accountLogsResp.json.logs.length > 0, 'expected account logs after sends');
  results.push(`account logs fetched: count=${accountLogsResp.json.logs.length}`);

  const saveLogsResp = await request('POST', '/api/account/logs/save', {
    headers: { Authorization: `Bearer ${token}` },
  });
  assert(saveLogsResp.status === 200 && saveLogsResp.json.ok === true, 'save account logs failed');
  results.push(`save logs to db: scanned=${saveLogsResp.json.summary.scanned} inserted=${saveLogsResp.json.summary.inserted}`);

  ws.close();

  console.log('INTEGRATION TEST PASSED');
  for (const line of results) {
    console.log(`- ${line}`);
  }
}

run().catch((error) => {
  console.error('INTEGRATION TEST FAILED');
  console.error(error.stack || error.message || String(error));
  process.exit(1);
});
