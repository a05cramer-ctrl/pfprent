// The coin frame as SVG (the site draws the same thing on a canvas).
import { FRAME as F } from './pfp.js';

const rings = (S) => {
  const R = S / 2;
  const rim = ((F.rimOut + F.rimIn) / 2) * R, rimW = (F.rimOut - F.rimIn) * R;
  const thin = ((F.gapIn + F.thinIn) / 2) * R, thinW = (F.gapIn - F.thinIn) * R;
  return `<circle cx="${R}" cy="${R}" r="${rim}" fill="none" stroke="#fff" stroke-width="${rimW}"/><circle cx="${R}" cy="${R}" r="${thin}" fill="none" stroke="#fff" stroke-width="${thinW}"/>`;
};
// official $PFP logo: a coin with a profile bust
export function officialSvg(S = 1000) {
  const R = S / 2;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${S}" height="${S}" viewBox="0 0 ${S} ${S}"><rect width="${S}" height="${S}" fill="#000"/>` +
    `<defs><clipPath id="b"><circle cx="${R}" cy="${R}" r="${F.bust * R}"/></clipPath></defs>` +
    `<g clip-path="url(#b)" fill="#fff"><circle cx="${R}" cy="${R - 0.192 * R}" r="${0.232 * R}"/><ellipse cx="${R}" cy="${R + 0.6 * R}" rx="${0.512 * R}" ry="${0.448 * R}"/></g>` +
    rings(S) + `</svg>`;
}
// anybody's photo on the coin
export function framedSvg(S, photoHref) {
  const R = S / 2, P = F.photo * R;
  return `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="${S}" height="${S}" viewBox="0 0 ${S} ${S}"><rect width="${S}" height="${S}" fill="#000"/>` +
    `<defs><clipPath id="p"><circle cx="${R}" cy="${R}" r="${P}"/></clipPath></defs>` +
    `<image href="${photoHref}" x="${R - P}" y="${R - P}" width="${2 * P}" height="${2 * P}" preserveAspectRatio="xMidYMid slice" clip-path="url(#p)"/>` +
    rings(S) + `</svg>`;
}
