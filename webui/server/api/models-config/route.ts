import { json } from '@/server/http';
import {
  ModelsConfigReadError,
  readModelsConfig,
  writeModelsConfig
} from '@/lib/models-config-store';
import { ContextWindowError, normalizeContextWindowOverrides } from '@/lib/model-context';

export async function GET() {
  try {
    return json(readModelsConfig());
  } catch (error) {
    if (error instanceof ModelsConfigReadError) {
      return json({ error: error.message }, { status: 422 });
    }
    return json({ error: String(error) }, { status: 500 });
  }
}

export async function PUT(req: Request) {
  try {
    const body = (await req.json()) as Record<string, unknown>;
    writeModelsConfig(normalizeContextWindowOverrides(body));
    return json({ success: true });
  } catch (error) {
    if (error instanceof ContextWindowError) {
      return json({ error: error.message }, { status: 400 });
    }
    if (error instanceof ModelsConfigReadError) {
      return json({ error: error.message }, { status: 409 });
    }
    return json({ error: String(error) }, { status: 500 });
  }
}
