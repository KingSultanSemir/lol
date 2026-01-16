const $ = (id) => document.getElementById(id);

const playersEl = $("players");
const historyEl = $("history");
const historyEmptyEl = $("historyEmpty");
const btnRefresh = $("btnRefresh");

const modalBackdrop = $("modalBackdrop");
const btnCloseModal = $("btnCloseModal");
const btnCancelModal = $("btnCancelModal");
const btnSaveBan = $("btnSaveBan");
const mPlayerName = $("mPlayerName");
const mChampion = $("mChampion");
const mNote = $("mNote");
const mHint = $("mHint");
const globalLastUpdate = $("globalLastUpdate");
const overviewBackdrop = $("overviewBackdrop");
const btnCloseOverview = $("btnCloseOverview");
const ovTitle = $("ovTitle");
const ovMostPlayed = $("ovMostPlayed");
const ovBans = $("ovBans");
const mChampSearch = $("mChampSearch");
const champGrid = $("champGrid");
const mSelectedChamp = $("mSelectedChamp");

const crownSvg = `
  <span class="crown" title="Leader">
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M3 7l4 4 5-6 5 6 4-4v12H3V7zm2 10h14v-6.17l-2.59 2.59L12 8.17 7.59 13.42 5 10.83V17z"/>
    </svg>
  </span>
`;

let state = null;
let champions = [];
let selectedChampion = null;
let modalPlayerId = null;

function fmtTime(iso) {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return String(iso);
  return d.toLocaleString("de-DE", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}
function setGlobalLastUpdate(dateIso) {
  if (!globalLastUpdate) return;
  globalLastUpdate.textContent = `Letztes Update: ${
    dateIso ? fmtTime(dateIso) : "—"
  }`;
}

function esc(s) {
  return String(s ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function rankText(rank) {
  if (!rank || rank.unranked) return "Unranked";
  const tier = (rank.tier || "").toUpperCase();
  const div = rank.division ? ` ${rank.division}` : "";
  const lp = Number.isFinite(+rank.lp) ? ` · ${rank.lp} LP` : "";
  return `${tier}${div}${lp}`.trim();
}

function rankValue(rank) {
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

  const divOrder = ["IV", "III", "II", "I"]; // I ist höher als IV

  const tier = String(rank.tier || "").toUpperCase();
  const division = String(rank.division || "").toUpperCase();
  const lp = Number.isFinite(+rank.lp) ? +rank.lp : 0;

  const tIdx = tierOrder.indexOf(tier);
  if (tIdx === -1) return -1;

  const isApex = ["MASTER", "GRANDMASTER", "CHALLENGER"].includes(tier);
  const dIdx = isApex ? 3 : divOrder.indexOf(division); // Apex hat oft keine Division
  const divScore = dIdx === -1 ? 0 : dIdx;

  // Höherer Tier wichtiger als Division, Division wichtiger als LP
  return tIdx * 100000 + divScore * 1000 + lp;
}

function bestRankForPlayer(p) {
  // Falls currentRank mal null ist, nimm lastRank als Fallback
  return p.currentRank ?? p.lastRank ?? { unranked: true };
}

function norm(s) {
  return String(s || "")
    .trim()
    .toLowerCase();
}

async function loadChampionsOnce() {
  if (champions.length) return;
  const res = await fetch("/api/champions?lang=de_DE");
  const out = await res.json();
  champions = out.champions || [];
}
async function apiGetPlayerOverview(playerId) {
  const res = await fetch(
    `/api/player/${encodeURIComponent(playerId)}/overview`
  );
  const out = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(out.error || `HTTP ${res.status}`);
  // akzeptiere sowohl {ok:true,...} als auch {...} ohne ok
  if (out && out.ok === false)
    throw new Error(out.error || "Overview fehlgeschlagen");
  return out;
}

async function apiGetChampGames(playerId, year = 2026) {
  const res = await fetch(
    `/api/player/${encodeURIComponent(playerId)}/champ-games?year=${year}`
  );
  const out = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(out.error || `HTTP ${res.status}`);
  if (out && out.ok === false)
    throw new Error(out.error || "champ-games fehlgeschlagen");
  return out;
}

function openOverviewModal() {
  overviewBackdrop.style.display = "flex";
}

function closeOverviewModal() {
  overviewBackdrop.style.display = "none";
}

function renderOverviewTilesMostPlayedFromGames(list, bans) {
  ovMostPlayed.innerHTML = "";

  if (!list?.length) {
    ovMostPlayed.innerHTML = `<div class="muted">Keine Spiele in 2026 gefunden.</div>`;
    return;
  }

  const bannedSet = new Set((bans || []).map((b) => norm(b.champion)));

  for (const it of list) {
    const isBanned =
      bannedSet.has(norm(it.name)) || (it.id && bannedSet.has(norm(it.id))); // falls du später mal IDs speicherst

    const div = document.createElement("div");
    div.className = "ov-tile" + (isBanned ? " disabled" : "");
    div.innerHTML = `
      ${
        it.icon
          ? `<img class="ov-icon" loading="lazy" src="${it.icon}" alt="${esc(
              it.name
            )}"/>`
          : `<div class="ov-icon"></div>`
      }
      <div class="ov-meta">
        <div class="ov-name">${esc(it.name)}</div>
        <div class="ov-sub">${esc(String(it.count))} Spiele (2026)</div>
      </div>
    `;
    ovMostPlayed.appendChild(div);
  }
}

function renderOverviewTilesBans(bans) {
  ovBans.innerHTML = "";

  // Icons: wir nutzen deine schon geladene champions-Liste
  const byName = new Map(champions.map((c) => [norm(c.name), c]));
  const byId = new Map(champions.map((c) => [norm(c.id), c]));

  if (!bans?.length) {
    ovBans.innerHTML = `<div class="muted">Noch keine gebannten Champions.</div>`;
    return;
  }

  for (const b of bans) {
    const champ =
      byName.get(norm(b.champion)) || byId.get(norm(b.champion)) || null;
    const div = document.createElement("div");
    div.className = "ov-tile";
    div.innerHTML = `
      ${
        champ?.icon
          ? `<img class="ov-icon" loading="lazy" src="${champ.icon}" alt="${esc(
              b.champion
            )}"/>`
          : `<div class="ov-icon"></div>`
      }
      <div class="ov-meta">
        <div class="ov-name">${esc(b.champion)}</div>
        <div class="ov-sub">${b.time ? esc(fmtTime(b.time)) : ""}</div>
      </div>
    `;
    ovBans.appendChild(div);
  }
}

function renderChampGrid(player) {
  const q = norm(mChampSearch.value);
  const bannedSet = new Set((player.bans || []).map((b) => norm(b.champion)));

  const list = champions.filter((c) => {
    if (!q) return true;
    return norm(c.name).includes(q) || norm(c.id).includes(q);
  });

  champGrid.innerHTML = "";

  for (const c of list) {
    const isBanned = bannedSet.has(norm(c.name)) || bannedSet.has(norm(c.id));
    const tile = document.createElement("div");
    tile.className =
      "champ-tile" +
      (isBanned ? " disabled" : "") +
      (selectedChampion?.id === c.id ? " selected" : "");
    tile.title = c.name;

    tile.innerHTML = `
      <img class="champ-icon" loading="lazy" src="${c.icon}" alt="${esc(
      c.name
    )}"/>
      <div class="champ-name">${esc(c.name)}</div>
    `;

    if (!isBanned) {
      tile.addEventListener("click", () => {
        selectedChampion = c;
        mSelectedChamp.textContent = c.name;
        renderChampGrid(player);
      });
    }

    champGrid.appendChild(tile);
  }
}

async function openBanModal(player) {
  modalPlayerId = player.id;
  mPlayerName.textContent = player.displayName;
  mNote.value = "";
  selectedChampion = null;
  mSelectedChamp.textContent = "—";
  mChampSearch.value = "";

  if (player.pendingBan) {
    mHint.textContent = `Uprank erkannt: ${rankText(
      player.pendingBan.from
    )} → ${rankText(player.pendingBan.to)} (detektiert: ${fmtTime(
      player.pendingBan.detectedAt
    )})`;
  } else {
    mHint.textContent = "Kein Uprank erkannt – Bann nicht möglich.";
  }

  await loadChampionsOnce();
  renderChampGrid(player);

  modalBackdrop.style.display = "flex";
  mChampSearch.focus();
}

function closeBanModal() {
  modalBackdrop.style.display = "none";
  modalPlayerId = null;
}

async function apiGetState() {
  const res = await fetch("/api/state");
  state = await res.json();
}

async function apiRefresh() {
  const res = await fetch("/api/refresh", { method: "POST" });
  const out = await res.json();
  if (!out.ok) throw new Error(out.error || "Refresh fehlgeschlagen");
  state = out.state;
}

async function apiAddBan(playerId, champion, note) {
  const res = await fetch("/api/ban", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ playerId, champion, note }),
  });
  const out = await res.json();
  if (!out.ok) throw new Error(out.error || "Ban fehlgeschlagen");
  state = out.state;
}

function render() {
  renderPlayers();
  renderHistory();
}

function renderPlayers() {
  playersEl.innerHTML = "";
  const sortedPlayers = [...state.players].sort((a, b) => {
    const av = rankValue(bestRankForPlayer(a));
    const bv = rankValue(bestRankForPlayer(b));
    return bv - av; // absteigend (höchster Rank zuerst)
  });
  const leaderId = sortedPlayers[0]?.id ?? null;
  for (const p of sortedPlayers) {
    const div = document.createElement("div");
    div.className = "player";

    const pending = p.pendingBan
      ? `
      <span class="badge pending">Pending Ban · Uprank ${rankText(
        p.pendingBan.from
      )} → ${rankText(p.pendingBan.to)}</span>
    `
      : "";

    div.innerHTML = `
      <div class="row">
        <div>
          <div class="player-title">
            ${p.id === leaderId ? crownSvg : ""}
            <div class="player-name">${esc(p.displayName)}</div>
            </div>


          <div class="muted">${esc(p.riotId.gameName)}#${esc(
      p.riotId.tagLine
    )} · ${esc(p.platform)}</div>
        </div>
        <div style="display:flex; flex-direction:column; align-items:flex-end; gap:6px;">
  <div class="pill">${esc(rankText(p.currentRank))}</div>
  <div class="muted">
    ${
      p.currentRank && p.currentRank.winrate != null
        ? `Winrate: ${esc(String(p.currentRank.winrate))}% (${esc(
            String(p.currentRank.wins)
          )}-${esc(String(p.currentRank.losses))})`
        : "Winrate: —"
    }
  </div>
</div>

      </div>

      <div class="row">
        ${pending || `<span class="badge">Kein Pending Ban</span>`}
      </div>
      <div>
  <div class="muted" style="margin-bottom:6px;">Letzte 5 Games</div>
  <div class="last5">
    ${
      (p.last5?.games?.length ? p.last5.games : [])
        .map(
          (g) => `
          <div class="last5-item ${g.win ? "win" : "loss"}"
               title="${esc(g.championName)} · ${g.k}/${g.d}/${g.a} · ${
            g.win ? "Win" : "Loss"
          }">
            ${
              g.championIcon
                ? `<img src="${g.championIcon}" alt="${esc(g.championName)}"/>`
                : ""
            }
          </div>
        `
        )
        .join("") || `<span class="muted">Keine Daten.</span>`
    }
  </div>
</div>

      <div>
        <div class="muted" style="margin-bottom:6px;">Gebannte Champions</div>
        <div class="bans">
          ${
            (p.bans?.length ? p.bans : [])
              .map(
                (b) =>
                  `<span class="chip" title="${esc(fmtTime(b.time))}${
                    b.note ? " · " + esc(b.note) : ""
                  }">${esc(b.champion)}</span>`
              )
              .join("") || `<span class="muted">Noch keine.</span>`
          }
        </div>
      </div>

      <div class="row" style="justify-content:flex-end;">
      <button data-overview="${esc(p.id)}">Übersicht</button>
        <button data-ban="${esc(p.id)}" ${
      p.pendingBan ? "" : "disabled"
    } title="${p.pendingBan ? "" : "Nur möglich nach einem Uprank"}">
  Bann eintragen
</button>

      </div>
    `;

    div.querySelector(`[data-ban="${p.id}"]`).addEventListener("click", () => {
      if (!p.pendingBan) return; // NEU: keine manuellen Bans
      openBanModal(p);
    });
    div
      .querySelector(`[data-overview="${p.id}"]`)
      .addEventListener("click", async () => {
        // Modal sofort öffnen + Loading anzeigen
        ovTitle.textContent = `Übersicht: ${p.displayName}`;
        ovMostPlayed.innerHTML = `<div class="muted">Lade…</div>`;
        ovBans.innerHTML = `<div class="muted">Lade…</div>`;
        openOverviewModal();

        try {
          await loadChampionsOnce(); // für Ban-Icons

          const [ov, games] = await Promise.all([
            apiGetPlayerOverview(p.id),
            apiGetChampGames(p.id, 2026),
          ]);

          // falls Backend displayName liefert
          ovTitle.textContent = `Übersicht: ${ov.displayName || p.displayName}`;

          renderOverviewTilesMostPlayedFromGames(games.byChampion, ov.bans);
          renderOverviewTilesBans(ov.bans);
        } catch (e) {
          console.warn("Overview fehlgeschlagen:", e);
          alert(
            "Übersicht konnte nicht geladen werden: " + String(e?.message || e)
          );
          ovMostPlayed.innerHTML = `<div class="muted">Fehler: ${esc(
            String(e?.message || e)
          )}</div>`;
          ovBans.innerHTML = "";
        }
      });

    playersEl.appendChild(div);
  }
}

function renderHistory() {
  historyEl.innerHTML = "";
  const hist = Array.isArray(state.banHistory) ? state.banHistory : [];

  if (!hist.length) {
    historyEmptyEl.style.display = "block";
    return;
  }
  historyEmptyEl.style.display = "none";

  for (const h of hist) {
    const div = document.createElement("div");
    div.className = "hist-item";
    div.innerHTML = `
  <div style="font-weight:600;">
    ${esc(h.playerName)} · ${esc(h.champion)}
    ${
      h.promotion?.from && h.promotion?.to
        ? ` <span class="muted">· Uprank: ${esc(
            rankText(h.promotion.from)
          )} → ${esc(rankText(h.promotion.to))}</span>`
        : ""
    }
  </div>
  <div class="muted">
    ${esc(fmtTime(h.time))}${h.note ? " · " + esc(h.note) : ""}
  </div>
`;

    historyEl.appendChild(div);
  }
}

// UI events
btnRefresh.addEventListener("click", async () => {
  btnRefresh.disabled = true;
  try {
    await apiRefresh();
    setGlobalLastUpdate(state?.globalLastUpdatedAt || new Date().toISOString());
    render();
  } catch (e) {
    alert(String(e?.message || e));
  } finally {
    btnRefresh.disabled = false;
  }
});

btnCloseOverview.addEventListener("click", closeOverviewModal);
overviewBackdrop.addEventListener("click", (e) => {
  if (e.target === overviewBackdrop) closeOverviewModal();
});

btnCloseModal.addEventListener("click", closeBanModal);
btnCancelModal.addEventListener("click", closeBanModal);
modalBackdrop.addEventListener("click", (e) => {
  if (e.target === modalBackdrop) closeBanModal();
});

btnSaveBan.addEventListener("click", async () => {
  if (!modalPlayerId) return;
  if (!selectedChampion) {
    alert("Bitte einen Champion auswählen.");
    return;
  }

  btnSaveBan.disabled = true;
  try {
    await apiAddBan(
      modalPlayerId,
      selectedChampion.name,
      (mNote.value || "").trim()
    );
    closeBanModal();
    render();
  } catch (e) {
    alert(String(e?.message || e));
  } finally {
    btnSaveBan.disabled = false;
  }
});

// Initial load + auto refresh in UI
(async function init() {
  try {
    await apiRefresh(); // holt live von Riot
  } catch (e) {
    // falls Riot mal nicht geht: zeig wenigstens den letzten gespeicherten Stand
    console.warn("Initial refresh fehlgeschlagen:", e);
    await apiGetState();
  }

  // optional: globales Last-Update setzen
  if (typeof setGlobalLastUpdate === "function") {
    setGlobalLastUpdate(state?.globalLastUpdatedAt || new Date().toISOString());
  }

  render();
})();

mChampSearch.addEventListener("input", async () => {
  const player = state.players.find((p) => p.id === modalPlayerId);
  if (player) renderChampGrid(player);
});
