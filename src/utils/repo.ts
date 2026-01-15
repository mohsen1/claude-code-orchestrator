/**
 * Repository URL utilities
 */

/**
 * Extract repository name from a git URL
 * 
 * @example
 * extractRepoName('git@github.com:microsoft/TypeScript.git') // 'TypeScript'
 * extractRepoName('https://github.com/facebook/react.git') // 'react'
 * extractRepoName('https://github.com/org/repo') // 'repo'
 */
export function extractRepoName(url: string | undefined): string {
  if (!url) return 'orchestrator';
  // Handle SSH: git@github.com:org/repo.git
  // Handle HTTPS: https://github.com/org/repo.git
  const match = url.match(/[\/:]([^\/]+?)(?:\.git)?$/);
  return match ? match[1] : 'orchestrator';
}
