# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Proxxied is a Magic: The Gathering proxy card printing tool. Users import decklists, fetch card images from Scryfall, arrange cards in a print-ready grid layout, and export to PDF.

**Live site:** https://proxxied.com

## Development Commands

```bash
# Install all dependencies (root, client, server)
npm install && cd client && npm install && cd ../server && npm install && cd ..

# Run both client and server concurrently
npm run dev

# Client-only commands (from /client)
npm run dev      # Vite dev server on localhost:5173
npm run build    # TypeScript check + Vite build
npm run lint     # ESLint

# Server-only commands (from /server)
npm run dev      # nodemon with ts-node on localhost:3001
npm run build    # TypeScript compile to dist/
```

## Architecture

### Monorepo Structure
- `/client` - React + TypeScript + Vite frontend
- `/server` - Node.js + Express backend (CommonJS, uses .js files with TypeScript for entry)

### Client Architecture

**State Management:** Zustand stores in `client/src/store/`
- `settings.ts` - Page layout settings (size, orientation, bleed, guides, DPI), persisted to IndexedDB
- `cards.ts` - Card clearing operations
- `artworkModal.ts` - Alternate artwork selection modal state
- `loading.ts` - Global loading state

**Data Persistence:** Dexie (IndexedDB wrapper) in `client/src/db.ts`
- `cards` table - CardOption objects with uuid, name, imageId, order
- `images` table - Cached image blobs (original, display, export versions with DPI/bleed metadata)
- `settings` table - Zustand persistence

**Key Client Components:**
- `ProxyBuilderPage.tsx` - Main page, orchestrates image processing on startup
- `PageView.tsx` - Card grid with drag-and-drop (@dnd-kit)
- `UploadSection.tsx` - Decklist input and custom image upload
- `PageSettingsControls.tsx` - Layout/export configuration panel

**Image Processing:** Web Workers for off-main-thread work
- `helpers/bleed.worker.ts` - Bleed edge processing
- `helpers/pdf.worker.ts` - PDF page rendering
- `helpers/imageProcessor.ts` - Coordinates worker pool

**PDF Export:** `helpers/ExportProxyPageToPdf.tsx`
- Uses pdf-lib for document creation
- Worker pool renders each page as JPEG, then embeds into PDF
- Supports cancellation and progress callbacks

### Server Architecture

**Express routes in `server/src/routes/`:**
- `imageRouter.js` - Card image fetching and caching
  - `POST /api/cards/images` - Batch fetch card images from Scryfall
  - `GET /api/cards/images/proxy?url=` - Cached image proxy with LRU eviction (12GB limit)
  - `POST /api/cards/images/upload` - Custom image upload
  - `GET /api/cards/images/front?id=` - Google Drive image proxy
- `streamRouter.js` - SSE streaming for card fetch progress

**Scryfall Integration:** `server/src/utils/getCardImagesPaged.js`
- Rate limiting (100ms between requests)
- Pagination handling
- Language fallback to English
- Query strategies: exact printing → set+name → name-only

### Key Types

```typescript
// client/src/types/Card.ts
interface CardOption {
  uuid: string;
  name: string;
  order: number;
  imageId?: string;        // References images table
  isUserUpload: boolean;
  hasBakedBleed?: boolean;
  set?: string;
  number?: string;
  lang?: string;
}
```

## API Configuration

Client uses `VITE_API_BASE` env var for API URL. In dev mode, defaults to empty (relative URLs via Vite proxy). See `client/src/constants.ts`.
