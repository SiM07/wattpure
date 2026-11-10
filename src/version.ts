import { readFileSync } from 'node:fs';

/** Version from package.json, found from both src/ (development) and dist/src/ (build). */
function readVersion(): string {
  for (const candidate of ['../package.json', '../../package.json']) {
    try {
      const pkg = JSON.parse(readFileSync(new URL(candidate, import.meta.url), 'utf8'));
      if (pkg.name === 'wattpure') return pkg.version;
    } catch {
      // try the next location
    }
  }
  return '0.0.0';
}

export const VERSION = readVersion();
