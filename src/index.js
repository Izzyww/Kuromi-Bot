import dotenv from "dotenv";
import { Client, IntentsBitField, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } from "discord.js";
import utils from "./utils.js";
import { trackMatch } from "./osuTracker.js";
import { setupStandingsFormulas, resortGroupsBySeed, updateLobbyDateTime, updateLobbyReferee, syncGroupStandings, updateLobbySeriesScore } from "./googleSheets.js";

dotenv.config();
const REFEREE_ROLE_ID = "1157479282700992552";

const client = new Client({
    intents: [
        IntentsBitField.Flags.Guilds,
        IntentsBitField.Flags.GuildMembers,
        IntentsBitField.Flags.GuildMessages,
        IntentsBitField.Flags.MessageContent, 
    ],
});

client.on("ready", (c) => {
    console.log(`I am on!! 🦈🌸 Logged in as ${c.user.tag}`);
});

client.on("interactionCreate", async (interaction) => {

    // 1. COMANDO SLASH (/reschedule)
    if (interaction.isChatInputCommand()) {
        if (interaction.commandName === "reschedule") {
            const author = interaction.member;
            const opponent = interaction.options.getUser("player-do-time-adversário"); 
            const date = interaction.options.getString("nova-data");
            const time = interaction.options.getString("novo-horário");
            const lobby = interaction.options.getString("lobby")?.trim().toUpperCase();
            if (!lobby) {
                await interaction.reply({ content: "Lobby inválida.", ephemeral: true });
                return;
            }
            const datetime = `${date} ${time}`;

            // --- VALIDAÇÕES (Mantemos reply ephemeral aqui pois é rápido) ---
            if (author.id === opponent.id) {
                // Se der erro, responde rápido e para.
                await interaction.reply({ content: "Você não pode remarcar com você mesmo!", ephemeral: true });
                return;
            }
            if (!utils.validateDate(date) || !utils.validateTime(time)) {
                await interaction.reply({ content: "Data ou horário inválido!", ephemeral: true });
                return;
            }

            // --- CORREÇÃO ERRO 10062 ---
            await interaction.deferReply(); 

            try {
                const rescheduleEmbed = new EmbedBuilder()
                    .setColor(0xFFA07A)
                    .setTitle(`📅 Lobby ${lobby} - Reschedule`) 
                    .setDescription(`O capitão ${author} pediu um reschedule na partida contra o time de ${opponent}.`)
                    .setThumbnail(author.user.displayAvatarURL())
                    .addFields(
                        { name: 'Capitão Solicitante', value: `${author}`, inline: true },
                        { name: 'Capitão Adversário', value: `${opponent}`, inline: true },
                        { name: 'Lobby', value: `**${lobby}**`, inline: true },
                        { name: 'Nova Data', value: `**${date}**`, inline: true },
                        { name: 'Novo Horário', value: `**${time}**`, inline: true },
                        { name: 'Data e Horário (Completo)', value: `${datetime}`, inline: true }
                    )
                    .setTimestamp()
                    .setFooter({ text: `Lobby:${lobby} | Aprovação necessária de ${opponent.tag}` });

                const acceptButton = new ButtonBuilder()
                    .setCustomId('reschedule_accept')
                    .setLabel('Aceitar')
                    .setStyle(ButtonStyle.Success)
                    .setEmoji('✅');

                const declineButton = new ButtonBuilder()
                    .setCustomId('reschedule_decline')
                    .setLabel('Recusar')
                    .setStyle(ButtonStyle.Danger)
                    .setEmoji('❌');

                const buttonRow = new ActionRowBuilder().addComponents(acceptButton, declineButton);

                // MUDANÇA AQUI
                // De: interaction.reply(...)
                // Para: interaction.editReply(...)
                await interaction.editReply({
                    content: `${opponent}, você recebeu um pedido de reschedule.`,
                    embeds: [rescheduleEmbed],
                    components: [buttonRow]
                    // fetchReply: true não é necessário com editReply se não for usar a variável agora
                });
            } catch (error) {
                console.error("Erro ao enviar reschedule:", error);
                // Se der erro depois do defer, avisa o usuário
                await interaction.editReply({ content: "Houve um erro ao tentar processar o pedido." });
            }
        }   

        if (interaction.commandName === "track") {
            const hasRefereeRole = interaction.member?.roles?.cache?.has(REFEREE_ROLE_ID);
            if (!hasRefereeRole) {
                await interaction.reply({
                    content: "🚫 Apenas usuários com o cargo de referee podem usar este comando.",
                    ephemeral: true,
                });
                return;
            }

            const matchId = interaction.options.getInteger("id");
            const bestOf = interaction.options.getInteger("best_of") || 13; 
            const lobby = interaction.options.getString("lobby")?.trim().toUpperCase() || null;
            
            // 1. Avisa o Discord que vamos processar (Isso gera o "Pensando...")
            await interaction.deferReply({ ephemeral: true });
    
            try {
                // Tenta rodar a função. Se der erro AQUI DENTRO, ele pula pro 'catch'
                const success = await trackMatch(matchId, interaction.channel, bestOf, lobby);
    
                if (success) {
                    const pointsToWin = Math.ceil(bestOf / 2);
                    const lobbyText = lobby ? ` | Lobby: **${lobby}**` : "";
                    await interaction.editReply(`✅ Monitorando MP **${matchId}** (Melhor de ${bestOf} - Ganha com ${pointsToWin})${lobbyText}.`);
                } else {
                    // Se o trackMatch retornar false (ex: sala não existe ou já está monitorando)
                    await interaction.editReply(`❌ Não consegui entrar na sala **${matchId}**. Verifique se ela existe, se a senha do IRC está certa ou se eu já estou nela.`);
                }
    
            } catch (error) {
                // AQUI É A PROTEÇÃO
                // Se qualquer coisa explodir, o bot cai aqui em vez de travar
                console.error("ERRO FATAL NO COMANDO /TRACK:", error);
                
                await interaction.editReply({ 
                    content: `☠️ **Ocorreu um erro interno ao tentar rastrear a partida.**\nVerifique o terminal para mais detalhes.` 
                });
            }
        }

        if (interaction.commandName === "ref") {
            const lobby = interaction.options.getString("lobby")?.trim().toUpperCase();
            const username = interaction.options.getString("username")?.trim();
            const hasRefereeRole = interaction.member?.roles?.cache?.has(REFEREE_ROLE_ID);

            if (!hasRefereeRole) {
                await interaction.reply({
                    content: "🚫 Apenas usuários com o cargo de referee podem usar este comando.",
                    ephemeral: true,
                });
                return;
            }

            if (!lobby) {
                await interaction.reply({ content: "Lobby inválida.", ephemeral: true });
                return;
            }
            if (!username) {
                await interaction.reply({ content: "Username inválido.", ephemeral: true });
                return;
            }

            await interaction.deferReply({ ephemeral: true });

            try {
                await updateLobbyReferee(lobby, username);
                await interaction.editReply(`✅ Referee da lobby **${lobby}** atualizado para **${username}**.`);
            } catch (error) {
                console.error("Erro ao atualizar referee no Google Sheets:", error);
                await interaction.editReply("❌ Não consegui atualizar a coluna Referee na planilha.");
            }
        }

        if (interaction.commandName === "unref") {
            const lobby = interaction.options.getString("lobby")?.trim().toUpperCase();
            const hasRefereeRole = interaction.member?.roles?.cache?.has(REFEREE_ROLE_ID);

            if (!hasRefereeRole) {
                await interaction.reply({
                    content: "🚫 Apenas usuários com o cargo de referee podem usar este comando.",
                    ephemeral: true,
                });
                return;
            }

            if (!lobby) {
                await interaction.reply({ content: "Lobby inválida.", ephemeral: true });
                return;
            }

            await interaction.deferReply({ ephemeral: true });

            try {
                await updateLobbyReferee(lobby, "");
                await interaction.editReply(`✅ Referee da lobby **${lobby}** removido.`);
            } catch (error) {
                console.error("Erro ao remover referee no Google Sheets:", error);
                await interaction.editReply("❌ Não consegui remover o referee na planilha.");
            }
        }

        if (interaction.commandName === "standings") {
            const lobbyInput = interaction.options.getString("lobby")?.trim().toUpperCase();
            const hasRefereeRole = interaction.member?.roles?.cache?.has(REFEREE_ROLE_ID);

            if (!hasRefereeRole) {
                await interaction.reply({
                    content: "🚫 Apenas usuários com o cargo de referee podem usar este comando.",
                    ephemeral: true,
                });
                return;
            }

            if (!lobbyInput) {
                await interaction.reply({ content: "Lobby inválida.", ephemeral: true });
                return;
            }

            const groupCode = lobbyInput.charAt(0);
            await interaction.deferReply({ ephemeral: true });

            try {
                const result = await syncGroupStandings(groupCode);
                await interaction.editReply(`✅ Standings do grupo **${result.group}** atualizadas (${result.updatedRows} jogadores).`);
            } catch (error) {
                console.error("Erro ao recalcular standings:", error);
                await interaction.editReply("❌ Não consegui recalcular as standings desse grupo.");
            }
        }

        if (interaction.commandName === "score") {
            const lobby = interaction.options.getString("lobby")?.trim().toUpperCase();
            const team1 = interaction.options.getInteger("team1");
            const team2 = interaction.options.getInteger("team2");
            const hasRefereeRole = interaction.member?.roles?.cache?.has(REFEREE_ROLE_ID);

            if (!hasRefereeRole) {
                await interaction.reply({
                    content: "🚫 Apenas usuários com o cargo de referee podem usar este comando.",
                    ephemeral: true,
                });
                return;
            }

            if (!lobby || team1 == null || team2 == null) {
                await interaction.reply({ content: "Parâmetros inválidos.", ephemeral: true });
                return;
            }

            if (team1 < 0 || team2 < 0) {
                await interaction.reply({ content: "Scores não podem ser negativos.", ephemeral: true });
                return;
            }

            await interaction.deferReply({ ephemeral: true });

            try {
                await updateLobbySeriesScore(lobby, team1, team2);
                await interaction.editReply(
                    `✅ Score da lobby **${lobby}** atualizado para **${team1} x ${team2}** na planilha. As standings atualizam automaticamente pelas fórmulas da sheet.`
                );
            } catch (error) {
                console.error("Erro ao atualizar score manual:", error);
                await interaction.editReply("❌ Não consegui atualizar score na planilha.");
            }
        }

        if (interaction.commandName === "setup-standings") {
            const hasRefereeRole = interaction.member?.roles?.cache?.has(REFEREE_ROLE_ID);

            if (!hasRefereeRole) {
                await interaction.reply({
                    content: "🚫 Apenas usuários com o cargo de referee podem usar este comando.",
                    ephemeral: true,
                });
                return;
            }

            await interaction.deferReply({ ephemeral: true });

            try {
                const result = await setupStandingsFormulas();
                await interaction.editReply(
                    `✅ Fórmulas de standings configuradas em **${result.groups}** grupos (${result.updatesWritten} células). As standings agora atualizam automaticamente — o bot não precisa estar online.`
                );
            } catch (error) {
                console.error("Erro ao configurar fórmulas de standings:", error);
                await interaction.editReply(`❌ Não consegui configurar as fórmulas: ${error.message}`);
            }
        }

        if (interaction.commandName === "resort-groups") {
            const hasRefereeRole = interaction.member?.roles?.cache?.has(REFEREE_ROLE_ID);

            if (!hasRefereeRole) {
                await interaction.reply({
                    content: "🚫 Apenas usuários com o cargo de referee podem usar este comando.",
                    ephemeral: true,
                });
                return;
            }

            await interaction.deferReply({ ephemeral: true });

            try {
                const result = await resortGroupsBySeed();

                const fmtDivision = (name, entries) => {
                    if (entries.length === 0) return null;
                    const lines = entries
                        .map((e) => {
                            const arrow = e.position === e.from ? "=" : "←";
                            return `• **${e.position}** ${arrow} ${e.from}  _(avg seed ${e.avgSeed})_`;
                        })
                        .join("\n");
                    return `__**${name}**__\n${lines}`;
                };

                const parts = [
                    fmtDivision("Dreamers", result.dreamers),
                    fmtDivision("Mischiefs", result.mischiefs),
                ].filter(Boolean);

                if (result.swapped === 0) {
                    await interaction.editReply("ℹ️ Os grupos já estão ordenados por avg seed. Nada a mudar.");
                } else {
                    await interaction.editReply(
                        `✅ Grupos reordenados (${result.swapped} posições trocadas).\n\n` +
                        parts.join("\n\n") +
                        `\n\nAs fórmulas de standings foram regeneradas com os novos rosters.`
                    );
                }
            } catch (error) {
                console.error("Erro ao reordenar grupos:", error);
                await interaction.editReply(`❌ Não consegui reordenar os grupos: ${error.message}`);
            }
        }
    }
    // 2. BOTÕES (Aceitar/Recusar)
    if (interaction.isButton()) {
        if (!interaction.customId.startsWith('reschedule_')) return;

        // deferUpdate mantém a interação viva sem precisar responder nova msg
        await interaction.deferUpdate(); 

        const buttonUser = interaction.user;
        const customId = interaction.customId;
        const embed = interaction.message.embeds[0]; 

        const fieldSolicitante = embed.fields.find(f => f.name === 'Capitão Solicitante');
        const fieldAdversario = embed.fields.find(f => f.name === 'Capitão Adversário');
        const fieldLobby = embed.fields.find(f => f.name === 'Lobby');
        const fieldDate = embed.fields.find(f => f.name === 'Nova Data');
        const fieldTime = embed.fields.find(f => f.name === 'Novo Horário');
        const fieldDataHora = embed.fields.find(f => f.name.includes('Completo'));
        const lobbyCode = (fieldLobby?.value || "").replace(/\*/g, "").trim().toUpperCase();

        const opponentIdMatch = fieldAdversario.value.match(/<@!?(\d+)>/);
        const opponentId = opponentIdMatch ? opponentIdMatch[1] : null;

        if (buttonUser.id !== opponentId) {
            // Aqui usamos followUp com ephemeral porque já demos deferUpdate
            return interaction.followUp({ content: "🚫 Apenas o capitão adversário pode decidir isso.", ephemeral: true });
        }

        const newEmbed = EmbedBuilder.from(embed);
        const disabledRow = ActionRowBuilder.from(interaction.message.components[0]).components.map(btn => 
            btn.setDisabled(true)
        );

        let statusLog = "";
        const STAFF_CHANNEL_ID = "1330252766072799282"; 
        const STAFF_ROLE_ID = "1157479282700992552";

        let sheetUpdateError = null;

        if (customId === 'reschedule_accept') {
            newEmbed.setDescription(`${embed.description}\n\n**✅ Aceito:** O capitão ${buttonUser} confirmou a nova data.`);
            newEmbed.setColor(0x00FF00);
            statusLog = "✅ **[RESCHEDULE ACCEPTED]**";
            const dateValue = (fieldDate?.value || "").replace(/\*/g, "").trim();
            const timeValue = (fieldTime?.value || "").replace(/\*/g, "").trim();
            if (lobbyCode && dateValue && timeValue) {
                try {
                    const formattedDateForSheet = utils.formatDateForSheet(dateValue);
                    await updateLobbyDateTime(lobbyCode, formattedDateForSheet, timeValue);
                } catch (error) {
                    sheetUpdateError = error;
                    console.error("Erro ao atualizar Google Sheets:", error.message ?? error);
                    await interaction.followUp({
                        content: `⚠️ Reschedule aceito, mas não consegui atualizar a planilha para a lobby **${lobbyCode}**. Staff foi notificado.`,
                        ephemeral: true
                    });
                }
            }
        } else {
            newEmbed.setDescription(`${embed.description}\n\n**❌ Recusado:** O capitão ${buttonUser} recusou a data.`);
            newEmbed.setColor(0xFF0000);
            statusLog = "❌ **[RESCHEDULE DECLINED]**";
        }

        newEmbed.setFooter({ text: `Decisão tomada por ${buttonUser.tag} | Lobby: ${lobbyCode || "N/A"}`, iconURL: buttonUser.displayAvatarURL() });

        // Como usamos deferUpdate lá em cima, usamos editReply aqui para alterar a mensagem original
        await interaction.editReply({
            embeds: [newEmbed],
            components: [{ type: 1, components: disabledRow }]
        });

        const staffChannel = await interaction.client.channels.fetch(STAFF_CHANNEL_ID).catch(() => null);
        
        if (staffChannel) {
            const shouldPingStaff = customId !== 'reschedule_accept' || sheetUpdateError != null;
            const staffEmbed = new EmbedBuilder()
                .setTitle(statusLog)
                .setColor(customId === 'reschedule_accept' ? (sheetUpdateError ? 0xFFA500 : 0x00FF00) : 0xFF0000)
                .addFields(
                    { name: 'Lobby', value: lobbyCode || 'N/A', inline: true },
                    { name: 'Team Captain', value: fieldSolicitante.value, inline: true },
                    { name: 'Opponent Captain', value: fieldAdversario.value, inline: true },
                    { name: 'Date & Time', value: fieldDataHora ? fieldDataHora.value : 'N/A', inline: false }
                )
                .setTimestamp();

            if (sheetUpdateError) {
                staffEmbed.addFields({
                    name: '⚠️ Falha na Planilha',
                    value: `A planilha **não foi atualizada**.\nErro: \`${sheetUpdateError.message}\`\nAtualize manualmente a lobby **${lobbyCode}**.`,
                    inline: false
                });
            }

            await staffChannel.send({
                content: shouldPingStaff ? `<@&${STAFF_ROLE_ID}>` : undefined,
                embeds: [staffEmbed],
            });
        }
    }
});

client.login(process.env.TOKEN);