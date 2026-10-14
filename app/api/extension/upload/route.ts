import { handleUpload } from '@/lib/agent/files';
import { handleAgentRequest } from '@/lib/agent/handler';

/** Image upload from the extension (generated images), max 12 MB, magic-byte validated. */
export async function POST(req: Request) {
  return handleUpload(req);
}

export async function OPTIONS(req: Request) {
  return handleAgentRequest(req);
}
