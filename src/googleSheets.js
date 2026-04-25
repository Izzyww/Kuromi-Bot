import dotenv from "dotenv";
import { google } from "googleapis";

dotenv.config();

let sheetsClient = null;

const DEFAULT_GROUPS_SPREADSHEET_ID = "18kTX8-XpCy0D37ez7tV-yg_UBTdJLkxvwXiDIHWeLBU";
const DEFAULT_GROUPS_TAB_NAME = "groups schedule";

/** Ref sheet (Schedule): column with the match / referee tab name (was P, now Q). */
function getScheduleMatchTabColumn() {
    return process.env.GOOGLE_SHEETS_MATCH_TAB_COLUMN || "Q";
}

function scheduleMatchTabIndexFromG() {
    const col = getScheduleMatchTabColumn().toUpperCase();
    return col.charCodeAt(0) - "G".charCodeAt(0);
}

function scheduleMatchTabIndexFromD() {
    const col = getScheduleMatchTabColumn().toUpperCase();
    return col.charCodeAt(0) - "D".charCodeAt(0);
}

/** Ref sheet `Tab!I2:P` for LET / IMPORTRANGE (I=lobby, O=MP, P=VOD). */
function scheduleRefRangeI2PForFormula() {
    const refTab = process.env.GOOGLE_SHEETS_TAB_NAME || "Schedule";
    if (/^[A-Za-z0-9_]+$/.test(refTab)) {
        return `${refTab}!I2:P`;
    }
    return `'${refTab.replace(/'/g, "''")}'!I2:P`;
}

/** A1 range prefix: quote tab name when it has spaces or special characters. */
function quoteSheetNameForA1(tabName) {
    const s = String(tabName);
    if (/^[A-Za-z0-9_]+$/.test(s)) return s;
    return `'${s.replace(/'/g, "''")}'`;
}

/** 0-based column index: A=0, Z=25, AA=26, … */
function columnLettersToIndex0(letters) {
    const s = String(letters).replace(/[^A-Za-z]/g, "").toUpperCase();
    if (!s) return 0;
    let n = 0;
    for (let i = 0; i < s.length; i += 1) {
        n = n * 26 + (s.charCodeAt(i) - 64);
    }
    return n - 1;
}

function index0ToColumnLetters(index0) {
    let n = index0 + 1;
    let result = "";
    while (n > 0) {
        n -= 1;
        result = String.fromCharCode(65 + (n % 26)) + result;
        n = Math.floor(n / 26);
    }
    return result;
}

function normalizeColumnLetter(col) {
    return String(col).replace(/\$/g, "").toUpperCase().replace(/[^A-Z]/g, "");
}

/**
 * On the main groups tab, lobby + two player columns (legacy G/M/P, compact B/E/H, etc.):
 * single range and slice indices for cross-ref with the ref Schedule.
 */
function groupsMainPlayerCrossRefSlice() {
    const lobby = normalizeColumnLetter(process.env.GOOGLE_GROUPS_LOBBY_COLUMN || "G");
    const p1 = normalizeColumnLetter(process.env.GOOGLE_GROUPS_PLAYER1_COLUMN || "M");
    const p2 = normalizeColumnLetter(process.env.GOOGLE_GROUPS_PLAYER2_COLUMN || "P");
    const i0 = columnLettersToIndex0(lobby);
    const i1 = columnLettersToIndex0(p1);
    const i2 = columnLettersToIndex0(p2);
    const minI = Math.min(i0, i1, i2);
    const maxI = Math.max(i0, i1, i2);
    const minCol = index0ToColumnLetters(minI);
    const maxCol = index0ToColumnLetters(maxI);
    return {
        minCol,
        maxCol,
        range: `${minCol}:${maxCol}`,
        lobbyOff: i0 - minI,
        p1Off: i1 - minI,
        p2Off: i2 - minI,
        lobby,
        p1,
        p2,
    };
}

/** Default last row to scan on main (groups) tab; keeps API row index = sheet row. */
function getGroupsMainScanEndRow() {
    const n = parseInt(process.env.GOOGLE_GROUPS_MAIN_SCAN_END_ROW || "5000", 10);
    return Math.min(20000, Math.max(20, n));
}

/** Trim lobby cell for match (NBSP, ZW, weird hyphens). */
function normalizeMainLobbyKey(raw) {
    return String(raw ?? "")
        .replace(/[\s\u00A0\u2000-\u200B\u200C\u200D\uFEFF]+/g, "")
        .replace(/[\u2010-\u2015\u2212\uFE58\uFE63\uFF0D]/g, "-")
        .toUpperCase();
}

/** `,` (US) vs `;` (many EU locales). Set `GOOGLE_SHEETS_FORMULA_ARG_SEP=;` if formulas show #ERROR!. */
function getFormulaArgSeparator() {
    const v = (process.env.GOOGLE_SHEETS_FORMULA_ARG_SEP || "").trim();
    return v === ";" ? ";" : ",";
}

function buildMpVodCellFormula(row, dataExpr, urlColIndex, sep, lobbyCol) {
    const lc = String(lobbyCol || "G").replace(/\$/g, "").toUpperCase();
    const ref = `$${lc}${row}`;
    const sq = "\u25a0"; // ■ — same as sheet-link-formulas.txt
    const idxKeys = sep === ";" ? "INDEX(data;;1)" : "INDEX(data,,1)";
    const idxUrl = sep === ";" ? `INDEX(data;row;${urlColIndex})` : `INDEX(data,row,${urlColIndex})`;
    const matchExpr = sep === ";" ? "MATCH(key;keys;0)" : "MATCH(key,keys,0)";
    const trimUrl = `TRIM(${idxUrl}&"")`;
    const linkLine =
        sep === ";"
            ? `IF(LEN(url);HYPERLINK(url;"${sq}");"")`
            : `IF(LEN(url),HYPERLINK(url,"${sq}"),"")`;
    const letBody =
        sep === ";"
            ? `LET(data;${dataExpr};key;TRIM(UPPER(${ref}));keys;TRIM(UPPER(${idxKeys}));row;${matchExpr};url;${trimUrl};${linkLine})`
            : `LET(data,${dataExpr},key,TRIM(UPPER(${ref})),keys,TRIM(UPPER(${idxKeys})),row,${matchExpr},url,${trimUrl},${linkLine})`;
    const outer =
        sep === ";" ? `IF(${ref}="";"";IFERROR(${letBody};""))` : `IF(${ref}="","",IFERROR(${letBody},""))`;
    return `=${outer}`;
}

/** Expression used as `LET(data, …, …)` — same file uses range; else IMPORTRANGE. */
function buildMpVodLetDataExpression() {
    const groupsId = process.env.GOOGLE_GROUPS_SHEETS_ID || DEFAULT_GROUPS_SPREADSHEET_ID;
    const refId = process.env.GOOGLE_SHEETS_ID;
    const range = scheduleRefRangeI2PForFormula();
    const sep = getFormulaArgSeparator();
    if (!refId) {
        throw new Error("GOOGLE_SHEETS_ID is not configured.");
    }
    if (refId === groupsId) {
        return range;
    }
    return sep === ";" ? `IMPORTRANGE("${refId}";"${range}")` : `IMPORTRANGE("${refId}","${range}")`;
}

/** Pull beatmap id from a sheet cell (plain id or osu URL). */
export function parseBeatmapIdFromCell(raw) {
    if (raw == null) return null;
    const s = String(raw).trim();
    if (!s) return null;
    const fromUrl =
        s.match(/\/beatmaps\/(\d+)/i)?.[1] ||
        s.match(/\/b\/(\d+)/i)?.[1] ||
        s.match(/#osu\/(\d+)/i)?.[1];
    if (fromUrl) return fromUrl;
    if (/^\d+$/.test(s)) return s;
    return null;
}

/**
 * Reads Sheet 2 mappool: column N = beatmap id, H = slot label (NM1, HR1, …).
 * @returns {Promise<Map<string, string>>} beatmapId → slot label
 */
export async function loadMappoolBeatmapSlotLookup() {
    const sheets = getSheetsClient();
    const spreadsheetId = process.env.GOOGLE_GROUPS_SHEETS_ID || DEFAULT_GROUPS_SPREADSHEET_ID;
    const tab = process.env.MAPPOOL_TAB_NAME || "mappool";
    const slotColumn = process.env.MAPPOOL_SLOT_COLUMN || "H";
    const idColumn = process.env.MAPPOOL_BEATMAP_ID_COLUMN || "N";

    const [slotRes, idRes] = await Promise.all([
        sheets.spreadsheets.values.get({
            spreadsheetId,
            range: `${tab}!${slotColumn}2:${slotColumn}5000`,
        }),
        sheets.spreadsheets.values.get({
            spreadsheetId,
            range: `${tab}!${idColumn}2:${idColumn}5000`,
        }),
    ]);

    const slots = slotRes.data.values || [];
    const ids = idRes.data.values || [];
    const map = new Map();
    const rowCount = Math.max(slots.length, ids.length);

    for (let i = 0; i < rowCount; i += 1) {
        const slot = String(slots[i]?.[0] ?? "").trim();
        const idRaw = ids[i]?.[0];
        const bid = parseBeatmapIdFromCell(idRaw);
        if (bid && slot) map.set(bid, slot);
    }

    return map;
}

export function getSheetsClient() {
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
    const normalizedLobby = normalizeMainLobbyKey(lobbyCode);
    const endRow = getGroupsMainScanEndRow();
    const tab = quoteSheetNameForA1(sheetName);
    const col = normalizeColumnLetter(lobbyColumn);
    const getRange = `${tab}!${col}1:${col}${endRow}`;
    const response = await sheets.spreadsheets.values.get({
        spreadsheetId,
        range: getRange,
    });

    const rows = response.data.values || [];

    for (let index = 0; index < rows.length; index += 1) {
        const value = normalizeMainLobbyKey(rows[index]?.[0] || "");
        if (value && value === normalizedLobby) {
            return index + 1;
        }
    }

    return -1;
}

/**
 * Sheet 1 (Schedule) column layout — the "ID" column at I was labeled in an
 * existing empty column, NOT inserted, so no other columns shifted:
 *   D = lobby number (1, 2, 3...)    — sequential, not a cross-reference key
 *   E = date
 *   F = time
 *   G = player 1
 *   H = player 2
 *   I = ID label (display only, synced from Sheet 2 via syncScheduleIds)
 *   J = referee
 *   M = team 1 score
 *   N = team 2 score
 *   O = MP link, P = VOD link
 *   Q = match / referee tab name (GOOGLE_SHEETS_MATCH_TAB_COLUMN, default Q)
 *
 * Sheet 2 (groups / “main”):
 *   Legacy: G = lobby, M/P = players. Compact (e.g. Kuruwumi main): B = lobby, E/H = players.
 *   Set GOOGLE_GROUPS_LOBBY_COLUMN, GOOGLE_GROUPS_PLAYER1_COLUMN, GOOGLE_GROUPS_PLAYER2_COLUMN.
 */

/**
 * Resolves a lobby code (e.g. "A1") to its row in Sheet 1's Schedule tab.
 *
 * Schedule's lobby column (D) holds sequential numbers, not lobby codes, so we
 * can't search it directly. Cross-reference via players (see layout comment):
 *   1. Find the lobby code on the main groups tab → read both players.
 *   2. Find the row in Sheet 1 Schedule where cols G and H contain those
 *      two players (in either order).
 *
 * @returns {Promise<{ scheduleRow: number, player1: string, player2: string, tabName: string|null }>}
 */
async function findScheduleRowByLobbyCode(sheets, lobbyCode) {
    const want = normalizeMainLobbyKey(lobbyCode);

    const groupsSpreadsheetId = process.env.GOOGLE_GROUPS_SHEETS_ID || DEFAULT_GROUPS_SPREADSHEET_ID;
    const groupsTabName = process.env.GOOGLE_GROUPS_TAB_NAME || DEFAULT_GROUPS_TAB_NAME;
    const groupsTabA1 = quoteSheetNameForA1(groupsTabName);
    const scheduleSpreadsheetId = process.env.GOOGLE_SHEETS_ID;
    const scheduleTabName = process.env.GOOGLE_SHEETS_TAB_NAME || "Schedule";

    if (!scheduleSpreadsheetId) {
        throw new Error("GOOGLE_SHEETS_ID is not configured.");
    }

    const { minCol, maxCol, lobbyOff, p1Off, p2Off, p1, p2, lobby: lobbyColLet } = groupsMainPlayerCrossRefSlice();
    const endRow = getGroupsMainScanEndRow();
    const a1 = `${groupsTabA1}!${minCol}1:${maxCol}${endRow}`;

    const groupsResp = await sheets.spreadsheets.values.get({
        spreadsheetId: groupsSpreadsheetId,
        range: a1,
    });
    const groupsRows = groupsResp.data.values || [];
    let player1 = null;
    let player2 = null;
    for (let i = 0; i < groupsRows.length; i += 1) {
        const row = groupsRows[i] || [];
        const code = normalizeMainLobbyKey(row[lobbyOff] ?? "");
        if (code && code === want) {
            player1 = String(row[p1Off] ?? "").trim();
            player2 = String(row[p2Off] ?? "").trim();
            break;
        }
    }

    if (!player1 || !player2) {
        // Fallback: row-bounded single-column search + one row read (handles odd API edge cases)
        const rowNum = await findLobbyRow(
            sheets,
            groupsSpreadsheetId,
            groupsTabName,
            lobbyColLet,
            lobbyCode
        );
        if (rowNum !== -1) {
            const one = await sheets.spreadsheets.values.get({
                spreadsheetId: groupsSpreadsheetId,
                range: `${groupsTabA1}!${minCol}${rowNum}:${maxCol}${rowNum}`,
            });
            const r = (one.data.values && one.data.values[0]) || [];
            player1 = String(r[p1Off] ?? "").trim();
            player2 = String(r[p2Off] ?? "").trim();
        }
    }

    if (!player1 || !player2) {
        const sample = [];
        for (let i = 0; i < groupsRows.length && sample.length < 8; i += 1) {
            const c = normalizeMainLobbyKey(groupsRows[i]?.[lobbyOff] ?? "");
            if (c && /^[A-Z]\d+$/.test(c)) sample.push(c);
        }
        const sampleStr = sample.length ? ` (ex. col ${lobbyColLet}: ${sample.join(", ")})` : "";
        throw new Error(
            `Lobby "${lobbyCode}" not found in "${groupsTabName}" (or players missing in cols ${p1}/${p2}).` +
            ` Scanned ${minCol}1:${maxCol}${endRow} (${groupsRows.length} rows).` +
            sampleStr
        );
    }

    const matchTabCol = getScheduleMatchTabColumn();
    const tabIdx = scheduleMatchTabIndexFromG();
    // Sheet 1 G:Q (etc.) → G=0, H=1, … match tab name at GOOGLE_SHEETS_MATCH_TAB_COLUMN
    const scheduleResp = await sheets.spreadsheets.values.get({
        spreadsheetId: scheduleSpreadsheetId,
        range: `${scheduleTabName}!G:${matchTabCol}`,
    });
    const scheduleRows = scheduleResp.data.values || [];

    for (let i = 0; i < scheduleRows.length; i++) {
        const row = scheduleRows[i];
        const g = String(row?.[0] || "").trim();
        const h = String(row?.[1] || "").trim();
        const matches =
            (g === player1 && h === player2) || (g === player2 && h === player1);
        if (matches) {
            const tabName = String(row?.[tabIdx] || "").trim();
            return { scheduleRow: i + 1, player1, player2, tabName: tabName || null };
        }
    }

    throw new Error(
        `Lobby "${lobbyCode}" (${player1} vs ${player2}) not found in "${scheduleTabName}" — ` +
        `check that both players are in cols G/H of the Schedule.`
    );
}

/**
 * Syncs Sheet 1's "ID" column (col I) so each Schedule row shows the lobby
 * code ("A1", "D3", etc.) its matchup corresponds to on Sheet 2.
 *
 * Purely cosmetic: Sheet 1's ID column is for human reference. Everywhere else
 * in the bot we still cross-reference by player names (col G/H of Schedule)
 * so reschedule / ref / score / standings keep working even if IDs drift.
 *
 * Lookup is done by matching the pair of players on each Schedule row to a
 * match row on Sheet 2 (M/P, either ordering). Rows whose players don't
 * appear on Sheet 2 are skipped and reported as "unmatched".
 *
 * @returns {Promise<{ matched: number, cleared: number, unmatched: Array<{row: number, players: string}> }>}
 */
export async function syncScheduleIds() {
    const sheets = getSheetsClient();

    const groupsSpreadsheetId = process.env.GOOGLE_GROUPS_SHEETS_ID || DEFAULT_GROUPS_SPREADSHEET_ID;
    const groupsTabName = process.env.GOOGLE_GROUPS_TAB_NAME || DEFAULT_GROUPS_TAB_NAME;
    const scheduleSpreadsheetId = process.env.GOOGLE_SHEETS_ID;
    const scheduleTabName = process.env.GOOGLE_SHEETS_TAB_NAME || "Schedule";
    const idCol = "I";

    if (!scheduleSpreadsheetId) {
        throw new Error("GOOGLE_SHEETS_ID is not configured.");
    }

    const groupsTabA1 = quoteSheetNameForA1(groupsTabName);
    const { minCol, maxCol, lobbyOff, p1Off, p2Off } = groupsMainPlayerCrossRefSlice();
    const endRow = getGroupsMainScanEndRow();
    const groupsRange = `${groupsTabA1}!${minCol}1:${maxCol}${endRow}`;

    // Main groups: build (sorted-player-pair → lobby code) map.
    const groupsResp = await sheets.spreadsheets.values.get({
        spreadsheetId: groupsSpreadsheetId,
        range: groupsRange,
    });
    const groupsRows = groupsResp.data.values || [];

    const pairKey = (a, b) => [a.trim(), b.trim()].sort().join("|");
    const lobbyByPair = new Map();
    for (const row of groupsRows) {
        const code = normalizeMainLobbyKey(row?.[lobbyOff] || "");
        if (!/^[A-Z]\d+$/.test(code)) continue;
        const p1 = String(row?.[p1Off] || "").trim();
        const p2 = String(row?.[p2Off] || "").trim();
        if (!p1 || !p2) continue;
        lobbyByPair.set(pairKey(p1, p2), code);
    }

    // Sheet 1: walk G/H, set col I to matching lobby code (or clear if not found).
    const scheduleResp = await sheets.spreadsheets.values.get({
        spreadsheetId: scheduleSpreadsheetId,
        range: `${scheduleTabName}!G:I`,
    });
    const scheduleRows = scheduleResp.data.values || [];

    const updates = [];
    const unmatched = [];
    let matched = 0;
    let cleared = 0;

    for (let i = 0; i < scheduleRows.length; i++) {
        const row = scheduleRows[i] || [];
        const g = String(row[0] || "").trim();
        const h = String(row[1] || "").trim();
        const existingId = String(row[2] || "").trim();
        const rowNumber = i + 1;

        if (!g || !h) continue; // empty schedule row — skip

        const code = lobbyByPair.get(pairKey(g, h));
        if (code) {
            if (existingId !== code) {
                updates.push({
                    range: `${scheduleTabName}!${idCol}${rowNumber}`,
                    values: [[code]],
                });
            }
            matched += 1;
        } else {
            // Pair not on Sheet 2 — clear any stale ID so it doesn't mislead.
            if (existingId) {
                updates.push({
                    range: `${scheduleTabName}!${idCol}${rowNumber}`,
                    values: [[""]],
                });
                cleared += 1;
            }
            unmatched.push({ row: rowNumber, players: `${g} vs ${h}` });
        }
    }

    if (updates.length > 0) {
        await sheets.spreadsheets.values.batchUpdate({
            spreadsheetId: scheduleSpreadsheetId,
            requestBody: {
                valueInputOption: "RAW",
                data: updates,
            },
        });
    }

    return { matched, cleared, unmatched };
}

/**
 * Writes Google Sheets formulas into the main groups tab columns **S** (MP) and **T** (VOD).
 * Each row pulls URLs from the ref **Schedule** tab (`I` = lobby code, `O` = MP, `P` = VOD)
 * by matching the main sheet **lobby** column (`GOOGLE_GROUPS_LOBBY_COLUMN`, default **G**) —
 * same logic as `sheet-link-formulas.txt`.
 *
 * First time with IMPORTRANGE across files, open the sheet and approve access on any MP/VOD cell.
 *
 * Only rows whose **lobby** column (see `GOOGLE_GROUPS_LOBBY_COLUMN`, default **G**) looks like a lobby
 * code (`A1`, `B2`, …) are updated so blank lobby cells (e.g. subheaders) are left untouched.
 * Output columns default **S** / **T**; set `GOOGLE_GROUPS_MP_LINK_COLUMN` / `GOOGLE_GROUPS_VOD_LINK_COLUMN`
 * if MP/VOD are elsewhere (e.g. **I** / **J** on the compact groups layout).
 *
 * @param {{ startRow?: number, rowCount?: number }} [opts]
 * @returns {Promise<{ startRow: number, endRow: number, scannedRows: number, rowsWritten: number,
 *   lobbyColumn: string, mpColumn: string, vodColumn: string }>}
 */
export async function applyGroupsSheetMpVodLinkFormulas(opts = {}) {
    const sheets = getSheetsClient();
    const groupsId = process.env.GOOGLE_GROUPS_SHEETS_ID || DEFAULT_GROUPS_SPREADSHEET_ID;
    const groupsTab = process.env.GOOGLE_GROUPS_TAB_NAME || DEFAULT_GROUPS_TAB_NAME;
    const groupsTabA1 = quoteSheetNameForA1(groupsTab);
    const lobbyCol = String(process.env.GOOGLE_GROUPS_LOBBY_COLUMN || "G")
        .replace(/\$/g, "")
        .toUpperCase();
    const mpCol = String(process.env.GOOGLE_GROUPS_MP_LINK_COLUMN || "S")
        .replace(/\$/g, "")
        .toUpperCase();
    const vodCol = String(process.env.GOOGLE_GROUPS_VOD_LINK_COLUMN || "T")
        .replace(/\$/g, "")
        .toUpperCase();

    const envStart = parseInt(process.env.GOOGLE_GROUPS_LINK_FORMULAS_START_ROW || "4", 10);
    const envCount = parseInt(process.env.GOOGLE_GROUPS_LINK_FORMULAS_ROW_COUNT || "500", 10);
    const startRow = Math.max(1, opts.startRow ?? envStart);
    const rowCount = Math.min(3000, Math.max(1, opts.rowCount ?? envCount));
    const endRow = startRow + rowCount - 1;

    const gResp = await sheets.spreadsheets.values.get({
        spreadsheetId: groupsId,
        range: `${groupsTabA1}!${lobbyCol}${startRow}:${lobbyCol}${endRow}`,
    });
    const gRows = gResp.data.values || [];
    const lobbyRe = /^[A-Z]\d+$/i;

    const dataExpr = buildMpVodLetDataExpression();
    const sep = getFormulaArgSeparator();
    const updates = [];

    for (let i = 0; i < gRows.length; i += 1) {
        const r = startRow + i;
        const gVal = String(gRows[i]?.[0] ?? "").trim();
        if (!lobbyRe.test(gVal)) continue;

        const fS = buildMpVodCellFormula(r, dataExpr, 7, sep, lobbyCol);
        const fT = buildMpVodCellFormula(r, dataExpr, 8, sep, lobbyCol);
        updates.push({ range: `${groupsTabA1}!${mpCol}${r}`, values: [[fS]] });
        updates.push({ range: `${groupsTabA1}!${vodCol}${r}`, values: [[fT]] });
    }

    const chunkSize = 100;
    for (let i = 0; i < updates.length; i += chunkSize) {
        await sheets.spreadsheets.values.batchUpdate({
            spreadsheetId: groupsId,
            requestBody: {
                valueInputOption: "USER_ENTERED",
                data: updates.slice(i, i + chunkSize),
            },
        });
    }

    return {
        startRow,
        endRow,
        scannedRows: rowCount,
        rowsWritten: updates.length / 2,
        lobbyColumn: lobbyCol,
        mpColumn: mpCol,
        vodColumn: vodCol,
    };
}

/** Group colours for the ■ link text (A–D / E–H same pattern as your design). */
const GROUP_SQUARE_COLOR_HEX = {
    A: "df63fa",
    B: "0048fc",
    C: "fcab00",
    D: "fcab00",
    E: "df63fa",
    F: "0048fc",
    G: "fcab00",
    H: "fcab00",
};

function hex6ToRgb01(hex6) {
    const h = String(hex6).replace(/^#/, "");
    if (h.length !== 6) return { red: 0, green: 0, blue: 0 };
    return {
        red: parseInt(h.slice(0, 2), 16) / 255,
        green: parseInt(h.slice(2, 4), 16) / 255,
        blue: parseInt(h.slice(4, 6), 16) / 255,
    };
}

function rgbForLobbyCode(lobby) {
    const c = String(lobby).trim().toUpperCase().charAt(0);
    const hex = GROUP_SQUARE_COLOR_HEX[c] || GROUP_SQUARE_COLOR_HEX.A;
    return hex6ToRgb01(hex);
}

function isPlausibleUrl(s) {
    return /^https?:\/\//i.test(String(s ?? "").trim());
}

function escapeSheetFormulaString(s) {
    return String(s).replace(/"/g, '""');
}

function hyperLinkSquareCellData(url, rgb) {
    const sq = process.env.GOOGLE_GROUPS_SQUARE_CHAR || "\u25a0";
    const f = `=HYPERLINK("${escapeSheetFormulaString(url)}","${escapeSheetFormulaString(sq)}")`;
    return {
        userEnteredValue: { formulaValue: f },
        userEnteredFormat: {
            textFormat: { foregroundColor: rgb, underline: false },
        },
    };
}

/** Clears content (removes a ■) when the ref has no URL. */
function clearSquareCellData() {
    return {
        userEnteredValue: { stringValue: "" },
        userEnteredFormat: {
            textFormat: { underline: false },
        },
    };
}

function pairKeyForSchedule(a, b) {
    return [String(a).trim(), String(b).trim()].sort().join("|");
}

/**
 * Batched reads from ref Schedule: col I = lobby, O = MP, Q = VOD, plus G/H for
 * name fallback when I doesn’t match.
 */
async function buildScheduleUrlLookup(sheets, scheduleId, schedTab, endRow) {
    const idCol = normalizeColumnLetter(
        process.env.GOOGLE_SHEETS_SCHEDULE_ID_COLUMN || process.env.GOOGLE_SHEETS_SCHEDULE_LOBBY_ID_COLUMN || "I"
    );
    const mpC = normalizeColumnLetter(process.env.GOOGLE_SHEETS_SCHEDULE_MP_COLUMN || "O");
    const vodC = normalizeColumnLetter(process.env.GOOGLE_SHEETS_SCHEDULE_VOD_COLUMN || "Q");
    const gCol = "G";
    const hCol = "H";
    const tab = quoteSheetNameForA1(schedTab);

    const [idRes, mpRes, vodRes, gRes, hRes] = await Promise.all([
        sheets.spreadsheets.values.get({ spreadsheetId: scheduleId, range: `${tab}!${idCol}1:${idCol}${endRow}` }),
        sheets.spreadsheets.values.get({ spreadsheetId: scheduleId, range: `${tab}!${mpC}1:${mpC}${endRow}` }),
        sheets.spreadsheets.values.get({ spreadsheetId: scheduleId, range: `${tab}!${vodC}1:${vodC}${endRow}` }),
        sheets.spreadsheets.values.get({ spreadsheetId: scheduleId, range: `${tab}!${gCol}1:${gCol}${endRow}` }),
        sheets.spreadsheets.values.get({ spreadsheetId: scheduleId, range: `${tab}!${hCol}1:${hCol}${endRow}` }),
    ]);

    const idRows = idRes.data.values || [];
    const mpRows = mpRes.data.values || [];
    const vodRows = vodRes.data.values || [];
    const gRows = gRes.data.values || [];
    const hRows = hRes.data.values || [];
    const n = endRow;

    const byLobby = new Map();
    const byPair = new Map();
    for (let i = 0; i < n; i += 1) {
        const mp = String(mpRows[i]?.[0] ?? "").trim();
        const vod = String(vodRows[i]?.[0] ?? "").trim();
        const g = String(gRows[i]?.[0] ?? "").trim();
        const h = String(hRows[i]?.[0] ?? "").trim();
        if (g && h) {
            byPair.set(pairKeyForSchedule(g, h), { mp, vod, row: i + 1 });
        }
        const idRaw = String(idRows[i]?.[0] ?? "");
        const id = normalizeMainLobbyKey(idRaw);
        if (id && /^[A-Z]\d+$/.test(id)) {
            if (!byLobby.has(id)) byLobby.set(id, { mp, vod, row: i + 1 });
        }
    }
    return { byLobby, byPair };
}

async function getGridSheetIdByName(sheets, spreadsheetId, title) {
    const res = await sheets.spreadsheets.get({
        spreadsheetId,
        fields: "sheets.properties",
    });
    const tab = res.data.sheets?.find((s) => s.properties?.title === title);
    if (tab?.properties?.sheetId == null) {
        throw new Error(`No sheet tab named "${title}" in this spreadsheet.`);
    }
    return tab.properties.sheetId;
}

/**
 * Main tab S/T (or env): set `=HYPERLINK(…,"■")` with your group text colours (no
 * underline) from ref Schedule O/Q. Clears a cell if the URL in ref is empty (removes
 * a ■ with no VOD/MP). Cross-refs by Schedule **I** first, then G/H + main E/H.
 */
export async function applyGroupsMpVodSquareHyperlinksFromSchedule(opts = {}) {
    const sheets = getSheetsClient();
    const groupsId = process.env.GOOGLE_GROUPS_SHEETS_ID || DEFAULT_GROUPS_SPREADSHEET_ID;
    const mainTab = process.env.GOOGLE_GROUPS_TAB_NAME || DEFAULT_GROUPS_TAB_NAME;
    const scheduleId = process.env.GOOGLE_SHEETS_ID;
    const schedTab = process.env.GOOGLE_SHEETS_TAB_NAME || "Schedule";
    if (!scheduleId) {
        throw new Error("GOOGLE_SHEETS_ID is not configured (ref / Schedule spreadsheet).");
    }

    const mpTgt = normalizeColumnLetter(
        process.env.GOOGLE_GROUPS_SQUARE_MP_COLUMN || process.env.GOOGLE_SQUARE_MP_COLUMN || "S"
    );
    const vodTgt = normalizeColumnLetter(
        process.env.GOOGLE_GROUPS_SQUARE_VOD_COLUMN || process.env.GOOGLE_SQUARE_VOD_COLUMN || "T"
    );
    if (mpTgt === vodTgt) {
        throw new Error("MP and VOD square columns must differ (default S and T).");
    }

    const { minCol, maxCol, lobbyOff, p1Off, p2Off } = groupsMainPlayerCrossRefSlice();
    const endMain = getGroupsMainScanEndRow();
    const envStart = parseInt(process.env.GOOGLE_GROUPS_LINK_FORMULAS_START_ROW || "4", 10);
    const envCount = parseInt(process.env.GOOGLE_GROUPS_LINK_FORMULAS_ROW_COUNT || "500", 10);
    const startRow = Math.max(1, opts.startRow ?? envStart);
    const rowCount = Math.min(3000, Math.max(1, opts.rowCount ?? envCount));
    const endRow = startRow + rowCount - 1;

    const mainTabA1 = quoteSheetNameForA1(mainTab);
    const mainA1 = `${mainTabA1}!${minCol}1:${maxCol}${endMain}`;
    const mainRes = await sheets.spreadsheets.values.get({
        spreadsheetId: groupsId,
        range: mainA1,
    });
    const mainRows = mainRes.data.values || [];
    const lobbyRe = /^[A-Z]\d+$/i;

    const { byLobby, byPair } = await buildScheduleUrlLookup(
        sheets,
        scheduleId,
        schedTab,
        endMain
    );

    const sheetId = await getGridSheetIdByName(sheets, groupsId, mainTab);
    const tMp = columnLettersToIndex0(mpTgt);
    const tVod = columnLettersToIndex0(vodTgt);
    if (tVod - tMp !== 1) {
        throw new Error("Set GOOGLE_GROUPS_SQUARE_MP_COLUMN and ..._VOD_COLUMN to adjacent columns (e.g. S, T) with VOD immediately to the right of MP.");
    }
    const startCol = tMp;
    const endColEx = tVod + 1;

    const requests = [];
    let hyperlinksSet = 0;
    let cellsCleared = 0;

    const pushRow = (row0, rowData) => {
        requests.push({
            updateCells: {
                range: {
                    sheetId,
                    startRowIndex: row0,
                    endRowIndex: row0 + 1,
                    startColumnIndex: startCol,
                    endColumnIndex: endColEx,
                },
                rows: [rowData],
                fields: "userEnteredValue,userEnteredFormat.textFormat",
            },
        });
    };

    for (let i = startRow - 1; i < endRow && i < mainRows.length; i += 1) {
        const row = mainRows[i] || [];
        const lobby = normalizeMainLobbyKey(row[lobbyOff] ?? "");
        if (!lobbyRe.test(lobby)) continue;

        const p1 = String(row[p1Off] ?? "").trim();
        const p2 = String(row[p2Off] ?? "").trim();
        const rgb = rgbForLobbyCode(lobby);
        const sheetRow0 = i;

        let src = byLobby.get(lobby);
        if (!src && p1 && p2) {
            src = byPair.get(pairKeyForSchedule(p1, p2));
        }
        if (!src) {
            continue;
        }
        const mpUrl = isPlausibleUrl(src.mp) ? String(src.mp).trim() : "";
        const vodUrl = isPlausibleUrl(src.vod) ? String(src.vod).trim() : "";
        const cMp = mpUrl ? hyperLinkSquareCellData(mpUrl, rgb) : clearSquareCellData();
        const cVod = vodUrl ? hyperLinkSquareCellData(vodUrl, rgb) : clearSquareCellData();
        if (mpUrl) hyperlinksSet += 1;
        else cellsCleared += 1;
        if (vodUrl) hyperlinksSet += 1;
        else cellsCleared += 1;
        pushRow(sheetRow0, { values: [cMp, cVod] });
    }

    for (let i = 0; i < requests.length; i += 40) {
        await sheets.spreadsheets.batchUpdate({
            spreadsheetId: groupsId,
            requestBody: { requests: requests.slice(i, i + 40) },
        });
    }

    return {
        startRow,
        endRow,
        requestCount: requests.length,
        hyperlinksSet,
        cellsCleared,
        squareMpColumn: mpTgt,
        squareVodColumn: vodTgt,
    };
}

/**
 * Updates the date/time for a lobby's match on Sheet 1's Schedule. Looks up
 * the Schedule row by cross-referencing player names (see findScheduleRowByLobbyCode).
 *
 * @param {string} lobbyCode
 * @param {string} dateValue
 * @param {string} timeValue
 * @returns {Promise<{ rowNumber: number, player1: string, player2: string }>}
 */
export async function updateLobbyDateTime(lobbyCode, dateValue, timeValue) {
    const spreadsheetId = process.env.GOOGLE_SHEETS_ID;
    const sheetName = process.env.GOOGLE_SHEETS_TAB_NAME || "Schedule";
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
    const { scheduleRow, player1, player2 } = await findScheduleRowByLobbyCode(sheets, lobbyCode);

    if (dateColumn && timeColumn) {
        await sheets.spreadsheets.values.batchUpdate({
            spreadsheetId,
            requestBody: {
                valueInputOption: "USER_ENTERED",
                data: [
                    {
                        range: `${sheetName}!${dateColumn}${scheduleRow}`,
                        values: [[dateValue]],
                    },
                    {
                        range: `${sheetName}!${timeColumn}${scheduleRow}`,
                        values: [[timeValue]],
                    },
                ],
            },
        });
    } else {
        const datetime = `${dateValue} ${timeValue}`.trim();
        await sheets.spreadsheets.values.update({
            spreadsheetId,
            range: `${sheetName}!${datetimeColumn}${scheduleRow}`,
            valueInputOption: "USER_ENTERED",
            requestBody: { values: [[datetime]] },
        });
    }

    return { rowNumber: scheduleRow, player1, player2 };
}

/**
 * Sets (or clears) the referee for a lobby's match on Sheet 1's Schedule.
 * Cross-references lobby code → players → schedule row via
 * findScheduleRowByLobbyCode.
 *
 * @param {string} lobbyCode
 * @param {string} refereeValue
 * @returns {Promise<{ rowNumber: number, refereeColumnLetter: string, player1: string, player2: string }>}
 */
export async function updateLobbyReferee(lobbyCode, refereeValue) {
    const spreadsheetId = process.env.GOOGLE_SHEETS_ID;
    const sheetName = process.env.GOOGLE_SHEETS_TAB_NAME || "Schedule";
    const refereeColumn = process.env.GOOGLE_SHEETS_REFEREE_COLUMN || "J";

    if (!spreadsheetId) {
        throw new Error("GOOGLE_SHEETS_ID is not configured.");
    }

    const sheets = getSheetsClient();
    const { scheduleRow, player1, player2 } = await findScheduleRowByLobbyCode(sheets, lobbyCode);

    await sheets.spreadsheets.values.update({
        spreadsheetId,
        range: `${sheetName}!${refereeColumn}${scheduleRow}`,
        valueInputOption: "USER_ENTERED",
        requestBody: { values: [[refereeValue]] },
    });

    return {
        rowNumber: scheduleRow,
        refereeColumnLetter: refereeColumn,
        player1,
        player2,
    };
}

/**
 * Reads all lobby scores from the Schedule tab.
 * Returns a Map of lobbyCode → { score1, score2, tabName }.
 * Schedule layout (from col D): D=lobby, M=score1, N=score2, Q=tabName (configurable)
 */
async function readAllScheduleScores(sheets, spreadsheetId, sheetName, lobbyColumn) {
    const matchTabCol = getScheduleMatchTabColumn();
    const response = await sheets.spreadsheets.values.get({
        spreadsheetId,
        range: `${sheetName}!D:${matchTabCol}`,
    });
    const rows = response.data.values || [];
    const colM = "M".charCodeAt(0) - "D".charCodeAt(0); // 9
    const colN = "N".charCodeAt(0) - "D".charCodeAt(0); // 10
    const colTab = scheduleMatchTabIndexFromD();

    const scoreMap = new Map();
    for (const row of rows) {
        const lobby = String(row[0] || "").trim().toUpperCase();
        if (!/^[A-Z]\d+$/.test(lobby)) continue;
        scoreMap.set(lobby, {
            score1: Number(row[colM]) || 0,
            score2: Number(row[colN]) || 0,
            tabName: String(row[colTab] || "").trim(),
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

    if (!spreadsheetId) {
        throw new Error("GOOGLE_SHEETS_ID is not configured.");
    }

    const sheets = getSheetsClient();
    const { tabName } = await findScheduleRowByLobbyCode(sheets, lobbyCode);

    if (!tabName) {
        throw new Error(
            `Lobby "${lobbyCode}" has no match tab assigned (${getScheduleMatchTabColumn()} is empty on Schedule).`
        );
    }

    await sheets.spreadsheets.values.batchUpdate({
        spreadsheetId,
        requestBody: {
            valueInputOption: "USER_ENTERED",
            data: [
                { range: `${tabName}!C3`, values: [[String(redScore)]] },
                { range: `${tabName}!E3`, values: [[String(blueScore)]] },
            ],
        },
    });

    return { tabName, team1Score: redScore, team2Score: blueScore };
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
// Column layout constants for Sheet 2 (groups schedule).
const GROUPS_SHEET_COLS = {
    lobbyCol: "G",
    dateCol: "H",
    timeCol: "I",
    player1Col: "M",
    player2Col: "P",
    score1Col: "N",
    score2Col: "O",
    refCol: "Q",
    rankCol: "Z",
    playerCol: "AA",
    winsCol: "AB",
    lossesCol: "AC",
    pfCol: "AD",
    paCol: "AE",
    pdCol: "AF",
    seedCol: "AG",
};

/**
 * Reads Sheet 2's groups schedule and returns a self-describing list of
 * groupDetails per detected group. Every field the writer needs is captured
 * here so downstream writes don't need to re-read the sheet.
 *
 * @returns {Promise<Array<{
 *   letter: string, startIndex: number, startRow: number,
 *   lobbyCodes: string[],      // 6 entries, one per match row
 *   matchRows: Array<{m: string, p: string}>, // 6 entries
 *   players: string[],         // 4 entries from AA of standings rows
 *   seeds: number[],           // 4 entries from AG; missing seeds become 99
 * }>>}
 */
async function readGroupDetails() {
    const spreadsheetId = process.env.GOOGLE_GROUPS_SHEETS_ID || DEFAULT_GROUPS_SPREADSHEET_ID;
    const sheetName = process.env.GOOGLE_GROUPS_TAB_NAME || DEFAULT_GROUPS_TAB_NAME;
    const sheets = getSheetsClient();

    const response = await sheets.spreadsheets.values.get({
        spreadsheetId,
        range: `${sheetName}!D1:AG`,
    });
    const rows = response.data.values || [];

    const result = [];
    for (let i = 0; i < rows.length; i++) {
        const cell = String(rows[i]?.[3] || "").trim().toUpperCase();
        if (!/^[A-Z]1$/.test(cell)) continue;

        const letter = cell[0];
        const startIndex = i;
        const startRow = startIndex + 1;
        const lobbyCodes = [];
        const matchRows = [];
        const players = [];
        const seeds = [];

        for (let k = 0; k < 6; k++) {
            const row = rows[startIndex + k] || [];
            lobbyCodes.push(String(row[3] || "").trim());
            matchRows.push({
                m: String(row[9] || "").trim(),  // col M (idx 9 inside D:AG)
                p: String(row[12] || "").trim(), // col P (idx 12 inside D:AG)
            });
            if (k < 4) {
                const name = String(row[23] || "").trim();     // col AA
                const seedRaw = String(row[29] || "").trim();  // col AG
                const seedNum = parseInt(seedRaw.replace(/^#/, ""), 10);
                players.push(name);
                seeds.push(Number.isFinite(seedNum) ? seedNum : 99);
            }
        }

        result.push({ letter, startIndex, startRow, lobbyCodes, matchRows, players, seeds });
    }

    return result;
}

/**
 * Writes score (N/O) and standings (Z:AG spill) formulas using pre-built
 * groupDetails. Does NOT read the sheet itself — player/seed constants are
 * taken from the input, so the caller controls exactly what gets baked into
 * each group's spill formula. Also applies PD "+" number format and the
 * top-2 pink text highlight.
 */
async function writeGroupStandingsFormulas(groupDetails) {
    const spreadsheetId = process.env.GOOGLE_GROUPS_SHEETS_ID || DEFAULT_GROUPS_SPREADSHEET_ID;
    const sheetName = process.env.GOOGLE_GROUPS_TAB_NAME || DEFAULT_GROUPS_TAB_NAME;
    const sourceSpreadsheetId = process.env.GOOGLE_SHEETS_ID;
    const sourceTabName = process.env.GOOGLE_SHEETS_TAB_NAME || "Schedule";
    const sourceP1Col = "G";
    const sourceP2Col = "H";
    const sourceS1Col = process.env.GOOGLE_SHEETS_RESULT_TEAM1_COLUMN || "M";
    const sourceS2Col = process.env.GOOGLE_SHEETS_RESULT_TEAM2_COLUMN || "N";

    if (!sourceSpreadsheetId) {
        throw new Error("GOOGLE_SHEETS_ID is not configured.");
    }

    const { player1Col, player2Col, score1Col, score2Col, rankCol, dateCol,
            timeCol, refCol,
            playerCol, winsCol, lossesCol, pfCol, paCol, pdCol, seedCol } = GROUPS_SHEET_COLS;

    // Sheet 1 (Schedule) columns that hold date, time, referee per match row.
    const sourceDateCol = process.env.GOOGLE_SHEETS_DATE_COLUMN || "E";
    const sourceTimeCol = process.env.GOOGLE_SHEETS_TIME_COLUMN || "F";
    const sourceRefCol  = process.env.GOOGLE_SHEETS_REFEREE_COLUMN || "J";

    const sheets = getSheetsClient();

    const ir = (col) => `IMPORTRANGE("${sourceSpreadsheetId}","${sourceTabName}!${col}:${col}")`;
    const irP1 = ir(sourceP1Col);
    const irP2 = ir(sourceP2Col);
    const irS1 = ir(sourceS1Col);
    const irS2 = ir(sourceS2Col);
    const irDate = ir(sourceDateCol);
    const irTime = ir(sourceTimeCol);
    const irRef  = ir(sourceRefCol);

    const escapeLit = (s) => `"${String(s).replace(/"/g, '""')}"`;

    const updates = [];
    const pdCellRanges = [];
    const highlightRanges = [];

    for (const { letter, startRow, lobbyCodes, players, seeds } of groupDetails) {
        pdCellRanges.push({ startRow, endRow: startRow + 4 });
        highlightRanges.push({ startRow, endRow: startRow + 2 });

        // ── SCORE COLUMNS N / O ────────────────────────────────────────────
        for (let offset = 0; offset < 6; offset++) {
            const r = startRow + offset;
            const lobby = lobbyCodes[offset] || "";
            if (!lobby) continue;

            const pl1 = `${player1Col}${r}`;
            const pl2 = `${player2Col}${r}`;

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

            // ── DATE / TIME / REFEREE (cols H, I, Q) ───────────────────────
            // These pull from Sheet 1 by cross-referencing the pair of
            // players in M/P, matching either G/H ordering on Schedule.
            // Empty string fallback so unplayed/unscheduled matches stay blank.
            const lookupDateTimeRef = (sourceIr) =>
                `IFERROR(IFNA(` +
                `FILTER(${sourceIr},${irP1}=${pl1},${irP2}=${pl2}),` +
                `FILTER(${sourceIr},${irP1}=${pl2},${irP2}=${pl1})),"")`;

            updates.push({
                range: `${sheetName}!${dateCol}${r}`,
                values: [[`=${lookupDateTimeRef(irDate)}`]],
            });
            updates.push({
                range: `${sheetName}!${timeCol}${r}`,
                values: [[`=${lookupDateTimeRef(irTime)}`]],
            });
            updates.push({
                range: `${sheetName}!${refCol}${r}`,
                values: [[`=${lookupDateTimeRef(irRef)}`]],
            });
        }

        // ── STANDINGS (auto-sorted spill formula at Z{startRow}) ───────────
        // Produces a 4x8 table that spills into Z:AG, sorted by
        // wins desc → PD desc → PF desc → seed asc. Ties share the same
        // rank label so e.g. two tied players both show "#2".
        const m = `${player1Col}${startRow}:${player1Col}${startRow + 5}`;
        const p = `${player2Col}${startRow}:${player2Col}${startRow + 5}`;
        const n = `${score1Col}${startRow}:${score1Col}${startRow + 5}`;
        const o = `${score2Col}${startRow}:${score2Col}${startRow + 5}`;

        const PL = `{${players.map(escapeLit).join(";")}}`; // column vector, semicolons
        const SD = `{${seeds.join(";")}}`;

        const spill =
            `=LET(` +
            `M_,${m},` +
            `P_,${p},` +
            `N_,${n},` +
            `O_,${o},` +
            `PL,${PL},` +
            `SD,${SD},` +
            // effS(self, opp) → effective score accounting for forfeits.
            // Forfeits are marked as 0/-1 in N/O so the sheet can still
            // display the raw forfeit; for standings we translate to 5-0.
            // The LAMBDA is called per-scalar inside nested MAP, which
            // iterates reliably — doing the IF as `effN,IF(N_<0,...)` in a
            // LET binding collapses to a scalar and poisons every stat.
            `effS,LAMBDA(self,opp,IF(self<0,0,IF(opp<0,5,self))),` +
            // Win: own effective score ≥ 5. Loss: opponent's ≥ 5.
            // Each stat is computed via MAP(M_,N_,O_,LAMBDA(m,n,o,…))
            // summed over the 6 match rows.
            `WN,MAP(PL,LAMBDA(pn,` +
                `SUM(MAP(M_,N_,O_,LAMBDA(m,n,o,(m=pn)*(effS(n,o)>=5))))` +
                `+SUM(MAP(P_,N_,O_,LAMBDA(p,n,o,(p=pn)*(effS(o,n)>=5))))` +
            `)),` +
            `LS,MAP(PL,LAMBDA(pn,` +
                `SUM(MAP(M_,N_,O_,LAMBDA(m,n,o,(m=pn)*(effS(o,n)>=5))))` +
                `+SUM(MAP(P_,N_,O_,LAMBDA(p,n,o,(p=pn)*(effS(n,o)>=5))))` +
            `)),` +
            `PFS,MAP(PL,LAMBDA(pn,` +
                `SUM(MAP(M_,N_,O_,LAMBDA(m,n,o,(m=pn)*effS(n,o))))` +
                `+SUM(MAP(P_,N_,O_,LAMBDA(p,n,o,(p=pn)*effS(o,n))))` +
            `)),` +
            `PAS,MAP(PL,LAMBDA(pn,` +
                `SUM(MAP(M_,N_,O_,LAMBDA(m,n,o,(m=pn)*effS(o,n))))` +
                `+SUM(MAP(P_,N_,O_,LAMBDA(p,n,o,(p=pn)*effS(n,o))))` +
            `)),` +
            `PDS,MAP(PL,LAMBDA(pn,` +
                `SUM(MAP(M_,N_,O_,LAMBDA(m,n,o,(m=pn)*(effS(n,o)-effS(o,n)))))` +
                `+SUM(MAP(P_,N_,O_,LAMBDA(p,n,o,(p=pn)*(effS(o,n)-effS(n,o)))))` +
            `)),` +
            `TBL,HSTACK(PL,WN,LS,PFS,PAS,PDS,SD),` +
            `ST,SORT(TBL,2,FALSE,6,FALSE,4,FALSE,7,TRUE),` +
            `SW,INDEX(ST,0,2),SPD,INDEX(ST,0,6),SPF,INDEX(ST,0,4),` +
            `RK,MAP(SEQUENCE(4),LAMBDA(k,"#"&(1` +
            `+COUNTIF(SW,">"&INDEX(SW,k))` +
            `+COUNTIFS(SW,"="&INDEX(SW,k),SPD,">"&INDEX(SPD,k))` +
            `+COUNTIFS(SW,"="&INDEX(SW,k),SPD,"="&INDEX(SPD,k),SPF,">"&INDEX(SPF,k))` +
            `))),` +
            `SL,MAP(INDEX(ST,0,7),LAMBDA(s,"#"&s)),` +
            `HSTACK(RK,INDEX(ST,0,1),INDEX(ST,0,2),INDEX(ST,0,3),INDEX(ST,0,4),INDEX(ST,0,5),INDEX(ST,0,6),SL))`;

        updates.push({
            range: `${sheetName}!${rankCol}${startRow}`,
            values: [[spill]],
        });

        console.log(`✅ Group ${letter}: sort formula queued at ${rankCol}${startRow} (spills into Z:AG).`);
    }

    // ── STEP 1: clear old standings content so the spill formulas don't collide.
    const clearRanges = groupDetails.map(
        (g) => `${sheetName}!${rankCol}${g.startIndex + 1}:${seedCol}${g.startIndex + 4}`
    );
    await sheets.spreadsheets.values.batchClear({
        spreadsheetId,
        requestBody: { ranges: clearRanges },
    });

    // ── STEP 2: write score formulas (N/O) and spill formulas (Z).
    await sheets.spreadsheets.values.batchUpdate({
        spreadsheetId,
        requestBody: {
            valueInputOption: "USER_ENTERED",
            data: updates,
        },
    });

    // ── STEP 3: PD "+" number format + top-2 pink highlight.
    try {
        const meta = await sheets.spreadsheets.get({ spreadsheetId });
        const tab = meta.data.sheets?.find((s) => s.properties?.title === sheetName);
        const sheetId = tab?.properties?.sheetId;

        if (sheetId != null) {
            const letterToIdx = (letters) =>
                letters.split("").reduce((acc, c) => acc * 26 + (c.charCodeAt(0) - 64), 0) - 1;
            const pdIdx     = letterToIdx(pdCol);
            const rankIdx   = letterToIdx(rankCol);
            const seedIdx   = letterToIdx(seedCol);

            const requests = [];

            // PD column: "+" prefix for positives
            for (const { startRow, endRow } of pdCellRanges) {
                requests.push({
                    repeatCell: {
                        range: {
                            sheetId,
                            startRowIndex: startRow - 1,
                            endRowIndex: endRow - 1,
                            startColumnIndex: pdIdx,
                            endColumnIndex: pdIdx + 1,
                        },
                        cell: {
                            userEnteredFormat: {
                                numberFormat: { type: "NUMBER", pattern: '"+"0;-0;0' },
                            },
                        },
                        fields: "userEnteredFormat.numberFormat",
                    },
                });
            }

            // Top 2 rows of each group's standings: pink text color across Z:AG.
            // Uses only textFormat.foregroundColor so any existing background,
            // borders, alignment, etc. on those cells stays intact.
            // #df63fa = rgb(223, 99, 250)
            const pink = { red: 223 / 255, green: 99 / 255, blue: 250 / 255 };
            for (const { startRow, endRow } of highlightRanges) {
                requests.push({
                    repeatCell: {
                        range: {
                            sheetId,
                            startRowIndex: startRow - 1,
                            endRowIndex: endRow - 1,
                            startColumnIndex: rankIdx,
                            endColumnIndex: seedIdx + 1,
                        },
                        cell: {
                            userEnteredFormat: {
                                textFormat: { foregroundColor: pink },
                            },
                        },
                        fields: "userEnteredFormat.textFormat.foregroundColor",
                    },
                });
            }

            if (requests.length > 0) {
                await sheets.spreadsheets.batchUpdate({
                    spreadsheetId,
                    requestBody: { requests },
                });
            }
        }
    } catch (err) {
        console.warn(`⚠️ Fórmulas escritas, mas não consegui aplicar formatação: ${err.message ?? err}`);
    }

    return { groups: groupDetails.length, updatesWritten: updates.length };
}

export async function setupStandingsFormulas() {
    const groupDetails = await readGroupDetails();
    if (groupDetails.length === 0) {
        throw new Error(
            `No groups found. Make sure lobby codes like "A1", "B1" are in column ${GROUPS_SHEET_COLS.lobbyCol} of the groups schedule tab.`
        );
    }
    return writeGroupStandingsFormulas(groupDetails);
}

/**
 * Reorders groups within each division (Dreamers = A-D, Mischiefs = E-H)
 * by average seed — lower seeds first. Group A ends up with the best avg
 * seed within Dreamers; Group D with the worst. Same for E→H in Mischiefs.
 *
 * Safety notes:
 *  - Sheet 1 (Schedule) is NEVER touched. Player rows, refs, and match tabs
 *    all stay put there. The reschedule/ref/score flows use name-based
 *    lookups so they keep working after a reorder.
 *  - Only Sheet 2 changes: per physical group position, the match-row data
 *    (cols M/P across 6 rows) and standings constants (AA/AG across 4 rows)
 *    are swapped in. Lobby codes (col G) and group-letter labels stay fixed
 *    at their positions — so "A1" still refers to the top-left match cell,
 *    it just now has the newly-ranked Group A's matchup.
 *  - Tiebreaker for equal avg seeds: the group with the lowest single seed
 *    (best solo player) wins.
 *  - Idempotent: running it twice produces no changes the second time.
 *
 * @returns {Promise<{ dreamers: Array<{position: string, from: string, avgSeed: number}>,
 *                     mischiefs: Array<{position: string, from: string, avgSeed: number}>,
 *                     swapped: number }>}
 */
export async function resortGroupsBySeed() {
    const groupDetails = await readGroupDetails();
    if (groupDetails.length === 0) {
        throw new Error(
            `No groups found. Make sure lobby codes like "A1", "B1" are in column ${GROUPS_SHEET_COLS.lobbyCol} of the groups schedule tab.`
        );
    }

    const spreadsheetId = process.env.GOOGLE_GROUPS_SHEETS_ID || DEFAULT_GROUPS_SPREADSHEET_ID;
    const sheetName = process.env.GOOGLE_GROUPS_TAB_NAME || DEFAULT_GROUPS_TAB_NAME;
    const { player1Col, player2Col } = GROUPS_SHEET_COLS;

    // Compute avg seed + min seed per group for sorting.
    const withStats = groupDetails.map((g) => ({
        ...g,
        avgSeed: g.seeds.reduce((a, b) => a + b, 0) / g.seeds.length,
        minSeed: Math.min(...g.seeds),
    }));

    const DIVISIONS = [
        { name: "dreamers", letters: ["A", "B", "C", "D"] },
        { name: "mischiefs", letters: ["E", "F", "G", "H"] },
    ];

    // For each division, determine the "position letter → source group letter" mapping.
    // Then rebuild groupDetails with each physical position receiving the data
    // of its newly-assigned source group.
    const rebuilt = new Map(); // letter → rebuilt groupDetail
    const summary = { dreamers: [], mischiefs: [], swapped: 0 };

    for (const { name, letters } of DIVISIONS) {
        const originals = withStats.filter((g) => letters.includes(g.letter));
        if (originals.length === 0) continue;

        const sorted = [...originals].sort((a, b) => {
            if (a.avgSeed !== b.avgSeed) return a.avgSeed - b.avgSeed;
            return a.minSeed - b.minSeed;
        });

        for (let pos = 0; pos < sorted.length; pos++) {
            const positionLetter = letters[pos];
            const source = sorted[pos];
            const positionOriginal = originals.find((g) => g.letter === positionLetter);
            if (!positionOriginal) continue;

            // Physical position keeps its own letter / startRow / lobbyCodes,
            // but takes the source group's players, seeds, and match-row data.
            rebuilt.set(positionLetter, {
                letter: positionLetter,
                startIndex: positionOriginal.startIndex,
                startRow: positionOriginal.startRow,
                lobbyCodes: positionOriginal.lobbyCodes,
                matchRows: source.matchRows,
                players: source.players,
                seeds: source.seeds,
            });

            if (source.letter !== positionLetter) summary.swapped += 1;
            summary[name].push({
                position: positionLetter,
                from: source.letter,
                avgSeed: Number(source.avgSeed.toFixed(2)),
            });
        }
    }

    // Assemble the new groupDetails list in original order (so the writer's
    // clear-then-write loop covers all of them).
    const newGroupDetails = groupDetails.map((g) => rebuilt.get(g.letter) || g);

    // STEP 1: overwrite match-row data (cols M, P across 6 rows per group).
    // We use RAW so player names can't accidentally be parsed as formulas.
    const mpUpdates = [];
    for (const g of newGroupDetails) {
        for (let i = 0; i < 6; i++) {
            const r = g.startRow + i;
            const mVal = g.matchRows[i]?.m ?? "";
            const pVal = g.matchRows[i]?.p ?? "";
            mpUpdates.push({ range: `${sheetName}!${player1Col}${r}`, values: [[mVal]] });
            mpUpdates.push({ range: `${sheetName}!${player2Col}${r}`, values: [[pVal]] });
        }
    }
    if (mpUpdates.length > 0) {
        const sheets = getSheetsClient();
        await sheets.spreadsheets.values.batchUpdate({
            spreadsheetId,
            requestBody: { valueInputOption: "RAW", data: mpUpdates },
        });
    }

    // STEP 2: regenerate standings formulas using the NEW players/seeds so
    // each physical group's spill has the correct roster baked in.
    await writeGroupStandingsFormulas(newGroupDetails);

    return summary;
}
