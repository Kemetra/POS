#!/usr/bin/env node
/**
 * Counts project-owned source/text LOC and writes docs/assets/badges/loc.svg.
 * Uses Node built-ins only. No external dependencies.
 *
 * Excluded: node_modules, dist, build, coverage, .git, .turbo, .cache,
 *           docs/assets, lockfiles, images, SVGs, binaries, generated outputs.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const ROOT = path.resolve(path.dirname(__filename), '..');

const EXCLUDED_DIRS = new Set([
  'node_modules',
  '.git',
  'dist',
  'build',
  'coverage',
  '.turbo',
  '.cache',
  '.next',
  'out',
  '.understand-anything',
  '.claude',
  'bin',
  'externals',
  'release',
]);

const EXCLUDED_PATH_PREFIXES = [path.join(ROOT, 'docs', 'assets')];

const EXCLUDED_FILENAMES = new Set(['package-lock.json', 'pnpm-lock.yaml', 'yarn.lock']);

const BINARY_EXTENSIONS = new Set([
  '.png',
  '.jpg',
  '.jpeg',
  '.gif',
  '.ico',
  '.webp',
  '.woff',
  '.woff2',
  '.ttf',
  '.eot',
  '.otf',
  '.mp4',
  '.mov',
  '.avi',
  '.zip',
  '.tar',
  '.gz',
  '.pdf',
  '.exe',
  '.bin',
  '.so',
  '.dylib',
  '.dll',
  '.svg',
]);

const SOURCE_EXTENSIONS = new Set([
  '.ts',
  '.tsx',
  '.js',
  '.jsx',
  '.mjs',
  '.cjs',
  '.json',
  '.yml',
  '.yaml',
  '.md',
  '.mdx',
  '.sql',
  '.sh',
  '.bash',
  '.css',
  '.scss',
  '.less',
  '.html',
  '.hbs',
  '.ejs',
  '.toml',
  '.env',
  '.graphql',
  '.gql',
  '.prisma',
]);

function isExcludedPath(absPath) {
  return EXCLUDED_PATH_PREFIXES.some((prefix) => absPath.startsWith(prefix));
}

function countLinesInFile(filePath) {
  try {
    const content = fs.readFileSync(filePath, 'utf8');
    return content.split('\n').length;
  } catch {
    return 0;
  }
}

function isCountedFile(entry, fullPath) {
  if (EXCLUDED_FILENAMES.has(entry.name)) return false;
  if (isExcludedPath(fullPath)) return false;
  const ext = path.extname(entry.name).toLowerCase();
  if (BINARY_EXTENSIONS.has(ext)) return false;
  return SOURCE_EXTENSIONS.has(ext);
}

function isWalkedDirectory(entry, fullPath) {
  return !EXCLUDED_DIRS.has(entry.name) && !isExcludedPath(fullPath);
}

function walkAndCount(dir) {
  let total = 0;

  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return 0;
  }

  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);

    if (entry.isDirectory()) {
      if (isWalkedDirectory(entry, fullPath)) total += walkAndCount(fullPath);
    } else if (entry.isFile() && isCountedFile(entry, fullPath)) {
      total += countLinesInFile(fullPath);
    }
  }

  return total;
}

function formatLoc(n) {
  if (n >= 1000) {
    const k = (n / 1000).toFixed(1);
    return k + 'k';
  }
  return String(n);
}

function buildSvg(locLabel) {
  const labelText = 'lines of code';
  const valueText = locLabel;

  const labelWidth = 96;
  const valueWidth = Math.max(valueText.length * 7 + 16, 48);
  const totalWidth = labelWidth + valueWidth;
  const labelX = Math.round(labelWidth / 2);
  const valueX = labelWidth + Math.round(valueWidth / 2);

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${totalWidth}" height="20" role="img" aria-label="${labelText}: ${valueText}">
  <title>${labelText}: ${valueText}</title>
  <linearGradient id="s" x2="0" y2="100%">
    <stop offset="0" stop-color="#bbb" stop-opacity=".1"/>
    <stop offset="1" stop-opacity=".1"/>
  </linearGradient>
  <clipPath id="r">
    <rect width="${totalWidth}" height="20" rx="3" fill="#fff"/>
  </clipPath>
  <g clip-path="url(#r)">
    <rect width="${labelWidth}" height="20" fill="#555"/>
    <rect x="${labelWidth}" width="${valueWidth}" height="20" fill="#0f766e"/>
    <rect width="${totalWidth}" height="20" fill="url(#s)"/>
  </g>
  <g fill="#fff" text-anchor="middle" font-family="DejaVu Sans,Verdana,Geneva,sans-serif" font-size="110">
    <text x="${labelX}0" y="150" fill="#010101" fill-opacity=".3" transform="scale(.1)" textLength="${(labelWidth - 10) * 10}" lengthAdjust="spacing">${labelText}</text>
    <text x="${labelX}0" y="140" transform="scale(.1)" textLength="${(labelWidth - 10) * 10}" lengthAdjust="spacing">${labelText}</text>
    <text x="${valueX}0" y="150" fill="#010101" fill-opacity=".3" transform="scale(.1)" textLength="${(valueWidth - 10) * 10}" lengthAdjust="spacing">${valueText}</text>
    <text x="${valueX}0" y="140" transform="scale(.1)" textLength="${(valueWidth - 10) * 10}" lengthAdjust="spacing">${valueText}</text>
  </g>
</svg>`;
}

const loc = walkAndCount(ROOT);
const label = formatLoc(loc);
const svg = buildSvg(label);

const outDir = path.join(ROOT, 'docs', 'assets', 'badges');
fs.mkdirSync(outDir, { recursive: true });
const outPath = path.join(outDir, 'loc.svg');
fs.writeFileSync(outPath, svg, 'utf8');

console.log(`LOC: ${loc.toLocaleString('en-US')} (${label}) -> ${outPath}`);
