const E164_REGEX = /^\+[1-9]\d{1,14}$/;

const GSM_7_BASIC_CHARS =
    '@\u00A3$\u00A5\u00E8\u00E9\u00F9\u00EC\u00F2\u00C7\n\u00D8\u00F8\r\u00C5\u00E5\u0394_\u03A6\u0393\u039B\u03A9\u03A0\u03A8\u03A3\u0398\u039E\u001B\u00C6\u00E6\u00DF\u00C9'
    + ' !"#\u00A4%&\'()*+,-./0123456789:;<=>?\u00A1ABCDEFGHIJKLMNOPQRSTUVWXYZ\u00C4\u00D6\u00D1\u00DC\u00A7\u00BFabcdefghijklmnopqrstuvwxyz\u00E4\u00F6\u00F1\u00FC\u00E0';

const GSM_7_EXTENSION_CHARS = '\f^{}\\\\[~]|\u20AC';

const GSM_7_BASIC_SET = new Set(Array.from(GSM_7_BASIC_CHARS));
const GSM_7_EXTENSION_SET = new Set(Array.from(GSM_7_EXTENSION_CHARS));

function normalizeToList(to) {
    if (Array.isArray(to)) {
        return to.map((item) => String(item || '').trim()).filter(Boolean);
    }

    if (typeof to === 'string') {
        return to
            .split(',')
            .map((item) => item.trim())
            .filter(Boolean);
    }

    return [];
}

function toCodePointHex(character) {
    const point = character.codePointAt(0);
    if (!point) {
        return 'U+0000';
    }
    return `U+${point.toString(16).toUpperCase().padStart(4, '0')}`;
}

function validateE164Number(inputNumber) {
    const input = String(inputNumber || '').trim();
    const normalized = input.replace(/\s+/g, '');

    if (!normalized) {
        return {
            input,
            normalized,
            valid: false,
            validationCode: 'empty_number',
            reason: 'Recipient is empty.',
        };
    }

    if (!normalized.startsWith('+')) {
        return {
            input,
            normalized,
            valid: false,
            validationCode: 'missing_plus_prefix',
            reason: 'E.164 number must start with +.',
        };
    }

    const plusCount = (normalized.match(/\+/g) || []).length;
    if (plusCount !== 1 || normalized.indexOf('+') !== 0) {
        return {
            input,
            normalized,
            valid: false,
            validationCode: 'invalid_plus_position',
            reason: 'Only one + is allowed at the beginning.',
        };
    }

    if (/[^\d+]/.test(normalized)) {
        return {
            input,
            normalized,
            valid: false,
            validationCode: 'invalid_characters',
            reason: 'E.164 allows only digits after +.',
        };
    }

    const digits = normalized.slice(1);
    if (digits.length < 2 || digits.length > 15) {
        return {
            input,
            normalized,
            valid: false,
            validationCode: 'invalid_length',
            reason: 'E.164 must contain 2 to 15 digits after +.',
        };
    }

    if (digits.startsWith('0')) {
        return {
            input,
            normalized,
            valid: false,
            validationCode: 'invalid_country_code',
            reason: 'Country code cannot start with 0 in E.164.',
        };
    }

    if (!E164_REGEX.test(normalized)) {
        return {
            input,
            normalized,
            valid: false,
            validationCode: 'invalid_e164_format',
            reason: 'Invalid E.164 format.',
        };
    }

    return {
        input,
        normalized,
        valid: true,
        validationCode: 'ok',
        reason: '',
    };
}

function addCharacterDetail(map, character, index, reason) {
    const key = `${character}__${toCodePointHex(character)}`;
    if (!map.has(key)) {
        map.set(key, {
            character,
            codePoint: toCodePointHex(character),
            reason,
            indexes: [],
        });
    }

    map.get(key).indexes.push(index);
}

function getCharacterEncodingUnits(character, gsm7Supported) {
    if (!gsm7Supported) {
        return character.length;
    }

    if (GSM_7_EXTENSION_SET.has(character)) {
        return 2;
    }

    return 1;
}

function simulateMultipartSegments(characters, gsm7Supported, perSegmentLimit) {
    if (characters.length === 0 || perSegmentLimit <= 0) {
        return [];
    }

    const segments = [];
    let currentChars = [];
    let currentUnits = 0;

    for (const character of characters) {
        const units = getCharacterEncodingUnits(character, gsm7Supported);

        if (currentChars.length > 0 && currentUnits + units > perSegmentLimit) {
            const text = currentChars.join('');
            segments.push({
                index: segments.length + 1,
                text,
                unitCount: currentUnits,
                characterCount: Array.from(text).length,
            });

            currentChars = [];
            currentUnits = 0;
        }

        currentChars.push(character);
        currentUnits += units;
    }

    if (currentChars.length > 0) {
        const text = currentChars.join('');
        segments.push({
            index: segments.length + 1,
            text,
            unitCount: currentUnits,
            characterCount: Array.from(text).length,
        });
    }

    return segments;
}

function analyzeMessage(messageInput) {
    const message = String(messageInput || '');
    const characters = Array.from(message);

    let gsm7Units = 0;
    let unicodeUnits = 0;

    const unsupportedMap = new Map();
    const extensionMap = new Map();

    characters.forEach((character, index) => {
        unicodeUnits += character.length;

        if (GSM_7_BASIC_SET.has(character)) {
            gsm7Units += 1;
            return;
        }

        if (GSM_7_EXTENSION_SET.has(character)) {
            gsm7Units += 2;
            addCharacterDetail(
                extensionMap,
                character,
                index,
                'Supported through GSM-7 extension table; consumes 2 units (escape + char).'
            );
            return;
        }

        addCharacterDetail(
            unsupportedMap,
            character,
            index,
            'Not present in GSM-7 basic/extension table. Unicode (UCS-2) encoding is required.'
        );
    });

    const unsupportedCharacters = Array.from(unsupportedMap.values());
    const extensionCharacters = Array.from(extensionMap.values());

    const gsm7Supported = unsupportedCharacters.length === 0;
    const encoding = gsm7Supported ? 'GSM-7' : 'UCS-2';

    const totalUnits = gsm7Supported ? gsm7Units : unicodeUnits;
    const singleSegmentLimit = gsm7Supported ? 160 : 70;
    const multipartSegmentLimit = gsm7Supported ? 153 : 67;

    const isMultipart = totalUnits > singleSegmentLimit;
    const perSegmentLimit = isMultipart ? multipartSegmentLimit : singleSegmentLimit;

    const segmentCount = totalUnits > 0 ? Math.ceil(totalUnits / perSegmentLimit) : 0;
    const remainingInCurrentSegment = totalUnits > 0
        ? Math.max(0, segmentCount * perSegmentLimit - totalUnits)
        : perSegmentLimit;

    const segments = simulateMultipartSegments(characters, gsm7Supported, perSegmentLimit);

    return {
        input: message,
        encoding,
        gsm7Supported,
        unicodeDetected: !gsm7Supported,
        totalCharacters: characters.length,
        totalUnits,
        singleSegmentLimit,
        multipartSegmentLimit,
        perSegmentLimit,
        segmentCount,
        isMultipart,
        remainingInCurrentSegment,
        unsupportedCharacters,
        extensionCharacters,
        segments,
    };
}

function analyzeRecipients(toInput) {
    const recipients = normalizeToList(toInput);
    const recipientDetails = recipients.map(validateE164Number);

    const validRecipients = recipientDetails.filter((item) => item.valid).map((item) => item.normalized);
    const invalidRecipients = recipientDetails.filter((item) => !item.valid);

    return {
        total: recipientDetails.length,
        validCount: validRecipients.length,
        invalidCount: invalidRecipients.length,
        validRecipients,
        invalidRecipients,
        details: recipientDetails,
    };
}

function analyzeSmsPayload({ to, message }) {
    return {
        recipients: analyzeRecipients(to),
        message: analyzeMessage(message),
    };
}

module.exports = {
    normalizeToList,
    validateE164Number,
    analyzeRecipients,
    analyzeMessage,
    analyzeSmsPayload,
};
