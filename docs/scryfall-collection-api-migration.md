# Scryfall Collection API Migration

## Overview

This document outlines the plan to migrate from Scryfall's Search API to the Collection API for initial card imports, dramatically improving fetch performance.

## Current Implementation

### Flow
1. User pastes decklist (e.g., 100 cards)
2. Client calls `POST /api/stream/cards` (SSE endpoint)
3. Server loops through each card **sequentially**
4. For each card, server calls Scryfall Search API:
   ```
   GET /cards/search?q=!"Sol Ring" include:extras unique:art lang:en
   ```
5. Each request has a **100ms mandatory delay** (Scryfall rate limit)
6. Returns all unique artworks per card

### Performance Problem
- 100 cards = 100+ API calls minimum
- 100ms delay per call = **10+ seconds** of mandatory waiting
- Additional time for HTTP overhead, pagination, language fallbacks
- **Typical import time: 20-60 seconds for 100 cards**

### Bug: Set/Collector Number Ignored

**Location:** `server/src/utils/getCardImagesPaged.js:35-67`

When users specify a set and collector number (e.g., `Mountain (one) 368`), the parser correctly extracts `{ name: "Mountain", set: "one", number: "368" }`. However, the server **ignores set and number** when `unique === "art"` (which is the default for imports).

```javascript
// Lines 35-37: Set/number only used when unique === "prints"
if (unique === "prints" && set && number) {
  // This branch is NEVER taken during import
}

// Line 67: Falls through to name-only search
const q = `!"${name}" include:extras unique:${unique} lang:${lang}`;
```

**Result:** User requests `Mountain (one) 368` but gets a random Mountain artwork instead of the specific ONE #368 printing.

**Fix:** The new Collection API implementation must use set/number when provided to fetch the exact printing requested.

### Files Involved
- `client/src/components/UploadSection.tsx` - Initiates fetch via SSE
- `server/src/routes/streamRouter.js` - SSE endpoint, sequential processing
- `server/src/routes/imageRouter.js` - Batch endpoint (unused for imports)
- `server/src/utils/getCardImagesPaged.js` - Scryfall Search API calls

---

## Proposed Implementation

### New Flow
1. User pastes decklist (e.g., 100 cards)
2. Client calls new endpoint `POST /api/cards/collection`
3. Server batches cards into groups of 75 (Collection API limit)
4. Server calls Scryfall Collection API:
   ```
   POST /cards/collection
   {
     "identifiers": [
       { "name": "Sol Ring" },
       { "name": "Counterspell" },
       // ... up to 75
     ]
   }
   ```
5. Returns **one artwork per card** (the default printing)
6. When user clicks a card, **lazy-load all artworks** using existing Search API

### Performance Improvement
- 100 cards = **2 API calls** (100 ÷ 75 = 2 batches)
- ~200ms total Scryfall time vs 10,000ms+
- **Expected import time: 1-3 seconds for 100 cards**

---

## API Details

### Scryfall Collection Endpoint

**Request:**
```http
POST https://api.scryfall.com/cards/collection
Content-Type: application/json

{
  "identifiers": [
    { "name": "Sol Ring" },
    { "set": "mm3", "collector_number": "129" },
    { "name": "Counterspell", "set": "ice" }
  ]
}
```

**Identifier Options (in priority order for matching):**
1. `{ "set": "xxx", "collector_number": "123" }` - Exact printing
2. `{ "name": "Card Name", "set": "xxx" }` - Specific set
3. `{ "name": "Card Name" }` - Any printing (Scryfall picks default)

**Response:**
```json
{
  "object": "list",
  "not_found": [
    { "name": "Misspelled Kard" }
  ],
  "data": [
    {
      "object": "card",
      "name": "Sol Ring",
      "set": "cmm",
      "collector_number": "420",
      "image_uris": {
        "png": "https://cards.scryfall.io/png/front/...",
        "large": "https://cards.scryfall.io/large/front/...",
        "normal": "https://cards.scryfall.io/normal/front/..."
      }
    }
  ]
}
```

**Limits:**
- Maximum 75 identifiers per request
- Still subject to 100ms rate limiting between requests
- Returns cards in arbitrary order (not input order)

### Mixed Identifier Support

The Collection API allows mixing different identifier types in a single request:

```json
{
  "identifiers": [
    { "set": "one", "collector_number": "368" },
    { "name": "Sol Ring", "set": "cmm" },
    { "name": "Counterspell" }
  ]
}
```

Each identifier is resolved independently:
- Exact set/number → returns that specific printing
- Name + set → returns Scryfall's default for that set
- Name only → returns Scryfall's default printing

### Not Found Handling

Cards that fail to match are returned in the `not_found` array with their **original identifier**:

```json
{
  "not_found": [
    { "set": "xyz", "collector_number": "999" },
    { "name": "Misspelled Kard" }
  ],
  "data": [ /* successfully found cards */ ]
}
```

This enables a **tiered fallback strategy**:

```javascript
// Fallback logic for not_found cards
for (const identifier of response.not_found) {
  if (identifier.collector_number && identifier.set) {
    // Exact printing failed → retry with name + set only
    retryQueue.push({ name: originalName, set: identifier.set });
  } else if (identifier.set) {
    // Name + set failed → retry with name only
    retryQueue.push({ name: identifier.name });
  } else {
    // Name only failed → card doesn't exist, report to user
    notFoundCards.push(identifier.name);
  }
}
```

---

## Implementation Plan

### Phase 1: New Server Endpoint

Create `POST /api/cards/collection` in `server/src/routes/imageRouter.js`:

```javascript
imageRouter.post("/collection", async (req, res) => {
  const cardQueries = req.body.cardQueries || []; // Array of { name, set?, number? }
  const language = (req.body.language || "en").toLowerCase();

  // 1. Build identifiers (use most specific available)
  // 2. Batch into groups of 75
  // 3. Call Scryfall Collection API for each batch
  // 4. Handle not_found cards with tiered fallback
  // 5. Return consolidated results with image URLs
});
```

**Identifier Building (fixes the set/number bug):**

```javascript
function buildIdentifier(cardInfo) {
  const { name, set, number } = cardInfo;

  if (set && number) {
    // Most specific: exact printing (e.g., "Mountain (one) 368")
    return { set: set.toLowerCase(), collector_number: number };
  } else if (set) {
    // Medium specific: card from specific set
    return { name, set: set.toLowerCase() };
  } else {
    // Least specific: any printing
    return { name };
  }
}
```

**Fallback Strategy for not_found:**

```javascript
async function fetchWithFallback(cardQueries) {
  const results = new Map(); // cardKey → scryfallCard
  let pending = cardQueries.map(q => ({ query: q, identifier: buildIdentifier(q) }));

  while (pending.length > 0) {
    // Batch and call Collection API
    const response = await callCollectionAPI(pending.map(p => p.identifier));

    // Process found cards
    for (const card of response.data) {
      results.set(matchToOriginalQuery(card, pending), card);
    }

    // Build retry queue with less specific identifiers
    const retry = [];
    for (const notFound of response.not_found) {
      const original = findOriginalQuery(notFound, pending);
      if (notFound.collector_number) {
        // Exact print failed → try name + set
        retry.push({ query: original.query, identifier: { name: original.query.name, set: notFound.set } });
      } else if (notFound.set) {
        // Name + set failed → try name only
        retry.push({ query: original.query, identifier: { name: notFound.name } });
      } else {
        // Name only failed → truly not found
        results.set(cardKey(original.query), null);
      }
    }

    pending = retry;
  }

  return results;
}
```

**Key considerations:**
- Handle double-faced cards (check `card_faces` array for images)
- Respect 100ms delay between batch requests
- Track original query to match returned cards back to decklist order
- Support language parameter (may need separate handling)

### Phase 2: Update Client

Modify `client/src/components/UploadSection.tsx`:

```typescript
// Replace fetchEventSource SSE call with simple POST
const response = await axios.post(`${API_BASE}/api/cards/collection`, {
  cardQueries: uniqueInfos,
  language: globalLanguage,
});

// Process response.data to add cards to IndexedDB
```

**Changes:**
- Remove SSE streaming logic (no longer needed for fast responses)
- Use simple axios POST request
- Keep progress indicator (can show batch progress: "Fetching batch 1/2...")
- Handle `not_found` cards (show warning to user)

### Phase 3: Lazy-Load Artworks

The existing `ArtworkModal.tsx` already handles this:
- Initial view shows single artwork from Collection API
- "Get All Prints" button fetches all artworks via Search API
- No changes needed, but consider renaming to "Get All Artworks"

### Phase 4: Cleanup (Optional)

- Remove or deprecate `POST /api/stream/cards` SSE endpoint
- Remove unused streaming logic from client
- Update `imageRouter.post("/")` batch endpoint if redundant

---

## Edge Cases to Handle

### 1. Cards Not Found
Collection API returns `not_found` array. Options:
- Show warning to user with list of unfound cards
- Attempt fallback Search API query for these cards
- Allow user to manually search/add

### 2. Double-Faced Cards (DFCs)
DFCs don't have `image_uris` at card level, only on `card_faces`:
```javascript
if (card.image_uris?.png) {
  return card.image_uris.png;
} else if (card.card_faces?.[0]?.image_uris?.png) {
  return card.card_faces[0].image_uris.png;
}
```

### 3. Language Support
Collection API supports language in identifiers, but behavior differs:
- If exact language not found, Scryfall may return English version
- Or it may appear in `not_found`
- Need to test behavior and handle accordingly

### 4. Set/Collector Number Matching
When user specifies set/number (e.g., "Sol Ring (cmm) 420"):
- Use precise identifier: `{ "set": "cmm", "collector_number": "420" }`
- If not found, could fallback to name-only

### 5. Order Preservation
Collection API returns cards in arbitrary order. Need to:
- Track original order from decklist
- Match returned cards back to original entries by name/set/number
- Preserve quantity information (e.g., "4x Sol Ring" → 4 cards)

---

## Testing Checklist

- [ ] Import 100+ card decklist completes in <5 seconds
- [ ] Cards with set/number specified get correct printing
- [ ] Double-faced cards display correctly
- [ ] Non-English language imports work
- [ ] Not-found cards show appropriate warning
- [ ] Duplicate cards (4x Sol Ring) create 4 separate entries
- [ ] Clicking card still shows artwork selection modal
- [ ] "Get All Prints/Artworks" still fetches all versions
- [ ] Large imports (500+ cards) handle batching correctly

---

## Rollback Plan

If issues arise:
1. Keep existing SSE endpoint functional during migration
2. Add feature flag to switch between old/new implementation
3. Monitor error rates and performance after deployment
