import { handleGscProof } from '@/lib/gsc/proof';
import { handleAgentRequest } from '@/lib/agent/handler';

/** The Search Console page copy after “Request indexing” (proof screenshot), from the extension. */
export async function POST(req: Request) {
  return handleGscProof(req);
}

export async function OPTIONS(req: Request) {
  return handleAgentRequest(req);
}
