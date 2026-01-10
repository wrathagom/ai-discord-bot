import { spawn } from "child_process";
import * as path from "path";
import * as fs from "fs";
import { EmbedBuilder } from "discord.js";
import type { SDKMessage } from "../types/index.js";
import { buildClaudeCommand, type DiscordContext } from "../utils/shell.js";
import { DatabaseManager, type PermissionMode, type ClaudeModel } from "../db/database.js";

export class ClaudeManager {
  private db: DatabaseManager;
  private channelMessages = new Map<string, any>();
  private channelToolCalls = new Map<string, Map<string, { message: any, toolId: string }>>();
  private channelNames = new Map<string, string>();
  private channelProcesses = new Map<
    string,
    {
      process: any;
      sessionId?: string;
      discordMessage: any;
    }
  >();

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
    // Store the channel name for path replacement
    this.channelNames.set(channelId, channelName);
    const workingDir = path.join(this.baseFolder, channelName);
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

    // Close stdin to signal we're done sending input
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
        const assistantEmbed = new EmbedBuilder()
          .setTitle("💬 Claude")
          .setDescription(content)
          .setColor(0x7289DA); // Discord blurple
        
        await channel.send({ embeds: [assistantEmbed] });
      }
      
      // If there are tool uses, send a message for each tool
      for (const tool of toolUses) {
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
