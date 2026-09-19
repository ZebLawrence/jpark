/** Parse JSON with comments and trailing commas (tsconfig, .babelrc, ...). */
export function parseJsonc(text: string): any {
  let out = '';
  let i = 0;
  const n = text.length;
  while (i < n) {
    const c = text[i];
    if (c === '"') {
      let j = i + 1;
      while (j < n && text[j] !== '"') j += text[j] === '\\' ? 2 : 1;
      out += text.slice(i, j + 1);
      i = j + 1;
    } else if (c === '/' && text[i + 1] === '/') {
      while (i < n && text[i] !== '\n') i++;
    } else if (c === '/' && text[i + 1] === '*') {
      const end = text.indexOf('*/', i + 2);
      i = end === -1 ? n : end + 2;
    } else {
      out += c;
      i++;
    }
  }
  out = out.replace(/,(\s*[}\]])/g, '$1');
  try {
    return JSON.parse(out.replace(/^﻿/, ''));
  } catch {
    return null;
  }
}
