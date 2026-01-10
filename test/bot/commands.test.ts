import { describe, it, expect, beforeEach, vi } from 'vitest';
import { CommandHandler } from '../../src/bot/commands.js';

// Mock ClaudeManager
const mockClaudeManager = {
  clearSession: vi.fn(),
};

describe('CommandHandler', () => {
  let commandHandler: CommandHandler;
  const allowedUserId = 'user-123';

  beforeEach(() => {
    commandHandler = new CommandHandler(mockClaudeManager as any, allowedUserId);
    vi.clearAllMocks();
  });

  describe('getCommands', () => {
    it('should return array of slash commands', () => {
      const commands = commandHandler.getCommands();
      expect(commands).toHaveLength(6);
      expect(commands.map(c => c.name)).toEqual(['clear', 'stop', 'mode', 'model', 'status', 'init']);
    });
  });

  describe('handleInteraction', () => {
    it('should ignore non-chat input commands', async () => {
      const mockInteraction = {
        isChatInputCommand: () => false,
      };

      await commandHandler.handleInteraction(mockInteraction);
      // Should not throw or call any methods
      expect(mockClaudeManager.clearSession).not.toHaveBeenCalled();
    });

    it('should deny unauthorized users', async () => {
      const mockInteraction = {
        isChatInputCommand: () => true,
        user: { id: 'unauthorized-user' },
        reply: vi.fn(),
      };

      await commandHandler.handleInteraction(mockInteraction);

      expect(mockInteraction.reply).toHaveBeenCalledWith({
        content: 'You are not authorized to use this bot.',
        ephemeral: true,
      });
      expect(mockClaudeManager.clearSession).not.toHaveBeenCalled();
    });

    it('should handle clear command for authorized user', async () => {
      const channelId = 'channel-123';
      const mockInteraction = {
        isChatInputCommand: () => true,
        user: { id: allowedUserId },
        channelId,
        commandName: 'clear',
        reply: vi.fn(),
      };

      await commandHandler.handleInteraction(mockInteraction);

      expect(mockClaudeManager.clearSession).toHaveBeenCalledWith(channelId);
      expect(mockInteraction.reply).toHaveBeenCalledWith(
        'Session cleared! Next message will start a new Claude Code session.'
      );
    });

    it('should ignore unknown commands', async () => {
      const mockInteraction = {
        isChatInputCommand: () => true,
        user: { id: allowedUserId },
        channelId: 'channel-123',
        commandName: 'unknown',
        reply: vi.fn(),
      };

      await commandHandler.handleInteraction(mockInteraction);

      expect(mockClaudeManager.clearSession).not.toHaveBeenCalled();
      expect(mockInteraction.reply).not.toHaveBeenCalled();
    });
  });
});