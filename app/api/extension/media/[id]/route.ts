import { handleMediaDownload } from '@/lib/agent/files';
import { handleAgentRequest } from '@/lib/agent/handler';

/** Attachment bytes for a job the requesting tab owns (e.g. photo checks). */
export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  return handleMediaDownload(req, (await params).id);
}

export async function OPTIONS(req: Request) {
  return handleAgentRequest(req);
}
