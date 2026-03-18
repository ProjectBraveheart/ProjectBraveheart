// Simple logger that respects LOG_LEVEL environment variable.
// Levels: error (0), warn (1), info (2), debug (3)
// Default level in production: info. In development: debug.

const LEVELS = { error: 0, warn: 1, info: 2, debug: 3 };

function getLevel() {
  const env = process.env.LOG_LEVEL?.toLowerCase();
  if (env && LEVELS[env] !== undefined) return LEVELS[env];
  return process.env.NODE_ENV === 'production' ? LEVELS.info : LEVELS.debug;
}

const currentLevel = getLevel();

const logger = {
  error: (...args) => { if (currentLevel >= LEVELS.error) console.error('[ERROR]', ...args); },
  warn:  (...args) => { if (currentLevel >= LEVELS.warn)  console.warn('[WARN]', ...args); },
  info:  (...args) => { if (currentLevel >= LEVELS.info)  console.log('[INFO]', ...args); },
  debug: (...args) => { if (currentLevel >= LEVELS.debug) console.log('[DEBUG]', ...args); },
};

export default logger;
