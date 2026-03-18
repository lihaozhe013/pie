import { json } from '@/server/http';
import { mkdirSync } from 'fs';
import { defaultCwdPath } from '@/lib/default-cwd';

// POST /api/default-cwd
// Creates ~/pi-cwd/<YYYYMMDD> (local date) if it doesn't exist and returns the path.
// The client then selects it through /api/cwd/validate like any other directory.
export async function POST() {
  try {
    const dir = defaultCwdPath();
    mkdirSync(dir, { recursive: true });
    return json({ cwd: dir });
  } catch (error) {
    return json({ error: String(error) }, { status: 500 });
  }
}
