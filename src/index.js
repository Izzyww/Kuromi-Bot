import dotenv from "dotenv";
import { Client, IntentsBitField } from "discord.js";

import utils from "./utils.js";

dotenv.config();

const client = new Client({
    intents: [
        IntentsBitField.Flags.Guilds,
        IntentsBitField.Flags.GuildMembers,
        IntentsBitField.Flags.GuildMessages,
        IntentsBitField.Flags.MessageContent,
        IntentsBitField.Flags.GuildMessageReactions,
    ],
});

client.on("ready", (c) => {
    console.log("I am on!! 🦈🌸");
});

client.on("messageCreate", (message) => {
    if (message.content === "oi kuromi") {
        message.reply("fodase");
    }
});

client.on("interactionCreate", async (interaction) => {
    if (!interaction.isChatInputCommand()) {
        return;
    }

    if (interaction.commandName === "reschedule") {
        const author = interaction.member;
        const opponent = interaction.options.get("capitão-do-time-adversário").user;
        const date = interaction.options.get("data").value;
        const time = interaction.options.get("horário").value;
        const datetime = `${date} ${time}`;

        if (author.id == opponent.id) {
            await interaction.reply("Você não pode dar reschedule com si mesmo!!");
            return;
        }

        if (!utils.validateDate(date)) {
            await interaction.reply("Dia/mês inválido!");
            return;
        }

        if (!utils.validateTime(time)) {
            await interaction.reply("Horário inválido!");
            return;
        }

        const interactionCallbackResponse = await interaction.reply({
            content: `${opponent}, ${author} quer remarcar sua partida para ${utils.formatDatetime(datetime)}, você aceita?`,
            withResponse: true,
        });

        const message = interactionCallbackResponse.resource.message;
        await message.react("✅");
        await message.react("❌");
    }
});

client.on("messageReactionAdd", async (messageReaction, user, details) => {
    if (user.bot) {
        return;
    }

    const member = messageReaction.message.mentions.members.at(0);
    const emojiName = messageReaction.emoji.name;
    const message = messageReaction.message;
    const channel = message.channel;
    const adminChannelId = "1330252766072799282";

    if (channel.id != adminChannelId) {
        if (user.id != member.id) {
            return;
        }

        if (message.editedAt != null) {
            return;
        }

        if (emojiName == "✅") {
            await message.edit(utils.appendSection(message.content, `${user} aceitou o reschedule, esperando aprovação da staff...`));
            const adminChannel = await client.channels.fetch(adminChannelId);

            if (!adminChannel.isSendable()) {
                return;
            }

            const messageLink = `https://discord.com/channels/${message.guildId}/${message.channelId}/${message.id}`
            const adminMessage = await adminChannel.send(
                `${messageLink}\n${user} aceitou o reschedule solicitado por ${message.interactionMetadata.user}, esperando aprovação...`
            );

            await adminMessage.react("✅");
            await adminMessage.react("❌");
        }

        if (emojiName == "❌") {
            await message.edit(utils.appendSection(message.content, `${user} recusou o reschedule, combinem outro horário.`));
        }

        return;
    }

    if (message.editedAt != null) {
        return;
    }

    const [guestChannelId, guestMessageId] = message.content.match(/channels\/\d+\/(\d+)\/(\d+)/).slice(1);
    const guestChannel = await client.channels.fetch(guestChannelId);
    const guestMessage = await guestChannel.messages.fetch(guestMessageId);

    if (emojiName == "✅") {
        await message.edit(utils.appendSection(message.content, "Schedule aceito."));

        await guestMessage.edit(
            utils.appendSection(guestMessage.content, "A staff aceitou seu pedido, seu schedule será editado na main sheet logo.")
        );
    }

    if (emojiName == "❌") {
        await message.edit(utils.appendSection(message.content, "Schedule recusado."));

        await guestMessage.edit(
            utils.appendSection(guestMessage.content, "A staff recusou seu pedido, por favor escolha outro horário.")
        );
    }
});

client.login(process.env.TOKEN);
