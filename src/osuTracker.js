import { EmbedBuilder } from "discord.js";
import { getMatchData } from "./osuapi.js";

/**
 * Match tracker that polls the osu! API v2 every ~20 s to detect newly
 * completed games in a multiplayer lobby, post Discord embeds with the
 * running BO score, and auto-stop once the BO winner is decided.
 *
 * Replaces the older IRC-based tracker (bancho.js). IRC required the bot
 * user to be inside the multiplayer room, which caused "No such channel"
 * errors whenever refs didn't add the bot. The API approach has no such
 * dependency — any match we can fetch from osu.ppy.sh works.
 */

const activeMatches = new Map(); // matchId → state
const POLL_INTERVAL_MS = 20_000;

function getUserDetails(userId, users) {
    const userObj = users?.find((u) => u.id === userId);
    if (userObj) {
        return {
            name: userObj.username,
            country: (userObj.country_code || "").toLowerCase(),
            avatar: userObj.avatar_url,
            id: userId,
        };
    }
    return { name: `User ${userId}`, country: "white", avatar: "", id: userId };
}

/** Head-to-head / unassigned slots still include `match.team: "none"` on legacy scores. */
function isTeamlessToken(t) {
    if (t == null) return true;
    if (typeof t === "string") {
        const L = t.trim().toLowerCase();
        return L === "" || L === "none" || L === "neutral";
    }
    return false;
}

/**
 * Team id from osu! API v2 `scores[].match.team` (shape differs slightly by version).
 */
function extractRawTeam(score) {
    const m = score?.match;
    if (!m) return null;
    let t = m.team;
    if (isTeamlessToken(t)) return null;
    if (typeof t === "object") {
        if ("id" in t && t.id != null) return t.id;
        if ("name" in t && t.name != null) {
            const name = t.name;
            return isTeamlessToken(name) ? null : name;
        }
        return null;
    }
    return t;
}

/**
 * osu! commonly serializes teams as 0 = red, 1 = blue. Some payloads use 1 = red, 2 = blue.
 * Pick mapping from the numeric values seen on this game's scores.
 */
function detectNumericTeamConvention(rawTeams) {
    let maxNum = -Infinity;
    for (const r of rawTeams) {
        let n = null;
        if (typeof r === "number" && Number.isFinite(r)) n = r;
        else if (typeof r === "string" && /^-?\d+$/.test(String(r).trim())) {
            n = Number(String(r).trim());
        }
        if (n != null) maxNum = Math.max(maxNum, n);
    }
    if (!Number.isFinite(maxNum)) return "zero_one";
    return maxNum >= 2 ? "one_two" : "zero_one";
}

/** @param {"zero_one" | "one_two"} convention */
function normalizeTeamSide(raw, convention) {
    if (raw == null) return null;
    if (typeof raw === "string") {
        const L = raw.trim().toLowerCase();
        if (L === "red") return "red";
        if (L === "blue") return "blue";
        if (/^-?\d+$/.test(L)) raw = Number(L);
        else return null;
    }
    if (typeof raw === "number" && Number.isFinite(raw)) {
        if (convention === "one_two") {
            if (raw === 1) return "red";
            if (raw === 2) return "blue";
        } else {
            if (raw === 0) return "red";
            if (raw === 1) return "blue";
        }
    }
    return null;
}

/** @returns {[string, string]|null} */
function parseVersusLabelsFromMatchName(name) {
    if (!name || typeof name !== "string") return null;
    const m = name.match(/\(([^)]+)\)\s+vs\s+\(([^)]+)\)/i);
    if (!m) return null;
    return [m[1].trim(), m[2].trim()];
}

function matchUserToTeamIndex(username, teamLabels) {
    if (!username || !teamLabels?.length) return null;
    const u = String(username).toLowerCase().trim();
    for (let i = 0; i < teamLabels.length; i += 1) {
        const L = String(teamLabels[i]).toLowerCase().trim();
        if (!L) continue;
        if (u === L || u.includes(L) || L.includes(u)) return i;
    }
    return null;
}

function findUserForTeamLabel(users, label) {
    if (!label || !users?.length) return null;
    const L = String(label).toLowerCase().trim();
    const exact = users.find((u) => String(u.username).toLowerCase() === L);
    if (exact) return exact;
    return users.find((u) => {
        const un = String(u.username).toLowerCase();
        return un.includes(L) || L.includes(un);
    });
}

/** Discord `:flag_xx:` from osu `country_code` (e.g. BR → br). */
function discordFlagFromCountryCode(code) {
    if (!code || String(code).length !== 2) return "";
    return `:flag_${String(code).toLowerCase()}:`;
}

/** Prefer romanized `artist` / `title`; fall back to `*_unicode` if missing. */
function pickBeatmapsetArtist(bs) {
    if (!bs) return "";
    const a = bs.artist;
    if (typeof a === "string" && a.trim()) return a.trim();
    const u = bs.artist_unicode;
    if (typeof u === "string" && u.trim()) return u.trim();
    return "";
}

function pickBeatmapsetTitle(bs) {
    if (!bs) return "";
    const t = bs.title;
    if (typeof t === "string" && t.trim()) return t.trim();
    const u = bs.title_unicode;
    if (typeof u === "string" && u.trim()) return u.trim();
    return "";
}

function osuMultiplayerMatchUrl(matchId) {
    if (matchId == null || matchId === "") return "";
    return `https://osu.ppy.sh/community/matches/${matchId}`;
}

function poolSlotLabelForBeatmap(state, beatmapId) {
    const bid = String(beatmapId);
    const raw = state?.slotByBeatmapId?.get(bid);
    if (raw == null) return null;
    const s = String(raw).trim();
    return s || null;
}

/** Live tracker map line: `**NM2:** [title [ver]](url)` or **Mapa:** if unknown pool slot. */
function liveMapDescriptionLine(beatmap, beatmapUrl, state, statusSuffix) {
    const bs = beatmap.beatmapset;
    const title = bs ? pickBeatmapsetTitle(bs) : "";
    const ver = beatmap.version || "";
    const mapLinkLabel = `${title} [${ver}]`.trim() || "beatmap";
    const slot = poolSlotLabelForBeatmap(state, beatmap.id);
    const prefix = slot ? `**${slot}:**` : "**Mapa:**";
    return `${prefix} [${mapLinkLabel}](${beatmapUrl})${statusSuffix}`;
}

/** @param {number} pickNumber 1-based
 *  @param {0|1} firstPickTeamIndex  which side opened picks (0 = first name in title, 1 = second) */
function teamIndexForPick(pickNumber, firstPickTeamIndex) {
    const odd = pickNumber % 2 === 1;
    if (firstPickTeamIndex === 0) return odd ? 0 : 1;
    return odd ? 1 : 0;
}

/**
 * Who won this finished game for series tally. Team-vs: red = first label, blue = second.
 * Head-to-head: winning username matched to labels.
 */
function gameWinnerTeamIndex(game, users, teamLabels) {
    const scoresRaw = game.scores || [];
    if (scoresRaw.length === 0 || !teamLabels || teamLabels.length < 2) return null;

    const allScores = scoresRaw.map((score) => ({
        user: getUserDetails(score.user_id, users),
        points: score.total_score || score.score || 0,
        rawTeam: extractRawTeam(score),
    }));
    const convention = detectNumericTeamConvention(allScores.map((s) => s.rawTeam));
    const hasTeams = allScores.some((s) => normalizeTeamSide(s.rawTeam, convention) != null);

    if (hasTeams) {
        let redScore = 0;
        let blueScore = 0;
        for (const s of allScores) {
            const side = normalizeTeamSide(s.rawTeam, convention);
            if (side === "red") redScore += s.points;
            else if (side === "blue") blueScore += s.points;
        }
        if (redScore === blueScore) return null;
        return redScore > blueScore ? 0 : 1;
    }

    allScores.sort((a, b) => b.points - a.points);
    const top = allScores[0];
    return matchUserToTeamIndex(top.user.name, teamLabels);
}

/**
 * @param {object} matchData  JSON from `GET /api/v2/matches/{id}`
 * @param {Map<string, string>} slotByBeatmapId
 * @param {number} firstPick1Based 1 = first name in `(A) vs (B)` had first pick, 2 = second
 */
export function buildPickRecapEmbed(matchData, slotByBeatmapId, firstPick1Based = 1) {
    const matchName = matchData?.match?.name || `Match ${matchData?.match?.id ?? ""}`;
    const teamLabels = parseVersusLabelsFromMatchName(matchName);
    const users = matchData.users || [];

    const completed = (matchData.events || [])
        .filter((e) => e.game?.end_time && e.game.beatmap)
        .sort((a, b) => a.id - b.id);

    if (completed.length === 0) return null;

    const firstPickIdx = Math.min(2, Math.max(1, firstPick1Based)) - 1;
    const firstPickLabel = teamLabels ? teamLabels[firstPickIdx] : null;

    const picksByTeam = teamLabels ? [[], []] : null;
    const linesFlat = [];

    for (let i = 0; i < completed.length; i += 1) {
        const pickNum = i + 1;
        const game = completed[i].game;
        const bm = game.beatmap;
        const bid = String(bm.id ?? game.beatmap_id ?? "");
        const slot = slotByBeatmapId.get(bid) ?? `?${bid}`;
        const url = `https://osu.ppy.sh/b/${bid}`;
        const artist = pickBeatmapsetArtist(bm.beatmapset);
        const title = pickBeatmapsetTitle(bm.beatmapset);
        const ver = bm.version || "";
        const line = `**${pickNum}.** [**${slot}**](${url}) ${artist} - ${title} [${ver}]`;

        if (teamLabels && picksByTeam) {
            const tIdx = teamIndexForPick(pickNum, firstPickIdx);
            picksByTeam[tIdx].push(line);
        } else {
            linesFlat.push(line);
        }
    }

    let wins = [0, 0];
    if (teamLabels) {
        for (const ev of completed) {
            const w = gameWinnerTeamIndex(ev.game, users, teamLabels);
            if (w === 0 || w === 1) wins[w] += 1;
        }
    }

    const titleStr = teamLabels ? `${teamLabels[0]} VS ${teamLabels[1]}` : matchName;
    const subtitle =
        teamLabels && firstPickLabel
            ? `\n**Pick Recap** (Primeiro pick: **${firstPickLabel}**)\n`
            : `\n**Pick Recap**\n`;

    let body = subtitle;
    if (teamLabels && picksByTeam) {
        const user0 = findUserForTeamLabel(users, teamLabels[0]);
        const user1 = findUserForTeamLabel(users, teamLabels[1]);
        const flag0 = discordFlagFromCountryCode(user0?.country_code);
        const flag1 = discordFlagFromCountryCode(user1?.country_code);
        const leftFlag = flag0 ? `${flag0} ` : "";
        const rightFlag = flag1 ? ` ${flag1}` : "";
        body += `**Placar (mapas):** ${leftFlag}${teamLabels[0]} **${wins[0]}** — **${wins[1]}** ${teamLabels[1]}${rightFlag}\n\n`;
        body += `**${teamLabels[0]}**\n${picksByTeam[0].join("\n") || "—"}\n\n`;
        body += `**${teamLabels[1]}**\n${picksByTeam[1].join("\n") || "—"}`;
    } else {
        body += linesFlat.join("\n");
    }

    const lastGame = completed[completed.length - 1]?.game;
    const lastBm = lastGame?.beatmap;
    const coverUrl =
        lastBm?.beatmapset?.covers?.["cover@2x"] || lastBm?.beatmapset?.covers?.cover || "";

    let winnerLine = "";
    if (teamLabels) {
        let winIdx = null;
        if (wins[0] > wins[1]) winIdx = 0;
        else if (wins[1] > wins[0]) winIdx = 1;
        else {
            const lw = lastGame ? gameWinnerTeamIndex(lastGame, users, teamLabels) : null;
            if (lw === 0 || lw === 1) winIdx = lw;
        }
        if (winIdx !== null) {
            winnerLine = `\n\n🏆 **${teamLabels[winIdx]} VENCEU A PARTIDA**`;
        }
    }

    const mpUrl = osuMultiplayerMatchUrl(matchData.match?.id);
    const mpLinkLine = mpUrl ? `\n\n🔗 [MP Link](${mpUrl})` : "";
    const tail = winnerLine + mpLinkLine;

    const maxDesc = 4096;
    let description = body + tail;
    if (description.length > maxDesc) {
        const reserve = tail.length + 4;
        const cap = maxDesc - reserve;
        description = `${body.slice(0, Math.max(0, cap))}…${tail}`;
        if (description.length > maxDesc) {
            description = `${description.slice(0, maxDesc - 1)}…`;
        }
    }

    const embed = new EmbedBuilder()
        .setColor(0xfce303)
        .setTitle(`ℹ️ ${titleStr}`)
        .setDescription(description);

    if (coverUrl) {
        embed.setImage(coverUrl);
    }

    return embed;
}

/**
 * Builds the embed for a completed game and updates the running BO score
 * on `state`. Returns `{ embed, matchEnded }` or null if the game should
 * be skipped (no scores, aborted beatmap, etc).
 *
 * Supports both team-vs (red/blue) and 1v1 head-to-head lobbies. Solo
 * head-to-head uses a per-user-id win counter on state.soloWins so the
 * BO runner-up threshold works the same way for 1v1s as it does for
 * team matches.
 */
function buildGameEmbed(game, users, state) {
    const beatmap = game.beatmap;
    if (!beatmap) return null;

    const scoresRaw = game.scores || [];
    if (scoresRaw.length === 0) return null;

    const allScores = scoresRaw.map((score) => ({
        user: getUserDetails(score.user_id, users),
        points: score.total_score || score.score || 0,
        rawTeam: extractRawTeam(score),
    }));
    allScores.sort((a, b) => b.points - a.points);

    // Legacy `legacy_match_score` rows often carry `match.team: "none"` even in "team" lobbies;
    // only treat as team-vs when at least one score resolves to red or blue.
    const convention = detectNumericTeamConvention(allScores.map((s) => s.rawTeam));
    const hasTeams = allScores.some((s) => normalizeTeamSide(s.rawTeam, convention) != null);

    if (hasTeams) {
        return buildTeamVsEmbed(beatmap, allScores, state, convention);
    }
    return buildHeadToHeadEmbed(beatmap, allScores, state);
}

function buildTeamVsEmbed(beatmap, allScores, state, convention) {
    const beatmapUrl = `https://osu.ppy.sh/b/${beatmap.id}`;
    const coverUrl = beatmap.beatmapset?.covers?.cover || "";

    let blueScore = 0;
    let redScore = 0;
    const blueMembers = [];
    const redMembers = [];

    for (const s of allScores) {
        const side = normalizeTeamSide(s.rawTeam, convention);
        if (side === "blue") {
            blueScore += s.points;
            blueMembers.push(s.user.name);
        } else if (side === "red") {
            redScore += s.points;
            redMembers.push(s.user.name);
        }
    }

    const mvpData = allScores[0];
    const blueNameLabel = blueMembers.length > 0 ? blueMembers.join(", ") : "Time Azul";
    const redNameLabel = redMembers.length > 0 ? redMembers.join(", ") : "Time Vermelho";

    let winnerTeam = "Empate";
    let color = 0x808080;
    if (redScore > blueScore) {
        winnerTeam = "Time Vermelho";
        color = 0xFF0000;
        state.scoreRed += 1;
    } else if (blueScore > redScore) {
        winnerTeam = "Time Azul";
        color = 0x0000FF;
        state.scoreBlue += 1;
    }

    const bo = state.bestOf;
    const pointsToWin = Math.ceil(bo / 2);
    const tiebreakerPoint = pointsToWin - 1;

    let statusText = "";
    const lobbyLabel = state.lobbyCode ? ` | Lobby: ${state.lobbyCode}` : "";
    const mpUrl = osuMultiplayerMatchUrl(state.matchId);
    const footerText = `🏆 Vencedor: ${winnerTeam}${lobbyLabel}${mpUrl ? ` | ${mpUrl}` : ""}`;

    const embed = new EmbedBuilder().setImage(coverUrl);
    let matchEnded = false;

    if (state.scoreRed >= pointsToWin) {
        statusText = `\n👑 **A PARTIDA ACABOU!** Vitória de ${redNameLabel}!`;
        embed.setTitle(`🏆 ${redNameLabel} VENCEU A PARTIDA!`);
        color = 0xFFD700;
        matchEnded = true;
    } else if (state.scoreBlue >= pointsToWin) {
        statusText = `\n👑 **A PARTIDA ACABOU!** Vitória de ${blueNameLabel}!`;
        embed.setTitle(`🏆 ${blueNameLabel} VENCEU A PARTIDA!`);
        color = 0xFFD700;
        matchEnded = true;
    } else if (state.scoreRed === tiebreakerPoint && state.scoreBlue === tiebreakerPoint) {
        statusText = `\n🔥 **TIEBREAKER TIME!!** 🔥`;
        color = 0xFF4500;
        embed.setTitle(`${redNameLabel} VS ${blueNameLabel}`);
    } else {
        embed.setTitle(`${redNameLabel} VS ${blueNameLabel}`);
    }

    embed.setDescription(liveMapDescriptionLine(beatmap, beatmapUrl, state, statusText));
    embed.setColor(color);
    embed.setFooter({ text: footerText, iconURL: mvpData.user.avatar });
    embed.addFields(
        {
            name: "🏁 Placar",
            value: `🔴 ${redNameLabel} **${state.scoreRed}** — **${state.scoreBlue}** ${blueNameLabel} 🔵`,
            inline: false,
        },
        { name: `${redNameLabel}`, value: redScore.toLocaleString(), inline: true },
        { name: `${blueNameLabel}`, value: blueScore.toLocaleString(), inline: true },
        { name: "Diferença", value: Math.abs(redScore - blueScore).toLocaleString(), inline: true },
        {
            name: "🌟 Vencedor  ",
            value: `:flag_${mvpData.user.country}: **${mvpData.user.name}** com ${mvpData.points.toLocaleString()} pontos`,
            inline: false,
        }
    );

    return { embed, matchEnded };
}

/**
 * Head-to-head 1v1 lobbies: track wins per user_id on state.soloWins.
 * First two players seen become the canonical "slot 1" / "slot 2" for the
 * embed's scoreboard line so the order stays stable across maps.
 */
function buildHeadToHeadEmbed(beatmap, allScores, state) {
    if (!state.soloWins) state.soloWins = new Map();
    if (!state.soloUsers) state.soloUsers = new Map();
    if (!state.soloOrder) state.soloOrder = [];

    // Register any new faces before crediting the map win.
    for (const s of allScores) {
        if (!state.soloUsers.has(s.user.id)) {
            state.soloUsers.set(s.user.id, s.user);
            state.soloWins.set(s.user.id, 0);
            state.soloOrder.push(s.user.id);
        }
    }

    const mvpData = allScores[0];
    state.soloWins.set(mvpData.user.id, (state.soloWins.get(mvpData.user.id) || 0) + 1);

    const bo = state.bestOf;
    const pointsToWin = Math.ceil(bo / 2);
    const tiebreakerPoint = pointsToWin - 1;

    const slot1Id = state.soloOrder[0];
    const slot2Id = state.soloOrder[1];
    const slot1 = slot1Id ? {
        user: state.soloUsers.get(slot1Id),
        wins: state.soloWins.get(slot1Id) || 0,
    } : null;
    const slot2 = slot2Id ? {
        user: state.soloUsers.get(slot2Id),
        wins: state.soloWins.get(slot2Id) || 0,
    } : null;

    const beatmapUrl = `https://osu.ppy.sh/b/${beatmap.id}`;
    const coverUrl = beatmap.beatmapset?.covers?.cover || "";
    const lobbyLabel = state.lobbyCode ? ` | Lobby: ${state.lobbyCode}` : "";
    const mpUrl = osuMultiplayerMatchUrl(state.matchId);

    const embed = new EmbedBuilder().setImage(coverUrl);
    let matchEnded = false;
    let color = 0x9B59B6;
    let statusText = "";
    let title;

    const topWins = Math.max(slot1?.wins || 0, slot2?.wins || 0);
    const bothAtTiebreaker = slot1 && slot2 && slot1.wins === tiebreakerPoint && slot2.wins === tiebreakerPoint;

    if (topWins >= pointsToWin) {
        // A slot has taken the BO — award to whichever crossed it.
        const winner = (slot1?.wins || 0) >= pointsToWin ? slot1 : slot2;
        title = `🏆 ${winner.user.name} VENCEU A PARTIDA!`;
        statusText = `\n👑 **A PARTIDA ACABOU!** Vitória de ${winner.user.name}!`;
        color = 0xFFD700;
        matchEnded = true;
    } else if (bothAtTiebreaker) {
        title = `${slot1.user.name} VS ${slot2.user.name}`;
        statusText = `\n🔥 **TIEBREAKER TIME!!** 🔥`;
        color = 0xFF4500;
    } else if (slot1 && slot2) {
        title = `${slot1.user.name} VS ${slot2.user.name}`;
    } else {
        title = slot1 ? slot1.user.name : mvpData.user.name;
    }

    embed.setTitle(title);
    embed.setDescription(liveMapDescriptionLine(beatmap, beatmapUrl, state, statusText));
    embed.setColor(color);
    embed.setFooter({
        text: `🏆 Vencedor: ${mvpData.user.name}${lobbyLabel}${mpUrl ? ` | ${mpUrl}` : ""}`,
        iconURL: mvpData.user.avatar,
    });

    if (slot1 && slot2) {
        embed.addFields({
            name: "🏁 Placar",
            value: `:flag_${slot1.user.country}: **${slot1.user.name}** ${slot1.wins} — ${slot2.wins} **${slot2.user.name}** :flag_${slot2.user.country}:`,
            inline: false,
        });
    }

    // Per-map leaderboard (top 3)
    const topMap = allScores.slice(0, 3).map((s, i) => {
        const medal = i === 0 ? "🥇" : i === 1 ? "🥈" : "🥉";
        return `${medal} :flag_${s.user.country}: **${s.user.name}**: ${s.points.toLocaleString()}`;
    }).join("\n");
    embed.addFields({ name: "Placar do mapa", value: topMap || "Sem dados", inline: false });

    return { embed, matchEnded };
}

/** Fetches latest match JSON and posts the yellow pick recap embed (live end or catch-up). */
async function sendPickRecapToChannel(matchId, discordChannel, slotByBeatmapId, firstPick1Based) {
    const matchData = await getMatchData(matchId);
    if (!matchData) {
        console.error(`Pick recap: sem dados da API para MP ${matchId}.`);
        return;
    }
    const slots = slotByBeatmapId instanceof Map ? slotByBeatmapId : new Map();
    const embed = buildPickRecapEmbed(matchData, slots, firstPick1Based);
    try {
        if (embed) {
            await discordChannel.send({ embeds: [embed] });
        }
    } catch (sendErr) {
        console.error(`Erro ao enviar pick recap MP ${matchId}:`, sendErr.message ?? sendErr);
    }
}

/** Post embeds for every completed game up to now (mid-match /track). */
async function replayCompletedGamesForChannel(matchData, state, discordChannel) {
    const events = matchData.events || [];
    const done = events.filter((e) => e.game && e.game.end_time).sort((a, b) => a.id - b.id);

    for (const event of done) {
        state.lastProcessedEventId = event.id;
        const result = buildGameEmbed(event.game, matchData.users, state);
        if (!result) continue;

        try {
            await discordChannel.send({ embeds: [result.embed] });
        } catch (sendErr) {
            console.error(
                `Erro ao enviar embed (replay) de MP ${state.matchId}:`,
                sendErr.message ?? sendErr
            );
        }

        if (result.matchEnded) {
            state.matchEnded = true;
            break;
        }
    }
}

async function pollMatch(matchId) {
    const state = activeMatches.get(matchId);
    if (!state) return;

    try {
        const matchData = await getMatchData(matchId);
        if (!matchData) return; // transient API error — try again next tick

        const events = matchData.events || [];

        const newCompletedGames = events.filter(
            (e) => e.game && e.game.end_time && e.id > state.lastProcessedEventId
        );

        newCompletedGames.sort((a, b) => a.id - b.id);

        for (const event of newCompletedGames) {
            state.lastProcessedEventId = event.id;

            const result = buildGameEmbed(event.game, matchData.users, state);
            if (!result) continue;

            try {
                await state.discordChannel.send({ embeds: [result.embed] });
            } catch (sendErr) {
                console.error(
                    `Erro ao enviar embed de MP ${matchId}:`,
                    sendErr.message ?? sendErr
                );
            }

            if (result.matchEnded) {
                state.matchEnded = true;
                break;
            }
        }

        if (state.matchEnded || matchData.match?.end_time) {
            await stopTracking(matchId);
        }
    } catch (err) {
        console.error(`Erro no polling de MP ${matchId}:`, err.message ?? err);
    }
}

async function notifyRunnerOfStop(state) {
    if (!state.runnerUser) return;
    const score = `${state.scoreRed}–${state.scoreBlue}`;
    const lobby = state.lobbyCode ? ` (${state.lobbyCode})` : "";
    try {
        await state.runnerUser.send(
            `Tracker da MP **${state.matchId}**${lobby} encerrado. Placar final: **${score}**.`
        );
    } catch (err) {
        // DMs may be blocked or the user left the guild — ignore quietly.
    }
}

async function stopTracking(matchId) {
    const state = activeMatches.get(matchId);
    if (!state) return;
    if (state.pollHandle) clearInterval(state.pollHandle);
    activeMatches.delete(matchId);
    console.log(`🏁 Tracker parado para MP ${matchId}.`);
    await sendPickRecapToChannel(
        matchId,
        state.discordChannel,
        state.slotByBeatmapId,
        state.firstPick1Based
    );
    notifyRunnerOfStop(state);
}

/**
 * Starts tracking a multiplayer match via the osu! API v2.
 *
 * Returns true when polling has been set up, false when the match doesn't
 * exist / can't be fetched / is already being tracked.
 *
 * Live: replays all finished maps to the channel (catch-up), then polls for new
 * games. Ended: posts pick recap only (no polling).
 *
 * @param {Map<string, string>|null|undefined} slotByBeatmapId  from `loadMappoolBeatmapSlotLookup`
 * @param {number} firstPick1Based  who opened picks: 1 = first name in `(A) vs (B)`, 2 = second
 * @returns {Promise<{ ok: boolean, postedRecap?: boolean }>}
 */
export async function trackMatch(
    matchId,
    discordChannel,
    bestOf = 13,
    lobbyCode = null,
    runnerUser = null,
    slotByBeatmapId = null,
    firstPick1Based
) {
    if (firstPick1Based !== 1 && firstPick1Based !== 2) {
        return { ok: false };
    }

    if (activeMatches.has(matchId)) {
        return { ok: false };
    }

    const matchData = await getMatchData(matchId);
    if (!matchData) {
        return { ok: false };
    }

    if (matchData.match?.end_time) {
        const slots = slotByBeatmapId instanceof Map ? slotByBeatmapId : new Map();
        const embed = buildPickRecapEmbed(matchData, slots, firstPick1Based);
        try {
            if (embed) {
                await discordChannel.send({ embeds: [embed] });
            } else {
                await discordChannel.send({
                    content: `MP **${matchId}** já encerrou, mas não há mapas concluídos no histórico da API.`,
                });
            }
        } catch (sendErr) {
            console.error(`Erro ao enviar recap da MP ${matchId}:`, sendErr.message ?? sendErr);
            return { ok: false };
        }
        return { ok: true, postedRecap: true };
    }

    const slots = slotByBeatmapId instanceof Map ? slotByBeatmapId : new Map();

    const state = {
        discordChannel,
        matchId,
        bestOf,
        lobbyCode: lobbyCode ? lobbyCode.trim().toUpperCase() : null,
        scoreBlue: 0,
        scoreRed: 0,
        lastProcessedEventId: 0,
        matchEnded: false,
        pollHandle: null,
        runnerUser,
        slotByBeatmapId: slots,
        firstPick1Based,
    };

    await replayCompletedGamesForChannel(matchData, state, discordChannel);

    if (state.matchEnded) {
        await sendPickRecapToChannel(matchId, discordChannel, slots, firstPick1Based);
        notifyRunnerOfStop(state);
        console.log(`🏁 MP ${matchId}: placar final após replay — recap enviado, sem polling.`);
        return { ok: true, postedRecap: true };
    }

    state.pollHandle = setInterval(() => pollMatch(matchId), POLL_INTERVAL_MS);
    activeMatches.set(matchId, state);

    console.log(`🎮 Tracker iniciado para MP ${matchId} (BO${bestOf}) via API v2.`);
    return { ok: true, postedRecap: false };
}
