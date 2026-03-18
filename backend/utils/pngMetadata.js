import sharp from 'sharp';
import { Buffer } from 'buffer';

/**
 * Extract character data from PNG metadata
 * @param {string} pngPath - Path to PNG file
 * @returns {Promise<Object>} Extracted character data
 */
export async function extractCharacterFromPng(pngPath) {
  try {
    const image = sharp(pngPath);
    const metadata = await image.metadata();

    // Check for 'chara' text chunk
    if (metadata.exif) {
      const exifBuffer = Buffer.from(metadata.exif);
      const exifString = exifBuffer.toString('utf8');

      // Look for base64 encoded JSON
      const charaMatch = exifString.match(/chara":"([^"]+)"/);
      if (charaMatch) {
        const base64Data = charaMatch[1];
        const jsonString = Buffer.from(base64Data, 'base64').toString('utf8');
        return JSON.parse(jsonString);
      }
    }

    // Alternative: Check PNG tEXt chunks
    const buffer = await image.toBuffer({ resolveWithObject: true });
    const pngBuffer = buffer.data;

    // Parse PNG chunks manually to find tEXt chunk with 'chara' keyword
    const chunks = parsePngChunks(pngBuffer);
    const charaChunk = chunks.find(chunk => chunk.keyword === 'chara');

    if (charaChunk) {
      const base64Data = charaChunk.text;
      const jsonString = Buffer.from(base64Data, 'base64').toString('utf8');
      return JSON.parse(jsonString);
    }

    throw new Error('No character data found in PNG');
  } catch (error) {
    throw new Error(`Failed to extract character from PNG: ${error.message}`);
  }
}

/**
 * Embed character data into PNG as metadata
 * @param {Buffer} imageBuffer - Original image buffer
 * @param {Object} characterData - Character card JSON data
 * @returns {Promise<Buffer>} PNG buffer with embedded metadata
 */
export async function embedCharacterInPng(imageBuffer, characterData) {
  try {
    // Encode character data as base64
    const jsonString = JSON.stringify(characterData);
    const base64Data = Buffer.from(jsonString, 'utf8').toString('base64');

    // Create tEXt chunk for 'chara' keyword
    const textChunk = createPngTextChunk('chara', base64Data);

    // Get the original PNG buffer
    let pngBuffer;
    if (Buffer.isBuffer(imageBuffer)) {
      pngBuffer = imageBuffer;
    } else {
      // If it's a file path, read it
      const image = sharp(imageBuffer);
      pngBuffer = await image.toBuffer();
    }

    // Insert the text chunk after IHDR chunk
    const result = insertPngChunk(pngBuffer, textChunk);

    return result;
  } catch (error) {
    throw new Error(`Failed to embed character in PNG: ${error.message}`);
  }
}

/**
 * Parse PNG chunks from buffer
 * @param {Buffer} buffer - PNG file buffer
 * @returns {Array} Array of chunk objects
 */
function parsePngChunks(buffer) {
  const chunks = [];
  let offset = 8; // Skip PNG signature

  while (offset < buffer.length) {
    const length = buffer.readUInt32BE(offset);
    const type = buffer.toString('ascii', offset + 4, offset + 8);
    const data = buffer.subarray(offset + 8, offset + 8 + length);
    const crc = buffer.readUInt32BE(offset + 8 + length);

    if (type === 'tEXt') {
      // Parse tEXt chunk
      const nullIndex = data.indexOf(0);
      const keyword = data.toString('latin1', 0, nullIndex);
      const text = data.toString('latin1', nullIndex + 1);
      chunks.push({ type, keyword, text, length, crc });
    } else {
      chunks.push({ type, data, length, crc });
    }

    offset += 12 + length; // 4 (length) + 4 (type) + length + 4 (crc)
  }

  return chunks;
}

/**
 * Create a PNG tEXt chunk
 * @param {string} keyword - Chunk keyword
 * @param {string} text - Text content
 * @returns {Buffer} tEXt chunk buffer
 */
function createPngTextChunk(keyword, text) {
  const keywordBuffer = Buffer.from(keyword, 'latin1');
  const textBuffer = Buffer.from(text, 'latin1');
  const dataLength = keywordBuffer.length + 1 + textBuffer.length;

  const chunk = Buffer.alloc(12 + dataLength);

  // Length (4 bytes)
  chunk.writeUInt32BE(dataLength, 0);

  // Type (4 bytes)
  chunk.write('tEXt', 4, 'ascii');

  // Data
  keywordBuffer.copy(chunk, 8);
  chunk[8 + keywordBuffer.length] = 0; // Null separator
  textBuffer.copy(chunk, 8 + keywordBuffer.length + 1);

  // CRC (4 bytes)
  const crc = calculateCrc(chunk.subarray(4, 8 + dataLength));
  chunk.writeUInt32BE(crc, 8 + dataLength);

  return chunk;
}

/**
 * Insert a chunk into PNG buffer after IHDR
 * @param {Buffer} pngBuffer - Original PNG buffer
 * @param {Buffer} newChunk - Chunk to insert
 * @returns {Buffer} Modified PNG buffer
 */
function insertPngChunk(pngBuffer, newChunk) {
  // PNG signature is 8 bytes
  // IHDR chunk starts at byte 8
  const ihdrLength = pngBuffer.readUInt32BE(8);
  const insertPosition = 8 + 12 + ihdrLength; // After IHDR chunk

  return Buffer.concat([
    pngBuffer.subarray(0, insertPosition),
    newChunk,
    pngBuffer.subarray(insertPosition)
  ]);
}

/**
 * Calculate CRC32 for PNG chunk
 * @param {Buffer} buffer - Buffer to calculate CRC for
 * @returns {number} CRC32 value
 */
function calculateCrc(buffer) {
  let crc = 0xFFFFFFFF;

  for (let i = 0; i < buffer.length; i++) {
    crc ^= buffer[i];
    for (let j = 0; j < 8; j++) {
      crc = (crc >>> 1) ^ (0xEDB88320 & -(crc & 1));
    }
  }

  return (crc ^ 0xFFFFFFFF) >>> 0;
}

/**
 * Generate a character card PNG with embedded JSON
 * @param {Object} characterData - Character card data
 * @param {Buffer|string} coverImage - Cover image buffer or base64 string
 * @returns {Promise<Buffer>} PNG buffer with embedded character data
 */
export async function generateCharacterCardPng(characterData, coverImage) {
  try {
    let imageBuffer;

    if (typeof coverImage === 'string') {
      // Base64 string
      if (coverImage.startsWith('data:')) {
        const base64Data = coverImage.split(',')[1];
        imageBuffer = Buffer.from(base64Data, 'base64');
      } else {
        imageBuffer = Buffer.from(coverImage, 'base64');
      }
    } else {
      imageBuffer = coverImage;
    }

    // Convert to PNG, preserving original dimensions and quality
    const pngBuffer = await sharp(imageBuffer)
      .png()
      .toBuffer();

    // Embed character data
    const result = await embedCharacterInPng(pngBuffer, characterData);

    return result;
  } catch (error) {
    throw new Error(`Failed to generate character card PNG: ${error.message}`);
  }
}
