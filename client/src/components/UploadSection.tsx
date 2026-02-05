import React, { useRef, useState } from "react";
import { db } from "../db";
import fullLogo from "@/assets/fullLogo.png";
import { API_BASE, LANGUAGE_OPTIONS } from "@/constants";
import {
  cardKey,
  parseDeckToInfos,
  type CardInfo,
} from "@/helpers/CardInfoHelper";
import {
  getMpcImageUrl,
  inferCardNameFromFilename,
  parseMpcText,
  tryParseMpcSchemaXml,
} from "@/helpers/Mpc";
import { useCardsStore, useLoadingStore, useSettingsStore } from "@/store";
import type { CardOption } from "@/types/Card";
import axios from "axios";
import { addCards, addCustomImage, addRemoteImage } from "@/helpers/dbUtils";
import {
  Button,
  HelperText,
  HR,
  List,
  ListItem,
  Select,
  Textarea,
  Tooltip,
} from "flowbite-react";
import { ExternalLink, HelpCircle } from "lucide-react";

async function readText(file: File): Promise<string> {
  return new Promise((resolve) => {
    const r = new FileReader();
    r.onloadend = () => resolve(String(r.result || ""));
    r.readAsText(file);
  });
}

export function UploadSection() {
  const [deckText, setDeckText] = useState("");
  const fetchController = useRef<AbortController | null>(null);

  const setLoadingTask = useLoadingStore((state) => state.setLoadingTask);

  const globalLanguage = useSettingsStore((s) => s.globalLanguage ?? "en");
  const setGlobalLanguage = useSettingsStore(
    (s) => s.setGlobalLanguage ?? (() => {})
  );

  async function addUploadedFiles(
    files: FileList,
    opts: { hasBakedBleed: boolean }
  ) {
    const fileArray = Array.from(files);

    const cardsToAdd: Array<
      Omit<CardOption, "uuid" | "order" | "face"> & { imageId: string; face?: "front" | "back" }
    > = [];

    for (const file of fileArray) {
      const imageId = await addCustomImage(file);
      cardsToAdd.push({
        name: inferCardNameFromFilename(file.name) || `Custom Art`,
        imageId: imageId,
        isUserUpload: true,
        hasBakedBleed: opts.hasBakedBleed,
      });
    }

    if (cardsToAdd.length > 0) {
      await addCards(cardsToAdd);
    }
  }

  const handleUploadMpcFill = async (
    e: React.ChangeEvent<HTMLInputElement>
  ) => {
    setLoadingTask("Uploading Images");

    try {
      const files = e.target.files;
      if (files && files.length) {
        await addUploadedFiles(files, { hasBakedBleed: true });
      }
    } finally {
      if (e.target) e.target.value = "";

      setLoadingTask(null);
    }
  };

  const handleUploadStandard = async (
    e: React.ChangeEvent<HTMLInputElement>
  ) => {
    setLoadingTask("Uploading Images");
    try {
      const files = e.target.files;
      if (files && files.length) {
        await addUploadedFiles(files, { hasBakedBleed: false });
      }
    } finally {
      if (e.target) e.target.value = "";
      setLoadingTask(null);
    }
  };

  const handleImportMpcXml = async (e: React.ChangeEvent<HTMLInputElement>) => {
    try {
      const file = e.target.files?.[0];
      if (!file) return;

      const raw = await readText(file);
      const schemaItems = tryParseMpcSchemaXml(raw);
      const items =
        schemaItems && schemaItems.length ? schemaItems : parseMpcText(raw);

      const cardsToAdd: Array<
        Omit<CardOption, "uuid" | "order" | "face"> & { imageId?: string; face?: "front" | "back" }
      > = [];

      for (const it of items) {
        for (let i = 0; i < (it.qty || 1); i++) {
          const name =
            it.name ||
            (it.filename
              ? inferCardNameFromFilename(it.filename)
              : "Custom Art");

          const mpcUrl = getMpcImageUrl(it.frontId);
          const imageUrls = mpcUrl ? [mpcUrl] : [];
          const imageId = await addRemoteImage(imageUrls);
          cardsToAdd.push({
            name,
            imageId: imageId,
            isUserUpload: true,
            hasBakedBleed: true,
          });
        }
      }

      if (cardsToAdd.length > 0) {
        await addCards(cardsToAdd);
      }
    } finally {
      if (e.target) e.target.value = "";
    }
  };

  const handleSubmit = async () => {
    if (fetchController.current) {
      fetchController.current.abort();
    }
    fetchController.current = new AbortController();

    try {
      const rawInfos = parseDeckToInfos(deckText || "");
      if (!rawInfos.length) return;

      // Partition: DFCs first, then non-DFCs
      const dfcEntries = rawInfos.filter((e) => e.info.backFaceName);
      const nonDfcEntries = rawInfos.filter((e) => !e.info.backFaceName);
      const infos = [...dfcEntries, ...nonDfcEntries];

      setLoadingTask("Fetching cards");

      // Deduplicate queries while preserving quantity info
      const uniqueMap = new Map<string, CardInfo>();
      for (const { info } of infos) uniqueMap.set(cardKey(info), info);
      const uniqueInfos = Array.from(uniqueMap.values());

      // Use new Collection API endpoint
      const response = await axios.post<{
        results: Array<{
          name: string;
          set?: string;
          number?: string;
          imageUrl: string | null;
          backImageUrl?: string | null;
          found: boolean;
        }>;
        notFound: Array<{ name: string; set?: string; number?: string }>;
      }>(
        `${API_BASE}/api/cards/images/collection`,
        { cardQueries: uniqueInfos },
        { signal: fetchController.current.signal }
      );

      const { results, notFound } = response.data;

      // Build lookup map from results
      const resultByKey: Record<string, (typeof results)[0]> = {};
      for (const result of results) {
        const k = cardKey({
          name: result.name,
          set: result.set,
          number: result.number,
        });
        resultByKey[k] = result;
        // Also store by name-only for fallback matching
        const nameOnlyKey = cardKey({ name: result.name });
        if (!resultByKey[nameOnlyKey]) resultByKey[nameOnlyKey] = result;

        // DFC: also key by front face name so stripped queries can match
        const dfcSplit = result.name.indexOf(" // ");
        if (dfcSplit !== -1) {
          const frontName = result.name.slice(0, dfcSplit).trim();
          const frontKey = cardKey({ name: frontName, set: result.set, number: result.number });
          if (!resultByKey[frontKey]) resultByKey[frontKey] = result;
          const frontNameOnly = cardKey({ name: frontName });
          if (!resultByKey[frontNameOnly]) resultByKey[frontNameOnly] = result;
        }
      }

      // Build front cards to add, respecting quantities from original decklist
      const frontCardsToAdd: (Omit<CardOption, "uuid" | "order" | "face"> & {
        imageId?: string;
        face?: "front" | "back";
      })[] = [];

      // Track DFC back faces to add after front cards (so we know the grid positions)
      const backFaceEntries: Array<{
        backImageUrl: string;
        name: string;
        set?: string;
        number?: string;
        quantity: number;
      }> = [];

      for (const { info, quantity } of infos) {
        const k = cardKey(info);
        const fallbackK = cardKey({ name: info.name });
        const result = resultByKey[k] ?? resultByKey[fallbackK];

        const imageUrl = result?.imageUrl;
        const imageId = imageUrl ? await addRemoteImage([imageUrl], quantity) : undefined;

        for (let i = 0; i < quantity; i++) {
          frontCardsToAdd.push({
            name: result?.name || info.name,
            set: result?.set,
            number: result?.number,
            isUserUpload: false,
            imageId: imageId,
            face: "front",
          });
        }

        // Collect DFC back face info
        if (result?.backImageUrl) {
          backFaceEntries.push({
            backImageUrl: result.backImageUrl,
            name: result.name,
            set: result.set,
            number: result.number,
            quantity,
          });
        }
      }

      if (frontCardsToAdd.length > 0) {
        await addCards(frontCardsToAdd);
      }

      // Create back-face cards for DFCs, positioned to match front card grid positions
      if (backFaceEntries.length > 0) {
        // Get all front cards (ordered) to determine the sequential position of newly added cards
        const allFrontCards = await db.cards.where("face").equals("front").sortBy("order");
        // The newly added front cards start at this index
        const newFrontStartIdx = allFrontCards.length - frontCardsToAdd.length;

        // Walk through infos in the same order as front cards were added
        // to determine which sequential grid position each DFC front occupies
        let frontOffset = 0;
        for (const { info, quantity } of infos) {
          const k = cardKey(info);
          const fallbackK = cardKey({ name: info.name });
          const result = resultByKey[k] ?? resultByKey[fallbackK];

          if (result?.backImageUrl) {
            const backImageId = await addRemoteImage([result.backImageUrl], quantity);
            const dfcSplit = result.name?.indexOf(" // ") ?? -1;
            const backName = dfcSplit !== -1 ? result.name.slice(dfcSplit + 4).trim() : result.name;

            for (let i = 0; i < quantity; i++) {
              // This DFC front card is at sequential position (newFrontStartIdx + frontOffset)
              // Place the back card at the same grid cell index
              const gridPosition = newFrontStartIdx + frontOffset;

              const backCard = {
                name: backName,
                set: result.set,
                number: result.number,
                isUserUpload: false,
                imageId: backImageId,
                face: "back" as const,
              };

              // Add back card then immediately set its order to the absolute grid position
              await addCards([backCard]);
              const lastBack = await db.cards.where("face").equals("back").reverse().sortBy("order");
              if (lastBack.length > 0) {
                await db.cards.update(lastBack[0].uuid, { order: gridPosition });
              }

              frontOffset++;
            }
          } else {
            frontOffset += quantity;
          }
        }
      }

      // Warn user about cards that couldn't be found
      if (notFound.length > 0) {
        const notFoundNames = notFound.map((c) => c.name).join(", ");
        console.warn("[FetchCards] Cards not found:", notFoundNames);
        alert(
          `Some cards could not be found: ${notFoundNames}\n\nThey were added without images.`
        );
      }

      setDeckText("");
    } catch (err: unknown) {
      if (err instanceof Error) {
        if (err.name !== "AbortError" && err.name !== "CanceledError") {
          console.error("[FetchCards] Error:", err);
          alert(err.message || "Something went wrong while fetching cards.");
        }
      } else {
        console.error("[FetchCards] Unknown Error:", err);
        alert("An unknown error occurred while fetching cards.");
      }
    } finally {
      setLoadingTask(null);
      fetchController.current = null;
    }
  };

  const clearAllCardsAndImages = useCardsStore(
    (state) => state.clearAllCardsAndImages
  );

  const [showClearConfirmModal, setShowClearConfirmModal] = useState(false);

  const handleClear = async () => {
    const count = await db.cards.count();
    if (count === 0) {
      await confirmClear();
      setShowClearConfirmModal(false);
    } else {
      setShowClearConfirmModal(true);
    }
  };

  const confirmClear = async () => {
    setLoadingTask("Clearing Images");

    try {
      await clearAllCardsAndImages();
      // The server cache clear is now handled by the clearAllCardsAndImages action if needed
      // or can be removed if the server cache is no longer relevant for client-side clear.
      // For now, we'll keep the server call as it might be clearing other things.
      try {
        await axios.delete(`${API_BASE}/api/cards/images`, {
          timeout: 15000,
        });
      } catch (e) {
        console.warn(
          "[Clear] Server cache clear failed (UI already cleared):",
          e
        );
      }
    } catch (err: unknown) {
      console.error("[Clear] Error:", err);
      if (err instanceof Error) {
        alert(err.message || "Failed to clear images.");
      } else {
        alert("An unknown error occurred while clearing images.");
      }
    } finally {
      setLoadingTask(null);
      setShowClearConfirmModal(false);
    }
  };

  return (
    <div className="w-1/5 dark:bg-gray-700 bg-gray-100 flex flex-col">
      <img src={fullLogo} alt="Proxxied Logo" />

      <div className="flex-1 flex flex-col overflow-y-auto gap-6 px-4 pb-4">
        <div className="flex flex-col gap-4">
          <div className="space-y-1">
            <h6 className="font-medium dark:text-white">
              Upload MPC Images (
              <a
                href="https://mpcfill.com"
                target="_blank"
                rel="noreferrer"
                className="underline hover:text-blue-600 dark:hover:text-blue-400"
              >
                MPC Autofill
                <ExternalLink className="inline-block size-4 ml-1" />
              </a>
              )
            </h6>

            <label
              htmlFor="upload-mpc"
              className="inline-block w-full text-center cursor-pointer rounded-md bg-gray-300 dark:bg-gray-600 px-4 py-2 text-sm font-medium text-gray-900 dark:text-white hover:bg-gray-300 dark:hover:bg-gray-500"
            >
              Choose Files
            </label>
            <input
              id="upload-mpc"
              type="file"
              accept="image/*"
              multiple
              onChange={handleUploadMpcFill}
              onClick={(e) => ((e.target as HTMLInputElement).value = "")}
              className="hidden"
            />
          </div>

          <div className="space-y-1">
            <h6 className="font-medium dark:text-white">
              Import MPC Text (XML)
            </h6>

            <label
              htmlFor="import-mpc-xml"
              className="inline-block w-full text-center cursor-pointer rounded-md bg-gray-300 dark:bg-gray-600 px-4 py-2 text-sm font-medium text-gray-900 dark:text-white hover:bg-gray-300 dark:hover:bg-gray-500"
            >
              Choose File
            </label>
            <input
              id="import-mpc-xml"
              type="file"
              accept=".xml,.txt,.csv,.log,text/xml,text/plain"
              onChange={handleImportMpcXml}
              onClick={(e) => ((e.target as HTMLInputElement).value = "")}
              className="hidden"
            />
          </div>

          <div className="space-y-1">
            <h6 className="font-medium dark:text-white">Upload Other Images</h6>
            <label
              htmlFor="upload-standard"
              className="inline-block w-full text-center cursor-pointer rounded-md bg-gray-300 dark:bg-gray-600 px-4 py-2 text-sm font-medium text-gray-900 dark:text-white hover:bg-gray-300 dark:hover:bg-gray-500"
            >
              Choose Files
            </label>
            <input
              id="upload-standard"
              type="file"
              accept="image/*"
              multiple
              onChange={handleUploadStandard}
              onClick={(e) => ((e.target as HTMLInputElement).value = "")}
              className="hidden"
            />
            <HelperText>
              You can upload images from mtgcardsmith, custom designs, etc.
            </HelperText>
          </div>
        </div>

        <HR className="my-0 dark:bg-gray-500" />

        <div className="space-y-4">
          <div className="space-y-1">
            <h6 className="font-medium dark:text-white">
              Add Cards (
              <a
                href="https://scryfall.com"
                target="_blank"
                rel="noopener noreferrer"
                className="underline hover:text-blue-600 dark:hover:text-blue-400"
              >
                Scryfall
                <ExternalLink className="inline-block size-4 ml-1" />
              </a>
              )
            </h6>

            <Textarea
              className="h-64"
              placeholder={`1x Sol Ring\n2x Counterspell\nFor specific art include set / CN\neg. Strionic Resonator (lcc)\nor Repurposing Bay (dft) 380`}
              value={deckText}
              onChange={(e) => setDeckText(e.target.value)}
            />
          </div>

          <div className="flex flex-col gap-2">
            <Button color="blue" onClick={handleSubmit}>
              Fetch Cards
            </Button>
            <Button color="red" onClick={handleClear}>
              Clear Cards
            </Button>
          </div>

          <div className="space-y-1">
            <div className="flex items-center justify-between">
              <h6 className="font-medium dark:text-white">Language</h6>
              <Tooltip content="Used for Scryfall lookups">
                <HelpCircle className="w-4 h-4 text-gray-400 hover:text-gray-500 dark:text-gray-500 dark:hover:text-gray-400 cursor-pointer" />
              </Tooltip>
            </div>

            <Select
              className="w-full rounded-md bg-gray-300 dark:bg-gray-600 my-2 text-sm text-gray-900 dark:text-white hover:bg-gray-300 dark:hover:bg-gray-500"
              value={globalLanguage}
              onChange={(e) => setGlobalLanguage(e.target.value)}
            >
              {LANGUAGE_OPTIONS.map((o) => (
                <option key={o.code} value={o.code}>
                  {o.label}
                </option>
              ))}
            </Select>
          </div>

          <div>
            <h6 className="font-medium dark:text-white">Tips:</h6>

            <List className="text-sm dark:text-white/60">
              <ListItem>To change a card art - click it</ListItem>
              <ListItem>
                To move a card - drag from the box at the top right
              </ListItem>
              <ListItem>
                To duplicate or delete a card - right click it
              </ListItem>
            </List>
          </div>
        </div>

        <HR className="my-0 dark:bg-gray-500" />
      </div>

      {showClearConfirmModal && (
        <div className="fixed inset-0 z-50 bg-gray-900/50 flex items-center justify-center">
          <div className="bg-white dark:bg-gray-800 p-6 rounded shadow-md w-96 text-center">
            <div className="mb-4 text-lg font-semibold text-gray-800 dark:text-white">
              Confirm Clear Cards
            </div>
            <div className="mb-5 text-lg font-normal text-gray-500 dark:text-gray-400">
              Are you sure you want to clear all cards? This action cannot be
              undone.
            </div>
            <div className="flex justify-center gap-4">
              <Button
                color="failure"
                className="bg-red-600 hover:bg-red-700 text-white"
                onClick={confirmClear}
              >
                Yes, I'm sure
              </Button>
              <Button
                color="gray"
                onClick={() => setShowClearConfirmModal(false)}
              >
                No, cancel
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
