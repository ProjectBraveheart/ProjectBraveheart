import { app, BrowserWindow, shell, net, session } from 'electron';
import path from 'path';
import http from 'http';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const isDev = !app.isPackaged;

let mainWindow = null;
let loginWindow = null;
let caiLoginWindow = null;
let serverInstance = null;
let proxyServer = null;
const SERVER_CLOSE_TIMEOUT_MS = 5000;
const LOGIN_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes

const charFields = [
  'name', 'description', 'personality', 'scenario',
  'first_message', 'greeting', 'example_dialogs', 'mes_example',
  'alternate_greetings', 'system_prompt', 'creator', 'tags',
];

const scoreCandidate = (candidate, fields) => {
  if (!candidate || typeof candidate !== 'object') return 0;

  let score = 0;
  for (const field of fields) {
    const val = candidate[field];
    if (val === null || val === undefined || val === '') continue;
    if (typeof val === 'string' && val.length > 0) score++;
    else if (Array.isArray(val) && val.length > 0) score++;
    else if (val && !Array.isArray(val) && typeof val === 'object' && Object.keys(val).length > 0) score++;
  }

  // Only consider objects that look like character payloads.
  if (!(candidate.name || candidate.description)) return 0;
  return score;
};

const pickBestInterceptedResponse = (responses, fields) => {
  let bestData = null;
  let bestScore = 0;

  for (const resp of responses) {
    // Handle both { name, ... } and { data: { name, ... } } formats
    const candidate = resp.data?.data || resp.data;
    const score = scoreCandidate(candidate, fields);
    if (score > bestScore) {
      bestScore = score;
      bestData = candidate;
    }
  }

  return { bestData, bestScore };
};

function getUserDataPath(...segments) {
  return path.join(app.getPath('userData'), ...segments);
}

// ---------------------------------------------------------------------------
// Chromium Proxy — uses Electron's net.fetch() (real Chrome TLS fingerprint)
// to bypass Cloudflare bot detection for platforms like JanitorAI.
// The backend POSTs to this proxy instead of using axios directly.
// ---------------------------------------------------------------------------

async function startChromiumProxy() {
  return new Promise((resolve, reject) => {
    proxyServer = http.createServer(async (req, res) => {
      // Route: POST /open-login — open JanitorAI login popup to capture auth token
      if (req.method === 'POST' && req.url === '/open-login') {
        try {
          const result = await openLoginWindow();
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(result));
        } catch (err) {
          console.error('Login popup error:', err.message);
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: err.message }));
        }
        return;
      }

      // Route: POST /open-cai-login — open Character.AI login popup to capture auth token
      if (req.method === 'POST' && req.url === '/open-cai-login') {
        try {
          const result = await openCAILoginWindow();
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(result));
        } catch (err) {
          console.error('CAI login popup error:', err.message);
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: err.message }));
        }
        return;
      }

      // Route: POST /cai-character-info — fetch character info from Character.AI
      // Strategy 1: net.request with a CLEAN session (no cookies, like cainode's
      //   native fetch) but Chromium TLS fingerprint + "Character.AI" User-Agent.
      // Strategy 2 (fallback): Hidden BrowserWindow scrapes the character page
      //   using the authenticated login session.
      if (req.method === 'POST' && req.url === '/cai-character-info') {
        let body = '';
        req.on('data', (chunk) => { body += chunk; });
        req.on('end', async () => {
          try {
            const { characterId, token } = JSON.parse(body);
            if (!characterId || !token) {
              res.writeHead(400, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ error: 'Missing characterId or token' }));
              return;
            }

            console.log(`CAI info: fetching character info for ${characterId}`);
            let result = null;

            // --- Strategy 1: API call with clean session + cainode headers ---
            try {
              result = await new Promise((resolveReq, rejectReq) => {
                // Clean ephemeral session — no cookies, just Chromium TLS fingerprint.
                // cainode's fetch also sends no cookies, just token + UA.
                const cleanSession = session.fromPartition('cai-api');
                const electronReq = net.request({
                  method: 'POST',
                  url: 'https://plus.character.ai/chat/character/info/',
                  session: cleanSession,
                });
                // Match cainode's https_fetch headers (omitting Connection/TE/
                // Sec-Fetch-* which Electron's net.request manages internally
                // and rejects as ERR_INVALID_ARGUMENT)
                electronReq.setHeader('Authorization', `Token ${token}`);
                electronReq.setHeader('Content-Type', 'application/json');
                electronReq.setHeader('User-Agent', 'Character.AI');
                electronReq.setHeader('DNT', '1');
                electronReq.setHeader('Sec-GPC', '1');

                const bodyStr = JSON.stringify({ external_id: characterId });
                electronReq.setHeader('Content-Length', `${Buffer.byteLength(bodyStr)}`);

                const chunks = [];
                electronReq.on('response', (response) => {
                  console.log(`CAI info [strategy 1]: status ${response.statusCode}`);
                  response.on('data', (chunk) => { chunks.push(chunk); });
                  response.on('end', () => {
                    const data = Buffer.concat(chunks).toString('utf-8');
                    if (response.statusCode !== 200) {
                      rejectReq(new Error(`HTTP ${response.statusCode}: ${data.substring(0, 100)}`));
                      return;
                    }
                    try {
                      resolveReq(JSON.parse(data));
                    } catch {
                      rejectReq(new Error(`Invalid JSON: ${data.substring(0, 100)}`));
                    }
                  });
                  response.on('error', rejectReq);
                });
                electronReq.on('error', rejectReq);
                electronReq.write(bodyStr);
                electronReq.end();
              });
              console.log(`CAI info [strategy 1]: success — name="${result?.character?.name}"`);
            } catch (err1) {
              console.warn(`CAI info [strategy 1] failed: ${err1.message}`);
            }

            // --- Strategy 2 (fallback): Scrape character page in BrowserWindow ---
            if (!result?.character) {
              console.log('CAI info [strategy 2]: scraping character page...');
              let hiddenWin = null;
              try {
                hiddenWin = new BrowserWindow({
                  show: false,
                  width: 800,
                  height: 600,
                  webPreferences: {
                    partition: 'persist:characterai',
                    contextIsolation: true,
                  },
                });

                // Navigate to the character chat page (includes avatar + name in the UI)
                const chatUrl = `https://character.ai/chat/${characterId}`;
                console.log(`CAI info [strategy 2]: loading ${chatUrl}`);
                await hiddenWin.loadURL(chatUrl);

                // Wait for the page to render character info
                await new Promise(r => setTimeout(r, 3000));

                // Extract character info from the rendered page
                const scraped = await hiddenWin.webContents.executeJavaScript(`
                  (function() {
                    const info = {};

                    // Try __NEXT_DATA__ first (most reliable)
                    try {
                      const nd = document.getElementById('__NEXT_DATA__');
                      if (nd) {
                        const data = JSON.parse(nd.textContent);
                        const char = data?.props?.pageProps?.character;
                        if (char) {
                          info.name = char.name || char.participant__name || '';
                          info.avatar_file_name = char.avatar_file_name || '';
                          info.greeting = char.greeting || '';
                          info.title = char.title || '';
                        }
                      }
                    } catch(e) {}

                    // Fallback: scrape avatar from img elements
                    if (!info.avatar_file_name) {
                      const imgs = document.querySelectorAll('img[src*="characterai.io"], img[src*="character.ai"]');
                      for (const img of imgs) {
                        const src = img.src || '';
                        const match = src.match(/avatars\\/([^?/]+)/);
                        if (match) {
                          info.avatar_file_name = match[1];
                          break;
                        }
                      }
                    }

                    // Fallback: scrape name from page title or header
                    if (!info.name) {
                      const header = document.querySelector('h1, [class*="char-name"], [class*="character-name"]');
                      if (header) info.name = header.textContent.trim();
                    }

                    return JSON.stringify(info);
                  })()
                `);

                const scrapedData = JSON.parse(scraped);
                console.log(`CAI info [strategy 2]: scraped name="${scrapedData.name}", avatar="${scrapedData.avatar_file_name}"`);

                if (scrapedData.name || scrapedData.avatar_file_name) {
                  result = { character: scrapedData };
                }
              } catch (err2) {
                console.warn(`CAI info [strategy 2] failed: ${err2.message}`);
              } finally {
                if (hiddenWin && !hiddenWin.isDestroyed()) {
                  hiddenWin.close();
                }
              }
            }

            if (result?.character) {
              console.log(`CAI info: final — name="${result.character.name}", avatar="${result.character.avatar_file_name}"`);
              res.writeHead(200, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify(result));
            } else {
              res.writeHead(404, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ error: 'Could not fetch character info' }));
            }
          } catch (err) {
            console.error('CAI info error:', err.message);
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: err.message }));
          }
        });
        return;
      }

      // Route: POST /scrape-character — open a character page in the
      // authenticated browser and scrape the rendered content.
      if (req.method === 'POST' && req.url === '/scrape-character') {
        let body = '';
        req.on('data', (chunk) => { body += chunk; });
        req.on('end', async () => {
          try {
            const { characterUrl } = JSON.parse(body);
            if (!characterUrl) {
              res.writeHead(400, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ error: 'Missing characterUrl' }));
              return;
            }
            console.log(`Scrape: opening ${characterUrl}`);
            const result = await scrapeCharacterPage(characterUrl);
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(result));
          } catch (err) {
            console.error('Scrape error:', err.message);
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: err.message }));
          }
        });
        return;
      }

      // Route: POST /proxy-fetch — Chromium-based fetch for Cloudflare bypass
      if (req.method !== 'POST' || req.url !== '/proxy-fetch') {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Not found' }));
        return;
      }

      let body = '';
      req.on('data', (chunk) => { body += chunk; });
      req.on('end', async () => {
        try {
          const { url, headers = {}, responseType } = JSON.parse(body);

          if (!url) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Missing url' }));
            return;
          }

          console.log(`Chromium proxy: fetching ${url}`);

          // Use Electron's net.request — Chromium networking API with
          // Chrome TLS fingerprint. For JanitorAI, use the login session.
          const requestOptions = { method: 'GET', url };
          if (url.includes('kim.janitorai.com')) {
            requestOptions.session = session.fromPartition('persist:janitorai');
          }

          const result = await new Promise((resolveReq, rejectReq) => {
            const electronReq = net.request(requestOptions);

            // Set headers individually (net.request requires this)
            for (const [key, value] of Object.entries(headers)) {
              try {
                electronReq.setHeader(key, value);
              } catch (e) {
                console.warn(`Chromium proxy: could not set header "${key}": ${e.message}`);
              }
            }

            const chunks = [];
            const responseHeaders = {};
            let statusCode = 0;
            let statusMessage = '';

            electronReq.on('response', (response) => {
              statusCode = response.statusCode;
              statusMessage = response.statusMessage || '';

              // Collect headers
              const rawHeaders = response.headers;
              for (const [key, value] of Object.entries(rawHeaders)) {
                responseHeaders[key] = Array.isArray(value) ? value.join(', ') : value;
              }

              response.on('data', (chunk) => {
                chunks.push(chunk);
              });

              response.on('end', () => {
                const fullBuffer = Buffer.concat(chunks);
                resolveReq({ statusCode, statusMessage, responseHeaders, body: fullBuffer });
              });

              response.on('error', (err) => {
                rejectReq(err);
              });
            });

            electronReq.on('error', (err) => {
              rejectReq(err);
            });

            electronReq.end();
          });

          console.log(`Chromium proxy: got ${result.statusCode} from ${url}`);

          // Encode body
          let responseBody;
          if (responseType === 'arraybuffer') {
            responseBody = result.body.toString('base64');
          } else {
            responseBody = result.body.toString('utf-8');
          }

          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            status: result.statusCode,
            statusText: result.statusMessage,
            headers: result.responseHeaders,
            body: responseBody,
          }));
        } catch (err) {
          console.error(`Chromium proxy error: ${err.message}`);
          res.writeHead(502, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: err.message }));
        }
      });
    });

    proxyServer.listen(0, '127.0.0.1', () => {
      const port = proxyServer.address().port;
      console.log(`Chromium proxy listening on 127.0.0.1:${port}`);
      resolve(port);
    });

    proxyServer.on('error', reject);
  });
}

function closeChromiumProxy() {
  return new Promise((resolve) => {
    if (!proxyServer) { resolve(); return; }
    proxyServer.close(() => {
      proxyServer = null;
      resolve();
    });
  });
}

async function waitForTextStabilization(win, maxMs) {
  let lastTextLen = 0;
  let stableChecks = 0;
  const start = Date.now();

  while (stableChecks < 3 && (Date.now() - start) < maxMs) {
    await new Promise(r => setTimeout(r, 1000));
    try {
      const curLen = await win.webContents.executeJavaScript(
        'document.body ? document.body.innerText.length : 0'
      );
      if (curLen === lastTextLen) {
        stableChecks++;
      } else {
        stableChecks = 0;
        lastTextLen = curLen;
      }
    } catch {
      // Ignore transient page errors while content continues to render.
    }
  }

  return lastTextLen;
}

async function expandAndScrollToTop(win) {
  await win.webContents.executeJavaScript(`
    (function() {
      window.scrollTo(0, 0);
      const containers = document.querySelectorAll(
        '[class*="chat" i], [class*="message" i], [class*="scroll" i], [role="log"]'
      );
      containers.forEach(c => { c.scrollTop = 0; });

      const expandBtns = [...document.querySelectorAll('button, [role="button"], span, div')];
      for (const btn of expandBtns) {
        const text = (btn.textContent || '').toLowerCase().trim();
        if (/^(show more|read more|expand|see more|view more)/.test(text)) {
          btn.click();
        }
      }
    })()
  `);

  await new Promise(r => setTimeout(r, 1500));
}

// Helper JS source for domToTextWithImages — injected into renderer scripts.
// Converts a DOM element to text, preserving inline images as markdown.
const DOM_TO_TEXT_JS = `
function domToTextWithImages(el) {
  var parts = [];
  var blockTags = {DIV:1,P:1,BR:1,H1:1,H2:1,H3:1,H4:1,H5:1,H6:1,LI:1,BLOCKQUOTE:1,SECTION:1,ARTICLE:1};
  function walk(node) {
    if (node.nodeType === 3) { // TEXT_NODE
      var t = node.textContent;
      if (t) parts.push(t);
      return;
    }
    if (node.nodeType !== 1) return; // ELEMENT_NODE
    var tag = node.tagName;
    if (tag === 'IMG') {
      var src = node.src || '';
      if (src && src.indexOf('data:') === -1 && src.indexOf('.svg') === -1
          && src.indexOf('avatar') === -1) {
        parts.push('\\n![image](' + src + ')\\n');
      }
      return;
    }
    if (tag === 'BR') { parts.push('\\n'); return; }
    var isBlock = blockTags[tag] || false;
    if (isBlock) parts.push('\\n');
    for (var i = 0; i < node.childNodes.length; i++) walk(node.childNodes[i]);
    if (isBlock) parts.push('\\n');
  }
  walk(el);
  return parts.join('').replace(/\\n\\n\\n+/g, '\\n\\n').trim();
}
`;

/**
 * Extract all chat greetings from a JanitorAI chat page.
 * JanitorAI renders ALL greetings as children of a slider element
 * (class*="botChoicesSlider"), positioned side-by-side via translateX.
 * All children are in the DOM at once, so we extract them directly.
 * Falls back to generic message selectors for non-JanitorAI pages.
 */
async function extractChatMessages(win) {
  const messagesJson = await win.webContents.executeJavaScript(`
    (function() {
      ${DOM_TO_TEXT_JS}
      var greetings = [];

      // Primary: extract all greetings from the JanitorAI slider children.
      // Each direct child of botChoicesSlider is one greeting panel.
      var slider = document.querySelector('[class*="botChoicesSlider"]');
      if (slider && slider.children.length > 0) {
        for (var i = 0; i < slider.children.length; i++) {
          var text = domToTextWithImages(slider.children[i]);
          if (text && text.length > 10) {
            greetings.push({ role: 'character', text: text });
          }
        }
      }

      // Fallback: generic message element extraction
      if (greetings.length === 0) {
        var sel = '[class*="message"], [class*="Message"], [class*="chat"], [class*="Chat"], [data-message-id], [data-testid*="message"]';
        var els = document.querySelectorAll(sel);
        for (var i = 0; i < els.length; i++) {
          if (els[i].querySelector(sel)) continue;
          var text = domToTextWithImages(els[i]);
          if (text && text.length > 10) {
            greetings.push({ role: 'character', text: text });
          }
        }
      }

      // Last resort: body text
      if (greetings.length === 0) {
        var body = document.body ? document.body.innerText : '';
        if (body.length > 50) {
          greetings.push({ role: 'full_chat', text: body });
        }
      }

      return JSON.stringify(greetings);
    })()
  `);

  return JSON.parse(messagesJson);
}

// ---------------------------------------------------------------------------
// Page Scraper — opens a character page in the authenticated browser,
// waits for it to render, and scrapes the visible content + images.
// The scraped text is then processed by the AI to generate a character card.
// ---------------------------------------------------------------------------

async function scrapeCharacterPage(characterUrl) {
  const SCRAPE_TIMEOUT_MS = 30000;
  const CHAT_POLL_TIMEOUT_MS = 15000;

  const scrapeWin = new BrowserWindow({
    show: false,
    width: 1280,
    height: 900,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      partition: 'persist:janitorai',
    },
  });

  // CDP state — declared in function scope so `finally` can access them
  let cdpAttached = false;
  const interceptedResponses = []; // { url, data }

  try {
    // ---------------------------------------------------------------
    // CDP network interception: passively capture character API responses.
    // JanitorAI's React app fetches character data on load. When the
    // definition is "hidden" or our direct API fetch fails with 530,
    // this captures whatever JAI's own code receives.
    // ---------------------------------------------------------------
    try {
      scrapeWin.webContents.debugger.attach('1.3');
      cdpAttached = true;
      await scrapeWin.webContents.debugger.sendCommand('Network.enable');

      scrapeWin.webContents.debugger.on('message', (event, method, params) => {
        if (method !== 'Network.responseReceived') return;
        const { requestId, response } = params;
        const url = response.url || '';

        // Only capture JSON 200s from the JanitorAI character API
        const isJanitorApi = url.includes('kim.janitorai.com');
        const isCharEndpoint = /\/characters\/[a-f0-9-]+/i.test(url);
        const isJson = (response.mimeType || '').includes('json')
          || (response.headers?.['content-type'] || '').includes('json');

        if (isJanitorApi && isCharEndpoint && isJson && response.status === 200) {
          scrapeWin.webContents.debugger.sendCommand('Network.getResponseBody', { requestId })
            .then(result => {
              try {
                const body = result.base64Encoded
                  ? Buffer.from(result.body, 'base64').toString('utf-8')
                  : result.body;
                const parsed = JSON.parse(body);
                interceptedResponses.push({ url, data: parsed });
                console.log(`Scrape: CDP intercepted API response from ${url} (keys: ${Object.keys(parsed).join(', ')})`);
              } catch (e) {
                console.log(`Scrape: CDP response parse failed: ${e.message}`);
              }
            })
            .catch(e => {
              console.log(`Scrape: CDP getResponseBody failed: ${e.message}`);
            });
        }
      });

      console.log('Scrape: CDP network interception enabled');
    } catch (cdpErr) {
      console.log(`Scrape: CDP attach failed (non-fatal): ${cdpErr.message}`);
      cdpAttached = false;
    }

    console.log(`Scrape: navigating to ${characterUrl}`);
    await scrapeWin.loadURL(characterUrl);

    // Wait for the SPA to render. Poll until meaningful content appears
    // or we hit the timeout.
    const startTime = Date.now();
    let pageReady = false;

    while (!pageReady && (Date.now() - startTime) < SCRAPE_TIMEOUT_MS) {
      await new Promise(r => setTimeout(r, 1000));

      try {
        const check = await scrapeWin.webContents.executeJavaScript(`
          (function() {
            const text = document.body ? document.body.innerText : '';
            // Check for meaningful content length (not just a loading spinner)
            return text.length > 200;
          })()
        `);
        if (check) pageReady = true;
      } catch {
        // Page may still be loading
      }
    }

    // Extra wait for images and lazy-loaded content
    await new Promise(r => setTimeout(r, 2000));

    // Detect the logged-in user's JanitorAI persona/display name.
    // JanitorAI stores user profile in a "stores" cookie (URL-encoded JSON).
    // The persona name lives at stores.user.profile.name and is what JAI renders
    // in place of {{user}} on the page.
    let jaiUsername = null;
    try {
      jaiUsername = await scrapeWin.webContents.executeJavaScript(`
        (function() {
          try {
            const cookies = document.cookie.split(';');
            for (const c of cookies) {
              const [rawKey, ...rawValParts] = c.split('=');
              if ((rawKey || '').trim() !== 'stores') continue;
              const decoded = decodeURIComponent(rawValParts.join('=').trim());
              const storesObj = JSON.parse(decoded);
              // Direct path: stores.user.profile.name
              const profileName = storesObj?.user?.profile?.name;
              if (profileName && typeof profileName === 'string' && profileName.length >= 2) {
                return profileName;
              }
              // Fallback: scan for persona/display name fields
              const user = storesObj?.user;
              if (user) {
                const fallback = user.display_name || user.displayName || user.persona_name
                  || user.name || user.username;
                if (fallback && typeof fallback === 'string' && fallback.length >= 2) {
                  return fallback;
                }
              }
              break;
            }
          } catch {}
          return null;
        })()
      `);
      if (jaiUsername) {
        console.log(`Scrape: detected JAI persona name: "${jaiUsername}" (from stores cookie)`);
      }
    } catch (e) {
      console.log('Scrape: persona detection failed (non-fatal):', e.message);
    }

    // Detect unauthenticated session — check for Supabase auth cookies.
    // If the user hasn't logged in, the scraper will get degraded data.
    let isLoggedIn = null;
    try {
      const jaiSession = session.fromPartition('persist:janitorai');
      const allCookies = await jaiSession.cookies.get({ url: 'https://janitorai.com' });
      isLoggedIn = allCookies.some(c => c.name.includes('auth-token'));
      console.log(`Scrape: auth check — ${allCookies.length} cookies, logged in: ${isLoggedIn}`);
    } catch (e) {
      console.log('Scrape: auth cookie check failed (non-fatal):', e.message);
    }

    // Try to fetch character data directly from the JanitorAI API using the
    // page's browser context (cookies, Cloudflare tokens, TLS session).
    // This is much more reliable than extracting from __NEXT_DATA__ or script tags.
    let apiCharacterData = null;
    try {
      const charIdMatch = characterUrl.match(/\/characters\/([a-f0-9-]+)/i);
      if (charIdMatch) {
        const charId = charIdMatch[1];
        const apiResult = await scrapeWin.webContents.executeJavaScript(`
          (async function() {
            try {
              const resp = await fetch('https://kim.janitorai.com/characters/${charId}', {
                headers: { 'Accept': 'application/json' },
                credentials: 'include',
              });
              if (resp.ok) {
                const data = await resp.json();
                return JSON.stringify({ ok: true, data });
              }
              return JSON.stringify({ ok: false, status: resp.status });
            } catch (e) {
              return JSON.stringify({ ok: false, error: e.message });
            }
          })()
        `);
        if (apiResult) {
          const parsed = JSON.parse(apiResult);
          if (parsed.ok) {
            apiCharacterData = parsed.data;
            console.log(`Scrape: fetched character data from in-page API (keys: ${Object.keys(apiCharacterData).join(', ')})`);
          } else {
            console.log(`Scrape: in-page API returned ${parsed.status || parsed.error || 'unknown error'}`);
          }
        }
      }
    } catch (e) {
      console.log('Scrape: in-page API fetch failed (non-fatal):', e.message);
    }

    // ---------------------------------------------------------------
    // CDP fallback: if direct API fetch failed, use intercepted data
    // from JAI's own network requests captured by the CDP handler.
    // ---------------------------------------------------------------
    if (!apiCharacterData && interceptedResponses.length > 0) {
      // Brief wait for any in-flight CDP body reads to finish
      await new Promise(r => setTimeout(r, 1500));

      const { bestData, bestScore } = pickBestInterceptedResponse(interceptedResponses, charFields);

      if (bestData) {
        apiCharacterData = bestData;
        console.log(`Scrape: using CDP-intercepted data (score: ${bestScore}, keys: ${Object.keys(bestData).join(', ')})`);
      } else {
        console.log('Scrape: CDP intercepted responses had no valid character data');
      }
    } else if (!apiCharacterData && cdpAttached) {
      // CDP is active but nothing was intercepted yet — wait and check once more
      await new Promise(r => setTimeout(r, 2000));
      if (interceptedResponses.length > 0) {
        const { bestData, bestScore } = pickBestInterceptedResponse(interceptedResponses, charFields);

        if (bestData) {
          apiCharacterData = bestData;
          console.log(`Scrape: using late CDP-intercepted data (score: ${bestScore}, keys: ${Object.keys(bestData).join(', ')})`);
        } else {
          console.log('Scrape: CDP intercepted responses had no valid character data');
        }
      }
    }

    // Expand all collapsed accordion sections before scraping.
    // JanitorAI uses collapsible sections (PERSONALITY, SCENARIO, etc.) that
    // must be clicked open for their content to appear in the DOM.
    try {
      const expandCount = await scrapeWin.webContents.executeJavaScript(`
        (function() {
          let count = 0;
          // JanitorAI accordion headers contain text like "PERSONALITY (2160 TOKENS)"
          // and a chevron icon. Click them to expand.
          const candidates = document.querySelectorAll('button, [role="button"], [class*="accordion" i], [class*="Accordion" i]');
          for (const el of candidates) {
            const text = (el.textContent || '').trim();
            if (/tokens?\\s*\\)/i.test(text) && text.length < 150) {
              try { el.click(); count++; } catch {}
            }
          }
          // Fallback: click any aria-collapsed accordion buttons
          document.querySelectorAll('[aria-expanded="false"]').forEach(el => {
            const text = (el.textContent || '').trim();
            if (/tokens?\\s*\\)/i.test(text) && text.length < 150) {
              try { el.click(); count++; } catch {}
            }
          });
          return count;
        })()
      `);
      if (expandCount > 0) {
        console.log(`Scrape: expanded ${expandCount} accordion section(s)`);
        await new Promise(r => setTimeout(r, 2000)); // Wait for React to re-render
      }
    } catch (e) {
      console.log('Scrape: accordion expansion failed (non-fatal):', e.message);
    }

    // Scrape the rendered page
    const scraped = await scrapeWin.webContents.executeJavaScript(`
      (function() {
        // Helper to get meta tags
        const getMeta = (name) => {
          const el = document.querySelector('meta[property="' + name + '"]') ||
                     document.querySelector('meta[name="' + name + '"]');
          return el ? el.getAttribute('content') : '';
        };

        // Get character images only — filter to JanitorAI CDN URLs
        // Character avatars/galleries live on ella.janitorai.com or pics.janitorai.com
        // with paths like /bot-avatars/ or /media-approved/
        const images = [];
        const seen = new Set();
        document.querySelectorAll('img').forEach(img => {
          const src = img.src || '';
          if (!src || src.includes('data:') || src.includes('svg')) return;
          // Only include images from JanitorAI's own CDN (character content)
          const isJanitorCdn = src.includes('ella.janitorai.com') || src.includes('pics.janitorai.com');
          const isBotContent = src.includes('bot-avatars') || src.includes('media-approved');
          if (isJanitorCdn && isBotContent && !seen.has(src)) {
            seen.add(src);
            images.push(src);
          }
        });

        // Get full page text as fallback only
        const bodyText = document.body ? document.body.innerText : '';

        // -----------------------------------------------------------------
        // Targeted field extraction — scrape specific card definition fields
        // from the JanitorAI character page sections.
        // JanitorAI shows labeled sections like "PERSONALITY (1135 TOKENS)",
        // "SCENARIO (307 TOKENS)", "FIRST MESSAGE (455 TOKENS)", etc.
        // -----------------------------------------------------------------
        const targetedFields = {};
        try {
          // Strategy: find all heading-like elements whose text matches known
          // section labels, then grab the content from the next sibling/parent
          // container. JanitorAI uses React + Chakra UI, so the structure is
          // typically: a <p>/<span>/<h*> with the label, and the content in a
          // nearby sibling or parent container's subsequent child.

          // First, click all "expand" / "show more" buttons to reveal full text
          const expandButtons = document.querySelectorAll('button, [role="button"], span, div');
          for (const btn of expandButtons) {
            const text = (btn.textContent || '').toLowerCase().trim();
            if (/^(show more|read more|expand|see more|view more|show all)/.test(text)) {
              try { btn.click(); } catch {}
            }
          }

          // Map of section label patterns to field names
          // NOTE: double-escape \\s, \\d etc. because this code is inside a template literal
          const sectionMap = [
            { pattern: /^personality/i, field: 'personality' },
            { pattern: /^scenario/i, field: 'scenario' },
            { pattern: /^first\\s*message/i, field: 'first_message' },
            { pattern: /^initial\\s*messages?/i, field: 'first_message' },
            { pattern: /^example\\s*dialog/i, field: 'example_dialogs' },
            { pattern: /^description/i, field: 'description' },
          ];

          // Strategy 0: JanitorAI accordion panels — use aria-controls to
          // map accordion buttons to their content panels directly.
          // Structure: <button aria-controls="panel-info-N">...<span>TITLE</span>...</button>
          //            <div id="panel-info-N" role="region">...content...</div>
          const accordionBtns = document.querySelectorAll('button[aria-controls]');
          for (const btn of accordionBtns) {
            const titleSpan = btn.querySelector('[class*="AccordionTitleText"], [class*="accordionTitle"]');
            const titleText = (titleSpan ? titleSpan.textContent : btn.textContent || '').trim();
            const cleanTitle = titleText.replace(/\\s*\\(\\d+\\s*tokens?\\)\\s*/i, '').trim();

            for (const { pattern, field } of sectionMap) {
              if (!pattern.test(cleanTitle)) continue;
              if (targetedFields[field]) continue;

              const panelId = btn.getAttribute('aria-controls');
              const panel = panelId ? document.getElementById(panelId) : null;
              if (panel && panel.innerText && panel.innerText.trim().length > 5) {
                targetedFields[field] = panel.innerText.trim();
              }
              break;
            }
          }

          // Generic fallback: find section labels by scanning all text-bearing elements
          const candidates = document.querySelectorAll('p, span, h1, h2, h3, h4, h5, h6, div, label');
          for (const el of candidates) {
            // Only check direct text content (not children) to avoid matching deeply nested text
            const directText = [...el.childNodes]
              .filter(n => n.nodeType === Node.TEXT_NODE)
              .map(n => n.textContent.trim())
              .join(' ')
              .trim();

            if (!directText) continue;

            // Match against known section labels (with optional token count like "(1135 TOKENS)")
            const cleanLabel = directText.replace(/\\s*\\(\\d+\\s*tokens?\\)\\s*/i, '').trim();

            for (const { pattern, field } of sectionMap) {
              if (!pattern.test(cleanLabel)) continue;
              if (targetedFields[field]) continue; // already found

              // Strategy 1: look for a sibling element that contains the section content
              let contentEl = el.nextElementSibling;
              // Skip small elements that might be sub-labels or icons
              while (contentEl && contentEl.innerText && contentEl.innerText.trim().length < 10) {
                contentEl = contentEl.nextElementSibling;
              }

              if (contentEl && contentEl.innerText && contentEl.innerText.trim().length > 5) {
                targetedFields[field] = contentEl.innerText.trim();
                break;
              }

              // Strategy 2: the label and content may be in the same parent container.
              // The content is usually the larger text block within the parent.
              const parent = el.parentElement;
              if (parent) {
                const children = [...parent.children];
                // Find the largest text block in the parent that isn't the label itself
                let bestChild = null;
                let bestLen = 0;
                for (const child of children) {
                  if (child === el) continue;
                  const childText = (child.innerText || '').trim();
                  if (childText.length > bestLen && childText.length > 5) {
                    bestChild = child;
                    bestLen = childText.length;
                  }
                }
                if (bestChild) {
                  targetedFields[field] = bestChild.innerText.trim();
                  break;
                }

                // Strategy 3: go up one more level — the parent's parent
                const grandparent = parent.parentElement;
                if (grandparent) {
                  // Look for the content section after the label's container
                  let sibling = parent.nextElementSibling;
                  while (sibling && sibling.innerText && sibling.innerText.trim().length < 10) {
                    sibling = sibling.nextElementSibling;
                  }
                  if (sibling && sibling.innerText && sibling.innerText.trim().length > 5) {
                    targetedFields[field] = sibling.innerText.trim();
                    break;
                  }
                }
              }
            }
          }

          // Try to grab the character name from the page heading
          // JanitorAI shows the name prominently at the top
          const nameEl = document.querySelector('h1, h2, [class*="name" i], [class*="title" i]');
          if (nameEl && nameEl.innerText) {
            const nameText = nameEl.innerText.trim();
            // Only use it if it looks like a name (not too long, not navigation text)
            if (nameText.length > 0 && nameText.length < 100 && !nameText.includes('\\n')) {
              targetedFields.name = nameText.split('\\n')[0].trim();
            }
          }

          // Try to grab tags from tag-like elements.
          // JanitorAI uses Chakra UI — tags are small pill/badge elements with
          // emoji + short text like "👩‍🦰 Female", "⛓️ Dominant", "🌗 Switch".
          // Broaden selectors to catch Chakra's generated class names too.
          const tagElements = document.querySelectorAll(
            '[class*="tag" i], [class*="chip" i], [class*="badge" i], ' +
            '[class*="pill" i], [class*="label" i], [class*="category" i]'
          );
          const tags = [];
          const seenTags = new Set();
          for (const tagEl of tagElements) {
            const tagText = (tagEl.innerText || '').trim();
            const tagLower = tagText.toLowerCase();
            // Filter out non-tag elements (buttons, nav items, metadata, etc.)
            if (tagText && tagText.length > 1 && tagText.length < 50
                && !tagText.includes('\\n') && !seenTags.has(tagLower)
                && !/^(show|hide|expand|collapse|more|less|edit|delete|copy|share|report|login|sign|updated|published|created)/i.test(tagText)) {
              seenTags.add(tagLower);
              tags.push(tagText);
            }
          }
          if (tags.length > 0) targetedFields.tags = tags;

          // -----------------------------------------------------------------
          // Fallback: if DOM traversal found no content fields, parse bodyText
          // line-by-line for section labels. More robust against DOM changes.
          // -----------------------------------------------------------------
          const contentFieldNames = ['personality', 'scenario', 'description', 'first_message', 'example_dialogs'];
          const hasContentFields = contentFieldNames.some(f => targetedFields[f]);

          if (!hasContentFields && bodyText.length > 100) {
            const btLines = bodyText.split('\\n');
            const btPatterns = [
              { re: /^personality(?:\\s*\\(?\\d+\\s*tokens?\\)?)?:?\\s*$/i, field: 'personality' },
              { re: /^scenario(?:\\s*\\(?\\d+\\s*tokens?\\)?)?:?\\s*$/i, field: 'scenario' },
              { re: /^description(?:\\s*\\(?\\d+\\s*tokens?\\)?)?:?\\s*$/i, field: 'description' },
              { re: /^first\\s*message(?:\\s*\\(?\\d+\\s*tokens?\\)?)?:?\\s*$/i, field: 'first_message' },
              { re: /^initial\\s*messages?(?:\\s*\\(?\\d+\\s*tokens?\\)?)?:?\\s*$/i, field: 'first_message' },
              { re: /^example\\s*dialog(?:ue)?s?(?:\\s*\\(?\\d+\\s*tokens?\\)?)?:?\\s*$/i, field: 'example_dialogs' },
            ];

            const sectionPositions = [];
            for (let i = 0; i < btLines.length; i++) {
              const trimmed = btLines[i].trim();
              if (!trimmed) continue;
              for (const { re, field } of btPatterns) {
                if (re.test(trimmed)) {
                  sectionPositions.push({ lineIndex: i, field });
                  break;
                }
              }
            }

            for (let s = 0; s < sectionPositions.length; s++) {
              const { lineIndex, field } = sectionPositions[s];
              const endLine = s + 1 < sectionPositions.length
                ? sectionPositions[s + 1].lineIndex
                : Math.min(lineIndex + 150, btLines.length);
              const content = btLines.slice(lineIndex + 1, endLine).join('\\n').trim();
              if (content.length > 5 && !targetedFields[field]) {
                targetedFields[field] = content;
              }
            }
          }

        } catch (e) {
          // Non-fatal — fall through to bodyText
        }

        // Try to extract character data from embedded page state.
        // JanitorAI (and many React/Next.js SPAs) embed character JSON in
        // script tags or the React fiber tree — this often contains the
        // first_message/greeting that isn't visible on the profile page.
        let embeddedCharData = null;
        try {
          // Approach 1: __NEXT_DATA__ (Next.js pages)
          const nextDataEl = document.querySelector('script#__NEXT_DATA__');
          if (nextDataEl) {
            const nd = JSON.parse(nextDataEl.textContent);
            const props = nd?.props?.pageProps;
            if (props?.character) embeddedCharData = props.character;
            else if (props?.data) embeddedCharData = props.data;
          }

          // Approach 2: Scan all script tags for JSON containing first_message
          if (!embeddedCharData) {
            const scripts = document.querySelectorAll('script:not([src])');
            for (const s of scripts) {
              const txt = s.textContent || '';
              if (txt.includes('first_message') || txt.includes('firstMessage') || txt.includes('greeting')) {
                // First try assignment payloads: window.__data = {...} or self.__next_f = [...]
                const assignMatch = txt.match(/(?:window\\.__data|self\\.__next_f)\\s*=\\s*(\\[.*\\]|\\{.*\\})/s);
                if (!embeddedCharData && assignMatch) {
                  try { embeddedCharData = JSON.parse(assignMatch[1]); } catch {}
                }

                // Fallback: find a nearby JSON object containing greeting keys.
                // Non-greedy with dotAll to avoid spanning entire script blocks.
                if (!embeddedCharData) {
                  const match = txt.match(/\\{[^]*?\\b(?:first_message|firstMessage|greeting)\\b[^]*?\\}/s);
                  if (match) {
                    try { embeddedCharData = JSON.parse(match[0]); } catch {}
                  }
                }
              }
            }
          }
        } catch (e) {
          // Non-fatal — fall through to bodyText
        }

        return JSON.stringify({
          title: document.title,
          url: window.location.href,
          ogTitle: getMeta('og:title'),
          ogDescription: getMeta('og:description'),
          ogImage: getMeta('og:image'),
          images: images,
          bodyText: bodyText,
          targetedFields: targetedFields,
          embeddedCharData: embeddedCharData,
        });
      })()
    `);

    const data = JSON.parse(scraped);
    // Attach detected JAI username so urlImportService can restore {{user}} placeholders
    if (jaiUsername) {
      data.jaiUsername = jaiUsername;
    }
    // Flag unauthenticated session so the caller can warn the user
    if (isLoggedIn === false) {
      data.notLoggedIn = true;
    }
    console.log(`Scrape: got ${data.bodyText.length} chars of text, ${data.images.length} images, title="${data.title}"${jaiUsername ? `, jaiUser="${jaiUsername}"` : ''}`);

    // Log targeted field extraction results
    if (data.targetedFields && Object.keys(data.targetedFields).length > 0) {
      const fieldSummary = Object.entries(data.targetedFields)
        .filter(([k]) => k !== 'tags')
        .map(([k, v]) => `${k}: ${typeof v === 'string' ? v.length + ' chars' : 'present'}`)
        .join(', ');
      const tagCount = Array.isArray(data.targetedFields.tags) ? data.targetedFields.tags.length : 0;
      console.log(`Scrape: targeted fields found: ${fieldSummary}${tagCount > 0 ? `, tags: ${tagCount}` : ''}`);
    } else {
      console.log('Scrape: no targeted fields extracted from DOM');
    }

    // Prefer API identifiers/primary fields while retaining extra embedded fields.
    if (apiCharacterData && (apiCharacterData.name || apiCharacterData.first_message)) {
      data.embeddedCharData = { ...(data.embeddedCharData || {}) };
      for (const [key, value] of Object.entries(apiCharacterData)) {
        if (value !== null && value !== undefined && value !== '') {
          data.embeddedCharData[key] = value;
        }
      }
      console.log(`Scrape: using in-page API data (keys: ${Object.keys(apiCharacterData).join(', ')})`);
    }

    // If we found embedded character data with a first message, attach it
    if (data.embeddedCharData) {
      const ecd = data.embeddedCharData;
      const firstMsg = ecd.first_message || ecd.firstMessage || ecd.greeting || '';
      if (firstMsg) {
        console.log(`Scrape: found embedded first message (${firstMsg.length} chars)`);
        data.firstMessage = firstMsg;
      }
      // Also grab structured fields if available
      if (ecd.personality) data.embeddedPersonality = ecd.personality;
      if (ecd.scenario) data.embeddedScenario = ecd.scenario;
      if (ecd.description) data.embeddedDescription = ecd.description;
      if (ecd.mes_example || ecd.example_dialogs || ecd.exampleDialogue) {
        data.embeddedExampleDialogue = ecd.mes_example || ecd.example_dialogs || ecd.exampleDialogue;
      }
      // Extract alternate greetings and other card fields for direct import
      if (Array.isArray(ecd.alternate_greetings) && ecd.alternate_greetings.length > 0) {
        data.alternateGreetings = ecd.alternate_greetings;
        console.log(`Scrape: found ${ecd.alternate_greetings.length} alternate greeting(s)`);
      }
      if (ecd.name) data.embeddedName = ecd.name;
      if (Array.isArray(ecd.tags)) data.embeddedTags = ecd.tags;
      if (ecd.creator) data.embeddedCreator = ecd.creator;
      if (ecd.creator_notes) data.embeddedCreatorNotes = ecd.creator_notes;
      if (ecd.system_prompt) data.embeddedSystemPrompt = ecd.system_prompt;
      if (ecd.post_history_instructions) data.embeddedPostHistoryInstructions = ecd.post_history_instructions;
      if (ecd.extensions) data.embeddedExtensions = ecd.extensions;
    }

    // --- Phase 2: Navigate to the chat page to capture messages ---
    data.chatMessages = [];
    try {
      // Find a chat link or "Start Chat" button on the character page.
      // JanitorAI uses a React SPA — buttons may not be plain <a> tags.
      // Strategy: try multiple selectors, then fall back to text-matching on all clickable elements.
      const chatUrl = await scrapeWin.webContents.executeJavaScript(`
        (function() {
          const toSafeHttpHref = (value) => {
            if (!value) return null;
            try {
              const parsed = new URL(value, window.location.href);
              if (parsed.protocol === 'http:' || parsed.protocol === 'https:') {
                return parsed.href;
              }
            } catch {
              return null;
            }
            return null;
          };

          // 1. Look for links to /chats/
          const chatLink = document.querySelector('a[href*="/chats/"]');
          if (chatLink) {
            const safeHref = toSafeHttpHref(chatLink.href);
            if (safeHref) return safeHref;
          }

          // 2. Look for any clickable element whose text contains "chat"
          // JanitorAI uses Chakra UI buttons that may say "Continue latest chat",
          // "Start chat", etc. — match any element containing the word "chat".
          const allClickable = [...document.querySelectorAll(
            'button, a, [role="button"], [role="link"], [tabindex], ' +
            '[class*="chat" i], [class*="Chat"], [class*="start" i]'
          )];
          for (const el of allClickable) {
            const text = (el.textContent || '').toLowerCase().trim();
            if (/\\bchat\\b/.test(text)) {
              const safeHref = toSafeHttpHref(el.href);
              if (safeHref) return safeHref;
              el.click();
              return '__clicked__';
            }
          }

          // 3. Broaden search: check ALL elements (divs, spans, etc.) for chat-like text
          // Some SPAs render clickable elements as plain divs with event listeners
          const allElements = [...document.querySelectorAll('div, span, p')];
          const MAX_BROAD_SCAN_ELEMENTS = 500;
          if (allElements.length > MAX_BROAD_SCAN_ELEMENTS) {
            // Avoid scanning huge SPAs in this expensive fallback path.
            return null;
          }

          for (let i = 0; i < Math.min(allElements.length, MAX_BROAD_SCAN_ELEMENTS); i++) {
            const el = allElements[i];
            const directText = [...el.childNodes]
              .filter(n => n.nodeType === Node.TEXT_NODE)
              .map(n => n.textContent.trim())
              .join(' ').toLowerCase();
            if (directText && /\\bchat\\b/.test(directText)) {
              const safeHref = toSafeHttpHref(el.closest('a')?.href);
              if (safeHref) return safeHref;
              el.click();
              return '__clicked__';
            }
          }

          return null;
        })()
      `);

      if (chatUrl) {
        console.log(`Scrape: found chat target: ${chatUrl}`);

        if (chatUrl !== '__clicked__') {
          let safeChatUrl = null;
          try {
            const parsed = new URL(chatUrl);
            if (parsed.protocol === 'http:' || parsed.protocol === 'https:') {
              safeChatUrl = parsed.href;
            }
          } catch {
            safeChatUrl = null;
          }

          if (!safeChatUrl) {
            throw new Error('Unsafe or invalid chat URL discovered');
          }

          // Navigate directly to the chat URL
          await scrapeWin.loadURL(safeChatUrl);
        }

        // Wait for chat page to load — look for message content
        const chatStart = Date.now();
        let chatReady = false;
        while (!chatReady && (Date.now() - chatStart) < CHAT_POLL_TIMEOUT_MS) {
          await new Promise(r => setTimeout(r, 1000));
          try {
            chatReady = await scrapeWin.webContents.executeJavaScript(`
              (function() {
                const url = window.location.href;
                if (!url.includes('/chats/')) return false;
                const text = document.body ? document.body.innerText : '';
                return text.length > 100;
              })()
            `);
          } catch { /* still loading */ }
        }

        if (chatReady) {
          const stableLen = await waitForTextStabilization(scrapeWin, 15000);
          console.log(`Scrape: chat text stabilized at ${stableLen} chars`);

          await expandAndScrollToTop(scrapeWin);
          data.chatMessages = await extractChatMessages(scrapeWin);
          console.log(`Scrape: captured ${data.chatMessages.length} chat message(s)`);
        } else {
          console.log('Scrape: chat page did not load in time, skipping chat capture');
        }
      } else {
        console.log('Scrape: no chat button/link found on character page');

        // Fallback: if no first message was found via embedded data or chat button,
        // try clicking a validated chat CTA based on label/ARIA intent, while
        // excluding destructive actions.
        if (!data.firstMessage) {
          console.log('Scrape: trying fallback — clicking validated chat CTA on page');
          const clicked = await scrapeWin.webContents.executeJavaScript(`
            (function() {
              const normalize = (s) => String(s || '').toLowerCase().replace(/\s+/g, ' ').trim();
              const allowRe = /\b(chat|start chat|continue|continue chat|continue latest chat|open chat|begin chat|message|talk)\b/i;
              const denyRe = /\b(delete|remove|block|ban|report|logout|log out|sign out|unsubscribe|cancel|close account|hide)\b/i;

              const candidates = [...document.querySelectorAll(
                'button, [role="button"], a, [role="link"], [class*="btn" i], [class*="button" i], [class*="cta" i]'
              )];
              if (candidates.length === 0) return false;

              const scored = [];
              for (const el of candidates) {
                const r = el.getBoundingClientRect();
                const style = window.getComputedStyle(el);
                if (r.width < 40 || r.height < 26) continue;
                if (style.visibility === 'hidden' || style.display === 'none') continue;

                const role = normalize(el.getAttribute('role'));
                const tag = normalize(el.tagName);
                const text = normalize(el.textContent);
                const ariaLabel = normalize(el.getAttribute('aria-label'));
                const title = normalize(el.getAttribute('title'));
                const label = [text, ariaLabel, title].filter(Boolean).join(' ');

                const hasButtonRole = role === 'button' || role === 'link' || tag === 'button' || tag === 'a';
                if (!hasButtonRole) continue;
                if (!allowRe.test(label)) continue;
                if (denyRe.test(label)) continue;

                const score = (r.width * r.height) + (allowRe.test(text) ? 500 : 0) + (tag === 'button' ? 200 : 0);
                scored.push({ el, score, label: label.substring(0, 80) });
              }

              scored.sort((a, b) => b.score - a.score);
              const best = scored[0];
              if (!best) return false;

              console.log('Scrape fallback: clicking validated CTA', best.label);
              best.el.click();
              return true;
            })()
          `);

          if (clicked) {
            // Wait for navigation to a chat page
            const fallbackStart = Date.now();
            let chatReady = false;
            while (!chatReady && (Date.now() - fallbackStart) < CHAT_POLL_TIMEOUT_MS) {
              await new Promise(r => setTimeout(r, 1000));
              try {
                chatReady = await scrapeWin.webContents.executeJavaScript(`
                  (function() {
                    const url = window.location.href;
                    if (!url.includes('/chats/') && !url.includes('/chat')) return false;
                    const text = document.body ? document.body.innerText : '';
                    return text.length > 100;
                  })()
                `);
              } catch { /* still loading */ }
            }

            if (chatReady) {
              const stableLen = await waitForTextStabilization(scrapeWin, 15000);
              console.log(`Scrape: fallback click reached chat page (${stableLen} chars)`);

              await expandAndScrollToTop(scrapeWin);
              data.chatMessages = await extractChatMessages(scrapeWin);
              console.log(`Scrape: fallback captured ${data.chatMessages.length} chat message(s)`);
            } else {
              console.log('Scrape: fallback click did not reach a chat page');
            }
          }
        }
      }
    } catch (chatErr) {
      console.log(`Scrape: chat capture failed (non-fatal): ${chatErr.message}`);
    }

    return data;
  } finally {
    if (cdpAttached) {
      try { scrapeWin.webContents.debugger.detach(); } catch {}
    }
    if (!scrapeWin.isDestroyed()) scrapeWin.close();
  }
}


// ---------------------------------------------------------------------------
// JanitorAI Login Popup — opens a real browser window so the user can log in.
// Intercepts outgoing requests to kim.janitorai.com to capture the Bearer token.
// Uses a persistent session partition so cookies survive across app restarts.
// ---------------------------------------------------------------------------

async function openLoginWindow() {
  if (loginWindow) {
    loginWindow.focus();
    throw new Error('Login window is already open');
  }

  const loginPartition = 'persist:janitorai';
  const loginSession = session.fromPartition(loginPartition);

  // Strip "Electron/..." from the user-agent so Cloudflare doesn't flag us as a bot.
  const defaultUA = loginSession.getUserAgent();
  const cleanUA = defaultUA.replace(/\s*Electron\/\S+/i, '');
  loginSession.setUserAgent(cleanUA);

  // Clear stale Supabase auth-token cookies so checkLoggedIn doesn't
  // false-positive on expired tokens from a previous session.
  // Keep all other cookies (Cloudflare clearance, preferences, etc.) intact.
  try {
    const allCookies = await loginSession.cookies.get({});
    for (const c of allCookies) {
      if (c.name.includes('auth-token')) {
        const cookieUrl = `https://${c.domain.replace(/^\./, '')}${c.path || '/'}`;
        await loginSession.cookies.remove(cookieUrl, c.name);
        console.log(`Cleared stale auth cookie: ${c.name}`);
      }
    }
  } catch (e) {
    console.log('Could not clear stale auth cookies:', e.message);
  }

  // Allow all permission requests (needed for CAPTCHAs like Turnstile/hCaptcha)
  loginSession.setPermissionRequestHandler((_webContents, _permission, callback) => {
    callback(true);
  });
  loginSession.setPermissionCheckHandler(() => true);

  return new Promise((resolve, reject) => {
    loginWindow = new BrowserWindow({
      width: 1000,
      height: 750,
      title: 'Login to JanitorAI',
      webPreferences: {
        nodeIntegration: false,
        contextIsolation: true,
        partition: loginPartition,
      },
    });

    let done = false;
    let pollInterval = null;
    let capturedToken = null;

    const timeout = setTimeout(() => {
      if (!done) {
        done = true;
        cleanupListeners();
        cleanup();
        closeWindow();
        reject(new Error('Login timed out after 5 minutes'));
      }
    }, LOGIN_TIMEOUT_MS);

    // --- Token capture: intercept Authorization header from API calls ---
    loginSession.webRequest.onBeforeSendHeaders(
      { urls: ['*://kim.janitorai.com/*'] },
      (details, callback) => {
        const auth = details.requestHeaders['Authorization'] || details.requestHeaders['authorization'];
        if (auth && !capturedToken) {
          capturedToken = auth.replace(/^Bearer\s+/i, '');
          console.log('Captured JanitorAI auth token from API request header');
        }
        callback({ requestHeaders: details.requestHeaders });
      }
    );

    function cleanupListeners() {
      try {
        loginSession.webRequest.onBeforeSendHeaders(null);
      } catch { /* ignore */ }
    }

    function cleanup() {
      clearTimeout(timeout);
      if (pollInterval) clearInterval(pollInterval);
    }

    function closeWindow() {
      if (loginWindow && !loginWindow.isDestroyed()) {
        loginWindow.close();
      }
    }

    // --- Token extraction: try multiple methods after login ---
    // Returns a valid JWT string or null. Does NOT close the window.
    async function extractToken() {
      // Method 1: Already captured via webRequest interceptor
      if (capturedToken) {
        console.log('Token already captured via webRequest interceptor');
        return capturedToken;
      }

      // Method 2: Search cookies for Supabase auth token
      try {
        const allCookies = await loginSession.cookies.get({});
        // Look for chunked Supabase auth cookies (sb-*-auth-token.0, .1, etc.)
        const authChunks = allCookies
          .filter(c => c.name.includes('auth-token'))
          .sort((a, b) => a.name.localeCompare(b.name));

        if (authChunks.length > 0) {
          console.log(`Found ${authChunks.length} auth-token cookie(s): ${authChunks.map(c => c.name).join(', ')}`);
          // Concatenate chunked cookie values
          const fullValue = authChunks.map(c => c.value).join('');
          if (fullValue.startsWith('base64-')) {
            try {
              const decoded = Buffer.from(fullValue.substring(7), 'base64').toString('utf-8');
              const parsed = JSON.parse(decoded);
              if (parsed.access_token) {
                console.log('Extracted access_token from Supabase auth cookie');
                return parsed.access_token;
              }
            } catch (e) {
              console.log('Could not decode auth cookie:', e.message);
            }
          }
          // Try the raw value as a token
          if (fullValue.startsWith('eyJ')) {
            console.log('Auth cookie value is a JWT');
            return fullValue;
          }
        }
      } catch (e) {
        console.log('Could not read cookies:', e.message);
      }

      // Method 3: Try localStorage via page JS execution
      if (loginWindow && !loginWindow.isDestroyed()) {
        try {
          const result = await loginWindow.webContents.executeJavaScript(`
            (function() {
              for (let i = 0; i < localStorage.length; i++) {
                const key = localStorage.key(i);
                const val = localStorage.getItem(key);
                if (!val || val.length < 50) continue;
                if (key.includes('auth') || key.includes('sb-') || key.includes('token') || key.includes('supabase')) {
                  try {
                    let data = val;
                    if (data.startsWith('base64-')) data = atob(data.substring(7));
                    const parsed = JSON.parse(data);
                    if (parsed.access_token) return parsed.access_token;
                  } catch {}
                  if (val.startsWith('eyJ')) return val;
                }
              }
              return null;
            })()
          `);
          if (result) {
            console.log('Extracted token from localStorage');
            return result;
          }
        } catch (e) {
          console.log('Could not access localStorage:', e.message);
        }
      }

      // Method 4: Navigate to homepage to trigger API calls, then check interceptor
      if (loginWindow && !loginWindow.isDestroyed()) {
        try {
          console.log('Navigating to JanitorAI homepage to trigger API calls...');
          loginWindow.loadURL('https://janitorai.com/');
          // Wait for API calls to fire
          await new Promise(r => setTimeout(r, 4000));
          if (capturedToken) {
            console.log('Token captured after homepage navigation');
            return capturedToken;
          }
        } catch (e) {
          console.log('Could not navigate for token capture:', e.message);
        }
      }

      console.log('Could not extract auth token via any method');
      return null;
    }

    // Detect login success, extract a valid token, and ONLY THEN close the window.
    // We require an actual JWT (starts with "eyJ") before considering login complete.
    async function checkLoggedIn() {
      if (done || !loginWindow || loginWindow.isDestroyed()) return;

      try {
        // Check for any login signal: captured Bearer token OR fresh auth-token cookies
        let loginSignal = null;
        if (capturedToken) {
          loginSignal = 'Bearer token from API request';
        } else {
          const cookies = await loginSession.cookies.get({ url: 'https://janitorai.com' });
          const hasAuthTokenCookie = cookies.some(c => c.name.includes('auth-token'));
          if (hasAuthTokenCookie) {
            loginSignal = `auth-token cookie (${cookies.length} cookies total)`;
          }
        }

        if (!loginSignal) return; // no login detected yet

        console.log(`JanitorAI login signal detected: ${loginSignal}`);
        console.log('Attempting to extract a valid auth token before closing window...');

        // Give the page a moment to settle after login
        await new Promise(r => setTimeout(r, 1500));

        const token = await extractToken();

        if (token && token.startsWith('eyJ')) {
          // Confirmed valid JWT — safe to close now
          done = true;
          console.log(`JanitorAI auth token confirmed (${token.length} chars), closing login window`);
          cleanupListeners();
          cleanup();
          closeWindow();
          resolve({ loggedIn: true, token });
        } else {
          // Signal looked promising but we couldn't get a real token.
          // Keep the window open so the user can finish logging in.
          console.log(`Login signal detected but no valid JWT extracted (got: ${token ? token.substring(0, 20) + '...' : 'null'}). Keeping window open.`);
        }
      } catch (e) {
        // Ignore — window may have been destroyed
      }
    }

    // Check after page loads and on SPA navigation
    loginWindow.webContents.on('did-finish-load', () => {
      setTimeout(checkLoggedIn, 1500);
    });
    loginWindow.webContents.on('did-navigate-in-page', () => {
      setTimeout(checkLoggedIn, 1500);
    });

    // Poll periodically as a fallback
    setTimeout(() => {
      if (done) return;
      pollInterval = setInterval(checkLoggedIn, 2000);
    }, 3000);

    // Allow popups for OAuth flows (same session so cookies are shared).
    loginWindow.webContents.setWindowOpenHandler(({ url: popupUrl }) => {
      return {
        action: 'allow',
        overrideBrowserWindowOptions: {
          webPreferences: {
            partition: loginPartition,
          },
        },
      };
    });

    loginWindow.on('closed', () => {
      loginWindow = null;
      if (!done) {
        done = true;
        clearTimeout(timeout);
        if (pollInterval) clearInterval(pollInterval);
        cleanupListeners();
        reject(new Error('Login window was closed'));
      }
    });

    loginWindow.loadURL('https://janitorai.com/login');
    console.log('Opened JanitorAI login popup window (login page)');
  });
}

// ---------------------------------------------------------------------------
// Character.AI Login Window
// Opens a BrowserWindow to character.ai for login, captures the auth token
// from the Authorization header (Token ...) on requests to neo.character.ai.
// ---------------------------------------------------------------------------

async function openCAILoginWindow() {
  if (caiLoginWindow) {
    caiLoginWindow.focus();
    throw new Error('Character.AI login window is already open');
  }

  const loginPartition = 'persist:characterai';
  const loginSession = session.fromPartition(loginPartition);

  // Strip "Electron/..." from the user-agent so Cloudflare doesn't flag us
  const defaultUA = loginSession.getUserAgent();
  const cleanUA = defaultUA.replace(/\s*Electron\/\S+/i, '');
  loginSession.setUserAgent(cleanUA);

  // Allow all permission requests (needed for CAPTCHAs)
  loginSession.setPermissionRequestHandler((_webContents, _permission, callback) => {
    callback(true);
  });
  loginSession.setPermissionCheckHandler(() => true);

  return new Promise((resolve, reject) => {
    caiLoginWindow = new BrowserWindow({
      width: 1000,
      height: 750,
      title: 'Login to Character.AI',
      webPreferences: {
        nodeIntegration: false,
        contextIsolation: true,
        partition: loginPartition,
      },
    });

    let done = false;
    let pollInterval = null;
    let capturedToken = null;

    const timeout = setTimeout(() => {
      if (!done) {
        done = true;
        cleanupListeners();
        cleanup();
        closeWindow();
        reject(new Error('Character.AI login timed out after 5 minutes'));
      }
    }, LOGIN_TIMEOUT_MS);

    // --- Token capture: intercept Authorization header from c.ai API calls ---
    // Character.AI uses "Token {value}" format (not "Bearer")
    loginSession.webRequest.onBeforeSendHeaders(
      { urls: ['*://neo.character.ai/*', '*://plus.character.ai/*'] },
      (details, callback) => {
        const auth = details.requestHeaders['Authorization'] || details.requestHeaders['authorization'];
        if (auth && !capturedToken) {
          capturedToken = auth.replace(/^Token\s+/i, '').trim();
          console.log('Captured Character.AI auth token from API request header');
        }
        callback({ requestHeaders: details.requestHeaders });
      },
    );

    function cleanupListeners() {
      try {
        loginSession.webRequest.onBeforeSendHeaders(null);
      } catch { /* ignore */ }
    }

    function cleanup() {
      clearTimeout(timeout);
      if (pollInterval) clearInterval(pollInterval);
    }

    function closeWindow() {
      if (caiLoginWindow && !caiLoginWindow.isDestroyed()) {
        caiLoginWindow.close();
      }
    }

    // --- Token extraction ---
    async function extractToken() {
      // Method 1: Already captured via webRequest interceptor
      if (capturedToken) {
        console.log('CAI token already captured via webRequest interceptor');
        return capturedToken;
      }

      // Method 2: Try localStorage — c.ai stores token under char_token or similar keys
      if (caiLoginWindow && !caiLoginWindow.isDestroyed()) {
        try {
          const result = await caiLoginWindow.webContents.executeJavaScript(`
            (function() {
              for (let i = 0; i < localStorage.length; i++) {
                const key = localStorage.key(i);
                const val = localStorage.getItem(key);
                if (!val || val.length < 50) continue;
                if (key.includes('token') || key.includes('auth') || key.includes('char_token')) {
                  try {
                    const parsed = JSON.parse(val);
                    if (parsed.value) return parsed.value;
                    if (parsed.access_token) return parsed.access_token;
                  } catch {}
                  // Raw long string could be a token
                  if (val.length > 100) return val;
                }
              }
              return null;
            })()
          `);
          if (result) {
            console.log('Extracted CAI token from localStorage');
            return result;
          }
        } catch (e) {
          console.log('Could not access CAI localStorage:', e.message);
        }
      }

      console.log('Could not extract CAI auth token via any method');
      return null;
    }

    // Detect login success, extract token, then close window
    async function checkLoggedIn() {
      if (done || !caiLoginWindow || caiLoginWindow.isDestroyed()) return;

      try {
        let loginSignal = null;
        if (capturedToken) {
          loginSignal = 'Token from API request';
        }

        if (!loginSignal) return;

        console.log(`Character.AI login signal detected: ${loginSignal}`);
        await new Promise(r => setTimeout(r, 1500));

        const token = await extractToken();
        if (token && token.length > 0) {
          done = true;
          console.log(`Character.AI auth token confirmed (${token.length} chars), closing login window`);
          cleanupListeners();
          cleanup();
          closeWindow();
          resolve({ loggedIn: true, token });
        } else {
          console.log('Login signal detected but no valid token extracted. Keeping window open.');
        }
      } catch {
        // Ignore — window may have been destroyed
      }
    }

    // Check after page loads and on SPA navigation
    caiLoginWindow.webContents.on('did-finish-load', () => {
      setTimeout(checkLoggedIn, 2000);
    });
    caiLoginWindow.webContents.on('did-navigate-in-page', () => {
      setTimeout(checkLoggedIn, 1500);
    });

    // Poll periodically as a fallback
    setTimeout(() => {
      if (done) return;
      pollInterval = setInterval(checkLoggedIn, 2000);
    }, 3000);

    // Allow popups for OAuth flows
    caiLoginWindow.webContents.setWindowOpenHandler(({ url: popupUrl }) => {
      return {
        action: 'allow',
        overrideBrowserWindowOptions: {
          webPreferences: {
            partition: loginPartition,
          },
        },
      };
    });

    caiLoginWindow.on('closed', () => {
      caiLoginWindow = null;
      if (!done) {
        done = true;
        clearTimeout(timeout);
        if (pollInterval) clearInterval(pollInterval);
        cleanupListeners();
        reject(new Error('Character.AI login window was closed'));
      }
    });

    caiLoginWindow.loadURL('https://character.ai/');
    console.log('Opened Character.AI login popup window');
  });
}

async function createWindow(port) {
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 800,
    minHeight: 600,
    title: 'Project Braveheart',
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      partition: 'persist:main',
    },
  });

  const url = isDev
    ? 'http://localhost:3000'
    : `http://localhost:${port}`;

  mainWindow.loadURL(url);

  // Open external links in the system browser
  mainWindow.webContents.setWindowOpenHandler(({ url: linkUrl }) => {
    shell.openExternal(linkUrl);
    return { action: 'deny' };
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

async function main() {
  await app.whenReady();

  // Start the Chromium proxy first (needed for Cloudflare bypass)
  let chromiumProxyPort;
  try {
    chromiumProxyPort = await startChromiumProxy();
  } catch (err) {
    console.error('Failed to start Chromium proxy:', err);
  }

  let actualPort;

  if (isDev) {
    // In dev mode, backend runs separately via nodemon on 3001,
    // and Vite dev server runs on 3000 with proxy to 3001.
    actualPort = 3000;

    // Notify the already-running backend about the proxy port
    if (chromiumProxyPort) {
      try {
        await net.fetch('http://localhost:3001/api/internal/set-chromium-proxy', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ port: chromiumProxyPort }),
        });
        console.log(`Notified backend of Chromium proxy port ${chromiumProxyPort}`);
      } catch (err) {
        console.warn('Could not notify backend of Chromium proxy port:', err.message);
      }
    }
  } else {
    // In production, start Express inside this process
    const { startServer } = await import('../backend/server.js');

    const uploadsPath = getUserDataPath('uploads');
    const frontendDistPath = path.join(app.getAppPath(), 'frontend', 'dist');

    serverInstance = await startServer({
      port: 0, // OS picks a free port
      uploadsPath,
      frontendDistPath,
      chromiumProxyPort,
    });

    actualPort = serverInstance.address().port;
  }

  await createWindow(actualPort);

  app.on('activate', async () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      try {
        await createWindow(actualPort);
      } catch (err) {
        console.error('Failed to recreate application window:', err);
      }
    }
  });
}

app.on('window-all-closed', async () => {
  // Close login windows if open
  if (loginWindow && !loginWindow.isDestroyed()) {
    loginWindow.close();
    loginWindow = null;
  }
  if (caiLoginWindow && !caiLoginWindow.isDestroyed()) {
    caiLoginWindow.close();
    caiLoginWindow = null;
  }

  // Shut down the Chromium proxy
  await closeChromiumProxy();

  if (serverInstance) {
    try {
      await Promise.race([
        new Promise((resolve, reject) => {
          serverInstance.close((err) => {
            if (err) {
              reject(err);
              return;
            }
            resolve();
          });
        }),
        new Promise((_, reject) => {
          setTimeout(() => reject(new Error('Timed out while closing embedded server')), SERVER_CLOSE_TIMEOUT_MS);
        }),
      ]);
    } catch (err) {
      console.error('Error during embedded server shutdown:', err);
    } finally {
      serverInstance = null;
    }
  }

  app.quit();
});

main().catch((err) => {
  console.error('Failed to start application:', err);
  app.quit();
});
