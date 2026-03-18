import pkg from 'epub2';
import fs from 'fs/promises';
import path from 'path';
import logger from '../utils/logger.js';
const { EPub } = pkg;

/**
 * Parse MOBI file and extract text content
 * Note: MOBI parsing is basic - extracts text but may not preserve all formatting
 * @param {string} filePath - Path to the MOBI file
 * @returns {Promise<Object>} Extracted text content and metadata
 */
async function parseMobi(filePath) {
  try {
    // Read MOBI file as buffer
    const buffer = await fs.readFile(filePath);
    
    // MOBI files contain HTML-like content after the header
    // This is a simplified parser that extracts text
    const content = buffer.toString('utf8', 0, buffer.length);
    
    // Try to extract text between common HTML tags
    // Remove HTML tags but preserve text
    let text = content
      .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, '') // Remove scripts
      .replace(/<style\b[^<]*(?:(?!<\/style>)<[^<]*)*<\/style>/gi, '') // Remove styles
      .replace(/<[^>]+>/g, ' ') // Remove all HTML tags
      .replace(/&nbsp;/g, ' ')
      .replace(/&[a-z]+;/gi, ' ') // Remove HTML entities
      .replace(/\s+/g, ' ') // Normalize whitespace
      .trim();
    
    // Basic metadata extraction from MOBI header (simplified)
    const titleMatch = content.match(/<dc:title[^>]*>([^<]+)<\/dc:title>/i);
    const authorMatch = content.match(/<dc:creator[^>]*>([^<]+)<\/dc:creator>/i);
    
    return {
      text: text,
      chapters: [{ title: '', text: text }], // MOBI: single chapter fallback
      metadata: {
        title: titleMatch ? titleMatch[1] : path.basename(filePath, '.mobi'),
        creator: authorMatch ? authorMatch[1] : 'Unknown Author'
      },
      hasCover: false // MOBI cover extraction not supported in basic parser
    };
  } catch (error) {
    throw new Error(`MOBI parsing error: ${error.message}`);
  }
}

/**
 * Parse EPUB file and extract text content
 * @param {string} filePath - Path to the EPUB file
 * @returns {Promise<Object>} Extracted text content and metadata
 */
export async function parseEpub(filePath) {
  // Check file extension
  const ext = path.extname(filePath).toLowerCase();
  
  if (ext === '.mobi') {
    return parseMobi(filePath);
  }
  
  // Parse EPUB
  return new Promise((resolve, reject) => {
    const epub = new EPub(filePath);

    epub.on('error', (err) => {
      reject(new Error(`EPUB parsing error: ${err.message}`));
    });

    epub.on('end', async () => {
      try {
        const chapterIds = epub.flow.map(chapter => chapter.id);
        const textPromises = chapterIds.map(chapterId =>
          new Promise((res, rej) => {
            epub.getChapter(chapterId, (err, text) => {
              if (err) rej(err);
              else res(text);
            });
          })
        );

        const rawTexts = await Promise.all(textPromises);

        // Build individual chapter objects with cleaned text
        const chapterObjects = rawTexts.map((html, i) => {
          const cleanText = html.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
          // Try to get a title from epub.flow metadata
          const flowItem = epub.flow[i];
          const title = flowItem?.title || `Chapter ${i + 1}`;
          return { title, text: cleanText };
        }).filter(ch => ch.text.length > 0); // Drop empty chapters

        const fullText = chapterObjects.map(ch => ch.text).join('\n\n');

        logger.info(`EPUB parsed: ${chapterObjects.length} chapters, ${fullText.length} chars total`);

        resolve({
          text: fullText,
          chapters: chapterObjects,
          metadata: epub.metadata,
          hasCover: !!epub.metadata.cover
        });
      } catch (err) {
        reject(err);
      }
    });

    epub.parse();
  });
}

/**
 * Extract cover image from EPUB file
 * @param {string} filePath - Path to the EPUB file
 * @returns {Promise<Buffer>} Cover image buffer
 */
export async function extractEpubCover(filePath) {
  return new Promise((resolve, reject) => {
    const epub = new EPub(filePath);

    epub.on('error', (err) => {
      reject(new Error(`EPUB parsing error: ${err.message}`));
    });

    epub.on('end', () => {
      if (!epub.metadata.cover) {
        reject(new Error('No cover found in EPUB'));
        return;
      }

      epub.getImage(epub.metadata.cover, (err, data, mimeType) => {
        if (err) {
          reject(err);
        } else {
          resolve(data);
        }
      });
    });

    epub.parse();
  });
}
