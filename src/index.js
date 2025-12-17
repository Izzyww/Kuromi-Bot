import dotenv from "dotenv";
import { Client, IntentsBitField, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } from "discord.js";
import utils from "./utils.js";
import { trackMatch } from "./osuTracker.js";

dotenv.config();

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
            const opponent = interaction.options.getUser("capitão-do-time-adversário"); 
            const date = interaction.options.getString("data");
            const time = interaction.options.getString("horário");
            const id = interaction.options.getInteger("id");
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
                    .setTitle(`📅 Match ID: ${id} - Reschedule`) 
                    .setDescription(`O capitão ${author} pediu um reschedule na partida contra o time de ${opponent}.`)
                    .setThumbnail(author.user.displayAvatarURL())
                    .addFields(
                        { name: 'Capitão Solicitante', value: `${author}`, inline: true },
                        { name: 'Capitão Adversário', value: `${opponent}`, inline: true },
                        { name: '\u200B', value: '\u200B', inline: true },
                        { name: 'Nova Data', value: `**${date}**`, inline: true },
                        { name: 'Novo Horário', value: `**${time}**`, inline: true },
                        { name: 'Data e Horário (Completo)', value: `${datetime}`, inline: true }
                    )
                    .setTimestamp()
                    .setFooter({ text: `ID:${id} | Aprovação necessária de ${opponent.tag}` });

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
            const matchId = interaction.options.getInteger("id");
            const bestOf = interaction.options.getInteger("best_of") || 13; 
            
            // 1. Avisa o Discord que vamos processar (Isso gera o "Pensando...")
            await interaction.deferReply({ ephemeral: true });
    
            try {
                // Tenta rodar a função. Se der erro AQUI DENTRO, ele pula pro 'catch'
                const success = await trackMatch(matchId, interaction.channel, bestOf);
    
                if (success) {
                    const pointsToWin = Math.ceil(bestOf / 2);
                    await interaction.editReply(`✅ Monitorando MP **${matchId}** (Melhor de ${bestOf} - Ganha com ${pointsToWin}).`);
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
        const fieldDataHora = embed.fields.find(f => f.name.includes('Completo'));
        
        const footerText = embed.footer.text; 
        const matchId = footerText.split('|')[0].replace('ID:', '').trim(); 

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

        if (customId === 'reschedule_accept') {
            newEmbed.setDescription(`${embed.description}\n\n**✅ Aceito:** O capitão ${buttonUser} confirmou a nova data.`);
            newEmbed.setColor(0x00FF00); // Verde Hex direto (ButtonStyle as vezes buga em cor de embed)
            statusLog = "✅ **[RESCHEDULE ACCEPTED]**";
        } else {
            newEmbed.setDescription(`${embed.description}\n\n**❌ Recusado:** O capitão ${buttonUser} recusou a data.`);
            newEmbed.setColor(0xFF0000); // Vermelho Hex
            statusLog = "❌ **[RESCHEDULE DECLINED]**";
        }

        newEmbed.setFooter({ text: `Decisão tomada por ${buttonUser.tag} | Match ID: ${matchId}`, iconURL: buttonUser.displayAvatarURL() });

        // Como usamos deferUpdate lá em cima, usamos editReply aqui para alterar a mensagem original
        await interaction.editReply({
            embeds: [newEmbed],
            components: [{ type: 1, components: disabledRow }]
        });

        const staffChannel = await interaction.client.channels.fetch(STAFF_CHANNEL_ID).catch(() => null);
        
        if (staffChannel) {
            await staffChannel.send({
                content: `<@&${STAFF_ROLE_ID}>`, 
                embeds: [
                    new EmbedBuilder()
                        .setTitle(statusLog)
                        .setColor(customId === 'reschedule_accept' ? 0x00FF00 : 0xFF0000)
                        .addFields(
                            { name: 'Match ID', value: matchId, inline: true },
                            { name: 'Team Captain', value: fieldSolicitante.value, inline: true },
                            { name: 'Opponent Captain', value: fieldAdversario.value, inline: true },
                            { name: 'Date & Time', value: fieldDataHora ? fieldDataHora.value : 'N/A', inline: false }
                        )
                        .setTimestamp()
                ]
            });
        }
    }
});

client.login(process.env.TOKEN);