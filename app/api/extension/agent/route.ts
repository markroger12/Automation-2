import { handleAgentRequest } from '@/lib/agent/handler';
import { ensurePragmas } from '@/lib/db';

/** Chrome extension agent endpoint (bearer connection key; see src/lib/agent/handler.ts). */
export async function POST(req: Request) {
  await ensurePragmas();
  return handleAgentRequest(req);
}

export async function OPTIONS(req: Request) {
  return handleAgentRequest(req);
}
