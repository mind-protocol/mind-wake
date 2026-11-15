import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

const MAX_AGE_MS = 120_000;

export function cityBrief(attempt, now = Date.now()) {
  const sample = attempt?.status === "received" ? attempt.sample : attempt;
  const value = sample?.value;
  const received = Date.parse(sample?.receivedAt);
  if (sample?.schema !== "mind.civ7.fixed-local-city-read.v1"
    || value?.error !== null || !Number.isSafeInteger(value.turn)
    || !Number.isSafeInteger(value.player) || !Number.isSafeInteger(value.city?.id)
    || !Number.isFinite(received) || received > now) {
    return { status: "unavailable", text: "Aucun relevé de ville exploitable." };
  }

  const { city } = value;
  const stale = now - received > MAX_AGE_MS;
  const name = typeof city.name === "string" && !city.name.startsWith("LOC_")
    ? city.name : `Ville ${city.id}`;
  const growth = Number.isSafeInteger(city.turnsUntilGrowth) && city.turnsUntilGrowth >= 0
    ? `Croissance dans ${city.turnsUntilGrowth} tour(s).` : "Délai de croissance inconnu.";
  const food = Number.isFinite(city.foodSurplus)
    ? `Surplus alimentaire : ${city.foodSurplus}.` : "Surplus alimentaire inconnu.";

  return {
    status: stale ? "stale" : "fresh",
    turn: value.turn,
    player: value.player,
    cityId: city.id,
    receivedAt: sample.receivedAt,
    text: `${stale ? "Relevé ancien. " : ""}Tour ${value.turn} · ${name}. ${growth} ${food}`,
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const file = process.argv[2];
  try {
    if (!file) throw new Error("Usage: node tools/civ7/city-brief.mjs <city-snapshot.json>");
    console.log(JSON.stringify(cityBrief(JSON.parse(readFileSync(file, "utf8").replace(/^\uFEFF/, ""))), null, 2));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
