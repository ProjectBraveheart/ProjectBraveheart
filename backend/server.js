import express from 'express';
import cors from 'cors';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import logger from './utils/logger.js';
import { createProcessRouter } from './routes/process.js';
import exportRouter from './routes/export.js';
import { setChromiumProxyPort } from './services/chromiumProxy.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/**
 * Create and start the Express server.
 * @param {object} options
 * @param {number} options.port - Port to listen on (0 = OS-assigned free port)
 * @param {string} options.uploadsPath - Writable directory for file uploads
 * @param {string} options.frontendDistPath - Path to built frontend files
 * @param {number} options.chromiumProxyPort - Port of Electron's Chromium proxy (production mode)
 * @returns {Promise<import('http').Server>}
 */
export function startServer(options = {}) {
  const {
    port = process.env.PORT || 3001,
    uploadsPath = path.resolve(__dirname, 'uploads'),
    frontendDistPath = path.resolve(__dirname, '../frontend/dist'),
    chromiumProxyPort: proxyPort,
  } = options;

  // Set proxy port if provided (production mode — passed directly by Electron)
  if (proxyPort) {
    setChromiumProxyPort(proxyPort);
    logger.info(`Chromium proxy port set to ${proxyPort} (production mode)`);
  }

  const app = express();

  // Middleware
  app.use(cors());
  app.use(express.json({ limit: '50mb' }));
  app.use(express.urlencoded({ extended: true, limit: '50mb' }));

  // Ensure uploads directory exists
  if (!fs.existsSync(uploadsPath)) {
    fs.mkdirSync(uploadsPath, { recursive: true });
  }

  // Routes
  app.use('/api/process', createProcessRouter(uploadsPath));
  app.use('/api/export', exportRouter);

  app.get('/health', (req, res) => {
    res.json({ status: 'ok' });
  });

  // Internal endpoint — Electron main process notifies us of the Chromium proxy port (dev mode)
  app.post('/api/internal/set-chromium-proxy', (req, res) => {
    const proxyPortValue = req.body?.port;
    if (proxyPortValue && typeof proxyPortValue === 'number') {
      setChromiumProxyPort(proxyPortValue);
      logger.info(`Chromium proxy port set to ${proxyPortValue} (dev mode)`);
      res.json({ ok: true });
    } else {
      res.status(400).json({ error: 'Missing or invalid port' });
    }
  });

  // Serve frontend static files if they exist
  if (fs.existsSync(frontendDistPath)) {
    app.use(express.static(frontendDistPath));
    app.get('*', (req, res, next) => {
      if (req.path.startsWith('/api')) {
        return next();
      }
      res.sendFile(path.join(frontendDistPath, 'index.html'));
    });
  }

  return new Promise((resolve, reject) => {
    const server = app.listen(port, () => {
      const actualPort = server.address().port;
      const modeMessage = fs.existsSync(frontendDistPath)
        ? 'with frontend build'
        : 'API-only mode (frontend build not found)';
      logger.info(`Server running on port ${actualPort} (${modeMessage})`);
      resolve(server);
    });
    server.on('error', reject);
  });
}

// When run directly (not imported by Electron), start with defaults
const isDirectRun = process.argv[1] &&
  path.resolve(process.argv[1]) === path.resolve(__filename);

if (isDirectRun) {
  startServer();
}
