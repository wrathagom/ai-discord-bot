import { DiscordBot } from './bot/client.js';
import { ClaudeManager } from './claude/manager.js';
import { validateConfig } from './utils/config.js';
import { MCPPermissionServer } from './mcp/server.js';

async function main() {
  const config = validateConfig();
  
  // Start MCP Permission Server
  const mcpPort = parseInt(process.env.MCP_SERVER_PORT || '3001');
  const mcpServer = new MCPPermissionServer(mcpPort);
  
  console.log('Starting MCP Permission Server...');
  await mcpServer.start();
  
  // Start Discord Bot and Claude Manager
  const claudeManager = new ClaudeManager(config.baseFolder);
  const bot = new DiscordBot(claudeManager, config.allowedUserId, config.baseFolder);
  
  // Connect MCP server to Discord bot for interactive approvals
  mcpServer.setDiscordBot(bot);
  
  // Handle graceful shutdown
  const shutdown = async () => {
    console.log('Shutting down gracefully...');
    
    // Stop MCP server first
    try {
      await mcpServer.stop();
    } catch (error) {
      console.error('Error stopping MCP server:', error);
    }
    
    // Stop Claude manager
    try {
      claudeManager.destroy();
    } catch (error) {
      console.error('Error stopping Claude manager:', error);
    }
    
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
  
  console.log('Starting Discord Bot...');
  await bot.login(config.discordToken);
  
  // Expose MCP server to Discord bot for reaction handling
  bot.setMCPServer(mcpServer);
  
  console.log('All services started successfully!');
  console.log('MCP Server and Discord Bot are now connected for interactive approvals!');
}

main().catch(console.error);