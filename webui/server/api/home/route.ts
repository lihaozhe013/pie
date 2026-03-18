import { json } from '@/server/http';
import { homedir } from 'os';

export async function GET() {
  return json({ home: homedir() });
}
