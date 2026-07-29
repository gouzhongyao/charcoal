function hasCjkCharacter(value) {
  return /[㐀-䶿一-鿿豈-﫿]/.test(value);
}

function countCjkCharacters(value) {
  return (String(value || '').match(/[㐀-䶿一-鿿豈-﫿]/g) || []).length;
}

function countReplacementCharacters(value) {
  return (String(value || '').match(/�/g) || []).length;
}

function countControlCharacters(value) {
  let count = 0;
  const text = String(value || '');
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    if ((code >= 0 && code <= 8) || code === 11 || code === 12 || (code >= 14 && code <= 31) || (code >= 127 && code <= 159)) {
      count += 1;
    }
  }
  return count;
}

function hasControlCharacter(value) {
  return countControlCharacters(value) > 0;
}

function countMojibakeSignals(value) {
  return (String(value || '').match(/[ÃÂÄÅÆÇÈÉÊËÌÍÎÏÐÑÒÓÔÕÖØÙÚÛÜÝÞßãâäåæçèéêëìíîïðñòóôõöøùúûüýþÿƒ„…†‡ˆ‰Š‹ŒŽ‘’“”•–—˜™š›œžŸ€]/g) || []).length;
}

const CP1252_UNICODE_TO_BYTE = new Map([
  [0x20ac, 0x80],
  [0x201a, 0x82],
  [0x0192, 0x83],
  [0x201e, 0x84],
  [0x2026, 0x85],
  [0x2020, 0x86],
  [0x2021, 0x87],
  [0x02c6, 0x88],
  [0x2030, 0x89],
  [0x0160, 0x8a],
  [0x2039, 0x8b],
  [0x0152, 0x8c],
  [0x017d, 0x8e],
  [0x2018, 0x91],
  [0x2019, 0x92],
  [0x201c, 0x93],
  [0x201d, 0x94],
  [0x2022, 0x95],
  [0x2013, 0x96],
  [0x2014, 0x97],
  [0x02dc, 0x98],
  [0x2122, 0x99],
  [0x0161, 0x9a],
  [0x203a, 0x9b],
  [0x0153, 0x9c],
  [0x017e, 0x9e],
  [0x0178, 0x9f]
]);

function toBytes(value, mode) {
  const bytes = [];
  const text = String(value || '');
  for (let index = 0; index < text.length; index += 1) {
    const code = text.codePointAt(index);
    if (code > 0xffff) {
      index += 1;
    }

    if (mode === 'cp1252' && CP1252_UNICODE_TO_BYTE.has(code)) {
      bytes.push(CP1252_UNICODE_TO_BYTE.get(code));
      continue;
    }

    if (code <= 0xff) {
      bytes.push(code);
      continue;
    }

    return null;
  }
  return bytes;
}

function decodeBytesAsUtf8(value, mode) {
  const bytes = toBytes(value, mode);
  if (!bytes || bytes.length === 0) {
    return '';
  }
  return Buffer.from(bytes).toString('utf8');
}

function scoreFilename(value) {
  const text = String(value || '');
  return {
    cjk: countCjkCharacters(text),
    replacements: countReplacementCharacters(text),
    controls: countControlCharacters(text),
    mojibakeSignals: countMojibakeSignals(text),
    length: text.length
  };
}

function shouldUseDecodedFilename(original, decoded) {
  if (!decoded || decoded === original) {
    return false;
  }

  const originalScore = scoreFilename(original);
  const decodedScore = scoreFilename(decoded);
  if (decodedScore.replacements > originalScore.replacements || decodedScore.controls > 0) {
    return false;
  }

  const cjkGain = decodedScore.cjk - originalScore.cjk;
  const mojibakeReduction = originalScore.mojibakeSignals - decodedScore.mojibakeSignals;
  const replacementReduction = originalScore.replacements - decodedScore.replacements;

  if (cjkGain <= 0) {
    return false;
  }

  return cjkGain >= 2 || mojibakeReduction > 0 || replacementReduction > 0 || originalScore.controls > decodedScore.controls;
}

function decodeUploadOriginalName(originalName) {
  if (originalName === undefined || originalName === null) {
    return originalName;
  }

  const value = String(originalName);
  if (!value || /^[\x20-\x7E]*$/.test(value)) {
    return value;
  }

  if (hasCjkCharacter(value) && countMojibakeSignals(value) === 0 && !hasControlCharacter(value)) {
    return value;
  }

  const candidates = [
    decodeBytesAsUtf8(value, 'latin1'),
    decodeBytesAsUtf8(value, 'cp1252')
  ].filter((candidate, index, list) => candidate && list.indexOf(candidate) === index);

  let best = value;
  let bestScore = scoreFilename(value);
  candidates.forEach((candidate) => {
    if (!shouldUseDecodedFilename(value, candidate)) {
      return;
    }
    const candidateScore = scoreFilename(candidate);
    if (
      candidateScore.cjk > bestScore.cjk
      || (candidateScore.cjk === bestScore.cjk && candidateScore.mojibakeSignals < bestScore.mojibakeSignals)
      || (candidateScore.cjk === bestScore.cjk && candidateScore.mojibakeSignals === bestScore.mojibakeSignals && candidateScore.replacements < bestScore.replacements)
    ) {
      best = candidate;
      bestScore = candidateScore;
    }
  });

  return best;
}

module.exports = {
  decodeUploadOriginalName
};
