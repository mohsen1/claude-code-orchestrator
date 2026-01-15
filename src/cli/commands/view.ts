import chalk from 'chalk';
import { execa } from 'execa';

interface ViewOptions {
  config?: string;
}

/**
 * Get all tmux sessions matching orchestrator pattern
 */
async function getOrchestratorSessions(): Promise<string[]> {
  try {
    const result = await execa('tmux', ['list-sessions', '-F', '#{session_name}'], { reject: false });
    if (result.exitCode !== 0) {
      return [];
    }
    
    const sessions = result.stdout.split('\n').filter(Boolean);
    // Filter for orchestrator sessions (director, em-*, worker-*)
    return sessions.filter(s => 
      s.includes('-director') || 
      s.includes('-em-') || 
      s.includes('-worker-') ||
      s.includes('-manager')
    );
  } catch {
    return [];
  }
}

/**
 * Extract repo name from session name
 */
function extractRepoFromSession(sessionName: string): string {
  // Session names are like: reponame-director, reponame-worker-1
  const match = sessionName.match(/^(.+?)-(director|manager|em-|worker-)/);
  return match ? match[1] : sessionName;
}

/**
 * Group sessions by repo
 */
function groupSessionsByRepo(sessions: string[]): Map<string, string[]> {
  const groups = new Map<string, string[]>();
  
  for (const session of sessions) {
    const repo = extractRepoFromSession(session);
    if (!groups.has(repo)) {
      groups.set(repo, []);
    }
    groups.get(repo)!.push(session);
  }
  
  return groups;
}

/**
 * Create a tmux view window with all sessions tiled
 */
async function createTmuxView(sessions: string[], repoName: string): Promise<void> {
  const viewWindowName = `cco-view-${repoName}`;
  
  // Check if view window already exists
  const existing = await execa('tmux', ['list-windows', '-F', '#{window_name}'], { reject: false });
  const existingWindows = existing.stdout?.split('\n') || [];
  
  if (existingWindows.includes(viewWindowName)) {
    // Switch to existing window
    console.log(chalk.yellow(`View window already exists, switching to it...`));
    await execa('tmux', ['select-window', '-t', viewWindowName]);
    return;
  }
  
  // Sort sessions: director first, then managers/EMs, then workers
  const sortedSessions = [...sessions].sort((a, b) => {
    const order = (s: string) => {
      if (s.includes('-director')) return 0;
      if (s.includes('-manager')) return 1;
      if (s.includes('-em-')) return 2;
      return 3;
    };
    return order(a) - order(b);
  });
  
  if (sortedSessions.length === 0) {
    console.log(chalk.yellow('No orchestrator sessions found'));
    return;
  }
  
  // Create new window with first session
  const firstSession = sortedSessions[0];
  await execa('tmux', ['new-window', '-n', viewWindowName, `tmux attach-session -t ${firstSession}`]);
  
  // Add remaining sessions as split panes
  for (let i = 1; i < sortedSessions.length; i++) {
    const session = sortedSessions[i];
    // Alternate horizontal/vertical splits for nice tiling
    const splitArg = i % 2 === 1 ? '-h' : '-v';
    await execa('tmux', ['split-window', splitArg, '-t', viewWindowName, `tmux attach-session -t ${session}`]);
    
    // Rebalance panes after each split
    await execa('tmux', ['select-layout', '-t', viewWindowName, 'tiled']);
  }
  
  // Set pane titles
  for (let i = 0; i < sortedSessions.length; i++) {
    const session = sortedSessions[i];
    const paneTitle = session.replace(`${repoName}-`, '');
    await execa('tmux', ['select-pane', '-t', `${viewWindowName}.${i}`, '-T', paneTitle], { reject: false });
  }
  
  // Enable pane border status to show titles
  await execa('tmux', ['set-option', '-t', viewWindowName, 'pane-border-status', 'top'], { reject: false });
  
  console.log(chalk.green(`✓ Created view window: ${viewWindowName}`));
  console.log(chalk.gray(`  Showing ${sortedSessions.length} sessions`));
}

/**
 * View command handler
 */
export async function viewCommand(options: ViewOptions): Promise<void> {
  console.log(chalk.cyan('\n🔍 Claude Code Orchestrator - Session View\n'));
  
  const sessions = await getOrchestratorSessions();
  
  if (sessions.length === 0) {
    console.log(chalk.yellow('No active orchestrator sessions found.'));
    console.log(chalk.gray('Start an orchestrator first with: cco start'));
    return;
  }
  
  const groups = groupSessionsByRepo(sessions);
  
  console.log(chalk.white(`Found ${sessions.length} sessions across ${groups.size} orchestration(s):\n`));
  
  for (const [repo, repoSessions] of groups) {
    console.log(chalk.cyan(`  ${repo}:`));
    for (const session of repoSessions) {
      const type = session.replace(`${repo}-`, '');
      console.log(chalk.gray(`    - ${type}`));
    }
    console.log();
  }
  
  // If specific config provided, show only that repo
  if (options.config) {
    // TODO: Read config to get repo name and filter
    console.log(chalk.yellow('Config-based filtering not yet implemented'));
  }
  
  // Create view for first (or only) repo
  if (groups.size === 1) {
    const [repoName, repoSessions] = [...groups.entries()][0];
    await createTmuxView(repoSessions, repoName);
  } else {
    console.log(chalk.yellow('Multiple orchestrations found. Please specify which one to view.'));
    // TODO: Add interactive selection
  }
}
