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
    const date = dayjs(value, "D/M");
    
    if (value.match(/^\d{1,2}\/\d{1,2}$/) == null) {
        return false;
    }

    const [day, month] = value.split("/");
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
    const date = dayjs(value, "D/M H:m");

    return date.format("DD/MM/YYYY HH:mm");
}

const utils = {
    appendSection,
    validateDate,
    validateTime,
    formatDatetime,
};

export default utils;
