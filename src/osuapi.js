import axios from "axios";
import dotenv from "dotenv";

dotenv.config();

let token = null;
let tokenExpiresAt = 0;

// 1. Função para pegar o Token de Acesso (Login do Bot)
async function getToken() {
    // Se já temos um token válido, usa ele pra não ficar pedindo toda hora
    if (token && Date.now() < tokenExpiresAt) {
        return token;
    }

    try {
        const response = await axios.post("https://osu.ppy.sh/oauth/token", {
            client_id: process.env.OSU_CLIENT_ID,
            client_secret: process.env.OSU_CLIENT_SECRET,
            grant_type: "client_credentials",
            scope: "public"
        });

        token = response.data.access_token;
        // O token dura 1 dia, mas vamos renovar um pouco antes por segurança
        tokenExpiresAt = Date.now() + (response.data.expires_in * 1000) - 5000;
        
        console.log("🔑 Novo Token da API v2 gerado com sucesso!");
        return token;
    } catch (error) {
        console.error("❌ Erro ao pegar token da API osu!:", error.response?.data || error.message);
        return null;
    }
}

// 2. Função para pegar os dados da partida
export async function getMatchData(matchId) {
    const accessToken = await getToken();
    if (!accessToken) return null;

    try {
        const response = await axios.get(`https://osu.ppy.sh/api/v2/matches/${matchId}`, {
            headers: {
                "Authorization": `Bearer ${accessToken}`,
                "Content-Type": "application/json",
                "x-api-version": "20220705" // Garante que a estrutura do JSON não mude do nada
            }
        });
        return response.data;
    } catch (error) {
        console.error(`❌ Erro ao buscar match ${matchId}:`, error.response?.data || error.message);
        return null;
    }
}