// Mochi's wardrobe: the outfit ids, their names, and the seasonal "Auto" pick.
// Pure data and date maths (no canvas), so it runs anywhere. Port of
// NotchBuddy/Sources/CoucouKit/MochiWardrobe.swift, with the Australian summer.

export const OUTFIT_IDS = [
  "none", "partyHat", "beanie", "crown", "sunglasses", "roundGlasses",
  "bow", "scarf", "witchHat", "pumpkin", "santaHat", "bunnyEars",
] as const;

/** An outfit that is actually worn (everything but none/auto). */
export type OutfitName = Exclude<(typeof OUTFIT_IDS)[number], "none">;
export type OutfitId = (typeof OUTFIT_IDS)[number];
export type OutfitSelection = OutfitId | "auto";

export const OUTFIT_NAMES: Record<OutfitSelection, string> = {
  auto: "Auto (seasons)",
  none: "None",
  partyHat: "Party hat",
  beanie: "Beanie",
  crown: "Crown",
  sunglasses: "Sunglasses",
  roundGlasses: "Round glasses",
  bow: "Bow",
  scarf: "Scarf",
  witchHat: "Witch hat",
  pumpkin: "Pumpkin",
  santaHat: "Santa hat",
  bunnyEars: "Bunny ears",
};

/** Picker order, same as the Mac app's CaseIterable order. */
export const OUTFIT_PICKER_ORDER: OutfitSelection[] = [
  "auto", "none", "partyHat", "beanie", "crown", "sunglasses", "roundGlasses",
  "bow", "scarf", "witchHat", "pumpkin", "santaHat", "bunnyEars",
];

export function isOutfitName(v: unknown): v is OutfitName {
  return typeof v === "string" && v !== "none" && (OUTFIT_IDS as readonly string[]).includes(v);
}

/** Unknown value reads as "auto". */
export function parseOutfitSelection(v: unknown): OutfitSelection {
  return typeof v === "string" && (v === "auto" || (OUTFIT_IDS as readonly string[]).includes(v))
    ? (v as OutfitSelection)
    : "auto";
}

/** Meeus/Jones/Butcher: month (1-12) and day of Easter Sunday. */
export function easterDate(year: number): [number, number] {
  const a = year % 19;
  const b = Math.floor(year / 100);
  const c = year % 100;
  const d = Math.floor(b / 4);
  const e = b % 4;
  const f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4);
  const k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31);
  const day = ((h + l - 7 * m + 114) % 31) + 1;
  return [month, day];
}

/**
 * The seasonal outfit for a local date (Australian version).
 * Priority: partyHat > santaHat > witchHat > bunnyEars > sunglasses (Dec 1 - Feb 28/29) > none.
 */
export function seasonalOutfit(date: Date): OutfitId {
  const day = date.getDate();
  const month = date.getMonth() + 1;
  const year = date.getFullYear();

  if ((month === 12 && day === 31) || (month === 1 && day <= 2)) return "partyHat";
  if (month === 12 && day <= 26) return "santaHat";
  if (month === 10 || (month === 11 && day === 1)) return "witchHat";

  // Easter -2 .. +1 days. Whole days by UTC arithmetic on the local y/m/d, so DST can't skew it.
  const [em, ed] = easterDate(year);
  const delta = Math.round((Date.UTC(year, month - 1, day) - Date.UTC(year, em - 1, ed)) / 86_400_000);
  if (delta >= -2 && delta <= 1) return "bunnyEars";

  // Australian summer: Dec 1 to the end of February.
  if (month === 12 || month === 1 || month === 2) return "sunglasses";

  return "none";
}

export function resolveOutfit(selection: OutfitSelection, date: Date): OutfitId {
  return selection === "auto" ? seasonalOutfit(date) : selection;
}

// ── Current choice (the island and every mini bot read this) ──────────────────

let selection: OutfitSelection = "auto";
let cacheKey = "";
let cacheVal: OutfitName | null = null;

export function setOutfitSelection(v: unknown) {
  selection = parseOutfitSelection(v);
  cacheKey = "";
}

/**
 * The outfit to wear right now, or null for none. Cached per selection and local
 * day, so calling it every frame is cheap and a date change applies at the next
 * frame after the island opens (no timer needed while hidden).
 */
export function currentOutfit(): OutfitName | null {
  const d = new Date();
  const key = `${selection}|${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
  if (key !== cacheKey) {
    cacheKey = key;
    const id = resolveOutfit(selection, d);
    cacheVal = id === "none" ? null : id;
  }
  return cacheVal;
}
