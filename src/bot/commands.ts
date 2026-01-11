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

  private getProjectPath(interaction: any): string | null {
    const channelId = interaction.channelId;

    // Check for custom path first
    const customFolder = this.claudeManager.getPath(channelId);
    if (customFolder) {
      const customPath = path.join(this.baseFolder, customFolder);
      if (fs.existsSync(customPath)) {
        return customPath;
      }
    }

    // Fall back to channel name
    const channelName = interaction.channel && "name" in interaction.channel
      ? interaction.channel.name
      : null;

    if (!channelName) return null;

    const projectPath = path.join(this.baseFolder, channelName);
    return fs.existsSync(projectPath) ? projectPath : null;
  }

  getCommands() {
    return [
      new SlashCommandBuilder()
        .setName("clear")
        .setDescription("Clear the current AI session"),
      new SlashCommandBuilder()
        .setName("stop")
        .setDescription("Stop the currently running AI process"),
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
        .setName("provider")
        .setDescription("Set the AI provider for this channel")
        .addStringOption(option =>
          option.setName("provider")
            .setDescription("The provider to use")
            .setRequired(true)
            .addChoices(
              { name: "claude - Claude Code CLI", value: "claude" },
              { name: "codex - Codex CLI", value: "codex" }
            )
        ),
      new SlashCommandBuilder()
        .setName("status")
        .setDescription("Show current mode and session info for this channel"),
      new SlashCommandBuilder()
        .setName("init")
        .setDescription("Create a new project folder matching this channel name"),
      new SlashCommandBuilder()
        .setName("ls")
        .setDescription("List files and directories in the project")
        .addStringOption(option =>
          option.setName("path")
            .setDescription("Relative path to list (default: project root)")
            .setRequired(false)
        ),
      new SlashCommandBuilder()
        .setName("cat")
        .setDescription("Display contents of a file")
        .addStringOption(option =>
          option.setName("file")
            .setDescription("Relative path to the file")
            .setRequired(true)
        )
        .addIntegerOption(option =>
          option.setName("lines")
            .setDescription("Max lines to show (default: 50)")
            .setRequired(false)
        ),
      new SlashCommandBuilder()
        .setName("tree")
        .setDescription("Show directory structure")
        .addIntegerOption(option =>
          option.setName("depth")
            .setDescription("Max depth to show (default: 2)")
            .setRequired(false)
        ),
      new SlashCommandBuilder()
        .setName("setpath")
        .setDescription("Set a custom folder path for this channel")
        .addStringOption(option =>
          option.setName("folder")
            .setDescription("Folder name (e.g., 'my-repo.github.io') or 'clear' to reset")
            .setRequired(true)
        ),
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
        "Session cleared! Next message will start a new AI session."
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

    if (interaction.commandName === "provider") {
      const channelId = interaction.channelId;
      const provider = interaction.options.getString("provider") as "claude" | "codex";
      this.claudeManager.setProvider(channelId, provider);

      const providerDescriptions = {
        claude: "**Claude** - Use Claude Code CLI with full tool streaming and permissions.",
        codex: "**Codex** - Use Codex CLI with JSON streaming output.",
      };

      await interaction.reply(`Provider updated!\n\n${providerDescriptions[provider]}`);
    }

    if (interaction.commandName === "status") {
      const channelId = interaction.channelId;
      const mode = this.claudeManager.getMode(channelId);
      const model = this.claudeManager.getModel(channelId);
      const provider = this.claudeManager.getProvider(channelId);
      const hasSession = this.claudeManager.getSessionId(channelId) ? "Yes" : "No";
      const customPath = this.claudeManager.getPath(channelId);
      const channelName = interaction.channel?.name || "unknown";
      const folder = customPath || channelName;

      let status = `**Channel Status**\n` +
        `Provider: ${provider}\n` +
        `Mode: ${mode}\n`;

      if (provider === "claude") {
        status += `Model: ${model}\n`;
      }

      status += `Active Session: ${hasSession}\n` +
        `Folder: \`${folder}\``;

      if (customPath) {
        status += ` *(custom)*`;
      }

      await interaction.reply(status);
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

    if (interaction.commandName === "ls") {
      const projectPath = this.getProjectPath(interaction);
      if (!projectPath) {
        await interaction.reply({
          content: "No project folder found for this channel. Use `/init` to create one.",
          ephemeral: true,
        });
        return;
      }

      const relativePath = interaction.options.getString("path") || "";
      const targetPath = path.join(projectPath, relativePath);

      // Security check: ensure we're still within the project
      if (!targetPath.startsWith(projectPath)) {
        await interaction.reply({
          content: "Cannot access paths outside the project folder.",
          ephemeral: true,
        });
        return;
      }

      if (!fs.existsSync(targetPath)) {
        await interaction.reply({
          content: `Path not found: \`${relativePath || "/"}\``,
          ephemeral: true,
        });
        return;
      }

      try {
        const entries = fs.readdirSync(targetPath, { withFileTypes: true });
        const dirs = entries.filter(e => e.isDirectory()).map(e => `📁 ${e.name}/`);
        const files = entries.filter(e => e.isFile()).map(e => `📄 ${e.name}`);

        const listing = [...dirs.sort(), ...files.sort()].join("\n");
        const displayPath = relativePath || "/";

        if (listing.length === 0) {
          await interaction.reply(`📂 \`${displayPath}\` is empty`);
        } else if (listing.length > 1900) {
          await interaction.reply(`📂 \`${displayPath}\`\n\`\`\`\n${listing.substring(0, 1900)}...\n\`\`\``);
        } else {
          await interaction.reply(`📂 \`${displayPath}\`\n\`\`\`\n${listing}\n\`\`\``);
        }
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        await interaction.reply({
          content: `❌ Error listing directory: ${errorMessage}`,
          ephemeral: true,
        });
      }
    }

    if (interaction.commandName === "cat") {
      const projectPath = this.getProjectPath(interaction);
      if (!projectPath) {
        await interaction.reply({
          content: "No project folder found for this channel. Use `/init` to create one.",
          ephemeral: true,
        });
        return;
      }

      const filePath = interaction.options.getString("file");
      const maxLines = interaction.options.getInteger("lines") || 50;
      const targetPath = path.join(projectPath, filePath);

      // Security check
      if (!targetPath.startsWith(projectPath)) {
        await interaction.reply({
          content: "Cannot access files outside the project folder.",
          ephemeral: true,
        });
        return;
      }

      if (!fs.existsSync(targetPath)) {
        await interaction.reply({
          content: `File not found: \`${filePath}\``,
          ephemeral: true,
        });
        return;
      }

      if (fs.statSync(targetPath).isDirectory()) {
        await interaction.reply({
          content: `\`${filePath}\` is a directory. Use \`/ls\` instead.`,
          ephemeral: true,
        });
        return;
      }

      try {
        const content = fs.readFileSync(targetPath, "utf-8");
        const lines = content.split("\n");
        const truncated = lines.length > maxLines;
        const displayContent = lines.slice(0, maxLines).join("\n");

        // Detect file extension for syntax highlighting
        const ext = path.extname(filePath).slice(1) || "txt";

        let response = `📄 \`${filePath}\``;
        if (truncated) {
          response += ` (showing ${maxLines}/${lines.length} lines)`;
        }

        if (displayContent.length > 1800) {
          response += `\n\`\`\`${ext}\n${displayContent.substring(0, 1800)}...\n\`\`\``;
        } else {
          response += `\n\`\`\`${ext}\n${displayContent}\n\`\`\``;
        }

        await interaction.reply(response);
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        await interaction.reply({
          content: `❌ Error reading file: ${errorMessage}`,
          ephemeral: true,
        });
      }
    }

    if (interaction.commandName === "tree") {
      const projectPath = this.getProjectPath(interaction);
      if (!projectPath) {
        await interaction.reply({
          content: "No project folder found for this channel. Use `/init` to create one.",
          ephemeral: true,
        });
        return;
      }

      const maxDepth = interaction.options.getInteger("depth") || 2;

      const buildTree = (dir: string, prefix: string = "", depth: number = 0): string[] => {
        if (depth >= maxDepth) return [];

        const entries = fs.readdirSync(dir, { withFileTypes: true })
          .filter(e => !e.name.startsWith(".") && e.name !== "node_modules")
          .sort((a, b) => {
            // Directories first, then alphabetically
            if (a.isDirectory() && !b.isDirectory()) return -1;
            if (!a.isDirectory() && b.isDirectory()) return 1;
            return a.name.localeCompare(b.name);
          });

        const lines: string[] = [];
        entries.forEach((entry, index) => {
          const isLast = index === entries.length - 1;
          const connector = isLast ? "└── " : "├── ";
          const icon = entry.isDirectory() ? "📁 " : "📄 ";
          lines.push(`${prefix}${connector}${icon}${entry.name}`);

          if (entry.isDirectory()) {
            const newPrefix = prefix + (isLast ? "    " : "│   ");
            lines.push(...buildTree(path.join(dir, entry.name), newPrefix, depth + 1));
          }
        });

        return lines;
      };

      try {
        const channelName = interaction.channel?.name || "project";
        const tree = [`📁 ${channelName}/`, ...buildTree(projectPath)].join("\n");

        if (tree.length > 1900) {
          await interaction.reply(`\`\`\`\n${tree.substring(0, 1900)}...\n\`\`\``);
        } else {
          await interaction.reply(`\`\`\`\n${tree}\n\`\`\``);
        }
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        await interaction.reply({
          content: `❌ Error building tree: ${errorMessage}`,
          ephemeral: true,
        });
      }
    }

    if (interaction.commandName === "setpath") {
      const channelId = interaction.channelId;
      const folder = interaction.options.getString("folder");

      if (folder.toLowerCase() === "clear") {
        this.claudeManager.clearPath(channelId);
        const channelName = interaction.channel?.name || "unknown";
        await interaction.reply(`✅ Custom path cleared. Channel will now use default folder: \`${channelName}\``);
        return;
      }

      // Check if the folder exists
      const folderPath = path.join(this.baseFolder, folder);
      if (!fs.existsSync(folderPath)) {
        await interaction.reply({
          content: `❌ Folder not found: \`${folderPath}\`\n\nMake sure the folder exists in your base folder.`,
          ephemeral: true,
        });
        return;
      }

      this.claudeManager.setPath(channelId, folder);
      await interaction.reply(`✅ Custom path set!\n\nThis channel now points to: \`${folderPath}\``);
    }
  }
}
