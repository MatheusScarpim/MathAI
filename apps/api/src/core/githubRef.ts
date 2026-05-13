/**
 * Extrai owner/repo de uma URL GitHub ou shorthand "owner/repo".
 * Aceita variantes:
 *   - https://github.com/owner/repo
 *   - https://github.com/owner/repo.git
 *   - git@github.com:owner/repo.git
 *   - owner/repo
 * Retorna null se nao reconhecer.
 */
export const parseGithubRef = (input: string): { owner: string; repo: string } | null => {
  if (!input) return null;
  const trimmed = input.trim();
  // URL completa: github.com/<owner>/<repo>(.git)?
  const urlMatch = trimmed.match(/github\.com[/:]([^/\s]+)\/([^/\s.]+?)(?:\.git)?\/?$/i);
  if (urlMatch) return { owner: urlMatch[1]!, repo: urlMatch[2]! };
  // Shorthand: owner/repo
  const slashMatch = trimmed.match(/^([^/\s]+)\/([^/\s.]+?)(?:\.git)?\/?$/);
  if (slashMatch) return { owner: slashMatch[1]!, repo: slashMatch[2]! };
  return null;
};
