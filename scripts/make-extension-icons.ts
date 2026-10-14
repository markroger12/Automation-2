/** Generates extension/icons/*.png from an inline SVG (run once; output is committed). */
import path from 'node:path';
import sharp from 'sharp';

const svg = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="128" height="128" viewBox="0 0 128 128">
<rect width="128" height="128" rx="26" fill="#4f46e5"/>
<text x="64" y="82" font-family="Segoe UI, Arial, sans-serif" font-size="54" font-weight="700" fill="#ffffff" text-anchor="middle">BA</text>
</svg>`);

for (const size of [16, 48, 128]) {
  await sharp(svg).resize(size, size).png().toFile(path.join('extension', 'icons', `icon-${size}.png`));
}
console.log('icons written');
