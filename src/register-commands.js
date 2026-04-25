import dotenv from "dotenv";
import { REST, Routes, ApplicationCommandOptionType } from "discord.js";

dotenv.config();

const commands = [
   
    {
        name: 'track',
        description: 'Começa a monitorar uma partida de osu!',
        options: [
            {
                name: 'id',
                description: 'O ID da partida (os números no fim do link)',
                type: 4, 
                required: true,
            },
            {
                name: 'best_of',
                description: 'Ex. bo9, bo11, bo13..',
                type: 4, 
                required: true,
            },
            {
                name: "first_pick",
                description: "Quem fez o primeiro pick: 1 = primeiro nome em (A) vs (B), 2 = segundo",
                type: ApplicationCommandOptionType.Integer,
                required: true,
                min_value: 1,
                max_value: 2,
            },
            {
                name: "lobby",
                description: "Código da lobby para sync na planilha (ex.: B1)",
                type: ApplicationCommandOptionType.String,
                required: false,
            },
        ],
    },
   
    {
        name: "reschedule",
        description: "Remarcar partida",
        options: [
            {
                name: "player-do-time-adversário",
                description: "Jogador do time adversário",
                type: ApplicationCommandOptionType.User,
                required: true,
            },
            {
                name: "lobby",
                description: "Código da lobby na planilha (ex.: B1)",
                type: ApplicationCommandOptionType.String,
                required: true,
            },
            {
                name: "nova-data",
                description: "dia da partida (use por exemplo, 03/04)",
                type: ApplicationCommandOptionType.String,
                required: true,
            }, 
            {
                name: "novo-horário",
                description: "Horário(use por exemplo, 15:00)",
                type: ApplicationCommandOptionType.String,
                required: true,
            },
        ],
    },
    {
        name: "ref",
        description: "Define o árbitro da lobby na planilha",
        options: [
            {
                name: "lobby",
                description: "Código da lobby na planilha (ex.: B1)",
                type: ApplicationCommandOptionType.String,
                required: true,
            },
            {
                name: "username",
                description: "Nome do referee para salvar na coluna Referee",
                type: ApplicationCommandOptionType.String,
                required: true,
            },
        ],
    },
    {
        name: "unref",
        description: "Remove o árbitro de uma lobby na planilha",
        options: [
            {
                name: "lobby",
                description: "Código da lobby na planilha (ex.: B1)",
                type: ApplicationCommandOptionType.String,
                required: true,
            },
        ],
    },
    {
        name: "standings",
        description: "Recalcula standings de um grupo (W/L/PF/PA/PD)",
        default_member_permissions: "0",
        options: [
            {
                name: "lobby",
                description: "Lobby ou grupo (ex.: B1 ou B)",
                type: ApplicationCommandOptionType.String,
                required: true,
            },
        ],
    },
    {
        name: "score",
        description: "Atualiza score de uma lobby e recalcula standings",
        default_member_permissions: "0",
        options: [
            {
                name: "lobby",
                description: "Código da lobby (ex.: B1)",
                type: ApplicationCommandOptionType.String,
                required: true,
            },
            {
                name: "team1",
                description: "Pontos do Team 1 (backend sheet)",
                type: ApplicationCommandOptionType.Integer,
                required: true,
            },
            {
                name: "team2",
                description: "Pontos do Team 2 (backend sheet)",
                type: ApplicationCommandOptionType.Integer,
                required: true,
            },
        ],
    },
    {
        name: "setup-standings",
        description: "Escreve fórmulas de standings na sheet 2 (roda uma vez, funciona sem o bot online)",
        default_member_permissions: "0",
    },
    {
        name: "resort-groups",
        description: "Reordena grupos (A-D Dreamers, E-H Mischiefs) por avg seed — menor seed = grupo A/E",
        default_member_permissions: "0",
    },
    {
        name: "sync-ids",
        description: "Atualiza a coluna ID da ref sheet (col I) com os códigos atuais (A1, D3...) da sheet 2",
        default_member_permissions: "0",
    },
    {
        name: "setup-mp-vod-links",
        description: "Escreve fórmulas nas colunas S e T (links MP/VOD) da sheet principal a partir da Schedule",
        default_member_permissions: "0",
        options: [
            {
                name: "primeira_linha",
                description: "Primeira linha com fórmulas (default 4 ou GOOGLE_GROUPS_LINK_FORMULAS_START_ROW)",
                type: ApplicationCommandOptionType.Integer,
                required: false,
                min_value: 1,
            },
            {
                name: "quantidade_linhas",
                description: "Quantas linhas preencher (default 500 ou GOOGLE_GROUPS_LINK_FORMULAS_ROW_COUNT, máx 3000)",
                type: ApplicationCommandOptionType.Integer,
                required: false,
                min_value: 1,
                max_value: 3000,
            },
        ],
    },
    {
        name: "sync-mp-vod-squares",
        description: "Main sheet: colunas S e T com ■ hiperligados (ref Schedule O/Q, cores por grupo)",
        default_member_permissions: "0",
        options: [
            {
                name: "primeira_linha",
                description: "Primeira linha (default 4 ou GOOGLE_GROUPS_LINK_FORMULAS_START_ROW)",
                type: ApplicationCommandOptionType.Integer,
                required: false,
                min_value: 1,
            },
            {
                name: "quantidade_linhas",
                description: "Quantas linhas (default 500 ou GOOGLE_GROUPS_LINK_FORMULAS_ROW_COUNT, máx 3000)",
                type: ApplicationCommandOptionType.Integer,
                required: false,
                min_value: 1,
                max_value: 3000,
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
