// Centralized backend constants

export const DEFAULT_API_BASE_URL = 'https://openrouter.ai/api/v1';
export const DEFAULT_CONTEXT_LENGTH = 200000;
export const DEFAULT_MODEL = 'anthropic/claude-3.5-sonnet';

// Token estimation: 1 token ≈ 4 characters
export const CHARS_PER_TOKEN = 4;

// Use 50% of context for input, leaving room for prompt + response
export const CONTEXT_INPUT_RATIO = 0.5;

// Chunk sizing: use 80% of safe context for each chunk
export const CHUNK_FILL_RATIO = 0.8;

// AI request limits
export const MAX_RESPONSE_TOKENS = 8000; // minimum floor; actual limit is calculated dynamically
export const INTERVIEW_RESPONSE_TOKENS = 16384; // default cap for character interview JSON responses
export const MAX_CONTINUATION_ATTEMPTS = 2;
export const MAX_CHARACTER_RETRIES = 2;
export const MAX_PARALLEL_CHARACTER_CALLS = 3;
export const AI_REQUEST_TIMEOUT_MS = 300000; // 5 minutes
export const CONNECTION_TEST_TIMEOUT_MS = 15000;

// File upload limits
export const MAX_FILE_SIZE_BYTES = 50 * 1024 * 1024; // 50MB
export const SUPPORTED_EXTENSIONS = ['.epub', '.mobi'];

// Character import (external AI companion services)
export const IMPORT_SERVICE_REQUEST_TIMEOUT_MS = 300000; // 5 minutes per message
export const IMPORT_SERVICE_MAX_RETRIES = 1; // retry once on timeout before failing
export const IMPORT_INTER_MESSAGE_DELAY_MS = 1500; // delay between messages to avoid rate limiting
export const IMPORT_SERVICE_RETRY_DELAY_MS = 7000; // longer backoff after timeout before retrying
export const IMPORT_MIN_RESPONSE_LENGTH = 20; // responses shorter than this are considered "empty"
export const IMPORT_MAX_CONSECUTIVE_EMPTY = 3; // abort interview after this many empty responses in a row
export const IMPORT_MIN_TOTAL_CHARS = 500; // minimum total interview text before sending to AI
export const IMPORT_MAX_RESPONSE_CHARS = 1500; // target max chars per interview response (Kindroid limit ~2000)

// Character.AI interview (via cainode WebSocket)
export const CAI_INTER_MESSAGE_DELAY_MS = 2500; // c.ai needs longer delays between messages

// URL-based character import (scraping from platforms)
export const URL_IMPORT_REQUEST_TIMEOUT_MS = 30000; // 30 seconds for API fetch
export const URL_IMPORT_IMAGE_TIMEOUT_MS = 15000; // 15 seconds for cover image download
