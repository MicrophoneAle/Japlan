// Dietary restrictions as filters, not weights. The survey records what the
// restriction is (dietary_detail); food tasks are rejected only when they
// involve it, instead of every food task vanishing for anyone who said "yes".
//
// Two ways a food task can clash:
//  - it names the thing, or a dish known to contain it ("eat takoyaki" for a
//    shellfish or fish allergy);
//  - it is blind: the player cannot choose what arrives ("order something you
//    cannot read", "order what the person next to you ordered"). Nobody with
//    a real restriction gets those.
// A restriction we cannot read fails closed: no food tasks at all, as before.

export type DietKey =
  | "shellfish"
  | "fish"
  | "peanut"
  | "tree_nut"
  | "dairy"
  | "egg"
  | "gluten"
  | "soy"
  | "sesame"
  | "pork"
  | "beef"
  | "meat"
  | "animal";

// What people write, to what it restricts. Order does not matter; every
// match adds its keys.
const NAMES: [RegExp, DietKey[]][] = [
  [/\bshell ?fish|shrimp|prawn|crab|lobster|crustacean|mollusc|oyster|clam|scallop/, ["shellfish"]],
  [/\bseafood\b/, ["shellfish", "fish"]],
  [/\bfish\b|\bpescat/, ["fish"]],
  [/peanut/, ["peanut"]],
  [/\bnuts?\b|tree ?nut|almond|walnut|cashew|pistachio|hazelnut/, ["tree_nut", "peanut"]],
  [/dairy|lactose|\bmilk\b|cheese|butter/, ["dairy"]],
  [/\beggs?\b/, ["egg"]],
  [/gluten|wheat|coeliac|celiac/, ["gluten"]],
  [/\bsoy|soya\b/, ["soy"]],
  [/sesame/, ["sesame"]],
  [/\bpork\b|\bpig\b|halal/, ["pork"]],
  [/kosher/, ["pork", "shellfish"]],
  [/\bbeef\b|\bcow\b/, ["beef"]],
  [/vegetarian|veggie|no meat|don'?t eat meat/, ["meat"]],
  [/vegan|plant.?based/, ["meat", "animal"]],
];

// What a task title has to mention to involve each key: the ingredient, or
// dishes where it is standard. Japanese stock (dashi) is fish.
const TRIGGERS: Record<DietKey, RegExp> = {
  shellfish: /shell ?fish|shrimp|prawn|crab|lobster|oyster|clam|scallop|mussel|seafood|\bebi\b|kani|takoyaki|octopus|squid|ika\b|kaisen/,
  fish: /\bfish|seafood|sushi|sashimi|tuna|salmon|\beel\b|unagi|bonito|dashi|katsuobushi|takoyaki|okonomiyaki|ramen|udon|soba|miso|onigiri|kaisen/,
  peanut: /peanut|satay/,
  tree_nut: /\bnuts?\b|almond|walnut|cashew|pistachio|hazelnut|praline|marzipan/,
  dairy: /\bmilk|cheese|butter|cream|latte|dairy|yogh?urt|gelato|crepe|parfait|pudding|custard/,
  egg: /\beggs?\b|omelet|tamago|omurice|mayo|custard|pudding|okonomiyaki|ramen|tempura|taiyaki|castella/,
  gluten: /wheat|bread|noodle|ramen|udon|soba|pasta|pizza|\bbeer|tempura|gyoza|okonomiyaki|monjayaki|takoyaki|taiyaki|pastry|cake|tonkatsu|katsu|karaage|\bbun\b|dumpling|melon ?pan|castella/,
  soy: /\bsoy|tofu|miso|edamame|natto|teriyaki|shoyu|ramen|yakitori|onigiri|udon|soba/,
  sesame: /sesame|tahini|goma/,
  pork: /\bpork|bacon|\bham\b|tonkatsu|chashu|gyoza|tonkotsu|ramen|katsu|sausage|salami|char siu|buta/,
  beef: /\bbeef|steak|wagyu|burger|gyudon|sukiyaki|yakiniku|shabu/,
  meat: /\bmeat|pork|beef|chicken|lamb|duck|bacon|\bham\b|steak|wagyu|burger|yakitori|karaage|tonkatsu|katsu|gyoza|gyudon|sukiyaki|yakiniku|shabu|ramen|chashu|sausage|fish|seafood|sushi|sashimi|takoyaki|okonomiyaki|monjayaki|dashi|eel|unagi|kaisen/,
  animal: /\beggs?\b|omelet|tamago|milk|cheese|butter|cream|latte|dairy|honey|taiyaki|crepe|pudding|custard|parfait|gelato/,
};

// Food the player does not choose. Also checked on titles, for model tasks.
const BLIND_FOOD_RE =
  /cannot read|can'?t read|unidentif|mystery|surprise|what (?:the person|they|someone|the staff)[^.]* (?:ordered|order|would order|recommend)|whatever (?:they|the)|omakase|chef'?s choice/;

export function parseDiet(text: string | undefined | null): { keys: DietKey[]; understood: boolean } {
  const lower = (text ?? "").toLowerCase();
  const keys = new Set<DietKey>();
  for (const [re, found] of NAMES) {
    if (re.test(lower)) for (const key of found) keys.add(key);
  }
  return { keys: [...keys], understood: keys.size > 0 };
}

export function isBlindFood(title: string, blindTemplate = false): boolean {
  return blindTemplate || BLIND_FOOD_RE.test(title.toLowerCase());
}

// Which restriction keys a title runs into.
export function dietClashes(title: string, keys: DietKey[]): DietKey[] {
  const lower = title.toLowerCase();
  return keys.filter((key) => TRIGGERS[key].test(lower));
}
