const axios = require("axios");

const SCRYFALL_COLLECTION_API = "https://api.scryfall.com/cards/collection";
const BATCH_SIZE = 75;

const AX = axios.create({
  headers: { "User-Agent": "Proxxied/1.0 (contact: proxxied@example.com)" },
  timeout: 30000,
});

// 100ms delay between Scryfall requests (their recommendation)
let lastScryfallRequest = 0;
async function delayScryfallRequest() {
  const now = Date.now();
  const elapsed = now - lastScryfallRequest;
  if (elapsed < 100) {
    await new Promise((r) => setTimeout(r, 100 - elapsed));
  }
  lastScryfallRequest = Date.now();
}

/**
 * Build a Scryfall identifier from card info, using the most specific available data.
 * @param {Object} cardInfo - { name, set?, number? }
 * @returns {Object} Scryfall identifier
 */
function buildIdentifier(cardInfo) {
  const { name, set, number } = cardInfo;

  if (set && number) {
    // Most specific: exact printing (e.g., "Mountain (one) 368")
    return { set: set.toLowerCase(), collector_number: String(number) };
  } else if (set) {
    // Medium specific: card from specific set
    return { name, set: set.toLowerCase() };
  } else {
    // Least specific: any printing
    return { name };
  }
}

/**
 * Create a unique key for a card query to track it through fallback retries.
 * @param {Object} cardInfo - { name, set?, number? }
 * @returns {string} Unique key
 */
function cardKey(cardInfo) {
  return `${(cardInfo.name || "").toLowerCase()}|${cardInfo.set || ""}|${cardInfo.number || ""}`;
}

/**
 * Extract image URL from a Scryfall card object, handling DFCs.
 * @param {Object} card - Scryfall card object
 * @returns {string|null} PNG image URL or null
 */
function extractImageUrl(card) {
  if (card.image_uris?.png) {
    return card.image_uris.png;
  }
  // Double-faced cards have images on card_faces
  if (Array.isArray(card.card_faces) && card.card_faces[0]?.image_uris?.png) {
    return card.card_faces[0].image_uris.png;
  }
  return null;
}

/**
 * Call Scryfall Collection API for a batch of identifiers.
 * @param {Array} identifiers - Array of Scryfall identifiers
 * @returns {Object} { data: [], not_found: [] }
 */
async function callCollectionAPI(identifiers) {
  await delayScryfallRequest();

  try {
    const response = await AX.post(SCRYFALL_COLLECTION_API, { identifiers });
    return {
      data: response.data.data || [],
      not_found: response.data.not_found || [],
    };
  } catch (err) {
    console.error("[Collection API] Error:", err.message);
    // On error, treat all as not found
    return {
      data: [],
      not_found: identifiers,
    };
  }
}

/**
 * Match a Scryfall card back to the original query.
 * Cards are returned in arbitrary order, so we need to match them.
 * @param {Object} card - Scryfall card object
 * @param {Array} pendingQueries - Array of { query, identifier, key }
 * @returns {Object|null} The matching pending query or null
 */
function matchCardToQuery(card, pendingQueries) {
  // Try to match by set + collector_number first (most specific)
  const byExact = pendingQueries.find(
    (p) =>
      p.identifier.set === card.set &&
      p.identifier.collector_number === card.collector_number
  );
  if (byExact) return byExact;

  // Try to match by name + set
  const byNameSet = pendingQueries.find(
    (p) =>
      p.identifier.name?.toLowerCase() === card.name.toLowerCase() &&
      p.identifier.set === card.set &&
      !p.identifier.collector_number
  );
  if (byNameSet) return byNameSet;

  // Try to match by name only
  const byName = pendingQueries.find(
    (p) =>
      p.identifier.name?.toLowerCase() === card.name.toLowerCase() &&
      !p.identifier.set
  );
  if (byName) return byName;

  return null;
}

/**
 * Fetch cards using Collection API with tiered fallback for not_found cards.
 *
 * Fallback strategy:
 * 1. If exact print (set + number) not found → retry with name + set
 * 2. If name + set not found → retry with name only
 * 3. If name only not found → report as truly not found
 *
 * @param {Array} cardQueries - Array of { name, set?, number? }
 * @returns {Object} { found: Map<key, cardData>, notFound: Array<cardQuery> }
 */
async function fetchCardsWithFallback(cardQueries) {
  const results = new Map(); // key → { query, card, imageUrl }
  const notFoundList = []; // Queries that truly couldn't be found

  // Initialize pending with original queries
  let pending = cardQueries.map((query) => ({
    query,
    identifier: buildIdentifier(query),
    key: cardKey(query),
    fallbackLevel: 0, // 0 = original, 1 = name+set, 2 = name only
  }));

  while (pending.length > 0) {
    // Process in batches of 75
    const batches = [];
    for (let i = 0; i < pending.length; i += BATCH_SIZE) {
      batches.push(pending.slice(i, i + BATCH_SIZE));
    }

    const nextPending = [];

    for (const batch of batches) {
      const identifiers = batch.map((p) => p.identifier);
      const response = await callCollectionAPI(identifiers);

      // Track which queries were matched
      const matched = new Set();

      // Process found cards
      for (const card of response.data) {
        const match = matchCardToQuery(card, batch);
        if (match) {
          matched.add(match.key);
          results.set(match.key, {
            query: match.query,
            card: {
              name: card.name,
              set: card.set,
              number: card.collector_number,
              imageUrl: extractImageUrl(card),
            },
          });
        }
      }

      // Process not_found - build retry queue with less specific identifiers
      for (const notFound of response.not_found) {
        // Find the original query for this not_found identifier
        const original = batch.find((p) => {
          if (notFound.collector_number && notFound.set) {
            return (
              p.identifier.set === notFound.set &&
              p.identifier.collector_number === notFound.collector_number
            );
          } else if (notFound.set && notFound.name) {
            return (
              p.identifier.name?.toLowerCase() === notFound.name.toLowerCase() &&
              p.identifier.set === notFound.set
            );
          } else if (notFound.name) {
            return (
              p.identifier.name?.toLowerCase() === notFound.name.toLowerCase() &&
              !p.identifier.set
            );
          }
          return false;
        });

        if (!original) continue;
        if (matched.has(original.key)) continue; // Already found via another path

        // Determine next fallback level
        if (notFound.collector_number && original.query.name) {
          // Exact print failed → try name + set
          nextPending.push({
            query: original.query,
            identifier: { name: original.query.name, set: notFound.set },
            key: original.key,
            fallbackLevel: 1,
          });
        } else if (notFound.set && original.query.name) {
          // Name + set failed → try name only
          nextPending.push({
            query: original.query,
            identifier: { name: original.query.name },
            key: original.key,
            fallbackLevel: 2,
          });
        } else {
          // Name only failed → truly not found
          notFoundList.push(original.query);
        }
      }
    }

    pending = nextPending;
  }

  return { found: results, notFound: notFoundList };
}

module.exports = {
  fetchCardsWithFallback,
  buildIdentifier,
  cardKey,
  extractImageUrl,
  BATCH_SIZE,
};
