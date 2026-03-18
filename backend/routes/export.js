import express from 'express';
import { generateCharacterCardPng } from '../utils/pngMetadata.js';
import sharp from 'sharp';
import logger from '../utils/logger.js';

const router = express.Router();

// Export character as PNG with embedded JSON
router.post('/character/png', async (req, res) => {
  try {
    const { characterData, coverImage } = req.body;

    if (!characterData) {
      return res.status(400).json({ error: 'Character data is required' });
    }

    let imageBuffer;

    if (coverImage) {
      // Use provided cover image
      if (coverImage.startsWith('data:')) {
        const base64Data = coverImage.split(',')[1];
        imageBuffer = Buffer.from(base64Data, 'base64');
      } else {
        imageBuffer = Buffer.from(coverImage, 'base64');
      }
    } else {
      // Create a default placeholder image
      imageBuffer = await sharp({
        create: {
          width: 512,
          height: 768,
          channels: 4,
          background: { r: 31, g: 31, b: 31, alpha: 1 }
        }
      })
        .png()
        .toBuffer();
    }

    const pngBuffer = await generateCharacterCardPng(characterData, imageBuffer);

    res.set({
      'Content-Type': 'image/png',
      'Content-Disposition': `attachment; filename="${characterData.data.name.replace(/[^a-z0-9]/gi, '_')}.png"`
    });

    res.send(pngBuffer);
  } catch (error) {
    logger.error('Error generating character PNG:', error);
    res.status(500).json({ error: error.message });
  }
});

// Export character as JSON
router.post('/character/json', async (req, res) => {
  try {
    const { characterData } = req.body;

    if (!characterData) {
      return res.status(400).json({ error: 'Character data is required' });
    }

    res.set({
      'Content-Type': 'application/json',
      'Content-Disposition': `attachment; filename="${characterData.data.name.replace(/[^a-z0-9]/gi, '_')}.json"`
    });

    res.json(characterData);
  } catch (error) {
    logger.error('Error generating character JSON:', error);
    res.status(500).json({ error: error.message });
  }
});

// Export lorebook as JSON
router.post('/lorebook/json', async (req, res) => {
  try {
    const { lorebookData, bookTitle } = req.body;

    if (!lorebookData) {
      return res.status(400).json({ error: 'Lorebook data is required' });
    }

    const filename = bookTitle
      ? `${bookTitle.replace(/[^a-z0-9]/gi, '_')}_lorebook.json`
      : 'lorebook.json';

    res.set({
      'Content-Type': 'application/json',
      'Content-Disposition': `attachment; filename="${filename}"`
    });

    res.json(lorebookData);
  } catch (error) {
    logger.error('Error generating lorebook JSON:', error);
    res.status(500).json({ error: error.message });
  }
});

export default router;
