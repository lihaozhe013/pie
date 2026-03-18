import { json } from '@/server/http';
import { statSync, type Stats } from 'fs';
import { normalizeCwd } from '@/lib/cwd-path';
import { allowFileRoot } from '@/lib/file-access';
import { projectIdentityKey } from '@/lib/project-identity';

// POST /api/cwd/validate  body: { cwd: string }
// Validates a candidate workspace before the UI selects it.
export async function POST(req: Request) {
  try {
    const body = (await req.json()) as { cwd?: unknown };
    const cwd = typeof body.cwd === 'string' ? body.cwd.trim() : '';

    if (!cwd) {
      return json({ error: 'Path is required' }, { status: 400 });
    }

    const normalizedCwd = normalizeCwd(cwd);
    let stat: Stats;
    try {
      stat = statSync(normalizedCwd);
    } catch {
      return json({ error: `Directory does not exist: ${cwd}` }, { status: 400 });
    }

    if (!stat.isDirectory()) {
      return json({ error: `Path is not a directory: ${cwd}` }, { status: 400 });
    }

    allowFileRoot(normalizedCwd);
    return json({
      success: true,
      cwd: normalizedCwd,
      projectRoot: normalizedCwd,
      projectKey: projectIdentityKey(normalizedCwd)
    });
  } catch (error) {
    return json({ error: String(error) }, { status: 500 });
  }
}
