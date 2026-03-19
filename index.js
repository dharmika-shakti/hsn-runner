/**
 * HSN Runner – minimal HTTP server that runs hsn-details.js when requested.
 * Deploy this as a Node.js app on Hostinger (or any host) so "node" is in PATH.
 * Laravel POSTs here instead of spawning Node locally; no NODE_PATH needed in PHP.
 *
 * Start: node hsn-runner.js
 * Port: HSN_RUNNER_PORT or 3070
 * POST /run-hsn with JSON: { profile_id, gstin, callback_url, callback_token?, gst_search_url? }
 */

const http = require('http');
const { spawn } = require('child_process');
const { join } = require('path');

const PORT = parseInt(process.env.HSN_RUNNER_PORT || '3070', 10);
const SCRIPT_PATH = join(__dirname, 'hsn-details.js');

function parseBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch (e) {
        reject(e);
      }
    });
    req.on('error', reject);
  });
}

function respond(res, statusCode, data) {
  res.writeHead(statusCode, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
}

const server = http.createServer(async (req, res) => {
  if (req.method === 'GET' && (req.url === '/' || req.url === '/health')) {
    return respond(res, 200, { ok: true, service: 'hsn-runner' });
  }

  if (req.method !== 'POST' || (req.url !== '/run-hsn' && req.url !== '/')) {
    res.writeHead(404);
    return res.end();
  }

  let payload;
  try {
    payload = await parseBody(req);
  } catch (e) {
    return respond(res, 400, { error: 'Invalid JSON body' });
  }

  const { profile_id, gstin, callback_url, callback_token, gst_search_url } = payload;
  if (!gstin) {
    return respond(res, 400, { error: 'Missing gstin in body' });
  }

  const env = {
    ...process.env,
    DISPLAY: process.env.DISPLAY || ':99',
    PROFILE_ID: String(profile_id || ''),
    HSN_CALLBACK_URL: callback_url || process.env.HSN_CALLBACK_URL || '',
    HSN_CALLBACK_TOKEN: callback_token || process.env.HSN_CALLBACK_TOKEN || '',
    GST_SEARCH_URL: gst_search_url || process.env.GST_SEARCH_URL || 'https://services.gst.gov.in/services/searchtp',
    HSN_HEADLESS: '0',
    HSN_LOG_FILE: process.env.HSN_LOG_FILE || '/tmp/hsn-' + gstin + '.log',
  };

  const child = spawn('node', [SCRIPT_PATH, gstin], {
    env,
    cwd: __dirname,
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  // Capture any error output
  child.stdout?.on('data', (data) => {
    console.log(`[${gstin}] ${data}`);
  });
  
  child.stderr?.on('data', (data) => {
    console.error(`[${gstin}] ${data}`);
  });

  child.unref();

  respond(res, 202, {
    status: 'started',
    message: 'HSN capture started on runner.',
    profile_id: profile_id || null,
    gstin,
  });
});

server.listen(PORT, () => {
  console.log(`HSN runner listening on port ${PORT}`);
});
