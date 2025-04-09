import dotenv from "dotenv";
import { REST, Routes, ApplicationCommandOptionType } from "discord.js";

dotenv.config();

const commands = [
    {
        name: "reschedule",
        description: "Remarcar partida",
        options: [
            {
                name: "capitão-do-time-adversário",
                description: "Capitão do time adversário",
                type: ApplicationCommandOptionType.User,
                required: true,
            },
            {
                name: "data",
                description: "dia da partida (use por exemplo, 03/04)",
                type: ApplicationCommandOptionType.String,
                required: true,
            },
            {
                name: "horário",
                description: "Horário(use por exemplo, 15:00)",
                type: ApplicationCommandOptionType.String,
                required: true,
            },
        ],
    },
];

const rest = new REST({ version: 10 }).setToken(process.env.TOKEN);

(async () => {
    try {
        console.log("Registering slash commands...");

        await rest.put(
            Routes.applicationGuildCommands(
                process.env.CLIENT_ID,
                process.env.GUILD_ID
            ),
            { body: commands }
        );

        console.log("Slash commands were registered successfully");
    } catch (error) {
        console.error(`QUEBREI AQUI!!!! 🔴 ${error}`);
    }
})();
