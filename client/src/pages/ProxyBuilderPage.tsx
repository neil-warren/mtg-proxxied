import { Suspense, lazy, useEffect, useMemo, useState } from "react";
import { useLiveQuery } from "dexie-react-hooks";
import { PageSettingsControls } from "../components/PageSettingsControls";
import { UploadSection } from "../components/UploadSection";
import { useImageProcessing } from "../hooks/useImageProcessing";
import { useSettingsStore } from "../store";
import { db } from "../db";
import { ImageProcessor } from "../helpers/imageProcessor";
import { rebalanceCardOrders } from "@/helpers/dbUtils";

const PageView = lazy(() =>
  import("../components/PageView").then((module) => ({
    default: module.PageView,
  }))
);

function PageViewLoader() {
  return (
    <div className="w-1/2 flex-1 overflow-y-auto bg-gray-200 h-full p-6 flex justify-center items-center dark:bg-gray-800">
      <div className="h-12 w-12 animate-spin rounded-full border-4 border-gray-400 border-t-transparent" />
    </div>
  );
}

export default function ProxyBuilderPage() {
  const bleedEdgeWidth = useSettingsStore((state) => state.bleedEdgeWidth);
  const imageProcessor = useMemo(() => new ImageProcessor(), []);
  const [activeFace, setActiveFace] = useState<"front" | "back">("front");

  const frontCardCount = useLiveQuery(
    () => db.cards.where("face").equals("front").count(),
    []
  ) ?? 0;

  const backCardCount = useLiveQuery(
    () => db.cards.where("face").equals("back").count(),
    []
  ) ?? 0;

  const { loadingMap, ensureProcessed, reprocessSelectedImages } =
    useImageProcessing({
      unit: "mm",
      bleedEdgeWidth,
      imageProcessor,
    });

  // On startup, rebalance card orders to prevent floating point issues.
  useEffect(() => {
    const timer = setTimeout(() => {
      void rebalanceCardOrders();
    }, 200);
    return () => clearTimeout(timer);
  }, []);

  // On startup, find all unprocessed images and kick off processing for them
  useEffect(() => {
    const processAllUnprocessed = async () => {
      const allCards = await db.cards.toArray();
      const allImages = await db.images.toArray();
      const imagesById = new Map(allImages.map((img) => [img.id, img]));

      const unprocessedCards = allCards.filter((card) => {
        if (!card.imageId) return false;
        const img = imagesById.get(card.imageId);
        return !img?.displayBlob;
      });

      for (const card of unprocessedCards) {
        void ensureProcessed(card);
      }
    };

    // Delay ever so slightly to allow the main UI to render first
    const timer = setTimeout(() => processAllUnprocessed(), 100);
    return () => clearTimeout(timer);
  }, [ensureProcessed]);

  useEffect(() => {
    return () => {
      imageProcessor.destroy();
    };
  }, [imageProcessor]);

  return (
    <div className="flex flex-row h-screen justify-between overflow-hidden">
      <UploadSection />
      <div className="w-1/2 flex-1 flex flex-col overflow-hidden">
        {/* Tab bar */}
        <div className="flex bg-gray-100 dark:bg-gray-700 border-b border-gray-300 dark:border-gray-600 px-4 pt-2 gap-1">
          <button
            className={`px-4 py-2 text-sm font-medium rounded-t-lg transition-colors ${
              activeFace === "front"
                ? "bg-gray-200 dark:bg-gray-800 text-gray-900 dark:text-white border border-b-0 border-gray-300 dark:border-gray-600"
                : "text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-300 hover:bg-gray-200/50 dark:hover:bg-gray-600/50"
            }`}
            onClick={() => setActiveFace("front")}
          >
            Front ({frontCardCount})
          </button>
          <button
            className={`px-4 py-2 text-sm font-medium rounded-t-lg transition-colors ${
              activeFace === "back"
                ? "bg-gray-200 dark:bg-gray-800 text-gray-900 dark:text-white border border-b-0 border-gray-300 dark:border-gray-600"
                : "text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-300 hover:bg-gray-200/50 dark:hover:bg-gray-600/50"
            }`}
            onClick={() => setActiveFace("back")}
          >
            Back ({backCardCount})
          </button>
        </div>
        <Suspense fallback={<PageViewLoader />}>
          <PageView
            loadingMap={loadingMap}
            ensureProcessed={ensureProcessed}
            activeFace={activeFace}
            frontCardCount={frontCardCount}
          />
        </Suspense>
      </div>
      <PageSettingsControls reprocessSelectedImages={reprocessSelectedImages} />
    </div>
  );
}
