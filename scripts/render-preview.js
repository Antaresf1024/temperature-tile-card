// Régénère docs/apercu.svg à partir du moteur réel de la carte (aucune retouche à la main) :
// quatre tuiles en échelle absolue par défaut, posées sur un fond sombre façon thème HA.
// Usage : npm run preview
import { mkdir, writeFile } from 'node:fs/promises';
import { loadCard } from '../tests/fake-dom.js';

const { temperatureTile, temperatureFill } = await loadCard();

const W = 220;
const H = 74;
const GAP = 12;
const PAD = 16;
const TILES = [
  { label: 'TERRASSE', value: 3.5 },
  { label: 'BUREAU', value: 18.5 },
  { label: 'VÉRANDA', value: 27 },
  { label: 'CAVE', value: null }, // source indisponible
];

const width = PAD * 2 + W * 2 + GAP;
const height = PAD * 2 + H * 2 + GAP;
const tiles = TILES.map(({ label, value }, index) => {
  const x = PAD + (index % 2) * (W + GAP);
  const y = PAD + Math.floor(index / 2) * (H + GAP);
  const tile = temperatureTile(value, label, W, H, temperatureFill(value), `apercu-${index}`, 1);
  return `  <g transform="translate(${x} ${y})">${tile}\n  </g>`;
}).join('\n');

const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
  <style>
    svg { --primary-text-color: #e1e1e1; --secondary-text-color: #9b9b9b; }
    text { font-family: Inter, Roboto, Arial, sans-serif; }
  </style>
  <rect width="${width}" height="${height}" rx="14" fill="#1c1c1c"/>
${tiles}
</svg>
`;

await mkdir(new URL('../docs/', import.meta.url), { recursive: true });
await writeFile(new URL('../docs/apercu.svg', import.meta.url), svg);
