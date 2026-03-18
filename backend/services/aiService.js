import axios from 'axios';
import logger from '../utils/logger.js';
import {
  DEFAULT_API_BASE_URL,
  CHARS_PER_TOKEN,
  CONTEXT_INPUT_RATIO,
  CHUNK_FILL_RATIO,
  MAX_RESPONSE_TOKENS,
  INTERVIEW_RESPONSE_TOKENS,
  MAX_CONTINUATION_ATTEMPTS,
  MAX_CHARACTER_RETRIES,
  MAX_PARALLEL_CHARACTER_CALLS,
  AI_REQUEST_TIMEOUT_MS,
  CONNECTION_TEST_TIMEOUT_MS,
} from '../config/constants.js';

/**
 * Test connection to an OpenAI-compatible API
 * @param {string} apiBaseUrl
 * @param {string} apiKey
 * @returns {Promise<{success: boolean, modelCount?: number, error?: string}>}
 */
export async function testConnection(apiBaseUrl, apiKey) {
  try {
    const response = await axios.get(`${apiBaseUrl}/models`, {
      headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      timeout: CONNECTION_TEST_TIMEOUT_MS,
    });
    const models = response.data.data || response.data;
    return { success: true, modelCount: Array.isArray(models) ? models.length : 0 };
  } catch (error) {
    const msg = error.response?.data?.error?.message || error.response?.statusText || error.message;
    return { success: false, error: msg };
  }
}

/**
 * Get available models from an OpenAI-compatible API
 * @param {string} apiKey
 * @param {string} apiBaseUrl
 * @returns {Promise<Array>}
 */
export async function getAvailableModels(apiKey, apiBaseUrl = DEFAULT_API_BASE_URL) {
  try {
    // Use detailed=true for providers like NanoGPT that gate context_length behind it
    const normalizedBaseUrl = `${apiBaseUrl.replace(/\/+$/, '')}/`;
    const url = new URL('models', normalizedBaseUrl);
    url.searchParams.set('detailed', 'true');

    const response = await axios.get(url.toString(), {
      headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    });
    const models = response.data.data || response.data;
    if (!Array.isArray(models)) throw new Error('Unexpected response format from models endpoint');

    return models.map(model => {
      // Normalize pricing to per-million-tokens for all providers
      let pricing = null;
      if (model.pricing) {
        const raw = model.pricing;
        const alreadyPerMillion = raw.unit === 'per_million_tokens';
        const prompt = parseFloat(raw.prompt);
        const completion = parseFloat(raw.completion);
        pricing = {
          prompt: isNaN(prompt) ? null : (alreadyPerMillion ? prompt : prompt * 1_000_000),
          completion: isNaN(completion) ? null : (alreadyPerMillion ? completion : completion * 1_000_000),
          unit: 'per_million_tokens',
        };
      }

      return {
        id: model.id,
        name: model.name || model.id,
        context_length: model.context_length || 4096,
        max_completion_tokens: model.top_provider?.max_completion_tokens || model.max_output_tokens || null,
        pricing,
        category: model.category || null,
      };
    });
  } catch (error) {
    const msg = error.response?.data?.error?.message || error.response?.statusText || error.message;
    throw new Error(`Failed to fetch models: ${msg}`);
  }
}

// ---------------------------------------------------------------------------
// Text chunking
// ---------------------------------------------------------------------------

/**
 * Split text into chunks by paragraphs (fallback for oversized chapters).
 */
function chunkText(text, maxTokens) {
  const charsPerChunk = maxTokens * CHARS_PER_TOKEN;
  const chunks = [];
  const paragraphs = text.split(/\n\n+/);
  let current = '';

  for (const paragraph of paragraphs) {
    if ((current + paragraph).length < charsPerChunk) {
      current += paragraph + '\n\n';
    } else {
      if (current) chunks.push(current.trim());
      current = paragraph + '\n\n';
    }
  }
  if (current) chunks.push(current.trim());
  return chunks;
}

/**
 * Split text into chunks at chapter boundaries.
 * Falls back to paragraph splitting for oversized chapters.
 */
function chunkByChapters(chapters, maxTokens) {
  const charsPerChunk = maxTokens * CHARS_PER_TOKEN;
  const chunks = [];
  let current = '';

  for (const chapter of chapters) {
    const chapterText = chapter.title
      ? `--- ${chapter.title} ---\n\n${chapter.text}`
      : chapter.text;

    if (chapterText.length > charsPerChunk) {
      if (current) { chunks.push(current.trim()); current = ''; }
      chunks.push(...chunkText(chapterText, maxTokens));
      continue;
    }

    if (current && (current.length + chapterText.length) > charsPerChunk) {
      chunks.push(current.trim());
      current = '';
    }
    current += chapterText + '\n\n';
  }
  if (current) chunks.push(current.trim());

  logger.info(`Chapter-aware chunking: ${chapters.length} chapters -> ${chunks.length} chunks`);
  return chunks;
}

// ---------------------------------------------------------------------------
// AI API helpers
// ---------------------------------------------------------------------------

function makeHeaders(apiKey) {
  return { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' };
}

/**
 * Summarize a single chunk of text.
 */
async function summarizeChunk(chunk, apiKey, model, apiBaseUrl) {
  const response = await axios.post(
    `${apiBaseUrl}/chat/completions`,
    {
      model,
      messages: [{
        role: 'user',
        content: `Summarize this excerpt from a book, focusing on characters, plot events, world-building details, and key information:\n\n${chunk}`,
      }],
    },
    {
      headers: makeHeaders(apiKey),
      timeout: AI_REQUEST_TIMEOUT_MS,
    },
  );
  if (!response.data?.choices?.[0]?.message?.content) {
    throw new Error('AI returned an empty or unexpected response while summarizing chunk');
  }
  return response.data.choices[0].message.content;
}

/**
 * Chunk and summarize text that exceeds the model's context window.
 */
async function chunkAndSummarize(bookText, chapters, maxCharsForInput, safeContextSize, apiKey, model, apiBaseUrl, sessionId, updateProgress) {
  const progress = (msg) => { if (updateProgress && sessionId) updateProgress(sessionId, msg); };
  progress('Book too large, chunking into smaller pieces...');

  const chunkTokenSize = Math.floor(safeContextSize * CHUNK_FILL_RATIO);
  const chunks = (chapters && chapters.length > 0)
    ? chunkByChapters(chapters, chunkTokenSize)
    : chunkText(bookText, chunkTokenSize);

  logger.info(`Split into ${chunks.length} chunks`);

  const summaries = [];
  for (let i = 0; i < chunks.length; i++) {
    progress(`Summarizing chunk ${i + 1} of ${chunks.length}...`);
    summaries.push(await summarizeChunk(chunks[i], apiKey, model, apiBaseUrl));
  }

  let combined = summaries.join('\n\n---\n\n');

  const maxReduceAttempts = 3;
  let reduceAttempt = 0;
  while (combined.length > maxCharsForInput && reduceAttempt < maxReduceAttempts) {
    reduceAttempt += 1;
    logger.info(`Combined summary too large (${combined.length} chars), reduction attempt ${reduceAttempt}/${maxReduceAttempts}...`);
    combined = await summarizeChunk(combined, apiKey, model, apiBaseUrl);
  }

  if (combined.length > maxCharsForInput) {
    logger.warn(`Combined summary still exceeds max input (${combined.length} > ${maxCharsForInput}) after ${maxReduceAttempts} attempts; truncating safely.`);
    combined = `${combined.slice(0, maxCharsForInput - 1)}…`;
  }

  return combined;
}

/**
 * Send the analysis prompt to the AI and return content + finish reason.
 */
async function requestAnalysis(prompt, apiKey, model, apiBaseUrl, maxResponseTokens) {
  const response = await axios.post(
    `${apiBaseUrl}/chat/completions`,
    {
      model,
      messages: [{ role: 'user', content: prompt }],
      response_format: { type: 'json_object' },
      stream: false,
      max_tokens: maxResponseTokens,
    },
    {
      headers: makeHeaders(apiKey),
      timeout: AI_REQUEST_TIMEOUT_MS,
    },
  );

  if (!response.data?.choices?.[0]?.message?.content) {
    throw new Error('AI response missing message content');
  }

  const choice = response.data.choices[0];
  return { content: choice.message.content, finishReason: choice.finish_reason };
}

/**
 * Ask the AI to continue a truncated JSON response.
 */
async function continueResponse(originalPrompt, partialResponse, apiKey, model, apiBaseUrl, maxResponseTokens) {
  const response = await axios.post(
    `${apiBaseUrl}/chat/completions`,
    {
      model,
      messages: [
        { role: 'user', content: originalPrompt },
        { role: 'assistant', content: partialResponse },
        { role: 'user', content: 'Your JSON response was cut off. Continue EXACTLY from where you stopped. Output ONLY the remaining JSON to complete the object. Do not repeat any content.' },
      ],
      stream: false,
      max_tokens: maxResponseTokens,
    },
    {
      headers: makeHeaders(apiKey),
      timeout: AI_REQUEST_TIMEOUT_MS,
    },
  );

  return response.data?.choices?.[0]?.message?.content || '';
}

/**
 * Attempt to parse JSON from AI response, with repair logic for common issues.
 */
async function parseAIResponse(content, aiOptions) {
  let initialParseError = null;

  // Try direct parse first
  try {
    return JSON.parse(content);
  } catch (err) {
    initialParseError = err;
  }

  logger.debug(`Direct JSON parse failed, attempting repair: ${initialParseError?.message || 'Unknown parse error'}`);
  let cleaned = content.trim();

  // Strip markdown code fences (handles ```json, ```, and variations with whitespace)
  cleaned = cleaned.replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/i, '');
  cleaned = cleaned.trim();

  // Extract outermost JSON object
  const first = cleaned.indexOf('{');
  const last = cleaned.lastIndexOf('}');
  if (first !== -1 && last > first) {
    cleaned = cleaned.substring(first, last + 1);
  }

  try { return JSON.parse(cleaned); } catch (err) {
    // Attempt to fix truncated JSON by closing open strings/brackets
    logger.debug('Standard repair failed, attempting truncation repair...');
    const repaired = repairTruncatedJSON(cleaned);
    if (repaired) {
      try { return JSON.parse(repaired); } catch (_) { /* fall through */ }
    }

    // Last resort: ask the AI to fix the malformed JSON
    if (aiOptions?.apiKey && aiOptions?.model && aiOptions?.apiBaseUrl) {
      try {
        const fixed = await requestJSONRepair(cleaned, aiOptions.apiKey, aiOptions.model, aiOptions.apiBaseUrl);
        logger.info('AI-assisted JSON repair succeeded');
        return fixed;
      } catch (repairErr) {
        logger.warn(`AI-assisted JSON repair failed: ${repairErr.message}`);
      }
    }

    throw new Error(
      `Failed to parse AI response after repair attempt: ${err.message}. Initial parse error: ${initialParseError?.message || 'Unknown parse error'}`,
    );
  }
}

/**
 * Attempt to repair truncated JSON by closing open strings, arrays, and objects.
 */
function repairTruncatedJSON(json) {
  // Trim back to the last complete value (ends with ", }, ], true, false, null, or a number)
  let trimmed = json.replace(/,\s*$/, '');

  // If we're inside an unterminated string, close it
  let inString = false;
  let lastGoodPos = 0;
  for (let i = 0; i < trimmed.length; i++) {
    const ch = trimmed[i];
    if (ch === '\\' && inString) { i++; continue; }
    if (ch === '"') { inString = !inString; }
    if (!inString && (ch === '}' || ch === ']' || ch === '"')) {
      lastGoodPos = i;
    }
  }

  if (inString) {
    // Cut at the last good position before the unterminated string and close it
    trimmed = trimmed.substring(0, lastGoodPos + 1);
  }

  // Remove any trailing comma
  trimmed = trimmed.replace(/,\s*$/, '');

  // Count open brackets and close them
  const stack = [];
  inString = false;
  for (let i = 0; i < trimmed.length; i++) {
    const ch = trimmed[i];
    if (ch === '\\' && inString) { i++; continue; }
    if (ch === '"') { inString = !inString; continue; }
    if (inString) continue;
    if (ch === '{' || ch === '[') stack.push(ch);
    if (ch === '}' || ch === ']') stack.pop();
  }

  // Close any remaining open brackets
  let suffix = '';
  while (stack.length > 0) {
    const open = stack.pop();
    suffix += open === '{' ? '}' : ']';
  }

  if (suffix) {
    logger.info(`Repaired truncated JSON by appending: ${suffix}`);
    return trimmed + suffix;
  }
  return null;
}

/**
 * Ask the AI to fix malformed JSON. Used as a last-resort fallback when
 * all programmatic repair attempts have failed.
 */
async function requestJSONRepair(brokenJSON, apiKey, model, apiBaseUrl) {
  const prompt = `The following JSON is malformed and cannot be parsed. Fix ONLY the JSON syntax errors and return the corrected JSON.

Rules:
- Do NOT change, remove, or summarize any data values
- Fix unescaped quotes inside strings (e.g. He said "hello" → He said \\"hello\\")
- Fix missing or extra commas
- Fix unclosed brackets, braces, or strings
- Preserve all fields and array items exactly as they are
- Return raw JSON only — no markdown, no code fences, no explanations

Malformed JSON:
${brokenJSON}`;

  logger.info('Attempting AI-assisted JSON repair...');
  const { data } = await axios.post(`${apiBaseUrl}/chat/completions`, {
    model,
    messages: [{ role: 'user', content: prompt }],
    response_format: { type: 'json_object' },
    stream: false,
    max_tokens: Math.min(32000, Math.ceil(brokenJSON.length / CHARS_PER_TOKEN * 1.5)),
  }, {
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    timeout: AI_REQUEST_TIMEOUT_MS,
  });

  let repaired = data?.choices?.[0]?.message?.content;
  if (!repaired) throw new Error('AI repair returned empty response');

  // Strip markdown fences the repair model may have added
  repaired = repaired.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/i, '').trim();

  // Extract outermost JSON object
  const firstBrace = repaired.indexOf('{');
  const lastBrace = repaired.lastIndexOf('}');
  if (firstBrace !== -1 && lastBrace > firstBrace) {
    repaired = repaired.substring(firstBrace, lastBrace + 1);
  }

  return JSON.parse(repaired);
}

/**
 * Validate and normalize the parsed analysis object.
 */
function validateAnalysis(analysis) {
  if (!analysis.characters || !Array.isArray(analysis.characters)) {
    throw new Error('AI response missing characters array');
  }
  if (!analysis.worldInfo) {
    logger.warn('AI response missing worldInfo, using empty structure');
    analysis.worldInfo = { setting: '', locations: [], factions: [], items: [], concepts: [] };
  }
  if (!analysis.bookTitle) {
    analysis.bookTitle = 'Unknown Book';
  }
  return analysis;
}

// ---------------------------------------------------------------------------
// Phase-specific validation
// ---------------------------------------------------------------------------

/**
 * Validate Phase 1 extraction result.
 */
function validateExtractionResult(result) {
  if (!result.bookTitle) result.bookTitle = 'Unknown Book';
  if (!result.characters || !Array.isArray(result.characters)) {
    throw new Error('AI extraction response missing characters array');
  }
  result.characters = result.characters.filter(c => c.name && c.role);
  if (result.characters.length === 0) {
    throw new Error('AI extraction returned no valid characters (each needs name and role)');
  }
  if (!result.worldInfo) {
    logger.warn('AI extraction response missing worldInfo, using empty structure');
    result.worldInfo = { setting: '', locations: [], factions: [], items: [], concepts: [] };
  }
  return result;
}

/**
 * Validate Phase 2 character detail result with fallback defaults.
 */
function validateCharacterDetail(detail, expectedName) {
  if (!detail.name) detail.name = expectedName;
  detail.background = detail.background || '';
  detail.physicalDescription = detail.physicalDescription || '';
  detail.personality = detail.personality || '';
  detail.commonPhrases = Array.isArray(detail.commonPhrases) ? detail.commonPhrases : [];
  detail.likes = Array.isArray(detail.likes) ? detail.likes : [];
  detail.dislikes = Array.isArray(detail.dislikes) ? detail.dislikes : [];
  detail.dailyLife = detail.dailyLife || '';
  detail.skills = detail.skills || '';
  detail.userRelationship = detail.userRelationship || '';
  detail.userKnowledge = detail.userKnowledge || '';
  detail.sharedExperiences = detail.sharedExperiences || '';
  detail.scenario = detail.scenario || '';
  detail.firstMessages = Array.isArray(detail.firstMessages) ? detail.firstMessages.filter(m => m && m.trim()) : [];
  detail.exampleDialogue = detail.exampleDialogue || '';
  detail.tags = Array.isArray(detail.tags) ? detail.tags : [];
  detail.canBePersona = detail.canBePersona ?? false;
  return detail;
}

// ---------------------------------------------------------------------------
// Concurrency utility
// ---------------------------------------------------------------------------

/**
 * Run async tasks with a concurrency limit, preserving result order.
 */
async function runWithConcurrency(tasks, concurrency) {
  const results = new Array(tasks.length);
  let nextIndex = 0;

  async function worker() {
    while (nextIndex < tasks.length) {
      const index = nextIndex++;
      results[index] = await tasks[index]();
    }
  }

  const workers = Array.from(
    { length: Math.min(concurrency, tasks.length) },
    () => worker(),
  );
  await Promise.all(workers);
  return results;
}

// ---------------------------------------------------------------------------
// Phase 2: per-character detail fetch
// ---------------------------------------------------------------------------

/**
 * Fetch full details for a single character with continuation + retry logic.
 * Returns null if all retries are exhausted (caller should skip).
 */
async function fetchCharacterDetail(
  textToAnalyze, characterSummary, bookTitle,
  apiKey, model, apiBaseUrl, maxResponseTokens,
  sessionId, updateProgress, characterIndex, totalCharacters,
) {
  const progress = (msg) => { if (updateProgress && sessionId) updateProgress(sessionId, msg); };
  const charLabel = `${characterSummary.name} (${characterIndex + 1}/${totalCharacters})`;

  const prompt = buildCharacterDetailPrompt(textToAnalyze, characterSummary, bookTitle);

  for (let retry = 0; retry <= MAX_CHARACTER_RETRIES; retry++) {
    try {
      progress(`Generating details for ${charLabel}...`);
      logger.info(`Character detail request for ${characterSummary.name} (attempt ${retry + 1})`);

      let { content, finishReason } = await requestAnalysis(
        prompt, apiKey, model, apiBaseUrl, maxResponseTokens,
      );

      // Handle truncation with continuation
      if (finishReason === 'length') {
        for (let attempt = 1; attempt <= MAX_CONTINUATION_ATTEMPTS; attempt++) {
          logger.info(`Character ${characterSummary.name} truncated, continuation ${attempt}/${MAX_CONTINUATION_ATTEMPTS}`);
          progress(`Response for ${charLabel} was truncated, continuing...`);

          const continuation = await continueResponse(prompt, content, apiKey, model, apiBaseUrl, maxResponseTokens);
          if (!continuation) break;
          content += continuation;

          try {
            return validateCharacterDetail(await parseAIResponse(content, { apiKey, model, apiBaseUrl }), characterSummary.name);
          } catch (err) {
            logger.error(
              `Still cannot parse ${characterSummary.name} after continuation: ${err.message}\n${err.stack || ''}`,
            );
            logger.debug(`Raw continuation content for ${characterSummary.name}: ${content}`);
          }
        }
      }

      const detail = validateCharacterDetail(await parseAIResponse(content, { apiKey, model, apiBaseUrl }), characterSummary.name);
      logger.info(`Parsed character detail for ${characterSummary.name}`);
      progress(`Completed ${charLabel}`);
      return detail;
    } catch (error) {
      logger.error(`Character detail failed for ${characterSummary.name} (attempt ${retry + 1}):`, error.message);
      if (retry < MAX_CHARACTER_RETRIES) {
        progress(`Retrying ${charLabel} (attempt ${retry + 2})...`);
        continue;
      }
      logger.warn(`Skipping ${characterSummary.name} after ${MAX_CHARACTER_RETRIES + 1} failed attempts`);
      progress(`Could not generate details for ${characterSummary.name}, skipping...`);
      return null;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

/**
 * Analyze book text and extract characters and world information.
 * Uses a two-phase approach: Phase 1 extracts a character roster + worldInfo,
 * Phase 2 fetches full details for each character in parallel.
 *
 * @param {string} bookText - The book text or summary
 * @param {Object} options
 * @param {string} options.apiKey
 * @param {string} [options.model='anthropic/claude-3.5-sonnet']
 * @param {number} [options.contextLength=200000] - Model's context window size in tokens
 * @param {string|null} [options.sessionId=null]
 * @param {Function|null} [options.updateProgress=null]
 * @param {string} [options.apiBaseUrl=DEFAULT_API_BASE_URL]
 * @param {Array|null} [options.chapters=null] - Optional chapter array for chapter-aware chunking
 * @param {number|null} [options.maxCompletionTokens=null] - Model's max output tokens (from provider)
 * @param {Function|null} [options.onCharacterComplete=null] - Called with (characterDetail, index, total) when each character finishes
 * @param {Function|null} [options.onExtractionComplete=null] - Called with (extraction) when Phase 1 finishes
 * @returns {Promise<Object>} Analysis with characters and worldInfo
 */
export async function analyzeBook(bookText, {
  apiKey,
  model = 'anthropic/claude-3.5-sonnet',
  contextLength = 200000,
  sessionId = null,
  updateProgress = null,
  apiBaseUrl = DEFAULT_API_BASE_URL,
  chapters = null,
  maxCompletionTokens = null,
  onCharacterComplete = null,
  onExtractionComplete = null,
} = {}) {
  if (!apiKey) {
    throw new Error('apiKey is required for analyzeBook');
  }

  const progress = (msg) => { if (updateProgress && sessionId) updateProgress(sessionId, msg); };

  const safeContextSize = Math.floor(contextLength * CONTEXT_INPUT_RATIO);
  const maxCharsForInput = safeContextSize * CHARS_PER_TOKEN;

  logger.info(`Book: ${bookText.length} chars, max input: ${maxCharsForInput} chars`);

  // Chunk and summarize if needed (unchanged)
  let textToAnalyze = bookText;
  if (bookText.length > maxCharsForInput) {
    textToAnalyze = await chunkAndSummarize(
      bookText, chapters, maxCharsForInput, safeContextSize,
      apiKey, model, apiBaseUrl, sessionId, updateProgress,
    );
  }

  // Helper to calculate max response tokens for a given prompt.
  // Adds 15% safety margin to input estimate to account for tokenizer variance
  // (CHARS_PER_TOKEN is approximate; real tokenizers often produce more tokens).
  function calcMaxResponseTokens(prompt) {
    const inputTokenEstimate = Math.ceil(prompt.length / CHARS_PER_TOKEN * 1.15);
    let tokens = Math.max(MAX_RESPONSE_TOKENS, contextLength - inputTokenEstimate);
    if (maxCompletionTokens) tokens = Math.min(tokens, maxCompletionTokens);
    return tokens;
  }

  // ---- PHASE 1: Extract character roster + worldInfo ----
  progress('Extracting character roster and world info...');
  const extractionPrompt = buildExtractionPrompt(textToAnalyze);
  const extractionMaxTokens = calcMaxResponseTokens(extractionPrompt);

  logger.info(`Phase 1: sending ${textToAnalyze.length} chars, max response tokens: ${extractionMaxTokens}`);

  let extraction;
  try {
    let { content, finishReason } = await requestAnalysis(
      extractionPrompt, apiKey, model, apiBaseUrl, extractionMaxTokens,
    );
    logger.info(`Phase 1 response: ${content.length} chars (finish_reason: ${finishReason})`);

    if (finishReason === 'length') {
      for (let attempt = 1; attempt <= MAX_CONTINUATION_ATTEMPTS; attempt++) {
        logger.info(`Phase 1 truncated, continuation ${attempt}/${MAX_CONTINUATION_ATTEMPTS}`);
        progress(`Extraction response truncated, requesting continuation (${attempt}/${MAX_CONTINUATION_ATTEMPTS})...`);
        const continuation = await continueResponse(extractionPrompt, content, apiKey, model, apiBaseUrl, extractionMaxTokens);
        if (!continuation) break;
        content += continuation;
        try {
          extraction = validateExtractionResult(await parseAIResponse(content, { apiKey, model, apiBaseUrl }));
          break;
        } catch {
          logger.info('Phase 1 still cannot parse after continuation');
        }
      }
    }

    if (!extraction) {
      extraction = validateExtractionResult(await parseAIResponse(content, { apiKey, model, apiBaseUrl }));
    }

    logger.info(`Phase 1 complete: "${extraction.bookTitle}", ${extraction.characters.length} characters identified`);
    progress(`Found ${extraction.characters.length} characters. Generating detailed profiles...`);
    if (onExtractionComplete) {
      try { onExtractionComplete(extraction); } catch (_) { /* non-critical */ }
    }
  } catch (error) {
    logger.error('Phase 1 error:', error.message);
    if (error.code === 'ECONNABORTED') {
      throw new Error('AI request timed out during extraction. Try a smaller book or try again later.');
    }
    if (error.response) {
      const msg = error.response.data?.error?.message || error.response.data?.error || error.response.statusText;
      throw new Error(`AI service error during extraction: ${msg}`);
    }
    if (error.request) {
      throw new Error('No response from AI service. Check your internet connection and API key.');
    }
    throw new Error(`AI extraction failed: ${error.message}`);
  }

  // ---- PHASE 2: Per-character detail calls ----
  const samplePrompt = buildCharacterDetailPrompt(textToAnalyze, extraction.characters[0], extraction.bookTitle);
  const charMaxTokens = calcMaxResponseTokens(samplePrompt);
  const totalCharacters = extraction.characters.length;

  logger.info(`Phase 2: ${totalCharacters} characters, max response tokens per character: ${charMaxTokens}`);

  const tasks = extraction.characters.map((charSummary, index) => {
    return async () => {
      const detail = await fetchCharacterDetail(
        textToAnalyze, charSummary, extraction.bookTitle,
        apiKey, model, apiBaseUrl, charMaxTokens,
        sessionId, updateProgress, index, totalCharacters,
      );
      if (detail && onCharacterComplete) {
        try { onCharacterComplete(detail, index, totalCharacters); } catch (_) { /* non-critical */ }
      }
      return detail;
    };
  });

  const characterDetails = await runWithConcurrency(tasks, MAX_PARALLEL_CHARACTER_CALLS);
  const successfulCharacters = characterDetails.filter(c => c !== null);

  if (successfulCharacters.length === 0) {
    throw new Error('Failed to generate details for any characters. Please try again.');
  }

  if (successfulCharacters.length < totalCharacters) {
    logger.warn(`${totalCharacters - successfulCharacters.length} character(s) failed and were skipped`);
    progress(`Completed with ${successfulCharacters.length}/${totalCharacters} characters`);
  }

  // ---- Assemble final result ----
  const analysis = {
    bookTitle: extraction.bookTitle,
    characters: successfulCharacters,
    worldInfo: extraction.worldInfo,
  };

  const validated = validateAnalysis(analysis);
  logger.info(`Analysis complete: ${validated.characters.length} characters, book: "${validated.bookTitle}"`);
  progress(`Analysis complete — ${validated.characters.length} character profiles generated`);

  return validated;
}

// ---------------------------------------------------------------------------
// Prompt templates
// ---------------------------------------------------------------------------

/**
 * Phase 1: Extraction prompt — character roster + worldInfo.
 */
function buildExtractionPrompt(text) {
  return `Analyze this book text and extract a list of important characters and detailed world information.

CRITICAL: Return ONLY valid JSON. No markdown, no code fences, no backticks, no explanations. Just raw JSON starting with { and ending with }.
Ensure all quotes inside string values are escaped with backslashes (e.g. "He said \\"hello\\"").

Book Text:
${text}

Return a JSON object with this structure:
{
  "bookTitle": "Title of the book",
  "characters": [
    {
      "name": "Character Name",
      "role": "main_character|love_interest|protagonist|antagonist|supporting|mentor|rival",
      "briefDescription": "1-2 sentences summarizing who this character is, their significance, and key traits"
    }
  ],
  "worldInfo": {
    "setting": "Detailed world/universe description (2-3 paragraphs covering geography, society, rules, tone)",
    "locations": [{"name": "Location Name", "description": "Detailed description of this place, its significance, and what happens there", "keywords": ["alias", "nickname", "related terms that should trigger this entry"]}],
    "factions": [{"name": "Faction Name", "description": "Who they are, their goals, structure, and role in the story", "keywords": ["alias", "abbreviation", "leader name", "related terms"]}],
    "items": [{"name": "Item Name", "description": "What it is, its properties, significance, and who uses it", "keywords": ["alias", "nickname", "related terms"]}],
    "concepts": [{"name": "Concept Name", "description": "Explanation of this magic system, technology, social concept, etc.", "keywords": ["alias", "related terms", "slang used in-universe"]}]
  }
}

Instructions:
- Identify 3-10 important characters
- For each character, provide ONLY name, role, and a brief 1-2 sentence description
- For worldInfo entries: include 3-6 keywords per entry (aliases, nicknames, abbreviations, related terms)
- Write worldInfo descriptions as detailed context an AI would need to roleplay accurately in this setting
- Return ONLY JSON, no other text`;
}

/**
 * Phase 2: Character detail prompt — full profile for a single character.
 */
function buildCharacterDetailPrompt(text, characterSummary, bookTitle) {
  return `You are analyzing the book "${bookTitle}". Focus on this specific character:

Name: ${characterSummary.name}
Role: ${characterSummary.role}
Summary: ${characterSummary.briefDescription}

CRITICAL: Return ONLY valid JSON. No markdown, no code fences, no backticks, no explanations. Just raw JSON starting with { and ending with }.
Ensure all quotes inside string values are escaped with backslashes (e.g. "He said \\"hello\\"").

Book Text:
${text}

Return a JSON object with detailed information about ${characterSummary.name}:
{
  "name": "${characterSummary.name}",
  "role": "${characterSummary.role}",
  "background": "1-2 paragraph background covering history, relationships, what shaped them",
  "physicalDescription": "1 paragraph: height, build, age, hair, eyes, distinctive features, clothing",
  "personality": "1-2 paragraphs: core traits, quirks, motivations, values, strengths, weaknesses",
  "commonPhrases": ["3-5 distinctive phrases or expressions they use"],
  "scenario": "Describe the scenario of when this character first meets {{user}} (1 paragraph). Set the scene with key details: setting, circumstances, mood, what brings them together. Use {{user}} instead of the other character's actual name.",
  "firstMessages": [
    "First message option 1 - Opening message when meeting {{user}}. 1-3 paragraphs. Start with backstory/context: what led to this moment, their emotional state, recent events. Then describe the scene with sensory details. Finally, their greeting or first action. Use quotes for dialogue and asterisks for actions/thoughts. Make it immersive and in-character.",
    "First message option 2 - Different opening showing another personality aspect. 1-3 paragraphs with context, scene-setting, and interaction. Use quotes for dialogue and asterisks for actions/thoughts.",
    "First message option 3 - Another variation (emotional, action-packed, humorous, or intimate). 1-3 paragraphs with comprehensive backstory and scene details. Use quotes for dialogue and asterisks for actions/thoughts.",
    "First message option 4 - A quieter or more introspective opening. 1-3 paragraphs showing a different side of the character. Use quotes for dialogue and asterisks for actions/thoughts.",
    "First message option 5 - A dramatic or high-stakes opening. 1-3 paragraphs with tension, urgency, or strong emotion. Use quotes for dialogue and asterisks for actions/thoughts."
  ],
  "exampleDialogue": "4-6 short exchanges. Use {{user}} for other person. Use quotes for speech, asterisks for actions",
  "tags": ["5-15 tags: gender, genre, personality, role"],
  "canBePersona": true
}

Instructions:
- Focus ONLY on ${characterSummary.name}
- Aim for ~3000 tokens of detailed content
- Replace interaction partner names with {{user}} in scenarios/messages/dialogue
- Use quotes for dialogue, asterisks for actions in messages
- Mark as canBePersona: true if this is a main character the user could roleplay as
- Return ONLY JSON, no other text`;
}

// ---------------------------------------------------------------------------
// Character interview analysis (single-character import from external services)
// ---------------------------------------------------------------------------

/**
 * Build a specialized extraction prompt for a character interview transcript.
 * Unlike the book analysis prompts, this handles first-person self-descriptions
 * and memory recall, producing a single character + worldInfo in one pass.
 */
function buildCharacterInterviewPrompt(interviewText) {
  return `You are analyzing an interview transcript where a character describes themselves, their world, and their memories.
Extract ALL information to build a complete, thorough character profile AND world information. Capture every detail mentioned.

CRITICAL: Return ONLY valid JSON. No markdown, no code fences, no backticks, no explanations. Just raw JSON starting with { and ending with }.
Ensure all quotes inside string values are escaped with backslashes (e.g. "He said \\"hello\\"").

Interview Transcript:
${interviewText}

Return a JSON object with this structure:
{
  "name": "Character's name",
  "role": "main_character",
  "background": "2-3 paragraphs covering complete history, origins, key events, relationships, and what shaped them. Written in third person. Include every detail from the interview — do not summarize or abbreviate.",
  "physicalDescription": "1-2 paragraphs: height, build, body type, age, hair, eyes, skin, scars, distinctive features, typical clothing, accessories. Written in third person. Include every physical detail mentioned.",
  "personality": "2-3 paragraphs: every core trait, quirk, habit, value, strength, weakness, and personality framework info (MBTI, Enneagram, etc. if mentioned). Written in third person. Be thorough.",
  "likes": ["Each specific thing the character likes/enjoys/loves, with brief context (e.g. 'Bruce Springsteen\\'s Thunder Road — plays it while painting'). Include every like mentioned in the interview."],
  "dislikes": ["Each specific thing the character dislikes/hates/avoids, with brief context (e.g. 'The color beige — associates it with lab origins'). Include every dislike mentioned."],
  "dailyLife": "1-2 paragraphs describing their living situation, home, pets, prized possessions, daily routine, and typical activities. Written in third person.",
  "skills": "1 paragraph listing all skills, knowledge areas, hobbies, interests, and areas of expertise. Written in third person.",
  "userRelationship": "2-3 paragraphs describing the character's relationship with {{user}} in third person. Include: how they met, the relationship timeline and key milestones, how the character feels about {{user}}, the tone and dynamic of their relationship, and what {{user}} means to the character. Extract this from the relationship-with-user interview responses.",
  "userKnowledge": "1-2 paragraphs listing everything the character knows about {{user}} — their interests, preferences, personality traits, habits, and any facts the character has learned. Written in third person. Extract from the knowledge-about-user interview responses.",
  "sharedExperiences": "1-2 paragraphs describing favorite shared activities, common conversation topics, inside jokes, recurring themes, and the most memorable moments between the character and {{user}}. Written in third person.",
  "commonPhrases": ["5-10 distinctive phrases or expressions they use, taken directly from their speech patterns in the interview"],
  "scenario": "Describe the scenario of when this character first meets {{user}} (1 paragraph). Set the scene with key details: setting, circumstances, mood, what brings them together. Use {{user}} for the person they are meeting.",
  "firstMessages": [
    "IMPORTANT: If the source text contains a greeting, first message, or opening message/scenario, reproduce it HERE exactly as-is — preserve all formatting, dialogue (quotes), actions (asterisks), and narrative text verbatim. Only replace the user/player name with {{user}}. If no existing greeting is found, create one.",
    "Write a NEW original greeting scenario — a different situation where this character meets {{user}}. Stay fully in-character: use their speech patterns, personality, mannerisms, and reference their world/setting/occupation from the interview data. The scene should feel authentically like this character, just in a new situation. 1-3 paragraphs with scene-setting and the character's opening words/actions. Use quotes for dialogue and asterisks for actions/thoughts. Do NOT copy text from the interview.",
    "Write a NEW original greeting scenario with a different mood or setting (e.g. emotional, humorous, intense, casual). Stay fully in-character using their voice, quirks, and knowledge from the interview. 1-3 paragraphs. Use quotes for dialogue and asterisks for actions/thoughts. Do NOT copy text from the interview.",
    "Write a NEW original greeting scenario — a quieter or more introspective opening showing a different side of the character. Stay fully in-character using their personality, interests, and world details from the interview. 1-3 paragraphs. Use quotes for dialogue and asterisks for actions/thoughts. Do NOT copy text from the interview.",
    "Write a NEW original greeting scenario — a dramatic or high-stakes opening with tension, urgency, or strong emotion. Stay fully in-character using their background, motivations, and speech patterns from the interview. 1-3 paragraphs. Use quotes for dialogue and asterisks for actions/thoughts. Do NOT copy text from the interview."
  ],
  "exampleDialogue": "4-6 short exchanges showing the character's voice. Use {{user}} for the other person. Use quotes for speech, asterisks for actions.",
  "tags": ["5-15 tags: gender, genre, personality, role, species, setting, etc."],
  "canBePersona": true,
  "worldInfo": {
    "setting": "Detailed world/universe description if the character described one (2-3 paragraphs covering geography, society, rules, tone). Leave empty string if real-world/modern/unspecified.",
    "locations": [{"name": "Location Name", "description": "Detailed description of this place, its significance, and events that happened there", "keywords": ["alias", "nickname", "related terms"]}],
    "factions": [{"name": "Faction/Group Name", "description": "Who they are, their goals, structure, and relationship to the character", "keywords": ["alias", "abbreviation", "related terms"]}],
    "items": [{"name": "Item Name", "description": "What it is, its properties, significance, and who uses it", "keywords": ["alias", "related terms"]}],
    "concepts": [{"name": "Concept Name", "description": "Explanation of this concept, system, or lore element", "keywords": ["alias", "related terms"]}]
  }
}

Instructions:
- The character described themselves in first person — transform ALL descriptions to third person for background, physicalDescription, personality, dailyLife, and skills
- Capture EVERY detail from the interview. Do not summarize or leave out information. The goal is to preserve all character data.
- Use the character's own words and speech patterns for commonPhrases and exampleDialogue
- For likes and dislikes, include EVERY specific preference mentioned — favorite music, food, activities, textures, smells, colors, etc.
- For dailyLife, include their home, living situation, pets, possessions, and routine
- For skills, include all hobbies, interests, knowledge areas, and abilities mentioned
- For userRelationship, userKnowledge, and sharedExperiences: extract from the relationship-focused interview questions. Use {{user}} as the placeholder for the interviewer. Write in third person. Capture the full relationship timeline, every known fact about {{user}}, and all shared experiences and conversation topics.
- CRITICAL — firstMessages MUST contain exactly 5 entries (an array of 5 strings). Entry 1: If the source text includes a greeting/first message/opening scenario, reproduce it EXACTLY as-is (preserve all formatting, dialogue, actions, narrative verbatim — only replace the user/player name with {{user}}). Entries 2-5: Write 4 NEW original greeting scenarios — each in a different situation, mood, or setting. These must feel authentically like this character: use their speech patterns, personality traits, mannerisms, world details, and occupation from the interview. But do NOT copy or rephrase interview text — create fresh scenes that showcase who this character is. Never return fewer than 5 first messages.
- For scenario, create an immersive scene based on the character's described world and personality
- Use {{user}} for the interaction partner in scenarios, messages, and dialogue
- Use quotes for dialogue, asterisks for actions in messages
- Set canBePersona to true (the user wants to interact with/as this character)
- IMPORTANT: The interview was conducted by a user/interviewer. Do NOT create worldInfo entries for the interviewer/questioner — they are represented as {{user}} in the final output. Only create worldInfo entries for OTHER named people, places, and concepts the character mentions.
- If a "## Chat Conversation" section is included, it contains a real roleplay conversation between the character and {{user}}. Mine it thoroughly for:
  - The character's actual speech patterns, vocabulary, and mannerisms (use for commonPhrases and exampleDialogue)
  - Relationship dynamics, how the character treats {{user}}, emotional tone (use for userRelationship)
  - Facts the character reveals about {{user}} (use for userKnowledge)
  - Shared experiences, inside jokes, recurring topics (use for sharedExperiences)
  - Named people, locations, items, factions, and lore concepts (use for worldInfo entries)
  - Personality traits demonstrated through actions and dialogue (use for personality)
  - Physical details described during the conversation (use for physicalDescription)
  The chat conversation is the richest source of character voice and world details — extract everything.
- Mine the memory and journal responses for lorebook content:
  - Named people from memories (NOT the interviewer) should become character entries in worldInfo (as factions or add to setting description)
  - Named locations from memories should become location entries
  - Groups, organizations, or factions mentioned should become faction entries
  - Significant objects should become item entries
  - Recurring concepts, lore, rules, or systems should become concept entries
- For worldInfo: only populate entries if the character described meaningful world details. For modern/real-world characters, still extract specific named locations and people from memories and chat conversations
- Include 3-6 keywords per worldInfo entry (aliases, nicknames, abbreviations, related terms)
- Return ONLY JSON, no other text`;
}

/**
 * Assemble a character interview AI response into the standard analysis format.
 */
function assembleInterviewResult(parsed) {
  const detail = validateCharacterDetail(parsed, parsed.name || 'Unknown Character');

  if (!detail.role) detail.role = 'main_character';

  const result = {
    bookTitle: detail.name ? `${detail.name} - Character Import` : 'Character Import',
    characters: [detail],
    worldInfo: parsed.worldInfo || {
      setting: '',
      locations: [],
      factions: [],
      items: [],
      concepts: [],
    },
  };

  return validateAnalysis(result);
}

/**
 * Analyze a character interview transcript and extract character data + worldInfo.
 * Uses a single-phase approach since we know it's exactly one character.
 *
 * @param {string} interviewText - Combined interview Q&A text
 * @param {Object} options
 * @param {string} options.apiKey
 * @param {string} [options.model]
 * @param {number} [options.contextLength=200000]
 * @param {string|null} [options.sessionId=null]
 * @param {Function|null} [options.updateProgress=null]
 * @param {string} [options.apiBaseUrl]
 * @param {number|null} [options.maxCompletionTokens=null]
 * @param {number|null} [options.interviewMaxResponseTokens=null]
 * @returns {Promise<Object>} Analysis with characters array (single character) and worldInfo
 */
export async function analyzeCharacterInterview(interviewText, {
  apiKey,
  model = 'anthropic/claude-3.5-sonnet',
  contextLength = 200000,
  sessionId = null,
  updateProgress = null,
  apiBaseUrl = DEFAULT_API_BASE_URL,
  maxCompletionTokens = null,
  interviewMaxResponseTokens = null,
} = {}) {
  if (!apiKey) throw new Error('apiKey is required');

  const progress = (msg) => { if (updateProgress && sessionId) updateProgress(sessionId, msg); };

  const prompt = buildCharacterInterviewPrompt(interviewText);

  // Character interview produces a single-character JSON payload. Keep a default
  // cap for provider stability, but allow callers to override for larger outputs.
  const interviewResponseTokenCap = interviewMaxResponseTokens || INTERVIEW_RESPONSE_TOKENS;
  const inputTokenEstimate = Math.ceil(prompt.length / CHARS_PER_TOKEN * 1.15);
  let maxResponseTokens = Math.max(MAX_RESPONSE_TOKENS, contextLength - inputTokenEstimate);
  if (maxCompletionTokens) maxResponseTokens = Math.min(maxResponseTokens, maxCompletionTokens);
  maxResponseTokens = Math.min(maxResponseTokens, interviewResponseTokenCap);

  progress('Generating character profile from interview data...');
  logger.info(`Character interview analysis: ${interviewText.length} chars input, model: ${model}, max response tokens: ${maxResponseTokens}`);

  const aiOptions = { apiKey, model, apiBaseUrl };

  for (let retry = 0; retry <= MAX_CHARACTER_RETRIES; retry++) {
    try {
      if (retry > 0) {
        progress(`Retrying character analysis (attempt ${retry + 1})...`);
      }
      logger.info(`Character interview analysis attempt ${retry + 1}`);

      let { content, finishReason } = await requestAnalysis(
        prompt, apiKey, model, apiBaseUrl, maxResponseTokens,
      );

      if (finishReason === 'length') {
        for (let attempt = 1; attempt <= MAX_CONTINUATION_ATTEMPTS; attempt++) {
          logger.info(`Character interview analysis truncated, continuation ${attempt}/${MAX_CONTINUATION_ATTEMPTS}`);
          progress(`Response truncated, requesting continuation (${attempt}/${MAX_CONTINUATION_ATTEMPTS})...`);
          const continuation = await continueResponse(prompt, content, apiKey, model, apiBaseUrl, maxResponseTokens);
          if (!continuation) break;
          content += continuation;
          try {
            return assembleInterviewResult(await parseAIResponse(content, aiOptions));
          } catch {
            logger.info('Character interview still cannot parse after continuation');
          }
        }
      }

      const parsed = await parseAIResponse(content, aiOptions);
      const result = assembleInterviewResult(parsed);

      logger.info(`Character interview analysis complete: "${result.bookTitle}", worldInfo entries: ${
        (result.worldInfo.locations?.length || 0) +
        (result.worldInfo.factions?.length || 0) +
        (result.worldInfo.items?.length || 0) +
        (result.worldInfo.concepts?.length || 0)
      }`);

      return result;
    } catch (error) {
      logger.error(`Character interview analysis failed (attempt ${retry + 1}):`, error.message);
      if (retry < MAX_CHARACTER_RETRIES) {
        continue;
      }
      throw error;
    }
  }
}
