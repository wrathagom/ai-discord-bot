import { describe, it, expect } from 'vitest';
import { escapeShellString, buildClaudeCommand } from '../../src/utils/shell.js';

describe('escapeShellString', () => {
  it('should wrap simple strings in single quotes', () => {
    expect(escapeShellString('hello world')).toBe("'hello world'");
  });

  it('should escape single quotes properly', () => {
    expect(escapeShellString("don't")).toBe("'don'\\''t'");
  });

  it('should handle multiple single quotes', () => {
    expect(escapeShellString("can't won't")).toBe("'can'\\''t won'\\''t'");
  });

  it('should handle empty string', () => {
    expect(escapeShellString('')).toBe("''");
  });

  it('should handle string with only single quotes', () => {
    expect(escapeShellString("'''")).toBe("''\\'''\\'''\\'''");
  });
});

describe('buildClaudeCommand', () => {
  it('should build basic command without session ID (auto mode)', () => {
    const command = buildClaudeCommand('/test/dir', 'hello world');
    expect(command).toBe("cd /test/dir && claude --output-format stream-json --model sonnet -p 'hello world' --verbose --dangerously-skip-permissions");
  });

  it('should build command with session ID (auto mode)', () => {
    const command = buildClaudeCommand('/test/dir', 'hello world', 'session-123');
    expect(command).toBe("cd /test/dir && claude --resume session-123 --output-format stream-json --model sonnet -p 'hello world' --verbose --dangerously-skip-permissions");
  });

  it('should properly escape prompt with special characters', () => {
    const command = buildClaudeCommand('/test/dir', "don't use this");
    expect(command).toBe("cd /test/dir && claude --output-format stream-json --model sonnet -p 'don'\\''t use this' --verbose --dangerously-skip-permissions");
  });

  it('should handle complex prompts', () => {
    const prompt = "Fix the bug in 'config.js' and don't break anything";
    const command = buildClaudeCommand('/project/path', prompt, 'abc-123');
    expect(command).toBe("cd /project/path && claude --resume abc-123 --output-format stream-json --model sonnet -p 'Fix the bug in '\\''config.js'\\'' and don'\\''t break anything' --verbose --dangerously-skip-permissions");
  });

  it('should use --permission-mode plan in plan mode', () => {
    const command = buildClaudeCommand('/test/dir', 'hello world', undefined, undefined, 'plan');
    expect(command).toBe("cd /test/dir && claude --output-format stream-json --model sonnet -p 'hello world' --verbose --permission-mode plan");
  });

  it('should use --dangerously-skip-permissions in auto mode explicitly', () => {
    const command = buildClaudeCommand('/test/dir', 'hello world', undefined, undefined, 'auto');
    expect(command).toBe("cd /test/dir && claude --output-format stream-json --model sonnet -p 'hello world' --verbose --dangerously-skip-permissions");
  });

  it('should use MCP permission-prompt-tool in approve mode', () => {
    const discordContext = {
      channelId: 'channel-123',
      channelName: 'test-channel',
      userId: 'user-456',
    };
    const command = buildClaudeCommand('/test/dir', 'hello world', undefined, discordContext, 'approve');
    expect(command).toContain('--mcp-config');
    expect(command).toContain('/tmp/mcp-config-claude-discord-');
    expect(command).toContain('--permission-prompt-tool mcp__discord-permissions__approve_tool');
    expect(command).toContain('--allowedTools mcp__discord-permissions');
    expect(command).not.toContain('--dangerously-skip-permissions');
  });

  it('should use opus model when specified', () => {
    const command = buildClaudeCommand('/test/dir', 'hello world', undefined, undefined, 'auto', 'opus');
    expect(command).toBe("cd /test/dir && claude --output-format stream-json --model opus -p 'hello world' --verbose --dangerously-skip-permissions");
  });

  it('should use haiku model when specified', () => {
    const command = buildClaudeCommand('/test/dir', 'hello world', undefined, undefined, 'auto', 'haiku');
    expect(command).toBe("cd /test/dir && claude --output-format stream-json --model haiku -p 'hello world' --verbose --dangerously-skip-permissions");
  });

  it('should combine model and plan mode', () => {
    const command = buildClaudeCommand('/test/dir', 'hello world', undefined, undefined, 'plan', 'opus');
    expect(command).toBe("cd /test/dir && claude --output-format stream-json --model opus -p 'hello world' --verbose --permission-mode plan");
  });
});