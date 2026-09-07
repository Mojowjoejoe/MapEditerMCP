import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

export function resolveEditorRoot() {
  let candidate = process.env.WULFRAM_FORGE_ROOT
    ? path.resolve(process.env.WULFRAM_FORGE_ROOT)
    : path.dirname(fileURLToPath(import.meta.url));
  while (true) {
    if (fs.existsSync(path.join(candidate, 'desktop/WulframForge/WulframForge.csproj'))) return candidate;
    const parent = path.dirname(candidate);
    if (process.env.WULFRAM_FORGE_ROOT || parent === candidate) break;
    candidate = parent;
  }
  throw new Error('Set WULFRAM_FORGE_ROOT to a compatible Wulfram Forge editor checkout.');
}
