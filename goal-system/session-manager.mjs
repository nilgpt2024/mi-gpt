/**
 * 会话管理器 (SessionManager)
 *
 * 职责：管理 LLM 会话的生命周期
 * 支持 Claude Code / Cursor 风格的 API
 * - 创建会话 (POST /session)
 * - 发送消息 (POST /session/:id/message)
 * - 会话历史记录
 * 
 * 支持三种 LLM 调用模式：
 * 1. 直接调用模式：直接使用 OpenAI SDK 调用 LLM
 * 2. OpenCode 代理模式：转发请求到外部 OpenCode 服务 (如 localhost:4096)
 * 3. 模拟模式：当 LLM 不可用时返回模拟响应
 */

import fs from "fs-extra";
import path from "path";
import { fileURLToPath } from "url";
import crypto from "crypto";
import http from "http";
import https from "https";
import { execFile, spawn } from "child_process";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const SESSIONS_FILE = path.join(__dirname, "..", ".sessions.json");

export class SessionManager {
  constructor(options = {}) {
    this.openaiClient = options.openaiClient || null;
    this.sessionsFile = options.sessionsFile || SESSIONS_FILE;
    this.maxHistoryPerSession = options.maxHistoryPerSession || 100;
    this.defaultModel = options.defaultModel || "gpt-4o-mini";
    this.maxTokens = options.maxTokens || 4096;
    this.temperature = options.temperature || 0.7;

    // 模拟模式（当 LLM 服务不可用时自动启用）
    this.mockMode = options.mockMode || false;

    // OpenCode 代理模式（转发到外部 OpenCode 服务）
    this.opencodeUrl = options.opencodeUrl || null;  // 如 "http://localhost:4096"
    this.opencodeTimeout = options.opencodeTimeout || 300000;  // 默认5分钟超时（LLM 可能需要较长时间）
    
    // 原生 HTTP 模块（用于正确读取 Hono streaming 响应）
    this._httpModule = http;
    this._httpsModule = https;
  }

  /**
   * 启用/禁用模拟模式
   */
  setMockMode(enabled) {
    this.mockMode = enabled;
    console.log(`🎭 [SessionManager] 模拟模式: ${enabled ? '已启用' : '已禁用'}`);
  }

  /**
   * 设置 OpenCode 代理 URL
   */
  setOpencodeUrl(url) {
    this.opencodeUrl = url;
    if (url) {
      console.log(`🔗 [SessionManager] OpenCode 代理模式: ${url}`);
    }
  }

  async init() {
    try {
      await this._ensureFileExists();
      console.log("✅ [SessionManager] 初始化完成");
      
      if (this.opencodeUrl) {
        console.log(`🔗 [SessionManager] 使用 OpenCode 代理: ${this.opencodeUrl}`);
      } else if (this.openaiClient) {
        console.log(`🤖 [SessionManager] 使用直接调用模式 (OpenAI SDK)`);
      } else {
        console.log(`🎭 [SessionManager] 使用模拟模式`);
      }
      
      return this;
    } catch (error) {
      console.error("❌ [SessionManager] 初始化失败:", error.message);
      throw error;
    }
  }

  setOpenAIClient(client) {
    this.openaiClient = client;
  }

  /**
   * 创建新会话
   * @param {Object} options - 会话选项
   * @param {string} options.directory - 工作目录（可选）
   * @param {string} options.systemPrompt - 系统提示词（可选）
   * @param {string} options.model - 模型名称（可选）
   * @returns {Promise<Object>} 会话对象
   */
  async createSession(options = {}) {
    const session = {
      id: this._generateId(),
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      directory: options.directory || process.cwd(),
      model: options.model || this.defaultModel,
      systemPrompt: options.systemPrompt || null,
      messages: [],
      metadata: {
        messageCount: 0,
        totalTokens: 0,
        lastActivity: new Date().toISOString()
      }
    };

    const sessions = await this._loadSessions();
    sessions.push(session);
    await this._saveSessions(sessions);

    console.log(`💬 [SessionManager] 创建会话: ${session.id}`);
    return session;
  }

  /**
   * 获取会话
   */
  async getSession(sessionId) {
    const sessions = await this._loadSessions();
    return sessions.find(s => s.id === sessionId) || null;
  }

  /**
   * 获取所有会话
   */
  async getSessions(limit = 20) {
    const sessions = await this._loadSessions();

    return sessions
      .sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt))
      .slice(0, limit)
      .map(s => ({
        id: s.id,
        createdAt: s.createdAt,
        updatedAt: s.updatedAt,
        directory: s.directory,
        model: s.model,
        messageCount: s.messages?.length || 0,
        metadata: s.metadata
      }));
  }

  /**
   * 发送消息到会话（核心方法）
   * @param {string} sessionId - 会话ID
   * @param {Array} parts - 消息部分数组 [{type: "text", text: "..."}]
   * @param {Object} options - 选项
   * @returns {Promise<Object>} AI响应
   */
  async sendMessage(sessionId, parts, options = {}) {
    if (!this.openaiClient) {
      throw new Error("OpenAI 客户端未初始化，请检查配置");
    }

    const session = await this.getSession(sessionId);
    if (!session) {
      throw new Error(`会话不存在: ${sessionId}`);
    }

    // 解析消息内容
    const userMessage = this._parseParts(parts);

    if (!userMessage || !userMessage.trim()) {
      throw new Error("消息内容不能为空");
    }

    console.log(`\n${"=".repeat(60)}`);
    console.log(`💬 [SessionManager] 会话 ${sessionId.substring(0, 8)}... 收到消息`);
    console.log(`${"=".repeat(60)}`);
    console.log(`📝 用户: ${userMessage.substring(0, 100)}${userMessage.length > 100 ? '...' : ''}`);

    // 构建消息历史
    const messages = [];

    // 添加系统提示词
    if (session.systemPrompt) {
      messages.push({
        role: "system",
        content: session.systemPrompt
      });
    }

    // 添加历史消息
    if (session.messages && session.messages.length > 0) {
      for (const msg of session.messages.slice(-20)) {  // 只取最近20条
        messages.push({
          role: msg.role,
          content: msg.content
        });
      }
    }

    // 添加当前用户消息
    messages.push({
      role: "user",
      content: userMessage
    });

    // 调用 LLM（三种模式：OpenCode代理 > 直接调用 > 模拟）
    let aiResponse = "";
    let usage = {};
    let actualModel = options.model || session.model || this.defaultModel;

    try {
      const startTime = Date.now();

      // ========== 模式1: OpenCode 代理模式 ==========
      if (this.opencodeUrl && !this.mockMode) {
        console.log(`🔗 [SessionManager] 使用 OpenCode 代理模式 → ${this.opencodeUrl}`);
        
        try {
          const proxyResult = await this._forwardToOpencode(sessionId, parts, options);
          aiResponse = proxyResult.content;
          usage = proxyResult.usage || {};
          actualModel = proxyResult.model || actualModel;
          
          const duration = ((Date.now() - startTime) / 1000).toFixed(1);
          console.log(`🤖 [OpenCode] AI 响应: ${aiResponse.substring(0, 100)}${aiResponse.length > 100 ? '...' : ''}`);
          console.log(`⏱️ 耗时: ${duration}s | Tokens: 输入=${usage.prompt_tokens || '?'}, 输出=${usage.completion_tokens || '?'}`);
          
        } catch (proxyError) {
          console.error(`❌ [SessionManager] OpenCode 代理失败:`, proxyError.message);
          
          if (!this.openaiClient) {
            throw proxyError;
          }
          console.warn(`⚠️ [SessionManager] 回退到直接调用模式...`);
        }
      }

      // ========== 模式2: 直接调用 OpenAI SDK ==========
      if (!aiResponse && this.openaiClient && !this.mockMode) {
        console.log(`🤖 [SessionManager] 使用直接调用模式 (OpenAI SDK)`);

        const completion = await this.openaiClient.chat.completions.create({
          model: actualModel,
          messages: messages,
          temperature: options.temperature ?? this.temperature,
          max_tokens: options.maxTokens || this.maxTokens,
          stream: false
        });

        aiResponse = completion.choices[0]?.message?.content || "";
        usage = completion.usage || {};
        actualModel = completion.model || actualModel;
        const duration = ((Date.now() - startTime) / 1000).toFixed(1);

        console.log(`🤖 AI (${actualModel}): ${aiResponse.substring(0, 100)}${aiResponse.length > 100 ? '...' : ''}`);
        console.log(`⏱️ 耗时: ${duration}s | Tokens: 输入=${usage.prompt_tokens}, 输出=${usage.completion_tokens}`);
      }

      // ========== 模式3: 模拟模式 ==========
      if (!aiResponse || this.mockMode) {
        if (!aiResponse && !this.mockMode) console.warn(`⚠️ [SessionManager] 所有 LLM 模式失败，启用模拟模式...`);
        
        aiResponse = this._generateMockResponse(userMessage);
        usage = { prompt_tokens: userMessage.length, completion_tokens: aiResponse.length, total_tokens: userMessage.length + aiResponse.length };
        actualModel = "mock";
        const duration = ((Date.now() - startTime) / 1000).toFixed(1);
        console.log(`🤖 [Mock] AI 响应: ${aiResponse.substring(0, 100)}${aiResponse.length > 100 ? '...' : ''}`);
        console.log(`⏱️ 耗时: ${duration}s (模拟模式)`);
      }

    } catch (error) {
      console.error(`❌ [SessionManager] LLM 调用失败:`, error.message);

      if (error.code === 'ECONNREFUSED' || error.message?.includes('Connection') || error.message?.includes('ECONNREFUSED')) {
        console.warn(`⚠️ [SessionManager] LLM 服务不可达，启用模拟模式...`);
        aiResponse = this._generateMockResponse(userMessage);
        usage = { prompt_tokens: userMessage.length, completion_tokens: aiResponse.length, total_tokens: userMessage.length + aiResponse.length };
        actualModel = "mock-fallback";
        console.log(`🤖 [Fallback Mock] AI 响应: ${aiResponse.substring(0, 100)}`);
      } else {
        throw new Error(`AI 服务调用失败: ${error.message}`);
      }
    }

    // 保存消息到会话历史
    const sessions = await this._loadSessions();
    const sessionIndex = sessions.findIndex(s => s.id === sessionId);

    if (sessionIndex !== -1) {
      const sessionData = sessions[sessionIndex];

      if (!sessionData.messages) sessionData.messages = [];

      // 保存用户消息
      sessionData.messages.push({
        role: "user",
        content: userMessage,
        timestamp: new Date().toISOString(),
        parts: parts
      });

      // 保存AI响应
      sessionData.messages.push({
        role: "assistant",
        content: aiResponse,
        timestamp: new Date().toISOString(),
        model: options.model || session.model || this.defaultModel,
        usage: usage
      });

      // 更新元数据
      sessionData.metadata = {
        messageCount: sessionData.messages.length,
        totalTokens: (sessionData.metadata?.totalTokens || 0) + (usage.total_tokens || 0),
        lastActivity: new Date().toISOString()
      };
      sessionData.updatedAt = new Date().toISOString();

      sessions[sessionIndex] = sessionData;
      await this._saveSessions(sessions);
    }

    // 返回响应（兼容 Claude Code 格式）
    return {
      type: "message",
      role: "assistant",
      model: options.model || session.model || this.defaultModel,
      content: aiResponse,
      usage: {
        prompt_tokens: usage.prompt_tokens || 0,
        completion_tokens: usage.completion_tokens || 0,
        total_tokens: usage.total_tokens || 0
      },
      stopReason: "end_turn",
      sessionId: sessionId,
      timestamp: new Date().toISOString()
    };
  }

  /**
   * 获取会话历史
   */
  async getSessionHistory(sessionId, limit = 50) {
    const session = await this.getSession(sessionId);
    if (!session) throw new Error(`会话不存在: ${sessionId}`);

    const messages = (session.messages || []).slice(-limit);

    return {
      sessionId,
      totalMessages: session.messages?.length || 0,
      messages: messages.map(m => ({
        role: m.role,
        content: m.content,
        timestamp: m.timestamp,
        ...(m.usage ? { usage: m.usage } : {})
      }))
    };
  }

  // ==================== OpenCode 风格快捷方法 ====================

  /**
   * 快捷聊天方法（OpenCode 风格）
   * 
   * 供内部模块（GoalParser、DynamicAdjuster 等）调用
   * 自动管理会话生命周期，返回 AI 响应文本
   * 
   * @param {string|Object} input - 用户输入（字符串或 {text, systemPrompt, model} 对象）
   * @param {Object} options - 可选配置
   * @returns {Promise<string>} AI 响应文本
   * 
   * @example
   * // 简单调用
   * const reply = await sessionManager.chat("你好");
   * 
   * @example
   * // 带系统提示词
   * const reply = await sessionManager.chat({
   *   text: "帮我解析这个目标",
   *   systemPrompt: "你是一个目标解析器",
   *   model: "gpt-4o"
   * });
   */
  async chat(input, options = {}) {
    if (!this.openaiClient) {
      throw new Error("OpenAI 客户端未初始化");
    }

    let text = "";
    let systemPrompt = options.systemPrompt || null;
    let model = options.model || this.defaultModel;
    let sessionId = options.sessionId || null;
    let temperature = options.temperature ?? this.temperature;

    if (typeof input === "string") {
      text = input;
    } else if (typeof input === "object" && input !== null) {
      text = input.text || input.message || input.content || "";
      systemPrompt = input.systemPrompt || systemPrompt;
      model = input.model || model;
      sessionId = input.sessionId || sessionId;
      temperature = input.temperature ?? temperature;
    }

    if (!text || !text.trim()) {
      throw new Error("聊天内容不能为空");
    }

    let session;

    if (sessionId) {
      session = await this.getSession(sessionId);
      if (!session) {
        throw new Error(`会话不存在: ${sessionId}`);
      }
    } else {
      session = await this.createSession({
        systemPrompt,
        model,
        directory: options.directory || process.cwd()
      });
      sessionId = session.id;
    }

    const parts = [{ type: "text", text }];
    const response = await this.sendMessage(sessionId, parts, {
      model,
      temperature,
      maxTokens: options.maxTokens || this.maxTokens,
      systemPrompt
    });

    return {
      content: response.content,
      sessionId: response.sessionId,
      model: response.model,
      usage: response.usage,
      timestamp: response.timestamp,
      rawResponse: response.rawResponse
    };
  }

  /**
   * 快捷聊天（只返回文本，简化版）
   */
  async chatText(input, options = {}) {
    const result = await this.chat(input, options);
    return result.content;
  }

  /**
   * 流式聊天方法（SSE 支持）
   * 
   * 与 chat() 类似，但支持流式返回，通过 onChunk 回调实时推送数据块
   * 
   * @param {string|Object} input - 用户输入
   * @param {Object} options - 可选配置
   * @param {Function} options.onChunk - 流式数据回调 (chunk) => void
   * @returns {Promise<Object>} 完整响应（与 chat() 格式一致）
   */
  async chatStream(input, options = {}) {
    if (!this.openaiClient) {
      throw new Error("OpenAI 客户端未初始化");
    }

    const onChunk = options.onChunk || null;
    let text = "";
    let systemPrompt = options.systemPrompt || null;
    let model = options.model || this.defaultModel;

    if (typeof input === "string") {
      text = input;
    } else if (typeof input === "object" && input !== null) {
      text = input.text || input.message || input.content || "";
      systemPrompt = input.systemPrompt || systemPrompt;
      model = input.model || model;
    }

    if (!text || !text.trim()) {
      throw new Error("聊天内容不能为空");
    }

    const session = await this.createSession({
      systemPrompt,
      model,
      directory: options.directory || process.cwd()
    });

    const parts = [{ type: "text", text }];
    
    // 使用 sendMessage 的流式变体
    const response = await this._sendMessageStream(session.id, parts, {
      model,
      temperature: options.temperature ?? this.temperature,
      maxTokens: options.maxTokens || this.maxTokens,
      onChunk,
      systemPrompt
    });

    return response;
  }

  /**
   * 发送消息（流式版本）- 内部使用
   */
  async _sendMessageStream(sessionId, parts, options = {}) {
    const session = await this.getSession(sessionId);
    if (!session) {
      throw new Error(`会话不存在: ${sessionId}`);
    }

    const userMessage = this._parseParts(parts);
    if (!userMessage || !userMessage.trim()) {
      throw new Error("消息内容不能为空");
    }

    console.log(`\n${"=".repeat(60)}`);
    console.log(`💬 [SessionManager] 会话 ${sessionId.substring(0, 8)}... 收到消息 (流式)`);
    console.log(`${"=".repeat(60)}`);
    console.log(`📝 用户: ${userMessage.substring(0, 100)}${userMessage.length > 100 ? '...' : ''}`);

    const onChunk = options.onChunk || null;
    let aiResponse = "";
    let usage = {};
    let actualModel = options.model || session.model || this.defaultModel;

    try {
      const startTime = Date.now();

      // OpenCode 代理模式（流式）
      if (this.opencodeUrl && !this.mockMode) {
        console.log(`🔗 [SessionManager] 使用 OpenCode 代理流式模式 → ${this.opencodeUrl}`);
        
        try {
          const proxyResult = await this._forwardToOpencodeStream(sessionId, parts, options, onChunk);
          aiResponse = proxyResult.content;
          usage = proxyResult.usage || {};
          actualModel = proxyResult.model || actualModel;
          
          const duration = ((Date.now() - startTime) / 1000).toFixed(1);
          console.log(`🤖 [OpenCode-Stream] AI 响应: ${aiResponse.substring(0, 100)}${aiResponse.length > 100 ? '...' : ''}`);
          console.log(`⏱️ 耗时: ${duration}s`);
          
        } catch (proxyError) {
          console.error(`❌ [SessionManager] OpenCode 流式代理失败:`, proxyError.message);
          if (!this.openaiClient) throw proxyError;
          console.warn(`⚠️ [SessionManager] 回退到直接调用...`);
        }
      }

      // 直接调用或回退
      if (!aiResponse && this.openaiClient && !this.mockMode) {
        console.log(`🤖 [SessionManager] 使用直接调用模式 (OpenAI SDK)`);
        const completion = await this.openaiClient.chat.completions.create({
          model: actualModel,
          messages: [{ role: "user", content: userMessage }],
          temperature: options.temperature ?? this.temperature,
          max_tokens: options.maxTokens || this.maxTokens,
          stream: false
        });
        aiResponse = completion.choices[0]?.message?.content || "";
        usage = completion.usage || {};
        
        if (onChunk) {
          onChunk({ content: aiResponse, done: true });
        }
      }

      // 模拟模式
      if (!aiResponse || this.mockMode) {
        if (!aiResponse && !this.mockMode) console.warn(`⚠️ [SessionManager] 所有 LLM 模式失败，启用模拟模式...`);
        aiResponse = this._generateMockResponse(userMessage);
        usage = { prompt_tokens: userMessage.length, completion_tokens: aiResponse.length };
        actualModel = "mock";
        
        if (onChunk) {
          onChunk({ content: aiResponse, done: true });
        }
      }
    } catch (error) {
      console.error(`❌ [SessionManager] LLM 调用失败:`, error.message);
      
      if (error.code === 'ECONNREFUSED' || error.message?.includes('Connection')) {
        aiResponse = this._generateMockResponse(userMessage);
        usage = { prompt_tokens: userMessage.length, completion_tokens: aiResponse.length };
        actualModel = "mock-fallback";
        if (onChunk) onChunk({ content: aiResponse, done: true });
      } else {
        throw new Error(`AI 服务调用失败: ${error.message}`);
      }
    }

    // 保存到会话历史
    const sessions = await this._loadSessions();
    const sessionIndex = sessions.findIndex(s => s.id === sessionId);

    if (sessionIndex !== -1) {
      const sessionData = sessions[sessionIndex];
      if (!sessionData.messages) sessionData.messages = [];
      
      sessionData.messages.push({
        role: "user",
        content: userMessage,
        timestamp: new Date().toISOString(),
        parts: parts
      });
      
      sessionData.messages.push({
        role: "assistant",
        content: aiResponse,
        timestamp: new Date().toISOString(),
        model: actualModel,
        usage: usage
      });

      sessionData.updatedAt = new Date().toISOString();
      sessions[sessionIndex] = sessionData;
      await this._saveSessions(sessions);
    }

    return {
      type: "message",
      role: "assistant",
      model: actualModel,
      content: aiResponse,
      usage: {
        prompt_tokens: usage.prompt_tokens || 0,
        completion_tokens: usage.completion_tokens || 0,
        total_tokens: usage.total_tokens || 0
      },
      stopReason: "end_turn",
      sessionId: sessionId,
      timestamp: new Date().toISOString()
    };
  }

  /**
   * 转发消息到外部 OpenCode 服务（流式版本）
   */
  async _forwardToOpencodeStream(sessionId, parts, options = {}, onChunk) {
    const baseUrl = this.opencodeUrl.replace(/\/$/, '');

    let targetSessionId = null;

    try {
      console.log(`🔗 [OpenCode-Stream] 创建新会话...`);
      const sessionResponse = await fetch(`${baseUrl}/session`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          directory: options.directory || process.cwd(),
          ...(options.systemPrompt ? { systemPrompt: options.systemPrompt } : {})
        })
      });

      if (!sessionResponse.ok) {
        throw new Error(`创建 OpenCode 会话失败: ${sessionResponse.status}`);
      }

      const sessionData = await sessionResponse.json();
      targetSessionId = sessionData.id || sessionData.data?.id;
      console.log(`🔗 [OpenCode-Stream] 新会话已创建: ${targetSessionId}`);

    } catch (createError) {
      console.error(`❌ [OpenCode-Stream] 创建会话失败:`, createError.message);
      throw new Error(`无法创建 OpenCode 会话: ${createError.message}`);
    }

    if (!targetSessionId) {
      throw new Error('OpenCode 返回的会话 ID 为空');
    }

    const requestBody = {
      parts: parts,
      ...(options.model && typeof options.model === 'object' ? { model: options.model } : {}),
      ...(options.agent ? { agent: options.agent } : {}),
      ...(options.system ? { system: options.system } : {}),
      ...(options.noReply !== undefined ? { noReply: options.noReply } : {})
    };

    console.log(`🔗 [OpenCode-Stream] 发送到 session/${targetSessionId.substring(0, 8)}.../message (流式)`);
    console.log(`🔗 [OpenCode-Stream] 等待 LLM 响应 (超时: ${Math.round(this.opencodeTimeout / 1000)}s)...`);

    const startTime = Date.now();

    try {
      const result = await this._sendHttpRequestViaChildProcessStream(
        `${baseUrl}/session/${targetSessionId}/message`,
        JSON.stringify(requestBody),
        this.opencodeTimeout,
        onChunk
      );

      const elapsed = Math.round((Date.now() - startTime) / 1000);
      console.log(`🔗 [OpenCode-Stream] 收到响应 (${elapsed}s) - Status: ${result.status}, 长度: ${result.body.length} 字符`);

      if (result.status !== 200) {
        throw new Error(`OpenCode 服务返回错误 ${result.status}: ${result.body.substring(0, 200)}`);
      }

      if (!result.body || result.body.trim().length === 0) {
        throw new Error('OpenCode 返回空响应');
      }

      let responseData;
      try {
        responseData = JSON.parse(result.body);
      } catch (parseError) {
        throw new Error(`JSON 解析失败: ${parseError.message}. 原始响应: ${result.body.substring(0, 200)}`);
      }

      let content = "";
      let usage = {};
      let model = "";

      if (responseData.parts && Array.isArray(responseData.parts)) {
        const textParts = responseData.parts.filter(p => p.type === "text" && p.text);
        content = textParts.map(p => p.text).join("\n");
        
        if (responseData.info) {
          model = responseData.info.model || responseData.info.agent || "";
          usage = {
            sessionID: targetSessionId,
            messageID: responseData.info.messageID,
            role: responseData.info.role
          };
        }
      } else if (responseData.content) {
        content = responseData.content;
        usage = responseData.usage || {};
        model = responseData.model || "";
      } else if (typeof responseData === "string") {
        content = responseData;
      } else {
        content = JSON.stringify(responseData);
      }

      if (onChunk && !options._chunkSent) {
        onChunk({ content, done: true });
      }

      const totalElapsed = Math.round((Date.now() - startTime) / 1000);
      console.log(`✅ [OpenCode-Stream] 成功获取 LLM 响应 (${totalElapsed}s, ${content.length} 字符)`);

      return {
        content,
        usage,
        model,
        opencodeSessionId: targetSessionId,
        rawResponse: responseData
      };

    } catch (error) {
      const elapsed = Math.round((Date.now() - startTime) / 1000);
      console.error(`❌ [OpenCode-Stream] 代理失败 (${elapsed}s): ${error.message}`);
      throw error;
    }
  }

  /**
   * 删除会话
   */
  async deleteSession(sessionId) {
    const sessions = await this._loadSessions();
    const filtered = sessions.filter(s => s.id !== sessionId);

    if (filtered.length === sessions.length) {
      throw new Error(`会话不存在: ${sessionId}`);
    }

    await this._saveSessions(filtered);
    console.log(`🗑️ [SessionManager] 删除会话: ${sessionId}`);
    return true;
  }

  /**
   * 清理过期会话
   */
  async cleanupExpiredSessions(maxAgeDays = 7) {
    const sessions = await this._loadSessions();
    const cutoffDate = new Date();
    cutoffDate.setDate(cutoffDate.getDate() - maxAgeDays);
    const cutoffStr = cutoffDate.toISOString();

    const active = sessions.filter(s => s.updatedAt >= cutoffStr);
    const removed = sessions.length - active.length;

    if (removed > 0) {
      await this._saveSessions(active);
      console.log(`🧹 [SessionManager] 清理了 ${removed} 个过期会话`);
    }

    return { removed, remaining: active.length };
  }

  _parseParts(parts) {
    if (!parts || !Array.isArray(parts)) {
      return typeof parts === 'string' ? parts : JSON.stringify(parts);
    }

    return parts
      .filter(p => p.type === "text" && p.text)
      .map(p => p.text)
      .join("\n");
  }

  /**
   * 转发消息到外部 OpenCode 服务
   * 
   * @param {string} sessionId - 会话ID（可选，如果为空则创建新会话）
   * @param {Array} parts - 消息部分
   * @param {Object} options - 选项
   * @returns {Promise<Object>} { content, usage, model }
   */
  /**
   * 使用 Node.js 原生 http 模块发送请求（解决 fetch 无法读取 Hono stream 的问题）
   */
  _sendHttpRequest(url, body, timeoutMs) {
    return new Promise((resolve, reject) => {
      const parsedUrl = new URL(url);
      const httpModule = parsedUrl.protocol === 'https:' ? this._httpsModule : this._httpModule;
      
      const options = {
        hostname: parsedUrl.hostname,
        port: parsedUrl.port || (parsedUrl.protocol === 'https:' ? 443 : 80),
        path: parsedUrl.pathname,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body)
        },
        timeout: timeoutMs
      };

      const req = httpModule.request(options, (res) => {
        let data = '';
        let chunkCount = 0;
        
        console.log(`🔗 [HTTP] 收到响应头: Status=${res.statusCode}`);
        
        // 正确处理 streaming 响应 - 逐块收集
        res.on('data', (chunk) => {
          chunkCount++;
          data += chunk;
          if (chunkCount <= 3) {
            console.log(`🔗 [HTTP] 收到数据块 #${chunkCount}: ${chunk.length} 字符`);
          }
        });
        
        res.on('end', () => {
          console.log(`🔗 [HTTP] 响应完成: 共 ${chunkCount} 个数据块, 总计 ${data.length} 字符`);
          resolve({
            status: res.statusCode,
            headers: res.headers,
            body: data
          });
        });
        
        res.on('error', (e) => {
          console.error(`🔗 [HTTP] 响应流错误:`, e.message);
          reject(e);
        });
        
        res.on('close', () => {
          console.log(`🔗 [HTTP] 响应流关闭 (当前数据长度: ${data.length})`);
        });
      });

      req.on('error', (error) => {
        console.error(`🔗 [HTTP] 请求错误:`, error.message);
        reject(error);
      });

      req.on('timeout', () => {
        console.warn(`🔗 [HTTP] 请求超时 (${timeoutMs}ms)`);
        req.destroy(new Error(`请求超时 (${timeoutMs}ms)`));
      });
      
      // 调试：确认请求正在发送
      console.log(`🔗 [HTTP] 发送请求到 ${parsedUrl.hostname}:${parsedUrl.port || 80}${parsedUrl.pathname} (body: ${body.length} 字节)`);

      // 发送请求体
      req.write(body);
      req.end();
    });
  }

  /**
   * 使用子进程调用 CommonJS 辅助脚本发送 HTTP 请求（解决 ESM streaming 问题）
   */
  _sendHttpRequestViaChildProcess(url, body, timeoutMs) {
    return new Promise((resolve, reject) => {
      const helperPath = path.join(path.dirname(fileURLToPath(import.meta.url)), 'opencode-http-helper.cjs');
      
      // 将 body 写入临时文件（避免命令行参数转义问题）
      const tempFile = path.join(__dirname, `.opencode-body-${Date.now()}-${Math.random().toString(36).substring(2, 8)}.tmp`);
      
      console.log(`🔗 [ChildProcess] 辅助脚本: ${helperPath}`);
      console.log(`🔗 [ChildProcess] URL: ${url}`);
      console.log(`🔗 [ChildProcess] Body 长度: ${body.length} 字符 → 临时文件: ${path.basename(tempFile)}`);
      console.log(`🔗 [ChildProcess] 超时: ${timeoutMs}ms`);
      
      try {
        fs.writeFileSync(tempFile, body, 'utf-8');
      } catch (writeError) {
        reject(new Error(`写入临时文件失败: ${writeError.message}`));
        return;
      }
      
      const child = execFile('node', [helperPath, url, tempFile, String(timeoutMs)], { 
        timeout: timeoutMs + 5000,
        maxBuffer: 10 * 1024 * 1024 
      }, (error, stdout, stderr) => {
        // 清理临时文件
        try { fs.unlinkSync(tempFile); } catch (_) {}
        
        if (stderr) {
          console.log(`🔗 [ChildProcess] stderr: ${stderr.substring(0, 300)}`);
        }
        
        if (error) {
          console.error(`🔗 [ChildProcess] 错误: ${error.message}`);
          reject(new Error(`子进程错误: ${error.message}`));
          return;
        }
        
        console.log(`🔗 [ChildProcess] stdout 长度: ${stdout.length} 字符`);
        
        try {
          const output = stdout.trim();
          if (!output) {
            reject(new Error('子进程无输出'));
            return;
          }
          
          const result = JSON.parse(output);
          if (result.error) {
            reject(new Error(result.error));
          } else {
            resolve(result);
          }
        } catch (e) {
          reject(new Error(`解析子进程输出失败: ${e.message}. 原始输出: ${stdout.substring(0, 200)}`));
        }
      });
    });
  }

  /**
   * 使用子进程流式调用 CommonJS 辅助脚本（解决 ESM streaming + 长耗时问题）
   * 使用 spawn 实时读取 stdout，逐块收集数据
   */
  _sendHttpRequestViaChildProcessStream(url, body, timeoutMs, onChunk) {
    return new Promise((resolve, reject) => {
      const helperPath = path.join(path.dirname(fileURLToPath(import.meta.url)), 'opencode-http-helper.cjs');
      
      const tempFile = path.join(__dirname, `.opencode-body-${Date.now()}-${Math.random().toString(36).substring(2, 8)}.tmp`);
      
      console.log(`🔗 [Stream] 辅助脚本: ${helperPath}`);
      console.log(`🔗 [Stream] URL: ${url}`);
      console.log(`🔗 [Stream] Body 长度: ${body.length} 字符 → 临时文件: ${path.basename(tempFile)}`);
      console.log(`🔗 [Stream] 超时: ${timeoutMs}ms (流式模式)`);
      
      try {
        fs.writeFileSync(tempFile, body, 'utf-8');
      } catch (writeError) {
        reject(new Error(`写入临时文件失败: ${writeError.message}`));
        return;
      }
      
      const child = spawn('node', [helperPath, url, tempFile, String(timeoutMs), '1'], {
        timeout: timeoutMs + 5000,
        maxBuffer: 50 * 1024 * 1024
      });
      
      let status = null;
      let fullBody = '';
      let chunkCount = 0;
      let errorOutput = '';
      let settled = false;
      
      const cleanup = () => {
        try { fs.unlinkSync(tempFile); } catch (_) {}
      };
      
      const settle = (result) => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve(result);
      };
      
      const settleErr = (err) => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(err);
      };
      
      // 超时处理
      const timer = setTimeout(() => {
        console.warn(`⏰ [Stream] 总超时 (${timeoutMs}ms)，返回已收集的数据 (${fullBody.length} 字符)`);
        if (fullBody.length > 0 && status === 200) {
          settle({ status, body: fullBody });
        } else {
          settleErr(new Error(`流式请求超时 (${timeoutMs}ms)`));
        }
      }, timeoutMs + 5000);
      
      child.stdout.on('data', (data) => {
        const lines = data.toString('utf-8').split('\n');
        
        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed) continue;
          
          if (trimmed.startsWith('STATUS:')) {
            status = parseInt(trimmed.substring(7));
            console.log(`🔗 [Stream] HTTP Status: ${status}`);
          } else if (trimmed.startsWith('DATA:')) {
            try {
              const chunkData = JSON.parse(trimmed.substring(5));
              fullBody += chunkData.chunk;
              chunkCount++;
              
              if (chunkCount <= 3 || chunkCount % 10 === 0) {
                console.log(`🔗 [Stream] 数据块 #${chunkData.total}: ${chunkData.size} 字符 (累计 ${fullBody.length})`);
              }
              
              // 回调通知外部（可用于 SSE 推送）
              if (onChunk) {
                onChunk({
                  chunk: chunkData.chunk,
                  totalSize: fullBody.length,
                  chunkIndex: chunkCount,
                  isPartial: true
                });
              }
            } catch (e) {
              console.warn(`🔗 [Stream] 解析 DATA 行失败:`, trimmed.substring(0, 100));
            }
          } else if (trimmed.startsWith('EVENT:end')) {
            console.log(`🔗 [Stream] 流结束 (共 ${chunkCount} 个数据块, ${fullBody.length} 字符)`);
          } else if (trimmed.startsWith('ERROR:')) {
            try {
              const errData = JSON.parse(trimmed.substring(6));
              errorOutput = errData.error || trimmed;
              console.error(`🔗 [Stream] 错误: ${errorOutput}`);
            } catch (_) {
              errorOutput = trimmed.substring(6);
            }
          }
        }
      });
      
      child.stderr.on('data', (data) => {
        const msg = data.toString('utf-8').trim();
        if (msg) {
          console.log(`🔗 [Stream] stderr: ${msg.substring(0, 200)}`);
          errorOutput = errorOutput || msg;
        }
      });
      
      child.on('close', (code) => {
        clearTimeout(timer);
        console.log(`🔗 [Stream] 子进程退出 code=${code}, 累计 ${fullBody.length} 字符`);
        
        if (errorOutput && !fullBody) {
          settleErr(new Error(errorOutput));
        } else if (status && fullBody) {
          settle({ status, body: fullBody });
        } else if (fullBody) {
          settle({ status: status || 200, body: fullBody });
        } else if (errorOutput) {
          settleErr(new Error(errorOutput));
        } else {
          settleErr(new Error('子进程无输出'));
        }
      });
      
      child.on('error', (err) => {
        clearTimeout(timer);
        console.error(`🔗 [Stream] 子进程错误:`, err.message);
        settleErr(new Error(`子进程错误: ${err.message}`));
      });
    });
  }

  async _forwardToOpencode(sessionId, parts, options = {}) {
    const baseUrl = this.opencodeUrl.replace(/\/$/, '');  // 移除尾部斜杠

    let targetSessionId = null;

    // 始终在 OpenCode 服务端创建新会话（本地 session ID 与 OpenCode 不通用）
    try {
      console.log(`🔗 [OpenCode] 创建新会话...`);
      const sessionResponse = await fetch(`${baseUrl}/session`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          directory: options.directory || process.cwd(),
          ...(options.systemPrompt ? { systemPrompt: options.systemPrompt } : {})
        })
      });

      if (!sessionResponse.ok) {
        throw new Error(`创建 OpenCode 会话失败: ${sessionResponse.status}`);
      }

      const sessionData = await sessionResponse.json();
      targetSessionId = sessionData.id || sessionData.data?.id;
      console.log(`🔗 [OpenCode] 新会话已创建: ${targetSessionId}`);

    } catch (createError) {
      console.error(`❌ [OpenCode] 创建会话失败:`, createError.message);
      throw new Error(`无法创建 OpenCode 会话: ${createError.message}`);
    }

    if (!targetSessionId) {
      throw new Error('OpenCode 返回的会话 ID 为空');
    }

    // 构建请求体（兼容 OpenCode PromptInput 格式）
    const requestBody = {
      parts: parts,
      ...(options.model && typeof options.model === 'object' ? { model: options.model } : {}),
      ...(options.agent ? { agent: options.agent } : {}),
      ...(options.system ? { system: options.system } : {}),
      ...(options.noReply !== undefined ? { noReply: options.noReply } : {})
    };

    console.log(`🔗 [OpenCode] 发送到 session/${targetSessionId.substring(0, 8)}.../message (使用流式子进程模式)`);
    console.log(`🔗 [OpenCode] 等待 LLM 响应 (超时: ${Math.round(this.opencodeTimeout / 1000)}s, 流式)...`);

    const startTime = Date.now();

    try {
      // 使用流式子进程调用（实时收集数据块，避免长耗时超时）
      const result = await this._sendHttpRequestViaChildProcessStream(
        `${baseUrl}/session/${targetSessionId}/message`,
        JSON.stringify(requestBody),
        this.opencodeTimeout
      );

      const elapsed = Math.round((Date.now() - startTime) / 1000);
      console.log(`🔗 [OpenCode] 收到响应 (${elapsed}s) - Status: ${result.status}, 长度: ${result.body.length} 字符`);

      if (result.status !== 200) {
        throw new Error(`OpenCode 服务返回错误 ${result.status}: ${result.body.substring(0, 200)}`);
      }

      if (!result.body || result.body.trim().length === 0) {
        throw new Error('OpenCode 返回空响应');
      }

      // 解析 JSON 响应
      let responseData;
      try {
        responseData = JSON.parse(result.body);
      } catch (parseError) {
        throw new Error(`JSON 解析失败: ${parseError.message}. 原始响应: ${result.body.substring(0, 200)}`);
      }

      // 解析 OpenCode message-v2 格式：{ info: {...}, parts: [{ type: "text", text: "..." }, ...] }
      let content = "";
      let usage = {};
      let model = "";

      if (responseData.parts && Array.isArray(responseData.parts)) {
        const textParts = responseData.parts.filter(p => p.type === "text" && p.text);
        content = textParts.map(p => p.text).join("\n");
        
        if (responseData.info) {
          model = responseData.info.model || responseData.info.agent || "";
          usage = {
            sessionID: targetSessionId,
            messageID: responseData.info.messageID,
            role: responseData.info.role
          };
        }
      } else if (responseData.content) {
        content = responseData.content;
        usage = responseData.usage || {};
        model = responseData.model || "";
      } else if (typeof responseData === "string") {
        content = responseData;
      } else {
        content = JSON.stringify(responseData);
      }

      const totalElapsed = Math.round((Date.now() - startTime) / 1000);
      console.log(`✅ [OpenCode] 成功获取 LLM 响应 (${totalElapsed}s, ${content.length} 字符)`);

      return {
        content,
        usage,
        model,
        opencodeSessionId: targetSessionId,
        rawResponse: responseData
      };

    } catch (error) {
      const elapsed = Math.round((Date.now() - startTime) / 1000);
      console.error(`❌ [OpenCode] 代理失败 (${elapsed}s): ${error.message}`);
      throw error;
    }
  }

  /**
   * 生成模拟 AI 响应（当 LLM 服务不可用时使用）
   */
  _generateMockResponse(userMessage) {
    const lowerMsg = (userMessage || "").toLowerCase();
    
    // 根据用户输入生成相关的模拟响应
    const responses = [
      { keywords: ["你好", "hi", "hello", "嗨"], reply: "你好！我是 AI 助手（模拟模式）。有什么可以帮助你的吗？😊" },
      { keywords: ["名字", "你是谁", "who are you"], reply: "我是一个 AI 生活助手，目前运行在模拟模式。我可以帮你管理目标、规划任务等！" },
      { keywords: ["天气", "weather"], reply: "今天天气不错呢！☀️ 不过这是模拟响应，实际使用时请配置真实的 LLM 服务获取准确信息。" },
      { keywords: ["时间", "几点", "time"], reply: `现在是 ${new Date().toLocaleString('zh-CN')} （模拟模式）` },
      { keywords: ["谢谢", "thank", "感谢"], reply: "不客气！有需要随时叫我～ 😊" },
      { keywords: ["目标", "goal", "习惯", "habit"], reply: "好的！我可以帮你创建和管理生活目标。比如：'帮我养成21天早起的习惯'。要试试吗？" },
      { keywords: ["1+1", "1 + 1", "一加一"], reply: "1 + 1 = 2 🧮" },
      { keywords: ["早上好", "早安", "good morning"], reply: "早上好！新的一天开始啦！☀️ 今天也要元气满满哦！（模拟模式）" },
      { keywords: ["晚安", "睡觉", "good night"], reply: "晚安！早点休息哦～做个好梦！🌙✨（模拟模式）" },
      { keywords: ["帮助", "help", "怎么用"], reply: "你可以这样使用我：\n1. 创建目标：'帮我养成21天早起习惯'\n2. 随意聊天：'你好'\n3. 查看会话历史\n\n当前为模拟模式，请配置 LLM 服务以获得完整功能。" },
    ];

    for (const item of responses) {
      if (item.keywords.some(k => lowerMsg.includes(k))) {
        return item.reply;
      }
    }

    // 默认响应
    const defaultResponses = [
      "这是一个模拟响应。实际使用时，这里会是真实 AI 的回复。",
      "收到你的消息了！（模拟模式）配置好 LLM 服务后就能正常对话啦～",
      `你说了："${userMessage.substring(0, 50)}..."（模拟模式已启用）`,
      "🤖 模拟模式运行中... 请检查 OpenAI API 配置以启用完整功能。",
    ];

    return defaultResponses[Math.floor(Math.random() * defaultResponses.length)];
  }

  _generateId() {
    return `sess_${crypto.randomBytes(8).toString('hex')}`;
  }

  async _loadSessions() {
    try {
      if (await fs.pathExists(this.sessionsFile)) {
        const data = await fs.readJson(this.sessionsFile);
        return data.sessions || [];
      }
    } catch (error) {
      console.error("❌ [SessionManager] 加载会话失败:", error.message);
    }
    return [];
  }

  async _saveSessions(sessions) {
    const data = {
      sessions,
      lastUpdated: new Date().toISOString()
    };
    await fs.writeJson(this.sessionsFile, data, { spaces: 2 });
  }

  async _ensureFileExists() {
    if (!(await fs.pathExists(this.sessionsFile))) {
      await fs.writeJson(
        this.sessionsFile,
        { sessions: [], lastUpdated: new Date().toISOString() },
        { spaces: 2 }
      );
      console.log(`📄 [SessionManager] 创建会话文件: ${this.sessionsFile}`);
    }
  }
}

export default SessionManager;
