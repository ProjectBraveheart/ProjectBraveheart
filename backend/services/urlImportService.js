import axios from 'axios';
import logger from '../utils/logger.js';
import { getChromiumProxyPort } from './chromiumProxy.js';
import {
  URL_IMPORT_REQUEST_TIMEOUT_MS,
  URL_IMPORT_IMAGE_TIMEOUT_MS,
} from '../config/constants.js';

// ---------------------------------------------------------------------------
// Custom error for triggering manual fallback in the frontend
// ---------------------------------------------------------------------------

class ManualFallbackError extends Error {
  constructor(message, platformLabel) {
    super(message);
    this.isManualFallback = true;
    this.platformLabel = platformLabel;
  }
}

// ---------------------------------------------------------------------------
// Chromium proxy fetch — routes requests through Electron's Chromium networking
// stack to bypass Cloudflare TLS fingerprinting. Falls back to null if the
// proxy is not available (e.g. running without Electron).
// ---------------------------------------------------------------------------

function tryParseJson(text) {
  try { return JSON.parse(text); } catch { return text; }
}

/**
 * Make an HTTP GET request via the Electron Chromium proxy.
 * Returns an axios-compatible response shape { status, data, headers }.
 * Throws if the proxy is unavailable or the upstream returns an error status.
 * @param {string} url - Target URL
 * @param {object} headers - Request headers
 * @param {object} options - { timeout, responseType }
 * @returns {Promise<{status: number, data: any, headers: object}>}
 */
/**
 * Scrape a character page via the Electron proxy's authenticated browser.
 * Returns { bodyText, images[], ogTitle, ogDescription, ogImage } or null.
 */
async function chromiumScrape(characterUrl) {
  const proxyPort = getChromiumProxyPort();
  if (!proxyPort) return null;

  try {
    const response = await fetch(`http://127.0.0.1:${proxyPort}/scrape-character`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ characterUrl }),
      signal: AbortSignal.timeout(45000), // 45s — page load + render can be slow
    });
    if (!response.ok) return null;
    return await response.json();
  } catch (err) {
    logger.info(`Scrape fallback failed: ${err.message}`);
    return null;
  }
}

async function chromiumFetch(url, headers = {}, options = {}) {
  const proxyPort = getChromiumProxyPort();
  if (!proxyPort) {
    throw new Error('Chromium proxy not available');
  }

  const { responseType = 'text', timeout = URL_IMPORT_REQUEST_TIMEOUT_MS } = options;

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeout);

  try {
    const response = await fetch(`http://127.0.0.1:${proxyPort}/proxy-fetch`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url, headers, responseType }),
      signal: controller.signal,
    });

    clearTimeout(timeoutId);

    if (!response.ok) {
      const errData = await response.json().catch(() => ({}));
      throw new Error(errData.error || `Proxy returned HTTP ${response.status}`);
    }

    const proxyResult = await response.json();

    // If the upstream returned a non-2xx status, throw with response info
    // so existing error handling (401, 403, 404, etc.) still works
    if (proxyResult.status >= 400) {
      const err = new Error(`HTTP ${proxyResult.status}`);
      err.response = {
        status: proxyResult.status,
        statusText: proxyResult.statusText,
        data: responseType === 'arraybuffer' ? null : tryParseJson(proxyResult.body),
        headers: proxyResult.headers,
      };
      throw err;
    }

    return {
      status: proxyResult.status,
      data: responseType === 'arraybuffer'
        ? Buffer.from(proxyResult.body, 'base64')
        : tryParseJson(proxyResult.body),
      headers: proxyResult.headers,
    };
  } catch (err) {
    clearTimeout(timeoutId);
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Auth token cleaning helpers
// ---------------------------------------------------------------------------

/**
 * Clean a JanitorAI auth token that may have been copied in various formats:
 * - Full localStorage entry: `sb-auth-auth-token:"base64-eyJ..."`
 * - Just the value with quotes: `"base64-eyJ..."`
 * - Just the base64 value: `base64-eyJ...`
 * - Already extracted access_token: `eyJhbGci...`
 *
 * The base64 payload decodes to JSON containing { access_token: "..." }
 */
function cleanJanitorToken(raw) {
  let token = raw.trim();

  // Strip "Bearer " prefix if user copied the full Authorization header value
  if (token.toLowerCase().startsWith('bearer ')) {
    token = token.substring(7).trim();
  }

  // Strip "Authorization: Bearer " if user copied the whole header line
  if (token.toLowerCase().startsWith('authorization:')) {
    token = token.substring(token.indexOf(':') + 1).trim();
    if (token.toLowerCase().startsWith('bearer ')) {
      token = token.substring(7).trim();
    }
  }

  // Strip key prefix if user copied "key:value" from localStorage
  const colonIdx = token.indexOf(':"');
  if (colonIdx !== -1 && colonIdx < 40) {
    token = token.substring(colonIdx + 1);
  }

  // Strip surrounding quotes
  if ((token.startsWith('"') && token.endsWith('"')) || (token.startsWith("'") && token.endsWith("'"))) {
    token = token.slice(1, -1);
  }

  // Handle base64- prefix (Supabase auth format)
  if (token.startsWith('base64-')) {
    const b64 = token.substring(7); // strip "base64-"
    try {
      const decoded = Buffer.from(b64, 'base64').toString('utf-8');
      const parsed = JSON.parse(decoded);
      if (parsed.access_token) {
        return parsed.access_token;
      }
    } catch {
      // Not valid base64 JSON — fall through and use as-is
    }
  }

  // If it looks like a JWT already, use as-is
  if (token.startsWith('eyJ')) {
    return token;
  }

  // Try parsing as JSON in case the whole value is a JSON object
  try {
    const parsed = JSON.parse(token);
    if (parsed.access_token) return parsed.access_token;
  } catch {
    // Not JSON — use as-is
  }

  return token;
}

// ---------------------------------------------------------------------------
// JanitorAI CDN helpers
// ---------------------------------------------------------------------------

const JANITOR_CDN_BASE = 'https://ella.janitorai.com';

/**
 * Try to extract a usable avatar URL from JanitorAI API response data.
 * The CDN uses: https://ella.janitorai.com/bot-avatars/{id}.webp
 * The API may return a full URL, a relative path, or just the ID/hash.
 */
function extractJanitorAvatarUrl(data) {
  // Check common field names for the avatar
  const candidateFields = [
    'avatar', 'avatar_url', 'profile_image', 'bot_avatar',
    'image', 'image_url', 'photo', 'photo_url', 'pic', 'picture',
    'cover_image', 'cover_image_url', 'thumbnail', 'thumbnail_url',
  ];

  let rawValue = null;
  for (const field of candidateFields) {
    if (data[field] && typeof data[field] === 'string' && data[field].trim()) {
      rawValue = data[field].trim();
      logger.info(`JanitorAI avatar: found field "${field}" = "${rawValue.substring(0, 100)}..."`);
      break;
    }
  }

  // If no candidate field found, try nested objects
  if (!rawValue && data.bot?.avatar) {
    rawValue = data.bot.avatar;
  }

  if (!rawValue) {
    // Log all top-level keys to help debug in the future
    logger.info(`JanitorAI avatar: no avatar field found. Response keys: ${Object.keys(data).join(', ')}`);
    return null;
  }

  // If it's already a full URL, use it directly
  if (rawValue.startsWith('http://') || rawValue.startsWith('https://')) {
    return rawValue;
  }

  // If it starts with '/', it's a relative path on the CDN
  if (rawValue.startsWith('/')) {
    return `${JANITOR_CDN_BASE}${rawValue}`;
  }

  // Otherwise treat it as an avatar ID/hash — construct the CDN URL
  // Strip any file extension if already present
  const id = rawValue.replace(/\.(webp|png|jpg|jpeg|gif)$/i, '');
  return `${JANITOR_CDN_BASE}/bot-avatars/${id}.webp`;
}

/**
 * Resolve a raw image value (URL, relative path, or bare ID) to a full CDN URL.
 * @param {string} raw - Raw value from the API
 * @param {string} cdnPath - CDN path prefix (e.g. '/bot-avatars/' or '/media-approved/')
 * @returns {string} Full URL
 */
function resolveJanitorImageUrl(raw, cdnPath = '/media-approved/') {
  if (raw.startsWith('http://') || raw.startsWith('https://')) return raw;
  if (raw.startsWith('/')) return `${JANITOR_CDN_BASE}${raw}`;
  const id = raw.replace(/\.(webp|png|jpg|jpeg|gif)$/i, '');
  return `${JANITOR_CDN_BASE}${cdnPath}${id}.webp`;
}

/**
 * Extract all image URLs from JanitorAI API response (avatar + gallery).
 * Gallery images use the CDN path /media-approved/{id}.webp
 * @param {object} data - API response data
 * @returns {string[]} Array of image URLs (avatar first, then gallery)
 */
function extractJanitorImageUrls(data) {
  const urls = [];

  // Start with the avatar
  const avatarUrl = extractJanitorAvatarUrl(data);
  if (avatarUrl) urls.push(avatarUrl);

  // Look for gallery/media arrays in common field names
  const galleryFields = [
    'gallery', 'images', 'media', 'photos', 'gallery_images',
    'extra_images', 'additional_images', 'bot_gallery',
  ];

  for (const field of galleryFields) {
    const value = data[field];
    if (Array.isArray(value) && value.length > 0) {
      logger.info(`JanitorAI gallery: found array field "${field}" with ${value.length} items`);
      for (const item of value) {
        let imgUrl = null;
        if (typeof item === 'string' && item.trim()) {
          imgUrl = resolveJanitorImageUrl(item.trim());
        } else if (item && typeof item === 'object') {
          // Could be { url: '...' } or { id: '...' } or { src: '...' }
          const raw = item.url || item.src || item.image || item.image_url || item.id;
          if (raw && typeof raw === 'string') {
            imgUrl = resolveJanitorImageUrl(raw.trim());
          }
        }
        if (imgUrl && !urls.includes(imgUrl)) {
          urls.push(imgUrl);
        }
      }
      break; // Use the first gallery field found
    }
  }

  if (urls.length > 0) {
    const avatarCount = avatarUrl ? 1 : 0;
    const galleryCount = urls.length - avatarCount;
    logger.info(`JanitorAI images: extracted ${urls.length} total URLs (${avatarCount} avatar + ${galleryCount} gallery)`);
  }

  return urls;
}

// ---------------------------------------------------------------------------
// Platform registry
// ---------------------------------------------------------------------------

const PLATFORMS = {
  janitorai: {
    id: 'janitorai',
    label: 'JanitorAI',
    hostPattern: 'janitorai.com',
    requiresAuth: false, // Try public access first; only need token for private characters
    manualOnly: false,
    authInstructions: {
      title: 'Auth token (only needed if the character is private):',
      steps: [
        'Open <a href="https://janitorai.com" target="_blank" rel="noopener">janitorai.com</a> in your browser and log in.',
        'Press <strong>F12</strong> (or right-click → Inspect) to open Developer Tools.',
        'Go to the <strong>Network</strong> tab.',
        'Now click on any character or navigate to a new page on JanitorAI — you\'ll see network requests appear.',
        'Click on any request to <code>kim.janitorai.com</code> in the list (look in the Domain/URL column).',
        'In the <strong>Headers</strong> section, scroll to <strong>Request Headers</strong> and find <code>Authorization</code>.',
        'Copy the value after <code>Bearer </code> (the long token string) and paste it above.',
      ],
      note: 'Most public characters work without a token. If you get an auth error, follow these steps to provide a token.',
    },
    match(url) {
      try {
        const parsed = new URL(url);
        if (!parsed.hostname.includes('janitorai.com')) return null;
        // Match /characters/{UUID}_character-{slug} — extract UUID
        const charMatch = parsed.pathname.match(/\/characters\/([a-f0-9-]+)/i);
        if (charMatch) return charMatch[1];
        // Match /chats/{chatId} — extract chat ID (numeric)
        const chatMatch = parsed.pathname.match(/\/chats\/(\d+)/);
        if (chatMatch) return `chat:${chatMatch[1]}`;
        return null;
      } catch { return null; }
    },
    /**
     * Parse a human-readable character name from a JanitorAI URL slug.
     * e.g. ".../characters/{UUID}_character-my-cool-oc" → "My Cool Oc"
     */
    parseNameFromUrl(url) {
      try {
        const parsed = new URL(url);
        // Match /characters/{UUID}_character-{slug}
        const slugMatch = parsed.pathname.match(/\/characters\/[a-f0-9-]+_character-([^/]+)/i);
        if (slugMatch) {
          return slugMatch[1]
            .replace(/-/g, ' ')
            .replace(/\b\w/g, c => c.toUpperCase())
            .trim();
        }
        // Some URLs use /characters/{UUID}_{slug} without "character-" prefix
        const altMatch = parsed.pathname.match(/\/characters\/[a-f0-9-]+_([^/]+)/i);
        if (altMatch) {
          return altMatch[1]
            .replace(/-/g, ' ')
            .replace(/\b\w/g, c => c.toUpperCase())
            .trim();
        }
        return null;
      } catch { return null; }
    },
    async fetch(characterId, authToken, progress) {
      const hasToken = authToken && authToken.trim();
      const cleanedToken = hasToken ? cleanJanitorToken(authToken) : null;
      if (cleanedToken) {
        logger.info(`JanitorAI fetch: characterId=${characterId}, token starts with "${cleanedToken.substring(0, 10)}...", length=${cleanedToken.length}`);
      } else {
        logger.info(`JanitorAI fetch: characterId=${characterId}, no auth token (trying public access)`);
      }
      progress('Fetching character data from JanitorAI...');

      // Build headers — omit Authorization if no token (try public access first)
      const buildHeaders = (includeAuth) => {
        const h = {
          'Accept': 'application/json, text/plain, */*',
          'Accept-Language': 'en-US,en;q=0.9',
          'Referer': 'https://janitorai.com/',
          'Origin': 'https://janitorai.com',
        };
        if (includeAuth && cleanedToken) {
          h['Authorization'] = `Bearer ${cleanedToken}`;
        }
        return h;
      };

      // Helper: try Chromium proxy first, fall back to axios.
      // If no token, tries without auth first; retries with auth on 401.
      const janitorGet = async (url) => {
        const makeRequest = async (headers) => {
          try {
            const result = await chromiumFetch(url, headers);
            logger.info('JanitorAI fetch: used Chromium proxy (Cloudflare bypass)');
            return result;
          } catch (proxyErr) {
            // If proxy returned an upstream error (401, 403, etc.), re-throw as-is
            if (proxyErr.response) throw proxyErr;
            // Proxy unavailable — fall back to axios
            logger.info(`JanitorAI fetch: Chromium proxy unavailable (${proxyErr.message}), falling back to axios`);
            return axios.get(url, {
              headers,
              timeout: URL_IMPORT_REQUEST_TIMEOUT_MS,
            });
          }
        };

        // Try without auth first (public characters don't need a token)
        try {
          return await makeRequest(buildHeaders(false));
        } catch (noAuthErr) {
          const status = noAuthErr.response?.status;
          // 401/403 = standard auth errors, 530 = JanitorAI's custom "auth required" page
          const isAuthError = status === 401 || status === 403 || status === 530;
          if (isAuthError && cleanedToken) {
            logger.info(`JanitorAI fetch: public access returned ${status}, retrying with auth token`);
            progress('Authenticating with JanitorAI...');
            return await makeRequest(buildHeaders(true));
          }
          if (isAuthError && !cleanedToken) {
            throw new ManualFallbackError(
              'This JanitorAI character requires authentication. Please provide your auth token (see instructions below), or paste the character info manually.',
              'JanitorAI',
            );
          }
          throw noAuthErr;
        }
      };

      let resolvedCharacterId = characterId;

      // If this is a chat URL (chat:{id}), we need to get the character ID first
      if (resolvedCharacterId.startsWith('chat:')) {
        const chatId = resolvedCharacterId.substring(5);
        progress('Looking up character from chat...');
        try {
          const chatResponse = await janitorGet(`https://kim.janitorai.com/chats/${chatId}`);
          const chatData = chatResponse.data;
          // Extract the character ID from the chat data
          const charId = chatData?.character_id || chatData?.bot_id || chatData?.character?.id;
          if (!charId) {
            throw new ManualFallbackError(
              'Could not find the character ID from this chat URL. Please use the character page URL instead (go to the character\'s profile page and copy that URL), or paste the character info manually.',
              'JanitorAI',
            );
          }
          resolvedCharacterId = charId;
        } catch (error) {
          if (error instanceof ManualFallbackError) throw error;
          throw new ManualFallbackError(
            'Could not look up character from this chat URL. Please use the character page URL instead (click the character\'s name/avatar to go to their profile, then copy that URL), or paste the character info manually.',
            'JanitorAI',
          );
        }
      }

      // Try the API first, then fall back to page scraping
      let data = null;
      try {
        const response = await janitorGet(`https://kim.janitorai.com/characters/${resolvedCharacterId}`);
        data = response.data;
      } catch (apiErr) {
        logger.info(`JanitorAI API failed (${apiErr.message}), trying page scrape fallback...`);
      }

      // If API returned valid data, use it directly
      if (data && (data.name || data.description)) {
        logger.info(`JanitorAI API response keys: ${Object.keys(data).join(', ')}`);

        const imageUrls = extractJanitorImageUrls(data);
        const coverImageUrl = imageUrls[0] || null;
        if (imageUrls.length > 0) {
          progress(`Found ${imageUrls.length} character image(s)...`);
        }

        // Build rawCard for direct import (skip AI analysis)
        // Merge description + personality into description (no separate personality field on standard cards)
        const apiDesc = data.description || '';
        const apiPers = data.personality || '';
        const mergedDescription = apiDesc && apiPers
          ? `${apiDesc}\n\n${apiPers}`
          : apiDesc || apiPers;

        const rawCard = {
          name: data.name || 'Unknown Character',
          description: mergedDescription,
          personality: '',
          scenario: data.scenario || '',
          first_mes: data.first_message || data.greeting || '',
          alternate_greetings: Array.isArray(data.alternate_greetings)
            ? data.alternate_greetings.filter(g => g && typeof g === 'string' && g.trim())
            : [],
          mes_example: data.example_dialogs || data.mes_example || '',
          tags: Array.isArray(data.tags) ? data.tags : [],
          creator: data.creator || '',
          creator_notes: data.creator_notes || '',
          system_prompt: data.system_prompt || '',
          post_history_instructions: data.post_history_instructions || '',
          extensions: data.extensions || {},
        };

        const greetingCount = (rawCard.first_mes ? 1 : 0) + rawCard.alternate_greetings.length;
        logger.info(`JanitorAI API: captured ${greetingCount} greeting(s) (${rawCard.first_mes ? '1 first' : '0 first'} + ${rawCard.alternate_greetings.length} alternates)`);

        return {
          name: data.name || 'Unknown Character',
          fields: {
            name: data.name,
            description: data.description,
            personality: data.personality,
            scenario: data.scenario,
            firstMessage: data.first_message,
            exampleDialogue: data.example_dialogs,
          },
          rawCard,
          coverImageUrl,
          imageUrls,
        };
      }

      // Fallback: scrape the character page in the authenticated browser
      progress('API unavailable — scraping character page...');
      const scraped = await chromiumScrape(`https://janitorai.com/characters/${resolvedCharacterId}`);

      // If the scraper detected we're not logged in, tell the user to login first
      if (scraped && scraped.notLoggedIn) {
        throw new ManualFallbackError(
          'You are not logged in to JanitorAI. Please click "Login to JanitorAI" to sign in first, then try importing again.',
          'JanitorAI'
        );
      }

      if (scraped && scraped.bodyText && scraped.bodyText.length > 100) {
        logger.info(`JanitorAI scrape: got ${scraped.bodyText.length} chars, ${(scraped.images || []).length} images`);

        // Collect character image URLs — only from JanitorAI's CDN
        const imageUrls = [];
        const isCharacterImage = (url) =>
          (url.includes('ella.janitorai.com') || url.includes('pics.janitorai.com')) &&
          (url.includes('bot-avatars') || url.includes('media-approved'));
        if (scraped.ogImage && isCharacterImage(scraped.ogImage)) imageUrls.push(scraped.ogImage);
        if (scraped.images) {
          for (const img of scraped.images) {
            if (!imageUrls.includes(img) && isCharacterImage(img)) imageUrls.push(img);
          }
        }

        const resolvedName = scraped.ogTitle || scraped.title || 'Unknown Character';
        const tf = scraped.targetedFields || {};

        // Build fullText from targeted/embedded fields — NOT from bodyText which
        // contains page chrome (navigation, comments, metadata, etc.)
        let fullText = '';

        const personality = scraped.embeddedPersonality || tf.personality || '';
        const scenario = scraped.embeddedScenario || tf.scenario || '';
        const description = scraped.embeddedDescription || tf.description || '';
        const exampleDlg = scraped.embeddedExampleDialogue || tf.example_dialogs || '';
        const firstMsg = scraped.firstMessage || tf.first_message || '';

        if (description) fullText += `## Description\n\n${description}\n\n`;
        if (personality) fullText += `## Personality\n\n${personality}\n\n`;
        if (scenario) fullText += `## Scenario\n\n${scenario}\n\n`;
        if (firstMsg) fullText += `## First Message / Greeting\n\n${firstMsg}\n\n`;
        if (exampleDlg) {
          const dlg = Array.isArray(exampleDlg) ? exampleDlg.join('\n') : exampleDlg;
          fullText += `## Example Dialogue\n\n${dlg}\n\n`;
        }

        // Only fall back to bodyText if we got absolutely nothing from targeted/embedded fields
        if (!fullText.trim()) {
          logger.info('JanitorAI scrape: no targeted or embedded fields found, falling back to bodyText');
          fullText = scraped.bodyText;
        }

        // Append chat messages if the scraper captured them.
        // If user messages are present, the chat is a real conversation — use
        // the first character message as the greeting and the full chat as
        // rich context for lorebook/character extraction.
        if (scraped.chatMessages && scraped.chatMessages.length > 0) {
          const charName = resolvedName;
          const hasUserMessages = scraped.chatMessages.some(m => m.role === 'user');

          if (hasUserMessages) {
            // Real conversation detected — split first character message as greeting,
            // rest becomes lorebook context
            const firstCharMsg = scraped.chatMessages.find(m => m.role === 'character');
            if (firstCharMsg && !scraped.firstMessage) {
              logger.info(`JanitorAI scrape: using first character message as greeting (${firstCharMsg.text.length} chars)`);
              fullText += `\n\n## First Message / Greeting\n\n${firstCharMsg.text}`;
            }
            logger.info(`JanitorAI scrape: appending ${scraped.chatMessages.length} chat message(s) as conversation context`);
            fullText += '\n\n## Chat Conversation (use as context for lorebook, personality, speech patterns, and relationship details)\n';
            for (const msg of scraped.chatMessages) {
              const text = msg.text ?? '';
              if (msg.role === 'full_chat') {
                fullText += text + '\n';
              } else {
                const speaker = msg.role === 'user' ? '{{user}}' : charName;
                fullText += `${speaker}: ${text}\n\n`;
              }
            }
          } else {
            // No user messages — just character greeting(s)
            logger.info(`JanitorAI scrape: appending ${scraped.chatMessages.length} chat message(s)`);
            if (!scraped.firstMessage) {
              const firstMsg = scraped.chatMessages[0];
              const text = firstMsg?.text ?? '';
              if (text.length > 20) {
                logger.info(`JanitorAI scrape: using chat message as greeting (${text.length} chars)`);
                fullText += `\n\n## First Message / Greeting\n\n${text}`;
              }
            }
            // Still append all messages as general context. Preserve a lone short
            // message, but avoid duplicating a lone long message already used as greeting.
            const singleMsgAlreadyUsedAsGreeting = (
              scraped.chatMessages.length === 1
              && !scraped.firstMessage
              && (scraped.chatMessages[0]?.text ?? '').length > 20
            );
            if (scraped.chatMessages.length > 1 || scraped.firstMessage || !singleMsgAlreadyUsedAsGreeting) {
              fullText += '\n\n## Chat History\n';
              for (const msg of scraped.chatMessages) {
                const text = msg.text ?? '';
                if (msg.role === 'full_chat') {
                  fullText += text + '\n';
                } else {
                  const speaker = msg.role === 'user' ? '{{user}}' : charName;
                  fullText += `${speaker}: ${text}\n\n`;
                }
              }
            }
          }
        }

        // Build a rawCard directly from whatever scraped data we have.
        // This skips AI analysis entirely — much faster and preserves all
        // greetings/images verbatim.
        //
        // Field priority: API data (embeddedCharData) > targeted DOM fields > bodyText fallback

        // Determine the best first message source
        let firstMes = scraped.firstMessage || tf.first_message || '';
        if (!firstMes && scraped.chatMessages && scraped.chatMessages.length > 0) {
          const hasUserMessages = scraped.chatMessages.some(m => m.role === 'user');
          if (!hasUserMessages) {
            // Character-only messages = greetings
            const firstMsg = scraped.chatMessages[0];
            if (firstMsg?.text && firstMsg.text.length > 20) {
              firstMes = firstMsg.text;
            }
          } else {
            // Real conversation — first character message is the greeting
            const firstCharMsg = scraped.chatMessages.find(m => m.role === 'character');
            if (firstCharMsg?.text && firstCharMsg.text.length > 20) {
              firstMes = firstCharMsg.text;
            }
          }
        }

        // Gather alternate greetings from embedded data or chat messages
        const alternateGreetings = [];
        if (Array.isArray(scraped.alternateGreetings)) {
          for (const g of scraped.alternateGreetings) {
            if (g && typeof g === 'string' && g.trim()) alternateGreetings.push(g);
          }
        }
        // If no embedded alternates but chat messages have multiple character-only greetings
        if (alternateGreetings.length === 0 && scraped.chatMessages && scraped.chatMessages.length > 1) {
          const hasUserMessages = scraped.chatMessages.some(m => m.role === 'user');
          if (!hasUserMessages) {
            for (let i = 1; i < scraped.chatMessages.length; i++) {
              const msg = scraped.chatMessages[i];
              if (msg?.text && msg.text.length > 20) {
                alternateGreetings.push(msg.text);
              }
            }
          }
        }

        // Strip the character name from the title to get a cleaner name
        const cleanName = (scraped.embeddedName || tf.name || resolvedName || '').replace(/\s*\|.*$/, '').trim();

        // Build rawCard from targeted fields (not bodyText which has page junk).
        // Merge description + personality into description (no separate personality field on standard cards).
        // Description first, personality appended below. Never use bodyText as description.
        const scrapeDesc = scraped.embeddedDescription || tf.description || '';
        const scrapePers = scraped.embeddedPersonality || tf.personality || '';
        const mergedDesc = scrapeDesc && scrapePers
          ? `${scrapeDesc}\n\n${scrapePers}`
          : scrapeDesc || scrapePers;

        const rawCard = {
          name: cleanName || resolvedName,
          description: mergedDesc,
          personality: '',
          scenario: scraped.embeddedScenario || tf.scenario || '',
          first_mes: firstMes,
          alternate_greetings: alternateGreetings,
          mes_example: scraped.embeddedExampleDialogue || tf.example_dialogs || '',
          tags: Array.isArray(scraped.embeddedTags)
            ? scraped.embeddedTags
            : (Array.isArray(tf.tags) ? tf.tags : []),
          creator: scraped.embeddedCreator || '',
          creator_notes: scraped.embeddedCreatorNotes || '',
          system_prompt: scraped.embeddedSystemPrompt || '',
          post_history_instructions: scraped.embeddedPostHistoryInstructions || '',
          extensions: scraped.embeddedExtensions || {},
        };

        // Restore {{user}} and {{char}} placeholders in scraped text.
        // JanitorAI renders {{user}} as the active persona name (logged in) or "Anon"
        // (logged out), and {{char}} as the character's name on the page.
        // The persona name comes from the JAI "stores" cookie (stores.user.profile.name).
        const charName = rawCard.name || cleanName || resolvedName;
        const detectedPersona = scraped.jaiUsername || null;
        if (detectedPersona) {
          logger.info(`JanitorAI scrape: detected persona "${detectedPersona}" — will restore to {{user}}`);
        }
        const restorePlaceholders = (text) => {
          if (!text || typeof text !== 'string') return text;
          let result = text;
          // Restore {{user}} — replace "Anon" (logged-out default)
          result = result.replace(/\bAnon\b/g, '{{user}}');
          // Restore {{user}} — replace detected JAI persona/display name (logged-in)
          if (detectedPersona && detectedPersona.length >= 2) {
            result = result.replace(new RegExp(`\\b${detectedPersona.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'gi'), '{{user}}');
          }
          // Restore {{char}} — JanitorAI shows the character's actual name
          if (charName && charName.length >= 2) {
            result = result.replace(new RegExp(`\\b${charName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'g'), '{{char}}');
          }
          return result;
        };
        rawCard.description = restorePlaceholders(rawCard.description);
        rawCard.scenario = restorePlaceholders(rawCard.scenario);
        rawCard.mes_example = restorePlaceholders(rawCard.mes_example);
        rawCard.first_mes = restorePlaceholders(rawCard.first_mes);
        rawCard.alternate_greetings = rawCard.alternate_greetings.map(g => restorePlaceholders(g));

        const greetingCount = (rawCard.first_mes ? 1 : 0) + rawCard.alternate_greetings.length;
        logger.info(`JanitorAI scrape: built rawCard — "${rawCard.name}", ${greetingCount} greeting(s), desc ${rawCard.description.length} chars`);

        // Detect "Character Definition is hidden" — creator disabled visibility.
        // If definition fields are all empty but we still have a name/greetings,
        // return what we have with a warning flag.
        const defFields = [rawCard.description, rawCard.scenario, rawCard.mes_example];
        const allDefEmpty = defFields.every(f => !f || !f.trim());
        const bodyLower = (scraped.bodyText || '').toLowerCase();
        const isHidden = bodyLower.includes('character definition is hidden')
          || bodyLower.includes('definition is hidden');

        if (isHidden && allDefEmpty) {
          logger.warn('JanitorAI scrape: character definition is hidden by creator — definition fields are empty');

          if (rawCard.name && (rawCard.first_mes || rawCard.alternate_greetings.length > 0)) {
            return {
              name: rawCard.name,
              rawCard,
              coverImageUrl: imageUrls[0] || null,
              imageUrls,
              hiddenDefinition: true,
            };
          }

          throw new ManualFallbackError(
            'This character\'s definition is hidden by its creator. The personality, scenario, and description could not be extracted. You can try pasting any visible info manually.',
            'JanitorAI',
          );
        }

        return {
          name: rawCard.name,
          rawCard,
          coverImageUrl: imageUrls[0] || null,
          imageUrls,
        };
      }

      throw new ManualFallbackError(
        'Could not fetch character data from JanitorAI (API and page scrape both failed). Please paste the character info manually.',
        'JanitorAI',
      );
    },
  },

  characterai: {
    id: 'characterai',
    label: 'Character.AI',
    hostPattern: 'character.ai',
    requiresAuth: true,
    manualOnly: false,
    authInstructions: {
      title: 'How to get your Character.AI session token:',
      steps: [
        'Open <a href="https://character.ai" target="_blank" rel="noopener">character.ai</a> in your browser and log in.',
        'Press <strong>F12</strong> to open Developer Tools.',
        'Go to the <strong>Application</strong> tab → <strong>Local Storage</strong> → <code>https://character.ai</code>.',
        'Find the key <code>char_token</code> and copy the <strong>value</strong> field from inside the JSON object.',
        'Paste it in the Auth Token field above.',
      ],
      note: 'This only works for characters where the creator has enabled "Show Definition." If the definition is private, you\'ll be prompted to paste the character\'s visible info manually.',
    },
    match(url) {
      try {
        const parsed = new URL(url);
        if (!parsed.hostname.includes('character.ai')) return null;
        const charParam = parsed.searchParams.get('char');
        if (charParam) return charParam;
        const pathMatch = parsed.pathname.match(/\/chat\/([^/?]+)/);
        return pathMatch ? pathMatch[1] : null;
      } catch { return null; }
    },
    async fetch(characterId, authToken, progress) {
      progress('Fetching character data from Character.AI...');

      // Try to dynamically import cainode — it's an optional dependency
      let CAINode;
      try {
        CAINode = (await import('cainode')).default || (await import('cainode'));
      } catch {
        throw new ManualFallbackError(
          'Character.AI direct import is not available (cainode package not installed). Please copy the character\'s description from the Character.AI page and paste it manually.',
          'Character.AI',
        );
      }

      try {
        const client = new CAINode();
        await client.login(authToken);
        const info = await client.character.info(characterId);

        const definition = info?.definition || info?.description || '';
        const name = info?.name || info?.participant__name || '';
        const greeting = info?.greeting || '';

        if (!definition.trim() && !name.trim()) {
          throw new ManualFallbackError(
            'This character\'s definition is private (the creator disabled "Show Definition"). Please copy the character\'s visible description and any other info from the page, then paste it manually.',
            'Character.AI',
          );
        }

        return {
          name: name || 'Unknown Character',
          fields: {
            name,
            description: info?.description || '',
            definition,
            greeting,
          },
          coverImageUrl: info?.avatar_file_name
            ? `https://characterai.io/i/400/static/avatars/${info.avatar_file_name}`
            : null,
        };
      } catch (error) {
        if (error instanceof ManualFallbackError) throw error;
        throw new ManualFallbackError(
          `Could not retrieve character from Character.AI: ${error.message}. Please paste the character info manually.`,
          'Character.AI',
        );
      }
    },
  },

  spicychat: {
    id: 'spicychat',
    label: 'SpicyChat',
    hostPattern: 'spicychat.ai',
    requiresAuth: true,
    manualOnly: false,
    authInstructions: {
      title: 'How to get your SpicyChat auth token:',
      steps: [
        'Open <a href="https://spicychat.ai" target="_blank" rel="noopener">spicychat.ai</a> in your browser and log in.',
        'Press <strong>F12</strong> to open Developer Tools.',
        'Go to the <strong>Network</strong> tab, then navigate to any page on SpicyChat (or refresh).',
        'Click on any request to <code>api.spicychat.ai</code> in the network list.',
        'In the <strong>Headers</strong> section, find <code>Authorization</code> and copy the value after <code>Bearer </code>.',
        'Paste it in the Auth Token field above.',
      ],
      note: 'Your token may expire after a while. If you get an auth error, repeat these steps.',
    },
    match(url) {
      try {
        const parsed = new URL(url);
        if (!parsed.hostname.includes('spicychat.ai')) return null;
        const m = parsed.pathname.match(/\/chat\/([^/?]+)/);
        return m ? m[1] : null;
      } catch { return null; }
    },
    async fetch(characterId, authToken, progress) {
      progress('Fetching character data from SpicyChat...');
      try {
        // Browser-like headers to avoid WAF/bot detection
        const browserHeaders = {
          'Authorization': `Bearer ${authToken}`,
          'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
          'Accept': 'application/json, text/plain, */*',
          'Accept-Language': 'en-US,en;q=0.9',
          'Referer': 'https://spicychat.ai/',
          'Origin': 'https://spicychat.ai',
        };

        const response = await axios.get(`https://api.spicychat.ai/api/characters/${characterId}`, {
          headers: browserHeaders,
          timeout: URL_IMPORT_REQUEST_TIMEOUT_MS,
        });
        const data = response.data;
        if (!data || (!data.name && !data.personality)) {
          throw new ManualFallbackError(
            'SpicyChat returned empty character data. Please paste the character info manually.',
            'SpicyChat',
          );
        }
        return {
          name: data.name || 'Unknown Character',
          fields: {
            name: data.name,
            title: data.title,
            personality: data.personality,
            scenario: data.scenario,
            greeting: data.greeting,
            exampleDialogue: data.example_dialogue,
          },
          coverImageUrl: data.avatar_url || data.avatar || null,
        };
      } catch (error) {
        if (error instanceof ManualFallbackError) throw error;
        throw new ManualFallbackError(
          `Could not retrieve character from SpicyChat: ${error.message}. The API endpoint may have changed. Please paste the character info manually.`,
          'SpicyChat',
        );
      }
    },
  },

  sakura: {
    id: 'sakura',
    label: 'Sakura.fm',
    hostPattern: 'sakura.fm',
    requiresAuth: false,
    manualOnly: true,
    manualInstructions: {
      title: 'Sakura.fm doesn\'t expose character data via API.',
      steps: [
        'Open the character\'s page on Sakura.fm.',
        'Look for the character\'s description, personality info, and any visible backstory.',
        'Copy all the text you can find about the character.',
        'Paste it in the <strong>Character Description</strong> text box below.',
      ],
      note: 'The more detail you paste, the better the generated card will be. Include personality traits, backstory, appearance, speech patterns — anything you can find or know about the character.',
    },
    match(url) {
      try {
        const parsed = new URL(url);
        if (!parsed.hostname.includes('sakura.fm')) return null;
        const m = parsed.pathname.match(/\/chat\/([a-zA-Z0-9]+)/);
        return m ? m[1] : null;
      } catch { return null; }
    },
  },

  moescape: {
    id: 'moescape',
    label: 'Moescape',
    hostPattern: 'moescape.ai',
    requiresAuth: false,
    manualOnly: true,
    manualInstructions: {
      title: 'Moescape doesn\'t currently support API-based extraction.',
      steps: [
        'Open the character\'s page on Moescape.',
        'Copy the character\'s description, personality, and any other visible info.',
        'Paste it in the <strong>Character Description</strong> text box below.',
      ],
      note: 'Tip: If the character uses W++ or Boostyle formatting, paste it as-is — the AI will understand it.',
    },
    match(url) {
      try {
        const parsed = new URL(url);
        if (!parsed.hostname.includes('moescape.ai')) return null;
        const m = parsed.pathname.match(/\/tavern\/characters\/([a-f0-9-]+)/i);
        return m ? m[1] : null;
      } catch { return null; }
    },
  },

  replika: {
    id: 'replika',
    label: 'Replika',
    hostPattern: 'replika',
    requiresAuth: false,
    manualOnly: true,
    manualInstructions: {
      title: 'Replika companions don\'t have a traditional character definition to export.',
      steps: [
        'Open the Replika app and go to your companion\'s <strong>Profile</strong>.',
        'Note down their <strong>name, traits, interests, and backstory</strong>.',
        'Go to <strong>Memories</strong> and scroll through — copy or write down the key facts.',
        'Optionally check their <strong>Diary</strong> for personality insights.',
        'Write or paste all of this into the <strong>Character Description</strong> text box below.',
      ],
      note: 'Include as much as you can: their personality traits, things they remember about you, their backstory, how they talk, their interests. The AI will use everything you provide to build a complete character card.',
    },
    match(url) {
      try {
        const parsed = new URL(url);
        return parsed.hostname.includes('replika') ? 'manual' : null;
      } catch { return null; }
    },
  },
};

// ---------------------------------------------------------------------------
// Exported functions
// ---------------------------------------------------------------------------

/**
 * Detect which platform a URL belongs to and return metadata.
 * @param {string} url - The character page URL
 * @returns {object|null} Platform info with characterId, or null if unrecognized
 */
export function detectPlatform(url) {
  if (!url || typeof url !== 'string') return null;

  for (const platform of Object.values(PLATFORMS)) {
    const characterId = platform.match(url);
    if (characterId) {
      return {
        platformId: platform.id,
        platformLabel: platform.label,
        characterId,
        requiresAuth: platform.requiresAuth,
        manualOnly: platform.manualOnly,
        authInstructions: platform.authInstructions || null,
        manualInstructions: platform.manualInstructions || null,
      };
    }
  }

  return null;
}

/**
 * Return serializable platform registry for frontend display.
 */
export function getPlatformRegistry() {
  return Object.values(PLATFORMS).map(p => ({
    id: p.id,
    label: p.label,
    hostPattern: p.hostPattern,
    requiresAuth: p.requiresAuth,
    manualOnly: p.manualOnly,
    authInstructions: p.authInstructions || null,
    manualInstructions: p.manualInstructions || null,
  }));
}

/**
 * Format scraped character fields into descriptive text for analyzeCharacterInterview().
 * @param {string} platformLabel - Platform name for context
 * @param {object} fields - Scraped character fields
 * @returns {string} Formatted markdown text
 */
export function formatScrapedDataAsText(platformLabel, fields) {
  const sections = [];

  sections.push(`## Character Profile (imported from ${platformLabel})`);

  if (fields.name) {
    sections.push(`## Name & Identity\n\nThis character's name is ${fields.name}.`);
  }

  if (fields.description) {
    sections.push(`## Description\n\n${fields.description}`);
  }

  if (fields.definition) {
    sections.push(`## Character Definition\n\n${fields.definition}`);
  }

  if (fields.personality) {
    sections.push(`## Personality\n\n${fields.personality}`);
  }

  if (fields.scenario) {
    sections.push(`## Scenario\n\n${fields.scenario}`);
  }

  if (fields.greeting || fields.firstMessage) {
    sections.push(`## First Message / Greeting\n\n${fields.greeting || fields.firstMessage}`);
  }

  if (fields.exampleDialogue) {
    sections.push(`## Example Dialogue\n\n${fields.exampleDialogue}`);
  }

  if (fields.title) {
    sections.push(`## Title\n\n${fields.title}`);
  }

  if (fields.background) {
    sections.push(`## Background\n\n${fields.background}`);
  }

  return sections.join('\n\n---\n\n');
}

/**
 * Fetch character data from a platform URL and format it as descriptive text.
 * @param {string} url - Character page URL
 * @param {string|null} authToken - Platform auth token
 * @param {string|null} sessionId - Session ID for progress tracking
 * @param {Function|null} updateProgressFn - Progress callback (sessionId, message)
 * @returns {Promise<{platformLabel: string, characterName: string, formattedText: string, coverImageUrl: string|null, imageUrls: string[]}>}
 */
export async function fetchCharacterFromUrl(url, authToken, sessionId, updateProgressFn) {
  const progress = (msg) => { if (updateProgressFn && sessionId) updateProgressFn(sessionId, msg); };

  const detected = detectPlatform(url);
  if (!detected) {
    throw new ManualFallbackError(
      'Unrecognized URL. Please paste the character\'s description manually.',
      'Unknown',
    );
  }

  const platform = PLATFORMS[detected.platformId];

  if (platform.manualOnly) {
    throw new ManualFallbackError(
      platform.manualInstructions
        ? `${platform.label}: ${platform.manualInstructions.title} Please paste the character's info manually.`
        : `${platform.label} does not support API-based extraction. Please paste the character info manually.`,
      platform.label,
    );
  }

  if (platform.requiresAuth && !authToken?.trim()) {
    throw new ManualFallbackError(
      `${platform.label} requires an auth token. Please provide your token or paste the character info manually.`,
      platform.label,
    );
  }

  // Try to extract a human-readable name from the URL slug (e.g. "My Cool Character")
  const slugName = platform.parseNameFromUrl ? platform.parseNameFromUrl(url) : null;

  try {
    const result = await platform.fetch(detected.characterId, authToken, progress);

    // Only use URL slug name as a fallback when fetched data has no usable name.
    const hasRawCardName = typeof result.rawCard?.name === 'string' && result.rawCard.name.trim().length > 0;
    const hasResultName = typeof result.name === 'string' && result.name.trim().length > 0;
    if (slugName && (!hasRawCardName || !hasResultName)) {
      if (result.rawCard && !hasRawCardName) {
        result.rawCard.name = slugName;
      }
      if (!hasResultName) {
        result.name = slugName;
      }
    }

    // If the platform returned raw scraped text (page scrape fallback),
    // use it directly — the AI will parse it into a card.
    let formattedText;
    if (result.scrapedText) {
      formattedText = `## Character Profile (scraped from ${platform.label})\n\n${result.scrapedText}`;
      logger.info(`URL import: using scraped page text (${formattedText.length} chars) for character "${result.name}"`);
    } else if (result.fields) {
      formattedText = formatScrapedDataAsText(platform.label, result.fields);
    } else {
      formattedText = '';
    }

    if (formattedText && formattedText.length < 50) {
      logger.warn(`URL import: very little data scraped from ${platform.label} (${formattedText.length} chars)`);
    }

    logger.info(`URL import: fetched character "${result.name}" from ${platform.label}`);

    return {
      platformLabel: platform.label,
      characterName: result.name,
      formattedText,
      coverImageUrl: result.coverImageUrl,
      imageUrls: result.imageUrls || [],
      rawCard: result.rawCard || null,
    };
  } catch (error) {
    if (error instanceof ManualFallbackError) throw error;

    const status = error.response?.status;
    logger.error(`URL import error: status=${status}, message=${error.message}, response=${JSON.stringify(error.response?.data)?.substring(0, 500)}`);

    if (status === 401 || status === 403 || status === 530) {
      throw new ManualFallbackError(
        `Invalid or expired ${platform.label} token (HTTP ${status}). Please get a fresh token from your browser, or paste the character info manually.`,
        platform.label,
      );
    }
    if (status === 404) {
      throw new ManualFallbackError(
        `Character not found on ${platform.label}. Check the URL and try again, or paste the character info manually.`,
        platform.label,
      );
    }
    if (status === 429) {
      throw new ManualFallbackError(
        `Rate limited by ${platform.label}. Wait a moment and try again, or paste the character info manually.`,
        platform.label,
      );
    }
    if (error.code === 'ECONNABORTED') {
      throw new ManualFallbackError(
        `Connection to ${platform.label} timed out. Try again, or paste the character info manually.`,
        platform.label,
      );
    }

    throw new ManualFallbackError(
      `Failed to fetch from ${platform.label}: ${error.message}. Please paste the character info manually.`,
      platform.label,
    );
  }
}

/**
 * Try to download a cover image from a URL and return as base64.
 * Returns null on failure (non-fatal).
 */
export async function downloadCoverImage(imageUrl) {
  if (!imageUrl) return null;
  try {
    // Determine referer based on the image URL's origin — some CDNs require it
    let referer;
    try {
      const parsed = new URL(imageUrl);
      if (parsed.hostname.includes('janitorai') || parsed.hostname.includes('ella.janitorai')) {
        referer = 'https://janitorai.com/';
      } else if (parsed.hostname.includes('spicychat')) {
        referer = 'https://spicychat.ai/';
      } else if (parsed.hostname.includes('character.ai') || parsed.hostname.includes('characterai')) {
        referer = 'https://character.ai/';
      }
    } catch { /* ignore URL parse errors */ }

    const headers = {
      'Accept': 'image/png,image/jpeg,image/webp,image/apng,image/svg+xml,image/*;q=0.8',
    };
    if (referer) headers['Referer'] = referer;

    // Try Chromium proxy first for JanitorAI CDN (may have Cloudflare protection)
    const isJanitorCdn = imageUrl.includes('janitorai') || imageUrl.includes('ella.janitorai');
    let response;
    if (isJanitorCdn) {
      try {
        response = await chromiumFetch(imageUrl, headers, {
          responseType: 'arraybuffer',
          timeout: URL_IMPORT_IMAGE_TIMEOUT_MS,
        });
        logger.info('Cover image: used Chromium proxy');
      } catch (proxyErr) {
        // If the proxy returned an upstream HTTP error, don't retry via axios.
        if (proxyErr?.response) {
          throw proxyErr;
        }
        // Proxy unavailable or failed — use axios fallback
        response = await axios.get(imageUrl, {
          responseType: 'arraybuffer',
          timeout: URL_IMPORT_IMAGE_TIMEOUT_MS,
          headers,
        });
      }
    } else {
      // Non-JanitorAI URLs skip proxy and use axios directly
      response = await axios.get(imageUrl, {
        responseType: 'arraybuffer',
        timeout: URL_IMPORT_IMAGE_TIMEOUT_MS,
        headers,
      });
    }

    const contentType = response.headers['content-type'] || '';
    const size = response.data?.byteLength || response.data?.length || 0;
    logger.info(`Downloaded cover image: ${size} bytes, type: ${contentType}`);

    return Buffer.from(response.data).toString('base64');
  } catch (error) {
    logger.warn(`Failed to download cover image from ${imageUrl}: ${error.message}`);
    return null;
  }
}
