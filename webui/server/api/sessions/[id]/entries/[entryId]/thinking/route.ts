import { json } from '@/server/http';
import { getSessionEntries, resolveSessionPath } from '@/lib/session-reader';

export async function GET(
  req: Request,
  { params }: { params: Promise<{ id: string; entryId: string }> }
) {
  const { id, entryId } = await params;
  const blockIndexParam = new URL(req.url).searchParams.get('blockIndex');
  const blockIndex = blockIndexParam === null ? Number.NaN : Number(blockIndexParam);
  if (!Number.isSafeInteger(blockIndex) || blockIndex < 0) {
    return json({ error: 'Valid blockIndex is required' }, { status: 400 });
  }

  try {
    const filePath = await resolveSessionPath(id);
    if (!filePath) return json({ error: 'Session not found' }, { status: 404 });

    // SessionManager-backed parsing preserves the SDK's malformed-line tolerance.
    const entry = getSessionEntries(filePath).find((candidate) => candidate.id === entryId);
    if (!entry || entry.type !== 'message' || entry.message.role !== 'assistant') {
      return json({ error: 'Assistant message not found' }, { status: 404 });
    }

    const block = entry.message.content[blockIndex];
    if (!block || block.type !== 'thinking') {
      return json({ error: 'Thinking block not found' }, { status: 404 });
    }

    return json({ thinking: block.thinking });
  } catch (error) {
    return json({ error: String(error) }, { status: 500 });
  }
}
