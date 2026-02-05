export type CardInfo = {
  name: string;
  set?: string;
  number?: string;
  backFaceName?: string;
};

export type CardInfoWithQuantity = {
  info: CardInfo;
  quantity: number;
};

export function extractCardInfo(input: string): CardInfo {
  let s = input.trim();

  s = s.replace(/^\s*\d+\s*x?\s+/i, "");

  const caretTail = /\s*\^[^^]*\^\s*$/;
  const bracketTail = /\s*\[[^\]]*]\s*$/;
  let changed = true;
  while (changed) {
    const before = s;
    s = s.replace(caretTail, "").trim();
    s = s.replace(bracketTail, "").trim();
    changed = s !== before;
  }

  let setCode: string | undefined;
  let number: string | undefined;
  const setNumTail = /\s*\(([a-z0-9]{2,5})\)\s*([0-9]+[a-z]?)?\s*$/i;
  const m = s.match(setNumTail);
  if (m) {
    setCode = m[1]?.toLowerCase();
    number = m[2] ?? undefined;
    s = s.replace(setNumTail, "").trim();
  }

  // Handle double-faced cards: "Front Face // Back Face"
  let backFaceName: string | undefined;
  const dfcSplit = s.indexOf(" // ");
  if (dfcSplit !== -1) {
    backFaceName = s.slice(dfcSplit + 4).trim();
    s = s.slice(0, dfcSplit).trim();
  }

  return { name: s, set: setCode, number, backFaceName };
}

export function parseDeckToInfos(deckText: string): CardInfoWithQuantity[] {
  const infos: CardInfoWithQuantity[] = [];
  deckText.split(/\r?\n/).forEach((line) => {
    const trimmed = line.trim();
    if (!trimmed) return;

    const qtyMatch = trimmed.match(/^\s*(\d+)\s*x?\s+(.*)$/i);
    if (qtyMatch) {
      const count = parseInt(qtyMatch[1], 10);
      const rest = qtyMatch[2];
      const info = extractCardInfo(rest);
      infos.push({ info, quantity: count });
    } else {
      infos.push({ info: extractCardInfo(trimmed), quantity: 1 });
    }
  });
  return infos;
}

export function cardKey(ci: CardInfo): string {
  return `${ci.name.toLowerCase()}|${ci.set ?? ""}|${ci.number ?? ""}`;
}
