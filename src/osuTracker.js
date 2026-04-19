import BanchoClient from "bancho.js";
import { EmbedBuilder } from "discord.js";
import { getMatchData } from "./osuapi.js";
import dotenv from "dotenv";

dotenv.config();

const activeMatches = new Map();

const bancho = new BanchoClient.BanchoClient({
    username: process.env.OSU_IRC_USERNAME,
    password: process.env.OSU_IRC_PASSWORD,
});

bancho.connect().then(() => {
    console.log("🎮 Conectado ao osu! Bancho (IRC)");
}).catch(console.error);

bancho.on("CM", async (message) => {
    const channelName = message.channel.name;
    
    if (!activeMatches.has(channelName)) return;

    const matchState = activeMatches.get(channelName);
    const content = message.content;
    const user = message.user.ircUsername;

    // console.log(`[IRC ${channelName}] ${user}: ${content}`);

    if (user === "BanchoBot") {
        const msgLower = content.toLowerCase();

        if (msgLower.includes("the match has finished") || msgLower.includes("match history available")) {
            
            console.log("✅ FIM DE PARTIDA DETECTADO! Buscando dados na API...");
            await new Promise(r => setTimeout(r, 2000));

            const matchData = await getMatchData(matchState.matchId);

            if (!matchData) {
                matchState.discordChannel.send("⚠️ Erro ao pegar dados da API.");
                return;
            }

            const events = matchData.events;
            const lastEvent = events[events.length - 1];
            
            if (!lastEvent || !lastEvent.game) {
                console.log("❌ O último evento não foi um jogo válido.");
                return;
            }

            const game = lastEvent.game;
            const beatmap = game.beatmap;
            const beatmapUrl = `https://osu.ppy.sh/b/${beatmap.id}`;
            const coverUrl = beatmap.beatmapset?.covers?.cover || ""; 

            const getUserDetails = (userId) => {
                const userObj = matchData.users.find(u => u.id === userId);
                if (userObj) {
                    return {
                        name: userObj.username,
                        country: userObj.country_code.toLowerCase(),
                        avatar: userObj.avatar_url,
                        id: userId
                    };
                }
                return { name: `User ${userId}`, country: 'white', avatar: '', id: userId };
            };

            let blueScore = 0;
            let redScore = 0;
            let isTeamVs = false;
            
            const blueMembers = [];
            const redMembers = [];
            const allScores = [];

            const hasTeams = game.scores.some(s => s.match.team !== null && s.match.team !== undefined);

            if (hasTeams) {
                isTeamVs = true;
                game.scores.forEach(score => {
                    const points = score.total_score || score.score || 0;
                    const team = score.match.team;
                    const user = getUserDetails(score.user_id); 
                    
                    allScores.push({ user, points });

                    if (team === 'blue' || team === 1) {
                        blueScore += points;
                        blueMembers.push(user.name);
                    } 
                    else if (team === 'red' || team === 2) {
                        redScore += points;
                        redMembers.push(user.name);
                    }
                });
            } else {
                game.scores.forEach(score => {
                    const points = score.total_score || score.score || 0;
                    const user = getUserDetails(score.user_id);
                    allScores.push({ user, points });
                });
            }

            // Evita crash se allScores estiver vazio (ex: ninguém jogou)
            if (allScores.length === 0) {
                 console.log("⚠️ Nenhum score encontrado neste mapa.");
                 return;
            }

            allScores.sort((a, b) => b.points - a.points);
            const mvpData = allScores[0];

            const blueNameLabel = blueMembers.length > 0 ? blueMembers.join(", ") : "Time Azul";
            const redNameLabel = redMembers.length > 0 ? redMembers.join(", ") : "Time Vermelho";

            const embed = new EmbedBuilder()
                .setImage(coverUrl);

            // --- VARIÁVEL DE CONTROLE PARA PARAR O TRACK ---
            let matchEnded = false;

            if (isTeamVs) {
                let winnerTeam = "Empate";
                let color = 0x808080;

                if (redScore > blueScore) {
                    winnerTeam = "Time Vermelho"; 
                    color = 0xFF0000;
                    matchState.scoreRed += 1;
                } else if (blueScore > redScore) {
                    winnerTeam = "Time Azul"; 
                    color = 0x0000FF;
                    matchState.scoreBlue += 1;
                }

                const bo = matchState.bestOf; 
                const pointsToWin = Math.ceil(bo / 2); 
                const tiebreakerPoint = pointsToWin - 1; 

                let statusText = "";
                const lobbyLabel = matchState.lobbyCode ? ` | Lobby: ${matchState.lobbyCode}` : "";
                let footerText = `🏆 Vencedor: ${winnerTeam} | Match ID: ${matchState.matchId}${lobbyLabel}`;

                // --- LÓGICA DE FIM DE JOGO ---
                if (matchState.scoreRed >= pointsToWin) {
                    statusText = `\n👑 **A PARTIDA ACABOU!** Vitória de ${redNameLabel}!`;
                    embed.setTitle(`🏆 ${redNameLabel} VENCEU A PARTIDA!`);
                    color = 0xFFD700; 
                    matchEnded = true; // <--- MARCA O FIM
                } 
                else if (matchState.scoreBlue >= pointsToWin) {
                    statusText = `\n👑 **A PARTIDA ACABOU!** Vitória de ${blueNameLabel}!`;
                    embed.setTitle(`🏆 ${blueNameLabel} VENCEU A PARTIDA!`);
                    color = 0xFFD700; 
                    matchEnded = true; // <--- MARCA O FIM
                }
                else if (matchState.scoreRed === tiebreakerPoint && matchState.scoreBlue === tiebreakerPoint) {
                    statusText = `\n🔥 **TIEBREAKER TIME!!** 🔥`;
                    color = 0xFF4500; 
                    embed.setTitle(`${redNameLabel} VS ${blueNameLabel}`); 
                } else {
                    embed.setTitle(`${redNameLabel} VS ${blueNameLabel}`);
                }

                embed.setDescription(`**Mapa:** [${beatmap.beatmapset.title} [${beatmap.version}]](${beatmapUrl})${statusText}`);
                embed.setColor(color);
                
                embed.setFooter({ 
                    text: footerText,
                    iconURL: mvpData.user.avatar 
                });

                embed.addFields(
                    { 
                        name: '🏁 Placar', 
                        value: `🔴 ${redNameLabel} **${matchState.scoreRed}** — **${matchState.scoreBlue}** ${blueNameLabel} 🔵`, 
                        inline: false 
                    },
                    { name: `${redNameLabel}`, value: redScore.toLocaleString(), inline: true },
                    { name: `${blueNameLabel}`, value: blueScore.toLocaleString(), inline: true },
                    { name: 'Diferença', value: Math.abs(redScore - blueScore).toLocaleString(), inline: true },
                    { 
                        name: '🌟 Vencedor  ', 
                        value: `:flag_${mvpData.user.country}: **${mvpData.user.name}** com ${mvpData.points.toLocaleString()} pontos`, 
                        inline: false 
                    }
                );


            } else {
                // Modo Solo
                const winner = allScores[0];
                embed.setTitle(`🏆 Vencedor: ${winner.user.name}`);
                embed.setDescription(`**Mapa:** [${beatmap.beatmapset.title} [${beatmap.version}]](${beatmapUrl})`);
                embed.setColor(0x9B59B6);
                embed.setFooter({ text: `Match ID: ${matchState.matchId}`, iconURL: winner.user.avatar });
                
                let leaderboard = "";
                allScores.slice(0, 3).forEach((s, i) => {
                    const medal = i === 0 ? "🥇" : i === 1 ? "🥈" : "🥉";
                    leaderboard += `${medal} :flag_${s.user.country}: **${s.user.name}**: ${s.points.toLocaleString()}\n`;
                });
                embed.addFields({ name: 'Placar', value: leaderboard || "Sem dados" });
            }

            try {
                await matchState.discordChannel.send({ embeds: [embed] });

                // --- LIMPEZA AUTOMÁTICA ---
                // Se a partida acabou, sai do canal e limpa a memória
                if (matchEnded) {
                    const channel = bancho.getChannel(channelName);
                    await channel.leave(); // Sai do IRC
                    activeMatches.delete(channelName); // Apaga da memória
                    
                    console.log(`🏁 Partida ${matchState.matchId} finalizada. Bot desconectado.`);
                }   

            } catch (err) {
                console.error("Erro ao enviar embed:", err);
            }
        }
    }
});

export async function trackMatch(matchId, discordChannel, bestOf = 13, lobbyCode = null) {
    const channelName = `#mp_${matchId}`;

    // Se já estiver monitorando essa sala, avisa e não faz nada
    if (activeMatches.has(channelName)) {
        return false;
    }

    try {
        console.log(`Tentando conectar em: ${channelName}...`);
        const channel = bancho.getChannel(channelName);
        await channel.join();
        console.log(`✅ Entrei no canal IRC: ${channelName}`);

        activeMatches.set(channelName, {
            discordChannel: discordChannel,
            matchId: matchId,
            scoreBlue: 0,
            scoreRed: 0,
            bestOf: bestOf,
            lobbyCode: lobbyCode ? lobbyCode.trim().toUpperCase() : null,
        });

        return true; 
    } catch (error) {
        console.error("Erro ao entrar na sala:", error);
        return false;
    }
}