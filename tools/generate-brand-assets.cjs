#!/usr/bin/env node
// Rasterize our own vector source, not the photographed sign. No runtime dependency.
const fs = require('node:fs');
const path = require('node:path');
const { Resvg } = require('@resvg/resvg-js');

const root = path.resolve(__dirname, '..');
const svg = fs.readFileSync(path.join(root, 'assets/brand/visionary-mark.svg'), 'utf8');
const paths = [...svg.matchAll(/<path fill="(#[0-9A-F]{6})" d="([^"]+)"\s*\/>/g)]
  .map(([, fill, d]) => ({ fill, d }));
if (paths.length !== 2 || !svg.includes('viewBox="0 0 240 240"')) {
  throw new Error('Unexpected brand source: review geometry before regenerating assets.');
}
const font = path.join(root, 'assets/fonts/theme/laoji_theme_neutral.ttf');

function render(relative, width, height, body) {
  const destination = path.join(root, relative);
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  const document = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">${body}</svg>`;
  const png = new Resvg(document, {
    font: { loadSystemFonts: false, fontFiles: [font], defaultFontFamily: 'LaojiThemeNeutral' },
  }).render().asPng();
  fs.writeFileSync(destination, png);
}

function mark(size, side, { background = '', mono = false } = {}) {
  const offset = (size - side) / 2;
  return `${background ? `<rect width="${size}" height="${size}" fill="${background}"/>` : ''}`
    + `<g transform="translate(${offset} ${offset}) scale(${side / 240})">`
    + paths.map(p => `<path fill="${mono ? '#000000' : p.fill}" d="${p.d}"/>`).join('') + '</g>';
}

function generate() {
  render('assets/icon.png', 1024, 1024, mark(1024, 620, { background: '#FFFFFF' }));
  render('assets/android-icon-foreground.png', 1024, 1024, mark(1024, 440));
  render('assets/android-icon-background.png', 1024, 1024, '<rect width="1024" height="1024" fill="#FFFFFF"/>');
  render('assets/android-icon-monochrome.png', 1024, 1024, mark(1024, 440, { mono: true }));
  render('assets/splash-icon.png', 1024, 1024, mark(1024, 440));
  render('assets/brand/mark.png', 512, 512, mark(512, 512));
  render('assets/favicon.png', 64, 64, mark(64, 44, { background: '#FFFFFF' }));
  // Android's fixed 200x80dp branding slot, at xxxhdpi. React uses the same image.
  render('assets/brand/splash-credit.png', 800, 320,
    '<text x="400" y="172" text-anchor="middle" font-family="LaojiThemeNeutral" font-size="44" fill="#647080">created by visionary tech</text>');
  process.stdout.write('Generated Visionary Tech launcher and splash assets\n');
}

if (require.main === module) generate();
module.exports = { generate, paths };
