import dotenv from "dotenv";
import { google } from "googleapis";

dotenv.config();

let sheetsClient = null;
const DEFAULT_GROUPS_SPREADSHEET_ID = "18kTX8-XpCy0D37ez7tV-yg_UBTdJLkxvwXiDIHWeLBU";
const DEFAULT_GROUPS_TAB_NAME = "groups schedule";

function getSheetsClient() {
    if (sheetsClient) {
        return sheetsClient;
    }

    const serviceEmail = process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL;
    const servicePrivateKey = process.env.GOOGLE_PRIVATE_KEY?.replace(/\\n/g, "\n");

    if (!serviceEmail || !servicePrivateKey) {
        throw new Error("Google Sheets credentials are missing in environment variables.");
    }

    const auth = new google.auth.JWT({
        email: serviceEmail,
        key: servicePrivateKey,
        scopes: ["https://www.googleapis.com/auth/spreadsheets"],
    });

    sheetsClient = google.sheets({
        version: "v4",
        auth,
    });

    return sheetsClient;
}

async function findLobbyRow(sheets, spreadsheetId, sheetName, lobbyColumn, lobbyCode) {
    const normalizedLobby = lobbyCode.trim().toUpperCase();
    const getRange = `${sheetName}!${lobbyColumn}:${lobbyColumn}`;
    const response = await sheets.spreadsheets.values.get({
        spreadsheetId,
        range: getRange,
    });

    const rows = response.data.values || [];

    for (let index = 0; index < rows.length; index += 1) {
        const value = (rows[index]?.[0] || "").trim().toUpperCase();
        if (value === normalizedLobby) {
            return index + 1;
        }
    }

    return -1;
}

/**
 * @param {string} lobbyCode
 * @param {string} dateValue
 * @param {string} timeValue
 * @returns {Promise<{ rowNumber: number, lobbyColumnLetter: string }>}
 */
export async function updateLobbyDateTime(lobbyCode, dateValue, timeValue) {
    const spreadsheetId = process.env.GOOGLE_SHEETS_ID;
    const sheetName = process.env.GOOGLE_SHEETS_TAB_NAME || "Sheet1";
    const lobbyColumn = process.env.GOOGLE_SHEETS_LOBBY_COLUMN || "A";
    const dateColumn = process.env.GOOGLE_SHEETS_DATE_COLUMN;
    const timeColumn = process.env.GOOGLE_SHEETS_TIME_COLUMN;
    const datetimeColumn = process.env.GOOGLE_SHEETS_DATETIME_COLUMN;

    if (!spreadsheetId) {
        throw new Error("GOOGLE_SHEETS_ID is not configured.");
    }

    if ((!dateColumn || !timeColumn) && !datetimeColumn) {
        throw new Error(
            "Set GOOGLE_SHEETS_DATE_COLUMN and GOOGLE_SHEETS_TIME_COLUMN, or keep GOOGLE_SHEETS_DATETIME_COLUMN as fallback."
        );
    }

    const sheets = getSheetsClient();
    const rowNumber = await findLobbyRow(sheets, spreadsheetId, sheetName, lobbyColumn, lobbyCode);

    if (rowNumber === -1) {
        throw new Error(`Lobby "${lobbyCode}" was not found in the sheet.`);
    }

    if (dateColumn && timeColumn) {
        await sheets.spreadsheets.values.batchUpdate({
            spreadsheetId,
            requestBody: {
                valueInputOption: "USER_ENTERED",
                data: [
                    {
                        range: `${sheetName}!${dateColumn}${rowNumber}`,
                        values: [[dateValue]],
                    },
                    {
                        range: `${sheetName}!${timeColumn}${rowNumber}`,
                        values: [[timeValue]],
                    },
                ],
            },
        });
    } else {
        const datetime = `${dateValue} ${timeValue}`.trim();
        const updateRange = `${sheetName}!${datetimeColumn}${rowNumber}`;

        await sheets.spreadsheets.values.update({
            spreadsheetId,
            range: updateRange,
            valueInputOption: "USER_ENTERED",
            requestBody: {
                values: [[datetime]],
            },
        });
    }

    return {
        rowNumber,
        lobbyColumnLetter: lobbyColumn,
    };
}

/**
 * @param {string} lobbyCode
 * @param {string} refereeValue
 * @returns {Promise<{ rowNumber: number, refereeColumnLetter: string }>}
 */
export async function updateLobbyReferee(lobbyCode, refereeValue) {
    const spreadsheetId = process.env.GOOGLE_SHEETS_ID;
    const sheetName = process.env.GOOGLE_SHEETS_TAB_NAME || "Sheet1";
    const lobbyColumn = process.env.GOOGLE_SHEETS_LOBBY_COLUMN || "A";
    const refereeColumn = process.env.GOOGLE_SHEETS_REFEREE_COLUMN || "J";

    if (!spreadsheetId) {
        throw new Error("GOOGLE_SHEETS_ID is not configured.");
    }

    const sheets = getSheetsClient();
    const rowNumber = await findLobbyRow(sheets, spreadsheetId, sheetName, lobbyColumn, lobbyCode);

    if (rowNumber === -1) {
        throw new Error(`Lobby "${lobbyCode}" was not found in the sheet.`);
    }

    await sheets.spreadsheets.values.update({
        spreadsheetId,
        range: `${sheetName}!${refereeColumn}${rowNumber}`,
        valueInputOption: "USER_ENTERED",
        requestBody: {
            values: [[refereeValue]],
        },
    });

    return {
        rowNumber,
        refereeColumnLetter: refereeColumn,
    };
}

/**
 * Reads all lobby scores from the Schedule tab.
 * Returns a Map of lobbyCode → { score1, score2, tabName }.
 * Schedule layout (from col D): D=lobby, M=score1, N=score2, P=tabName
 */
async function readAllScheduleScores(sheets, spreadsheetId, sheetName, lobbyColumn) {
    const response = await sheets.spreadsheets.values.get({
        spreadsheetId,
        range: `${sheetName}!D:P`,
    });
    const rows = response.data.values || [];
    const colD = "D".charCodeAt(0) - "A".charCodeAt(0); // 3
    const colM = "M".charCodeAt(0) - "D".charCodeAt(0); // 9
    const colN = "N".charCodeAt(0) - "D".charCodeAt(0); // 10
    const colP = "P".charCodeAt(0) - "D".charCodeAt(0); // 12

    const scoreMap = new Map();
    for (const row of rows) {
        const lobby = String(row[0] || "").trim().toUpperCase();
        if (!/^[A-Z]\d+$/.test(lobby)) continue;
        scoreMap.set(lobby, {
            score1: Number(row[colM]) || 0,
            score2: Number(row[colN]) || 0,
            tabName: String(row[colP] || "").trim(),
        });
    }
    return scoreMap;
}

/**
 * Updates a match score by writing directly to the match tab's C3/E3 cells.
 * This preserves the Schedule M/N ArrayFormulas (which read from the match tab).
 * C3 = red/team1 score, E3 = blue/team2 score (as per the referee template).
 * @param {string} lobbyCode
 * @param {number} redScore
 * @param {number} blueScore
 * @returns {Promise<{ tabName: string, team1Score: number, team2Score: number }>}
 */
export async function updateLobbySeriesScore(lobbyCode, redScore, blueScore) {
    const spreadsheetId = process.env.GOOGLE_SHEETS_ID;
    const sheetName = process.env.GOOGLE_SHEETS_TAB_NAME || "Schedule";
    const lobbyColumn = process.env.GOOGLE_SHEETS_LOBBY_COLUMN || "D";

    if (!spreadsheetId) {
        throw new Error("GOOGLE_SHEETS_ID is not configured.");
    }

    const sheets = getSheetsClient();
    const scoreMap = await readAllScheduleScores(sheets, spreadsheetId, sheetName, lobbyColumn);
    const entry = scoreMap.get(lobbyCode.trim().toUpperCase());

    if (!entry) {
        throw new Error(`Lobby "${lobbyCode}" was not found in the sheet.`);
    }
    if (!entry.tabName) {
        throw new Error(`Lobby "${lobbyCode}" has no match tab assigned (column P is empty).`);
    }

    await sheets.spreadsheets.values.batchUpdate({
        spreadsheetId,
        requestBody: {
            valueInputOption: "USER_ENTERED",
            data: [
                { range: `${entry.tabName}!C3`, values: [[String(redScore)]] },
                { range: `${entry.tabName}!E3`, values: [[String(blueScore)]] },
            ],
        },
    });

    return { tabName: entry.tabName, team1Score: redScore, team2Score: blueScore };
}

// Stores the last known scores so the poller can detect changes.
const _lastKnownScores = new Map();

const NETWORK_ERROR_CODES = new Set(["ENOTFOUND", "ECONNRESET", "ECONNREFUSED", "ETIMEDOUT", "EAI_AGAIN"]);
const MAX_BACKOFF_MS = 10 * 60 * 1000; // 10 minutes

function isNetworkError(err) {
    return (
        NETWORK_ERROR_CODES.has(err?.code) ||
        NETWORK_ERROR_CODES.has(err?.cause?.code) ||
        NETWORK_ERROR_CODES.has(err?.error?.code)
    );
}

/**
 * Starts polling the Schedule tab for score changes.
 * When any score changes, calls onGroupChanged(groupCode).
 * Uses exponential backoff when network errors occur to avoid log spam.
 * @param {(groupCode: string) => void} onGroupChanged
 * @param {number} intervalMs - base polling interval in milliseconds (default 30s)
 * @returns {{ stop: () => void }} - call stop() to cancel polling
 */
export function startScorePolling(onGroupChanged, intervalMs = 30000) {
    const spreadsheetId = process.env.GOOGLE_SHEETS_ID;
    const sheetName = process.env.GOOGLE_SHEETS_TAB_NAME || "Schedule";
    const lobbyColumn = process.env.GOOGLE_SHEETS_LOBBY_COLUMN || "D";

    let timeoutHandle = null;
    let consecutiveNetworkErrors = 0;
    let stopped = false;

    const scheduleNext = (delayMs) => {
        if (stopped) return;
        timeoutHandle = setTimeout(poll, delayMs);
    };

    const poll = async () => {
        if (stopped) return;
        try {
            const sheets = getSheetsClient();
            const scoreMap = await readAllScheduleScores(sheets, spreadsheetId, sheetName, lobbyColumn);

            const wasOffline = consecutiveNetworkErrors > 0;
            if (wasOffline) {
                console.log("✅ Polling de scores reconectado.");
                consecutiveNetworkErrors = 0;
            }

            const changedGroups = new Set();

            for (const [lobby, { score1, score2 }] of scoreMap) {
                const prev = _lastKnownScores.get(lobby);
                const scoreChanged = prev && (prev.score1 !== score1 || prev.score2 !== score2);
                // If we were offline we may have missed a score change — re-sync any group
                // that has a non-zero final score and either has no cached baseline or
                // whose cached score differs from what the sheet now shows.
                const missedWhileOffline = wasOffline && (score1 > 0 || score2 > 0) && !prev;

                if (!prev || scoreChanged || missedWhileOffline) {
                    if (scoreChanged) {
                        console.log(`📊 Score changed for ${lobby}: ${prev.score1}:${prev.score2} → ${score1}:${score2}`);
                        changedGroups.add(lobby.charAt(0));
                    } else if (missedWhileOffline) {
                        console.log(`📊 Recovering offline miss for ${lobby}: ${score1}:${score2} — recalculating standings.`);
                        changedGroups.add(lobby.charAt(0));
                    }
                    _lastKnownScores.set(lobby, { score1, score2 });
                }
            }

            for (const groupCode of changedGroups) {
                try {
                    await onGroupChanged(groupCode);
                } catch (err) {
                    console.error(`Erro ao recalcular standings do grupo ${groupCode}:`, err);
                }
            }

            scheduleNext(intervalMs);
        } catch (err) {
            if (isNetworkError(err)) {
                consecutiveNetworkErrors += 1;
                const backoffMs = Math.min(intervalMs * Math.pow(2, consecutiveNetworkErrors - 1), MAX_BACKOFF_MS);
                if (consecutiveNetworkErrors === 1) {
                    console.warn(`⚠️ Polling: sem acesso ao Sheets (${err.code ?? err.cause?.code ?? "rede"}). Próxima tentativa em ${Math.round(backoffMs / 1000)}s.`);
                } else {
                    console.warn(`⚠️ Polling: ainda sem rede (tentativa ${consecutiveNetworkErrors}). Próxima em ${Math.round(backoffMs / 1000)}s.`);
                }
                scheduleNext(backoffMs);
            } else {
                console.error("Erro no polling de scores:", err.message ?? err);
                scheduleNext(intervalMs);
            }
        }
    };

    // Seed the initial state without triggering callbacks
    (async () => {
        try {
            const sheets = getSheetsClient();
            const scoreMap = await readAllScheduleScores(sheets, spreadsheetId, sheetName, lobbyColumn);
            for (const [lobby, scores] of scoreMap) {
                _lastKnownScores.set(lobby, { score1: scores.score1, score2: scores.score2 });
            }
            console.log(`✅ Score polling iniciado (intervalo: ${intervalMs / 1000}s, ${scoreMap.size} lobbies monitoradas)`);
        } catch (err) {
            if (isNetworkError(err)) {
                console.warn(`⚠️ Polling: sem rede na inicialização. Tentando novamente no primeiro ciclo.`);
            } else {
                console.error("Erro ao inicializar polling:", err.message ?? err);
            }
        }
        scheduleNext(intervalMs);
    })();

    return {
        stop: () => {
            stopped = true;
            if (timeoutHandle) clearTimeout(timeoutHandle);
        },
    };
}

/**
 * Updates match score in frontend groups schedule tab by lobby id.
 * Default lobby column G, score columns N and O.
 * @param {string} lobbyCode
 * @param {number} team1Score
 * @param {number} team2Score
 * @returns {Promise<{ rowNumber: number }>}
 */
export async function updateGroupsMatchScore(lobbyCode, team1Score, team2Score) {
    const spreadsheetId = process.env.GOOGLE_GROUPS_SHEETS_ID || DEFAULT_GROUPS_SPREADSHEET_ID;
    const sheetName = process.env.GOOGLE_GROUPS_TAB_NAME || DEFAULT_GROUPS_TAB_NAME;
    const lobbyColumn = process.env.GOOGLE_GROUPS_LOBBY_COLUMN || "G";
    const team1ScoreColumn = process.env.GOOGLE_GROUPS_TEAM1_SCORE_COLUMN || "N";
    const team2ScoreColumn = process.env.GOOGLE_GROUPS_TEAM2_SCORE_COLUMN || "O";

    const sheets = getSheetsClient();
    const rowNumber = await findLobbyRow(sheets, spreadsheetId, sheetName, lobbyColumn, lobbyCode);

    if (rowNumber === -1) {
        throw new Error(`Lobby "${lobbyCode}" was not found in ${sheetName}.`);
    }

    await sheets.spreadsheets.values.batchUpdate({
        spreadsheetId,
        requestBody: {
            valueInputOption: "USER_ENTERED",
            data: [
                {
                    range: `${sheetName}!${team1ScoreColumn}${rowNumber}`,
                    values: [[String(team1Score)]],
                },
                {
                    range: `${sheetName}!${team2ScoreColumn}${rowNumber}`,
                    values: [[String(team2Score)]],
                },
            ],
        },
    });

    return { rowNumber };
}

/**
 * Adds score lookup formulas in groups schedule so sheet 2 always reads sheet 1.
 * @returns {Promise<{ updatedRows: number }>}
 */
export async function setupGroupsScoreSyncFormulas() {
    const sourceSpreadsheetId = process.env.GOOGLE_SHEETS_ID;
    const sourceTabName = process.env.GOOGLE_SHEETS_TAB_NAME || "Schedule";
    const sourceLobbyColumn = process.env.GOOGLE_SHEETS_LOBBY_COLUMN || "D";
    const sourceTeam1Column = process.env.GOOGLE_SHEETS_RESULT_TEAM1_COLUMN || "M";
    const sourceTeam2Column = process.env.GOOGLE_SHEETS_RESULT_TEAM2_COLUMN || "N";

    const targetSpreadsheetId = process.env.GOOGLE_GROUPS_SHEETS_ID || DEFAULT_GROUPS_SPREADSHEET_ID;
    const targetTabName = process.env.GOOGLE_GROUPS_TAB_NAME || DEFAULT_GROUPS_TAB_NAME;
    const targetLobbyColumn = process.env.GOOGLE_GROUPS_LOBBY_COLUMN || "G";
    const targetTeam1Column = process.env.GOOGLE_GROUPS_TEAM1_SCORE_COLUMN || "N";
    const targetTeam2Column = process.env.GOOGLE_GROUPS_TEAM2_SCORE_COLUMN || "O";

    if (!sourceSpreadsheetId) {
        throw new Error("GOOGLE_SHEETS_ID is not configured.");
    }

    const sheets = getSheetsClient();
    const response = await sheets.spreadsheets.values.get({
        spreadsheetId: targetSpreadsheetId,
        range: `${targetTabName}!${targetLobbyColumn}:${targetLobbyColumn}`,
    });

    const rows = response.data.values || [];
    const updates = [];

    for (let i = 0; i < rows.length; i += 1) {
        const rowNumber = i + 1;
        const lobby = String(rows[i]?.[0] || "").trim().toUpperCase();

        if (!/^[A-Z]\d+$/.test(lobby)) {
            continue;
        }

        const lobbyRef = `IMPORTRANGE("${sourceSpreadsheetId}", "${sourceTabName}!$${sourceLobbyColumn}:$${sourceLobbyColumn}")`;
        const team1Ref = `IMPORTRANGE("${sourceSpreadsheetId}", "${sourceTabName}!$${sourceTeam1Column}:$${sourceTeam1Column}")`;
        const team2Ref = `IMPORTRANGE("${sourceSpreadsheetId}", "${sourceTabName}!$${sourceTeam2Column}:$${sourceTeam2Column}")`;

        const team1Formula = `=IFERROR(INDEX(${team1Ref}, MATCH($${targetLobbyColumn}${rowNumber}, ${lobbyRef}, 0)), 0)`;
        const team2Formula = `=IFERROR(INDEX(${team2Ref}, MATCH($${targetLobbyColumn}${rowNumber}, ${lobbyRef}, 0)), 0)`;

        updates.push({
            range: `${targetTabName}!${targetTeam1Column}${rowNumber}:${targetTeam2Column}${rowNumber}`,
            values: [[team1Formula, team2Formula]],
        });
    }

    if (updates.length === 0) {
        return { updatedRows: 0 };
    }

    await sheets.spreadsheets.values.batchUpdate({
        spreadsheetId: targetSpreadsheetId,
        requestBody: {
            valueInputOption: "USER_ENTERED",
            data: updates,
        },
    });

    return { updatedRows: updates.length };
}

function parseNumber(value) {
    const num = Number(String(value).trim());
    return Number.isFinite(num) ? num : null;
}

function parseSeed(seedValue) {
    const match = String(seedValue || "").match(/#?\s*(\d+)/);
    if (!match) {
        return Number.MAX_SAFE_INTEGER;
    }
    return Number(match[1]);
}

/**
 * Recalculates one group standings in groups schedule (Z:AG block).
 * Reads scores from the backend sheet (sheet 1) to avoid IMPORTRANGE caching delays.
 * Ranking rule: wins desc, PD desc, PF desc, then seed asc.
 * @param {string} groupCode
 * @returns {Promise<{ group: string, updatedRows: number }>}
 */
export async function syncGroupStandings(groupCode) {
    const spreadsheetId = process.env.GOOGLE_GROUPS_SHEETS_ID || DEFAULT_GROUPS_SPREADSHEET_ID;
    const sheetName = process.env.GOOGLE_GROUPS_TAB_NAME || DEFAULT_GROUPS_TAB_NAME;
    const targetGroup = groupCode.trim().toUpperCase().charAt(0);

    const sourceSpreadsheetId = process.env.GOOGLE_SHEETS_ID;
    const sourceSheetName = process.env.GOOGLE_SHEETS_TAB_NAME || "Schedule";
    const sourceLobbyColumn = process.env.GOOGLE_SHEETS_LOBBY_COLUMN || "D";
    const sourceTeam1Column = process.env.GOOGLE_SHEETS_RESULT_TEAM1_COLUMN || "M";
    const sourceTeam2Column = process.env.GOOGLE_SHEETS_RESULT_TEAM2_COLUMN || "N";

    if (!targetGroup.match(/[A-Z]/)) {
        throw new Error("Invalid group code.");
    }

    const sheets = getSheetsClient();

    // Read group layout from sheet 2: lobby codes, player names, seeds
    const groupsResponse = await sheets.spreadsheets.values.get({
        spreadsheetId,
        range: `${sheetName}!D1:AG`,
    });
    const rows = groupsResponse.data.values || [];

    // row[3] = column G = lobby code (e.g. "A1")
    const groupStartIndex = rows.findIndex((row) => String(row[3] || "").trim().toUpperCase() === `${targetGroup}1`);

    if (groupStartIndex === -1) {
        throw new Error(`Group "${targetGroup}" not found in ${sheetName}.`);
    }

    // Read all scores from sheet 1 (source of truth, avoids IMPORTRANGE caching)
    const scoreResponse = await sheets.spreadsheets.values.get({
        spreadsheetId: sourceSpreadsheetId,
        range: `${sourceSheetName}!${sourceLobbyColumn}:${sourceTeam2Column}`,
    });
    const scoreRows = scoreResponse.data.values || [];

    // Build lobby → scores map from sheet 1
    // The columns between sourceLobbyColumn and sourceTeam2Column span several columns.
    // We read the whole range so we need to know the offset of score columns within it.
    const colIndex = (letter) => letter.toUpperCase().charCodeAt(0) - "A".charCodeAt(0);
    const lobbyColIdx = colIndex(sourceLobbyColumn);
    const t1ColIdx = colIndex(sourceTeam1Column) - lobbyColIdx;
    const t2ColIdx = colIndex(sourceTeam2Column) - lobbyColIdx;

    const scoreMap = new Map();
    for (const row of scoreRows) {
        const lobby = String(row[0] || "").trim().toUpperCase();
        if (/^[A-Z]\d+$/.test(lobby)) {
            const s1 = parseNumber(row[t1ColIdx]);
            const s2 = parseNumber(row[t2ColIdx]);
            scoreMap.set(lobby, { score1: s1 ?? 0, score2: s2 ?? 0 });
        }
    }

    // Process each of the 6 group matches
    const groupMatches = [0, 1, 2, 3, 4, 5].map((offset) => rows[groupStartIndex + offset] || []);

    // Seed (from column AG) stored separately so we can look it up by player name
    const seedByPlayer = new Map();
    const standingsRows = [0, 1, 2, 3].map((offset) => rows[groupStartIndex + offset] || []);
    standingsRows.forEach((row) => {
        // row[23] = column AA = player name in standings block
        // row[29] = column AG = seed
        const player = String(row[23] || "").trim();
        if (player) seedByPlayer.set(player, parseSeed(row[29]));
    });

    // Build the roster from ALL 6 match rows (regardless of score) so that players
    // who haven't played yet still appear in standings with 0 wins/losses.
    // Only consider rows that have a valid lobby code (e.g. "D1") to avoid adding
    // header text or placeholder values as fake players.
    const statsByPlayer = new Map();
    groupMatches.forEach((matchRow) => {
        const lobbyCode = String(matchRow[3] || "").trim().toUpperCase(); // col G
        if (!/^[A-Z]\d+$/.test(lobbyCode)) return; // skip rows that aren't real matches
        const player1 = String(matchRow[9] || "").trim();  // col M
        const player2 = String(matchRow[12] || "").trim(); // col P
        for (const player of [player1, player2]) {
            if (player && !statsByPlayer.has(player)) {
                statsByPlayer.set(player, {
                    player,
                    seed: seedByPlayer.get(player) ?? Number.MAX_SAFE_INTEGER,
                    wins: 0,
                    losses: 0,
                    pf: 0,
                    pa: 0,
                    pd: 0,
                });
            }
        }
    });

    console.log(`📋 Group ${targetGroup}: roster found: [${[...statsByPlayer.keys()].join(", ")}]`);

    // Calculate stats for played matches only
    groupMatches.forEach((matchRow) => {
        const lobbyCode = String(matchRow[3] || "").trim().toUpperCase(); // col G
        const player1 = String(matchRow[9] || "").trim();                 // col M
        const player2 = String(matchRow[12] || "").trim();                // col P

        if (!player1 || !player2 || !lobbyCode) return;

        const scores = scoreMap.get(lobbyCode) ?? { score1: 0, score2: 0 };
        const { score1, score2 } = scores;

        // Skip matches that haven't been played or ended in a draw
        if (score1 === 0 && score2 === 0) return;

        const p1 = statsByPlayer.get(player1);
        const p2 = statsByPlayer.get(player2);
        if (!p1 || !p2) return;

        p1.pf += score1;
        p1.pa += score2;
        p2.pf += score2;
        p2.pa += score1;

        // W/L only counted when the match is finished (someone reached 5 in BO9)
        if (score1 >= 5 || score2 >= 5) {
            if (score1 > score2) {
                p1.wins += 1;
                p2.losses += 1;
            } else {
                p2.wins += 1;
                p1.losses += 1;
            }
        }
    });

    const ranking = Array.from(statsByPlayer.values())
        .map((entry) => ({ ...entry, pd: entry.pf - entry.pa }))
        .sort((a, b) =>
            b.wins - a.wins
            || b.pd - a.pd
            || b.pf - a.pf
            || a.seed - b.seed
        )
        .slice(0, 4);

    if (ranking.length < 4) {
        throw new Error(`Group "${targetGroup}" has less than 4 players in standings block.`);
    }

    const updateData = ranking.map((entry, index) => {
        const rowNumber = groupStartIndex + index + 1;
        const seedLabel = entry.seed < Number.MAX_SAFE_INTEGER ? `#${entry.seed}` : "";
        return {
            range: `${sheetName}!Z${rowNumber}:AG${rowNumber}`,
            values: [[
                `#${index + 1}`,
                entry.player,
                String(entry.wins),
                String(entry.losses),
                String(entry.pf),
                String(entry.pa),
                String(entry.pd),
                seedLabel,
            ]],
        };
    });

    console.log(`📋 Group ${targetGroup}: writing standings to rows ${groupStartIndex + 1}–${groupStartIndex + ranking.length} of "${sheetName}".`);
    console.log(ranking.map((e, i) => `  #${i + 1} ${e.player} (${e.wins}W/${e.losses}L PF:${e.pf} PA:${e.pa})`).join("\n"));

    await sheets.spreadsheets.values.batchUpdate({
        spreadsheetId,
        requestBody: {
            valueInputOption: "USER_ENTERED",
            data: updateData,
        },
    });    return {
        group: targetGroup,
        updatedRows: updateData.length,
    };
}

/**
 * One-time setup: writes all standings formulas to the groups sheet (Sheet 2)
 * so standings auto-update without the bot being online.
 *
 * How the formulas work:
 *
 *  SCORE COLUMNS (N, O) — cross-reference Sheet 1 by player names
 *     Sheet 1's Schedule tab has player names in G/H and scores in M/N
 *     (which are themselves formulas reading each match tab's C3/E3).
 *     Sheet 2 row has players in cols M and P; we FILTER Sheet 1 where
 *     (G = Sheet2 M) AND (H = Sheet2 P) to find the matching row and
 *     pull its score. Falls back to 0 until the match is played.
 *
 *  STANDINGS COLUMNS (AB–AF, Z) — pure local computation on Sheet 2
 *     Wins/Losses count matches where team score reached 5 (BO9 finished).
 *     PF/PA sum up every point scored in every played match.
 *     Rank uses COUNTIF tie-breaking: wins desc → PD desc → PF desc.
 *
 *  NOT TOUCHED: AA (player name) and AG (seed) must already be filled in
 *  manually in the standings rows of each group template.
 *
 *  IMPORTRANGE authorization: the first time these formulas run, Google
 *  Sheets may show #REF! until you click into an N/O cell and approve
 *  access. This is a one-time popup per sheet pair.
 */
export async function setupStandingsFormulas() {
    const spreadsheetId = process.env.GOOGLE_GROUPS_SHEETS_ID || DEFAULT_GROUPS_SPREADSHEET_ID;
    const sheetName = process.env.GOOGLE_GROUPS_TAB_NAME || DEFAULT_GROUPS_TAB_NAME;
    const sourceSpreadsheetId = process.env.GOOGLE_SHEETS_ID;
    const sourceTabName = process.env.GOOGLE_SHEETS_TAB_NAME || "Schedule";
    // On Sheet 1 (Schedule), players are in G/H and scores in M/N.
    const sourceP1Col = "G";
    const sourceP2Col = "H";
    const sourceS1Col = process.env.GOOGLE_SHEETS_RESULT_TEAM1_COLUMN || "M";
    const sourceS2Col = process.env.GOOGLE_SHEETS_RESULT_TEAM2_COLUMN || "N";

    if (!sourceSpreadsheetId) {
        throw new Error("GOOGLE_SHEETS_ID is not configured.");
    }

    const lobbyCol   = process.env.GOOGLE_GROUPS_LOBBY_COLUMN || "G";
    const player1Col = "M";
    const player2Col = "P";
    const score1Col  = process.env.GOOGLE_GROUPS_TEAM1_SCORE_COLUMN || "N";
    const score2Col  = process.env.GOOGLE_GROUPS_TEAM2_SCORE_COLUMN || "O";
    const rankCol    = "Z";
    const playerCol  = "AA";
    const winsCol    = "AB";
    const lossesCol  = "AC";
    const pfCol      = "AD";
    const paCol      = "AE";
    const pdCol      = "AF";

    const sheets = getSheetsClient();

    const response = await sheets.spreadsheets.values.get({
        spreadsheetId,
        range: `${sheetName}!D1:AG`,
    });
    const rows = response.data.values || [];

    // Find each group's starting row by locating "X1" lobby codes in column G
    // (col G is index 3 within the D:AG range).
    const groups = [];
    for (let i = 0; i < rows.length; i++) {
        const cell = String(rows[i][3] || "").trim().toUpperCase();
        if (/^[A-Z]1$/.test(cell)) {
            groups.push({ letter: cell[0], startIndex: i });
        }
    }

    if (groups.length === 0) {
        throw new Error(
            `No groups found. Make sure lobby codes like "A1", "B1" are in column ${lobbyCol} of "${sheetName}".`
        );
    }

    // Reusable IMPORTRANGE snippets. Sheets caches these by argument pair,
    // so repeating the same IMPORTRANGE across many cells is cheap.
    const ir = (col) => `IMPORTRANGE("${sourceSpreadsheetId}","${sourceTabName}!${col}:${col}")`;
    const irP1 = ir(sourceP1Col);
    const irP2 = ir(sourceP2Col);
    const irS1 = ir(sourceS1Col);
    const irS2 = ir(sourceS2Col);

    const updates = [];
    const pdCellRanges = []; // sheet-row ranges to number-format

    for (const { letter, startIndex } of groups) {
        const startRow = startIndex + 1;
        pdCellRanges.push({ startRow, endRow: startRow + 4 }); // 4 standings rows

        // ── SCORE COLUMNS N / O ────────────────────────────────────────────
        // For every match row, look up the Schedule row whose player names
        // match this row's M and P (both orderings accepted), pull scores.
        // Wrapped in IFNA→VALUE so results are always proper numbers (text
        // returned by FILTER would break numeric comparisons downstream).
        for (let offset = 0; offset < 6; offset++) {
            const r = startRow + offset;
            const lobby = String(rows[startIndex + offset]?.[3] || "").trim();
            if (!lobby) continue;

            const pl1 = `${player1Col}${r}`; // e.g. M38
            const pl2 = `${player2Col}${r}`; // e.g. P38

            // IFERROR (not IFNA) on outer layer: VALUE("") returns #VALUE!,
            // not #N/A, and we want a 0 in either case. Inner IFNA catches
            // "no matching row" from FILTER; VALUE forces a numeric result
            // so downstream comparisons (N>=5) don't get fooled by text.
            const lookupT1 =
                `IFERROR(VALUE(IFNA(` +
                `FILTER(${irS1},${irP1}=${pl1},${irP2}=${pl2}),` +
                `FILTER(${irS2},${irP1}=${pl2},${irP2}=${pl1}))),0)`;

            const lookupT2 =
                `IFERROR(VALUE(IFNA(` +
                `FILTER(${irS2},${irP1}=${pl1},${irP2}=${pl2}),` +
                `FILTER(${irS1},${irP1}=${pl2},${irP2}=${pl1}))),0)`;

            updates.push({
                range: `${sheetName}!${score1Col}${r}:${score2Col}${r}`,
                values: [[`=${lookupT1}`, `=${lookupT2}`]],
            });
        }

        // ── STANDINGS COLUMNS AB–AF and Z ──────────────────────────────────
        // Using COUNTIFS/SUMIFS (strict numeric comparisons, skips non-numbers)
        // instead of SUMPRODUCT (returns truthy for text >= number comparisons).
        const m = `${player1Col}${startRow}:${player1Col}${startRow + 5}`;
        const p = `${player2Col}${startRow}:${player2Col}${startRow + 5}`;
        const n = `${score1Col}${startRow}:${score1Col}${startRow + 5}`;
        const o = `${score2Col}${startRow}:${score2Col}${startRow + 5}`;

        const winsRange = `${winsCol}${startRow}:${winsCol}${startRow + 3}`;
        const pdRange   = `${pdCol}${startRow}:${pdCol}${startRow + 3}`;
        const pfRange   = `${pfCol}${startRow}:${pfCol}${startRow + 3}`;

        for (let offset = 0; offset < 4; offset++) {
            const r  = startRow + offset;
            const pl = `${playerCol}${r}`;
            const emptyGuard = `IF(${pl}="",0,`;

            const wins   = `=${emptyGuard}COUNTIFS(${m},${pl},${n},">=5")+COUNTIFS(${p},${pl},${o},">=5"))`;
            const losses = `=${emptyGuard}COUNTIFS(${m},${pl},${o},">=5")+COUNTIFS(${p},${pl},${n},">=5"))`;
            const pf     = `=${emptyGuard}SUMIF(${m},${pl},${n})+SUMIF(${p},${pl},${o}))`;
            const pa     = `=${emptyGuard}SUMIF(${m},${pl},${o})+SUMIF(${p},${pl},${n}))`;
            const pd     = `=${pfCol}${r}-${paCol}${r}`;

            // Rank: 1 + (players with strictly better wins, then PD, then PF)
            const rank = `=IF(${pl}="","","#"&(1`
                + `+COUNTIF(${winsRange},">"&${winsCol}${r})`
                + `+COUNTIFS(${winsRange},"="&${winsCol}${r},${pdRange},">"&${pdCol}${r})`
                + `+COUNTIFS(${winsRange},"="&${winsCol}${r},${pdRange},"="&${pdCol}${r},${pfRange},">"&${pfCol}${r})))`;

            updates.push({
                range: `${sheetName}!${winsCol}${r}:${pdCol}${r}`,
                values: [[wins, losses, pf, pa, pd]],
            });
            updates.push({
                range: `${sheetName}!${rankCol}${r}`,
                values: [[rank]],
            });
        }

        console.log(`✅ Group ${letter}: formulas queued for rows ${startRow}–${startRow + 5}.`);
    }

    await sheets.spreadsheets.values.batchUpdate({
        spreadsheetId,
        requestBody: {
            valueInputOption: "USER_ENTERED",
            data: updates,
        },
    });

    // Apply "+"-prefix number format to PD cells (values stay numeric so the
    // rank tiebreaker COUNTIFS still compares correctly).
    try {
        const meta = await sheets.spreadsheets.get({ spreadsheetId });
        const tab = meta.data.sheets?.find((s) => s.properties?.title === sheetName);
        const sheetId = tab?.properties?.sheetId;

        if (sheetId != null && pdCellRanges.length > 0) {
            const colIdx = pdCol.split("").reduce((acc, c) => acc * 26 + (c.charCodeAt(0) - 64), 0) - 1;
            const formatRequests = pdCellRanges.map(({ startRow, endRow }) => ({
                repeatCell: {
                    range: {
                        sheetId,
                        startRowIndex: startRow - 1,
                        endRowIndex: endRow - 1,
                        startColumnIndex: colIdx,
                        endColumnIndex: colIdx + 1,
                    },
                    cell: {
                        userEnteredFormat: {
                            numberFormat: { type: "NUMBER", pattern: '"+"0;-0;0' },
                        },
                    },
                    fields: "userEnteredFormat.numberFormat",
                },
            }));

            await sheets.spreadsheets.batchUpdate({
                spreadsheetId,
                requestBody: { requests: formatRequests },
            });
        }
    } catch (err) {
        console.warn(`⚠️ Fórmulas escritas, mas não consegui aplicar o formato "+" em PD: ${err.message ?? err}`);
    }

    return { groups: groups.length, updatesWritten: updates.length };
}
