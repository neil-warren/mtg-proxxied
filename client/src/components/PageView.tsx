import {
  closestCenter,
  DndContext,
  PointerSensor,
  useSensor,
  useSensors,
} from "@dnd-kit/core";
import {
  arrayMove,
  rectSortingStrategy,
  SortableContext,
} from "@dnd-kit/sortable";
import { useLiveQuery } from "dexie-react-hooks";
import { Button, Label } from "flowbite-react";
import { Copy, Trash } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import fullLogo from "../assets/fullLogo.png";
import CardCellLazy from "../components/CardCellLazy";
import EdgeCutLines from "../components/FullPageGuides";
import EmptyDropCell from "../components/EmptyDropCell";
import SortableCard from "../components/SortableCard";
import { db } from "../db";
import { deleteCard, duplicateCard } from "../helpers/dbUtils";
import { getBleedInPixels } from "../helpers/ImageHelper";
import { useImageProcessing } from "../hooks/useImageProcessing";
import { useArtworkModalStore, useSettingsStore } from "../store";
import { ArtworkModal } from "./ArtworkModal";
import type { CardOption } from "../types/Card";

const unit = "mm";
const baseCardWidthMm = 63;
const baseCardHeightMm = 88;

type PageViewProps = {
  loadingMap: ReturnType<typeof useImageProcessing>["loadingMap"];
  ensureProcessed: ReturnType<typeof useImageProcessing>["ensureProcessed"];
  activeFace: "front" | "back";
  frontCardCount: number;
};

export function PageView({ loadingMap, ensureProcessed, activeFace, frontCardCount }: PageViewProps) {
  const pageSizeUnit = useSettingsStore((state) => state.pageSizeUnit);
  const pageWidth = useSettingsStore((state) => state.pageWidth);
  const pageHeight = useSettingsStore((state) => state.pageHeight);
  const columns = useSettingsStore((state) => state.columns);
  const rows = useSettingsStore((state) => state.rows);
  const bleedEdgeWidth = useSettingsStore((state) => state.bleedEdgeWidth);
  const zoom = useSettingsStore((state) => state.zoom);

  const pageRef = useRef<HTMLDivElement>(null);

  const sensors = useSensors(useSensor(PointerSensor));

  const cards = useLiveQuery(
    () => db.cards.where("face").equals(activeFace).sortBy("order"),
    [activeFace]
  );
  const images = useLiveQuery(() => db.images.toArray(), []);

  const urlCacheRef = useRef<Map<string, { blob: Blob | null; url: string; isProcessed: boolean }>>(new Map());

  // Returns image URLs - prefers displayBlob (processed), falls back to originalBlob or sourceUrl
  const { imageUrls, processedIds } = useMemo(() => {
    const urls: Record<string, string> = {};
    const processed = new Set<string>();
    if (!images) return { imageUrls: urls, processedIds: processed };

    const currentCache = urlCacheRef.current;
    const usedIds = new Set<string>();

    images.forEach((img) => {
      usedIds.add(img.id);

      // Determine the best available source
      const hasProcessed = !!(img.displayBlob && img.displayBlob.size > 0);
      const blob = hasProcessed ? img.displayBlob : img.originalBlob;
      const sourceUrl = img.sourceUrl;

      if (hasProcessed) {
        processed.add(img.id);
      }

      // Check cache
      const cached = currentCache.get(img.id);

      if (blob) {
        if (cached && cached.blob === blob) {
          urls[img.id] = cached.url;
        } else {
          if (cached && cached.url && !cached.url.startsWith('http')) {
            URL.revokeObjectURL(cached.url);
          }
          const newUrl = URL.createObjectURL(blob);
          urls[img.id] = newUrl;
          currentCache.set(img.id, { blob, url: newUrl, isProcessed: hasProcessed });
        }
      } else if (sourceUrl) {
        urls[img.id] = sourceUrl;
        currentCache.set(img.id, { blob: null, url: sourceUrl, isProcessed: false });
      }
    });

    // Clean up URLs for images that no longer exist
    for (const [id, cached] of currentCache.entries()) {
      if (!usedIds.has(id)) {
        if (cached.url && !cached.url.startsWith('http')) {
          URL.revokeObjectURL(cached.url);
        }
        currentCache.delete(id);
      }
    }

    return { imageUrls: urls, processedIds: processed };
  }, [images]);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      for (const cached of urlCacheRef.current.values()) {
        if (cached.url && !cached.url.startsWith('http')) {
          URL.revokeObjectURL(cached.url);
        }
      }
      urlCacheRef.current.clear();
    };
  }, []);

  const openArtworkModal = useArtworkModalStore((state) => state.openModal);

  const bleedPixels = getBleedInPixels(bleedEdgeWidth, unit);
  const guideOffset = `${(bleedPixels * (25.4 / 300)).toFixed(3)}mm`;
  const totalCardWidth = baseCardWidthMm + bleedEdgeWidth * 2;
  const totalCardHeight = baseCardHeightMm + bleedEdgeWidth * 2;
  const pageCapacity = columns * rows;
  const cardSpacingMm = useSettingsStore((state) => state.cardSpacingMm);

  const gridWidthMm =
    totalCardWidth * columns + Math.max(0, columns - 1) * cardSpacingMm;
  const gridHeightMm =
    totalCardHeight * rows + Math.max(0, rows - 1) * cardSpacingMm;

  const [contextMenu, setContextMenu] = useState({
    visible: false,
    x: 0,
    y: 0,
    cardUuid: null as string | null,
  });

  const rebalanceOrders = useCallback(async () => {
    const sortedCards = await db.cards.where("face").equals(activeFace).sortBy("order");
    const rebalancedCards = sortedCards.map((card, index) => ({
      ...card,
      order: index + 1,
    }));
    await db.cards.bulkPut(rebalancedCards);
  }, [activeFace]);

  useEffect(() => {
    const handler = () =>
      setContextMenu((prev) => ({ ...prev, visible: false }));
    window.addEventListener("click", handler);
    return () => window.removeEventListener("click", handler);
  }, []);

  function chunkCards<T>(cards: T[], size: number): T[][] {
    const chunks: T[][] = [];
    for (let i = 0; i < cards.length; i += size) {
      chunks.push(cards.slice(i, i + size));
    }
    return chunks;
  }

  // For back tab: build a map of order (grid cell index) → card
  const backCardsByIndex = useMemo(() => {
    if (activeFace !== "back" || !cards) return new Map<number, CardOption>();
    const map = new Map<number, CardOption>();
    for (const card of cards) {
      map.set(card.order, card);
    }
    return map;
  }, [activeFace, cards]);

  // For back tab: compute total cells needed (match front page count, minimum 1 page)
  const backTotalCells = useMemo(() => {
    if (activeFace !== "back") return 0;
    const frontPages = Math.max(1, Math.ceil(frontCardCount / pageCapacity));
    const maxBackIndex = cards && cards.length > 0
      ? Math.max(...cards.map(c => c.order))
      : -1;
    const backPagesNeeded = Math.ceil((maxBackIndex + 1) / pageCapacity);
    const totalPages = Math.max(frontPages, backPagesNeeded);
    return totalPages * pageCapacity;
  }, [activeFace, frontCardCount, pageCapacity, cards]);

  // Render a single card cell (shared between front and back rendering)
  const renderCardCell = useCallback((card: CardOption, globalIndex: number, index: number) => {
    if (!card.imageId) {
      return (
        <div
          key={card.uuid}
          onContextMenu={(e) => {
            e.preventDefault();
            setContextMenu({
              visible: true,
              x: e.clientX,
              y: e.clientY,
              cardUuid: card.uuid,
            });
          }}
          onClick={() => {
            openArtworkModal({
              card,
              index: globalIndex,
            });
          }}
          className="flex items-center justify-center border-2 border-dashed border-red-500 bg-gray-50 text-center p-2 select-none"
          style={{ boxSizing: "border-box" }}
          title={`"${card.name}" not found`}
        >
          <div>
            <div className="font-semibold text-red-700">"{card.name}"</div>
            <div className="text-xs text-gray-600">Image not available</div>
          </div>
        </div>
      );
    }

    const imageSrc = imageUrls[card.imageId];
    const isProcessed = processedIds.has(card.imageId);

    return (
      <CardCellLazy
        key={card.uuid}
        card={card}
        state={loadingMap[card.uuid] ?? "idle"}
        hasImage={!!imageSrc}
        isProcessed={isProcessed}
        ensureProcessed={ensureProcessed}
      >
        <SortableCard
          card={card}
          index={index}
          globalIndex={globalIndex}
          imageSrc={imageSrc!}
          totalCardWidth={totalCardWidth}
          totalCardHeight={totalCardHeight}
          guideOffset={guideOffset}
          setContextMenu={setContextMenu}
        />
      </CardCellLazy>
    );
  }, [imageUrls, processedIds, loadingMap, ensureProcessed, openArtworkModal, totalCardWidth, totalCardHeight, guideOffset]);

  // Front tab: DnD handler (sequential reorder)
  const handleFrontDragEnd = useCallback(async ({ active, over }: { active: { id: string | number }; over: { id: string | number } | null }) => {
    if (!cards || !over || active.id === over.id) return;

    const oldIndex = cards.findIndex((c) => c.uuid === active.id);
    const newIndex = cards.findIndex((c) => c.uuid === over.id);
    if (oldIndex === -1 || newIndex === -1) return;

    const reorderedCards = arrayMove(cards, oldIndex, newIndex);

    const prevCard = reorderedCards[newIndex - 1];
    const nextCard = reorderedCards[newIndex + 1];

    let newOrder: number;

    if (!prevCard) {
      newOrder = (nextCard?.order || 0) - 1;
    } else if (!nextCard) {
      newOrder = prevCard.order + 1;
    } else {
      newOrder = (prevCard.order + nextCard.order) / 2.0;
    }

    if (newOrder === prevCard?.order || newOrder === nextCard?.order) {
      console.warn("Floating point precision limit reached. Triggering order re-balance.");
      await rebalanceOrders();
      return;
    }

    await db.cards.update(active.id as string, { order: newOrder });
  }, [cards, rebalanceOrders]);

  // Back tab: DnD handler (position-based)
  const handleBackDragEnd = useCallback(async ({ active, over }: { active: { id: string | number }; over: { id: string | number } | null }) => {
    if (!over) return;

    const overId = String(over.id);
    let targetCellIndex: number;

    if (overId.startsWith("empty-cell-")) {
      targetCellIndex = parseInt(overId.replace("empty-cell-", ""), 10);
    } else {
      // Dropped on another card - find that card's order (cell index)
      const overCard = cards?.find(c => c.uuid === overId);
      if (!overCard) return;
      targetCellIndex = overCard.order;
    }

    const activeCard = cards?.find(c => c.uuid === active.id);
    if (!activeCard || activeCard.order === targetCellIndex) return;

    // If target cell is occupied, swap the two cards
    const occupant = cards?.find(c => c.order === targetCellIndex && c.uuid !== activeCard.uuid);
    if (occupant) {
      const oldOrder = activeCard.order;
      await db.cards.update(activeCard.uuid, { order: targetCellIndex });
      await db.cards.update(occupant.uuid, { order: oldOrder });
    } else {
      await db.cards.update(activeCard.uuid, { order: targetCellIndex });
    }
  }, [cards]);

  const contextMenuOverlay = contextMenu.visible && contextMenu.cardUuid && (
    <div
      className="absolute bg-white border rounded-xl border-gray-300 shadow-md z-50 text-sm flex flex-col gap-1"
      style={{
        top: contextMenu.y,
        left: contextMenu.x,
        padding: "0.25rem",
      }}
      onMouseLeave={() => setContextMenu({ ...contextMenu, visible: false })}
    >
      {activeFace === "front" && (
        <Button
          size="xs"
          onClick={async () => {
            await duplicateCard(contextMenu.cardUuid!);
            setContextMenu({ ...contextMenu, visible: false });
          }}
        >
          <Copy className="size-3 mr-1" />
          Duplicate
        </Button>
      )}
      <Button
        size="xs"
        color="red"
        onClick={async () => {
          await deleteCard(contextMenu.cardUuid!);
          setContextMenu({ ...contextMenu, visible: false });
        }}
      >
        <Trash className="size-3 mr-1" />
        Delete
      </Button>
    </div>
  );

  const renderPage = (pageIndex: number, children: React.ReactNode) => (
    <div
      key={pageIndex}
      className="proxy-page relative bg-white dark:bg-gray-700"
      style={{
        zoom: zoom,
        width: `${pageWidth}${pageSizeUnit}`,
        height: `${pageHeight}${pageSizeUnit}`,
        display: "flex",
        flexDirection: "column",
        justifyContent: "center",
        alignItems: "center",
        breakAfter: "page",
        flexShrink: 0,
        padding: 0,
        margin: 0,
      }}
    >
      <div
        style={{
          display: "grid",
          gridTemplateColumns: `repeat(${columns}, ${totalCardWidth}mm)`,
          gridTemplateRows: `repeat(${rows}, ${totalCardHeight}mm)`,
          width: `${gridWidthMm}mm`,
          height: `${gridHeightMm}mm`,
          gap: `${cardSpacingMm}mm`,
        }}
      >
        {children}
      </div>

      <EdgeCutLines
        totalCardWidthMm={totalCardWidth}
        totalCardHeightMm={totalCardHeight}
        baseCardWidthMm={baseCardWidthMm}
        baseCardHeightMm={baseCardHeightMm}
        bleedEdgeWidthMm={bleedEdgeWidth}
      />
    </div>
  );

  return (
    <div className="flex-1 overflow-y-auto bg-gray-200 h-full p-6 flex justify-center dark:bg-gray-800">
      {(!cards || cards.length === 0) && activeFace === "front" ? (
        <div className="flex flex-col items-center">
          <div className="flex flex-row items-center">
            <Label className="text-7xl justify-center font-bold whitespace-nowrap">
              Welcome to
            </Label>
            <img src={fullLogo} alt="Proxxied Logo" className="h-36 mt-[1rem]" />
          </div>
          <Label className="text-xl text-gray-600 justify-center">
            Enter a decklist to the left or Upload Files to get started
          </Label>
        </div>
      ) : (!cards || cards.length === 0) && activeFace === "back" ? (
        <div className="flex flex-col items-center pt-12">
          <Label className="text-xl text-gray-600 dark:text-gray-400 justify-center">
            No back-face cards yet
          </Label>
          <Label className="text-sm text-gray-500 dark:text-gray-500 justify-center mt-2">
            Import double-faced cards to auto-populate the back tab
          </Label>
        </div>
      ) : activeFace === "front" ? (
        /* ===== FRONT TAB: sequential card grid ===== */
        <div ref={pageRef} className="flex flex-col gap-[1rem]">
          {contextMenuOverlay}
          <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleFrontDragEnd}>
            <SortableContext items={cards!.map((card) => card.uuid)} strategy={rectSortingStrategy}>
              {chunkCards(cards!, pageCapacity).map((page, pageIndex) =>
                renderPage(
                  pageIndex,
                  page.map((card, index) => {
                    const globalIndex = pageIndex * pageCapacity + index;
                    return renderCardCell(card, globalIndex, index);
                  })
                )
              )}
            </SortableContext>
          </DndContext>
        </div>
      ) : (
        /* ===== BACK TAB: fixed grid with gaps ===== */
        <div ref={pageRef} className="flex flex-col gap-[1rem]">
          {contextMenuOverlay}
          <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleBackDragEnd}>
            <SortableContext items={cards!.map((card) => card.uuid)} strategy={rectSortingStrategy}>
              {Array.from({ length: Math.max(1, Math.ceil(backTotalCells / pageCapacity)) }).map((_, pageIndex) =>
                renderPage(
                  pageIndex,
                  Array.from({ length: pageCapacity }).map((_, cellIdx) => {
                    const globalIndex = pageIndex * pageCapacity + cellIdx;
                    const card = backCardsByIndex.get(globalIndex);

                    if (card) {
                      return renderCardCell(card, globalIndex, cellIdx);
                    }

                    return (
                      <EmptyDropCell
                        key={`empty-${globalIndex}`}
                        cellIndex={globalIndex}
                        totalCardWidth={totalCardWidth}
                        totalCardHeight={totalCardHeight}
                      />
                    );
                  })
                )
              )}
            </SortableContext>
          </DndContext>
        </div>
      )}

      <ArtworkModal />
    </div>
  );
}
