// bootstrap.js
import fs from "fs/promises";
import "dotenv/config";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const RIOT_API_KEY = process.env.RIOT_API_KEY;
if (!RIOT_API_KEY) {
  console.error("Fehlt: RIOT_API_KEY");
  process.exit(1);
}

const DATA_PATH = path.join(__dirname, "data.json");
const YEAR = 2026;
const QUEUE_ID = 420; // SoloQ
const REMAKE_MAX_DURATION_SEC = 300;

// konservatives Throttling, damit du nicht in 429 läufst
const MIN_DELAY_MS = 1100;

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function riotFetch(url) {
  while (true) {
    const res = await fetch(url, { headers: { "X-Riot-Token": RIOT_API_KEY } });

    if (res.status === 429) {
      const ra = Number(res.headers.get("retry-after") || "2");
      await sleep(Math.max(ra * 1000, 2000));
      continue;
    }

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`Riot API ${res.status} ${res.statusText}: ${text}`);
    }

    // kleine Pause zwischen Calls (auch bei Erfolg)
    await sleep(MIN_DELAY_MS);
    return res.json();
  }
}

async function ddragonFetch(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`DDragon ${res.status}: ${url}`);
  return res.json();
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

async function ensurePuuid(player) {
  if (player.puuid) return;
  const cluster = "europe";
  const { gameName, tagLine } = player.riotId;
  const url =
    `https://${cluster}.api.riotgames.com/riot/account/v1/accounts/by-riot-id/` +
    `${encodeURIComponent(gameName)}/${encodeURIComponent(tagLine)}`;
  const acc = await riotFetch(url);
  player.puuid = acc.puuid;
}

async function fetchSoloQRank(player) {
  const platform = String(player.platform || "euw1").toLowerCase();
  const url =
    `https://${platform}.api.riotgames.com/lol/league/v4/entries/by-puuid/` +
    `${encodeURIComponent(player.puuid)}`;

  const entries = await riotFetch(url);
  const solo = Array.isArray(entries)
    ? entries.find((e) => e.queueType === "RANKED_SOLO_5x5")
    : null;

  if (!solo) return { unranked: true, wins: 0, losses: 0, winrate: null };

  const wins = Number(solo.wins || 0);
  const losses = Number(solo.losses || 0);
  const games = wins + losses;
  const winrate = games > 0 ? Math.round((wins / games) * 1000) / 10 : null;

  return {
    tier: solo.tier,
    division: solo.rank,
    lp: solo.leaguePoints,
    wins,
    losses,
    winrate,
  };
}

async function getDdragonChampionsDe() {
  const versions = await ddragonFetch(
    "https://ddragon.leagueoflegends.com/api/versions.json"
  );
  const version = versions[0];

  const json = await ddragonFetch(
    `https://ddragon.leagueoflegends.com/cdn/${version}/data/de_DE/champion.json`
  );

  const champs = Object.values(json?.data ?? {}).map((c) => ({
    key: String(c.key), // numeric string
    name: c.name,
    icon: `https://ddragon.leagueoflegends.com/cdn/${version}/img/champion/${c.image.full}`,
  }));

  const byKey = new Map(champs.map((c) => [c.key, c]));
  return { version, byKey };
}

async function fetchAllMatchIdsForYear({ puuid, platform, year, queueId }) {
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
    if (ids.length < 100) break;
  }

  return { region, ids: all };
}

async function fetchMatch(region, matchId) {
  const url =
    `https://${region}.api.riotgames.com/lol/match/v5/matches/` +
    `${encodeURIComponent(matchId)}`;
  return riotFetch(url);
}

function isRemake(m) {
  const dur = m?.info?.gameDuration;
  return Number.isFinite(dur) && dur > 0 && dur < REMAKE_MAX_DURATION_SEC;
}

async function main() {
  const raw = await fs.readFile(DATA_PATH, "utf-8");
  const state = JSON.parse(raw);

  const dd = await getDdragonChampionsDe();

  for (const p of state.players) {
    console.log("Bootstrap:", p.displayName);

    // 1) PUUID + Rank
    await ensurePuuid(p);
    const rank = await fetchSoloQRank(p);

    p.lastRank = p.currentRank ?? null;
    p.currentRank = rank;
    p.soloWL = { wins: rank.wins || 0, losses: rank.losses || 0 };

    // 2) Match-IDs 2026 SoloQ
    const { region, ids } = await fetchAllMatchIdsForYear({
      puuid: p.puuid,
      platform: p.platform,
      year: YEAR,
      queueId: QUEUE_ID,
    });

    // newest first
    const latestMatchId = ids[0] || null;

    // 3) last5 + champion counts (non-remake)
    const counts = {};
    const last5 = [];

    for (const matchId of ids) {
      const m = await fetchMatch(region, matchId);
      if (isRemake(m)) continue;

      const me = (m?.info?.participants || []).find(
        (x) => x?.puuid === p.puuid
      );
      if (!me) continue;

      const champId = Number(me.championId);
      if (Number.isFinite(champId)) {
        const k = String(champId);
        counts[k] = (counts[k] || 0) + 1;
      }

      if (last5.length < 5) {
        const champ = dd.byKey.get(String(champId));
        last5.push({
          matchId,
          time: new Date(m?.info?.gameEndTimestamp || Date.now()).toISOString(),
          win: !!me.win,
          championId: champId,
          championName: champ?.name || `Champion ${champId}`,
          championIcon: champ?.icon || null,
          k: Number(me.kills || 0),
          d: Number(me.deaths || 0),
          a: Number(me.assists || 0),
          durationSec: Number(m?.info?.gameDuration || 0),
          queueId: Number(m?.info?.queueId || 0),
        });
      }
    }

    const byChampion = Object.entries(counts)
      .map(([champIdStr, count]) => {
        const champ = dd.byKey.get(champIdStr);
        return {
          championId: Number(champIdStr),
          count,
          name: champ?.name || `Champion ${champIdStr}`,
          icon: champ?.icon || null,
        };
      })
      .sort((a, b) => b.count - a.count);

    p.champGamesByYear = p.champGamesByYear || {};
    p.champGamesByYear[String(YEAR)] = {
      computedAt: new Date().toISOString(),
      year: YEAR,
      queueId: QUEUE_ID,
      matchCount: ids.length,
      totalGames: Object.values(counts).reduce((s, x) => s + x, 0),
      latestMatchId,
      countsByChampionId: counts,
      byChampion,
      triggerSoloTotal: (p.soloWL?.wins || 0) + (p.soloWL?.losses || 0),
    };

    p.last5 = { computedAt: new Date().toISOString(), games: last5 };

    // Aufräumen alter Fehler
    delete p.lastError;
    delete p.last5Error;
    delete p.champGamesError2026;
  }

  state.globalLastUpdatedAt = new Date().toISOString();
  await fs.writeFile(DATA_PATH, JSON.stringify(state, null, 2), "utf-8");
  console.log("Bootstrap fertig. data.json aktualisiert.");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
