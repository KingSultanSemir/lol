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
const REMAKE_MAX_DURATION_SEC = 300; // 5 Minuten

let MATCH_DETAIL_BUDGET = 0;
const MATCH_DETAIL_BUDGET_PER_REFRESH = 20; // start konservativ

const DATA_DIR = process.env.DATA_DIR; // z.B. /data (Railway Volume)
const DATA_PATH = DATA_DIR
  ? path.join(DATA_DIR, "data.json")
  : path.join(__dirname, "data.json");

const SEED_PATH = path.join(__dirname, "data.json");
const app = express();
app.use(express.json());

async function loadState() {
  try {
    const raw = await fs.readFile(DATA_PATH, "utf-8");
    return JSON.parse(raw);
  } catch (e) {
    if (e && e.code === "ENOENT") {
      // Volume ist leer -> Seed aus Repo kopieren
      await fs
        .mkdir(path.dirname(DATA_PATH), { recursive: true })
        .catch(() => {});

      let seed = { players: [], banHistory: [], globalLastUpdatedAt: null };

      try {
        const rawSeed = await fs.readFile(SEED_PATH, "utf-8");
        seed = JSON.parse(rawSeed);
      } catch {
        // falls Seed nicht lesbar ist, fallback bleibt leer
      }

      await fs.writeFile(DATA_PATH, JSON.stringify(seed, null, 2), "utf-8");
      return seed;
    }
    throw e;
  }
}

async function saveState(state) {
  await fs.writeFile(DATA_PATH, JSON.stringify(state, null, 2), "utf-8");
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function riotFetch(url, { retries = 5 } = {}) {
  const res = await fetch(url, { headers: { "X-Riot-Token": RIOT_API_KEY } });

  if (res.status === 429) {
    console.log("RateLimit Suceeded");
    const retryAfterSec = Number(res.headers.get("retry-after") || 0);
    const waitMs =
      retryAfterSec > 0 ? retryAfterSec * 1000 : 500 + Math.random() * 500; // fallback

    if (retries <= 0) {
      const text = await res.text().catch(() => "");
      throw new Error(`Riot API 429 Rate limit exceeded: ${text}`);
    }

    await sleep(waitMs);
    return riotFetch(url, { retries: retries - 1 });
  }

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

const matchDetailCache = new Map();

async function fetchMatchDetail(region, matchId) {
  const key = `${region}:${matchId}`;
  if (matchDetailCache.has(key)) return matchDetailCache.get(key);

  if (MATCH_DETAIL_BUDGET <= 0) throw new Error("MATCH_DETAIL_BUDGET_EXCEEDED");
  MATCH_DETAIL_BUDGET--;

  const url = `https://${region}.api.riotgames.com/lol/match/v5/matches/${encodeURIComponent(
    matchId
  )}`;
  const data = await riotFetch(url);
  matchDetailCache.set(key, data);
  return data;
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

function rankValue(oldRank, newRank) {
  if (!oldRank || oldRank.unranked) return false;
  if (!newRank || newRank.unranked) return false;

  const tierOrder = {
    IRON: 1,
    BRONZE: 2,
    SILVER: 3,
    GOLD: 4,
    PLATINUM: 5,
    EMERALD: 6,
    DIAMOND: 7,
    MASTER: 8,
    GRANDMASTER: 9,
    CHALLENGER: 10,
  };
  const divOrder = { IV: 1, III: 2, II: 3, I: 4 };

  const oldTier = tierOrder[String(oldRank.tier || "").toUpperCase()] ?? 0;
  const newTier = tierOrder[String(newRank.tier || "").toUpperCase()] ?? 0;

  if (newTier !== oldTier) return newTier > oldTier;

  const apex = newTier >= tierOrder.MASTER;

  const oldDiv = apex
    ? 0
    : divOrder[String(oldRank.division || "").toUpperCase()] ?? 0;
  const newDiv = apex
    ? 0
    : divOrder[String(newRank.division || "").toUpperCase()] ?? 0;

  if (newDiv !== oldDiv) return newDiv > oldDiv;

  return false;
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
  const platform = String(player.platform || "euw1").toLowerCase();

  const url =
    `https://${platform}.api.riotgames.com/lol/league/v4/entries/by-puuid/` +
    `${encodeURIComponent(player.puuid)}`;
  //console.log(url);
  const entries = await riotFetch(url);
  console.log("fetchSoloQPlayer():", entries);
  const solo = Array.isArray(entries)
    ? entries.find((e) => e.queueType === "RANKED_SOLO_5x5")
    : null;

  if (!solo) return { unranked: true };

  // tier (e.g., GOLD), rank (division like II), leaguePoints

  const wins = Number(solo.wins || 0);
  const losses = Number(solo.losses || 0);
  const games = wins + losses;
  const winrate = games > 0 ? Math.round((wins / games) * 1000) / 10 : null; // z.B. 53.2

  return {
    tier: solo.tier,
    division: solo.rank,
    lp: solo.leaguePoints,
    wins,
    losses,
    winrate,
  };
}

function isPromotion(prevRank, newRank) {
  return rankValue(prevRank, newRank);
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

async function fetchLastNGamesSummary(player, n = 5, queueId = 420) {
  const region = regionalForPlatform(player.platform);

  // Match IDs (nur Ranked SoloQ = 420)
  const qs = new URLSearchParams({
    start: "0",
    count: String(Math.min(n * 2, 20)), // etwas mehr holen, falls Remakes rausfliegen
  });
  if (queueId != null) qs.set("queue", String(queueId));

  const idsUrl =
    `https://${region}.api.riotgames.com/lol/match/v5/matches/by-puuid/` +
    `${encodeURIComponent(player.puuid)}/ids?` +
    qs.toString();

  //console.log(idsUrl);
  const matchIds = await riotFetch(idsUrl);
  //console.log(matchIds);
  if (!Array.isArray(matchIds) || matchIds.length === 0) return [];

  const dd = await getChampionsFromDdragon({ lang: "de_DE" });
  const byKey = new Map(dd.champions.map((c) => [String(c.key), c]));

  const out = [];
  for (const matchId of matchIds) {
    if (out.length >= n) break;

    const m = await fetchMatchDetail(region, matchId);

    const dur = m?.info?.gameDuration;
    if (Number.isFinite(dur) && dur > 0 && dur < REMAKE_MAX_DURATION_SEC) {
      //console.log("remake");
      continue; // Remake skip
    }

    const parts = m?.info?.participants || [];
    const me = parts.find((x) => x?.puuid === player.puuid);
    if (!me) continue;

    const champId = me.championId;
    const champ = byKey.get(String(champId));

    console.log({
      matchId,
      time: new Date(m?.info?.gameEndTimestamp || Date.now()).toISOString(),
      win: !!me.win,
      championId: champId,
      championName: champ?.name || `Champion ${champId}`,
      championIcon: champ?.icon || null,
      k: Number(me.kills || 0),
      d: Number(me.deaths || 0),
      a: Number(me.assists || 0),
      durationSec: Number(dur || 0),
      queueId: Number(m?.info?.queueId || 0),
    });

    out.push({
      matchId,
      time: new Date(m?.info?.gameEndTimestamp || Date.now()).toISOString(),
      win: !!me.win,
      championId: champId,
      championName: champ?.name || `Champion ${champId}`,
      championIcon: champ?.icon || null,
      k: Number(me.kills || 0),
      d: Number(me.deaths || 0),
      a: Number(me.assists || 0),
      durationSec: Number(dur || 0),
      queueId: Number(m?.info?.queueId || 0),
    });
  }

  return out;
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

function ensureCountsMap(stats) {
  if (stats.countsByChampionId) return;
  const map = {};
  for (const row of stats.byChampion || []) {
    map[String(row.championId)] = row.count;
  }
  stats.countsByChampionId = map;
}

async function updateChampionOverviewIncremental(
  state,
  player,
  year = 2026,
  queueId = 420
) {
  await ensurePuuidAndSummonerId(player);
  if (!player.champGamesByYear) player.champGamesByYear = {};
  const key = String(year);

  let stats = player.champGamesByYear[key];
  if (!stats) {
    stats = { year, queueId, totalGames: 0, byChampion: [] };
    player.champGamesByYear[key] = stats;
  }

  stats.queueId = queueId;
  ensureCountsMap(stats);

  const region = regionalForPlatform(player.platform);
  const { start, end } = yearRangeEpochSeconds(year);

  const qs = new URLSearchParams({
    startTime: String(start),
    endTime: String(end),
    start: "0",
    count: "100",
  });
  if (queueId != null) qs.set("queue", String(queueId));

  const idsUrl =
    `https://${region}.api.riotgames.com/lol/match/v5/matches/by-puuid/` +
    `${encodeURIComponent(player.puuid)}/ids?` +
    qs.toString();

  const ids = await riotFetch(idsUrl);
  if (!Array.isArray(ids) || ids.length === 0) return;

  // Wenn wir noch keinen Marker haben: nur Marker setzen (damit wir nichts doppelt zählen)
  if (!stats.latestMatchId) {
    stats.latestMatchId = ids[0];
    stats.computedAt = new Date().toISOString();
    await saveState(state);
    return;
  }

  // Neue IDs bis zum Marker
  const newIds = [];
  for (const id of ids) {
    if (id === stats.latestMatchId) break;
    newIds.push(id);
  }

  // Marker auf neuestes setzen
  stats.latestMatchId = ids[0];

  if (newIds.length === 0) {
    stats.computedAt = new Date().toISOString();
    await saveState(state);
    return;
  }

  // DDragon für Mapping
  const dd = await getChampionsFromDdragon({ lang: "de_DE" });
  const byKey = new Map(dd.champions.map((c) => [String(c.key), c]));

  let added = 0;

  for (const matchId of newIds) {
    const m = await fetchMatchDetail(region, matchId);

    // Remake skip
    const dur = m?.info?.gameDuration;
    if (Number.isFinite(dur) && dur > 0 && dur < REMAKE_MAX_DURATION_SEC)
      continue;

    const me = (m?.info?.participants || []).find(
      (x) => x?.puuid === player.puuid
    );
    const champId = me?.championId;
    if (!Number.isFinite(champId)) continue;

    const k = String(champId);
    stats.countsByChampionId[k] = (stats.countsByChampionId[k] || 0) + 1;
    stats.totalGames = (stats.totalGames || 0) + 1;
    added++;
  }

  // byChampion neu bauen (aus counts)
  const list = Object.entries(stats.countsByChampionId).map(
    ([champIdStr, count]) => {
      const champ = byKey.get(champIdStr);
      return {
        championId: Number(champIdStr),
        count,
        name: champ?.name || `Champion ${champIdStr}`,
        icon: champ?.icon || null,
      };
    }
  );
  list.sort((a, b) => b.count - a.count);

  stats.byChampion = list;
  stats.matchCount = (stats.matchCount || 0) + newIds.length; // optional als "processed match ids"
  stats.computedAt = new Date().toISOString();
  stats.lastIncrement = { newMatchesSeen: newIds.length, gamesCounted: added };

  player.champGamesByYear[key] = stats;
  await saveState(state);
}

async function refreshAll() {
  MATCH_DETAIL_BUDGET = MATCH_DETAIL_BUDGET_PER_REFRESH;

  const state = await loadState();
  const nowIso = new Date().toISOString();
  state.globalLastUpdatedAt = nowIso;

  for (const p of state.players) {
    try {
      await ensurePuuidAndSummonerId(p);

      const newRank = await fetchSoloQRank(p);
      const prevRank = p.currentRank || p.lastRank || { unranked: true };

      // Vorherige SoloQ W/L aus dem gespeicherten State
      const prevWL = p.soloWL || { wins: null, losses: null };
      const prevTotal =
        (Number.isFinite(+prevWL.wins) ? +prevWL.wins : 0) +
        (Number.isFinite(+prevWL.losses) ? +prevWL.losses : 0);

      const newWL = {
        wins: Number.isFinite(+newRank.wins) ? +newRank.wins : 0,
        losses: Number.isFinite(+newRank.losses) ? +newRank.losses : 0,
      };
      const newTotal = newWL.wins + newWL.losses;

      // Immer speichern, damit nächstes Mal verglichen werden kann
      p.soloWL = newWL;

      // shift current -> last, then set new current
      p.lastRank = p.currentRank ?? p.lastRank ?? null;
      p.currentRank = newRank;

      if (newTotal !== prevTotal) {
        await updateChampionOverviewIncremental(state, p, 2026, 420);
        const cached = p.last5;

        const games = await fetchLastNGamesSummary(p, 5, 420);
        console.log("GAMES:", games);
        p.last5 = { computedAt: nowIso, games };
      }
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
      const msg = String(e?.message || e);
      if (msg.includes("MATCH_DETAIL_BUDGET_EXCEEDED")) {
        p.needsCatchup = true;
      } else {
        p.lastError = msg;
      }
    }
  }

  await saveState(state);
  return state;
}

// Serve frontend
app.use("/", express.static(path.join(__dirname, "public")));

// API: get state
app.get("/api/state", async (req, res) => {
  const state = await loadState();
  res.json(state);
});

app.get("/api/player/:playerId/overview", async (req, res) => {
  try {
    const playerId = String(req.params.playerId);
    const state = await loadState();
    const p = state.players.find((x) => x.id === playerId);
    if (!p)
      return res
        .status(404)
        .json({ ok: false, error: "Spieler nicht gefunden." });

    // Minimal: nur aus data.json liefern (ohne Riot Calls)
    return res.json({
      ok: true,
      playerId: p.id,
      displayName: p.displayName,
      bans: Array.isArray(p.bans) ? p.bans : [],
      games2026: p.champGamesByYear?.["2026"]?.byChampion || [],
      totalGames2026: p.champGamesByYear?.["2026"]?.totalGames || 0,
      last5: p.last5?.games || [],
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
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

app.get("/api/player/:playerId/champ-games", async (req, res) => {
  try {
    const playerId = String(req.params.playerId);
    const year = String(req.query.year || "2026");

    const state = await loadState();
    const p = state.players.find((x) => x.id === playerId);
    if (!p)
      return res
        .status(404)
        .json({ ok: false, error: "Spieler nicht gefunden." });

    const stats = p.champGamesByYear?.[year];
    if (!stats) {
      return res.json({
        ok: true,
        year: Number(year),
        byChampion: [],
        totalGames: 0,
        matchCount: 0,
      });
    }

    return res.json({
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
