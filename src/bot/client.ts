import {
  Client,
  GatewayIntentBits,
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ComponentType,
} from "discord.js";
import * as fs from "fs";
import * as path from "path";
import type { ClaudeManager } from '../claude/manager.js';
import { CommandHandler } from './commands.js';
import type { MCPPermissionServer } from '../mcp/server.js';
import {
  ensureAttachmentDir,
  getTempPath,
  downloadAttachment,
  isImageType,
  buildPromptWithAttachments,
  cleanupOldAttachments,
  type DownloadedAttachment
} from '../utils/attachments.js';

export class DiscordBot {
  public client: Client; // Make public so MCP server can access it
  private commandHandler: CommandHandler;
  private mcpServer?: MCPPermissionServer;

  constructor(
    private claudeManager: ClaudeManager,
    private allowedUserId: string,
    private baseFolder: string
  ) {
    this.client = new Client({
      intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.GuildMessageReactions, // Add reactions for approval
      ],
    });

    this.commandHandler = new CommandHandler(claudeManager, allowedUserId, baseFolder);
    this.setupEventHandlers();
  }

  /**
   * Set the MCP server for handling approval reactions
   */
  setMCPServer(mcpServer: MCPPermissionServer): void {
    this.mcpServer = mcpServer;
  }

  private setupEventHandlers(): void {
    this.client.once("ready", async () => {
      console.log(`Bot is ready! Logged in as ${this.client.user?.tag}`);
      await this.commandHandler.registerCommands(
        process.env.DISCORD_TOKEN!,
        this.client.user!.id
      );
    });

    this.client.on("interactionCreate", async (interaction) => {
      await this.commandHandler.handleInteraction(interaction);
    });

    this.client.on("messageCreate", async (message) => {
      await this.handleMessage(message);
    });

    // Handle reactions for MCP approval
    this.client.on("messageReactionAdd", async (reaction, user) => {
      await this.handleReactionAdd(reaction, user);
    });
  }

  /**
   * Handle reaction add events for MCP approval
   */
  private async handleReactionAdd(reaction: any, user: any): Promise<void> {
    // Ignore bot reactions
    if (user.bot) return;

    // Only process reactions from the authorized user
    if (user.id !== this.allowedUserId) return;

    // Only process ✅ and ❌ reactions
    if (reaction.emoji.name !== '✅' && reaction.emoji.name !== '❌') return;

    console.log(`Discord: Reaction ${reaction.emoji.name} by ${user.id} on message ${reaction.message.id}`);

    // Pass to MCP server if available
    if (this.mcpServer) {
      const approved = reaction.emoji.name === '✅';
      this.mcpServer.getPermissionManager().handleApprovalReaction(
        reaction.message.channelId,
        reaction.message.id,
        user.id,
        approved
      );
    }
  }

  /**
   * Download attachments from a Discord message to temp files
   */
  private async downloadAttachments(message: any): Promise<DownloadedAttachment[]> {
    const downloaded: DownloadedAttachment[] = [];

    if (!message.attachments || message.attachments.size === 0) {
      return downloaded;
    }

    ensureAttachmentDir();
    cleanupOldAttachments(); // Clean old files periodically

    let index = 0;
    for (const [, attachment] of message.attachments) {
      try {
        const tempPath = getTempPath(message.channelId, attachment.name, index);
        await downloadAttachment(attachment.url, tempPath);

        downloaded.push({
          tempPath,
          originalName: attachment.name,
          contentType: attachment.contentType,
          isImage: isImageType(attachment.contentType, attachment.name)
        });

        console.log(`Downloaded attachment: ${attachment.name} -> ${tempPath}`);
        index++;
      } catch (error) {
        console.error(`Failed to download ${attachment.name}:`, error);
      }
    }

    return downloaded;
  }

  private async handleMessage(message: any): Promise<void> {
    if (message.author.bot) return;

    console.log("MESSAGE CREATED", message.id);

    if (message.author.id !== this.allowedUserId) {
      return;
    }

    const channelId = message.channelId;

    // Atomic check-and-lock: if channel is already processing, skip
    if (this.claudeManager.hasActiveProcess(channelId)) {
      console.log(
        `Channel ${channelId} is already processing, skipping new message`
      );
      return;
    }

    const channelName =
      message.channel && "name" in message.channel
        ? message.channel.name
        : "default";

    const provider = this.claudeManager.getProvider(channelId);
    const providerLabel = provider === "codex" ? "Codex" : "Claude Code";
    
    // Don't run in general channel
    if (channelName === "general") {
      return;
    }

    // Ignore slash commands (they're handled by interactions)
    if (message.content.startsWith("/")) {
      return;
    }

    // Check if this is a new channel without a folder
    const customPath = this.claudeManager.getPath(channelId);
    const folderName = customPath || channelName;
    const projectPath = path.join(this.baseFolder, folderName);

    if (!fs.existsSync(projectPath)) {
      // Show info message about folder creation
      const infoEmbed = new EmbedBuilder()
        .setTitle("📁 New Project Channel")
        .setDescription(
          `This channel will create a ${providerLabel} session in:\n\`${projectPath}\`\n\n` +
          `**Create Folder** - Create the folder and start working\n` +
          `**Change Path** - Use \`/setpath <folder>\` to map to a different folder first`
        )
        .setColor(0x5865F2);

      const row = new ActionRowBuilder<ButtonBuilder>()
        .addComponents(
          new ButtonBuilder()
            .setCustomId("folder_create")
            .setLabel("Create Folder")
            .setStyle(ButtonStyle.Success),
          new ButtonBuilder()
            .setCustomId("folder_cancel")
            .setLabel("Change Path")
            .setStyle(ButtonStyle.Secondary)
        );

      const infoMsg = await message.channel.send({ embeds: [infoEmbed], components: [row] });

      try {
        const interaction = await infoMsg.awaitMessageComponent({
          componentType: ComponentType.Button,
          filter: (i) => i.user.id === this.allowedUserId,
          time: 60000,
        });

        if (interaction.customId === "folder_create") {
          await interaction.deferUpdate();

          // Create the folder
          fs.mkdirSync(projectPath, { recursive: true });

          const createdEmbed = new EmbedBuilder()
            .setTitle("✅ Folder Created")
            .setDescription(`Created \`${projectPath}\``)
            .setColor(0x00FF00);

          await infoMsg.edit({ embeds: [createdEmbed], components: [] });
          // Continue with processing below
        } else {
          await interaction.deferUpdate();

          const cancelEmbed = new EmbedBuilder()
            .setTitle("ℹ️ Path Change Required")
            .setDescription(`Use \`/setpath <folder>\` to set a custom path, then send your message again.`)
            .setColor(0xFFD700);

          await infoMsg.edit({ embeds: [cancelEmbed], components: [] });
          return; // Don't process the message
        }
      } catch (error) {
        // Timeout
        const timeoutEmbed = new EmbedBuilder()
          .setTitle("⏰ Timed Out")
          .setDescription("No response. Use `/setpath` or send your message again.")
          .setColor(0xFFD700);

        await infoMsg.edit({ embeds: [timeoutEmbed], components: [] });
        return;
      }
    }

    const sessionId = this.claudeManager.getSessionId(channelId);

    console.log(`Received message in channel: ${channelName} (${channelId})`);
    console.log(`Message content: ${message.content}`);
    console.log(`Existing session ID: ${sessionId || "none"}`);

    try {
      // Check if we have an existing session
      const isNewSession = !sessionId;
      
      // Create status embed
      const statusEmbed = new EmbedBuilder()
        .setColor(0xFFD700); // Yellow for startup
      
      if (isNewSession) {
        statusEmbed
          .setTitle("🆕 Starting New Session")
          .setDescription(`Initializing ${providerLabel}...`);
      } else {
        statusEmbed
          .setTitle("🔄 Continuing Session")
          .setDescription(`**Session ID:** ${sessionId}\nResuming ${providerLabel}...`);
      }
      
      // Create initial Discord message
      const reply = await message.channel.send({ embeds: [statusEmbed] });
      console.log("Created Discord message:", reply.id);
      this.claudeManager.setDiscordMessage(channelId, reply);

      // Create Discord context for MCP server
      const discordContext = {
        channelId: channelId,
        channelName: channelName,
        userId: message.author.id,
        messageId: message.id,
      };

      // Download any attachments from the message
      const attachments = await this.downloadAttachments(message);

      // Build enhanced prompt with attachment references
      const enhancedPrompt = buildPromptWithAttachments(message.content, attachments);

      // Reserve the channel and run the selected provider
      this.claudeManager.reserveChannel(channelId, sessionId, reply);
      await this.claudeManager.runClaudeCode(channelId, channelName, enhancedPrompt, sessionId, discordContext);
    } catch (error) {
      console.error("Error running provider:", error);
      
      // Clean up on error
      this.claudeManager.clearSession(channelId);
      
      const errorMessage = error instanceof Error ? error.message : String(error);
      try {
        await message.channel.send(`Error: ${errorMessage}`);
      } catch (sendError) {
        console.error("Failed to send error message:", sendError);
      }
    }
  }

  async login(token: string): Promise<void> {
    await this.client.login(token);
  }
}
