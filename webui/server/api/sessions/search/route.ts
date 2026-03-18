import { json } from '@/server/http';
import { listAllSessions } from '@/lib/session-reader';
import { searchSessionContents } from '@/lib/session-search';

export async function GET(request: Request) {
  const query = (new URL(request.url).searchParams.get('q') ?? '').trim();
  const headers = { 'Cache-Control': 'no-store' };
  if (query.length > 200) {
    return json(
      { error: 'Search query exceeds 200 characters' },
      { status: 400, headers }
    );
  }
  try {
    const sessions =
      query && !request.signal.aborted ? await listAllSessions({ allowStale: true }) : [];
    return json(await searchSessionContents(sessions, query, request.signal), {
      headers
    });
  } catch (error) {
    return json({ error: String(error) }, { status: 500, headers });
  }
}
