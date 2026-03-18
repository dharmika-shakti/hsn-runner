import { exec } from 'child_process';
import { promisify } from 'util';
import { writeFileSync, unlinkSync, appendFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

const execAsync = promisify(exec);

const HSN_LOG_FILE = (process.env.HSN_LOG_FILE || '').trim();
// Ensure Puppeteer uses a cache dir that exists in common deploy targets (e.g. Render).
// This must be set before importing puppeteer, so we import puppeteer dynamically in main().
process.env.PUPPETEER_CACHE_DIR =
  process.env.PUPPETEER_CACHE_DIR || join(process.cwd(), '.cache', 'puppeteer');

/** Log a stage message with timestamp; writes to console and optionally to HSN_LOG_FILE for PHP to fetch */
function logStage(stage, message, isError = false) {
  const ts = new Date().toISOString();
  const line = `[${ts}] [${stage}] ${message}`;
  if (isError) {
    console.error(line);
  } else {
    console.log(line);
  }
  if (HSN_LOG_FILE) {
    try {
      appendFileSync(HSN_LOG_FILE, line + '\n', 'utf8');
    } catch (e) {
      try { console.error('[LOG_FILE] Failed to write:', e.message); } catch {}
    }
  }
}

const GST_SEARCH_URL = process.env.GST_SEARCH_URL || 'https://services.gst.gov.in/services/searchtp';
const HEADER_OVERRIDE = (process.env.HEADER_OVERRIDE || '').trim().toLowerCase(); // optional alternative heading text
const HSN_TABLE_SELECTOR = (process.env.HSN_TABLE_SELECTOR || '').trim();
const HSN_TABLE_INDEX_OVERRIDE = Number.isFinite(parseInt(process.env.HSN_TABLE_INDEX_OVERRIDE || '', 10))
  ? parseInt(process.env.HSN_TABLE_INDEX_OVERRIDE || '', 10)
  : null;
const HSN_CALLBACK_URL = process.env.HSN_CALLBACK_URL || '';
const HSN_CALLBACK_TOKEN = process.env.HSN_CALLBACK_TOKEN || '';
const PROFILE_ID = process.env.PROFILE_ID || '';
const MANUAL_CAPTCHA = true;

// On server (no display), must use headless or Chrome won't launch.
// HSN_HEADLESS=1 or true forces headless; unset on Windows allows visible browser.
const forceHeadless = (v) => /^(1|true|yes)$/i.test(String(v || '').trim());
const hasDisplay = process.platform === 'win32' || (process.env.DISPLAY && process.env.DISPLAY.length > 0);
const RUN_HEADLESS = forceHeadless(process.env.HSN_HEADLESS) || (!hasDisplay && process.platform !== 'win32');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Windows-specific function to focus browser window by process ID
async function focusBrowserWindow(pid) {
  if (process.platform !== 'win32') {
    return; // Only works on Windows
  }
  let tempFile = null;
  try {
    // Create temporary PowerShell script file to avoid quote escaping issues
    tempFile = join(tmpdir(), `focus-browser-${pid}-${Date.now()}.ps1`);
    const psScript = `Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public class Win32 {
  [DllImport("user32.dll")]
  public static extern bool ShowWindowAsync(IntPtr hWnd, int nCmdShow);
  [DllImport("user32.dll")]
  public static extern bool SetForegroundWindow(IntPtr hWnd);
  [DllImport("user32.dll")]
  public static extern bool IsIconic(IntPtr hWnd);
  public static void BringToFront(IntPtr hWnd) {
    if (IsIconic(hWnd)) {
      ShowWindowAsync(hWnd, 9);
    }
    SetForegroundWindow(hWnd);
    ShowWindowAsync(hWnd, 3);
  }
}
'@
$process = Get-Process -Id ${pid} -ErrorAction SilentlyContinue
if ($process) {
  $process.MainWindowHandle | ForEach-Object {
    if ($_ -ne [IntPtr]::Zero) {
      [Win32]::BringToFront($_)
    }
  }
}`;
    writeFileSync(tempFile, psScript, 'utf8');
    await execAsync(`powershell -NoProfile -ExecutionPolicy Bypass -File "${tempFile}"`);
  } catch (err) {
    // Silently fail if PowerShell command doesn't work
    console.log('Could not focus window via PowerShell:', err.message);
  } finally {
    // Clean up temp file
    if (tempFile) {
      try {
        unlinkSync(tempFile);
      } catch {}
    }
  }
}

// Minimal fetch fallback for Node < 18 using https/http
async function doFetch(url, options = {}) {
  if (typeof fetch === 'function') {
    return fetch(url, options);
  }
  const { request: httpRequest } = await import(url.startsWith('https') ? 'https' : 'http');
  return new Promise((resolvePromise, rejectPromise) => {
    try {
      const urlObj = new URL(url);
      const bodyString = options.body instanceof URLSearchParams ? options.body.toString() : (typeof options.body === 'string' ? options.body : undefined);
      const req = httpRequest(
        {
          protocol: urlObj.protocol,
          hostname: urlObj.hostname,
          port: urlObj.port || (urlObj.protocol === 'https:' ? 443 : 80),
          path: urlObj.pathname + (urlObj.search || ''),
          method: options.method || 'GET',
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            'Content-Length': bodyString ? Buffer.byteLength(bodyString) : 0,
            ...(options.headers || {}),
          },
        },
        (res) => {
          let data = '';
          res.on('data', (chunk) => (data += chunk));
          res.on('end', () => {
            resolvePromise({
              status: res.statusCode,
              ok: res.statusCode >= 200 && res.statusCode < 300,
              text: async () => data,

              json: async () => {
                try {
                  return JSON.parse(data);
                } catch {
                  return { raw: data };
                }
              },
            });
          });
        }
      );
      req.on('error', rejectPromise);
      if (bodyString) req.write(bodyString);
      req.end();
    } catch (e) {
      rejectPromise(e);
    }
  });
}

async function manualFillAndSubmit(page, gstIn) {
  await page.waitForSelector('form[name="searchtaxp"]', { timeout: 20000 });
  await page.waitForSelector('input[name="for_gstin"]', { timeout: 15000 });

  await page.evaluate(() => {
    const el = document.querySelector('input[name="for_gstin"]');
    if (el) {
      el.value = '';
      el.dispatchEvent(new Event('input', { bubbles: true }));
    }
  });
  await page.type('input[name="for_gstin"]', gstIn, { delay: 50 });

  try {
    const captchaSelectors = [
      'input[name="captcha"]',
      'input[name*="captcha" i]',
      'input[id*="captcha" i]',
    ];
    for (const sel of captchaSelectors) {
      const exists = await page.$(sel);
      if (exists) {
        await page.focus(sel);
        break;
      }
    }
  } catch {}

  console.log('\n=== Manual CAPTCHA Mode ===');
  console.log('A browser window is open with the GSTIN pre-filled.');
  const canUseStdin = !!(process.stdin && process.stdin.isTTY);
  if (canUseStdin) {
    console.log('1. Solve the CAPTCHA in the browser.');
    console.log('2. Do not click submit. Once the captcha is solved, press Enter here to let the script submit.\n');
    await new Promise((resolve) => {
      try {
        process.stdin.resume();
        process.stdin.once('data', () => resolve());
      } catch {
        setTimeout(resolve, 30_000);
      }
    });
    try {
      process.stdin.pause();
    } catch {}

    const submitSelectorCandidates = [
      'form[name="searchtaxp"] button[type="submit"]',
      'form[name="searchtaxp"] input[type="submit"]',
      'form[name="searchtaxp"] button',
    ];
    let clicked = false;
    for (const sel of submitSelectorCandidates) {
      const btn = await page.$(sel);
      if (btn) {
        await Promise.allSettled([
          page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 20000 }),
          btn.click(),
        ]);
        clicked = true;
        break;
      }
    }
    if (!clicked) {
      await page.evaluate(() => {
        const form = document.querySelector('form[name="searchtaxp"]');
        if (form && typeof form.submit === 'function') {
          form.submit();
        }
      });
      await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 20000 }).catch(() => {});
    }
  } else {
    console.log('Solve the CAPTCHA in the browser and click the Submit button yourself.');
    console.log('The scraper is waiting for the GST portal to load the results...');

    // Store initial URL to detect navigation
    const initialUrl = page.url();

    // Wait for navigation or results to appear - give more time
    await Promise.race([
      page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 90000 }).catch(() => {}),
      page.waitForSelector('.table.tbl.inv.exp.table-bordered', { timeout: 90000 }).catch(() => {}),
      page.waitForFunction(() => {
        const hasTable = !!document.querySelector('.table.tbl.inv.exp.table-bordered');
        const hasResults = /(dealing in goods|hsn|sac)/i.test(document.body.innerText || '');
        return hasTable || hasResults;
      }, { timeout: 90000 }).catch(() => {}),
    ]);

    // Give extra time for page to fully render
    await sleep(5000);

    // Check if URL changed (indicates navigation happened)
    const currentUrl = page.url();
    const urlChanged = currentUrl !== initialUrl;
    console.log('URL changed after submission:', urlChanged);
  }

  // Check if we're on results page - look for positive indicators first
  // Wait a bit more to ensure page is fully loaded
  await sleep(3000);

  const hasResultsTable = await page.$('.table.tbl.inv.exp.table-bordered').catch(() => null);
  const hasResultsContent = await page.evaluate(() => {
    const bodyText = document.body.innerText || document.body.textContent || '';
    const hasDealingIn = /dealing in goods/i.test(bodyText);
    const hasHsn = /hsn|sac/i.test(bodyText);
    const hasTable = !!document.querySelector('.table.tbl.inv.exp.table-bordered');
    return hasDealingIn || hasHsn || hasTable;
  }).catch(() => false);

  // Check for alternative table selectors
  const hasAlternativeTable = await page.evaluate(() => {
    const tables = document.querySelectorAll('table');
    for (const table of tables) {
      const text = table.innerText || table.textContent || '';
      if (/(dealing in goods|hsn|sac)/i.test(text)) {
        return true;
      }
    }
    return false;
  }).catch(() => false);

  const stillOnForm = await page.$('form[name="searchtaxp"]').catch(() => null);

  logStage('FILL_SUBMIT', `Detection: hasResultsTable=${!!hasResultsTable} hasResultsContent=${hasResultsContent} hasAlternativeTable=${hasAlternativeTable} stillOnForm=${!!stillOnForm}`);

  // Only error if form exists AND no results found (even after checking alternatives)
  // The form might still exist in DOM but results are below it
  if (stillOnForm && !hasResultsTable && !hasResultsContent && !hasAlternativeTable) {
    // Wait more and check again with multiple attempts
    for (let attempt = 0; attempt < 3; attempt++) {
      await sleep(5000);
      const retryHasTable = await page.$('.table.tbl.inv.exp.table-bordered').catch(() => null);
      const retryHasContent = await page.evaluate(() => {
        const bodyText = document.body.innerText || document.body.textContent || '';
        return /(dealing in goods|hsn|sac)/i.test(bodyText);
      }).catch(() => false);
      const retryHasAltTable = await page.evaluate(() => {
        const tables = document.querySelectorAll('table');
        for (const table of tables) {
          const text = table.innerText || table.textContent || '';
          if (/(dealing in goods|hsn|sac)/i.test(text)) {
            return true;
          }
        }
        return false;
      }).catch(() => false);

      if (retryHasTable || retryHasContent || retryHasAltTable) {
        console.log('Results found on retry attempt', attempt + 1);
        return { ok: true };
      }
    }

    // Final check - if we still don't have results, but form might be hidden or results are there
    const finalCheck = await page.evaluate(() => {
      const bodyText = document.body.innerText || document.body.textContent || '';
      const hasAnyResults = /(dealing in goods|hsn|sac)/i.test(bodyText);
      const hasTable = !!document.querySelector('.table.tbl.inv.exp.table-bordered');
      const allTables = document.querySelectorAll('table');
      let foundResultsTable = false;
      for (const table of allTables) {
        const text = table.innerText || table.textContent || '';
        if (/(dealing in goods|hsn|sac)/i.test(text) && text.length > 100) {
          foundResultsTable = true;
          break;
        }
      }
      return hasAnyResults || hasTable || foundResultsTable;
    }).catch(() => false);

    if (!finalCheck) {
      throw new Error('CAPTCHA appears unresolved. The GST portal is still showing the search form.');
    }
  }

  return { ok: true };
}

async function captureGoodsServices(page) {
  // Try multiple selectors to find the results table
  const tableSelectors = [
    '.table.tbl.inv.exp.table-bordered',
    'table.table-bordered',
    'table.tbl',
    'table[class*="table"]',
    'table'
  ];

  let tableElement = null;
  let usedSelector = null;

  // Try each selector
  for (const selector of tableSelectors) {
    try {
      const element = await page.$(selector);
      if (element) {
        // Verify this table contains HSN-related content
        const hasHsnContent = await page.evaluate((sel) => {
          const table = document.querySelector(sel);
          if (!table) return false;
          const text = table.innerText || table.textContent || '';
          return /(dealing in goods|hsn|sac|goods|services)/i.test(text);
        }, selector);

        if (hasHsnContent) {
          tableElement = element;
          usedSelector = selector;
          console.log('Found results table with selector:', selector);
          break;
        }
      }
    } catch (e) {
      continue;
    }
  }

  if (!tableElement) {
    console.log('No results table found with any selector');
    return null;
  }

  try {
    const snapshot = await page.$eval(usedSelector, (el) => {
      const rows = Array.from(el.querySelectorAll('tbody tr, tr'));
      const data = [];
      for (const row of rows) {
        const cells = Array.from(row.querySelectorAll('td')).map((td) => (td.innerText || td.textContent || '').trim());
        // Handle both 4-column format (goods + services) and 2-column format (separate tables)
        if (cells.length >= 2) {
          if (cells.length >= 4) {
            // 4-column format: Goods HSN, Goods Desc, Services HSN, Services Desc
            data.push({
              goodsCode: cells[0] || '',
              goodsDescription: cells[1] || '',
              servicesCode: cells[2] || '',
              servicesDescription: cells[3] || '',
            });
          } else if (cells.length === 2) {
            // 2-column format: Could be goods or services - check context
            const rowText = row.innerText || row.textContent || '';
            const table = row.closest('table');
            const prevSibling = table?.previousElementSibling;
            const prevText = prevSibling?.innerText || prevSibling?.textContent || '';
            const pageText = document.body.innerText || document.body.textContent || '';

            // Determine if this is goods or services based on context
            const isGoods = /goods/i.test(prevText) || /goods/i.test(pageText.substring(0, pageText.indexOf(table?.innerText || '')));
            const isServices = /services/i.test(prevText) || /services/i.test(pageText.substring(0, pageText.indexOf(table?.innerText || '')));

            // If we can determine, use that; otherwise, try to infer from position or default to both
            if (isGoods && !isServices) {
              data.push({
                goodsCode: cells[0] || '',
                goodsDescription: cells[1] || '',
                servicesCode: '',
                servicesDescription: '',
              });
            } else if (isServices && !isGoods) {
              data.push({
                goodsCode: '',
                goodsDescription: '',
                servicesCode: cells[0] || '',
                servicesDescription: cells[1] || '',
              });
            } else {
              // Can't determine - check if HSN looks like goods (numeric) or services (SAC code)
              const hsnCode = cells[0] || '';
              // SAC codes for services typically start with 99
              if (/^99/.test(hsnCode)) {
                data.push({
                  goodsCode: '',
                  goodsDescription: '',
                  servicesCode: cells[0] || '',
                  servicesDescription: cells[1] || '',
                });
              } else {
                // Assume goods
                data.push({
                  goodsCode: cells[0] || '',
                  goodsDescription: cells[1] || '',
                  servicesCode: '',
                  servicesDescription: '',
                });
              }
            }
          }
        }
      }
      return data;
    });

    const goods = snapshot
      .filter((row) => row.goodsCode || row.goodsDescription)
      .map((row) => ({ HSN: row.goodsCode, Description: row.goodsDescription }));
    const services = snapshot
      .filter((row) => row.servicesCode || row.servicesDescription)
      .map((row) => ({ HSN: row.servicesCode, Description: row.servicesDescription }));

    console.log('Captured HSN details:', { goodsCount: goods.length, servicesCount: services.length });
    return { goods, services, rows: snapshot };
  } catch (error) {
    logStage('CAPTURE', `Error capturing goods/services: ${error.message}`, true);
    return null;
  }
}

async function notifyCallback(payload) {
  if (!HSN_CALLBACK_URL) return;
  try {
    const headers = {
      'Content-Type': 'application/json',
    };
    if (HSN_CALLBACK_TOKEN) {
      headers['Authorization'] = `Bearer ${HSN_CALLBACK_TOKEN}`;
    }
    const payloadString = JSON.stringify(payload);
    if (typeof fetch === 'function') {
      await fetch(HSN_CALLBACK_URL, {
        method: 'POST',
        headers,
        body: payloadString,
      });
    } else {
      await doFetch(HSN_CALLBACK_URL, {
        method: 'POST',
        headers,
        body: payloadString,
      });
    }
  } catch (err) {
    logStage('CALLBACK', `Callback notification failed: ${err.message || err}`, true);
  }
}

async function extractDealingGoodsServicesTable(page) {
  async function extractFromContext(ctx, headerOverrideArg, tableSelectorArg, tableIndexOverrideArg) {
    const { headerFound, data } = await ctx.evaluate((headerOverride, tableSelector, tableIndexOverride) => {
      function qsa(sel) { return Array.from(document.querySelectorAll(sel)); }
      function normalize(text) { return (text || '').replace(/\s+/g, ' ').trim(); }
      function isLikelyHsnHeaderCell(text) {
        const t = (text || '').toLowerCase();
        return t.includes('hsn') || t.includes('sac') || t.includes('hsn/sac') || t.includes('description') || t.includes('goods') || t.includes('service');
      }
      function guessHsnFromText(text) {
        const codes = (text.match(/\b\d{4,8}\b/g) || []).filter(Boolean);
        if (codes.length) return codes[0];
        return '';
      }
      function extractFromList(root) {
        const rows = [];
        const listSelectors = ['ul li', '.list-group li', '.list li'];
        for (const sel of listSelectors) {
          const items = Array.from(root.querySelectorAll(sel));
          for (const it of items) {
            const txt = normalize(it.innerText || it.textContent);
            if (!txt) continue;
            const hsn = guessHsnFromText(txt);
            if (hsn || /hsn|sac/i.test(txt)) {
              rows.push({ 'HSN/SAC': hsn, Description: txt });
            }
          }
        }
        // Grid-like rows
        const gridRows = Array.from(root.querySelectorAll('.row, .table-responsive .row'));
        for (const gr of gridRows) {
          const cols = Array.from(gr.querySelectorAll('.col, [class*="col-"]')).map(c => normalize(c.innerText || c.textContent)).filter(Boolean);
          if (cols.length >= 2) {
            const joined = cols.join(' | ');
            const hsn = guessHsnFromText(joined);
            if (hsn || /hsn|sac/i.test(joined)) {
              rows.push({ 'HSN/SAC': hsn, Description: joined });
            }
          }
        }
        // Plain paragraphs under the root
        const paras = Array.from(root.querySelectorAll('p, span, div'));
        for (const el of paras) {
          const txt = normalize(el.innerText || el.textContent);
          if (!txt) continue;
          const hsn = guessHsnFromText(txt);
          if (hsn && txt.length < 500) {
            rows.push({ 'HSN/SAC': hsn, Description: txt });
          }
        }
        // Deduplicate
        const unique = [];
        const seen = new Set();
        for (const r of rows) {
          const key = `${r['HSN/SAC']}|${r.Description}`;
          if (!seen.has(key)) {
            seen.add(key);
            unique.push(r);
          }
        }
        if (unique.length) {
          return { headers: ['HSN/SAC', 'Description'], rows: unique };
        }
        return null;
      }
      function findHeader() {
        const target = 'dealing in goods and services';
        const candidates = qsa('h1, h2, h3, h4, h5, h6, .panel-title, .accordion, .card-header, .section-title, .heading, .title, div, span, strong');
        const headings = candidates.filter(el => /^H[1-6]$/.test(el.tagName));
        const pools = [headings, candidates];
        for (const pool of pools) {
          for (const el of pool) {
            const text = normalize(el.textContent).toLowerCase();
            if (text === target) return el;
          }
        }
        for (const el of candidates) {
          const text = normalize(el.textContent).toLowerCase();
          if (text.includes(target)) return el;
        }
        return null;
      }
      function findNearestTable(start) {
        const container = start?.closest?.('.panel, .card, .accordion, section, .panel-body, .card-body, .content, div') || null;
        if (container) {
          const t = container.querySelector('table');
          if (t) return t;
        }
        if (start && start.nextElementSibling) {
          let el = start.nextElementSibling;
          for (let i = 0; i < 10 && el; i++, el = el.nextElementSibling) {
            const t = el.querySelector ? el.querySelector('table') : null;
            if (t) return t;
            if (el.tagName && el.tagName.toLowerCase() === 'table') return el;
          }
        }
        return null;
      }
      function extractFromTable(table) {
        const headers = [];
        const headerRow = table.querySelector('thead tr') || table.querySelector('tr');
        if (headerRow) {
          for (const th of headerRow.querySelectorAll('th, td')) {
            headers.push(normalize(th.textContent));
          }
        }
        const rows = [];
        const bodyRows = table.querySelectorAll('tbody tr');
        const rowNodes = bodyRows.length ? bodyRows : table.querySelectorAll('tr:not(:scope thead tr)');
        rowNodes.forEach((tr, idx) => {
          const cells = Array.from(tr.querySelectorAll('td, th')).map((td) => normalize(td.innerText || td.textContent));
          if (cells.length === 0) return;
          if (headers.length && cells.length === headers.length) {
            const obj = {};
            headers.forEach((h, i) => {
              obj[h || `col_${i + 1}`] = cells[i] ?? '';
            });
            rows.push(obj);
          } else {
            rows.push({ row: idx + 1, cells });
          }
        });
        return { headers, rows };
      }
      // Support override header name via argument
      const override = (headerOverride || '').toLowerCase();
      function findHeaderWithOverride() {
        const hdr = findHeader();
        if (hdr) return hdr;
        if (!override) return null;
        const candidates = qsa('h1, h2, h3, h4, h5, h6, .panel-title, .accordion, .card-header, .section-title, .heading, .title, div, span, strong');
        for (const el of candidates) {
          const text = normalize(el.textContent).toLowerCase();
          if (text.includes(override)) return el;
        }
        return null;
      }

      const headerEl = findHeaderWithOverride();
      let table = headerEl ? findNearestTable(headerEl) : null;
      // Explicit selector override
      if (!table && tableSelector) {
        const selected = qsa(tableSelector);
        if (selected && selected.length) {
          table = selected[Math.min(Math.max(tableIndexOverride || 0, 0), selected.length - 1)];
        }
      }
      if (!table) {
        const fallbackSelectors = [
          'table.tbl.inv.exp.table-bordered',
          '.table-responsive table.table-bordered',
        ];
        for (const sel of fallbackSelectors) {
          const matches = qsa(sel);
          if (matches && matches.length) {
            table = matches[Math.min(Math.max(tableIndexOverride || 0, 0), matches.length - 1)];
            break;
          }
        }
      }
      if (!table) {
        const allTables = qsa('table');
        let bestScore = -1;
        let bestTable = null;
        for (const t of allTables) {
          const headerRow = t.querySelector('thead tr') || t.querySelector('tr');
          const headersEval = headerRow ? Array.from(headerRow.querySelectorAll('th, td')).map(el => normalize(el.textContent)) : [];
          let score = 0;
          const headerLower = headersEval.map(h => h.toLowerCase());
          if (headerLower.some(h => /hsn|sac/.test(h))) score += 6;
          if (headerLower.some(h => /hsn\/sac/.test(h))) score += 3;
          if (headerLower.some(h => /description|desc/.test(h))) score += 2;
          if (headerLower.some(h => /goods|services/.test(h))) score += 1;
          const bodyRows = t.querySelectorAll('tbody tr');
          const rowNodes = bodyRows.length ? bodyRows : t.querySelectorAll('tr:not(:scope thead tr)');
          const sample = Array.from(rowNodes).slice(0, 8);
          let rowCodeHits = 0;
          for (const tr of sample) {
            const cells = Array.from(tr.querySelectorAll('td, th')).map(td => normalize(td.textContent));
            if (cells.some(c => /\b\d{4,8}\b/.test(c))) rowCodeHits += 1;
          }
          score += Math.min(5, rowCodeHits) * 2;
          if ((headersEval.length || 0) > 12) score -= 2;
          let headingBoost = 0;
          let el = t.previousElementSibling;
          for (let i = 0; i < 5 && el; i++, el = el.previousElementSibling) {
            const txt = (el.textContent || '').toLowerCase();
            if (txt.includes('dealing') || txt.includes('goods') || txt.includes('services')) {
              headingBoost = 4;
              break;
            }
          }
          score += headingBoost;
          if (score > bestScore) {
            bestScore = score;
            bestTable = t;
          }
        }
        if (bestScore > 2) table = bestTable;
      }
      if (!table) {
        const scope = headerEl ? (headerEl.closest('.panel, .card, .accordion, section, .panel-body, .card-body, .content, div') || document.body) : document.body;
        const listData = extractFromList(scope);
        if (listData) return { headerFound: !!headerEl, data: listData };
        return { headerFound: !!headerEl, data: null };
      }
      const raw = extractFromTable(table);
      function asArray(row, hdrs) {
        if (!row) return [];
        if (Array.isArray(row)) return row.slice();
        if (row && typeof row === 'object') {
          if (Array.isArray(row.cells)) return row.cells.slice();
          const ordered = [];
          (hdrs || []).forEach((h) => ordered.push(row[h] || ''));
          return ordered;
        }
        return [];
      }
      let headersEval = raw.headers ? raw.headers.slice() : [];
      let rowsEval = raw.rows ? raw.rows.slice() : [];
      if ((!headersEval.some(h => /hsn|sac/.test((h || '').toLowerCase()))) && rowsEval.length) {
        const firstCells = asArray(rowsEval[0], headersEval);
        if (firstCells.some(c => /hsn/.test((c || '').toLowerCase())) && firstCells.length >= 2) {
          headersEval = firstCells;
          rowsEval = rowsEval.slice(1);
        }
      }
      const lowerHeaders = (headersEval || []).map(h => (h || '').toLowerCase());
      const isGoodsServicesHeader = headerEl ? /(goods|services)/i.test(normalize(headerEl.textContent || '')) : false;
      const goodsServicesLayout = (headersEval.length >= 4 && headersEval.filter(h => /hsn|description/i.test(h || '')).length >= 3)
        || (rowsEval.length && asArray(rowsEval[0], headersEval).length >= 4)
        || isGoodsServicesHeader;
      if (goodsServicesLayout) {
        const mappedRows = rowsEval.map(row => {
          const cells = asArray(row, headersEval);
          return {
            goodsCode: cells[0] || '',
            goodsDescription: cells[1] || '',
            servicesCode: cells[2] || '',
            servicesDescription: cells[3] || '',
          };
        }).filter(r => r.goodsCode || r.goodsDescription || r.servicesCode || r.servicesDescription);
        if (mappedRows.length) {
          return {
            headerFound: !!headerEl,
            data: {
              headers: ['goodsCode', 'goodsDescription', 'servicesCode', 'servicesDescription'],
              layout: 'goodsServices',
              rows: mappedRows,
            },
          };
        }
      }
      const mapIndex = (patterns) => {
        for (let i = 0; i < lowerHeaders.length; i++) {
          const h = lowerHeaders[i];
          if (patterns.some(p => p.test(h))) return i;
        }
        return -1;
      };
      const codeIdx = mapIndex([/hsn/, /sac/, /code/]);
      const descIdx = mapIndex([/description/, /desc/, /item/]);
      const rateIdx = mapIndex([/rate|tax/]);
      const uqcIdx = mapIndex([/uqc|unit|qty|quantity/]);
      if (codeIdx >= 0 || descIdx >= 0 || rateIdx >= 0 || uqcIdx >= 0) {
        const mappedRows = rowsEval.map(row => {
          const cells = asArray(row, headersEval);
          return {
            code: codeIdx >= 0 ? (cells[codeIdx] || '') : '',
            description: descIdx >= 0 ? (cells[descIdx] || '') : '',
            rate: rateIdx >= 0 ? (cells[rateIdx] || '') : '',
            uqc: uqcIdx >= 0 ? (cells[uqcIdx] || '') : '',
          };
        }).filter(r => r.code || r.description || r.rate || r.uqc);
        if (mappedRows.length) {
          return {
            headerFound: !!headerEl,
            data: {
              headers: ['code', 'description', 'rate', 'uqc'],
              layout: 'standard',
              rows: mappedRows,
            },
          };
        }
      }
      return {
        headerFound: !!headerEl,
        data: {
          headers: headersEval.length ? headersEval : raw.headers,
          layout: 'raw',
          rows: rowsEval,
        },
      };
    }, headerOverrideArg, tableSelectorArg, tableIndexOverrideArg);
    if (data) return data;
    return null;
  }

  const contexts = [page, ...page.frames()];
  for (const ctx of contexts) {
    try {
      const res = await extractFromContext(ctx, HEADER_OVERRIDE, HSN_TABLE_SELECTOR, HSN_TABLE_INDEX_OVERRIDE);
      if (res && res.rows && res.rows.length) {
        return res;
      }
    } catch (err) {
      const message = (err && err.message) ? err.message.toLowerCase() : '';
      if (
        message.includes('detached') ||
        message.includes('execution context destroyed') ||
        message.includes('cross-origin') ||
        message.includes('permission denied')
      ) {
        continue;
      }
      throw err;
    }
  }

  throw new Error('Could not extract table under "Dealing In Goods and Services"');
}

async function main() {
  logStage('INIT', 'Script started');
  const puppeteer = (await import('puppeteer')).default;
  const gstIn = process.argv[2];
  if (!gstIn) {
    logStage('ARGS', 'Missing GSTIN. Usage: node hsn-details.js <GSTIN>', true);
    process.exit(1);
  }
  logStage('ARGS', `GSTIN=${gstIn}, URL=${GST_SEARCH_URL}, headless=${RUN_HEADLESS}, manual_captcha=${MANUAL_CAPTCHA}`);

  let browser;
  try {
    if (!GST_SEARCH_URL) {
      logStage('ENV', 'GST_SEARCH_URL environment variable is not set', true);
      throw new Error('GST_SEARCH_URL environment variable is not set!');
    }
    logStage('ENV', 'Environment OK');

    const launchOptions = {
      headless: RUN_HEADLESS ? true : (MANUAL_CAPTCHA ? false : true),
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-blink-features=AutomationControlled',
        '--disable-dev-shm-usage',
        '--disable-gpu',
        ...(RUN_HEADLESS ? [] : [
          '--start-maximized',
          '--disable-backgrounding-occluded-windows',
          '--disable-renderer-backgrounding',
          '--disable-background-timer-throttling',
          '--new-window'
        ])
      ],
      defaultViewport: RUN_HEADLESS ? { width: 1280, height: 800 } : null,
      ignoreHTTPSErrors: true,
      protocolTimeout: 60000,
      executablePath: '/opt/render/.cache/puppeteer/chrome/linux-127.0.6533.88/chrome-linux64/chrome',
    };

    logStage('BROWSER_LAUNCH', 'Launching Puppeteer browser...');
    browser = await puppeteer.launch(launchOptions);
    logStage('BROWSER_LAUNCHED', 'Browser launched successfully');
    const page = await browser.newPage();
    logStage('PAGE_CREATED', 'New page created');

    // Bring browser window to front only when headed (not on server)
    if (!RUN_HEADLESS) {
      const browserPid = browser.process()?.pid;
      if (browserPid) {
        await focusBrowserWindow(browserPid);
        await sleep(200);
        await page.bringToFront().catch(() => {});
        await sleep(100);
        await focusBrowserWindow(browserPid);
      } else {
        await page.bringToFront().catch(() => {});
        await sleep(100);
        await page.bringToFront().catch(() => {});
      }
    }

    // Set up dialog handler immediately (non-blocking)
    page.on('dialog', async (dialog) => {
      try {
        await dialog.accept();
      } catch (e) {
        try { await dialog.dismiss(); } catch {}
      }
    });

    // Set user agent and headers in parallel, then navigate immediately
    await Promise.all([
      page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/118.0.0.0 Safari/537.36'),
      page.setExtraHTTPHeaders({ 'Accept-Language': 'en-US,en;q=0.9' })
    ]);

    logStage('NAV_START', `Navigating to ${GST_SEARCH_URL}`);
    const navigationPromise = page.goto(GST_SEARCH_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });

    // Ensure window stays focused during navigation (headed only)
    if (!RUN_HEADLESS) {
      const browserPid = browser.process()?.pid;
      if (browserPid) focusBrowserWindow(browserPid).catch(() => {});
      page.bringToFront().catch(() => {});
    }

    await navigationPromise;
    logStage('NAV_DONE', `Navigation completed. URL=${page.url()}`);

    logStage('FORM_WAIT', 'Waiting for search form...');
    await page.waitForSelector('form[name="searchtaxp"]', { timeout: 20000 });
    logStage('FORM_FOUND', 'Search form found');

    logStage('FILL_SUBMIT', 'Filling GSTIN and waiting for CAPTCHA/submit...');
    await manualFillAndSubmit(page, gstIn);
    logStage('FILL_SUBMIT', 'Submit completed, waiting for results');

    // Set up navigation monitor EARLY to catch any redirects immediately
    let navigationDetected = false;
    let browserClosed = false;
    const navListener = page.on('framenavigated', async (frame) => {
      if (browserClosed) return; // Don't process if browser already closed
      try {
        // Check if page is still attached before accessing frames
        if (!page || page.isClosed()) return;
        if (frame === page.mainFrame()) {
          const url = frame.url().toLowerCase();
          if (url.includes('myprofile') || url.includes('accessdenied')) {
            logStage('REDIRECT', 'Detected redirect to myprofile/accessdenied. Closing browser.');
            navigationDetected = true;
            browserClosed = true;
            try {
              await browser.close();
              process.exit(0);
            } catch {}
          }
        }
      } catch (frameErr) {
        // Frame might be detached, ignore
        const errMsg = frameErr.message || String(frameErr);
        if (!errMsg.includes('detached') && !errMsg.includes('Target closed') && !errMsg.includes('Session closed')) {
          // Only log non-detachment errors
        }
      }
    });

    logStage('CAPTURE', 'Capturing HSN data from page...');
    let capture = await captureGoodsServices(page);

    if (capture && capture.rows && capture.rows.length > 0) {
      logStage('CAPTURE', `Data captured: ${capture.rows.length} rows. Closing browser.`);
      browserClosed = true; // Set flag first to prevent navigation listener from processing
      try {
        page.removeListener('framenavigated', navListener);
      } catch {}
      try {
        await browser.close();
      } catch (closeErr) {
        try {
          await browser.process()?.kill();
        } catch {}
      }
      // Continue with data processing after browser is closed
    }

    // If data not captured yet, check for modal and try to capture after
    if ((!capture || !capture.rows || !capture.rows.length) && !browserClosed) {
      // Check for and handle Information modal dialog (if it's a DOM element, not JS dialog)
      try {
        await sleep(1000); // Give time for modal to appear
        const proceedButton = await page.$('button:has-text("PROCEED"), button[onclick*="proceed"], .modal button:has-text("PROCEED"), button').catch(() => null);
        if (proceedButton && !browserClosed) {
          const buttonText = await page.evaluate(el => el.textContent?.trim(), proceedButton).catch(() => '');
          if (buttonText.toUpperCase().includes('PROCEED')) {
            logStage('MODAL', 'Information dialog found. Capturing data before clicking PROCEED.');
            // Try to capture data from behind the modal first
            capture = await captureGoodsServices(page);
            if (!capture || !capture.rows || !capture.rows.length) {
              logStage('MODAL', 'Clicking PROCEED button.');
              await proceedButton.click().catch(() => {});
              await sleep(2000); // Wait for navigation
              capture = await captureGoodsServices(page);
              // If we got data after clicking PROCEED, close immediately
              if (capture && capture.rows && capture.rows.length > 0) {
                logStage('CAPTURE', 'Data captured after PROCEED. Closing browser.');
                browserClosed = true;
                try {
                  page.removeListener('framenavigated', navListener);
                } catch {}
                try {
                  await browser.close();
                } catch (closeErr) {
                  try {
                    await browser.process()?.kill();
                  } catch {}
                }
              }
            } else {
              logStage('CAPTURE', 'Data captured before PROCEED. Closing browser.');
              // Don't click PROCEED if we already have data - it might cause redirect
              // Close browser immediately
              browserClosed = true;
              try {
                page.removeListener('framenavigated', navListener);
              } catch {}
              try {
                await browser.close();
              } catch (closeErr) {
                try {
                  await browser.process()?.kill();
                } catch {}
              }
            }
          }
        }
        // Also try to find by common modal selectors
        if ((!capture || !capture.rows || !capture.rows.length) && !browserClosed) {
          const modalProceed = await page.evaluate(() => {
            const buttons = Array.from(document.querySelectorAll('button, a, input[type="button"]'));
            const proceed = buttons.find(btn => {
              const text = (btn.textContent || btn.value || '').trim().toUpperCase();
              return text.includes('PROCEED') || text === 'PROCEED';
            });
            if (proceed) {
              // Try to capture data first
              const table = document.querySelector('.table.tbl.inv.exp.table-bordered');
              if (table) {
                return { hasTable: true, shouldClick: false };
              }
              proceed.click();
              return { hasTable: false, shouldClick: true };
            }
            return { hasTable: false, shouldClick: false };
          }).catch(() => ({ hasTable: false, shouldClick: false }));

          if (modalProceed.shouldClick) {
            await sleep(2000);
            capture = await captureGoodsServices(page);
            if (capture && capture.rows && capture.rows.length > 0) {
              logStage('CAPTURE', 'Data captured after modal click. Closing browser.');
              browserClosed = true;
              try {
                page.removeListener('framenavigated', navListener);
              } catch {}
              try {
                await browser.close();
              } catch (closeErr) {
                try {
                  await browser.process()?.kill();
                } catch {}
              }
            }
          } else if (modalProceed.hasTable) {
            capture = await captureGoodsServices(page);
            if (capture && capture.rows && capture.rows.length > 0) {
              logStage('CAPTURE', 'Data captured from table. Closing browser.');
              browserClosed = true;
              try {
                page.removeListener('framenavigated', navListener);
              } catch {}
              try {
                await browser.close();
              } catch (closeErr) {
                try {
                  await browser.process()?.kill();
                } catch {}
              }
            }
          }
        }
      } catch (modalErr) {
        console.log('Modal handling (non-critical):', modalErr.message || modalErr);
      }
    }

    // Check if browser is already closed (from earlier data capture)
    // browserClosed is already declared above, just verify state
    if (!browserClosed) {
      try {
        // Try to get pages - if browser is closed, this will fail
        await browser.pages();
      } catch {
        browserClosed = true;
        logStage('CLOSE', 'Browser already closed from earlier capture. Processing data.');
      }
    }

    // Only set up navigation blocking if browser is still open
    if (!browserClosed) {
      // Block navigation immediately after capturing data to prevent redirects to access denied
      try {
        // Prevent location changes via JavaScript on current page
        await page.evaluate(() => {
        // Override location methods to prevent redirects
        const originalReplace = window.location.replace;
        const originalAssign = window.location.assign;

        window.location.replace = function() {
          console.log('Blocked location.replace() after data capture');
          return false;
        };
        window.location.assign = function() {
          console.log('Blocked location.assign() after data capture');
          return false;
        };

        // Block href changes
        try {
          let currentHref = window.location.href;
          Object.defineProperty(window.location, 'href', {
            get: function() { return currentHref; },
            set: function(value) {
              console.log('Blocked location.href change to:', value);
              // Don't change href
            },
            configurable: true
          });
        } catch (e) {
          // If we can't override, try to stop navigation
          window.addEventListener('beforeunload', function(e) {
            e.preventDefault();
            e.returnValue = '';
            return '';
          });
        }

        // Stop any pending navigation
        if (window.stop) window.stop();
      }).catch(() => {});

      // Set up request interception to block navigation requests
      try {
        await page.setRequestInterception(true);
        page.on('request', (request) => {
          const url = request.url().toLowerCase();
          // Block navigation requests, especially to myprofile
          if (request.isNavigationRequest() && (url.includes('myprofile') || url !== page.url().toLowerCase())) {
            console.log('Blocked navigation request to:', request.url());
            request.abort();
          } else {
            request.continue();
          }
        });

        // Also block framenavigated events
        page.on('framenavigated', (frame) => {
          if (frame === page.mainFrame()) {
            const url = frame.url().toLowerCase();
            if (url.includes('myprofile') || url.includes('accessdenied')) {
              console.log('Blocked navigation to:', frame.url());
              // Try to go back or stop
              try {
                frame.evaluate(() => {
                  if (window.stop) window.stop();
                  if (window.history && window.history.back) {
                    // Don't go back, just stop
                  }
                }).catch(() => {});
              } catch {}
            }
          }
        });
      } catch (interceptErr) {
        // If interception was already set up, just log
        console.log('Request interception note:', interceptErr.message || 'already active');
      }
    } catch (blockErr) {
      console.log('Navigation blocking (non-critical):', blockErr.message || blockErr);
    }
    } // End of if (!browserClosed)

    // Only do page operations if browser is still open
    if (!browserClosed) {
      // Expand likely sections/tabs and wait for results to render
      try {
        await page.evaluate(() => {
          const clickables = Array.from(document.querySelectorAll('button, a, [role="tab"], .accordion-toggle, .card-header, .panel-title'));
          clickables.forEach((el) => {
            const t = (el.textContent || '').toLowerCase();
            if (t.includes('goods') || t.includes('services') || t.includes('dealing') || t.includes('details') || t.includes('profile')) {
              try { el.click(); } catch {}
            }
          });
        });
      } catch {}
      const hasCaptureData = !!(capture && capture.rows && capture.rows.length);

      if (!hasCaptureData) {
        // Wait for page to be stable before trying to capture
        try {
          await page.waitForFunction(
            () => document.readyState === 'complete',
            { timeout: 10000 }
          ).catch(() => {});
        } catch {}
        await page.waitForFunction(
          () => document.querySelector('table') || /(dealing in goods|hsn|sac)/i.test(document.body.innerText || ''),
          { timeout: 10000 }
        ).catch(() => {});
        await sleep(2000); // Give more time for page to fully render
        capture = await captureGoodsServices(page);

        // If we got data now, close immediately
        if (capture && capture.rows && capture.rows.length > 0) {
          logStage('CAPTURE', 'Data captured from retry. Closing browser.');
          browserClosed = true;
          try {
            page.removeListener('framenavigated', navListener);
          } catch {}
          try {
            await browser.close();
          } catch (closeErr) {
            try {
              await browser.process()?.kill();
            } catch {}
          }
        }
      }
    }

    const hasCaptureData = !!(capture && capture.rows && capture.rows.length);

    // Only do page operations if browser is still open
    let accessDenied = false;
    let hasGoodsTable = false;
    if (!browserClosed) {
      // Wait for page stability before evaluating
      try {
        await page.waitForFunction(() => document.readyState === 'complete', { timeout: 5000 }).catch(() => {});
        await sleep(1000);
      } catch {}

      // Safely evaluate with retry logic
      try {
        const result = await page.evaluate(() => {
          const text = (document.body.innerText || '').toLowerCase();
          const table = document.querySelector('.table.tbl.inv.exp.table-bordered');
          return {
            accessDenied: text.includes('access denied'),
            hasGoodsTable: !!table,
          };
        });
        accessDenied = result.accessDenied;
        hasGoodsTable = result.hasGoodsTable;
      } catch (evalErr) {
        // If context was destroyed, wait and retry
        if (evalErr.message && evalErr.message.includes('Execution context was destroyed')) {
          await sleep(2000);
          try {
            await page.waitForFunction(() => document.readyState === 'complete', { timeout: 5000 }).catch(() => {});
            const result = await page.evaluate(() => {
              const text = (document.body.innerText || '').toLowerCase();
              const table = document.querySelector('.table.tbl.inv.exp.table-bordered');
              return {
                accessDenied: text.includes('access denied'),
                hasGoodsTable: !!table,
              };
            });
            accessDenied = result.accessDenied;
            hasGoodsTable = result.hasGoodsTable;
          } catch (retryErr) {
            // If still fails, try to get basic info without evaluate
            console.log('Warning: Could not evaluate page state, proceeding with capture attempt...');
          }
        } else {
          throw evalErr;
        }
      }
    }

    let table = null;
    let goods = [];
    let services = [];

    if (capture && capture.rows && capture.rows.length) {
      table = {
        layout: 'goodsServices',
        headers: ['goodsCode', 'goodsDescription', 'servicesCode', 'servicesDescription'],
        rows: capture.rows,
      };
      goods = capture.goods.map((item) => ({
        code: item.HSN || '',
        description: item.Description || '',
      }));
      services = capture.services.map((item) => ({
        code: item.HSN || '',
        description: item.Description || '',
      }));
    }

    if (!table && !browserClosed) {
      // Wait for page to be fully stable before extraction
      try {
        await page.waitForFunction(() => document.readyState === 'complete', { timeout: 5000 }).catch(() => {});
        await sleep(2000);
      } catch {}

      try {
        table = await extractDealingGoodsServicesTable(page);
        if (table && table.layout === 'goodsServices') {
          goods = table.rows
            .filter((row) => row.goodsCode || row.goodsDescription)
            .map((row) => ({
              code: row.goodsCode || '',
              description: row.goodsDescription || '',
            }));
          services = table.rows
            .filter((row) => row.servicesCode || row.servicesDescription)
            .map((row) => ({
              code: row.servicesCode || '',
              description: row.servicesDescription || '',
            }));
        }
      } catch (extractErr) {
        console.log('Warning: Extraction failed, but continuing with captured data:', extractErr.message || extractErr);
        // Continue with whatever we captured so far
      }
    }

    // Only check for access denied AFTER all extraction attempts
    // Only throw error if we have NO data at all
    const hasAnyData = (goods && goods.length > 0) || (services && services.length > 0) || (table && table.rows && table.rows.length > 0);

    // Re-check for access denied page (might appear after data is captured) - only if browser still open
    let currentAccessDenied = false;
    if (!browserClosed) {
      try {
        const pageText = await page.evaluate(() => document.body.innerText || '').catch(() => '');
        currentAccessDenied = /access denied/i.test(pageText);
      } catch {}
    }

    if (hasAnyData && (accessDenied || currentAccessDenied)) {
      // Data was successfully captured, but page shows access denied - this is OK, just log it
      console.log('Note: "Access Denied" page appeared after successful data capture. This is normal and data has been saved.');
    } else if (!hasAnyData && (accessDenied || currentAccessDenied) && !hasGoodsTable) {
      throw new Error('Site responded with "Access Denied" after submission. Verify captcha solving, session timing, and IP reputation.');
    }

    // Prepare output immediately after data extraction
    const output = {
      ok: true,
      gstIn,
      source: GST_SEARCH_URL,
      section: HEADER_OVERRIDE || 'Dealing In Goods and Services',
      extractedAt: new Date().toISOString(),
      table,
      goods,
      services,
    };

    logStage('OUTPUT', 'Final output prepared');
    console.log(JSON.stringify(output));

    if (hasAnyData && !browserClosed) {
      logStage('CLOSE', 'Data captured successfully. Closing browser.');
      browserClosed = true; // Set flag first to prevent navigation listener from processing

      // Remove navigation listener since we're closing
      try {
        page.removeListener('framenavigated', navListener);
      } catch {}

      // Stop any pending navigation
      try {
        await page.evaluate(() => {
          if (window.stop) window.stop();
        }).catch(() => {});
      } catch {}

      // Close browser immediately - don't wait for anything
      try {
        await browser.close();
      } catch (closeErr) {
        try {
          await browser.process()?.kill();
        } catch {}
      }

      // Send callback after browser is closed (doesn't need browser)
      logStage('CALLBACK', 'Sending success callback');
      try {
        await notifyCallback({
          status: 'success',
          gstIn,
          profileId: PROFILE_ID || null,
          goods,
          services,
          raw: output,
        });
      } catch (callbackErr) {
        logStage('CALLBACK', `Callback failed: ${callbackErr.message || callbackErr}`, true);
      }
      logStage('DONE', 'Success. Exiting 0.');
      process.exit(0);
    } else if (hasAnyData && browserClosed) {
      logStage('CALLBACK', 'Sending success callback (browser already closed)');
      try {
        await notifyCallback({
          status: 'success',
          gstIn,
          profileId: PROFILE_ID || null,
          goods,
          services,
          raw: output,
        });
      } catch (callbackErr) {
        logStage('CALLBACK', `Callback failed: ${callbackErr.message || callbackErr}`, true);
      }
      logStage('DONE', 'Success. Exiting 0.');
      process.exit(0);
    }
  } catch (err) {
    const gstIn = process.argv[2] || 'unknown';
    const errMsg = (err && err.message) ? err.message : String(err);
    const errStack = (err && err.stack) ? String(err.stack) : null;
    logStage('ERROR', `Script failed: ${errMsg}`, true);
    if (errStack) logStage('ERROR', `Stack: ${errStack}`, true);

    const errorPayload = {
      ok: false,
      gstIn,
      source: GST_SEARCH_URL,
      error: errMsg,
      stack: errStack,
      at: new Date().toISOString()
    };
    console.error(JSON.stringify(errorPayload, null, 2));

    if (browser) {
      try {
        await sleep(RUN_HEADLESS ? 2000 : 10000);
      } catch {}
    }

    logStage('CALLBACK', 'Sending error callback');
    try {
      await notifyCallback({
        status: 'error',
        gstIn,
        profileId: PROFILE_ID || null,
        error: errMsg,
        stack: errStack,
      });
    } catch (callbackErr) {
      logStage('CALLBACK', `Callback failed: ${callbackErr.message || callbackErr}`, true);
    }

    try {
      await browser?.close();
    } catch {}
    logStage('DONE', 'Exiting 1 (error).');
    process.exit(1);
  }
}

main().catch((err) => {
  const line = `[${new Date().toISOString()}] [FATAL] Unhandled: ${(err && err.message) ? err.message : String(err)}`;
  console.error(line);
  if (HSN_LOG_FILE) {
    try {
      appendFileSync(HSN_LOG_FILE, line + '\n', 'utf8');
    } catch (e) {}
  }
  process.exit(1);
});


