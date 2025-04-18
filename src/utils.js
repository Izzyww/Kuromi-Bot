import dayjs from "dayjs";
import customParseFormat from "dayjs/plugin/customParseFormat.js";

dayjs.extend(customParseFormat);

const separator = "\n\n-----\n\n";

/**
 * @param {string} previousText
 * @param {string} text
 * @returns {string}
 */
function appendSection(previousText, text) {
    return previousText + separator + text;
}

/**
 * @param {string} value
 * @returns {boolean}
 */
function validateDate(value) {
    const match = value.match(/^(\d{1,2})\/(\d{1,2})(?:\/(\d{4}))?$/);

    if (match == null) {
        return false;
    }

    const day = match[1];
    const month = match[2];
    const year = match[3] || (new Date()).getFullYear().toString();
    const date = dayjs(`${day}/${month}/${year}`, "D/M/Y");

    const internalDay = date.date();
    const internalMonth = date.month();

    if (day != internalDay) {
        return false;
    }

    if (month != internalMonth + 1) {
        return false;
    }

    return true;
}

/**
 * @param {string} value
 * @returns {boolean}
 */
function validateTime(value) {
    if (value.match(/^\d{1,2}:\d{1,2}$/) == null) {
        return false;
    }

    const [hours, minutes] = value.split(":").map((value) => Number(value));

    if (hours < 0 || hours > 23) {
        return false;
    }

    if (minutes < 0 || minutes > 59) {
        return false;
    }

    return true;
}

/**
 * @param {string} value
 * @returns {string}
 */
function formatDatetime(value) {
    let date = dayjs(value, "D/M/Y H:m");

    if (!date.isValid()) {
        date = dayjs(value, "D/M H:m");
    }

    return date.format("DD/MM/YYYY HH:mm");
}

const utils = {
    appendSection,
    validateDate,
    validateTime,
    formatDatetime,
};

export default utils;
