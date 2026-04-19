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
        team: score.match?.team ?? null,
    }));
    allScores.sort((a, b) => b.points - a.points);

    const hasTeams = allScores.some((s) => s.team != null);

    if (hasTeams) {
        return buildTeamVsEmbed(beatmap, allScores, state);
    }
    return buildHeadToHeadEmbed(beatmap, allScores, state);
}

function buildTeamVsEmbed(beatmap, allScores, state) {
    const beatmapUrl = `https://osu.ppy.sh/b/${beatmap.id}`;
    const coverUrl = beatmap.beatmapset?.covers?.cover || "";

    let blueScore = 0;
    let redScore = 0;
    const blueMembers = [];
    const redMembers = [];

    for (const s of allScores) {
        if (s.team === "blue" || s.team === 1) {
            blueScore += s.points;
            blueMembers.push(s.user.name);
        } else if (s.team === "red" || s.team === 2) {
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
    const footerText = `🏆 Vencedor: ${winnerTeam} | Match ID: ${state.matchId}${lobbyLabel}`;

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

    embed.setDescription(
        `**Mapa:** [${beatmap.beatmapset.title} [${beatmap.version}]](${beatmapUrl})${statusText}`
    );
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
    embed.setDescription(
        `**Mapa:** [${beatmap.beatmapset.title} [${beatmap.version}]](${beatmapUrl})${statusText}`
    );
    embed.setColor(color);
    embed.setFooter({
        text: `🏆 Vencedor: ${mvpData.user.name} | Match ID: ${state.matchId}${lobbyLabel}`,
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

async function pollMatch(matchId) {
    const state = activeMatches.get(matchId);
    if (!state) return;

    try {
        const matchData = await getMatchData(matchId);
        if (!matchData) return; // transient API error — try again next tick

        const events = matchData.events || [];

        // Only process completed game events we haven't seen yet.
        // event.game.end_time is set once a map finishes; null means still playing.
        const newCompletedGames = events.filter(
            (e) => e.game && e.game.end_time && e.id > state.lastProcessedEventId
        );

        // Sort ascending just in case (API returns oldest-first, but belt + suspenders)
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

        // Stop polling when the BO is decided OR the lobby closed on osu's side.
        if (state.matchEnded || matchData.match?.end_time) {
            stopTracking(matchId);
        }
    } catch (err) {
        // Non-fatal: log and keep polling. Next tick may succeed.
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

function stopTracking(matchId) {
    const state = activeMatches.get(matchId);
    if (!state) return;
    if (state.pollHandle) clearInterval(state.pollHandle);
    activeMatches.delete(matchId);
    console.log(`🏁 Tracker parado para MP ${matchId}.`);
    // Fire-and-forget DM to the person who ran /track — kept off the public
    // channel so the rest of the guild doesn't get a "stopped" spam.
    notifyRunnerOfStop(state);
}

/**
 * Starts tracking a multiplayer match via the osu! API v2.
 *
 * Returns true when polling has been set up, false when the match doesn't
 * exist / can't be fetched / is already being tracked.
 *
 * By default we anchor at the match's current latest event id, so past games
 * aren't retroactively counted — scoring starts from 0-0 and only games
 * completed AFTER /track ran contribute. Only team-vs games are reported;
 * solo/head-to-head games are silently skipped.
 *
 * @param {number} matchId
 * @param {import("discord.js").TextBasedChannel} discordChannel
 * @param {number} bestOf
 * @param {string|null} lobbyCode
 * @param {import("discord.js").User|null} runnerUser  - DM'd privately when the tracker stops.
 * @returns {Promise<boolean>}
 */
export async function trackMatch(matchId, discordChannel, bestOf = 13, lobbyCode = null, runnerUser = null) {
    if (activeMatches.has(matchId)) {
        return false;
    }

    const matchData = await getMatchData(matchId);
    if (!matchData) {
        return false;
    }

    const events = matchData.events || [];
    const lastEventId = events.length > 0 ? events[events.length - 1].id : 0;

    const state = {
        discordChannel,
        matchId,
        bestOf,
        lobbyCode: lobbyCode ? lobbyCode.trim().toUpperCase() : null,
        scoreBlue: 0,
        scoreRed: 0,
        lastProcessedEventId: lastEventId,
        matchEnded: false,
        pollHandle: null,
        runnerUser,
    };

    state.pollHandle = setInterval(() => pollMatch(matchId), POLL_INTERVAL_MS);
    activeMatches.set(matchId, state);

    console.log(`🎮 Tracker iniciado para MP ${matchId} (BO${bestOf}) via API v2.`);
    return true;
}
