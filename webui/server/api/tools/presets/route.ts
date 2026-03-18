import { json } from '@/server/http';
import {
  CustomToolPresetsLockedError,
  readCustomToolPresets,
  writeCustomToolPresets
} from '@/lib/custom-tool-presets';
import { hasJsonContentType, isApiRequestAllowed } from '@/lib/request-security';

// The custom tool presets (`lib/custom-tool-presets.ts`): the whole list is
// replaced on each save, as the editor sends it. Reads are open like the other
// settings GETs; writes require a trusted same-origin request.

export async function GET() {
  try {
    return json({ presets: readCustomToolPresets() });
  } catch (error) {
    return json(
      { error: error instanceof Error ? error.message : String(error) },
      { status: 500 }
    );
  }
}

export async function PUT(req: Request) {
  if (!isApiRequestAllowed(req)) {
    return json({ error: 'Untrusted API request' }, { status: 403 });
  }
  if (!hasJsonContentType(req)) {
    return json({ error: 'Content-Type must be application/json' }, { status: 415 });
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  try {
    const presets = await writeCustomToolPresets(body);
    return json({ presets });
  } catch (error) {
    if (error instanceof CustomToolPresetsLockedError) {
      return json({ error: error.message }, { status: 409 });
    }
    // An invalid document is the client's mistake; anything else is ours.
    const message = error instanceof Error ? error.message : String(error);
    const invalid = message.startsWith('Expected a tool preset document');
    return json({ error: message }, { status: invalid ? 400 : 500 });
  }
}
