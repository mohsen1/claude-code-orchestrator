# Claude Code Orchestrator - Issues Report
**Session Date**: January 12, 2026  
**Session Duration**: ~1.5 hours (17:41 - 19:10)  
**Purpose**: Babysitting and monitoring the orchestrator to identify issues for improvement

---

## Executive Summary

This babysitting session monitored a multi-worker Claude Code orchestrator system managing 10 workers. The session identified several critical issues causing worker stagnation, system bottlenecks, and intervention requirements.

**Key Findings:**
- Workers frequently getting stuck in "(no response)" or "(no content)" states
- Manager/Orchestrator not automatically detecting and restarting stuck workers
- Rate limit handling causing worker restarts but not proper resumption
- Workers dropping to shell prompts without automatic recovery
- Settings errors blocking worker startup

---

## Critical Issues Identified

### 1. Worker "No Response" Stuck States

**Severity**: HIGH  
**Frequency**: RECURRING (especially Worker 4)  
**Impact**: Workers stop making progress indefinitely

**Description:**
Multiple workers, particularly Worker 4, repeatedly entered a "(no response)" or "(no content)" state where:
- The Claude Code interface appeared loaded
- Prompt was visible but empty
- No activity despite waiting
- Workers remained stuck until manual intervention

**Affected Workers:**
- Worker 4: Stuck 3+ times in "(no response)" state
- Worker 5: Stuck with "Please resume this task" message
- Worker 10: Stuck with "Interrupted - What should Claude do instead?"

**Manual Intervention Required:**
```bash
# Intervention pattern that worked:
tmux send-keys -t "claude-worker-X" C-c  # Break out
sleep 2
tmux send-keys -t "claude-worker-X" Enter
# Sometimes required: Ctrl-L, Space, or "y" + Enter
```

**Root Cause Hypothesis:**
- Claude Code interface entering a hung state after certain operations
- Possibly related to API errors, rate limits, or internal state corruption
- No automatic timeout/retry mechanism

**Recommendation:**
Implement a heartbeat/health check system that:
1. Monitors worker activity (token usage, state changes)
2. Detects stuck states after N minutes of no progress
3. Automatically restarts stuck workers
4. Preserves worker context before restart

---

### 2. Manager/Orchestrator Bottleneck

**Severity**: CRITICAL  
**Frequency**: OCCURRENCE  
**Impact**: 5+ workers blocked waiting for merges

**Description:**
The Manager (Worker 1) became stuck, blocking the entire pipeline:
- Workers 2, 3, 4, 7, 8, 9 all waiting for Manager to merge their work
- Manager showed "Interrupted - What should Claude do instead?" state
- No automatic detection or recovery
- Required manual session investigation

**Timeline:**
- 17:41-18:14: Workers completing tasks and pushing to branches
- 18:14: Multiple workers waiting for merges
- 18:14-18:29: Manager unresponsive
- 18:29: Manual intervention discovered Manager stuck

**Resolution Attempted:**
- Killed worker-1 session expecting orchestrator to recreate it
- Orchestrator did NOT automatically recreate the worker
- Internal state became desynchronized

**Root Cause:**
The orchestrator's internal worker tracking was separate from actual tmux sessions. Killing a session didn't trigger recreation.

**Recommendation:**
1. Implement session health monitoring
2. Auto-recreate killed/crashed worker sessions
3. Merge queue priority system to prevent indefinite waits
4. Timeout mechanism for Manager merges (escalate if merge takes >10 minutes)

---

### 3. Workers Dropping to Shell After Rate Limits

**Severity**: MEDIUM  
**Frequency**: OCCASIONAL  
**Impact**: Workers inactive until manual restart

**Description:**
When workers hit rate limits and were rotated:
- Worker session restarted
- Claude Code process exited
- Worker dropped to shell prompt (fish/bash)
- No automatic restart of Claude Code

**Example (Worker 10):**
```
claude@MacBookPro /t/o/w/worker-10 (worker-10)>
claude@MacBookPro /t/o/w/worker-10 (worker-10)> [repeated]
```

**Current Recovery Process:**
```bash
tmux send-keys -t "claude-worker-10" "claude --dangerously-skip-permissions" C-m
```

**Recommendation:**
Implement a wrapper script that:
1. Detects when Claude Code process exits
2. Automatically restarts with appropriate flags
3. Restores previous context/session state
4. Logs restart events for monitoring

---

### 4. Settings Errors Blocking Workers

**Severity**: MEDIUM  
**Frequency:** OCCASIONAL  
**Impact:** Workers can't start until settings fixed

**Description:**
Workers encountered settings errors on startup:
```
Hooks use a new format with matchers
PostToolUse: Expected array, but received string
Stop: Expected array, but received string
```

**Error Menu:**
```
❯ 1. Exit and fix manually
   2. Continue without these settings
```

**Resolution:**
Manual selection of option 2 (Continue without settings)

**Recommendation:**
1. Automatically skip invalid settings files
2. Validate settings format before starting workers
3. Provide command-line flag to ignore errors: `--skip-settings-errors`
4. Better default behavior when settings are invalid

---

### 5. Worker Resumption After Rate Limit Restarts

**Severity**: MEDIUM  
**Frequency**: FREQUENT  
**Impact**: Workers idle after config rotation

**Description:**
When orchestrator rotated worker configs due to rate limits:
- Workers received message: "You were restarted due to rate limits. Your config was rotated to oauth/apikey"
- Workers showed workflow instructions but didn't resume work
- Required manual intervention (sending Enter key)

**Example Pattern:**
```
You were restarted due to rate limits. Your config was rotated to oauth.

Your previous task was:
You are **Worker X** in a Claude Code Orchestrator.

## Your Environment
[workflow instructions...]

Please resume this task. Check your recent file changes and git status.
```

**Manual Fix:**
```bash
tmux send-keys -t "claude-worker-X" Enter
sleep 3
# Sometimes need: Space, then Enter, or "y" then Enter
```

**Recommendation:**
1. Automatically resume worker task after config rotation
2. Don't show workflow instructions - just resume work
3. Send resume signal programmatically
4. Or better: Don't kill worker session, just rotate config in-place

---

## System Architecture Issues

### 6. Orchestrator Internal State Desynchronization

**Severity**: HIGH  
**Description:**
Orchestrator's internal worker state became disconnected from actual tmux sessions:
- Killed worker-1 session
- Orchestrator still trying to send rate limit rotations to non-existent session
- No automatic recreation or state cleanup

**Evidence:**
```
# After killing worker-1:
2026-01-12 18:28:11 [warn]: Rate limit detected for worker-1
2026-01-12 18:28:11 [info]: Instance worker-1 rotated to apikey (api-key-1)
# But worker-1 session didn't exist!
```

**Recommendation:**
1. Implement session existence checks
2. Heartbeat monitoring for all workers
3. Auto-recreation of dead workers
4. State reconciliation mechanism

---

### 7. Manager Confusion - Wrong Session Identified

**Severity**: LOW  
**Description:**
Initially thought session "12" was the orchestrator. Later discovered "claude-manager" was the actual Manager session. This caused confusion during troubleshooting.

**Recommendation:**
1. Use consistent, descriptive session names
2. Document session naming convention
3. Add session descriptions in tmux

---

## Worker-Specific Patterns

### Worker 4 - Recurring Stuck States

Worker 4 got stuck in "(no response)" state **3 times** during the session:
- 17:47: First occurrence
- 18:54: Second occurrence  
- 19:00: Third occurrence

**Pattern:**
- Worker 4 consistently vulnerable to stuck states
- May indicate task-specific issue or worker-specific problem
- Required Ctrl-C + Enter to fix each time

**Recommendation:**
- Investigate Worker 4's task type (BIND-1 task)
- Check if specific operations trigger stuck state
- Consider Worker 4 for targeted monitoring/testing

---

## Successful Intervention Patterns

### What Worked

1. **Ctrl-C + Enter**: Most effective for "(no response)" states
2. **Space + Enter**: Effective for "(no content)" states  
3. **"y" + Enter**: Effective for "Interrupted" states
4. **Ctrl-L + Enter**: Clear screen and resume
5. **Rate limit recovery**: Enter → wait 3s → Enter

### Important Timing Pattern
When sending keys to Claude Code screens:
1. Send keys (command/action)
2. **Wait 3 seconds**
3. Send Enter
4. Wait for response

**Example:**
```bash
tmux send-keys -t "claude-worker-X" Space
sleep 3
tmux send-keys -t "claude-worker-X" Enter
```

---

## Recommendations Summary

### Immediate (High Priority)

1. **Implement Worker Health Monitoring**
   - Heartbeat checks every 2 minutes
   - Auto-restart stuck workers
   - Preserve context before restart

2. **Fix Manager Bottleneck**
   - Merge queue with priority system
   - Timeout for pending merges (>10 min)
   - Auto-escalate or alert on stuck merges

3. **Session-Orchestrator Sync**
   - Detect dead sessions
   - Auto-recreate killed workers
   - State reconciliation mechanism

### Short-Term (Medium Priority)

4. **Auto-Resume After Rate Limit Rotation**
   - Don't show workflow instructions
   - Programmatically resume work
   - Consider in-place config rotation (no restart)

5. **Wrapper Script for Workers**
   - Auto-restart Claude Code if it exits
   - Restore previous context
   - Log all restarts

6. **Settings Error Handling**
   - Auto-skip invalid settings
   - `--skip-settings-errors` flag
   - Validate settings on startup

### Long-Term (Lower Priority)

7. **Improve Session Naming**
   - Consistent naming convention
   - Add session descriptions
   - Document architecture

8. **Investigate Worker 4 Pattern**
   - Why does it get stuck frequently?
   - Task-specific or worker-specific issue?
   - Targeted monitoring

9. **Better Logging/Diagnostics**
   - Worker state transitions
   - Stuck state detection
   - Intervention history

---

## Conclusion

The orchestrator system shows promise but requires significant improvements in:
1. **Self-healing capabilities** - Currently requires manual babysitting
2. **State management** - Internal state can desync from reality  
3. **Worker lifecycle** - Better handling of restarts and rate limits
4. **Bottleneck detection** - Manager merges need queue management

The 1.5-hour session required **15+ manual interventions** across 10 workers. With recommended improvements, this should be reduced to near-zero manual intervention.

---

**Report Generated**: January 12, 2026  
**Monitoring Session**: 17:41 - 19:10 CET  
**Total Interventions**: 15+  
**Critical Issues**: 7  
**Workers Managed**: 10  
