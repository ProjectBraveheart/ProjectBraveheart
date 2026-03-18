import logger from '../utils/logger.js';
import { getInterviewQuestions } from './characterImportService.js';
import {
  CAI_INTER_MESSAGE_DELAY_MS,
  IMPORT_MIN_RESPONSE_LENGTH,
  IMPORT_MAX_CONSECUTIVE_EMPTY,
  IMPORT_MIN_TOTAL_CHARS,
} from '../config/constants.js';

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Extract the text content from a CAINode SingleCharacterChatInfo response.
 * Shape: { turn: { candidates: [{ raw_content: "...", is_final: true }] } }
 */
function extractCAIResponseText(response) {
  const candidates = response?.turn?.candidates;
  if (Array.isArray(candidates) && candidates.length > 0) {
    return candidates[0].raw_content || '';
  }
  return '';
}

/**
 * Try to extract the greeting text from a CAINode create_new_conversation response.
 * The response shape varies between cainode versions, so we try multiple paths.
 */
function extractGreetingText(greetingResponse) {
  // cainode create_new_conversation(true) returns an array:
  //   [0] = {chat, command, request_id}  — the chat creation response
  //   [1] = {turn: {candidates: [{raw_content: "...", is_final: true}]}} — the greeting
  // Try extractCAIResponseText on EVERY element, not just [0].
  if (Array.isArray(greetingResponse)) {
    for (const item of greetingResponse) {
      const text = extractCAIResponseText(item);
      if (text) return text;
    }
    // Fallback: check direct properties on each element
    for (const item of greetingResponse) {
      if (typeof item === 'string' && item.trim()) return item;
      const raw = item?.raw_content || item?.text || item?.body;
      if (raw && typeof raw === 'string') return raw;
    }
  }
  // Direct response object (non-array)
  const direct = extractCAIResponseText(greetingResponse);
  if (direct) return direct;
  if (greetingResponse?.replies?.[0]?.text) return greetingResponse.replies[0].text;
  if (typeof greetingResponse?.text === 'string') return greetingResponse.text;
  if (typeof greetingResponse?.message === 'string') return greetingResponse.message;
  return '';
}

/**
 * Interview a character on Character.AI via the cainode WebSocket API.
 *
 * Creates a new conversation with the character, asks the standard interview
 * questions, captures the greeting, and assembles a markdown document in
 * the same format as interviewCharacter() (for Kindroid) so the downstream
 * AI analysis + card generation pipeline works unchanged.
 *
 * @param {string} token - Character.AI auth token
 * @param {string} characterId - Character external ID (from the c.ai URL)
 * @param {string|null} sessionId - Session ID for progress tracking
 * @param {Function|null} updateProgress - Progress update callback
 * @returns {Promise<{text: string}>} Interview text
 */
export async function interviewCharacterCAI(token, characterId, sessionId, updateProgress) {
  const progress = (msg) => { if (updateProgress && sessionId) updateProgress(sessionId, msg); };

  // Dynamically import cainode (it's an optional dependency)
  let CAINode;
  try {
    const mod = await import('cainode');
    CAINode = mod.CAINode || mod.default;
  } catch {
    throw new Error(
      'Character.AI interview is not available (cainode package not installed). '
      + 'Please install it with: npm install cainode',
    );
  }

  const client = new CAINode();

  try {
    // Step 1: Login
    progress('Connecting to Character.AI...');
    logger.info(`CAI interview: logging in (token: ${token.length} chars)`);
    try {
      await client.login(token);
    } catch (error) {
      throw new Error(
        'Character.AI login failed. Your token may have expired — please log in again. '
        + `(${typeof error === 'string' ? error : error.message})`,
      );
    }
    logger.info('CAI interview: login successful');

    // Step 2: Connect to character
    progress('Connecting to character...');
    logger.info(`CAI interview: connecting to character ${characterId}`);
    try {
      await client.character.connect(characterId, false);
    } catch (error) {
      throw new Error(
        `Could not connect to character "${characterId}" on Character.AI. `
        + 'Check that the Character ID is correct and try again. '
        + `(${typeof error === 'string' ? error : error.message})`,
      );
    }
    logger.info('CAI interview: connected to character');

    // Step 2b: Fetch character info (name, avatar, greeting) via cainode's
    // own internal fetch — uses the same https_fetch that worked for login,
    // so it should bypass Cloudflare.
    let characterInfo = null;
    try {
      progress('Fetching character info...');
      logger.info('CAI interview: fetching character info via cainode');
      const infoResult = await client.character.info(characterId);
      const charData = infoResult?.character;
      if (charData) {
        characterInfo = {
          name: charData.name || charData.participant__name || null,
          avatarFileName: charData.avatar_file_name || null,
          greeting: charData.greeting || null,
          title: charData.title || null,
        };
        logger.info(`CAI interview: character info — name="${characterInfo.name}", avatar="${characterInfo.avatarFileName}", greeting=${characterInfo.greeting?.length || 0} chars`);
      } else {
        logger.warn('CAI interview: character info response had no character data');
      }
    } catch (error) {
      // Non-fatal — we can still interview without character info
      const errMsg = typeof error === 'string' ? error : error.message;
      logger.warn(`CAI interview: character.info() failed — ${errMsg}`);
    }

    // Step 3: Create a fresh conversation and capture the greeting
    progress('Starting new conversation...');
    logger.info('CAI interview: creating new conversation with greeting');
    let characterGreeting = null;
    try {
      const greetingResponse = await client.character.create_new_conversation(true);
      // Log the full response shape for debugging
      logger.info(`CAI interview: greeting response type=${typeof greetingResponse}, isArray=${Array.isArray(greetingResponse)}`);
      logger.debug(`CAI interview: greeting response keys=${greetingResponse ? JSON.stringify(Object.keys(greetingResponse)).substring(0, 300) : 'null'}`);
      if (Array.isArray(greetingResponse) && greetingResponse.length > 0) {
        logger.debug(`CAI interview: greeting[0] keys=${JSON.stringify(Object.keys(greetingResponse[0])).substring(0, 300)}`);
      }

      const greetingText = extractGreetingText(greetingResponse);
      if (greetingText && greetingText.trim().length >= IMPORT_MIN_RESPONSE_LENGTH) {
        characterGreeting = greetingText.trim();
        logger.info(`CAI interview: captured greeting (${characterGreeting.length} chars)`);
      } else {
        logger.info(`CAI interview: greeting too short or empty (${greetingText?.length || 0} chars), skipping`);
      }
    } catch (error) {
      // Non-fatal — we can still interview without capturing the greeting
      logger.warn(`CAI interview: failed to capture greeting: ${typeof error === 'string' ? error : error.message}`);
    }

    // Step 4: Send interview questions
    const responses = [];
    let consecutiveEmpty = 0;
    const currentQuestions = await getInterviewQuestions();
    const enabledQuestions = currentQuestions.filter(q => q.enabled !== false);

    const parsedLimit = Number.parseInt(process.env.INTERVIEW_QUESTION_LIMIT || '', 10);
    const limit = Number.isInteger(parsedLimit) && parsedLimit >= 1
      ? parsedLimit
      : enabledQuestions.length;
    const questionsToSend = enabledQuestions.slice(0, Math.min(limit, enabledQuestions.length));
    const totalQuestions = questionsToSend.length;

    logger.info(`CAI interview: sending ${totalQuestions} questions`);

    for (let i = 0; i < totalQuestions; i++) {
      const q = questionsToSend[i];
      progress(`Interviewing character: ${q.category} (${i + 1}/${totalQuestions})...`);

      logger.info(`CAI interview [${q.id}]: sending question for "${q.category}"`);

      let responseText = '';
      try {
        const response = await client.character.send_message(
          `${q.question}\n\nPlease be as detailed as possible in your response.`,
        );
        responseText = extractCAIResponseText(response);
      } catch (error) {
        // If a single question fails, log and continue with empty response
        // rather than aborting the entire interview
        const errMsg = typeof error === 'string' ? error : error.message;
        logger.error(`CAI interview [${q.id}]: send_message failed — ${errMsg}`);

        // Auth/connection errors are fatal
        if (errMsg.includes('login') || errMsg.includes('Unauthorized') || errMsg.includes('token')) {
          throw new Error(
            'Your Character.AI session expired during the interview. '
            + 'Please log in again and retry.',
          );
        }
        // For other errors, record empty and let consecutive-empty logic handle it
      }

      responses.push({
        category: q.category,
        question: q.question,
        answer: responseText,
      });

      logger.info(`CAI interview [${q.id}]: got ${responseText.length} chars`);

      // Track response quality — abort early if character isn't providing data
      if (responseText.trim().length < IMPORT_MIN_RESPONSE_LENGTH) {
        consecutiveEmpty++;
        logger.warn(`CAI interview [${q.id}]: short/empty response (${consecutiveEmpty} consecutive)`);
        if (consecutiveEmpty >= IMPORT_MAX_CONSECUTIVE_EMPTY) {
          logger.error(`CAI interview: aborting — ${consecutiveEmpty} consecutive empty responses`);
          throw new Error(
            `Character returned ${consecutiveEmpty} empty responses in a row. `
            + 'The character may not have enough data to import. '
            + 'Try importing via URL or pasting character info manually instead.',
          );
        }
      } else {
        consecutiveEmpty = 0;
      }

      // Delay between messages to avoid rate limiting
      if (i < totalQuestions - 1) {
        await delay(CAI_INTER_MESSAGE_DELAY_MS);
      }
    }

    // Step 5: Assemble into a structured text document
    progress('Compiling interview responses...');
    const document = responses
      .map(r => `## ${r.category}\n\n**Q:** ${r.question}\n\n**A:** ${r.answer}`)
      .join('\n\n---\n\n');

    logger.info(`CAI interview complete: ${responses.length} responses, ${document.length} total chars`);

    // Validate we have enough data before sending to AI
    const answerChars = responses.reduce((sum, r) => sum + r.answer.trim().length, 0);
    if (answerChars < IMPORT_MIN_TOTAL_CHARS) {
      throw new Error(
        `Interview collected too little data (${answerChars} chars of answers). `
        + 'The character\'s responses were too short to generate a meaningful card. '
        + 'Try importing via URL or pasting character info manually instead.',
      );
    }

    // Prepend the character's greeting so the AI analysis reproduces it verbatim
    let interviewText = document;
    if (characterGreeting) {
      const greetingSection = `## First Message / Greeting\n\n${characterGreeting}`;
      interviewText = `${greetingSection}\n\n---\n\n${document}`;
    }

    return { text: interviewText, characterInfo };
  } finally {
    // Always cleanup WebSocket connections
    try { await client.character.disconnect(); } catch { /* ignore */ }
    try { await client.logout(); } catch { /* ignore */ }
  }
}
