/**
 * Real-browser smoke test (no dependencies, uses Node's built-in WebSocket).
 * Loads the built extension into headless Chrome, opens the popup, and proves:
 *   1. The MV3 service worker boots.
 *   2. The popup UI renders real runtime data (React + messaging + Ollama).
 *   3. A typed request round-trips through chrome.runtime.sendMessage.
 *   4. No page exceptions / console errors.
 *
 * Requires: npm run build, Google Chrome installed. Ollama running is a bonus
 * (the test asserts reachability only when the server answers).
 */
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const root = join(import.meta.dirname, '..');
const outDir = join(root, '.output', 'chrome-mv3');
const chromeCandidates = [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  `${process.env.LOCALAPPDATA}/Google/Chrome/Application/chrome.exe`,
];
const chromePath = chromeCandidates.find((p) => existsSync(p));
if (!chromePath) {
  console.error('Chrome not found; cannot run browser smoke test.');
  process.exit(1);
}
if (!existsSync(join(outDir, 'manifest.json'))) {
  console.error('Build output missing. Run "npm run build" first.');
  process.exit(1);
}

// Random port per run: avoids TIME_WAIT collisions from previous runs on Windows.
const PORT = 9500 + Math.floor(Math.random() * 400);
const userDataDir = mkdtempSync(join(tmpdir(), 'videoking-smoke-'));
let failures = 0;
let checks = 0;
function check(name, cond, detail) {
  checks++;
  if (cond) console.log(`  ok  ${name}`);
  else {
    failures++;
    console.error(`FAIL  ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

const chrome = spawn(
  chromePath,
  [
    '--headless=new',
    `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${userDataDir}`,
    // No --load-extension/--disable-extensions-except: branded Chrome >= 137
    // ignores the former, and the latter would disable CDP-loaded extensions.
    // Loading happens via Extensions.loadUnpacked below.
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-gpu',
    'about:blank',
  ],
  { stdio: 'ignore' },
);

const killChrome = () => {
  try {
    spawnSync('taskkill', ['/pid', String(chrome.pid), '/t', '/f'], {
      stdio: 'ignore',
    });
  } catch {
    chrome.kill();
  }
};

const watchdog = setTimeout(() => {
  console.error('Smoke test timed out after 240s');
  killChrome();
  process.exit(1);
}, 240_000);

async function listTargets() {
  const res = await fetch(`http://127.0.0.1:${PORT}/json/list`);
  return res.json();
}

let fetchErrorLogged = false;
async function listTargetsDiag() {
  try {
    return await listTargets();
  } catch (err) {
    if (!fetchErrorLogged) {
      fetchErrorLogged = true;
      console.log(`  ..  fetch error: ${err.message} (chrome pid=${chrome.pid}, port=${PORT})`);
    }
    return undefined;
  }
}

function cdpConnect(wsUrl) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    let nextId = 1;
    const pending = new Map();
    const events = [];
    ws.onmessage = (ev) => {
      const msg = JSON.parse(String(ev.data));
      if (msg.id && pending.has(msg.id)) {
        const { res, rej } = pending.get(msg.id);
        pending.delete(msg.id);
        if (msg.error) rej(new Error(msg.error.message));
        else res(msg.result);
      } else if (msg.method) {
        events.push(msg);
      }
    };
    ws.onerror = () => reject(new Error('CDP WebSocket error'));
    ws.onopen = () =>
      resolve({
        events,
        send(method, params = {}) {
          return new Promise((res, rej) => {
            const id = nextId++;
            pending.set(id, { res, rej });
            ws.send(JSON.stringify({ id, method, params }));
          });
        },
        close: () => ws.close(),
      });
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Branded Chrome >= 137 ignores --load-extension. Load via the CDP Extensions
 * domain instead (works on branded builds; the flag stays as a fallback for
 * Chrome for Testing / Chromium).
 */
async function loadExtensionViaCdp() {
  const version = await fetch(`http://127.0.0.1:${PORT}/json/version`).then((r) => r.json());
  const browser = await cdpConnect(version.webSocketDebuggerUrl);
  try {
    const result = await browser.send('Extensions.loadUnpacked', {
      // Forward slashes required: backslash paths load a broken extension.
      path: outDir.replaceAll('\\', '/'),
    });
    console.log(`  ..  Extensions.loadUnpacked -> id=${result?.id ?? 'unknown'}`);
    return result?.id;
  } catch (err) {
    console.log(`  ..  Extensions.loadUnpacked unavailable: ${err.message}`);
    return undefined;
  } finally {
    browser.close();
  }
}

try {
  // 0. Wait for DevTools, then ensure the extension is loaded.
  let loadedId;
  for (let i = 0; i < 30; i++) {
    const targets = await listTargetsDiag();
    if (Array.isArray(targets)) {
      loadedId = await loadExtensionViaCdp().catch(() => undefined);
      break;
    }
    await sleep(500);
  }

  // 1. Open the popup directly with the loaded extension id. Opening an
  // extension page wakes its MV3 service worker (the port keeps it alive).
  let extId = loadedId;
  if (!extId) {
    // Fallback: discover by manifest name among running SW targets.
    for (let i = 0; i < 20 && !extId; i++) {
      const targets = (await listTargetsDiag()) ?? [];
      for (const candidate of targets.filter(
        (t) => t.type === 'service_worker' && t.url.startsWith('chrome-extension://'),
      )) {
        const conn = await cdpConnect(candidate.webSocketDebuggerUrl).catch(() => undefined);
        if (!conn) continue;
        const nameResult = await conn
          .send('Runtime.evaluate', {
            expression: 'chrome.runtime.getManifest().name',
            returnByValue: true,
          })
          .catch(() => undefined);
        if (nameResult?.result?.value === 'videoKING AI') {
          extId = new URL(candidate.url).host;
          conn.close();
          break;
        }
        conn.close();
      }
      if (!extId) await sleep(500);
    }
  }
  check('extension loaded into Chrome', Boolean(extId));
  if (!extId) throw new Error('videoKING extension not loaded');

  const newTab = await fetch(
    `http://127.0.0.1:${PORT}/json/new?chrome-extension://${extId}/popup.html`,
    { method: 'PUT' },
  ).then((r) => r.json());
  const page = await cdpConnect(newTab.webSocketDebuggerUrl);
  await page.send('Runtime.enable');
  await page.send('Log.enable');

  // Wait until the extension page actually committed (not about:blank or an
  // error page), then give React + the status RPC time to render.
  let pageHref = '';
  for (let i = 0; i < 20; i++) {
    const loc = await page.send('Runtime.evaluate', {
      expression: 'location.href',
      returnByValue: true,
    });
    pageHref = String(loc.result?.value ?? '');
    if (pageHref.startsWith('chrome-extension://')) break;
    await sleep(500);
  }
  await sleep(5000);

  // 2. The popup must render real runtime data.
  const pageUrl = await page.send('Runtime.evaluate', {
    expression: 'location.href',
    returnByValue: true,
  });
  check(
    'popup page loaded (not an error page)',
    String(pageUrl.result?.value ?? '').startsWith('chrome-extension://'),
    String(pageUrl.result?.value ?? ''),
  );
  const text = await page.send('Runtime.evaluate', {
    expression: 'document.body.innerText',
    returnByValue: true,
  });
  const body = String(text.result?.value ?? '');
  check('popup renders app title', body.includes('videoKING AI'));
  check('popup lists installed models', body.includes('qwen2.5:1.5b'));
  check(
    'popup shows runtime connection state',
    body.includes('Connected') || body.includes('Not reachable'),
  );
  if (body.includes('Connected')) {
    console.log('  ..  Ollama reachable from inside the extension (live)');
  }

  // 3. Real typed RPC round-trip from the page through the SW to Ollama.
  const rpc = await page.send('Runtime.evaluate', {
    expression: `chrome.runtime.sendMessage({kind:'videoking/request',id:'smoke_1',type:'runtime/testConnection',payload:undefined})`,
    awaitPromise: true,
    returnByValue: true,
  });
  const rpcValue = rpc.result?.value;
  check('RPC envelope answered', rpcValue && rpcValue.ok === true, JSON.stringify(rpc.result));
  if (rpcValue?.ok) {
    check('testConnection reports Ollama version', typeof rpcValue.data?.version === 'string');
    console.log(`  ..  live version=${rpcValue.data.version} models=${rpcValue.data.modelCount} latency=${rpcValue.data.latencyMs}ms`);
  }

  // 4. Queue endpoint works too (empty queue is a valid real answer).
  const queueRpc = await page.send('Runtime.evaluate', {
    expression: `chrome.runtime.sendMessage({kind:'videoking/request',id:'smoke_2',type:'queue/list',payload:undefined})`,
    awaitPromise: true,
    returnByValue: true,
  });
  check('queue/list round-trip', queueRpc.result?.value?.ok === true);

  // 4b. Full task lifecycle in the real worker: enqueue a model test, watch it
  // run sequentially to success, and read the real model reply from the result.
  const enqueueRpc = await page.send('Runtime.evaluate', {
    expression: `chrome.runtime.sendMessage({kind:'videoking/request',id:'smoke_3',type:'runtime/testModel',payload:{model:'qwen2.5:1.5b'}})`,
    awaitPromise: true,
    returnByValue: true,
  });
  const taskId = enqueueRpc.result?.value?.data?.taskId;
  check('model-test task enqueued', typeof taskId === 'string', JSON.stringify(enqueueRpc.result));
  if (typeof taskId === 'string') {
    let finalTask;
    for (let i = 0; i < 180; i++) {
      const q = await page.send('Runtime.evaluate', {
        expression: `chrome.runtime.sendMessage({kind:'videoking/request',id:'smoke_poll',type:'queue/list',payload:undefined})`,
        awaitPromise: true,
        returnByValue: true,
      });
      const tasks = q.result?.value?.data ?? [];
      finalTask = tasks.find((t) => t.id === taskId);
      if (finalTask && ['succeeded', 'failed', 'cancelled'].includes(finalTask.status)) break;
      await sleep(1000);
    }
    check('model-test task succeeded in real worker', finalTask?.status === 'succeeded', JSON.stringify(finalTask?.error ?? finalTask?.status));
    check('model-test result contains a real reply', typeof finalTask?.result?.reply === 'string' && finalTask.result.reply.length > 0, JSON.stringify(finalTask?.result));
    if (finalTask?.status === 'succeeded') {
      console.log(`  ..  task lifecycle OK: reply="${finalTask.result.reply}" attempts=${finalTask.attempts}`);
    }
  }

  // 5. Service worker is awake now (port connected) — verify its identity.
  const targetsNow = (await listTargetsDiag()) ?? [];
  const swTarget = targetsNow.find(
    (t) => t.type === 'service_worker' && t.url.includes(extId),
  );
  check('extension service worker running', Boolean(swTarget));
  let sw;
  if (swTarget) {
    sw = await cdpConnect(swTarget.webSocketDebuggerUrl);
    const manifestName = await sw.send('Runtime.evaluate', {
      expression: 'chrome.runtime.getManifest().name',
      returnByValue: true,
    });
    check('SW manifest name', manifestName.result?.value === 'videoKING AI');
  }

  // 6. YouTube workflow (phase 2): content script answers on a real watch
  // page; consent gate enforced in the real worker; capture returns either a
  // real transcript or an honest typed unavailability (YouTube degrades
  // automated sessions — both outcomes are correct behavior).
  if (sw) {
    // Pre-set YouTube consent cookie (EU) so the watch page is not redirected.
    await page.send('Network.enable');
    await page.send('Network.setCookie', {
      name: 'SOCS',
      value: 'CAISNQgDEitib3FfaWRlbnRpdHlmcm9udGVuZHVpc2VydmVyXzIwMjMwODI5LjA3X3AxGgJlbiACGgYIgLC_pwY',
      domain: '.youtube.com',
      path: '/',
    });
    const ytTab = await fetch(
      `http://127.0.0.1:${PORT}/json/new?https://www.youtube.com/watch?v=jNQXAC9IVRw&hl=en`,
      { method: 'PUT' },
    ).then((r) => r.json());
    await sleep(10000);

    // No "tabs" permission by design: query without url filter, then ask each
    // tab — only the YouTube content script answers page/videoInfo.
    const infoRpc = await sw.send('Runtime.evaluate', {
      expression: `(async () => {
        const tabs = await chrome.tabs.query({});
        for (const tab of tabs) {
          if (tab.id === undefined) continue;
          try {
            const info = await chrome.tabs.sendMessage(tab.id, { kind: 'videoking/page-request', type: 'page/videoInfo', payload: undefined });
            if (info && info.isVideoPage) return { found: true, tabId: tab.id, info };
          } catch { /* not a YouTube tab */ }
        }
        return { found: false };
      })()`,
      awaitPromise: true,
      returnByValue: true,
    });
    const infoValue = infoRpc.result?.value;
    check('content script answers on YouTube', infoValue?.found === true && infoValue?.info?.isVideoPage === true, JSON.stringify(infoValue)?.slice(0, 200));
    check('real video metadata extracted', infoValue?.info?.video?.videoId === 'jNQXAC9IVRw', JSON.stringify(infoValue?.info?.video)?.slice(0, 200));

    // Capture WITHOUT consent must be refused (fail-closed) in the real worker.
    const noConsent = await page.send('Runtime.evaluate', {
      expression: `chrome.runtime.sendMessage({kind:'videoking/request',id:'smoke_nc',type:'youtube/capture',payload:{tabId:${infoValue?.tabId ?? 0}}})`,
      awaitPromise: true,
      returnByValue: true,
    });
    check('capture refused without consent', noConsent.result?.value?.ok === false && noConsent.result?.value?.error?.code === 'CONSENT_REQUIRED', JSON.stringify(noConsent.result?.value)?.slice(0, 200));

    // Grant consent, then capture.
    await page.send('Runtime.evaluate', {
      expression: `chrome.runtime.sendMessage({kind:'videoking/request',id:'smoke_grant',type:'consent/grant',payload:{scope:'youtubeCaptions'}})`,
      awaitPromise: true,
      returnByValue: true,
    });
    const captureRpc = await page.send('Runtime.evaluate', {
      expression: `chrome.runtime.sendMessage({kind:'videoking/request',id:'smoke_cap',type:'youtube/capture',payload:{tabId:${infoValue?.tabId ?? 0}}})`,
      awaitPromise: true,
      returnByValue: true,
    });
    const captureValue = captureRpc.result?.value;
    const capturedOk = captureValue?.ok === true && captureValue?.data?.record?.segmentCount > 0;
    const honestFail = captureValue?.ok === false && captureValue?.error?.code === 'CAPTURE_UNAVAILABLE';
    check('capture returns real transcript OR honest typed unavailability', capturedOk || honestFail, JSON.stringify(captureValue)?.slice(0, 250));
    if (capturedOk) {
      console.log(`  ..  LIVE CAPTURE: ${captureValue.data.record.segmentCount} segments stored (${captureValue.data.record.id})`);
      const libraryRpc = await page.send('Runtime.evaluate', {
        expression: `chrome.runtime.sendMessage({kind:'videoking/request',id:'smoke_lib',type:'videos/list',payload:undefined})`,
        awaitPromise: true,
        returnByValue: true,
      });
      check('captured video visible in library', (libraryRpc.result?.value?.data ?? []).some((v) => v.id === captureValue.data.record.id));
    } else {
      console.log('  ..  YouTube limited this automated session (expected headless); typed unavailability surfaced honestly. Manual verification: docs/reports/PHASE-2.md');
    }

    // Revoke consent → capture must be refused again.
    await page.send('Runtime.evaluate', {
      expression: `chrome.runtime.sendMessage({kind:'videoking/request',id:'smoke_revoke',type:'consent/revoke',payload:{scope:'youtubeCaptions'}})`,
      awaitPromise: true,
      returnByValue: true,
    });
    const afterRevoke = await page.send('Runtime.evaluate', {
      expression: `chrome.runtime.sendMessage({kind:'videoking/request',id:'smoke_nc2',type:'youtube/capture',payload:{tabId:${infoValue?.tabId ?? 0}}})`,
      awaitPromise: true,
      returnByValue: true,
    });
    check('revoking consent stops capture', afterRevoke.result?.value?.ok === false && afterRevoke.result?.value?.error?.code === 'CONSENT_REQUIRED');

    // Close the YouTube tab to free memory.
    await fetch(`http://127.0.0.1:${PORT}/json/close/${ytTab.id}`).catch(() => {});
    sw.close();
  }

  // 7. No page exceptions or console errors (favicon noise filtered).
  const exceptions = page.events.filter((e) => e.method === 'Runtime.exceptionThrown');
  const consoleErrors = page.events.filter(
    (e) =>
      e.method === 'Log.entryAdded' &&
      e.params.entry.level === 'error' &&
      !/favicon/i.test(e.params.entry.text ?? ''),
  );
  check('no page exceptions', exceptions.length === 0, JSON.stringify(exceptions[0]?.params ?? ''));
  check('no console errors', consoleErrors.length === 0, JSON.stringify(consoleErrors[0]?.params ?? ''));

  page.close();
} catch (err) {
  failures++;
  console.error('Smoke test error:', err.message);
} finally {
  clearTimeout(watchdog);
  killChrome();
  try {
    rmSync(userDataDir, { recursive: true, force: true });
  } catch {
    // Temp cleanup is best-effort on Windows (files may be locked briefly).
  }
}

console.log(`\n${checks - failures}/${checks} browser checks passed`);
process.exit(failures > 0 ? 1 : 0);
