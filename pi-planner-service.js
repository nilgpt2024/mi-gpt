/**
 * 轻量级任务规划服务 - 基于 OpenAI Function Calling
 *
 * 功能：
 * 1. 通过自然语言对话管理小爱音箱定时任务
 * 2. 支持 OpenAI function calling 调用工具
 * 3. 流式响应支持（SSE）
 * 4. 多会话管理
 *
 * 优势：
 * - ✅ 无需额外依赖（使用已有的 openai 包）
 * - ✅ 稳定可靠
 * - ✅ 完全控制
 * - ✅ 支持流式输出
 */

import OpenAI from "openai";
import { taskTools } from "./pi-task-tools.js";
import fs from "fs-extra";
import path from "path";
import { fileURLToPath } from "url";
import dotenv from "dotenv";

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const SCHEDULES_FILE = path.join(__dirname, ".schedules.json");

// ==================== 配置 ====================
const DEFAULT_CONFIG = {
  model: process.env.PI_MODEL || "gpt-4o-mini",
  temperature: 0.7,
  maxTokens: 2000,
  
  systemPrompt: `你是一个专业的小爱音箱定时任务规划助手。你的主要职责是帮助用户通过自然语言管理小爱音箱的定时播报任务。

## ⚠️ 最重要：必须使用工具！

你有以下工具可以使用：
- list_tasks: 列出所有定时任务
- add_task: 添加新的定时任务
- update_task: 更新现有任务
- delete_task: 删除任务
- generate_warm_text: 生成温馨提示语
- daily_planning: 智能每日规划（核心功能！会分析并自动创建任务）
- batch_update_tasks: 批量更新任务

**规则：当用户需要操作任务时，你必须调用相应的工具函数，绝对不能直接用文字回复说"无法创建"或"需要手动设置"！**

## 核心能力

1. **智能任务管理（必须使用 add_task 工具）**
   - 用户可以用自然语言描述时间和内容，你负责调用 add_task 工具创建任务
   - 例如："每天早上7点半叫孩子们起床" → 调用 add_task 工具
   - 支持：每天/工作日/周末、具体时间、间隔时间等

2. **AI 每日智能规划（必须使用 daily_planning 工具！）**
   - 当用户说"帮我规划明天的任务"、"制定今日计划"等，你必须调用 daily_planning 工具
   - daily_planning 工具会：
     - 分析日期是工作日还是周末
     - 根据天气（如果提供）调整活动建议
     - 考虑特殊事件（生日、节日等）
     - **自动为你创建合适的任务！**
   - 调用 daily_planning 后，根据返回的建议，立即调用 add_task 创建实际任务
   - 重要：不要只是返回建议，要真正去创建任务！

3. **温馨提示语生成（使用 generate_warm_text 工具）**
   - 根据场景（起床、吃饭、睡觉等）生成适合的提示语
   - 为孩子设计的温馨、有趣的内容

4. **批量操作支持（使用 batch_update_tasks 工具）**
   - 季节性调整、批量修改文案等

## 工作流程（严格遵守）

1. 理解用户需求
2. **立即调用相应工具**（不要犹豫，不要问用户是否确定）
3. 根据工具返回结果向用户确认
4. 提供后续建议

## 文案风格要求

- 温馨亲切，像家人在说话
- 口语化，适合语音播报
- 控制长度（一般50-100字为宜）

## 示例对话

用户："提醒大家喝水"
→ 你应该：调用 add_task 工具创建喝水提醒任务
→ 不应该说："我无法创建任务" 或 "请手动设置"

用户："列出所有任务"
→ 你应该：调用 list_tasks 工具获取任务列表
→ 返回任务列表给用户`,
};

// ==================== 主类 ====================
export class TaskPlannerService {
  constructor(config = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.sessions = new Map();
    this.openai = null;
    this.isInitialized = false;
  }

  /**
   * 初始化服务
   */
  async initialize(apiKey = null, baseURL = null) {
    if (this.isInitialized) return this;

    const key = apiKey || process.env.OPENAI_API_KEY;
    if (!key || key === "your-api-key-here") {
      throw new Error("OpenAI API Key 未配置。请在 .env 文件中设置 OPENAI_API_KEY");
    }

    try {
      console.log("🚀 正在初始化任务规划服务...");

      this.openai = new OpenAI({
        apiKey: key,
        baseURL: baseURL || process.env.OPENAI_BASE_URL || undefined,
      });

      this.isInitialized = true;
      console.log("✅ 任务规划服务已就绪");
      
      return this;
    } catch (error) {
      console.error("❌ 任务规划服务初始化失败:", error.message);
      throw error;
    }
  }

  /**
   * 创建新的会话
   */
  createSession(sessionId = null) {
    const id = sessionId || this.generateSessionId();
    
    // 如果会话已存在，先销毁
    if (this.sessions.has(id)) {
      this.destroySession(id);
    }

    const sessionData = {
      id,
      messages: [
        {
          role: "system",
          content: this.config.systemPrompt,
        },
      ],
      createdAt: new Date(),
      lastActivity: new Date(),
      messageCount: 0,
    };

    this.sessions.set(id, sessionData);
    console.log(`✅ 会话已创建: ${id}`);

    return {
      success: true,
      sessionId: id,
      message: "会话创建成功",
    };
  }

  /**
   * 发送消息并获取流式响应
   */
  async chat(sessionId, message, onChunk = null) {
    let sessionData = this.sessions.get(sessionId);

    if (!sessionData) {
      // 自动创建新会话
      const result = this.createSession(sessionId);
      sessionData = this.sessions.get(result.sessionId);
      sessionId = result.sessionId;
    }

    sessionData.lastActivity = new Date();
    sessionData.messageCount++;

    // 添加用户消息
    sessionData.messages.push({
      role: "user",
      content: message,
    });

    return new Promise(async (resolve, reject) => {
      let fullResponse = "";
      let toolCalls = [];

      try {
        // 转换工具格式为 OpenAI function calling 格式
        const functions = taskTools.map((tool) => ({
          type: "function",
          function: {
            name: tool.name,
            description: tool.description,
            parameters: tool.parameters,
          },
        }));

        // 创建流式请求
        const stream = await this.openai.chat.completions.create({
          model: this.config.model,
          messages: sessionData.messages,
          functions: functions,
          function_call: "auto",
          temperature: this.config.temperature,
          max_tokens: this.config.maxTokens,
          stream: true,
        });

        // 处理流式响应
        (async () => {
          try {
            for await (const chunk of stream) {
              const delta = chunk.choices[0]?.delta;

              // 文本内容
              if (delta?.content) {
                fullResponse += delta.content;

                if (onChunk) {
                  onChunk({
                    type: "chunk",
                    content: delta.content,
                    timestamp: Date.now(),
                  });
                }
              }

              // 函数调用
              if (delta?.function_call) {
                if (!toolCalls[delta.function_call.index]) {
                  toolCalls[delta.function_call.index] = {
                    id: delta.function_call.id,
                    name: delta.function_call.name,
                    arguments: "",
                  };
                }
                toolCalls[delta.function_call.index].arguments +=
                  delta.function_call.arguments || "";
              }

              // 完成
              if (chunk.choices[0]?.finish_reason === "stop") {
                if (onChunk) {
                  onChunk({
                    type: "done",
                    content: fullResponse,
                    timestamp: Date.now(),
                  });
                }

                // 添加助手回复到历史
                sessionData.messages.push({
                  role: "assistant",
                  content: fullResponse,
                });

                resolve({
                  success: true,
                  response: fullResponse,
                  sessionId,
                  messageCount: sessionData.messageCount,
                });
              }

              // 需要调用函数
              if (chunk.choices[0]?.finish_reason === "function_call") {
                // 处理所有函数调用
                for (const toolCall of toolCalls) {
                  await this.handleFunctionCall(
                    sessionData,
                    toolCall,
                    onChunk
                  );
                }

                // 继续获取最终响应
                await this.getFinalResponse(sessionData, onChunk, resolve);
              }
            }
          } catch (error) {
            if (onChunk) {
              onChunk({
                type: "error",
                content: error.message,
                timestamp: Date.now(),
              });
            }
            reject(error);
          }
        })().catch(reject); // 确保内部 IIFE 的异常不会丢失
      } catch (error) {
        reject(error);
      }

      // 超时处理
      setTimeout(() => {
        if (fullResponse && !fullResponse.includes("[DONE]")) {
          if (onChunk) {
            onChunk({
              type: "timeout",
              content: fullResponse || "响应超时",
              timestamp: Date.now(),
            });
          }

          resolve({
            success: true,
            response: fullResponse || "(响应超时)",
            sessionId,
            timeout: true,
          });
        }
      }, 60000); // 60秒超时
    });
  }

  /**
   * 处理函数调用
   */
  async handleFunctionCall(sessionData, toolCall, onChunk) {
    const { name, arguments: argsString } = toolCall;

    // 发送状态信息
    if (onChunk) {
      onChunk({
        type: "tool_start",
        content: `🔧 正在调用工具: ${name}`,
        timestamp: Date.now(),
      });
    }

    try {
      // 解析参数
      let args = {};
      try {
        args = JSON.parse(argsString);
      } catch (e) {
        args = {};
      }

      // 查找并执行工具
      const tool = taskTools.find((t) => t.name === name);
      if (!tool) {
        throw new Error(`未知工具: ${name}`);
      }

      // 执行工具函数
      const result = await tool.function(args);

      // 发送工具结果
      if (onChunk) {
        onChunk({
          type: "tool_result",
          content: `✅ ${name} 执行完成`,
          data: result,
          timestamp: Date.now(),
        });
      }

      // 将函数调用和结果添加到消息历史
      sessionData.messages.push({
        role: "assistant",
        content: null,
        function_call: {
          id: toolCall.id,
          name: name,
          arguments: argsString,
        },
      });

      sessionData.messages.push({
        role: "function",
        name: name,
        content: JSON.stringify(result),
      });

      // 发送工具调用完成事件（供 chatSimple 收集）
      if (onChunk) {
        onChunk({
          type: "tool_call",
          name: name,
          arguments: argsString,
          id: toolCall.id,
          data: result,
          timestamp: Date.now(),
        });
      }
    } catch (error) {
      console.error(`工具执行失败 (${name}):`, error);

      // 发送错误信息
      if (onChunk) {
        onChunk({
          type: "tool_error",
          content: `❌ ${name} 执行失败: ${error.message}`,
          timestamp: Date.now(),
        });
      }

      // 添加错误结果到消息历史
      sessionData.messages.push({
        role: "assistant",
        content: null,
        function_call: {
          id: toolCall.id,
          name: name,
          arguments: argsString,
        },
      });

      sessionData.messages.push({
        role: "function",
        name: name,
        content: JSON.stringify({ error: error.message }),
      });
    }
  }

  /**
   * 获取最终响应（工具调用后）
   */
  async getFinalResponse(sessionData, onChunk, resolve) {
    let finalResponse = "";

    try {
      const stream = await this.openai.chat.completions.create({
        model: this.config.model,
        messages: sessionData.messages,
        temperature: this.config.temperature,
        max_tokens: this.config.maxTokens,
        stream: true,
      });

      for await (const chunk of stream) {
        const delta = chunk.choices[0]?.delta;

        if (delta?.content) {
          finalResponse += delta.content;

          if (onChunk) {
            onChunk({
              type: "chunk",
              content: delta.content,
              timestamp: Date.now(),
            });
          }
        }

        if (chunk.choices[0]?.finish_reason === "stop") {
          if (onChunk) {
            onChunk({
              type: "done",
              content: finalResponse,
              timestamp: Date.now(),
            });
          }

          // 添加最终回复到历史
          sessionData.messages.push({
            role: "assistant",
            content: finalResponse,
          });

          resolve({
            success: true,
            response: finalResponse,
            sessionId: sessionData.id,
            messageCount: sessionData.messageCount,
          });
        }
      }
    } catch (error) {
      if (onChunk) {
        onChunk({
          type: "error",
          content: error.message,
          timestamp: Date.now(),
        });
      }

      resolve({
        success: true,
        response: finalResponse || "(处理完成)",
        sessionId: sessionData.id,
      });
    }
  }

  /**
   * 快速聊天（非流式）
   */
  async chatSimple(sessionId, message) {
    let response = "";
    const toolCalls = [];
    const toolResults = [];

    await this.chat(sessionId, message, (chunk) => {
      if (chunk.type === "chunk") {
        response += chunk.content;
      } else if (chunk.type === "tool_call") {
        toolCalls.push({
          name: chunk.name,
          arguments: chunk.arguments,
          id: chunk.id,
        });
        console.log(`🔧 工具调用: ${chunk.name}`);
      } else if (chunk.type === "tool_result") {
        toolResults.push({
          name: chunk.name || "unknown",
          data: chunk.data,
        });
        console.log(`✅ 工具执行完成: ${chunk.name || "unknown"}`);
      }
    });

    return {
      success: true,
      response,
      sessionId,
      toolCalls,
      toolResults,
      hasToolCalls: toolCalls.length > 0,
    };
  }

  /**
   * 销毁指定会话
   */
  destroySession(sessionId) {
    if (this.sessions.has(sessionId)) {
      this.sessions.delete(sessionId);
      console.log(`🗑️ 会话已销毁: ${sessionId}`);
    }

    return { success: true, sessionId };
  }

  /**
   * 获取会话状态
   */
  getSessionStatus(sessionId) {
    const sessionData = this.sessions.get(sessionId);

    if (!sessionData) {
      return { exists: false, sessionId };
    }

    return {
      exists: true,
      sessionId,
      createdAt: sessionData.createdAt,
      lastActivity: sessionData.lastActivity,
      messageCount: sessionData.messageCount,
      age: Date.now() - sessionData.createdAt.getTime(),
    };
  }

  /**
   * 列出所有活跃会话
   */
  listSessions() {
    const sessions = [];
    for (const [id, data] of this.sessions.entries()) {
      sessions.push(this.getSessionStatus(id));
    }
    return { total: sessions.length, sessions };
  }

  /**
   * 清理过期会话
   */
  cleanupExpiredSessions(maxAge = 3600000) {
    const now = Date.now();
    const expiredIds = [];

    for (const [id, data] of this.sessions.entries()) {
      if (now - data.lastActivity.getTime() > maxAge) {
        expiredIds.push(id);
      }
    }

    expiredIds.forEach((id) => this.destroySession(id));

    if (expiredIds.length > 0) {
      console.log(`🧹 已清理 ${expiredIds.length} 个过期会话`);
    }

    return { cleaned: expiredIds.length, expiredIds };
  }

  /**
   * 生成会话 ID
   */
  generateSessionId() {
    return `planner-${Date.now().toString(36)}-${Math.random().toString(36).substr(2, 8)}`;
  }

  /**
   * 停止服务
   */
  shutdown() {
    console.log("🛑 正在关闭任务规划服务...");
    for (const [id] of this.sessions.entries()) {
      this.destroySession(id);
    }
    this.isInitialized = false;
    console.log("✅ 任务规划服务已关闭");
  }
}

// ==================== 单例模式 ====================
let instance = null;

/**
 * 获取 TaskPlannerService 单例
 */
export async function getTaskPlannerService(config = {}) {
  if (!instance) {
    instance = new TaskPlannerService(config);
    await instance.initialize(config.apiKey, config.baseURL);
  }
  return instance;
}

// ==================== 导出工具函数 ====================

/**
 * 获取可用的工具列表
 */
export function getAvailableTools() {
  return taskTools.map((tool) => ({
    name: tool.name,
    description: tool.description,
    parameters: tool.parameters,
  }));
}
