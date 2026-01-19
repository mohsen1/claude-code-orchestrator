#!/usr/bin/env npx ts-node
/**
 * Test script for TmuxClaudeRunner
 * 
 * Usage: npx ts-node src/test-tmux-runner.ts
 */

import { TmuxClaudeRunner } from './tmux-claude-runner.js';

async function main() {
  console.log('Testing TmuxClaudeRunner...\n');

  // Create runner with env vars
  const runner = new TmuxClaudeRunner({
    apiKey: process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN,
    baseUrl: process.env.ANTHROPIC_BASE_URL,
  });

  const testDir = process.cwd();
  const sessionName = 'test-claude-session';

  try {
    // Step 1: Create session
    console.log('1. Creating tmux session...');
    const session = await runner.createSession(sessionName, testDir);
    console.log(`   Session created: ${session.name}`);
    console.log(`   Working dir: ${session.workingDir}`);

    // Give Claude time to fully initialize
    console.log('   Waiting for Claude to initialize (10s)...');
    await sleep(10000);

    // Step 2: Test file creation prompt FIRST (this is the important one)
    console.log('\n2. Testing file creation...');
    const fileResult = await runner.runPrompt(
      sessionName, 
      'Create a file called test-output.txt with the content "Hello from Claude via tmux"'
    );

    console.log(`   Success: ${fileResult.success}`);
    console.log(`   Duration: ${fileResult.durationMs}ms`);
    console.log(`   Output preview: ${fileResult.output.substring(0, 300)}`);

    // Check if file was created
    const fs = await import('fs');
    if (fs.existsSync('test-output.txt')) {
      const content = fs.readFileSync('test-output.txt', 'utf-8');
      console.log(`   FILE CREATED! Content: "${content}"`);
      fs.unlinkSync('test-output.txt'); // cleanup
    } else {
      console.log('   File was NOT created');
    }

    // Step 3: Send a simple test prompt
    console.log('\n3. Sending simple test prompt...');
    const result = await runner.runPrompt(sessionName, 'What is 2 + 2? Reply with just the number.');

    console.log('\n4. Simple prompt result:');
    console.log(`   Success: ${result.success}`);
    console.log(`   Duration: ${result.durationMs}ms`);
    console.log(`   Output: ${result.output.substring(0, 500)}`);
    if (result.error) {
      console.log(`   Error: ${result.error}`);
    }

  } catch (error) {
    console.error('Test failed:', error);
  } finally {
    // Cleanup
    console.log('\n5. Cleaning up...');
    await runner.killSession(sessionName);
    console.log('   Session killed');
  }

  console.log('\nTest complete!');
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

main().catch(console.error);
