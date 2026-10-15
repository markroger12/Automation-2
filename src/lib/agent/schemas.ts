import { z } from 'zod';
import { EXTENSION_FAIL_CODES } from '../domain';

const id = z.string().min(1).max(64).regex(/^[A-Za-z0-9_:.-]+$/);
const url = z.string().max(2000).optional().nullable();
const diagnostics = z.record(z.string(), z.unknown()).optional();

export const tabInfoSchema = z.object({
  tabId: id,
  url: url,
  state: z.string().max(40).optional(),
  jobId: id.optional().nullable(),
});

export const agentRequestSchema = z.discriminatedUnion('action', [
  z.object({
    action: z.literal('hello'),
    installId: id,
    version: z.string().max(20),
    protocol: z.number().int().optional(),
    capabilities: z.array(z.string().max(40)).max(40).default([]),
    tabs: z.array(tabInfoSchema).max(10).default([]),
    loggedIn: z.boolean().optional().nullable(),
    humanCheck: z.boolean().optional().nullable(),
    claimsPaused: z.boolean().optional(),
    backoffUntil: z.string().max(40).optional().nullable(),
    lastError: z.string().max(500).optional().nullable(),
    diagnostics,
  }),
  z.object({
    action: z.literal('claim'),
    installId: id,
    tabId: id,
    openConversationUrls: z.array(z.string().max(500)).max(10).default([]),
  }),
  z.object({
    action: z.literal('progress'),
    installId: id,
    tabId: id,
    jobId: id,
    step: z.string().max(200),
    sent: z.boolean().optional(),
    sentAt: z.string().max(40).optional(),
    conversationUrl: url,
    diagnostics,
  }),
  z.object({
    action: z.literal('complete'),
    installId: id,
    tabId: id,
    jobId: id,
    text: z.string().max(1_500_000),
    html: z.string().max(3_000_000).optional().nullable(),
    conversationUrl: url,
    recovered: z.boolean().optional(),
    reused: z.boolean().optional(),
    elapsedMs: z.number().int().min(0).max(24 * 3600 * 1000).optional(),
    images: z.array(z.object({ mediaAssetId: id })).max(12).optional(),
    /** Image-search gallery pictures the extension could not download itself (fetched later by the app). */
    imageLinks: z
      .array(z.object({ url: z.string().max(2000).regex(/^https?:\/\//), width: z.number().int().min(0).max(50_000).optional(), height: z.number().int().min(0).max(50_000).optional() }))
      .max(20)
      .optional(),
  }),
  z.object({
    action: z.literal('fail'),
    installId: id,
    tabId: id,
    jobId: id,
    code: z.enum(EXTENSION_FAIL_CODES),
    message: z.string().max(2000),
    retryAfterSec: z.number().int().min(0).max(24 * 3600).optional().nullable(),
    uncertain: z.boolean().optional(),
    diagnostics,
  }),
  z.object({
    action: z.literal('release'),
    installId: id,
    tabId: id,
    jobId: id,
    reason: z.string().max(300),
  }),
  z.object({
    action: z.literal('report429'),
    installId: id,
    retryAfterSec: z.number().int().min(0).max(24 * 3600).optional().nullable(),
    reason: z.string().max(300),
  }),
]);

export type AgentRequest = z.output<typeof agentRequestSchema>;

export const uploadRequestSchema = z.object({
  installId: id,
  tabId: id,
  jobId: id,
  name: z.string().max(200),
  mime: z.enum(['image/png', 'image/jpeg', 'image/webp', 'image/gif']),
  dataBase64: z.string().max(17_000_000),
  sourceUrl: z.string().max(2000).optional().nullable(),
});
