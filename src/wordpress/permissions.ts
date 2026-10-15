/**
 * What the signed-in WordPress account may do, from its own capabilities
 * (GET /wp/v2/users/me?context=edit). The app needs to create/edit posts;
 * image uploads and new tags are optional and degrade with a warning.
 */
export interface PermissionCheck {
  status: 'OK' | 'WARN' | 'FAIL';
  message: string;
  user: string;
  roles: string[];
  canCreatePosts: boolean;
  canUploadFiles: boolean;
  canManageTerms: boolean;
  canPublish: boolean;
}

export function evaluatePermissions(user: { name: string; roles: string[]; capabilities: Record<string, boolean> }, opts: { createMissingTags?: boolean } = {}): PermissionCheck {
  const cap = (k: string) => user.capabilities[k] === true;
  const canCreatePosts = cap('edit_posts');
  const canUploadFiles = cap('upload_files');
  const canManageTerms = cap('manage_categories');
  const canPublish = cap('publish_posts');
  const who = `${user.name || 'The account'}${user.roles.length ? ` (${user.roles.join(', ')})` : ''}`;
  const base = { user: user.name, roles: user.roles, canCreatePosts, canUploadFiles, canManageTerms, canPublish };
  if (!canCreatePosts) return { ...base, status: 'FAIL', message: `${who} may not create posts. Log in with an Author, Editor or Administrator account.` };
  const gaps: string[] = [];
  if (!canUploadFiles) gaps.push('may not upload images (drafts are saved without them)');
  if (opts.createMissingTags && !canManageTerms) gaps.push('may not create new tags (only existing tags are assigned)');
  if (gaps.length) return { ...base, status: 'WARN', message: `${who} ${gaps.join('; ')}.` };
  return { ...base, status: 'OK', message: `${who} may create drafts and upload images.` };
}
