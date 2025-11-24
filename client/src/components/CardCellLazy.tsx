import React, { useEffect } from "react";
import { useOnScreen } from "../hooks/useOnScreen";
import type { CardOption } from "../types/Card";

type Props = {
  card: CardOption;
  state: "idle" | "loading" | "error" | undefined;
  hasImage: boolean;
  isProcessed?: boolean;
  ensureProcessed: (card: CardOption) => Promise<void>;
  children: React.ReactNode;
};

export default function CardCellLazy({
  card,
  state,
  hasImage,
  isProcessed = false,
  ensureProcessed,
  children,
}: Props) {
  const { ref, visible } = useOnScreen<HTMLDivElement>("400px");

  useEffect(() => {
    // Only trigger processing if visible and not yet processed
    if (visible && !isProcessed) void ensureProcessed(card);
  }, [visible, card.uuid, card.imageId, isProcessed, ensureProcessed]);

  return (
    <div ref={ref} className="relative">
      {/* Only show spinner if we have no image at all */}
      {!hasImage && state !== "error" && (
        <div className="absolute inset-0 grid place-items-center z-10">
          <div className="h-8 w-8 animate-spin rounded-full border-4 border-gray-300 border-t-transparent" />
        </div>
      )}
      {/* Show small processing indicator when we have image but it's not processed yet */}
      {hasImage && !isProcessed && state === "loading" && (
        <div className="absolute top-1 right-1 z-10">
          <div className="h-4 w-4 animate-spin rounded-full border-2 border-blue-500 border-t-transparent" />
        </div>
      )}
      {state === "error" && !hasImage && (
        <div className="absolute inset-0 grid place-items-center z-10">
          <div className="px-2 py-1 text-xs bg-red-600 text-white rounded">
            load failed — click to retry
          </div>
        </div>
      )}
      <div
        onClick={() => {
          if (state === "error") void ensureProcessed(card);
        }}
      >
        {children}
      </div>
    </div>
  );
}
