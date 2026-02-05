import { changeCardArtwork } from "@/helpers/dbUtils";
import { useLiveQuery } from "dexie-react-hooks";
import axios from "axios";
import {
  Button,
  Checkbox,
  Label,
  Modal,
  ModalBody,
  ModalHeader,
  TextInput,
} from "flowbite-react";
import { useState, useEffect } from "react";
import { API_BASE } from "../constants";
import { db } from "../db";
import { useArtworkModalStore } from "../store";
import type { ScryfallCard } from "../types/Card";
import { ArrowLeft } from "lucide-react";

export function ArtworkModal() {
  const [isGettingMore, setIsGettingMore] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [setFilter, setSetFilter] = useState("");
  const [isSearchingSet, setIsSearchingSet] = useState(false);
  const [applyToAll, setApplyToAll] = useState(false);
  const [previewCardData, setPreviewCardData] = useState<ScryfallCard | null>(
    null
  );

  const isModalOpen = useArtworkModalStore((state) => state.open);
  const modalCard = useArtworkModalStore((state) => state.card);
  const closeModal = useArtworkModalStore((state) => state.closeModal);

  const [isFetchingArtworks, setIsFetchingArtworks] = useState(false);
  const [fetchedArtworks, setFetchedArtworks] = useState<string[] | null>(null);
  const [setSearchResults, setSetSearchResults] = useState<string[] | null>(null);

  // Reset local state when the modal is closed
  useEffect(() => {
    if (!isModalOpen) {
      setPreviewCardData(null);
      setSearchQuery("");
      setSetFilter("");
      setApplyToAll(false);
      setFetchedArtworks(null);
      setSetSearchResults(null);
    }
  }, [isModalOpen]);

  const imageObject =
    useLiveQuery(
      () => (modalCard?.imageId ? db.images.get(modalCard.imageId) : undefined),
      [modalCard?.imageId]
    ) || null;

  // Automatically fetch all unique artworks when modal opens
  useEffect(() => {
    if (!isModalOpen || !modalCard?.name || previewCardData) return;

    // Don't refetch if we already have multiple artworks cached
    if (imageObject?.imageUrls && imageObject.imageUrls.length > 1) {
      return;
    }

    const fetchArtworks = async () => {
      setIsFetchingArtworks(true);
      try {
        const res = await axios.post<ScryfallCard[]>(
          `${API_BASE}/api/cards/images`,
          { cardNames: [modalCard.name], cardArt: "art" }
        );
        const urls = res.data?.[0]?.imageUrls ?? [];
        if (urls.length > 0) {
          setFetchedArtworks(urls);
          // Also update the database so it's cached for next time
          if (imageObject?.id) {
            await db.images.update(imageObject.id, { imageUrls: urls });
          }
        }
      } catch (err) {
        console.error("Failed to fetch artworks:", err);
      } finally {
        setIsFetchingArtworks(false);
      }
    };

    fetchArtworks();
  }, [isModalOpen, modalCard?.name, imageObject?.id, imageObject?.imageUrls?.length, previewCardData]);

  const displayData = {
    name: previewCardData?.name || modalCard?.name,
    // Priority: set search results > preview card > fetched artworks > stored imageUrls
    imageUrls: setSearchResults || previewCardData?.imageUrls || fetchedArtworks || imageObject?.imageUrls,
    id: previewCardData?.imageUrls?.[0] || imageObject?.id,
  };

  // Search for specific set/collector number
  async function handleSetSearch() {
    const query = setFilter.trim().toLowerCase();
    if (!query || !modalCard?.name) return;

    setIsSearchingSet(true);
    setSetSearchResults(null);

    try {
      // Parse input - could be "cmm", "cmm 123", or just "123"
      let set: string | undefined;
      let number: string | undefined;

      const parts = query.split(/\s+/);
      if (parts.length === 2) {
        set = parts[0];
        number = parts[1];
      } else if (/^\d+[a-z]?$/i.test(query)) {
        // Just a collector number
        number = query;
      } else {
        // Just a set code
        set = query;
      }

      const res = await axios.post<ScryfallCard[]>(
        `${API_BASE}/api/cards/images`,
        {
          cardQueries: [{
            name: modalCard.name,
            set,
            number,
          }],
          cardArt: "prints",
          strictSet: true, // Don't fall back to all prints if set search fails
        }
      );

      const urls = res.data?.[0]?.imageUrls ?? [];
      if (urls.length > 0) {
        setSetSearchResults(urls);
      } else {
        alert(`No results found for "${query}"`);
      }
    } catch (err) {
      console.error("Set search failed:", err);
      alert("Search failed. Please try again.");
    } finally {
      setIsSearchingSet(false);
    }
  }

  function clearSetSearch() {
    setSetFilter("");
    setSetSearchResults(null);
  }

  async function getMorePrints() {
    if (!displayData.name || !displayData.id) return;
    setIsGettingMore(true);
    try {
      const res = await axios.post<ScryfallCard[]>(
        `${API_BASE}/api/cards/images`,
        { cardNames: [displayData.name], cardArt: "prints" }
      );

      const urls = res.data?.[0]?.imageUrls ?? [];
      if (previewCardData) {
        setPreviewCardData({ ...previewCardData, imageUrls: urls });
      } else {
        await db.images.update(displayData.id, { imageUrls: urls });
      }
    } finally {
      setIsGettingMore(false);
    }
  }

  async function handleSelectArtwork(newImageUrl: string) {
    if (!modalCard) return;

    const isReplacing = !!previewCardData;
    const newImageId = newImageUrl.includes("scryfall") ? newImageUrl.split("?")[0] : newImageUrl.split("id=")[1];

    await changeCardArtwork(
      modalCard.imageId || "",
      newImageId,
      modalCard,
      applyToAll,
      isReplacing ? previewCardData.name : undefined
    );

    closeModal();
  }

  async function handleSearch() {
    const name = searchQuery.trim();
    if (!name) return;

    const res = await axios.post<ScryfallCard[]>(
      `${API_BASE}/api/cards/images`,
      { cardNames: [name] }
    );

    const newCardData = res.data?.[0];
    if (newCardData) {
      setPreviewCardData(newCardData);
    }
  }

  return (
    <Modal show={isModalOpen} onClose={closeModal} size="4xl">
      <ModalHeader>
        {previewCardData && (
          <Button
            size="xs"
            className="mr-2"
            onClick={() => setPreviewCardData(null)}
          >
            <ArrowLeft className="size-4" />
          </Button>
        )}
        Select Artwork for {displayData.name}
      </ModalHeader>
      <ModalBody>
        <div className="sticky top-0 z-10 bg-white dark:bg-gray-700 py-4 space-y-3">
          {/* Set/Number filter for current card */}
          <div className="flex gap-2">
            <TextInput
              className="flex-grow"
              type="text"
              placeholder="Filter by set or number (e.g., cmm, 368, or cmm 420)"
              value={setFilter}
              onChange={(e) => setSetFilter(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  e.stopPropagation();
                  handleSetSearch();
                }
              }}
            />
            <Button onClick={handleSetSearch} disabled={isSearchingSet}>
              {isSearchingSet ? "..." : "Filter"}
            </Button>
            {setSearchResults && (
              <Button color="gray" onClick={clearSetSearch}>
                Clear
              </Button>
            )}
          </div>

          {/* Search for different card */}
          <div className="flex gap-2">
            <TextInput
              className="flex-grow"
              type="text"
              placeholder="Or search for a different card..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  e.stopPropagation();
                  handleSearch();
                }
              }}
            />
            <Button color="gray" onClick={handleSearch}>Search</Button>
          </div>

          {modalCard && (
            <div className="flex items-center gap-2">
              <Checkbox
                id="apply-to-all"
                checked={applyToAll}
                onChange={(e) => setApplyToAll(e.target.checked)}
              />
              <Label htmlFor="apply-to-all">
                Apply to all cards named "{modalCard?.name}"
              </Label>
            </div>
          )}
        </div>

        {modalCard && (
          <>
            {(isFetchingArtworks || isSearchingSet) ? (
              <div className="flex flex-col items-center justify-center py-12">
                <div className="h-10 w-10 animate-spin rounded-full border-4 border-blue-500 border-t-transparent mb-4" />
                <p className="text-gray-600 dark:text-gray-300">
                  {isSearchingSet ? "Searching..." : "Loading artworks..."}
                </p>
              </div>
            ) : (
              <>
                {setSearchResults && (
                  <p className="text-sm text-gray-500 dark:text-gray-400 mb-2">
                    Showing {setSearchResults.length} result{setSearchResults.length !== 1 ? "s" : ""} for "{setFilter}"
                  </p>
                )}
                <div className="grid grid-cols-3 md:grid-cols-3 gap-4 max-h-[60vh] overflow-y-auto pt-2">
                  {(displayData.imageUrls ?? []).map((pngUrl, i) => (
                    <img
                      key={i}
                      src={pngUrl}
                      loading="lazy"
                      className={`w-full cursor-pointer border-4 rounded ${
                        displayData.id === pngUrl
                          ? "border-green-500"
                          : "border-transparent hover:border-gray-300"
                      }`}
                      onClick={() => handleSelectArtwork(pngUrl)}
                    />
                  ))}
                </div>
              </>
            )}

            {!setSearchResults && (
              <Button
                className="w-full mt-4"
                color="gray"
                onClick={getMorePrints}
                disabled={isGettingMore || isFetchingArtworks}
              >
                {isGettingMore ? "Loading all prints..." : "Show All Prints (every set)"}
              </Button>
            )}
          </>
        )}
      </ModalBody>
    </Modal>
  );
}
