import express from "express";
import fs from "fs/promises";
import "dotenv/config";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = process.env.PORT || 5179;
const RIOT_API_KEY = process.env.RIOT_API_KEY;

if (!RIOT_API_KEY) {
  console.error("Fehlt: RIOT_API_KEY (Environment Variable).");
  process.exit(1);
}

const DATA_PATH = path.join(__dirname, "data.json");

const app = express();
app.use(express.json());

async function loadState() {
  const raw = await fs.readFile(DATA_PATH, "utf-8");
  return JSON.parse(raw);
}

async function saveState(state) {
  await fs.writeFile(DATA_PATH, JSON.stringify(state, null, 2), "utf-8");
}

async function riotFetch(url) {
  //console.log(url);
  const res = await fetch(url, {
    headers: { "X-Riot-Token": RIOT_API_KEY },
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Riot API ${res.status} ${res.statusText}: ${text}`);
  }
  return res.json();
}

const DDRAGON_TTL_MS = 24 * 60 * 60 * 1000;

let ddragonCache = {
  version: null,
  lang: null,
  champions: null,
  fetchedAt: 0,
};

async function getLatestDdragonVersion() {
  const versions = await riotFetch(
    "https://ddragon.leagueoflegends.com/api/versions.json"
  );
  if (!Array.isArray(versions) || !versions[0])
    throw new Error("Could not fetch Data Dragon versions");
  return versions[0];
}

async function getChampionsFromDdragon({ lang = "de_DE" } = {}) {
  const now = Date.now();
  if (
    ddragonCache.champions &&
    ddragonCache.version &&
    ddragonCache.lang === lang &&
    now - ddragonCache.fetchedAt < DDRAGON_TTL_MS
  ) {
    return ddragonCache;
  }

  const version = await getLatestDdragonVersion();
  const url = `https://ddragon.leagueoflegends.com/cdn/${version}/data/${lang}/champion.json`;
  const json = await riotFetch(url);

  const data = json?.data ?? {};
  const champs = Object.values(data)
    .map((c) => {
      // Square icons: /cdn/<version>/img/champion/<file>.png (e.g., Aatrox.png) :contentReference[oaicite:1]{index=1}
      const file = c?.image?.full; // e.g., "Aatrox.png"
      return {
        id: c.id, // e.g., "Aatrox"
        key: c.key, // e.g., "266"
        name: c.name, // localized (de_DE)
        title: c.title, // localized
        icon: `https://ddragon.leagueoflegends.com/cdn/${version}/img/champion/${file}`,
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name, "de"));

  ddragonCache = { version, lang, champions: champs, fetchedAt: now };
  return ddragonCache;
}

function regionalForPlatform(platform) {
  const p = String(platform || "").toLowerCase();
  if (["euw1", "eun1", "tr1", "ru"].includes(p)) return "europe";
  if (["na1", "br1", "la1", "la2", "oc1"].includes(p)) return "americas";
  return "asia";
}

function yearRangeEpochSeconds(year) {
  const start = Math.floor(Date.UTC(year, 0, 1, 0, 0, 0) / 1000);
  const end = Math.floor(Date.UTC(year + 1, 0, 1, 0, 0, 0) / 1000);
  return { start, end };
}

async function fetchAllMatchIdsForYear({
  puuid,
  platform,
  year,
  queueId = null,
}) {
  const region = regionalForPlatform(platform);
  const { start, end } = yearRangeEpochSeconds(year);

  const all = [];
  let startIdx = 0;

  while (true) {
    const qs = new URLSearchParams({
      startTime: String(start),
      endTime: String(end),
      start: String(startIdx),
      count: "100",
    });
    if (queueId != null) qs.set("queue", String(queueId));

    const url =
      `https://${region}.api.riotgames.com/lol/match/v5/matches/by-puuid/` +
      `${encodeURIComponent(puuid)}/ids?` +
      qs.toString();

    const ids = await riotFetch(url);
    if (!Array.isArray(ids) || ids.length === 0) break;

    all.push(...ids);
    startIdx += ids.length;

    if (ids.length < 100) break; // letzte Seite
  }

  return all;
}

async function fetchMatchDetail(region, matchId) {
  const url =
    `https://${region}.api.riotgames.com/lol/match/v5/matches/` +
    `${encodeURIComponent(matchId)}`;
  return riotFetch(url);
}

async function countGamesByChampionFromMatches({ puuid, platform, matchIds }) {
  const region = regionalForPlatform(platform);
  const counts = new Map();
  let total = 0;

  const CONCURRENCY = 3; // bewusst klein wegen Rate Limits
  let idx = 0;

  async function worker() {
    while (idx < matchIds.length) {
      const myIdx = idx++;
      const matchId = matchIds[myIdx];

      const m = await fetchMatchDetail(region, matchId);
      const parts = m?.info?.participants || [];
      const me = parts.find((x) => x?.puuid === puuid);
      const champId = me?.championId;

      if (Number.isFinite(champId)) {
        counts.set(champId, (counts.get(champId) || 0) + 1);
        total++;
      }
    }
  }

  const n = Math.min(CONCURRENCY, matchIds.length || 0);
  await Promise.all(Array.from({ length: n }, worker));
  return { counts, total };
}

function mapCountsToChampionList(ddChampions, countsMap) {
  const byKey = new Map(ddChampions.map((c) => [String(c.key), c])); // key == numeric champId als string
  const out = [];

  for (const [championId, count] of countsMap.entries()) {
    const c = byKey.get(String(championId));
    out.push({
      championId,
      count,
      name: c?.name || `Champion ${championId}`,
      icon: c?.icon || null,
    });
  }

  out.sort((a, b) => b.count - a.count);
  return out;
}

function rankValue(rank) {
  // Higher = better
  // rank object: { tier, division, lp } OR { unranked: true }
  if (!rank || rank.unranked) return -1;

  const tierOrder = [
    "IRON",
    "BRONZE",
    "SILVER",
    "GOLD",
    "PLATINUM",
    "EMERALD",
    "DIAMOND",
    "MASTER",
    "GRANDMASTER",
    "CHALLENGER",
  ];
  const divOrder = ["IV", "III", "II", "I"]; // higher index = better

  const t = String(rank.tier || "").toUpperCase();
  const d = String(rank.division || "").toUpperCase();

  const tIdx = tierOrder.indexOf(t);
  if (tIdx === -1) return -1;

  // Apex tiers often have no division in entries; treat as best within tier
  const isApex = ["MASTER", "GRANDMASTER", "CHALLENGER"].includes(t);

  const dIdx = isApex ? 3 : divOrder.indexOf(d);
  const divScore = dIdx === -1 ? 0 : dIdx; // be permissive

  // Add LP as minor tiebreaker
  const lp = Number.isFinite(+rank.lp) ? +rank.lp : 0;

  return tIdx * 1000 + divScore * 10 + Math.min(lp, 99) / 100;
}

function formatRank(rank) {
  if (!rank || rank.unranked) return "Unranked";
  const tier = rank.tier?.toUpperCase() ?? "";
  const div = rank.division ? ` ${rank.division}` : "";
  const lp = Number.isFinite(+rank.lp) ? `${rank.lp} LP` : "";
  return `${tier}${div} ${lp}`.trim();
}

async function ensurePuuidAndSummonerId(player) {
  // 1) PUUID via account-v1 by Riot ID
  if (!player.puuid) {
    const cluster = "europe";
    const { gameName, tagLine } = player.riotId;
    const url =
      `https://${cluster}.api.riotgames.com/riot/account/v1/accounts/by-riot-id/` +
      `${encodeURIComponent(gameName)}/${encodeURIComponent(tagLine)}`;
    const acc = await riotFetch(url);
    player.puuid = acc.puuid;
  }
}

async function fetchSoloQRank(player) {
  const platform = "euw1";
  const url =
    `https://${platform}.api.riotgames.com/lol/league/v4/entries/by-puuid/` +
    `${encodeURIComponent(player.puuid)}`;
  console.log(url);
  const entries = await riotFetch(url);
  console.log(entries);
  const solo = Array.isArray(entries)
    ? entries.find((e) => e.queueType === "RANKED_SOLO_5x5")
    : null;

  if (!solo) return { unranked: true };

  // tier (e.g., GOLD), rank (division like II), leaguePoints
  return {
    tier: solo.tier,
    division: solo.rank,
    lp: solo.leaguePoints,
  };
}

function isPromotion(prevRank, newRank) {
  return rankValue(newRank) > rankValue(prevRank);
}

const CHAMP_GAMES_TTL_MS = 30 * 60 * 1000; // 30 Minuten

function getYearStats(player, year) {
  return player?.champGamesByYear?.[String(year)] || null;
}

function setYearStats(player, year, stats) {
  if (!player.champGamesByYear) player.champGamesByYear = {};
  player.champGamesByYear[String(year)] = stats;
}

function isFresh(iso, ttlMs) {
  const t = Date.parse(iso || "");
  if (!Number.isFinite(t)) return false;
  return Date.now() - t < ttlMs;
}

async function computeChampionGamesForYear(
  state,
  player,
  year,
  queueId = null
) {
  await ensurePuuidAndSummonerId(player);

  // Reuse cached-in-json stats if fresh
  const existing = getYearStats(player, year);
  if (
    existing?.computedAt &&
    isFresh(existing.computedAt, CHAMP_GAMES_TTL_MS) &&
    existing.queueId === queueId
  ) {
    return existing;
  }

  const matchIds = await fetchAllMatchIdsForYear({
    puuid: player.puuid,
    platform: player.platform,
    year,
    queueId,
  });

  const { counts, total } = await countGamesByChampionFromMatches({
    puuid: player.puuid,
    platform: player.platform,
    matchIds,
  });

  const dd = await getChampionsFromDdragon({ lang: "de_DE" });
  const byChampion = mapCountsToChampionList(dd.champions, counts);

  const stats = {
    computedAt: new Date().toISOString(),
    year,
    queueId, // null = alle Queues, 420 = SoloQ usw.
    matchCount: matchIds.length,
    totalGames: total,
    byChampion, // Liste (sortiert) mit name/icon/count
  };

  setYearStats(player, year, stats);
  await saveState(state);
  return stats;
}

async function refreshAll() {
  const state = await loadState();
  const nowIso = new Date().toISOString();
  state.globalLastUpdatedAt = nowIso;

  for (const p of state.players) {
    try {
      await ensurePuuidAndSummonerId(p);

      const newRank = await fetchSoloQRank(p);
      const prevRank = p.currentRank ?? p.lastRank ?? null;

      // shift current -> last, then set new current
      p.lastRank = p.currentRank ?? p.lastRank ?? null;
      p.currentRank = newRank;
      p.lastUpdatedAt = nowIso;

      if (isPromotion(prevRank, newRank)) {
        // Create pending ban (only if none exists)
        if (!p.pendingBan) {
          p.pendingBan = {
            detectedAt: nowIso,
            from: prevRank,
            to: newRank,
          };
        }
      }
    } catch (err) {
      p.lastUpdatedAt = nowIso;
      p.lastError = String(err?.message || err);
    }
  }

  await saveState(state);
  return state;
}

// Serve frontend
app.use("/", express.static(path.join(__dirname, "..", "public")));

// API: get state
app.get("/api/state", async (req, res) => {
  const state = await loadState();
  res.json(state);
});

app.get("/api/champions", async (req, res) => {
  try {
    const lang = req.query.lang ? String(req.query.lang) : "de_DE";
    const out = await getChampionsFromDdragon({ lang });
    res.json(out); // { version, lang, champions: [...] }
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

// kleines in-memory cache (10 min) für overview
const OVERVIEW_TTL_MS = 10 * 60 * 1000;
const overviewCache = new Map(); // key: playerId -> { ts, data }

async function fetchTopChampionMastery(player, topN = 5) {
  // falls du summonerId doch nicht speicherst: hier sicherstellen (oder an deine Logik anpassen)
  await ensurePuuidAndSummonerId(player);

  const platform = String(player.platform).toLowerCase();
  const url = `https://${platform}.api.riotgames.com/lol/champion-mastery/v4/champion-masteries/by-puuid/${encodeURIComponent(
    player.puuid
  )}/top?count=${topN}`;
  return riotFetch(url); // array mit championId, championPoints, ...
}

function champByNumericId(champions, championIdNum) {
  const idStr = String(championIdNum);
  // Data Dragon: champ.key ist numeric string ("266")
  return champions.find((c) => c.key === idStr) || null;
}

app.get("/api/player/:playerId/overview", async (req, res) => {
  try {
    const playerId = String(req.params.playerId);
    const state = await loadState();
    const p = state.players.find((x) => x.id === playerId);
    if (!p)
      return res
        .status(404)
        .json({ ok: false, error: "Spieler nicht gefunden." });

    // cache
    const cached = overviewCache.get(playerId);
    if (cached && Date.now() - cached.ts < OVERVIEW_TTL_MS) {
      return res.json({ ok: true, ...cached.data });
    }

    // Champions (für Icons/Namen)
    const dd = await getChampionsFromDdragon({ lang: "de_DE" });

    // Top mastery (most played)
    const mastery = await fetchTopChampionMastery(p, 5);
    const mostPlayed = (Array.isArray(mastery) ? mastery : []).map((m) => {
      const champ = champByNumericId(dd.champions, m.championId);
      return {
        championId: m.championId,
        name: champ?.name || `Champion ${m.championId}`,
        icon: champ?.icon || null,
        points: m.championPoints,
      };
    });

    // NEU: Games pro Champ aus Match-Historie 2026 (alle Queues oder setze queueId=420)
    const games2026 = await computeChampionGamesForYear(state, p, 2026, null);

    const data = {
      playerId: p.id,
      displayName: p.displayName,
      mostPlayed,
      bans: Array.isArray(p.bans) ? p.bans : [],
      games2026: games2026.byChampion, // Liste sortiert
      totalGames2026: games2026.totalGames,
    };

    overviewCache.set(playerId, { ts: Date.now(), data });
    await saveState(state); // falls ensurePuuidAndSummonerId was ergänzt hat
    res.json({ ok: true, ...data });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

app.get("/api/player/:playerId/champ-games", async (req, res) => {
  try {
    const playerId = String(req.params.playerId);
    const year = Number(req.query.year || 2026);

    // optional: queue filter (420 SoloQ, 440 Flex, null = alle)
    const queueParam = req.query.queue;
    const queueId =
      queueParam === undefined || queueParam === "" ? null : Number(queueParam);

    const state = await loadState();
    const p = state.players.find((x) => x.id === playerId);
    if (!p) {
      return res
        .status(404)
        .json({ ok: false, error: "Spieler nicht gefunden." });
    }

    const stats = await computeChampionGamesForYear(state, p, year, queueId);

    res.json({
      ok: true,
      playerId: p.id,
      displayName: p.displayName,
      ...stats,
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

// API: force refresh
app.post("/api/refresh", async (req, res) => {
  try {
    const state = await refreshAll();
    res.json({ ok: true, state });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

// API: add ban (clears pendingBan)
app.post("/api/ban", async (req, res) => {
  const { playerId, champion, note } = req.body || {};
  const champ = String(champion || "").trim();
  if (!playerId || !champ) {
    return res
      .status(400)
      .json({ ok: false, error: "playerId und champion sind erforderlich." });
  }

  const state = await loadState();
  const p = state.players.find((x) => x.id === playerId);
  if (!p)
    return res
      .status(404)
      .json({ ok: false, error: "Spieler nicht gefunden." });

  // NEU: Keine manuellen Bans erlaubt
  if (!p.pendingBan) {
    return res.status(409).json({
      ok: false,
      error: "Kein Uprank erkannt. Bans sind nur nach einem Uprank erlaubt.",
    });
  }

  const norm = (s) => String(s).trim().replace(/\s+/g, " ").toLowerCase();
  if (p.bans.some((b) => norm(b.champion) === norm(champ))) {
    return res.status(409).json({
      ok: false,
      error: "Champion ist für diesen Spieler bereits gebannt.",
    });
  }

  // ... innerhalb app.post("/api/ban", ...)

  const time = new Date().toISOString();

  // Uprank-Info sichern, bevor du pendingBan leerst
  const pending = p.pendingBan ? { ...p.pendingBan } : null;

  const entry = {
    time,
    playerId: p.id,
    playerName: p.displayName,
    champion: champ,
    note: String(note || ""),

    // NEU: Uprank-Info für die Historie
    promotion: pending
      ? {
          from: pending.from ?? null,
          to: pending.to ?? null,
          detectedAt: pending.detectedAt ?? null,
        }
      : null,
  };

  p.bans.push({ time, champion: champ, note: entry.note });

  // pendingBan erst nach dem Erstellen des History-Eintrags löschen
  p.pendingBan = null;

  state.banHistory.unshift(entry);

  await saveState(state);
  return res.json({ ok: true, state });
});

app.listen(PORT, () => {
  console.log(`Server läuft: http://localhost:${PORT}`);
});
