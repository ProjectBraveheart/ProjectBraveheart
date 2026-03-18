import logger from './logger.js';

// Simple in-memory progress tracker
const progressStore = new Map();
const TTL_MS = 60 * 60 * 1000; // 1 hour
const CLEANUP_INTERVAL_MS = 10 * 60 * 1000; // 10 minutes

function cleanupExpiredProgress() {
  const now = Date.now();
  for (const [sessionId, entry] of progressStore.entries()) {
    if (!entry?.createdAt || (now - entry.createdAt) > TTL_MS) {
      progressStore.delete(sessionId);
    }
  }
}

const cleanupInterval = setInterval(cleanupExpiredProgress, CLEANUP_INTERVAL_MS);
if (typeof cleanupInterval.unref === 'function') {
  cleanupInterval.unref();
}

export function updateProgress(sessionId, message) {
  const now = Date.now();
  const existing = progressStore.get(sessionId);
  progressStore.set(sessionId, {
    value: { message, timestamp: now },
    partialResults: existing?.partialResults || null,
    createdAt: existing?.createdAt || now,
  });
  logger.debug(`[Progress ${sessionId}]: ${message}`);
}

export function initPartialResults(sessionId, bookTitle) {
  const entry = progressStore.get(sessionId);
  if (!entry) return;
  entry.partialResults = { bookTitle: bookTitle || '', characters: [] };
}

export function addPartialCharacter(sessionId, characterCard) {
  const entry = progressStore.get(sessionId);
  if (!entry) return;
  if (!entry.partialResults) {
    entry.partialResults = { bookTitle: '', characters: [] };
  }
  entry.partialResults.characters.push(characterCard);
}

export function getProgress(sessionId) {
  const entry = progressStore.get(sessionId);
  if (!entry) return null;

  if ((Date.now() - entry.createdAt) > TTL_MS) {
    progressStore.delete(sessionId);
    return null;
  }

  return {
    ...entry.value,
    partialResults: entry.partialResults || null,
  };
}

export function clearProgress(sessionId) {
  progressStore.delete(sessionId);
}

export function stopProgressCleanup() {
  clearInterval(cleanupInterval);
}
