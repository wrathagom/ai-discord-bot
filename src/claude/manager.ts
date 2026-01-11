import { spawn, type ChildProcess } from "child_process";
import * as path from "path";
import * as fs from "fs";
import { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, ComponentType } from "discord.js";
import type { SDKMessage } from "../types/index.js";
import { buildClaudeCommand, buildCodexCommand, type DiscordContext } from "../utils/shell.js";
import { DatabaseManager, type PermissionMode, type ClaudeModel, type Provider } from "../db/database.js";

interface PendingQuestion {
  toolUseId: string;
  questions: Array<{
    question: string;
    header?: string;
    options: Array<{ label: string; description?: string }>;
    multiSelect?: boolean;
  }>;
  resolve: (answers: Record<string, string>) => void;
}

export class ClaudeManager {
  private db: DatabaseManager;
  private channelMessages = new Map<string, any>();
  private channelToolCalls = new Map<string, Map<string, { message: any, toolId: string }>>();
  private channelNames = new Map<string, string>();
  private channelProcesses = new Map<
    string,
    {
      process: ChildProcess | null;
      sessionId?: string;
      discordMessage: any;
    }
  >();
  private pendingQuestions = new Map<string, PendingQuestion>();

  constructor(private baseFolder: string) {
    this.db = new DatabaseManager();
    // Clean up old sessions on startup
    this.db.cleanupOldSessions();
  }

  hasActiveProcess(channelId: string): boolean {
    return this.channelProcesses.has(channelId);
  }

  killActiveProcess(channelId: string): void {
    const activeProcess = this.channelProcesses.get(channelId);
    if (activeProcess?.process) {
      console.log(`Killing active process for channel ${channelId}`);
      activeProcess.process.kill("SIGTERM");
    }
  }

  clearSession(channelId: string): void {
    this.killActiveProcess(channelId);
    this.db.clearSession(channelId);
    this.channelMessages.delete(channelId);
    this.channelToolCalls.delete(channelId);
    this.channelNames.delete(channelId);
    this.channelProcesses.delete(channelId);
  }

  setMode(channelId: string, mode: PermissionMode): void {
    this.db.setMode(channelId, mode);
  }

  getMode(channelId: string): PermissionMode {
    return this.db.getMode(channelId);
  }

  setModel(channelId: string, model: ClaudeModel): void {
    this.db.setModel(channelId, model);
  }

  getModel(channelId: string): ClaudeModel {
    return this.db.getModel(channelId);
  }

  setProvider(channelId: string, provider: Provider): void {
    this.db.setProvider(channelId, provider);
    this.clearSession(channelId);
  }

  getProvider(channelId: string): Provider {
    return this.db.getProvider(channelId);
  }

  setPath(channelId: string, folderName: string): void {
    this.db.setPath(channelId, folderName);
  }

  getPath(channelId: string): string | undefined {
    return this.db.getPath(channelId);
  }

  clearPath(channelId: string): void {
    this.db.clearPath(channelId);
  }

  private formatToolCall(tool: any, channelId: string): string {
    const channelName = this.channelNames.get(channelId);
    const basePath = channelName ? `${this.baseFolder}${channelName}` : "";

    const cleanPath = (val: string): string => {
      if (basePath && val === basePath) return ".";
      if (basePath && val.startsWith(basePath + "/")) {
        return val.replace(basePath + "/", "./");
      }
      return val;
    };

    // Special formatting for Bash tool
    if (tool.name === "Bash" && tool.input?.command) {
      const cmd = cleanPath(String(tool.input.command));
      return `🔧 **Bash**\n\`\`\`bash\n${cmd}\n\`\`\``;
    }

    // Special formatting for TodoWrite tool
    if (tool.name === "TodoWrite" && tool.input?.todos) {
      const todos = tool.input.todos;
      if (Array.isArray(todos)) {
        const todoLines = todos.map((t: any) => {
          const status = t.status === "completed" ? "✅" :
                        t.status === "in_progress" ? "🔄" : "⬜";
          return `${status} ${t.content || t.activeForm || ""}`;
        }).join("\n");
        return `🔧 **TodoWrite**\n${todoLines}`;
      }
    }

    // Special formatting for Read tool
    if (tool.name === "Read" && tool.input?.file_path) {
      const filePath = cleanPath(String(tool.input.file_path));
      return `🔧 **Read** \`${filePath}\``;
    }

    // Special formatting for Edit tool
    if (tool.name === "Edit" && tool.input?.file_path) {
      const filePath = cleanPath(String(tool.input.file_path));
      return `🔧 **Edit** \`${filePath}\``;
    }

    // Special formatting for Write tool
    if (tool.name === "Write" && tool.input?.file_path) {
      const filePath = cleanPath(String(tool.input.file_path));
      return `🔧 **Write** \`${filePath}\``;
    }

    // Special formatting for Glob tool
    if (tool.name === "Glob" && tool.input?.pattern) {
      return `🔧 **Glob** \`${tool.input.pattern}\``;
    }

    // Special formatting for Grep tool
    if (tool.name === "Grep" && tool.input?.pattern) {
      const pattern = tool.input.pattern;
      const path = tool.input.path ? ` in \`${cleanPath(tool.input.path)}\`` : "";
      return `🔧 **Grep** \`${pattern}\`${path}`;
    }

    // Special formatting for AskUserQuestion - handled separately
    if (tool.name === "AskUserQuestion") {
      return `❓ **Question from Claude**`;
    }

    // Special formatting for ExitPlanMode - handled separately
    if (tool.name === "ExitPlanMode") {
      return `📋 **Plan Ready for Approval**`;
    }

    // Default formatting for other tools
    let message = `🔧 **${tool.name}**`;

    if (tool.input && Object.keys(tool.input).length > 0) {
      const inputs = Object.entries(tool.input)
        .map(([key, value]) => {
          let val: string;
          if (typeof value === 'object' && value !== null) {
            val = JSON.stringify(value);
            if (val.length > 80) val = val.substring(0, 80) + "...";
          } else {
            val = cleanPath(String(value));
            if (val.length > 80) val = val.substring(0, 80) + "...";
          }
          return `${key}=\`${val}\``;
        })
        .join(", ");
      message += ` (${inputs})`;
    }

    return message;
  }

  setDiscordMessage(channelId: string, message: any): void {
    this.channelMessages.set(channelId, message);
    this.channelToolCalls.set(channelId, new Map());
  }

  reserveChannel(
    channelId: string,
    sessionId: string | undefined,
    discordMessage: any
  ): void {
    // Kill any existing process (safety measure)
    const existingProcess = this.channelProcesses.get(channelId);
    if (existingProcess?.process) {
      console.log(
        `Killing existing process for channel ${channelId} before starting new one`
      );
      existingProcess.process.kill("SIGTERM");
    }

    // Reserve the channel by adding a placeholder entry (prevents race conditions)
    this.channelProcesses.set(channelId, {
      process: null, // Will be set when process actually starts
      sessionId,
      discordMessage,
    });
  }

  getSessionId(channelId: string): string | undefined {
    return this.db.getSession(channelId);
  }

  async runClaudeCode(
    channelId: string,
    channelName: string,
    prompt: string,
    sessionId?: string,
    discordContext?: DiscordContext
  ): Promise<void> {
    const provider = this.getProvider(channelId);
    if (provider === "codex") {
      await this.runCodex(channelId, channelName, prompt, sessionId);
      return;
    }

    // Check for custom path first, fall back to channel name
    const customPath = this.getPath(channelId);
    const folderName = customPath || channelName;

    // Store the folder name for path replacement
    this.channelNames.set(channelId, folderName);
    const workingDir = path.join(this.baseFolder, folderName);
    console.log(`Running Claude Code in: ${workingDir}`);

    // Check if working directory exists
    if (!fs.existsSync(workingDir)) {
      throw new Error(`Working directory does not exist: ${workingDir}`);
    }

    const mode = this.getMode(channelId);
    const model = this.getModel(channelId);
    const commandString = buildClaudeCommand(workingDir, prompt, sessionId, discordContext, mode, model);
    console.log(`Running command: ${commandString}`);
    console.log(`Using mode: ${mode}, model: ${model}`);

    const claude = spawn("/bin/bash", ["-c", commandString], {
      stdio: ["pipe", "pipe", "pipe"],
      env: {
        ...process.env,
        SHELL: "/bin/bash",
      },
    });

    console.log(`Claude process spawned with PID: ${claude.pid}`);

    // Update the channel process tracking with actual process
    const channelProcess = this.channelProcesses.get(channelId);
    if (channelProcess) {
      channelProcess.process = claude;
    }

    // Close stdin - we're using -p mode so all input is via command line
    // Note: AskUserQuestion via stdin requires --input-format stream-json which
    // doesn't work well with -p mode, so that feature is disabled for now
    claude.stdin.end();

    // Add immediate listeners to debug
    claude.on("spawn", () => {
      console.log("Process successfully spawned");
    });

    claude.on("error", (error) => {
      console.error("Process spawn error:", error);
    });

    let buffer = "";

    // Set a timeout for the Claude process (5 minutes)
    const timeout = setTimeout(() => {
      console.log("Claude process timed out, killing it");
      claude.kill("SIGTERM");

      const channel = this.channelMessages.get(channelId)?.channel;
      if (channel) {
        const timeoutEmbed = new EmbedBuilder()
          .setTitle("⏰ Timeout")
          .setDescription("Claude Code took too long to respond (5 minutes)")
          .setColor(0xFFD700); // Yellow for timeout
        
        channel.send({ embeds: [timeoutEmbed] }).catch(console.error);
      }
    }, 5 * 60 * 1000); // 5 minutes

    claude.stdout.on("data", (data) => {
      const rawData = data.toString();
      console.log("Raw stdout data:", rawData);
      
      // Log all streamed output to log.txt
      try {
        fs.appendFileSync(path.join(process.cwd(), 'log.txt'), 
          `[${new Date().toISOString()}] Channel: ${channelId}\n${rawData}\n---\n`);
      } catch (error) {
        console.error("Error writing to log.txt:", error);
      }
      
      buffer += rawData;
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";

      for (const line of lines) {
        if (line.trim()) {
          console.log("Processing line:", line);
          try {
            const parsed: SDKMessage = JSON.parse(line);
            console.log("Parsed message type:", parsed.type);

            if (parsed.type === "assistant" && parsed.message.content) {
              this.handleAssistantMessage(channelId, parsed).catch(console.error);
            } else if (parsed.type === "user" && parsed.message.content) {
              this.handleToolResultMessage(channelId, parsed).catch(console.error);
            } else if (parsed.type === "result") {
              this.handleResultMessage(channelId, parsed).then(() => {
                clearTimeout(timeout);
                claude.kill("SIGTERM");
                this.channelProcesses.delete(channelId);
              }).catch(console.error);
            } else if (parsed.type === "system") {
              console.log("System message:", parsed.subtype);
              if (parsed.subtype === "init") {
                this.handleInitMessage(channelId, parsed).catch(console.error);
              }
              const channelName = this.channelNames.get(channelId) || "default";
              this.db.setSession(channelId, parsed.session_id, channelName);
            }
          } catch (error) {
            console.error("Error parsing JSON:", error, "Line:", line);
          }
        }
      }
    });

    claude.on("close", (code) => {
      console.log(`Claude process exited with code ${code}`);
      clearTimeout(timeout);
      // Ensure cleanup on process close
      this.channelProcesses.delete(channelId);

      if (code !== 0 && code !== null) {
        // Process failed - send error embed to Discord
        const channel = this.channelMessages.get(channelId)?.channel;
        if (channel) {
          const errorEmbed = new EmbedBuilder()
            .setTitle("❌ Claude Code Failed")
            .setDescription(`Process exited with code: ${code}`)
            .setColor(0xFF0000); // Red for error
          
          channel.send({ embeds: [errorEmbed] }).catch(console.error);
        }
      }
    });

    claude.stderr.on("data", (data) => {
      const stderrOutput = data.toString();
      console.error("Claude stderr:", stderrOutput);

      // If there's significant stderr output, send warning to Discord
      if (
        stderrOutput.trim() &&
        !stderrOutput.includes("INFO") &&
        !stderrOutput.includes("DEBUG")
      ) {
        const channel = this.channelMessages.get(channelId)?.channel;
        if (channel) {
          const warningEmbed = new EmbedBuilder()
            .setTitle("⚠️ Warning")
            .setDescription(stderrOutput.trim())
            .setColor(0xFFA500); // Orange for warnings
          
          channel.send({ embeds: [warningEmbed] }).catch(console.error);
        }
      }
    });

    claude.on("error", (error) => {
      console.error("Claude process error:", error);
      clearTimeout(timeout);

      // Clean up process tracking on error
      this.channelProcesses.delete(channelId);

      // Send error to Discord
      const channel = this.channelMessages.get(channelId)?.channel;
      if (channel) {
        const processErrorEmbed = new EmbedBuilder()
          .setTitle("❌ Process Error")
          .setDescription(error.message)
          .setColor(0xFF0000); // Red for errors
        
        channel.send({ embeds: [processErrorEmbed] }).catch(console.error);
      }
    });
  }

  private async runCodex(
    channelId: string,
    channelName: string,
    prompt: string,
    sessionId?: string
  ): Promise<void> {
    const customPath = this.getPath(channelId);
    const folderName = customPath || channelName;

    this.channelNames.set(channelId, folderName);
    const workingDir = path.join(this.baseFolder, folderName);
    console.log(`Running Codex in: ${workingDir}`);

    if (!fs.existsSync(workingDir)) {
      throw new Error(`Working directory does not exist: ${workingDir}`);
    }

    const commandString = buildCodexCommand(workingDir, prompt, sessionId);
    console.log(`Running command: ${commandString}`);

    const codex = spawn("/bin/bash", ["-c", commandString], {
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...process.env,
        SHELL: "/bin/bash",
      },
    });

    console.log(`Codex process spawned with PID: ${codex.pid}`);

    const channelProcess = this.channelProcesses.get(channelId);
    if (channelProcess) {
      channelProcess.process = codex;
    }

    let buffer = "";

    const timeout = setTimeout(() => {
      console.log("Codex process timed out, killing it");
      codex.kill("SIGTERM");

      const channel = this.channelMessages.get(channelId)?.channel;
      if (channel) {
        const timeoutEmbed = new EmbedBuilder()
          .setTitle("⏰ Timeout")
          .setDescription("Codex took too long to respond (5 minutes)")
          .setColor(0xFFD700);

        channel.send({ embeds: [timeoutEmbed] }).catch(console.error);
      }
    }, 5 * 60 * 1000);

    codex.stdout.on("data", (data) => {
      const rawData = data.toString();
      console.log("Raw stdout data:", rawData);

      try {
        fs.appendFileSync(
          path.join(process.cwd(), "log.txt"),
          `[${new Date().toISOString()}] Channel: ${channelId}\n${rawData}\n---\n`
        );
      } catch (error) {
        console.error("Error writing to log.txt:", error);
      }

      buffer += rawData;
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";

      for (const line of lines) {
        if (!line.trim()) continue;

        try {
          const parsed = JSON.parse(line);
          if (parsed.type === "thread.started" && parsed.thread_id) {
            this.db.setSession(channelId, parsed.thread_id, folderName);
            this.handleCodexInitMessage(channelId, parsed).catch(console.error);
          } else if (parsed.type === "item.started" && parsed.item?.type === "command_execution") {
            this.handleCodexCommandStart(channelId, parsed.item).catch(console.error);
          } else if (parsed.type === "item.completed") {
            if (parsed.item?.type === "agent_message") {
              const messageText = String(parsed.item.text || "");
              this.handleCodexMessage(channelId, messageText).catch(console.error);
            } else if (parsed.item?.type === "reasoning") {
              this.handleCodexReasoning(channelId, parsed.item).catch(console.error);
            } else if (parsed.item?.type === "command_execution") {
              this.handleCodexCommandComplete(channelId, parsed.item).catch(console.error);
            } else if (parsed.item?.type === "file_change") {
              this.handleCodexFileChange(channelId, parsed.item).catch(console.error);
            }
          } else if (parsed.type === "turn.completed") {
            this.handleCodexTurnCompleted(channelId, parsed).catch(console.error);
          }
        } catch (error) {
          console.error("Error parsing Codex JSON:", error, "Line:", line);
        }
      }
    });

    codex.on("close", (code) => {
      console.log(`Codex process exited with code ${code}`);
      clearTimeout(timeout);
      this.channelProcesses.delete(channelId);

      if (code !== 0 && code !== null) {
        const channel = this.channelMessages.get(channelId)?.channel;
        if (channel) {
          const errorEmbed = new EmbedBuilder()
            .setTitle("❌ Codex Failed")
            .setDescription(`Process exited with code: ${code}`)
            .setColor(0xFF0000);

          channel.send({ embeds: [errorEmbed] }).catch(console.error);
        }
      }
    });

    codex.stderr.on("data", (data) => {
      const stderrOutput = data.toString();
      console.error("Codex stderr:", stderrOutput);

      if (
        stderrOutput.trim() &&
        !stderrOutput.includes("INFO") &&
        !stderrOutput.includes("DEBUG")
      ) {
        const channel = this.channelMessages.get(channelId)?.channel;
        if (channel) {
          const warningEmbed = new EmbedBuilder()
            .setTitle("⚠️ Warning")
            .setDescription(stderrOutput.trim())
            .setColor(0xFFA500);

          channel.send({ embeds: [warningEmbed] }).catch(console.error);
        }
      }
    });

    codex.on("error", (error) => {
      console.error("Codex process error:", error);
      clearTimeout(timeout);
      this.channelProcesses.delete(channelId);

      const channel = this.channelMessages.get(channelId)?.channel;
      if (channel) {
        const processErrorEmbed = new EmbedBuilder()
          .setTitle("❌ Process Error")
          .setDescription(error.message)
          .setColor(0xFF0000);

        channel.send({ embeds: [processErrorEmbed] }).catch(console.error);
      }
    });
  }

  private async handleCodexMessage(channelId: string, text: string): Promise<void> {
    const channel = this.channelMessages.get(channelId)?.channel;
    if (!channel || !text.trim()) return;

    const MAX_EMBED_LENGTH = 4000;
    if (text.length <= MAX_EMBED_LENGTH) {
      const embed = new EmbedBuilder()
        .setTitle("💬 Codex")
        .setDescription(text)
        .setColor(0x4B88FF);

      await channel.send({ embeds: [embed] });
      return;
    }

    const chunks: string[] = [];
    let remaining = text;
    while (remaining.length > 0) {
      if (remaining.length <= MAX_EMBED_LENGTH) {
        chunks.push(remaining);
        break;
      }

      let splitIndex = remaining.lastIndexOf("\n\n", MAX_EMBED_LENGTH);
      if (splitIndex === -1 || splitIndex < MAX_EMBED_LENGTH / 2) {
        splitIndex = remaining.lastIndexOf("\n", MAX_EMBED_LENGTH);
      }
      if (splitIndex === -1 || splitIndex < MAX_EMBED_LENGTH / 2) {
        splitIndex = remaining.lastIndexOf(". ", MAX_EMBED_LENGTH);
        if (splitIndex !== -1) splitIndex += 1;
      }
      if (splitIndex === -1 || splitIndex < MAX_EMBED_LENGTH / 2) {
        splitIndex = MAX_EMBED_LENGTH;
      }

      chunks.push(remaining.substring(0, splitIndex));
      remaining = remaining.substring(splitIndex).trim();
    }

    const firstEmbed = new EmbedBuilder()
      .setTitle("💬 Codex")
      .setDescription(chunks[0])
      .setColor(0x4B88FF);
    await channel.send({ embeds: [firstEmbed] });

    for (let i = 1; i < chunks.length; i++) {
      const continueEmbed = new EmbedBuilder()
        .setDescription(chunks[i])
        .setColor(0x4B88FF)
        .setFooter({ text: `(continued ${i + 1}/${chunks.length})` });
      await channel.send({ embeds: [continueEmbed] });
    }
  }

  private async handleCodexInitMessage(channelId: string, parsed: any): Promise<void> {
    const channel = this.channelMessages.get(channelId)?.channel;
    if (!channel) return;

    const initEmbed = new EmbedBuilder()
      .setTitle("🚀 Codex Session Started")
      .setDescription(`**Thread ID:** ${parsed.thread_id}`)
      .setColor(0x00FF00);

    await channel.send({ embeds: [initEmbed] });
  }

  private async handleCodexReasoning(channelId: string, item: any): Promise<void> {
    const channel = this.channelMessages.get(channelId)?.channel;
    if (!channel) return;

    const text = String(item.text || "").trim();
    if (!text) return;

    const shortText = text.length > 350 ? text.substring(0, 350) + "..." : text;
    const reasoningEmbed = new EmbedBuilder()
      .setTitle("🧠 Codex Thinking")
      .setDescription(shortText)
      .setColor(0x6C5CE7);

    await channel.send({ embeds: [reasoningEmbed] });
  }

  private async handleCodexCommandStart(channelId: string, item: any): Promise<void> {
    const channel = this.channelMessages.get(channelId)?.channel;
    if (!channel) return;

    const command = this.formatCodexCommand(String(item.command || ""), channelId);
    const description = command.length > 500 ? command.substring(0, 500) + "..." : command;
    const embed = new EmbedBuilder()
      .setDescription(`⏳ 🔧 **Command**\n\`\`\`bash\n${description}\n\`\`\``)
      .setColor(0x0099FF);

    const message = await channel.send({ embeds: [embed] });
    const toolCalls = this.channelToolCalls.get(channelId) || new Map();
    toolCalls.set(item.id, { message, toolId: item.id });
    this.channelToolCalls.set(channelId, toolCalls);
  }

  private async handleCodexCommandComplete(channelId: string, item: any): Promise<void> {
    const channel = this.channelMessages.get(channelId)?.channel;
    if (!channel) return;

    const toolCalls = this.channelToolCalls.get(channelId) || new Map();
    const toolCall = toolCalls.get(item.id);
    const output = String(item.aggregated_output || "").trim();
    const firstLine = output.split("\n")[0] || "";
    const resultText = firstLine.length > 120 ? firstLine.substring(0, 120) + "..." : firstLine;
    const exitCode = typeof item.exit_code === "number" ? item.exit_code : undefined;
    const status = item.status === "failed" || exitCode ? "❌" : "✅";

    if (toolCall?.message) {
      const currentEmbed = toolCall.message.embeds[0];
      const originalDescription = currentEmbed.data.description.replace("⏳", status);
      const updatedEmbed = new EmbedBuilder()
        .setDescription(`${originalDescription}${resultText ? `\n*${resultText}*` : ""}`)
        .setColor(status === "✅" ? 0x00FF00 : 0xFF0000);
      await toolCall.message.edit({ embeds: [updatedEmbed] });
    } else {
      const command = this.formatCodexCommand(String(item.command || ""), channelId);
      const description = command.length > 500 ? command.substring(0, 500) + "..." : command;
      const embed = new EmbedBuilder()
        .setDescription(`${status} 🔧 **Command**\n\`\`\`bash\n${description}\n\`\`\`${resultText ? `\n*${resultText}*` : ""}`)
        .setColor(status === "✅" ? 0x00FF00 : 0xFF0000);
      await channel.send({ embeds: [embed] });
    }
  }

  private async handleCodexFileChange(channelId: string, item: any): Promise<void> {
    const channel = this.channelMessages.get(channelId)?.channel;
    if (!channel) return;

    const changes = Array.isArray(item.changes) ? item.changes : [];
    if (changes.length === 0) return;

    const channelName = this.channelNames.get(channelId);
    const basePath = channelName ? `${this.baseFolder}${channelName}` : "";
    const cleanPath = (val: string): string => {
      if (basePath && val === basePath) return ".";
      if (basePath && val.startsWith(basePath + "/")) {
        return val.replace(basePath + "/", "./");
      }
      return val;
    };

    const changeLines = changes
      .slice(0, 6)
      .map((change: any) => `• ${change.kind || "update"}: \`${cleanPath(String(change.path || ""))}\``);
    const more = changes.length > 6 ? `\n…and ${changes.length - 6} more` : "";

    const embed = new EmbedBuilder()
      .setTitle("📝 Codex File Changes")
      .setDescription(`${changeLines.join("\n")}${more}`)
      .setColor(0x00B894);

    await channel.send({ embeds: [embed] });
  }

  private formatCodexCommand(command: string, channelId: string): string {
    const channelName = this.channelNames.get(channelId);
    const basePath = channelName ? `${this.baseFolder}${channelName}` : "";

    if (!basePath) return command;
    if (command.includes(basePath)) {
      return command.replaceAll(basePath + "/", "./");
    }
    return command;
  }

  private async handleCodexTurnCompleted(channelId: string, parsed: any): Promise<void> {
    const channel = this.channelMessages.get(channelId)?.channel;
    if (!channel) return;

    const usage = parsed.usage || {};
    const tokenSummary = [
      typeof usage.input_tokens === "number" ? `input ${usage.input_tokens}` : null,
      typeof usage.output_tokens === "number" ? `output ${usage.output_tokens}` : null,
      typeof usage.cached_input_tokens === "number" ? `cached ${usage.cached_input_tokens}` : null,
    ].filter(Boolean).join(" · ");

    const description = tokenSummary ? `*${tokenSummary}*` : "*Turn complete*";

    const resultEmbed = new EmbedBuilder()
      .setTitle("✅ Session Complete")
      .setDescription(description)
      .setColor(0x00FF00);

    await channel.send({ embeds: [resultEmbed] });
  }

  private async handleInitMessage(channelId: string, parsed: any): Promise<void> {
    const channel = this.channelMessages.get(channelId)?.channel;
    if (!channel) return;
    
    const initEmbed = new EmbedBuilder()
      .setTitle("🚀 Claude Code Session Started")
      .setDescription(`**Working Directory:** ${parsed.cwd}\n**Model:** ${parsed.model}\n**Tools:** ${parsed.tools.length} available`)
      .setColor(0x00FF00); // Green for init
    
    try {
      await channel.send({ embeds: [initEmbed] });
    } catch (error) {
      console.error("Error sending init message:", error);
    }
  }

  private async handleAssistantMessage(
    channelId: string,
    parsed: SDKMessage & { type: "assistant" }
  ): Promise<void> {
    const channel = this.channelMessages.get(channelId)?.channel;
    if (!channel) return;

    const content = Array.isArray(parsed.message.content)
      ? parsed.message.content.find((c: any) => c.type === "text")?.text || ""
      : parsed.message.content;

    // Check for tool use in the message
    const toolUses = Array.isArray(parsed.message.content)
      ? parsed.message.content.filter((c: any) => c.type === "tool_use")
      : [];

    const toolCalls = this.channelToolCalls.get(channelId) || new Map();

    try {
      // If there's text content, send an assistant message
      if (content && content.trim()) {
        // Discord embed description limit is 4096 characters
        // Split long messages into multiple embeds
        const MAX_EMBED_LENGTH = 4000; // Leave some margin

        if (content.length <= MAX_EMBED_LENGTH) {
          const assistantEmbed = new EmbedBuilder()
            .setTitle("💬 Claude")
            .setDescription(content)
            .setColor(0x7289DA); // Discord blurple

          await channel.send({ embeds: [assistantEmbed] });
        } else {
          // Split into multiple messages
          const chunks: string[] = [];
          let remaining = content;

          while (remaining.length > 0) {
            if (remaining.length <= MAX_EMBED_LENGTH) {
              chunks.push(remaining);
              break;
            }

            // Try to split at a paragraph or sentence boundary
            let splitIndex = remaining.lastIndexOf('\n\n', MAX_EMBED_LENGTH);
            if (splitIndex === -1 || splitIndex < MAX_EMBED_LENGTH / 2) {
              splitIndex = remaining.lastIndexOf('\n', MAX_EMBED_LENGTH);
            }
            if (splitIndex === -1 || splitIndex < MAX_EMBED_LENGTH / 2) {
              splitIndex = remaining.lastIndexOf('. ', MAX_EMBED_LENGTH);
              if (splitIndex !== -1) splitIndex += 1; // Include the period
            }
            if (splitIndex === -1 || splitIndex < MAX_EMBED_LENGTH / 2) {
              splitIndex = MAX_EMBED_LENGTH;
            }

            chunks.push(remaining.substring(0, splitIndex));
            remaining = remaining.substring(splitIndex).trim();
          }

          // Send first chunk with title
          const firstEmbed = new EmbedBuilder()
            .setTitle("💬 Claude")
            .setDescription(chunks[0])
            .setColor(0x7289DA);
          await channel.send({ embeds: [firstEmbed] });

          // Send remaining chunks without title
          for (let i = 1; i < chunks.length; i++) {
            const continueEmbed = new EmbedBuilder()
              .setDescription(chunks[i])
              .setColor(0x7289DA)
              .setFooter({ text: `(continued ${i + 1}/${chunks.length})` });
            await channel.send({ embeds: [continueEmbed] });
          }
        }
      }
      
      // If there are tool uses, send a message for each tool
      for (const tool of toolUses) {
        // Special handling for AskUserQuestion - show Discord buttons and respond via stdin
        if (tool.name === "AskUserQuestion") {
          await this.handleAskUserQuestion(channelId, tool, channel);
          continue;
        }

        // Special handling for ExitPlanMode - show approval buttons
        if (tool.name === "ExitPlanMode") {
          await this.handleExitPlanMode(channelId, tool, channel);
          continue;
        }

        const toolMessage = this.formatToolCall(tool, channelId);

        const toolEmbed = new EmbedBuilder()
          .setDescription(`⏳ ${toolMessage}`)
          .setColor(0x0099FF); // Blue for tool calls

        const sentMessage = await channel.send({ embeds: [toolEmbed] });

        // Track this tool call message for later updating
        toolCalls.set(tool.id, {
          message: sentMessage,
          toolId: tool.id
        });
      }

      const channelName = this.channelNames.get(channelId) || "default";
      this.db.setSession(channelId, parsed.session_id, channelName);
      this.channelToolCalls.set(channelId, toolCalls);
    } catch (error) {
      console.error("Error sending assistant message:", error);
    }
  }

  private async handleToolResultMessage(channelId: string, parsed: any): Promise<void> {
    const toolResults = Array.isArray(parsed.message.content)
      ? parsed.message.content.filter((c: any) => c.type === "tool_result")
      : [];

    if (toolResults.length === 0) return;

    const toolCalls = this.channelToolCalls.get(channelId) || new Map();

    for (const result of toolResults) {
      const toolCall = toolCalls.get(result.tool_use_id);
      if (toolCall && toolCall.message) {
        try {
          // Get the first line of the result
          const firstLine = result.content.split('\n')[0].trim();
          const resultText = firstLine.length > 100 
            ? firstLine.substring(0, 100) + "..."
            : firstLine;
          
          // Get the current embed and update it
          const currentEmbed = toolCall.message.embeds[0];
          const originalDescription = currentEmbed.data.description.replace("⏳", "✅");
          const isError = result.is_error === true;
          
          const updatedEmbed = new EmbedBuilder();
          
          if (isError) {
            updatedEmbed
              .setDescription(`❌ ${originalDescription.substring(2)}\n*${resultText}*`)
              .setColor(0xFF0000); // Red for errors
          } else {
            updatedEmbed
              .setDescription(`${originalDescription}\n*${resultText}*`)
              .setColor(0x00FF00); // Green for completed
          }

          await toolCall.message.edit({ embeds: [updatedEmbed] });
        } catch (error) {
          console.error("Error updating tool result message:", error);
        }
      }
    }
  }

  private async handleResultMessage(
    channelId: string,
    parsed: SDKMessage & { type: "result" }
  ): Promise<void> {
    console.log("Result message:", parsed);
    const channelName = this.channelNames.get(channelId) || "default";
    this.db.setSession(channelId, parsed.session_id, channelName);

    const channel = this.channelMessages.get(channelId)?.channel;
    if (!channel) return;

    // Create a final result embed
    const resultEmbed = new EmbedBuilder();

    // Format cost display
    const cost = parsed.total_cost_usd;
    const costStr = cost < 0.01
      ? `${(cost * 100).toFixed(2)}¢`
      : `$${cost.toFixed(2)}`;

    if (parsed.subtype === "success") {
      const mode = this.getMode(channelId);
      const resultText = "result" in parsed && parsed.result ? String(parsed.result) : "";

      let description = `*${parsed.num_turns} turns · ${costStr}*`;

      // Only show result content in plan mode (to show the plan)
      // In auto mode, the result duplicates the last message which was already shown
      if (mode === "plan" && resultText.length > 50) {
        // Truncate long results for Discord (max 4096 chars for embed description)
        const truncatedResult = resultText.length > 3800
          ? resultText.substring(0, 3800) + "\n\n*... (truncated)*"
          : resultText;
        description = truncatedResult + `\n\n*${parsed.num_turns} turns · ${costStr}*`;
      }

      resultEmbed
        .setTitle("✅ Session Complete")
        .setDescription(description)
        .setColor(0x00FF00); // Green for success
    } else {
      resultEmbed
        .setTitle("❌ Session Failed")
        .setDescription(`Task failed: ${parsed.subtype}\n*${parsed.num_turns} turns · ${costStr}*`)
        .setColor(0xFF0000); // Red for failure
    }

    try {
      await channel.send({ embeds: [resultEmbed] });
    } catch (error) {
      console.error("Error sending result message:", error);
    }

    console.log("Got result message, cleaning up process tracking");
  }

  /**
   * Handle AskUserQuestion tool call by showing Discord buttons and sending response via stdin
   */
  private async handleAskUserQuestion(
    channelId: string,
    tool: { id: string; name: string; input: any },
    channel: any
  ): Promise<void> {
    const questions = tool.input?.questions || [];
    if (questions.length === 0) {
      console.log("AskUserQuestion called with no questions");
      this.sendToolResponse(channelId, tool.id, { answers: {} });
      return;
    }

    const answers: Record<string, string> = {};

    // Process each question (typically just one at a time)
    for (const q of questions) {
      const embed = new EmbedBuilder()
        .setTitle(`❓ ${q.header || "Question"}`)
        .setDescription(q.question)
        .setColor(0x5865F2); // Discord blurple

      // Add option descriptions if available
      const optionDescriptions = q.options
        .filter((o: any) => o.description)
        .map((o: any) => `**${o.label}**: ${o.description}`)
        .join("\n");

      if (optionDescriptions) {
        embed.addFields({ name: "Options", value: optionDescriptions });
      }

      // Build buttons (max 5 per row)
      const rows: ActionRowBuilder<ButtonBuilder>[] = [];
      let currentRow = new ActionRowBuilder<ButtonBuilder>();

      q.options.forEach((option: any, index: number) => {
        const button = new ButtonBuilder()
          .setCustomId(`ask_q_${index}`)
          .setLabel(option.label.substring(0, 80))
          .setStyle(ButtonStyle.Primary);

        currentRow.addComponents(button);

        if (currentRow.components.length === 5) {
          rows.push(currentRow);
          currentRow = new ActionRowBuilder<ButtonBuilder>();
        }
      });

      // Add "Other" button for custom input
      const otherButton = new ButtonBuilder()
        .setCustomId("ask_q_other")
        .setLabel("Other...")
        .setStyle(ButtonStyle.Secondary);
      currentRow.addComponents(otherButton);

      if (currentRow.components.length > 0) {
        rows.push(currentRow);
      }

      // Send the question
      const message = await channel.send({ embeds: [embed], components: rows });

      // Wait for button interaction (60 second timeout)
      try {
        const interaction = await message.awaitMessageComponent({
          componentType: ComponentType.Button,
          time: 60000,
        });

        if (interaction.customId === "ask_q_other") {
          // User wants to provide custom input
          await interaction.reply({
            content: "Please type your response:",
            ephemeral: true,
          });

          const collected = await channel.awaitMessages({
            filter: (m: any) => m.author.id === interaction.user.id,
            max: 1,
            time: 60000,
          });

          const userResponse = collected.first()?.content || "No response";
          answers[q.question] = userResponse;

          // Update the message
          const responseEmbed = new EmbedBuilder()
            .setTitle(`✅ ${q.header || "Question"}`)
            .setDescription(`${q.question}\n\n**Your answer:** ${userResponse}`)
            .setColor(0x00FF00);

          await message.edit({ embeds: [responseEmbed], components: [] });
        } else {
          // User selected an option
          const optionIndex = parseInt(interaction.customId.replace("ask_q_", ""));
          const selectedOption = q.options[optionIndex];

          answers[q.question] = selectedOption.label;
          await interaction.deferUpdate();

          // Update the message
          const responseEmbed = new EmbedBuilder()
            .setTitle(`✅ ${q.header || "Question"}`)
            .setDescription(`${q.question}\n\n**Your answer:** ${selectedOption.label}`)
            .setColor(0x00FF00);

          await message.edit({ embeds: [responseEmbed], components: [] });
        }
      } catch (error) {
        // Timeout - use default or empty response
        answers[q.question] = "No response (timed out)";

        const timeoutEmbed = new EmbedBuilder()
          .setTitle(`⏰ ${q.header || "Question"}`)
          .setDescription(`${q.question}\n\n*Timed out - no response*`)
          .setColor(0xFFD700);

        await message.edit({ embeds: [timeoutEmbed], components: [] });
      }
    }

    // Send the response back to Claude Code via stdin
    this.sendToolResponse(channelId, tool.id, { answers });
  }

  /**
   * Handle ExitPlanMode tool call by showing approval buttons
   */
  private async handleExitPlanMode(
    channelId: string,
    tool: { id: string; name: string; input: any },
    channel: any
  ): Promise<void> {
    const embed = new EmbedBuilder()
      .setTitle("📋 Plan Ready for Review")
      .setDescription(
        "Claude has finished creating a plan and is waiting for your approval.\n\n" +
        "**Approve** - Accept the plan and let Claude implement it\n" +
        "**Reject** - Reject the plan and provide feedback"
      )
      .setColor(0x5865F2); // Discord blurple

    const row = new ActionRowBuilder<ButtonBuilder>()
      .addComponents(
        new ButtonBuilder()
          .setCustomId("plan_approve")
          .setLabel("✅ Approve Plan")
          .setStyle(ButtonStyle.Success),
        new ButtonBuilder()
          .setCustomId("plan_reject")
          .setLabel("❌ Reject Plan")
          .setStyle(ButtonStyle.Danger)
      );

    const message = await channel.send({ embeds: [embed], components: [row] });

    try {
      const interaction = await message.awaitMessageComponent({
        componentType: ComponentType.Button,
        time: 300000, // 5 minute timeout for plan review
      });

      if (interaction.customId === "plan_approve") {
        await interaction.deferUpdate();

        const approvedEmbed = new EmbedBuilder()
          .setTitle("✅ Plan Approved")
          .setDescription("Proceeding with implementation...")
          .setColor(0x00FF00);

        await message.edit({ embeds: [approvedEmbed], components: [] });

        // Send approval response - empty object signals approval
        this.sendToolResponse(channelId, tool.id, {});
      } else {
        // User rejected - ask for feedback
        await interaction.reply({
          content: "Please provide feedback on what should be changed:",
          ephemeral: true,
        });

        const collected = await channel.awaitMessages({
          filter: (m: any) => m.author.id === interaction.user.id,
          max: 1,
          time: 120000, // 2 minutes to provide feedback
        });

        const feedback = collected.first()?.content || "Plan rejected without feedback";

        const rejectedEmbed = new EmbedBuilder()
          .setTitle("❌ Plan Rejected")
          .setDescription(`**Feedback:** ${feedback}`)
          .setColor(0xFF0000);

        await message.edit({ embeds: [rejectedEmbed], components: [] });

        // Send rejection response with feedback
        // The tool result content will be passed back to Claude
        this.sendToolResponse(channelId, tool.id, {
          rejected: true,
          feedback: feedback
        });
      }
    } catch (error) {
      // Timeout
      const timeoutEmbed = new EmbedBuilder()
        .setTitle("⏰ Plan Review Timed Out")
        .setDescription("No response received. Defaulting to reject.")
        .setColor(0xFFD700);

      await message.edit({ embeds: [timeoutEmbed], components: [] });

      this.sendToolResponse(channelId, tool.id, {
        rejected: true,
        feedback: "Review timed out - no response from user"
      });
    }
  }

  /**
   * Send a tool response back to Claude Code via stdin
   */
  private sendToolResponse(channelId: string, toolUseId: string, result: any): void {
    const channelProcess = this.channelProcesses.get(channelId);
    if (!channelProcess?.process?.stdin) {
      console.error("Cannot send tool response: no process stdin available");
      return;
    }

    // Format the response as stream-json expects
    const response = {
      type: "user",
      message: {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: toolUseId,
            content: JSON.stringify(result),
            is_error: false,
          },
        ],
      },
    };

    const jsonLine = JSON.stringify(response) + "\n";
    console.log("Sending tool response to stdin:", jsonLine);

    channelProcess.process.stdin.write(jsonLine);
  }

  // Clean up resources
  destroy(): void {
    // Close all active processes
    for (const [channelId] of this.channelProcesses) {
      this.killActiveProcess(channelId);
    }
    
    // Close database connection
    this.db.close();
  }
}
