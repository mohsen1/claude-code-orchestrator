export interface ClaudeHooksConfig {
  hooks: {
    Stop?: HookDefinition[];
    ToolUse?: HookDefinition[];
    [key: string]: HookDefinition[] | undefined;
  };
}

interface HookDefinition {
  matcher: string;
  command: string[];
}

/**
 * Generate Claude Code hooks configuration that sends events to the orchestrator.
 */
export function generateHooksConfig(
  orchestratorUrl: string,
  instanceId: string,
  workerId: number,
  instanceType: 'manager' | 'worker'
): ClaudeHooksConfig {
  const basePayload = {
    instance_id: instanceId,
    worker_id: workerId,
    instance_type: instanceType,
  };

  const payloadJson = JSON.stringify(basePayload);

  return {
    hooks: {
      // Stop hook - instance finished its task
      Stop: [
        {
          matcher: '*',
          command: [
            'curl',
            '-s',
            '-X',
            'POST',
            '-H',
            'Content-Type: application/json',
            '-d',
            payloadJson,
            `${orchestratorUrl}/hooks/stop`,
          ],
        },
      ],
      // ToolUse hook - for heartbeat/activity tracking
      ToolUse: [
        {
          matcher: '*',
          command: [
            'curl',
            '-s',
            '-X',
            'POST',
            '-H',
            'Content-Type: application/json',
            '-d',
            payloadJson,
            `${orchestratorUrl}/hooks/tool_use`,
          ],
        },
      ],
    },
  };
}

/**
 * Generate the full Claude settings.json content with hooks.
 */
export function generateClaudeSettings(
  orchestratorUrl: string,
  instanceId: string,
  workerId: number,
  instanceType: 'manager' | 'worker',
  existingSettings: Record<string, unknown> = {}
): Record<string, unknown> {
  const hooksConfig = generateHooksConfig(orchestratorUrl, instanceId, workerId, instanceType);

  return {
    ...existingSettings,
    ...hooksConfig,
  };
}
