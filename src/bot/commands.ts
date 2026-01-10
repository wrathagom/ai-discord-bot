import { SlashCommandBuilder, REST, Routes } from "discord.js";
import * as fs from "fs";
import * as path from "path";
import type { ClaudeManager } from '../claude/manager.js';

export class CommandHandler {
  constructor(
    private claudeManager: ClaudeManager,
    private allowedUserId: string,
    private baseFolder: string
  ) {}

  getCommands() {
    return [
      new SlashCommandBuilder()
        .setName("clear")
        .setDescription("Clear the current Claude Code session"),
      new SlashCommandBuilder()
        .setName("stop")
        .setDescription("Stop the currently running Claude Code process"),
      new SlashCommandBuilder()
        .setName("mode")
        .setDescription("Set Claude's permission mode for this channel")
        .addStringOption(option =>
          option.setName("mode")
            .setDescription("The permission mode to use")
            .setRequired(true)
            .addChoices(
              { name: "auto - Execute immediately without asking", value: "auto" },
              { name: "plan - Create detailed plan before executing", value: "plan" },
              { name: "approve - Ask permission for each dangerous action", value: "approve" }
            )
        ),
      new SlashCommandBuilder()
        .setName("model")
        .setDescription("Set the Claude model for this channel")
        .addStringOption(option =>
          option.setName("model")
            .setDescription("The model to use")
            .setRequired(true)
            .addChoices(
              { name: "opus - Most capable, best for complex tasks", value: "opus" },
              { name: "sonnet - Balanced performance and cost", value: "sonnet" },
              { name: "haiku - Fastest and most affordable", value: "haiku" }
            )
        ),
      new SlashCommandBuilder()
        .setName("status")
        .setDescription("Show current mode and session info for this channel"),
      new SlashCommandBuilder()
        .setName("init")
        .setDescription("Create a new project folder matching this channel name"),
    ];
  }

  async registerCommands(token: string, clientId: string): Promise<void> {
    const rest = new REST().setToken(token);

    try {
      await rest.put(Routes.applicationCommands(clientId), {
        body: this.getCommands(),
      });
      console.log("Successfully registered application commands.");
    } catch (error) {
      console.error(error);
    }
  }

  async handleInteraction(interaction: any): Promise<void> {
    if (!interaction.isChatInputCommand()) return;

    if (interaction.user.id !== this.allowedUserId) {
      await interaction.reply({
        content: "You are not authorized to use this bot.",
        ephemeral: true,
      });
      return;
    }

    if (interaction.commandName === "clear") {
      const channelId = interaction.channelId;
      this.claudeManager.clearSession(channelId);

      await interaction.reply(
        "Session cleared! Next message will start a new Claude Code session."
      );
    }

    if (interaction.commandName === "stop") {
      const channelId = interaction.channelId;
      if (this.claudeManager.hasActiveProcess(channelId)) {
        this.claudeManager.killActiveProcess(channelId);
        await interaction.reply("🛑 Stopped the running process.");
      } else {
        await interaction.reply({
          content: "No active process to stop.",
          ephemeral: true,
        });
      }
    }

    if (interaction.commandName === "mode") {
      const channelId = interaction.channelId;
      const mode = interaction.options.getString("mode") as "auto" | "plan" | "approve";
      this.claudeManager.setMode(channelId, mode);

      const modeDescriptions = {
        auto: "**Auto mode** - Claude will execute actions immediately without asking for permission.",
        plan: "**Plan mode** - Claude will create a detailed plan and wait for approval before executing.",
        approve: "**Approve mode** - Claude will ask for permission (✅/❌) before each dangerous action (Bash, Write, Edit).",
      };

      await interaction.reply(`Mode updated!\n\n${modeDescriptions[mode]}`);
    }

    if (interaction.commandName === "model") {
      const channelId = interaction.channelId;
      const model = interaction.options.getString("model") as "opus" | "sonnet" | "haiku";
      this.claudeManager.setModel(channelId, model);

      const modelDescriptions = {
        opus: "**Opus** - Most capable model, best for complex tasks requiring deep reasoning.",
        sonnet: "**Sonnet** - Balanced performance and cost, great for most tasks.",
        haiku: "**Haiku** - Fastest and most affordable, ideal for simple tasks.",
      };

      await interaction.reply(`Model updated!\n\n${modelDescriptions[model]}`);
    }

    if (interaction.commandName === "status") {
      const channelId = interaction.channelId;
      const mode = this.claudeManager.getMode(channelId);
      const model = this.claudeManager.getModel(channelId);
      const hasSession = this.claudeManager.getSessionId(channelId) ? "Yes" : "No";

      await interaction.reply(
        `**Channel Status**\n` +
        `Mode: ${mode}\n` +
        `Model: ${model}\n` +
        `Active Session: ${hasSession}`
      );
    }

    if (interaction.commandName === "init") {
      const channelName = interaction.channel && "name" in interaction.channel
        ? interaction.channel.name
        : null;

      if (!channelName || channelName === "general") {
        await interaction.reply({
          content: "Cannot initialize in this channel. Use a project-specific channel.",
          ephemeral: true,
        });
        return;
      }

      const projectPath = path.join(this.baseFolder, channelName);

      if (fs.existsSync(projectPath)) {
        await interaction.reply(`Project folder already exists: \`${projectPath}\``);
        return;
      }

      try {
        fs.mkdirSync(projectPath, { recursive: true });
        await interaction.reply(`✅ Created project folder: \`${projectPath}\``);
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        await interaction.reply({
          content: `❌ Failed to create folder: ${errorMessage}`,
          ephemeral: true,
        });
      }
    }
  }
}