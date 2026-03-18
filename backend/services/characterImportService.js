import axios from 'axios';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import logger from '../utils/logger.js';
import {
  IMPORT_SERVICE_REQUEST_TIMEOUT_MS,
  IMPORT_SERVICE_MAX_RETRIES,
  IMPORT_INTER_MESSAGE_DELAY_MS,
  IMPORT_SERVICE_RETRY_DELAY_MS,
  IMPORT_MIN_RESPONSE_LENGTH,
  IMPORT_MAX_CONSECUTIVE_EMPTY,
  IMPORT_MIN_TOTAL_CHARS,
  IMPORT_MAX_RESPONSE_CHARS,
} from '../config/constants.js';
import { DEFAULT_INTERVIEW_QUESTIONS } from '../config/interviewQuestions.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
let INTERVIEW_QUESTIONS_STORE_PATH = process.env.INTERVIEW_QUESTIONS_STORE_PATH
  || path.resolve(__dirname, '../uploads/interview-questions.json');

/**
 * Override the interview-questions store path at runtime.
 * Called by the router when Electron passes a writable uploadsPath
 * (inside app.getPath('userData')) so we don't write into the ASAR archive.
 */
export function setInterviewQuestionsStorePath(uploadsPath) {
  INTERVIEW_QUESTIONS_STORE_PATH = path.join(uploadsPath, 'interview-questions.json');
}

export class ValidationError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ValidationError';
  }
}

function cloneInterviewQuestions(questions) {
  return questions.map((q) => ({
    id: String(q.id),
    category: String(q.category),
    question: String(q.question),
    enabled: q.enabled !== false,
  }));
}

function normalizeInterviewQuestions(questions) {
  if (!Array.isArray(questions)) {
    throw new ValidationError('questions must be an array');
  }

  const normalized = [];
  for (const q of questions) {
    if (!q || typeof q !== 'object') continue;
    const id = String(q.id || '').trim();
    const category = String(q.category || '').trim();
    const question = String(q.question || '').trim();
    if (!id || !category || !question) continue;
    normalized.push({ id, category, question, enabled: q.enabled !== false });
  }

  if (normalized.length === 0) {
    throw new ValidationError('questions array must contain at least one valid question');
  }

  return normalized;
}

async function readInterviewQuestionsStore() {
  try {
    const raw = await fs.readFile(INTERVIEW_QUESTIONS_STORE_PATH, 'utf8');
    const parsed = JSON.parse(raw);
    const candidate = parsed?.questions ?? parsed;
    return normalizeInterviewQuestions(candidate);
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    logger.warn(`Interview questions store is invalid (${INTERVIEW_QUESTIONS_STORE_PATH}): ${error.message}. Falling back to defaults.`);
    return null;
  }
}

async function writeInterviewQuestionsStore(questions) {
  await fs.mkdir(path.dirname(INTERVIEW_QUESTIONS_STORE_PATH), { recursive: true });
  const tmpPath = `${INTERVIEW_QUESTIONS_STORE_PATH}.tmp`;
  await fs.writeFile(tmpPath, JSON.stringify({ questions }, null, 2), 'utf8');
  await fs.rename(tmpPath, INTERVIEW_QUESTIONS_STORE_PATH);
}

async function deleteInterviewQuestionsStore() {
  try {
    await fs.unlink(INTERVIEW_QUESTIONS_STORE_PATH);
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
}

export async function getInterviewQuestions() {
  const stored = await readInterviewQuestionsStore();
  const source = stored || DEFAULT_INTERVIEW_QUESTIONS;
  return cloneInterviewQuestions(source);
}

export async function setInterviewQuestions(questions) {
  const normalized = normalizeInterviewQuestions(questions);
  await writeInterviewQuestionsStore(normalized);
  return cloneInterviewQuestions(normalized);
}

export async function resetInterviewQuestions() {
  await deleteInterviewQuestionsStore();
  return cloneInterviewQuestions(DEFAULT_INTERVIEW_QUESTIONS);
}

function makeHeaders(apiKey) {
  return {
    'Authorization': `Bearer ${apiKey}`,
    'Content-Type': 'application/json',
  };
}

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Extract text from a service API response.
 * Different services may return data in different formats.
 */
function extractResponseText(responseData) {
  if (typeof responseData === 'string') return responseData;
  if (responseData?.message) return responseData.message;
  if (responseData?.response) return responseData.response;
  if (responseData?.text) return responseData.text;
  if (responseData?.content) return responseData.content;
  if (responseData?.choices?.[0]?.message?.content) return responseData.choices[0].message.content;
  return JSON.stringify(responseData);
}

/**
 * Interview a character on an external AI companion service.
 * Currently supports Kindroid-style APIs (/send-message + /chat-break).
 *
 * @param {string} serviceUrl - Base URL of the service API (e.g. https://api.kindroid.ai/v1)
 * @param {string} serviceApiKey - API key for the service
 * @param {string} characterId - The character/AI ID on the service
 * @param {string|null} sessionId - Session ID for progress tracking
 * @param {Function|null} updateProgress - Progress update callback
 * @returns {Promise<string>} Combined interview text document
 */
export async function interviewCharacter(serviceUrl, serviceApiKey, characterId, sessionId, updateProgress) {
  const progress = (msg) => { if (updateProgress && sessionId) updateProgress(sessionId, msg); };

  const baseUrl = serviceUrl.replace(/\/+$/, '');
  const headers = makeHeaders(serviceApiKey);

  // Step 1: Reset conversation context
  progress('Resetting character conversation context...');
  logger.info(`Character import: sending chat-break to ${baseUrl}/chat-break (ai_id: ${characterId})`);
  try {
    const breakResponse = await axios.post(`${baseUrl}/chat-break`, {
      ai_id: characterId,
      greeting: 'Hello! I would like to learn more about you.',
    }, {
      headers,
      timeout: IMPORT_SERVICE_REQUEST_TIMEOUT_MS,
    });
    logger.info(`Character import: chat-break successful (status: ${breakResponse.status})`);
  } catch (error) {
    const status = error.response?.status;
    logger.warn(`Chat-break failed: status=${status}, code=${error.code}, message=${error.message}`);
    if (error.response?.data) {
      logger.warn(`Chat-break response body: ${JSON.stringify(error.response.data).substring(0, 500)}`);
    }
    if (status === 401 || status === 403) {
      throw new Error('Invalid service API key. Check your API key and try again.');
    }
    if (status === 404) {
      throw new Error('Character not found. Check your Character ID and try again.');
    }
    logger.warn('Proceeding with interview despite chat-break failure');
  }

  // Step 2: Send interview questions sequentially
  const responses = [];
  let consecutiveEmpty = 0;
  const currentQuestions = await getInterviewQuestions();
  const enabledQuestions = currentQuestions.filter((q) => q.enabled !== false);
  // Optional test knob: limit question count via env var without code changes.
  const parsedLimit = Number.parseInt(process.env.INTERVIEW_QUESTION_LIMIT || '', 10);
  const limit = Number.isInteger(parsedLimit) && parsedLimit >= 1
    ? parsedLimit
    : enabledQuestions.length;
  const questionsToSend = enabledQuestions.slice(0, Math.min(limit, enabledQuestions.length));
  const totalQuestions = questionsToSend.length;

  for (let i = 0; i < totalQuestions; i++) {
    const q = questionsToSend[i];
    progress(`Interviewing character: ${q.category} (${i + 1}/${totalQuestions})...`);

    const requestUrl = `${baseUrl}/send-message`;
    const constrainedMessage = `${q.question}\n\n(Keep your response under ${IMPORT_MAX_RESPONSE_CHARS} characters. Be detailed but concise — prioritize the most important information.)`;
    const requestBody = { ai_id: characterId, message: constrainedMessage };
    logger.info(`Character import [${q.id}]: POST ${requestUrl} (timeout: ${IMPORT_SERVICE_REQUEST_TIMEOUT_MS}ms)`);
    logger.debug(`Character import [${q.id}]: request body: ${JSON.stringify(requestBody).substring(0, 200)}`);

    let response = null;
    for (let attempt = 0; attempt <= IMPORT_SERVICE_MAX_RETRIES; attempt++) {
      try {
        const startTime = Date.now();
        response = await axios.post(requestUrl, requestBody, {
          headers,
          timeout: IMPORT_SERVICE_REQUEST_TIMEOUT_MS,
        });
        const elapsed = Date.now() - startTime;

        logger.info(`Character import [${q.id}]: response status=${response.status}, elapsed=${elapsed}ms, data type=${typeof response.data}`);
        logger.debug(`Character import [${q.id}]: raw response data (first 500 chars): ${
          typeof response.data === 'string'
            ? response.data.substring(0, 500)
            : JSON.stringify(response.data).substring(0, 500)
        }`);
        break; // success — exit retry loop
      } catch (error) {
        const status = error.response?.status;
        logger.error(`Character import [${q.id}]: FAILED (attempt ${attempt + 1}/${IMPORT_SERVICE_MAX_RETRIES + 1}) — status=${status}, code=${error.code}, message=${error.message}`);
        if (error.response?.data) {
          logger.error(`Character import [${q.id}]: error response body: ${JSON.stringify(error.response.data).substring(0, 500)}`);
        }
        if (error.response?.headers) {
          logger.debug(`Character import [${q.id}]: response headers: ${JSON.stringify(error.response.headers).substring(0, 500)}`);
        }

        // Non-retryable errors — fail immediately
        if (status === 401 || status === 403) {
          throw new Error('Invalid service API key. Check your API key and try again.');
        }
        if (status === 429) {
          throw new Error('Service rate limited. Please wait a moment and try again.');
        }

        // Retryable: timeout or transient error
        if (attempt < IMPORT_SERVICE_MAX_RETRIES) {
          const isTimeout = error.code === 'ECONNABORTED';
          const backoffMs = isTimeout ? IMPORT_SERVICE_RETRY_DELAY_MS : IMPORT_INTER_MESSAGE_DELAY_MS;
          const retryLabel = isTimeout
            ? `timed out, backing off ${Math.round(backoffMs / 1000)}s`
            : `failed (${error.code || status})`;
          logger.info(`Character import [${q.id}]: ${retryLabel}, retrying after ${backoffMs}ms...`);
          progress(`"${q.category}" ${retryLabel}, retrying (${attempt + 2}/${IMPORT_SERVICE_MAX_RETRIES + 1})...`);
          await delay(backoffMs);
          continue;
        }

        // All retries exhausted
        if (error.code === 'ECONNABORTED') {
          throw new Error(`Character did not respond to "${q.category}" (timed out after ${IMPORT_SERVICE_REQUEST_TIMEOUT_MS / 1000}s, ${IMPORT_SERVICE_MAX_RETRIES + 1} attempts). The character may be unresponsive. Please try again.`);
        }
        throw new Error(`Failed during "${q.category}": status=${status}, ${error.response?.data?.error || error.message}`);
      }
    }

    if (!response) {
      logger.error(`Character import [${q.id}]: no response object after retry loop for "${q.category}"`);
      throw new Error(`Failed during "${q.category}": no response received from service after retries.`);
    }

    const responseText = extractResponseText(response.data);

    responses.push({
      category: q.category,
      question: q.question,
      answer: responseText,
    });

    logger.info(`Character import [${q.id}]: extracted ${responseText.length} chars`);

    // Track response quality — abort early if character isn't providing data
    if (responseText.trim().length < IMPORT_MIN_RESPONSE_LENGTH) {
      consecutiveEmpty++;
      logger.warn(`Character import [${q.id}]: short/empty response (${consecutiveEmpty} consecutive)`);
      if (consecutiveEmpty >= IMPORT_MAX_CONSECUTIVE_EMPTY) {
        logger.error(`Character import: aborting — ${consecutiveEmpty} consecutive empty responses`);
        throw new Error(
          `Character returned ${consecutiveEmpty} empty responses in a row. `
          + 'The character may not have enough data to import. '
          + 'Try pasting character info manually instead.'
        );
      }
    } else {
      consecutiveEmpty = 0;
    }

    // Delay between messages to avoid rate limiting
    if (i < totalQuestions - 1) {
      await delay(IMPORT_INTER_MESSAGE_DELAY_MS);
    }
  }

  // Step 3: Assemble into a structured text document
  progress('Compiling interview responses...');
  const document = responses
    .map(r => `## ${r.category}\n\n**Q:** ${r.question}\n\n**A:** ${r.answer}`)
    .join('\n\n---\n\n');

  logger.info(`Character interview complete: ${responses.length} responses, ${document.length} total chars`);

  // Validate we have enough data before sending to AI
  const answerChars = responses.reduce((sum, r) => sum + r.answer.trim().length, 0);
  if (answerChars < IMPORT_MIN_TOTAL_CHARS) {
    throw new Error(
      `Interview collected too little data (${answerChars} chars of answers). `
      + 'The character\'s responses were too short to generate a meaningful card. '
      + 'Try pasting character info manually instead.'
    );
  }

  // Step 4: Reset conversation context and capture the character's natural greeting.
  // Send chat-break without a custom greeting so the character responds with their
  // configured default greeting — this is the authentic first message they use in chats.
  progress('Capturing character greeting...');
  let characterGreeting = null;
  try {
    const greetingResponse = await axios.post(`${baseUrl}/chat-break`, {
      ai_id: characterId,
    }, {
      headers,
      timeout: IMPORT_SERVICE_REQUEST_TIMEOUT_MS,
    });
    const greetingText = extractResponseText(greetingResponse.data);
    if (greetingText && greetingText.trim().length >= IMPORT_MIN_RESPONSE_LENGTH) {
      characterGreeting = greetingText.trim();
      logger.info(`Character import: captured natural greeting (${characterGreeting.length} chars)`);
    } else {
      logger.info(`Character import: greeting too short or empty (${greetingText?.length || 0} chars), skipping`);
    }
    logger.info('Character import: post-interview chat-break successful');
  } catch (error) {
    logger.warn(`Post-interview chat-break failed: ${error.message} (non-fatal)`);
  }

  // Prepend the character's actual greeting so the AI analysis reproduces it verbatim
  // as the first message (matching how urlImportService handles "## First Message / Greeting").
  if (characterGreeting) {
    const greetingSection = `## First Message / Greeting\n\n${characterGreeting}`;
    return `${greetingSection}\n\n---\n\n${document}`;
  }

  return document;
}
