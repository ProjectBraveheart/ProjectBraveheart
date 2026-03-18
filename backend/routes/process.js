import express from 'express';
import multer from 'multer';
import path from 'path';
import fs from 'fs/promises';
import { fileURLToPath } from 'url';
import { parseEpub, extractEpubCover } from '../services/fileParser.js';
import { analyzeBook, analyzeCharacterInterview, getAvailableModels, testConnection } from '../services/aiService.js';
import {
  interviewCharacter,
  getInterviewQuestions,
  setInterviewQuestions,
  resetInterviewQuestions,
  setInterviewQuestionsStorePath,
  ValidationError,
} from '../services/characterImportService.js';
import { interviewCharacterCAI } from '../services/characterAIService.js';
import { fetchCharacterFromUrl, downloadCoverImage, getPlatformRegistry, detectPlatform } from '../services/urlImportService.js';
import { getChromiumProxyPort } from '../services/chromiumProxy.js';
import { generateCharacterCards, generateLorebook, buildDirectCard } from '../services/cardGenerator.js';
import { updateProgress, getProgress, clearProgress, initPartialResults, addPartialCharacter } from '../utils/progressTracker.js';
import logger from '../utils/logger.js';
import {
  DEFAULT_API_BASE_URL,
  DEFAULT_CONTEXT_LENGTH,
  MAX_FILE_SIZE_BYTES,
  SUPPORTED_EXTENSIONS,
  CONTEXT_INPUT_RATIO,
  CHUNK_FILL_RATIO,
  CHARS_PER_TOKEN,
} from '../config/constants.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function validateFileExtension(filename) {
  const ext = path.extname(filename).toLowerCase();
  if (!SUPPORTED_EXTENSIONS.includes(ext)) {
    return `Only ${SUPPORTED_EXTENSIONS.join(' and ')} files are supported`;
  }
  return null;
}

async function cleanupFiles(...filePaths) {
  for (const p of filePaths) {
    if (!p) continue;
    try {
      await fs.unlink(p);
    } catch (error) {
      if (error?.code !== 'ENOENT') {
        logger.error(`Failed to delete uploaded file ${p}:`, error.message);
      }
    }
  }
}

function getUploadedPaths(req) {
  const paths = [];

  if (req?.file?.path) paths.push(req.file.path);

  if (!req?.files) return paths;

  if (Array.isArray(req.files)) {
    for (const f of req.files) {
      if (f?.path) paths.push(f.path);
    }
    return paths;
  }

  for (const entry of Object.values(req.files)) {
    if (Array.isArray(entry)) {
      for (const f of entry) {
        if (f?.path) paths.push(f.path);
      }
    } else if (entry?.path) {
      paths.push(entry.path);
    }
  }

  return paths;
}

async function cleanupRequestUploads(req) {
  await cleanupFiles(...getUploadedPaths(req));
}

function generateSessionId() {
  return `session_${Date.now()}_${Math.random().toString(36).substring(2, 11)}`;
}

// ---------------------------------------------------------------------------
// Router factory — accepts a configurable uploads path
// ---------------------------------------------------------------------------

const LOGIN_TIMEOUT_MS = 5 * 60 * 1000 + 10000; // 5 min + buffer
const LOGIN_SESSION_TTL_MS = 15 * 60 * 1000;

export function createProcessRouter(uploadsPath) {
  // Point the interview-questions store at the writable uploads directory
  // so it doesn't try to write inside the read-only ASAR archive in production.
  setInterviewQuestionsStorePath(uploadsPath);

  const router = express.Router();
  const janitorLoginSessions = new Map();
  const caiLoginSessions = new Map();

  function pruneJanitorLoginSessions() {
    const cutoff = Date.now() - LOGIN_SESSION_TTL_MS;
    for (const [sessionId, sessionInfo] of janitorLoginSessions.entries()) {
      if ((sessionInfo?.updatedAt || sessionInfo?.createdAt || 0) < cutoff) {
        janitorLoginSessions.delete(sessionId);
      }
    }
  }

  function pruneCAILoginSessions() {
    const cutoff = Date.now() - LOGIN_SESSION_TTL_MS;
    for (const [sessionId, sessionInfo] of caiLoginSessions.entries()) {
      if ((sessionInfo?.updatedAt || sessionInfo?.createdAt || 0) < cutoff) {
        caiLoginSessions.delete(sessionId);
      }
    }
  }

  async function sendImportResults({
    analysis,
    coverImageBase64,
    imageUrls = [],
    sessionId,
    req,
    res,
    completeLogPrefix,
  }) {
    if (!analysis.characters?.length) {
      throw new Error('Failed to extract character from import data');
    }

    const characterCards = generateCharacterCards(analysis.characters, coverImageBase64, { imageUrls });
    const lorebook = generateLorebook(analysis.worldInfo || {}, analysis.characters, analysis.characters[0]?.name);
    characterCards.forEach(card => { card.data.character_book = lorebook; });

    logger.info(`${completeLogPrefix}: ${characterCards.length} cards, ${lorebook.entries.length} lorebook entries`);

    if (req.file) await cleanupFiles(req.file.path);

    updateProgress(sessionId, 'Complete! Sending results...');
    clearProgress(sessionId);

    res.json({
      characters: characterCards,
      lorebook,
      bookTitle: analysis.bookTitle || 'Character Import',
      coverImage: coverImageBase64,
      sessionId,
    });
  }

  const storage = multer.diskStorage({
    destination: uploadsPath,
    filename: (_req, file, cb) => cb(null, `${Date.now()}-${file.originalname}`),
  });

  const upload = multer({ storage, limits: { fileSize: MAX_FILE_SIZE_BYTES } });

  // GET /models
  router.get('/models', async (req, res) => {
    try {
      const apiKey = req.headers['x-api-key'];
      const apiBaseUrl = req.headers['x-api-base-url'] || DEFAULT_API_BASE_URL;
      if (!apiKey) return res.status(400).json({ error: 'API key is required' });

      const models = await getAvailableModels(apiKey, apiBaseUrl);
      res.json({ models });
    } catch (error) {
      logger.error('Error fetching models:', error.message);
      res.status(500).json({ error: error.message });
    }
  });

  // POST /test-connection
  router.post('/test-connection', async (req, res) => {
    try {
      const { apiBaseUrl, apiKey } = req.body;
      if (!apiKey) return res.status(400).json({ success: false, error: 'API key is required' });
      if (!apiBaseUrl) return res.status(400).json({ success: false, error: 'API base URL is required' });

      const result = await testConnection(apiBaseUrl, apiKey);
      res.json(result);
    } catch (error) {
      logger.error('Error testing connection:', error.message);
      res.status(500).json({ success: false, error: error.message });
    }
  });

  // POST /preview — parse-only stats (no AI cost)
  router.post('/preview', upload.single('file'), async (req, res) => {
    try {
      const file = req.file;
      if (!file) return res.status(400).json({ error: 'No file uploaded' });

      const extError = validateFileExtension(file.originalname);
      if (extError) {
        await cleanupFiles(file.path);
        return res.status(400).json({ error: extError });
      }

      const epubData = await parseEpub(file.path);
      const contextLength = parseInt(req.body.contextLength) || DEFAULT_CONTEXT_LENGTH;

      const safeContextSize = Math.floor(contextLength * CONTEXT_INPUT_RATIO);
      const maxCharsForInput = safeContextSize * CHARS_PER_TOKEN;
      const charsPerChunk = Math.floor(safeContextSize * CHUNK_FILL_RATIO) * CHARS_PER_TOKEN;

      const textLength = epubData.text.length;
      const estimatedTokens = Math.ceil(textLength / CHARS_PER_TOKEN);
      const chapterCount = epubData.chapters?.length || 1;
      const fitsInContext = textLength <= maxCharsForInput;

      let estimatedChunks = 1;
      if (!fitsInContext) {
        let currentSize = 0;
        estimatedChunks = 1;
        for (const ch of (epubData.chapters || [])) {
          const chLen = ch.text.length + (ch.title ? ch.title.length + 10 : 0);
          if (chLen > charsPerChunk) {
            if (currentSize > 0) estimatedChunks++;
            estimatedChunks += Math.ceil(chLen / charsPerChunk);
            currentSize = 0;
          } else if (currentSize + chLen > charsPerChunk) {
            estimatedChunks++;
            currentSize = chLen;
          } else {
            currentSize += chLen;
          }
        }
      }

      const totalRequests = fitsInContext ? 1 : estimatedChunks + 1;

      await cleanupFiles(file.path);

      res.json({
        fileName: file.originalname,
        textLength,
        estimatedTokens,
        chapterCount,
        fitsInContext,
        estimatedChunks: fitsInContext ? 0 : estimatedChunks,
        totalRequests,
        contextLength,
      });
    } catch (error) {
      logger.error('Error previewing file:', error.message);
      if (req.file) await cleanupFiles(req.file.path);
      res.status(500).json({ error: error.message });
    }
  });

  // GET /progress/:sessionId
  router.get('/progress/:sessionId', (req, res) => {
    const progress = getProgress(req.params.sessionId);
    res.json(progress || { message: 'No progress available', timestamp: Date.now() });
  });

  // POST /file — full EPUB processing pipeline
  router.post('/file', upload.fields([
    { name: 'file', maxCount: 1 },
    { name: 'coverImage', maxCount: 1 },
  ]), async (req, res) => {
    const sessionId = req.body.sessionId || generateSessionId();

    try {
      updateProgress(sessionId, 'Starting file processing...');

      const { apiKey, model, contextLength, maxCompletionTokens, useCoverFromEpub, apiBaseUrl } = req.body;
      const file = req.files?.file?.[0];
      const coverImage = req.files?.coverImage?.[0];

      if (!file) {
        await cleanupRequestUploads(req);
        return res.status(400).json({ error: 'No file uploaded' });
      }
      if (!apiKey) {
        await cleanupRequestUploads(req);
        return res.status(400).json({ error: 'API key is required' });
      }

      const extError = validateFileExtension(file.originalname);
      if (extError) {
        await cleanupRequestUploads(req);
        return res.status(400).json({ error: extError });
      }

      logger.info(`Processing: ${file.originalname}, model: ${model}`);

      // Parse EPUB
      updateProgress(sessionId, 'Parsing EPUB file...');
      const epubData = await parseEpub(file.path);
      const bookText = epubData.text;
      logger.info(`EPUB parsed: ${bookText.length} chars`);
      updateProgress(sessionId, `EPUB parsed (${bookText.length.toLocaleString()} characters)`);

      // Cover image
      updateProgress(sessionId, 'Processing cover image...');
      let coverImageBase64 = null;
      if (useCoverFromEpub === 'true' && epubData.hasCover) {
        const coverBuffer = await extractEpubCover(file.path);
        coverImageBase64 = coverBuffer.toString('base64');
      } else if (coverImage) {
        const coverBuffer = await fs.readFile(coverImage.path);
        coverImageBase64 = coverBuffer.toString('base64');
      }

      // AI analysis
      updateProgress(sessionId, 'Analyzing book with AI... This may take a few minutes.');
      const contextSize = parseInt(contextLength) || DEFAULT_CONTEXT_LENGTH;
      const maxCompTokens = parseInt(maxCompletionTokens) || null;
      const providerUrl = apiBaseUrl || DEFAULT_API_BASE_URL;
      const analysis = await analyzeBook(bookText, {
        apiKey,
        model,
        contextLength: contextSize,
        sessionId,
        updateProgress,
        apiBaseUrl: providerUrl,
        chapters: epubData.chapters,
        maxCompletionTokens: maxCompTokens,
        onExtractionComplete: (extraction) => {
          initPartialResults(sessionId, extraction.bookTitle);
        },
        onCharacterComplete: (charDetail) => {
          try {
            const cards = generateCharacterCards([charDetail], coverImageBase64);
            for (const card of cards) {
              addPartialCharacter(sessionId, card);
            }
          } catch (error) {
            logger.error(`Failed to add partial character result (session ${sessionId}): ${error.message}`);
          }
        },
      });
      updateProgress(sessionId, `AI analysis complete - found ${analysis.characters?.length || 0} characters`);

      // Generate outputs
      updateProgress(sessionId, 'Generating character cards and lorebook...');

      if (!analysis.characters?.length) throw new Error('No characters found in book analysis');

      const characterCards = generateCharacterCards(analysis.characters, coverImageBase64);
      const lorebook = generateLorebook(analysis.worldInfo || {}, analysis.characters, analysis.characters[0]?.name);
      characterCards.forEach(card => { card.data.character_book = lorebook; });
      logger.info(`Generated ${characterCards.length} cards, ${lorebook.entries.length} lorebook entries`);

      if (!characterCards.length) throw new Error('Failed to generate character cards');
      if (!lorebook?.entries) throw new Error('Failed to generate lorebook');

      // Cleanup
      await cleanupFiles(file.path, coverImage?.path);

      updateProgress(sessionId, 'Complete! Sending results...');
      clearProgress(sessionId);

      res.json({
        characters: characterCards,
        lorebook,
        bookTitle: analysis.bookTitle,
        coverImage: coverImageBase64,
        sessionId,
      });
    } catch (error) {
      await cleanupRequestUploads(req);
      logger.error('Error processing file:', error.message);
      clearProgress(sessionId);
      res.status(500).json({ error: error.message || 'An error occurred during processing' });
    }
  });

  // POST /summary — text summary processing
  router.post('/summary', upload.single('coverImage'), async (req, res) => {
    try {
      const { summary, apiKey, model, contextLength, maxCompletionTokens, apiBaseUrl } = req.body;
      const coverImage = req.file;

      if (!summary) return res.status(400).json({ error: 'Summary text is required' });
      if (!apiKey) return res.status(400).json({ error: 'API key is required' });

      let coverImageBase64 = null;
      if (coverImage) {
        const coverBuffer = await fs.readFile(coverImage.path);
        coverImageBase64 = coverBuffer.toString('base64');
      }

      const contextSize = parseInt(contextLength) || DEFAULT_CONTEXT_LENGTH;
      const maxCompTokens = parseInt(maxCompletionTokens) || null;
      const providerUrl = apiBaseUrl || DEFAULT_API_BASE_URL;
      const analysis = await analyzeBook(summary, {
        apiKey,
        model,
        contextLength: contextSize,
        sessionId: null,
        updateProgress: null,
        apiBaseUrl: providerUrl,
        chapters: null,
        maxCompletionTokens: maxCompTokens,
      });

      const characterCards = generateCharacterCards(analysis.characters, coverImageBase64);
      const lorebook = generateLorebook(analysis.worldInfo, analysis.characters, analysis.characters[0]?.name);
      characterCards.forEach(card => { card.data.character_book = lorebook; });

      if (coverImage) await cleanupFiles(coverImage.path);

      res.json({
        characters: characterCards,
        lorebook,
        bookTitle: analysis.bookTitle,
        coverImage: coverImageBase64,
      });
    } catch (error) {
      await cleanupFiles(req.file?.path);
      logger.error('Error processing summary:', error.message);
      res.status(500).json({ error: error.message });
    }
  });

  // GET /platforms — return platform registry metadata for URL-based import
  router.get('/platforms', (_req, res) => {
    res.json({ platforms: getPlatformRegistry() });
  });

  // GET /interview-questions — editable interview prompts used by /import
  router.get('/interview-questions', async (_req, res) => {
    try {
      const questions = await getInterviewQuestions();
      res.json({ questions });
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });

  // PUT /interview-questions — replace interview prompts used by /import
  router.put('/interview-questions', async (req, res) => {
    let updated;
    try {
      updated = await setInterviewQuestions(req.body?.questions);
    } catch (error) {
      if (error instanceof ValidationError || error?.name === 'ValidationError') {
        return res.status(400).json({ error: error.message });
      }
      return res.status(500).json({ error: error.message });
    }

    res.json({ questions: updated });
  });

  // POST /interview-questions/reset — reset prompts to defaults
  router.post('/interview-questions/reset', async (_req, res) => {
    let questions;
    try {
      questions = await resetInterviewQuestions();
    } catch (error) {
      return res.status(500).json({ error: error.message });
    }

    res.json({ questions });
  });

  // GET /detect-platform — detect platform from a URL
  router.get('/detect-platform', (req, res) => {
    const { url } = req.query;
    if (!url) return res.status(400).json({ error: 'URL is required' });
    try {
      const platform = detectPlatform(url);
      if (!platform) {
        return res.json({ detected: false, message: 'Unrecognized platform. You can paste the character description manually.' });
      }
      res.json({ detected: true, ...platform });
    } catch {
      res.json({ detected: false, message: 'Could not parse URL.' });
    }
  });

  // POST /janitor-login — start JanitorAI login and return a pollable session id
  router.post('/janitor-login', (req, res) => {
    const proxyPort = getChromiumProxyPort();
    if (!proxyPort) {
      return res.status(503).json({
        error: 'Login popup requires the Electron app. Please run with: npm run electron:dev',
      });
    }

    pruneJanitorLoginSessions();
    const loginSessionId = `janitor_login_${Date.now()}_${Math.random().toString(36).substring(2, 11)}`;
    janitorLoginSessions.set(loginSessionId, {
      status: 'pending',
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });

    res.status(202).json({ sessionId: loginSessionId, status: 'pending' });

    // Run the long login handshake in the background and update session state.
    void (async () => {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), LOGIN_TIMEOUT_MS);
      try {
        const response = await fetch(`http://127.0.0.1:${proxyPort}/open-login`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: '{}',
          signal: controller.signal,
        });

        const data = await response.json().catch(() => ({}));

        if (!response.ok) {
          janitorLoginSessions.set(loginSessionId, {
            status: 'failed',
            error: data.error || 'Login failed',
            createdAt: janitorLoginSessions.get(loginSessionId)?.createdAt || Date.now(),
            updatedAt: Date.now(),
          });
          return;
        }

        janitorLoginSessions.set(loginSessionId, {
          status: 'completed',
          loggedIn: !!data.loggedIn,
          token: data.token,
          createdAt: janitorLoginSessions.get(loginSessionId)?.createdAt || Date.now(),
          updatedAt: Date.now(),
        });
      } catch (error) {
        const message = error.name === 'AbortError'
          ? 'Login request timed out'
          : (error.message || 'Login failed');
        janitorLoginSessions.set(loginSessionId, {
          status: 'failed',
          error: message,
          createdAt: janitorLoginSessions.get(loginSessionId)?.createdAt || Date.now(),
          updatedAt: Date.now(),
        });
      } finally {
        clearTimeout(timeout);
      }
    })();
  });

  // GET /janitor-login-status?sessionId=... — poll JanitorAI login status
  router.get('/janitor-login-status', (req, res) => {
    const sessionId = String(req.query.sessionId || '').trim();
    if (!sessionId) {
      return res.status(400).json({ error: 'sessionId is required' });
    }

    pruneJanitorLoginSessions();
    const sessionInfo = janitorLoginSessions.get(sessionId);
    if (!sessionInfo) {
      return res.status(404).json({ error: 'Login session not found or expired' });
    }

    res.json({ sessionId, ...sessionInfo });
  });

  // POST /cai-login — start Character.AI login and return a pollable session id
  router.post('/cai-login', (req, res) => {
    const proxyPort = getChromiumProxyPort();
    if (!proxyPort) {
      return res.status(503).json({
        error: 'Login popup requires the Electron app. Please run with: npm run electron:dev',
      });
    }

    pruneCAILoginSessions();
    const loginSessionId = `cai_login_${Date.now()}_${Math.random().toString(36).substring(2, 11)}`;
    caiLoginSessions.set(loginSessionId, {
      status: 'pending',
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });

    res.status(202).json({ sessionId: loginSessionId, status: 'pending' });

    // Run the long login handshake in the background and update session state.
    void (async () => {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), LOGIN_TIMEOUT_MS);
      try {
        const response = await fetch(`http://127.0.0.1:${proxyPort}/open-cai-login`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: '{}',
          signal: controller.signal,
        });

        const data = await response.json().catch(() => ({}));

        if (!response.ok) {
          caiLoginSessions.set(loginSessionId, {
            status: 'failed',
            error: data.error || 'Login failed',
            createdAt: caiLoginSessions.get(loginSessionId)?.createdAt || Date.now(),
            updatedAt: Date.now(),
          });
          return;
        }

        caiLoginSessions.set(loginSessionId, {
          status: 'completed',
          loggedIn: !!data.loggedIn,
          token: data.token,
          createdAt: caiLoginSessions.get(loginSessionId)?.createdAt || Date.now(),
          updatedAt: Date.now(),
        });
      } catch (error) {
        const message = error.name === 'AbortError'
          ? 'Login request timed out'
          : (error.message || 'Login failed');
        caiLoginSessions.set(loginSessionId, {
          status: 'failed',
          error: message,
          createdAt: caiLoginSessions.get(loginSessionId)?.createdAt || Date.now(),
          updatedAt: Date.now(),
        });
      } finally {
        clearTimeout(timeout);
      }
    })();
  });

  // GET /cai-login-status?sessionId=... — poll Character.AI login status
  router.get('/cai-login-status', (req, res) => {
    const sessionId = String(req.query.sessionId || '').trim();
    if (!sessionId) {
      return res.status(400).json({ error: 'sessionId is required' });
    }

    pruneCAILoginSessions();
    const sessionInfo = caiLoginSessions.get(sessionId);
    if (!sessionInfo) {
      return res.status(404).json({ error: 'Login session not found or expired' });
    }

    res.json({ sessionId, ...sessionInfo });
  });

  // POST /url-import — character import via URL scraping or manual text paste
  router.post('/url-import', upload.single('coverImage'), async (req, res) => {
    const sessionId = req.body.sessionId || generateSessionId();

    try {
      updateProgress(sessionId, 'Starting URL-based character import...');

      const {
        characterUrl,
        authToken,
        manualText,
        apiKey,
        model,
        contextLength,
        maxCompletionTokens,
        interviewMaxResponseTokens,
        apiBaseUrl,
      } = req.body;

      if (!apiKey) {
        return res.status(400).json({ error: 'AI provider API key is required' });
      }
      if (!characterUrl && !manualText) {
        return res.status(400).json({ error: 'Either a character URL or manual text is required' });
      }

      let characterText;
      let coverImageBase64 = null;
      let imageUrls = [];
      let rawCard = null;

      // Handle uploaded cover image
      if (req.file) {
        logger.info(`URL import: cover image received (${req.file.originalname}, ${req.file.size} bytes)`);
        const coverBuffer = await fs.readFile(req.file.path);
        coverImageBase64 = coverBuffer.toString('base64');
      }

      if (manualText && manualText.trim()) {
        // Manual fallback path — user pasted character text directly
        updateProgress(sessionId, 'Processing manually provided character text...');
        characterText = manualText.trim();
        logger.info(`URL import: using manual text (${characterText.length} chars)`);
      } else {
        // URL scraping path
        try {
          const result = await fetchCharacterFromUrl(
            characterUrl, authToken, sessionId, updateProgress,
          );
          characterText = result.formattedText;
          imageUrls = result.imageUrls || [];
          rawCard = result.rawCard || null;

          // If platform provided a cover image URL and user didn't upload one, try to download it
          if (!coverImageBase64 && result.coverImageUrl) {
            updateProgress(sessionId, 'Downloading character image...');
            coverImageBase64 = await downloadCoverImage(result.coverImageUrl);
          }
        } catch (error) {
          if (error.isManualFallback) {
            return res.status(422).json({
              error: error.message,
              manualFallbackRequired: true,
              platformLabel: error.platformLabel,
            });
          }
          throw error;
        }
      }

      // FAST PATH: If the platform returned structured card data, build the card
      // directly without AI analysis. This preserves all greetings and images
      // verbatim and completes in seconds instead of minutes.
      if (rawCard) {
        updateProgress(sessionId, 'Building character card from structured data...');
        logger.info(`URL import: using direct import fast path for "${rawCard.name}"`);

        const { characters, lorebook } = buildDirectCard(rawCard, coverImageBase64, imageUrls);
        characters.forEach(card => { card.data.character_book = lorebook; });

        logger.info(`URL import complete (direct): ${characters.length} card(s), ${lorebook.entries.length} lorebook entries`);

        if (req.file) await cleanupFiles(req.file.path);
        updateProgress(sessionId, 'Complete! Sending results...');
        clearProgress(sessionId);

        return res.json({
          characters,
          lorebook,
          bookTitle: `${rawCard.name} - Character Import`,
          coverImage: coverImageBase64,
          sessionId,
        });
      }

      // SLOW PATH: Unstructured data (scrape fallback / manual text) — use AI analysis
      updateProgress(sessionId, 'Analyzing character data with AI...');
      const contextSize = parseInt(contextLength) || DEFAULT_CONTEXT_LENGTH;
      const maxCompTokens = parseInt(maxCompletionTokens) || null;
      const interviewMaxTokens = parseInt(interviewMaxResponseTokens) || null;
      const providerUrl = apiBaseUrl || DEFAULT_API_BASE_URL;

      const analysis = await analyzeCharacterInterview(characterText, {
        apiKey,
        model,
        contextLength: contextSize,
        sessionId,
        updateProgress,
        apiBaseUrl: providerUrl,
        maxCompletionTokens: maxCompTokens,
        interviewMaxResponseTokens: interviewMaxTokens,
      });

      // Generate outputs (same as /import route)
      updateProgress(sessionId, 'Generating character card and lorebook...');
      await sendImportResults({
        analysis,
        coverImageBase64,
        imageUrls,
        sessionId,
        req,
        res,
        completeLogPrefix: 'URL import complete',
      });
    } catch (error) {
      if (req.file) await cleanupFiles(req.file.path);
      logger.error('Error in URL character import:', error.message);
      clearProgress(sessionId);
      res.status(500).json({ error: error.message || 'An error occurred during character import' });
    }
  });

  // POST /import — character import via external service interview
  router.post('/import', upload.single('coverImage'), async (req, res) => {
    const sessionId = req.body.sessionId || generateSessionId();

    try {
      updateProgress(sessionId, 'Starting character import...');

      const {
        importService,
        serviceUrl,
        serviceApiKey,
        caiToken,
        characterId,
        apiKey,
        model,
        contextLength,
        maxCompletionTokens,
        interviewMaxResponseTokens,
        apiBaseUrl,
      } = req.body;

      const isCAI = importService === 'characterai';

      // Validate based on service type
      if (isCAI) {
        if (!caiToken) {
          return res.status(400).json({ error: 'Character.AI auth token is required. Please log in first.' });
        }
        if (!characterId) {
          return res.status(400).json({ error: 'Character ID is required' });
        }
      } else {
        if (!serviceUrl) {
          return res.status(400).json({ error: 'Service API URL is required' });
        }
        if (!serviceApiKey) {
          return res.status(400).json({ error: 'Service API key is required' });
        }
        if (!characterId) {
          return res.status(400).json({ error: 'Character / AI ID is required' });
        }
      }
      if (!apiKey) {
        return res.status(400).json({ error: 'AI provider API key is required' });
      }

      logger.info(`Character import: service ${isCAI ? 'Character.AI' : serviceUrl}, model: ${model}`);

      // Phase 1: Interview the character on the external service
      let interviewText;
      let caiCharacterInfo = null;
      if (isCAI) {
        const result = await interviewCharacterCAI(
          caiToken,
          characterId,
          sessionId,
          updateProgress,
        );
        interviewText = result.text;
        caiCharacterInfo = result.characterInfo || null;
      } else {
        interviewText = await interviewCharacter(
          serviceUrl,
          serviceApiKey,
          characterId,
          sessionId,
          updateProgress,
        );
      }

      // Phase 1b: For Character.AI, get character info (name + avatar).
      // Primary source: cainode's own character.info() (returned from the interview).
      // Fallback: Electron Chromium proxy (bypasses Cloudflare via browser TLS).
      let caiAvatarUrl = null;
      let caiCharacterName = null;
      if (isCAI) {
        // Try the cainode-returned character info first
        if (caiCharacterInfo?.avatarFileName) {
          caiAvatarUrl = `https://characterai.io/i/400/static/avatars/${caiCharacterInfo.avatarFileName}`;
          logger.info(`Character import: c.ai avatar URL (from cainode): ${caiAvatarUrl}`);
        }
        if (caiCharacterInfo?.name) {
          caiCharacterName = caiCharacterInfo.name;
          logger.info(`Character import: c.ai character name (from cainode): "${caiCharacterName}"`);
        }
        if (caiCharacterInfo?.greeting && !interviewText.includes('## First Message / Greeting')) {
          const greeting = caiCharacterInfo.greeting.trim();
          if (greeting.length >= 20) {
            logger.info(`Character import: using greeting from cainode info (${greeting.length} chars)`);
            interviewText = `## First Message / Greeting\n\n${greeting}\n\n---\n\n${interviewText}`;
          }
        }

        // Fallback to Electron proxy if cainode didn't return the data we need
        if (!caiAvatarUrl || !caiCharacterName) {
          let timeoutId;
          try {
            updateProgress(sessionId, 'Fetching character info...');
            const proxyPort = getChromiumProxyPort();
            const controller = new AbortController();
            const timeoutMs = 8000;
            timeoutId = setTimeout(() => controller.abort(), timeoutMs);
            const infoResponse = await fetch(`http://127.0.0.1:${proxyPort}/cai-character-info`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ characterId, token: caiToken }),
              signal: controller.signal,
            });
            if (infoResponse.ok) {
              const infoData = await infoResponse.json();
              const charInfo = infoData?.character;
              if (!caiAvatarUrl && charInfo?.avatar_file_name) {
                caiAvatarUrl = `https://characterai.io/i/400/static/avatars/${charInfo.avatar_file_name}`;
                logger.info(`Character import: c.ai avatar URL (from proxy): ${caiAvatarUrl}`);
              }
              if (!caiCharacterName && charInfo?.name) {
                caiCharacterName = charInfo.name;
                logger.info(`Character import: c.ai character name (from proxy): "${caiCharacterName}"`);
              }
              if (charInfo?.greeting && !interviewText.includes('## First Message / Greeting')) {
                const greeting = charInfo.greeting.trim();
                if (greeting.length >= 20) {
                  logger.info(`Character import: using greeting from proxy info (${greeting.length} chars)`);
                  interviewText = `## First Message / Greeting\n\n${greeting}\n\n---\n\n${interviewText}`;
                }
              }
            } else {
              logger.warn(`Character import: c.ai proxy info request failed (status ${infoResponse.status})`);
            }
          } catch (error) {
            if (error?.name === 'AbortError') {
              logger.warn('Character import: c.ai proxy info request timed out');
            } else {
              logger.warn(`Character import: could not fetch c.ai character info via proxy: ${error.message}`);
            }
          } finally {
            if (timeoutId) {
              clearTimeout(timeoutId);
            }
          }
        }

        // Inject the real character name into the interview text so the AI uses it
        if (caiCharacterName) {
          interviewText = `## Character Name\n\nThis character's name is "${caiCharacterName}". Use this exact name.\n\n---\n\n${interviewText}`;
        }
      }

      // Cover image handling
      let coverImageBase64 = null;
      if (req.file) {
        logger.info(`Character import: cover image received (${req.file.originalname}, ${req.file.size} bytes)`);
        const coverBuffer = await fs.readFile(req.file.path);
        coverImageBase64 = coverBuffer.toString('base64');
      } else if (caiAvatarUrl) {
        // Auto-download Character.AI avatar when no user-uploaded image
        try {
          updateProgress(sessionId, 'Downloading character avatar...');
          coverImageBase64 = await downloadCoverImage(caiAvatarUrl);
          if (coverImageBase64) {
            logger.info('Character import: auto-downloaded Character.AI avatar');
          }
        } catch (error) {
          logger.warn(`Character import: could not download c.ai avatar: ${error.message}`);
        }
      } else {
        logger.info('Character import: no cover image provided');
      }

      // Phase 2: AI analysis using the user's configured provider
      updateProgress(sessionId, 'Analyzing interview responses with AI...');
      const contextSize = parseInt(contextLength) || DEFAULT_CONTEXT_LENGTH;
      const maxCompTokens = parseInt(maxCompletionTokens) || null;
      const interviewMaxTokens = parseInt(interviewMaxResponseTokens) || null;
      const providerUrl = apiBaseUrl || DEFAULT_API_BASE_URL;

      const analysis = await analyzeCharacterInterview(interviewText, {
        apiKey,
        model,
        contextLength: contextSize,
        sessionId,
        updateProgress,
        apiBaseUrl: providerUrl,
        maxCompletionTokens: maxCompTokens,
        interviewMaxResponseTokens: interviewMaxTokens,
      });

      // Validate AI produced meaningful data before generating cards
      const chars = analysis.characters || [];
      const mainChar = chars[0];
      if (!mainChar || !mainChar.name || mainChar.name === 'Unknown Character') {
        const desc = mainChar?.description || '';
        if (!mainChar || desc.length < 50) {
          logger.warn('Character import: AI returned placeholder/empty character data');
          clearProgress(sessionId);
          if (req.file) await cleanupFiles(req.file.path);
          return res.status(422).json({
            error: 'The AI could not extract meaningful character data from the interview responses. '
              + 'The character may not have provided enough detail. '
              + 'Try pasting character info manually using the URL Import tab instead.',
          });
        }
      }

      // Generate outputs
      updateProgress(sessionId, 'Generating character card and lorebook...');
      await sendImportResults({
        analysis,
        coverImageBase64,
        imageUrls: [],
        sessionId,
        req,
        res,
        completeLogPrefix: 'Character import complete',
      });
    } catch (error) {
      if (req.file) await cleanupFiles(req.file.path);
      logger.error('Error in character import:', error.message);
      clearProgress(sessionId);
      res.status(500).json({ error: error.message || 'An error occurred during character import' });
    }
  });

  return router;
}

// Default export for backward compatibility (standalone node server.js usage).
// Lazily initialized to avoid creating directories at module-load time,
// which fails when running inside an Electron asar archive.
let _defaultRouter = null;
export function getDefaultRouter() {
  if (!_defaultRouter) {
    const __dirname = path.dirname(fileURLToPath(import.meta.url));
    _defaultRouter = createProcessRouter(path.resolve(__dirname, '..', 'uploads'));
  }
  return _defaultRouter;
}
