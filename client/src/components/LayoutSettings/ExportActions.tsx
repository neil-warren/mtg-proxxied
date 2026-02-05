import { buildDecklist, downloadDecklist } from "@/helpers/DecklistHelper";
import { useLoadingStore, type LoadingTask } from "@/store/loading";
import { useSettingsStore } from "@/store/settings";
import { Button } from "flowbite-react";
import { useLiveQuery } from "dexie-react-hooks";
import { db } from "../../db";
import type { CardOption } from "@/types/Card";

export function ExportActions() {
  const setLoadingTask = useLoadingStore((state) => state.setLoadingTask);
  const setProgress = useLoadingStore((state) => state.setProgress);

  const allCards = useLiveQuery(() => db.cards.orderBy("order").toArray(), []) || [];
  const frontCards = useLiveQuery(
    () => db.cards.where("face").equals("front").sortBy("order"),
    []
  ) || [];
  const backCards = useLiveQuery(
    () => db.cards.where("face").equals("back").sortBy("order"),
    []
  ) || [];

  const pageOrientation = useSettingsStore((state) => state.pageOrientation);
  const pageSizeUnit = useSettingsStore((state) => state.pageSizeUnit);
  const pageWidth = useSettingsStore((state) => state.pageWidth);
  const pageHeight = useSettingsStore((state) => state.pageHeight);
  const columns = useSettingsStore((state) => state.columns);
  const rows = useSettingsStore((state) => state.rows);
  const bleedEdgeWidth = useSettingsStore((state) => state.bleedEdgeWidth);
  const bleedEdge = useSettingsStore((state) => state.bleedEdge);
  const guideColor = useSettingsStore((state) => state.guideColor);
  const guideWidth = useSettingsStore((state) => state.guideWidth);
  const cardSpacingMm = useSettingsStore((state) => state.cardSpacingMm);
  const cardPositionX = useSettingsStore((state) => state.cardPositionX);
  const cardPositionY = useSettingsStore((state) => state.cardPositionY);
  const dpi = useSettingsStore((state) => state.dpi);

  const setOnCancel = useLoadingStore((state) => state.setOnCancel);

  const handleCopyDecklist = async () => {
    const text = buildDecklist(allCards, { style: "withSetNum", sort: "alpha" });
    await navigator.clipboard.writeText(text);
  };

  const handleDownloadDecklist = () => {
    const text = buildDecklist(allCards, { style: "withSetNum", sort: "alpha" });
    const date = new Date().toISOString().slice(0, 10);
    downloadDecklist(`decklist_${date}.txt`, text);
  };

  /**
   * Build the card array for PDF export.
   * Front: sequential cards as-is.
   * Back: build array with nulls for empty grid cells.
   */
  function buildExportCards(face: "front" | "back"): (CardOption | null)[] {
    if (face === "front") {
      return frontCards;
    }

    // Back face: build a sparse array based on grid positions
    const pageCapacity = columns * rows;
    const maxBackIndex = backCards.length > 0
      ? Math.max(...backCards.map(c => c.order))
      : -1;
    const frontPageCount = Math.max(1, Math.ceil(frontCards.length / pageCapacity));
    const backPagesNeeded = Math.ceil((maxBackIndex + 1) / pageCapacity);
    const totalCells = Math.max(frontPageCount, backPagesNeeded) * pageCapacity;

    const backByIndex = new Map<number, CardOption>();
    for (const card of backCards) {
      backByIndex.set(card.order, card);
    }

    const result: (CardOption | null)[] = [];
    for (let i = 0; i < totalCells; i++) {
      result.push(backByIndex.get(i) ?? null);
    }
    return result;
  }

  const runExport = async (face: "front" | "back", label: LoadingTask) => {
    const exportCards = buildExportCards(face);
    if (!exportCards.length) return;

    const { exportProxyPagesToPdf } = await import(
      "@/helpers/ExportProxyPageToPdf"
    );

    const allImages = await db.images.toArray();
    const imagesById = new Map(allImages.map((img) => [img.id, img]));

    const pageWidthPx =
      pageSizeUnit === "in" ? pageWidth * dpi : (pageWidth / 25.4) * dpi;
    const pageHeightPx =
      pageSizeUnit === "in" ? pageHeight * dpi : (pageHeight / 25.4) * dpi;

    const MAX_PIXELS_PER_PDF_BATCH = 2_000_000_000;
    const pixelsPerPage = pageWidthPx * pageHeightPx;
    const autoPagesPerPdf = Math.floor(MAX_PIXELS_PER_PDF_BATCH / pixelsPerPage);
    const effectivePagesPerPdf = Math.max(1, autoPagesPerPdf);

    setLoadingTask(label);
    setProgress(0);

    let rejectPromise: (reason?: Error) => void;
    const cancellationPromise = new Promise<void>((_, reject) => {
      rejectPromise = reject;
    });

    const onCancel = () => {
      rejectPromise(new Error("Cancelled by user"));
    };
    setOnCancel(onCancel);

    try {
      await exportProxyPagesToPdf({
        cards: exportCards,
        imagesById,
        bleedEdge,
        bleedEdgeWidthMm: bleedEdgeWidth,
        guideColor,
        guideWidthPx: guideWidth,
        pageOrientation,
        pageSizeUnit,
        pageWidth,
        pageHeight,
        columns,
        rows,
        cardSpacingMm,
        cardPositionX,
        cardPositionY,
        dpi,
        onProgress: setProgress,
        pagesPerPdf: effectivePagesPerPdf,
        cancellationPromise,
        filenameSuffix: face,
      });
    } catch (err: unknown) {
      if (err instanceof Error && err.message !== "Cancelled by user") {
        console.error("Export failed:", err);
      }
    } finally {
      setLoadingTask(null);
      setOnCancel(null);
    }
  };

  const handleExportFront = () => runExport("front", "Generating Front PDF");
  const handleExportBack = () => runExport("back", "Generating Back PDF");
  const handleExportBoth = async () => {
    await runExport("front", "Generating Front PDF");
    await runExport("back", "Generating Back PDF");
  };

  async function handleExportZip() {
    setLoadingTask("Exporting ZIP");
    try {
      const { ExportImagesZip } = await import("@/helpers/ExportImagesZip");
      const allCardsArr = await db.cards.toArray();
      const allImages = await db.images.toArray();
      await ExportImagesZip({
        cards: allCardsArr,
        images: allImages,
      });
    } finally {
      setLoadingTask(null);
    }
  }

  return (
    <div className="flex flex-col gap-2">
      {backCards.length > 0 ? (
        <>
          <Button color="green" onClick={handleExportFront} disabled={!frontCards.length}>
            Export Front PDF
          </Button>
          <Button color="green" onClick={handleExportBack} disabled={!backCards.length}>
            Export Back PDF
          </Button>
          <Button color="teal" onClick={handleExportBoth} disabled={!frontCards.length && !backCards.length}>
            Export Both PDFs
          </Button>
        </>
      ) : (
        <Button color="green" onClick={handleExportFront} disabled={!frontCards.length}>
          Export to PDF
        </Button>
      )}

      <Button
        color="indigo"
        onClick={handleExportZip}
        disabled={!allCards.length}
      >
        Export Card Images (.zip)
      </Button>

      <Button color="cyan" onClick={handleCopyDecklist} disabled={!allCards.length}>
        Copy Decklist
      </Button>

      <Button
        color="blue"
        onClick={handleDownloadDecklist}
        disabled={!allCards.length}
      >
        Download Decklist (.txt)
      </Button>

      <a
        href="https://buymeacoffee.com/kaiserclipston"
        target="_blank"
        rel="noopener noreferrer"
      >
        <Button size="sm" className="bg-yellow-500 hover:bg-yellow-600 w-full">
          Buy Me a Coffee
        </Button>
      </a>
    </div>
  );
}
