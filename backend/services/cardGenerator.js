import logger from '../utils/logger.js';

/**
 * Format example dialogue with proper <START> delimiters.
 * Expects exchanges separated by <START> markers.
 * @param {string} rawDialogue - Raw example dialogue from AI
 * @returns {string} Formatted dialogue with <START> markers
 */
function formatExampleDialogue(rawDialogue) {
  if (!rawDialogue) return '';

  // AI may return an array of exchanges instead of a string
  if (Array.isArray(rawDialogue)) {
    rawDialogue = rawDialogue.filter(e => e && typeof e === 'string').join('\n');
  }

  if (typeof rawDialogue !== 'string' || !rawDialogue.trim()) return '';

  const dialogue = rawDialogue.trim();

  // Already has <START> markers — return as-is
  if (dialogue.includes('<START>')) return dialogue;

  // Split into exchanges at each {{user}}: line (each one starts a new exchange pair)
  const parts = dialogue.split(/(?=\{\{user\}\}:)/i);

  if (parts.length > 1) {
    return parts
      .map(part => part.trim())
      .filter(part => part.length > 0)
      .map(part => `<START>\n${part}`)
      .join('\n');
  }

  // Couldn't split into exchanges — wrap the whole block
  return `<START>\n${dialogue}`;
}

/**
 * Format character description — core identity only.
 * Scenario, first messages, and example dialogue go in their dedicated v2 fields
 * (scenario, first_mes, alternate_greetings, mes_example) and should NOT be
 * duplicated here.
 * @param {Object} char - Character data from AI analysis
 * @returns {string} Formatted description
 */
function formatCharacterDescription(char) {
  const parts = [];

  const header = `{{char}} is ${char.name}.`;
  parts.push(header);

  if (char.background) {
    parts.push(char.background);
  }
  if (char.physicalDescription) {
    parts.push(`{{char}}'s appearance: ${char.physicalDescription}`);
  }
  if (char.personality) {
    parts.push(`{{char}}'s personality: ${char.personality}`);
  }
  if (char.dailyLife) {
    parts.push(`{{char}}'s daily life: ${char.dailyLife}`);
  }
  if (char.likes && char.likes.length > 0) {
    parts.push(`{{char}}'s likes:\n${char.likes.map(l => `- ${l}`).join('\n')}`);
  }
  if (char.dislikes && char.dislikes.length > 0) {
    parts.push(`{{char}}'s dislikes:\n${char.dislikes.map(l => `- ${l}`).join('\n')}`);
  }
  if (char.userRelationship) {
    parts.push(`{{char}}'s relationship with {{user}}: ${char.userRelationship}`);
  }
  if (char.userKnowledge) {
    parts.push(`What {{char}} knows about {{user}}: ${char.userKnowledge}`);
  }
  if (char.sharedExperiences) {
    parts.push(`{{char}} and {{user}}'s shared experiences: ${char.sharedExperiences}`);
  }
  if (char.commonPhrases && char.commonPhrases.length > 0) {
    parts.push(`{{char}} often says things like:\n${char.commonPhrases.map(p => `- "${p}"`).join('\n')}`);
  }

  return parts.join('\n\n').trim();
}

/**
 * Get display label for character role
 * @param {string} role - Character role from AI analysis
 * @returns {string} Display label
 */
function getRoleLabel(role) {
  const roleLabels = {
    'main_character': 'Main Character',
    'protagonist': 'Protagonist',
    'love_interest': 'Love Interest',
    'antagonist': 'Antagonist',
    'supporting': 'Supporting Character',
    'mentor': 'Mentor',
    'rival': 'Rival'
  };
  
  return roleLabels[role] || 'Character';
}

// Talkativeness by role — controls auto-response frequency (0.0–1.0)
const ROLE_TALKATIVENESS = {
  'main_character': 0.8,
  'protagonist': 0.8,
  'love_interest': 0.75,
  'antagonist': 0.65,
  'supporting': 0.5,
  'mentor': 0.6,
  'rival': 0.65
};

/**
 * Generate character cards from analyzed characters
 * @param {Array} characters - Array of character objects from AI analysis
 * @param {string} coverImageBase64 - Optional base64 encoded cover image
 * @param {Object} options - Optional settings
 * @param {string[]} options.imageUrls - Image URLs to append as markdown to first message (Chub-style)
 * @returns {Array} Array of character cards (includes both regular and persona versions)
 */
export function generateCharacterCards(characters, coverImageBase64 = null, options = {}) {
  const { imageUrls = [] } = options;
  const cards = [];

  // Sort characters to ensure main/protagonist characters come first for persona generation
  const sortedCharacters = [...characters].sort((a, b) => {
    const roleOrder = {
      'main_character': 0,
      'protagonist': 1,
      'love_interest': 2,
      'antagonist': 3,
      'supporting': 4,
      'mentor': 5,
      'rival': 6
    };
    return (roleOrder[a.role] || 99) - (roleOrder[b.role] || 99);
  });

  sortedCharacters.forEach((char, index) => {
    // Build tag array from AI tags plus role
    const tags = [
      ...(char.tags || []),
      char.role || 'character'
    ];

    // Remove duplicates and convert to lowercase
    const uniqueTags = [...new Set(tags.map(t => t.toLowerCase()))];

    // Get first messages - check multiple possible formats
    let firstMessages = [];
    if (Array.isArray(char.firstMessages) && char.firstMessages.length > 0) {
      firstMessages = char.firstMessages.filter(msg => msg && msg.trim());
    } else if (char.firstMessage) {
      firstMessages = [char.firstMessage];
    }

    // Fallback if no first messages found
    if (firstMessages.length === 0) {
      firstMessages = [`*${char.name} appears before you.*`];
    }

    logger.debug(`Character ${char.name}: Found ${firstMessages.length} first messages`);

    const baseFirstMessages = firstMessages.slice();
    const charFirstMessages = baseFirstMessages.slice();

    // Append image gallery as the last greeting for the regular card only.
    if (imageUrls.length > 0 && index === 0) {
      const imageMarkdown = '**Card Image Gallery**\n\n' + imageUrls.map(url => `![](${url})`).join('\n');
      charFirstMessages.push(imageMarkdown);
      logger.debug(`Appended image gallery greeting (${imageUrls.length} image(s)) as last greeting`);
    }

    // Format example dialogue with <START> delimiters
    const formattedExamples = formatExampleDialogue(char.exampleDialogue);

    const talkativeness = ROLE_TALKATIVENESS[char.role] || 0.5;

    // Generate regular character card (for interacting WITH the character)
    const regularCard = {
      spec: 'chara_card_v2',
      spec_version: '2.0',
      data: {
        name: char.name,
        description: formatCharacterDescription(char),
        personality: char.personality || '',
        scenario: char.scenario || '',
        first_mes: charFirstMessages[0] || `*${char.name} appears before you.*`,
        mes_example: formattedExamples,
        creator_notes: 'Auto-generated by Chatbot Maker',
        system_prompt: `Write {{char}}'s next reply in a fictional roleplay chat with {{user}}. Be creative and descriptive. Stay in character as {{char}} at all times. Drive the scene forward with meaningful actions and dialogue. Use {{char}}'s established speech patterns, personality, and mannerisms.`,
        post_history_instructions: `[Stay in character as {{char}}. Use descriptive prose with *actions* and "dialogue". React authentically to {{user}}'s words and actions. Avoid repetition and keep responses engaging.]`,
        tags: uniqueTags,
        creator: 'Chatbot Maker',
        character_version: 'main',
        alternate_greetings: charFirstMessages.slice(1),
        extensions: {
          talkativeness: talkativeness,
          depth_prompt: {
            role: 'system',
            depth: 4,
            prompt: `[Remember: You are {{char}}. Stay true to {{char}}'s personality, speech patterns, and motivations. Do not break character.]`
          }
        },
        character_book: null
      },
      characterType: getRoleLabel(char.role),
      isPersona: false,
      canBePersona: char.canBePersona || false
    };

    cards.push(regularCard);

    // Only generate persona for top 2 characters that can be personas
    const shouldGeneratePersona = char.canBePersona && index < 2;

    if (shouldGeneratePersona) {
      logger.debug(`Generating persona card for ${char.name} (rank ${index + 1})`);
      const personaCard = {
        spec: 'chara_card_v2',
        spec_version: '2.0',
        data: {
          name: `${char.name} (Persona)`,
          description: formatCharacterDescription(char),
          personality: char.personality || '',
          scenario: char.scenario ? char.scenario.replace(/\{\{user\}\}/g, char.name) : '',
          first_mes: baseFirstMessages[0] || `*You are ${char.name}. The story begins.*`,
          mes_example: formattedExamples,
          creator_notes: 'Auto-generated by Chatbot Maker - Persona Version (roleplay AS this character)',
          system_prompt: `{{user}} is roleplaying as ${char.name}. The AI should write the world, NPCs, and other characters around {{user}}'s character. React to {{user}}'s actions as ${char.name} would experience them. Narrate the environment, other characters' dialogue and actions, and consequences of {{user}}'s choices. Do NOT write {{user}}'s actions or dialogue.`,
          post_history_instructions: `[{{user}} is playing as ${char.name}. Write the surrounding world and NPCs. Never control ${char.name}'s actions — only describe what happens around them. Use descriptive prose with *actions* and "dialogue" for NPCs.]`,
          tags: [...uniqueTags, 'persona'],
          creator: 'Chatbot Maker',
          character_version: 'persona',
          alternate_greetings: baseFirstMessages.slice(1),
          extensions: {
            talkativeness: 0.8,
            depth_prompt: {
              role: 'system',
              depth: 4,
              prompt: `[{{user}} is ${char.name}. Write the world and NPCs around them. Do not control ${char.name}'s actions or dialogue.]`
            }
          },
          character_book: null
        },
        characterType: `${getRoleLabel(char.role)} (Persona)`,
        isPersona: true,
        canBePersona: false
      };

      cards.push(personaCard);
    }
  });

  return cards;
}

/**
 * Build a character card directly from raw platform API data (no AI analysis).
 * Used when the platform returns structured character card v2 fields.
 * This is much faster than the AI pipeline and preserves all original data verbatim.
 *
 * @param {Object} rawCard - Raw card fields from platform API
 * @param {string|null} coverImageBase64 - Optional base64 encoded cover image
 * @param {string[]} imageUrls - Character image URLs
 * @returns {{ characters: Array, lorebook: Object }}
 */
export function buildDirectCard(rawCard, coverImageBase64 = null, imageUrls = []) {
  // Build first messages array: first_mes + alternate_greetings
  const firstMessages = [];
  if (rawCard.first_mes && rawCard.first_mes.trim()) {
    firstMessages.push(rawCard.first_mes);
  }
  if (Array.isArray(rawCard.alternate_greetings)) {
    for (const g of rawCard.alternate_greetings) {
      if (g && g.trim()) firstMessages.push(g);
    }
  }
  if (firstMessages.length === 0) {
    firstMessages.push(`*${rawCard.name} appears before you.*`);
  }

  logger.debug(`Direct import ${rawCard.name}: ${firstMessages.length} greeting(s)`);

  const charFirstMessages = [...firstMessages];

  // Insert image gallery greeting at position 1 (same as generateCharacterCards behavior)
  // Deduplicate: skip images that already appear inline in any greeting text
  if (imageUrls.length > 0) {
    const allGreetingText = firstMessages.join('\n');
    const galleryOnly = imageUrls.filter(url => !allGreetingText.includes(url));
    if (galleryOnly.length > 0) {
      const imageMarkdown = '**Card Image Gallery**\n\n' + galleryOnly.map(url => `![](${url})`).join('\n');
      charFirstMessages.push(imageMarkdown);
      logger.debug(`Direct import: appended image gallery greeting (${galleryOnly.length} image(s), ${imageUrls.length - galleryOnly.length} deduplicated) as last greeting`);
    } else {
      logger.debug(`Direct import: all ${imageUrls.length} image(s) already inline in greetings, skipping gallery greeting`);
    }
  }

  // Format example dialogue with <START> delimiters
  const formattedExamples = formatExampleDialogue(rawCard.mes_example);

  // Build tags
  const tags = Array.isArray(rawCard.tags)
    ? [...new Set(rawCard.tags.map(t => typeof t === 'string' ? t.toLowerCase() : ''))]
        .filter(t => t)
    : [];

  // Use provided system prompt or sensible default
  const systemPrompt = rawCard.system_prompt && rawCard.system_prompt.trim()
    ? rawCard.system_prompt
    : `Write {{char}}'s next reply in a fictional roleplay chat with {{user}}. Be creative and descriptive. Stay in character as {{char}} at all times. Drive the scene forward with meaningful actions and dialogue. Use {{char}}'s established speech patterns, personality, and mannerisms.`;

  const postHistoryInstructions = rawCard.post_history_instructions && rawCard.post_history_instructions.trim()
    ? rawCard.post_history_instructions
    : `[Stay in character as {{char}}. Use descriptive prose with *actions* and "dialogue". React authentically to {{user}}'s words and actions. Avoid repetition and keep responses engaging.]`;

  // Preserve depth_prompt from extensions if available
  const depthPrompt = rawCard.extensions?.depth_prompt || {
    role: 'system',
    depth: 4,
    prompt: `[Remember: You are {{char}}. Stay true to {{char}}'s personality, speech patterns, and motivations. Do not break character.]`,
  };

  const card = {
    spec: 'chara_card_v2',
    spec_version: '2.0',
    data: {
      name: rawCard.name,
      description: rawCard.description || '',
      personality: rawCard.personality || '',
      scenario: rawCard.scenario || '',
      first_mes: charFirstMessages[0],
      mes_example: formattedExamples,
      creator_notes: rawCard.creator_notes || 'Imported by Chatbot Maker',
      system_prompt: systemPrompt,
      post_history_instructions: postHistoryInstructions,
      tags,
      creator: rawCard.creator || 'Chatbot Maker',
      character_version: 'main',
      alternate_greetings: charFirstMessages.slice(1),
      extensions: {
        talkativeness: 0.8,
        depth_prompt: depthPrompt,
      },
      character_book: null,
    },
    characterType: 'Main Character',
    isPersona: false,
    canBePersona: false,
  };

  // Minimal empty lorebook (no AI analysis to populate it)
  const lorebook = {
    name: `${rawCard.name} Lorebook`,
    description: `World info for ${rawCard.name}`,
    scan_depth: 2,
    token_budget: 512,
    recursive_scanning: false,
    entries: [],
  };

  logger.info(`Direct import: built card for "${rawCard.name}" with ${charFirstMessages.length} greeting(s), ${tags.length} tags`);

  return {
    characters: [card],
    lorebook,
  };
}

/**
 * Generate smart trigger keys from a name and optional keywords list
 * Produces the name itself, lowercased variant, individual words (3+ chars),
 * and any AI-provided keywords.
 * @param {string} name - Entry name
 * @param {Array<string>} extraKeywords - Optional AI-provided keywords
 * @returns {Array<string>} Deduplicated trigger keys
 */
function generateKeys(name, extraKeywords = []) {
  const keys = new Set();

  // Exact name and lowercase
  keys.add(name);
  keys.add(name.toLowerCase());

  // Individual words from the name (skip short filler words)
  const words = name.split(/[\s\-_,]+/);
  for (const word of words) {
    const clean = word.replace(/[^a-zA-Z0-9']/g, '');
    if (clean.length >= 3) {
      keys.add(clean.toLowerCase());
    }
  }

  // AI-provided keywords
  for (const kw of extraKeywords) {
    if (kw && kw.trim()) keys.add(kw.trim().toLowerCase());
  }

  return [...keys];
}

/**
 * Extract secondary keys from description text — common nouns/proper nouns
 * that co-occur with the entry to reduce false triggers.
 * @param {string} description - Entry description
 * @param {string} category - Entry category
 * @returns {Array<string>} Secondary keys (empty if not useful)
 */
function generateSecondaryKeys(description, category) {
  // Only use secondary keys for generic-sounding entries to prevent false positives
  if (!description || description.length < 50) return [];

  // For items and concepts, extract a contextual secondary key from the description
  if (category === 'item' || category === 'concept') {
    // Pick up to 2 meaningful words from the first sentence
    const firstSentence = description.split(/[.!?]/)[0] || '';
    const candidates = firstSentence
      .split(/\s+/)
      .map(w => w.replace(/[^a-zA-Z]/g, '').toLowerCase())
      .filter(w => w.length >= 5);
    return candidates.slice(0, 2);
  }

  return [];
}

// Category configuration: order (insertion priority), weight, depth, position
const CATEGORY_CONFIG = {
  setting:   { order: 1000, weight: 50, depth: 8, position: 0 }, // Before char defs — always-on world context
  character: { order: 900,  weight: 35, depth: 6, position: 1 }, // After char defs — triggered by character name
  location:  { order: 800,  weight: 30, depth: 6, position: 1 },
  faction:   { order: 700,  weight: 25, depth: 6, position: 1 },
  concept:   { order: 600,  weight: 20, depth: 4, position: 1 },
  item:      { order: 500,  weight: 15, depth: 4, position: 1 },
};

/**
 * Generate lorebook from world info and characters
 * @param {Object} worldInfo - World information object from AI analysis
 * @param {Array} characters - Character objects from AI analysis
 * @returns {Object} Formatted lorebook
 */
export function generateLorebook(worldInfo, characters = [], cardName = '') {
  const entries = {};
  let entryId = 1;
  let displayIndex = 0;

  const createEntry = (name, category, description, extraKeywords = []) => {
    const config = CATEGORY_CONFIG[category] || CATEGORY_CONFIG.concept;
    const keys = generateKeys(name, extraKeywords);
    const secondaryKeys = generateSecondaryKeys(description, category);
    const assignedDisplayIndex = displayIndex++;

    // Format content with category context so the AI knows what this entry is
    const categoryLabel = category.charAt(0).toUpperCase() + category.slice(1);
    const formattedContent = `[${categoryLabel}: ${name}]\n${description}`;

    const entry = {
      uid: entryId,
      key: keys,
      keysecondary: secondaryKeys,
      comment: categoryLabel,
      content: formattedContent,
      constant: category === 'setting', // World setting always active
      selective: secondaryKeys.length > 0,
      selectiveLogic: 0, // AND logic for secondary keys
      order: config.order,
      position: config.position,
      disable: false,
      addMemo: true,
      excludeRecursion: false,
      probability: 100,
      displayIndex: assignedDisplayIndex,
      useProbability: true,
      secondary_keys: secondaryKeys,
      keys: keys,
      id: entryId,
      priority: config.weight,
      insertion_order: config.order,
      enabled: true,
      name: name,
      extensions: {
        depth: config.depth,
        weight: config.weight,
        addMemo: true,
        displayIndex: assignedDisplayIndex,
        useProbability: true,
        characterFilter: null,
        excludeRecursion: false
      },
      case_sensitive: false,
      depth: config.depth,
      characterFilter: null
    };

    entries[entryId] = entry;
    entryId++;
  };

  // Add setting as a constant (always-on) entry
  if (worldInfo.setting) {
    createEntry('World Setting', 'setting', worldInfo.setting, ['world', 'setting', 'place', 'realm']);
  }

  // Add locations
  if (worldInfo.locations) {
    worldInfo.locations.forEach((loc) => {
      createEntry(loc.name, 'location', loc.description, loc.keywords || []);
    });
  }

  // Add factions
  if (worldInfo.factions) {
    worldInfo.factions.forEach((fac) => {
      createEntry(fac.name, 'faction', fac.description, fac.keywords || []);
    });
  }

  // Add concepts
  if (worldInfo.concepts) {
    worldInfo.concepts.forEach((con) => {
      createEntry(con.name, 'concept', con.description, con.keywords || []);
    });
  }

  // Add items
  if (worldInfo.items) {
    worldInfo.items.forEach((item) => {
      createEntry(item.name, 'item', item.description, item.keywords || []);
    });
  }

  // Add characters
  if (characters && characters.length > 0) {
    characters.forEach((char) => {
      if (!char.name) return;
      const parts = [];
      if (char.background) parts.push(char.background);
      if (char.physicalDescription) parts.push(char.physicalDescription);
      if (char.personality) parts.push(char.personality);
      const description = parts.join('\n\n') || char.briefDescription || '';
      if (!description) return;

      const keywords = Array.isArray(char.tags) ? char.tags : [];
      createEntry(char.name, 'character', description, keywords);
    });
  }

  return {
    name: cardName ? `${cardName} Lorebook` : 'Generated Lorebook',
    description: 'Auto-generated world information',
    is_creation: false,
    scan_depth: 8,
    token_budget: 2048,
    recursive_scanning: true,
    extensions: {},
    entries: Object.values(entries)
  };
}
