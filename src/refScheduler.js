import fs from "fs";
import path from "path";
import { getSheetsClient } from "./googleSheets.js";

const REF_CHANNEL_ID = "1330252766072799282";
const POLL_INTERVAL_MS = 60 * 1000;            // check the sheet every minute
const NOTIFY_LEAD_MINUTES = 25;                 // ping this many minutes before match
const NOTIFY_WINDOW_MINUTES = NOTIFY_LEAD_MINUTES; // upper bound of "too far away"

// Persist pinged matches so bot restarts don't re-ping refs who've already
// been notified. JSON file in ./data/ref-pings.json. Entries older than this
// are cleaned up on load — keeps the file bounded over time.
const PING_STORE_PATH = path.resolve(process.cwd(), "data", "ref-pings.json");
const PING_RETENTION_MS = 48 * 60 * 60 * 1000; // 48 hours

function loadPersistedPings() {
    try {
        if (!fs.existsSync(PING_STORE_PATH)) return new Map();
        const raw = fs.readFileSync(PING_STORE_PATH, "utf8");
        const obj = JSON.parse(raw);
        const now = Date.now();
        const kept = new Map();
        for (const [key, ts] of Object.entries(obj)) {
            if (typeof ts === "number" && now - ts < PING_RETENTION_MS) {
                kept.set(key, ts);
            }
        }
        return kept;
    } catch (err) {
        console.warn(`⚠️ Falha ao ler ${PING_STORE_PATH}:`, err.message ?? err);
        return new Map();
    }
}

function persistPings(pingedMap) {
    try {
        const dir = path.dirname(PING_STORE_PATH);
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        const obj = Object.fromEntries(pingedMap);
        fs.writeFileSync(PING_STORE_PATH, JSON.stringify(obj, null, 2));
    } catch (err) {
        console.warn(`⚠️ Falha ao salvar ${PING_STORE_PATH}:`, err.message ?? err);
    }
}

const NETWORK_ERROR_CODES = new Set([
    "ENOTFOUND", "ECONNRESET", "ECONNREFUSED", "ETIMEDOUT", "EAI_AGAIN",
]);
function isNetworkError(err) {
    return (
        NETWORK_ERROR_CODES.has(err?.code) ||
        NETWORK_ERROR_CODES.has(err?.cause?.code) ||
        NETWORK_ERROR_CODES.has(err?.error?.code)
    );
}

// Portuguese month abbreviations used by utils.formatDateForSheet:
// "(Sáb) Abr 18", "(Dom) Abr 25"
const MONTHS_PT_SHORT = [
    "Jan", "Fev", "Mar", "Abr", "Mai", "Jun",
    "Jul", "Ago", "Set", "Out", "Nov", "Dez",
];

/**
 * Turns the raw sheet cell values (date text like "(Sáb) Abr 18" and time text
 * like "16:00") into a JS Date in local time. Returns null if parsing fails.
 * Assumes the current year — if a match rolls over a calendar year boundary
 * and the sheet date looks like it's in the past by >6 months, we bump it to
 * next year (so a Jan match on a Dec bot still pings correctly).
 */
function parseScheduleDateTime(dateValue, timeValue) {
    if (!dateValue || !timeValue) return null;

    const dateMatch = String(dateValue).match(/\(\s*\w+\s*\)\s*([A-Za-zÀ-ÿ]+)\s+(\d{1,2})/);
    if (!dateMatch) return null;

    const monthName = dateMatch[1];
    const day = parseInt(dateMatch[2], 10);
    const monthIdx = MONTHS_PT_SHORT.findIndex(
        (m) => m.toLowerCase() === monthName.toLowerCase()
    );
    if (monthIdx < 0 || !Number.isFinite(day)) return null;

    const timeMatch = String(timeValue).match(/^(\d{1,2}):(\d{1,2})$/);
    if (!timeMatch) return null;
    const hours = parseInt(timeMatch[1], 10);
    const minutes = parseInt(timeMatch[2], 10);
    if (!Number.isFinite(hours) || !Number.isFinite(minutes)) return null;

    const now = new Date();
    let year = now.getFullYear();
    let date = new Date(year, monthIdx, day, hours, minutes, 0, 0);

    // Year rollover guard: if computed date is >6 months in the past, it's
    // likely next year's date (e.g. a Jan match while bot boots in Dec).
    const sixMonthsMs = 6 * 30 * 24 * 60 * 60 * 1000;
    if (now - date > sixMonthsMs) {
        date = new Date(year + 1, monthIdx, day, hours, minutes, 0, 0);
    }

    return Number.isFinite(date.getTime()) ? date : null;
}

/**
 * Finds a guild member by display name / nickname / username, case-insensitive.
 * Returns the GuildMember or null.
 */
function findMemberByName(guild, rawName) {
    const target = String(rawName || "").trim().toLowerCase();
    if (!target) return null;
    return guild.members.cache.find((m) => {
        const u = (m.user?.username || "").toLowerCase();
        const g = (m.user?.globalName || "").toLowerCase();
        const n = (m.nickname || "").toLowerCase();
        const d = (m.displayName || "").toLowerCase();
        return u === target || g === target || n === target || d === target;
    }) || null;
}

/** Key used to dedupe pings across polls in the same bot session. */
function pingKey(rowNumber, matchDate, refName) {
    return `${rowNumber}|${matchDate.toISOString()}|${refName}`;
}

/**
 * Starts the referee-reminder loop. Polls every minute and pings the ref in
 * the configured channel ~25 minutes before their match starts.
 *
 * In-memory dedup keyed by (row, match datetime, ref name) — so a reschedule
 * or ref change after a ping has already fired will trigger a fresh ping.
 *
 * Only stored in memory: if the bot restarts within the 25-minute window of a
 * match, the ping might re-fire. For a single-day tournament this is fine.
 *
 * @param {import("discord.js").Client} client
 * @returns {{ stop: () => void }}
 */
export function startRefereeReminders(client) {
    const pinged = loadPersistedPings();
    console.log(`⏰ Ref reminders: ${pinged.size} ping(s) já registrados (não serão repetidos).`);
    let timeoutHandle = null;
    let stopped = false;
    let consecutiveNetworkErrors = 0;

    const scheduleNext = (delayMs) => {
        if (stopped) return;
        timeoutHandle = setTimeout(tick, delayMs);
    };

    const tick = async () => {
        if (stopped) return;
        try {
            await pollOnce();
            if (consecutiveNetworkErrors > 0) {
                console.log("✅ Ref reminders: rede restabelecida.");
                consecutiveNetworkErrors = 0;
            }
            scheduleNext(POLL_INTERVAL_MS);
        } catch (err) {
            if (isNetworkError(err)) {
                consecutiveNetworkErrors += 1;
                const backoff = Math.min(
                    POLL_INTERVAL_MS * Math.pow(2, consecutiveNetworkErrors - 1),
                    10 * 60 * 1000
                );
                if (consecutiveNetworkErrors === 1) {
                    console.warn(
                        `⚠️ Ref reminders: sem rede. Retomando em ${Math.round(backoff / 1000)}s.`
                    );
                }
                scheduleNext(backoff);
            } else {
                console.error("Erro no ciclo de ref reminders:", err.message ?? err);
                scheduleNext(POLL_INTERVAL_MS);
            }
        }
    };

    const pollOnce = async () => {
        const spreadsheetId = process.env.GOOGLE_SHEETS_ID;
        const sheetName = process.env.GOOGLE_SHEETS_TAB_NAME || "Schedule";
        if (!spreadsheetId) return;

        const sheets = getSheetsClient();
        const resp = await sheets.spreadsheets.values.get({
            spreadsheetId,
            range: `${sheetName}!D:J`,
        });
        const rows = resp.data.values || [];

        const guild = client.guilds.cache.get(process.env.GUILD_ID)
            || (await client.guilds.fetch(process.env.GUILD_ID).catch(() => null));
        if (!guild) return;

        // Ensure members are in cache for name lookup — fetch once if empty.
        if (guild.members.cache.size <= 1) {
            await guild.members.fetch().catch(() => {});
        }

        const channel = await client.channels.fetch(REF_CHANNEL_ID).catch(() => null);
        if (!channel) return;

        const now = new Date();

        for (let i = 0; i < rows.length; i++) {
            const row = rows[i] || [];
            // D:J → D=0 (match #), E=1 (date), F=2 (time), G=3 (p1),
            // H=4 (p2), I=5 (lobby ID), J=6 (referee).
            const matchNum = String(row[0] || "").trim();
            const dateValue = String(row[1] || "").trim();
            const timeValue = String(row[2] || "").trim();
            const player1 = String(row[3] || "").trim();
            const player2 = String(row[4] || "").trim();
            const lobbyId = String(row[5] || "").trim();
            const refName = String(row[6] || "").trim();

            if (!refName || !dateValue || !timeValue || !player1 || !player2) continue;

            const matchDate = parseScheduleDateTime(dateValue, timeValue);
            if (!matchDate) continue;

            const minutesUntil = (matchDate.getTime() - now.getTime()) / 60000;
            // Skip matches that have already started or that are still further
            // away than our lead window.
            if (minutesUntil <= 0 || minutesUntil > NOTIFY_WINDOW_MINUTES) continue;

            const rowNumber = i + 1;
            const key = pingKey(rowNumber, matchDate, refName);
            if (pinged.has(key)) continue;

            // Mark BEFORE send + persist so a transient network error
            // doesn't cause a double-ping on the next poll. Worst case we
            // miss one ping on a send error — acceptable trade-off.
            pinged.set(key, Date.now());
            persistPings(pinged);

            const member = findMemberByName(guild, refName);
            const refMention = member ? `<@${member.id}>` : `**${refName}**`;
            const lobbyLabel = lobbyId || `#${matchNum}`;
            const minutesRounded = Math.max(1, Math.round(minutesUntil));

            const msg =
                `${refMention} — sua partida **${lobbyLabel}** ` +
                `(${player1} vs ${player2}) começa em **${minutesRounded} min** ` +
                `(${timeValue}).`;

            try {
                await channel.send({ content: msg });
                if (!member) {
                    console.warn(
                        `⚠️ Referee "${refName}" não encontrado no servidor — enviei o lembrete sem menção.`
                    );
                }
                console.log(
                    `📣 Ref reminder: ${lobbyLabel} — ${refName} (${minutesUntil.toFixed(1)} min)`
                );
            } catch (sendErr) {
                console.error(
                    `Erro ao enviar lembrete para ${refName} (lobby ${lobbyLabel}):`,
                    sendErr.message ?? sendErr
                );
            }
        }
    };

    scheduleNext(0); // kick off immediately

    return {
        stop: () => {
            stopped = true;
            if (timeoutHandle) clearTimeout(timeoutHandle);
        },
    };
}
