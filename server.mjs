/**
 * 小爱音箱 Web 管理后台 API 服务器
 *
 * 功能：
 * 1. 提供 REST API 供前端调用
 * 2. 管理定时任务、TTS、AI 交互
 * 3. 静态文件服务（前端页面）
 *
 * 启动: node server.mjs
 * 访问: http://localhost:3000
 */

import http from "http";
import fs from "fs-extra";
import path from "path";
import { fileURLToPath } from "url";
import { getMiNA, getMiIOT } from "mi-service-lite";
import OpenAI from "openai";
import { exec, spawnSync } from "child_process";
import { promisify } from "util";
import dotenv from "dotenv";
import { AiDailyPlanner } from "./xiaoai-ai-planner.mjs";
import { getTaskPlannerService, getAvailableTools } from "./pi-planner-service.js";
import { taskTools, _getWeather, _getSpecialEvents } from "./pi-task-tools.js";
import { GoalParser } from "./goal-system/goal-parser.mjs";
import { GoalManager } from "./goal-system/goal-manager.mjs";
import { DynamicAdjuster } from "./goal-system/dynamic-adjuster.mjs";
import { SessionManager } from "./goal-system/session-manager.mjs";
import { SmartTaskGenerator } from "./goal-system/smart-task-generator.mjs";

dotenv.config();

if (process.platform === 'win32') {
  spawnSync('chcp', ['65001'], { stdio: 'ignore' });
  process.stdout.setEncoding('utf8');
  process.stderr.setEncoding('utf8');
}

process.env.LANG = 'zh_CN.UTF-8';

const execAsync = promisify(exec);

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ==================== 配置 ====================
const CONFIG = {
  userId: process.env.MI_USER_ID || "2259538958",
  password: process.env.MI_PASSWORD || "071419jt",
  did: process.env.MI_DID || "89952946",
};

// 敏感信息校验
if (!CONFIG.userId || !CONFIG.password || !CONFIG.did) {
  console.warn("⚠️ [配置] 小米账号信息未完整配置，请检查 .env 文件中的 MI_USER_ID、MI_PASSWORD、MI_DID");
}

const PORT = 13000;
const SCHEDULES_FILE = path.join(__dirname, ".schedules.json");
const SETTINGS_FILE = path.join(__dirname, ".settings.json");
const HISTORY_FILE = path.join(__dirname, ".history.json");
const CONVERSATION_FILE = path.join(__dirname, ".conversation.json");

// ==================== 全局状态 ====================
let miNA = null;
let miIOT = null;
let device = null;
let openai = null;
let conversationHistory = [];
let scheduleTimers = new Map(); // 定时器引用
let autoPlannerTimer = null; // AI 每日规划自动运行定时器
let taskPlannerService = null; // 任务规划服务（基于 OpenAI）
let aiDailyPlanner = null; // AI 每日规划器
let goalParser = null; // AI 目标解析器
let goalManager = null; // 目标管理器
let dynamicAdjuster = null; // 动态调整引擎
let sessionManager = null; // 会话管理器
let smartTaskGenerator = null; // 智能任务生成器（统一入口）v2.0

// ==================== 配置文件 ====================
const AI_PLANNER_CONFIG = path.join(__dirname, ".ai-planner-config.json");
const AI_PLANNER_HISTORY = path.join(__dirname, ".ai-planner-history.json");

// ==================== 初始化 ====================

async function init() {
  if (!miNA) {
    try {
      miNA = await getMiNA(CONFIG);
      if (!miNA) {
        console.warn("⚠️ MiNA 初始化失败（网络问题），部分功能可能不可用");
        // 不再抛出错误，允许继续运行
      }
    } catch (error) {
      console.warn("⚠️ MiNA 初始化异常:", error.message, "- 继续启动其他服务...");
    }
  }

  if (!miIOT) {
    try {
      miIOT = await getMiIOT(CONFIG);
      if (miIOT) {
        console.log("✅ MiIOT 服务已初始化");
      }
    } catch (error) {
      console.warn("⚠️ MiIOT 初始化失败，唤醒功能将不可用:", error.message);
    }
  }

  if (!device) {
    const devices = await miNA.getDevices();
    device = devices.find(d =>
      d.miotDID === CONFIG.did || d.name === CONFIG.did || d.alias === CONFIG.did
    );
    if (!device) throw new Error(`未找到设备: ${CONFIG.did}`);
  }

  if (conversationHistory.length === 0) {
    conversationHistory = await loadConversationHistory();
    console.log(`✅ 已加载 ${conversationHistory.length} 条对话历史`);
  }

  if (!openai) {
    // 优先从设置文件加载
    const settings = await loadSettings();
    const apiKey = settings.apiKey || process.env.OPENAI_API_KEY;
    const baseURL = settings.apiBaseUrl || process.env.OPENAI_BASE_URL;

    if (apiKey && apiKey !== "your-api-key-here") {
      openai = new OpenAI({
        apiKey: apiKey,
        baseURL: baseURL || undefined,
      });
      console.log("✅ AI 服务已初始化");
    }
  }

  // 初始化任务规划服务（基于 OpenAI Function Calling）
  if (!taskPlannerService && openai) {
    try {
      // 从设置文件加载 API 配置
      const settings = await loadSettings();
      const plannerApiKey = settings.apiKey || process.env.OPENAI_API_KEY;
      const plannerBaseUrl = settings.apiBaseUrl || process.env.OPENAI_BASE_URL;

      if (plannerApiKey && plannerApiKey !== "your-api-key-here") {
        taskPlannerService = await getTaskPlannerService({
          apiKey: plannerApiKey,
          baseURL: plannerBaseUrl,
        });
        console.log("✅ 任务规划服务已初始化（基于 OpenAI）");
        console.log(`   📡 API 端点: ${plannerBaseUrl || 'https://api.openai.com/v1'}`);
      }
    } catch (error) {
      console.warn("⚠️ 任务规划服务初始化失败:", error.message);
    }
  }

  // 初始化 AI 每日规划器
  if (!aiDailyPlanner && openai) {
    // 创建适配函数
    const getWeatherFn = async (city, config) => {
      const date = config?.date || new Date(Date.now() + 86400000);
      
      console.log(`🌤️ [初始化] 创建天气函数，目标城市: ${city || '北京'}`);
      
      try {
        const weather = await _getWeather(date, city || "北京");
        console.log(`✅ [初始化] 天气获取成功: ${weather.weather}, 城市: ${weather.city}`);
        
        return {
          city: weather.city || city || "北京",
          weather: weather.weather,
          temp: weather.temp,
          feelsLike: weather.feelsLike,
          humidity: weather.humidity,
          uvIndex: weather.uvIndex,
          windSpeed: weather.windSpeed,
          visibility: weather.visibility,
          tips: weather.tips
        };
      } catch (e) {
        console.warn(`⚠️ [初始化] 天气获取失败:`, e.message);
        return {
          city: city || "北京",
          weather: "晴",
          temp: "20°C",
          feelsLike: "20°C",
          humidity: "未知",
          uvIndex: "未知",
          windSpeed: "未知",
          visibility: "未知",
          tips: "天气信息获取失败，使用默认值"
        };
      }
    };
    
    const getTomorrowHolidayFn = async (tomorrowDate) => {
      // 使用传入的日期或默认明天
      const tomorrow = tomorrowDate || new Date(Date.now() + 86400000);
      const weekday = ["星期日", "星期一", "星期二", "星期三", "星期四", "星期五", "星期六"][tomorrow.getDay()];
      const isWeekend = tomorrow.getDay() === 0 || tomorrow.getDay() === 6;
      
      // 获取特殊事件
      const events = _getSpecialEvents(tomorrow);
      
      // 返回完整的节日信息
      return {
        date: tomorrow.toISOString().split("T")[0],
        weekday: weekday,
        isWeekend: isWeekend,
        isWorkday: !isWeekend,
        events: events, // 所有事件列表
        name: events.length > 0 ? events[0] : null, // 主要事件名称
        hasSpecialEvent: events.length > 0
      };
    };
    
    aiDailyPlanner = new AiDailyPlanner(openai, getWeatherFn, getTomorrowHolidayFn);
    console.log("✅ AI 每日规划器已初始化");
  }

  // 初始化会话管理器（OpenCode 风格的统一 LLM 入口）
  if (!sessionManager) {
    try {
      const opencodeUrl = process.env.OPCODE_URL || null;
      
      sessionManager = new SessionManager({ 
        openaiClient: openai,
        opencodeUrl: opencodeUrl
      });
      await sessionManager.init();
      console.log("💬 会话管理器已就绪！（OpenCode 风格）");
      
      if (opencodeUrl) {
        console.log(`🔗 已配置 OpenCode 代理: ${opencodeUrl}`);
      }
    } catch (error) {
      console.warn("⚠️ 会话管理器初始化失败:", error.message);
    }
  }

  // 初始化目标管理系统（使用 OpenCode 风格调用 LLM）
  if (!goalManager && sessionManager) {
    try {
      goalManager = new GoalManager();
      await goalManager.init();

      // ✅ 读取 AI 规划配置（获取城市等设置）
      const aiPlannerConfig = await loadAIPlannerConfig();
      const configuredCity = aiPlannerConfig.city || '北京';
      console.log(`🌍 [初始化] AI 规划城市: ${configuredCity}`);

      goalParser = new GoalParser(sessionManager);
      console.log("✅ AI 目标解析器已初始化（OpenCode 模式）");

      dynamicAdjuster = new DynamicAdjuster(
        sessionManager,
        _getWeather,
        _getSpecialEvents,
        goalManager,
        { defaultCity: configuredCity }  // ✅ 传递配置的城市
      );
      console.log("✅ 动态调整引擎已初始化（OpenCode 模式 v2.0）");

      // 初始化智能任务生成器（统一入口）
      smartTaskGenerator = new SmartTaskGenerator(sessionManager, {
        goalManager,
        getWeatherFn: _getWeather,
        getHolidayFn: _getSpecialEvents
      });
      console.log("🤖 智能任务生成器已初始化（统一AI入口）");
      
      console.log("🎯 目标系统已就绪！所有模块通过 OpenCode 文件生成模式调用 LLM");
    } catch (error) {
      console.warn("⚠️ 目标系统初始化失败:", error.message);
    }
  }

  return { miNA, miIOT, device, openai, taskPlannerService, aiDailyPlanner, goalParser, goalManager, dynamicAdjuster, sessionManager, smartTaskGenerator };
}

// ==================== 工具函数 ====================

function generateId() {
  return Date.now().toString(36) + Math.random().toString(36).substr(2, 5);
}

async function loadSchedules() {
  try {
    if (await fs.pathExists(SCHEDULES_FILE)) {
      return await fs.readJson(SCHEDULES_FILE);
    }
  } catch (error) {
    console.error("加载任务失败:", error.message);
  }
  return [];
}

async function saveSchedules(schedules) {
  await fs.writeJson(SCHEDULES_FILE, schedules, { spaces: 2 });
}

async function loadSettings() {
  try {
    if (await fs.pathExists(SETTINGS_FILE)) {
      return await fs.readJson(SETTINGS_FILE);
    }
  } catch (error) {
    console.error("加载设置失败:", error.message);
  }
  return {};
}

async function saveSettings(settings) {
  await fs.writeJson(SETTINGS_FILE, settings, { spaces: 2 });
}

async function loadAIPlannerConfig() {
  try {
    if (await fs.pathExists(AI_PLANNER_CONFIG)) {
      return await fs.readJson(AI_PLANNER_CONFIG);
    }
  } catch (error) {
    console.error("加载 AI 规划器配置失败:", error.message);
  }
  return {
    enabled: true,
    autoRunAt: "22:00",
    city: "北京",
    address: "",
    customPrompt: "",
    generateWeatherTasks: true,
    generateHolidayTasks: true,
    generateDailyRoutine: true,
  };
}

async function saveAIPlannerConfig(config) {
  await fs.writeJson(AI_PLANNER_CONFIG, config, { spaces: 2 });
}

async function loadHistory() {
  try {
    if (await fs.pathExists(HISTORY_FILE)) {
      const data = await fs.readJson(HISTORY_FILE);
      return data.logs || [];
    }
  } catch (error) {
    console.error("加载历史记录失败:", error.message);
  }
  return [];
}

async function loadConversationHistory() {
  try {
    if (await fs.pathExists(CONVERSATION_FILE)) {
      const data = await fs.readJson(CONVERSATION_FILE);
      return data.messages || [];
    }
  } catch (error) {
    console.error("加载对话历史失败:", error.message);
  }
  return [];
}

async function saveConversationHistory(messages) {
  try {
    await fs.writeJson(CONVERSATION_FILE, {
      messages,
      lastUpdated: new Date().toISOString()
    }, { spaces: 2 });
  } catch (error) {
    console.error("保存对话历史失败:", error.message);
  }
}

async function saveHistory(logs) {
  try {
    await fs.writeJson(HISTORY_FILE, {
      logs,
      lastUpdated: new Date().toISOString()
    }, { spaces: 2 });
  } catch (error) {
    console.error("保存历史记录失败:", error.message);
  }
}

async function addHistoryLog(type, data) {
  const logs = await loadHistory();
  const log = {
    id: generateId(),
    type,
    timestamp: new Date().toISOString(),
    ...data
  };
  logs.unshift(log);

  if (logs.length > 1000) {
    logs.splice(1000);
  }

  await saveHistory(logs);
  return log;
}

// ==================== 定时任务调度器 ====================

function parseCron(cronExpr) {
  const parts = cronExpr.split(/\s+/);
  if (parts.length !== 5) {
    throw new Error("Cron 表达式格式错误");
  }
  const [minute, hour, day, month, weekday] = parts;
  return { minute, hour, day, month, weekday };
}

function getNextRunTime(schedule) {
  const now = new Date();

  switch (schedule.type) {
    case "once": {
      const target = new Date(schedule.at);
      target.setMilliseconds(0);
      const nowMs = now.getTime();
      const targetMs = target.getTime();
      
      if (targetMs >= nowMs - 60000 && targetMs <= nowMs + 24 * 60 * 60 * 1000) {
        return targetMs < nowMs ? new Date(nowMs + 1000) : target;
      }
      return null;
    }

    case "interval": {
      const lastRun = schedule.lastRun ? new Date(schedule.lastRun) : new Date(0);
      const nextRun = new Date(lastRun.getTime() + schedule.interval * 1000);
      return nextRun > now ? nextRun : new Date(now.getTime() + 1000);
    }

    case "cron": {
      const { minute, hour } = parseCron(schedule.cron);
      const next = new Date(now);
      next.setSeconds(0, 0);
      next.setMilliseconds(0);

      if (minute !== "*") next.setMinutes(parseInt(minute));
      if (hour !== "*") next.setHours(parseInt(hour));

      if (next.getTime() <= now.getTime()) {
        next.setDate(next.getDate() + 1);
      }

      return next;
    }

    default:
      return null;
  }
}

async function executeSchedule(schedule) {
  console.log(`⏰ 执行任务: "${schedule.text || schedule.command || '未知'}"`);
  
  try {
    let textToSpeak = "";
    let commandOutput = "";
    let success = false;

    if (schedule.taskType === "command" && schedule.command) {
      // 执行系统命令
      console.log(`🔧 执行命令: ${schedule.command}`);
      const { stdout, stderr } = await execAsync(schedule.command, { timeout: 30000 });
      
      commandOutput = stdout || stderr;
      
      if (commandOutput) {
        textToSpeak = commandOutput.trim();
        if (textToSpeak.length > 500) {
          textToSpeak = textToSpeak.substring(0, 500) + "，结果太长，已省略";
        }
        success = true;
      } else {
        textToSpeak = "命令执行完成，没有输出结果";
        success = true;
      }
    } else {
      // 普通文本播报
      textToSpeak = schedule.text;
      success = true;
    }

    // 播放结果
    const ttsResult = await miNA.ubus(
      "mibrain",
      "text_to_speech",
      { text: textToSpeak },
      device.deviceID
    );

    if (ttsResult?.code === 0) {
      console.log(`✅ 任务执行成功: "${schedule.text || schedule.command}"`);

      schedule.lastRun = new Date().toISOString();
      schedule.runCount = (schedule.runCount || 0) + 1;
      const schedules = await loadSchedules();
      const index = schedules.findIndex(s => s.id === schedule.id);
      if (index !== -1) {
        schedules[index] = schedule;
        await saveSchedules(schedules);
      }

      await addHistoryLog("schedule_run", {
        scheduleId: schedule.id,
        text: schedule.text,
        command: schedule.command,
        taskType: schedule.taskType || "text",
        output: commandOutput,
        success: true
      });
    } else {
      console.error(`❌ TTS播放失败:`, ttsResult);

      await addHistoryLog("schedule_run", {
        scheduleId: schedule.id,
        text: schedule.text,
        command: schedule.command,
        taskType: schedule.taskType || "text",
        output: commandOutput,
        success: false,
        error: ttsResult
      });
    }
  } catch (error) {
    console.error(`❌ 任务执行错误:`, error.message);

    // 即使命令执行失败，也尝试播放错误信息
    try {
      const errorMessage = `命令执行失败: ${error.message.substring(0, 200)}`;
      await miNA.ubus(
        "mibrain",
        "text_to_speech",
        { text: errorMessage },
        device.deviceID
      );
    } catch (ttsError) {
      console.error(`❌ 错误信息播放失败:`, ttsError);
    }

    await addHistoryLog("schedule_run", {
      scheduleId: schedule.id,
      text: schedule.text,
      command: schedule.command,
      taskType: schedule.taskType || "text",
      success: false,
      error: error.message
    });
  }
}

function createTimer(schedule) {
  const nextRun = getNextRunTime(schedule);

  if (!nextRun) {
    console.log(`⏰ 任务 "${schedule.text}" 已过期或无效`);
    return;
  }

  const delay = nextRun.getTime() - Date.now();

  if (delay < 0) {
    console.log(`⏰ 任务 "${schedule.text}" 时间已过，立即执行`);
    executeSchedule(schedule);
    return;
  }

  console.log(`⏰ 任务 "${schedule.text}" 将在 ${nextRun.toLocaleString()} 执行（${Math.round(delay / 1000)}秒后）`);

  const timer = setTimeout(async () => {
    await executeSchedule(schedule);

    if (schedule.type !== "once") {
      createTimer(schedule);
    } else {
      scheduleTimers.delete(schedule.id);
      const schedules = await loadSchedules();
      const filtered = schedules.filter(s => s.id !== schedule.id);
      await saveSchedules(filtered);
    }
  }, delay);

  scheduleTimers.set(schedule.id, timer);
}

async function startSchedules() {
  console.log("\n🔄 启动定时任务调度器...");
  const schedules = await loadSchedules();
  
  for (const schedule of schedules) {
    createTimer(schedule);
  }
  
  console.log(`✅ 已加载 ${schedules.length} 个定时任务\n`);
}

function stopAllTimers() {
  for (const [id, timer] of scheduleTimers) {
    clearTimeout(timer);
  }
  scheduleTimers.clear();
}

// ==================== AI 每日规划自动运行调度器 ====================

/**
 * 启动每日自动规划调度器
 * 根据 .ai-planner-config.json 中的 autoRunAt 时间，每天自动生成明天的计划
 */
async function startAutoPlanner() {
  stopAutoPlanner();

  try {
    const config = await loadAIPlannerConfig();
    if (!config.enabled) {
      console.log("⏸️  [自动规划] AI 规划已禁用，跳过自动调度");
      return;
    }

    const autoRunAt = config.autoRunAt || "23:00";
    console.log(`📅 [自动规划] 启动调度器，计划每天 ${autoRunAt} 自动生成明日计划`);

    _scheduleNextAutoRun(autoRunAt);
  } catch (error) {
    console.error("❌ [自动规划] 启动失败:", error.message);
  }
}

/**
 * 停止自动规划调度器
 */
function stopAutoPlanner() {
  if (autoPlannerTimer) {
    clearTimeout(autoPlannerTimer);
    autoPlannerTimer = null;
  }
}

/**
 * 计算下一次执行时间并设置定时器
 * @param {string} autoRunAt - 格式 "HH:MM"
 */
function _scheduleNextAutoRun(autoRunAt) {
  if (autoPlannerTimer) {
    clearTimeout(autoPlannerTimer);
  }

  const now = new Date();
  const [hour, minute] = autoRunAt.split(':').map(Number);
  let nextRun = new Date(now.getFullYear(), now.getMonth(), now.getDate(), hour, minute, 0, 0);

  // 如果今天的时间已过，则安排到明天
  if (nextRun <= now) {
    nextRun.setDate(nextRun.getDate() + 1);
  }

  const delay = nextRun.getTime() - now.getTime();
  const nextRunStr = nextRun.toLocaleString('zh-CN');

  console.log(`⏰ [自动规划] 下次执行: ${nextRunStr} (${Math.round(delay / 3600000)}h${Math.round((delay % 3600000) / 60000)}m 后)`);

  autoPlannerTimer = setTimeout(async () => {
    await _executeAutoPlan(autoRunAt);
    // 执行完后立即安排下一天
    _scheduleNextAutoRun(autoRunAt);
  }, delay);
}

/**
 * 执行自动规划：为所有活跃目标生成明天的计划
 */
async function _executeAutoPlan(autoRunAt) {
  const today = new Date().toISOString().split('T')[0];
  const tomorrow = new Date(Date.now() + 86400000).toISOString().split('T')[0];
  const tomorrowLabel = new Date(Date.now() + 86400000).toLocaleDateString('zh-CN', { month: 'long', day: 'numeric', weekday: 'long' });

  console.log(`\n${'='.repeat(60)}`);
  console.log(`🤖 [自动规划] ===== 开始自动生成明日计划 =====`);
  console.log(`   📅 目标日期: ${tomorrow} (${tomorrowLabel})`);
  console.log(`   ⏰ 执行时间: ${new Date().toLocaleString('zh-CN')}`);
  console.log(`${'='.repeat(60)}\n`);

  try {
    if (!smartTaskGenerator || !goalManager) {
      console.warn("⚠️ [自动规划] 核心服务未初始化，跳过");
      return;
    }

    // 获取所有活跃目标
    const goals = await goalManager.getActiveGoals();
    if (goals.length === 0) {
      console.log("ℹ️  [自动规划] 无活跃目标，跳过");
      return;
    }

    console.log(`📊 [自动规划] 发现 ${goals.length} 个活跃目标`);

    // 获取 AI 规划配置（自定义提示词）
    const aiConfig = await loadAIPlannerConfig();
    const customSystemPrompt = aiConfig.customPrompt || null;

    for (const goal of goals) {
      try {
        console.log(`\n   🎯 [自动规划] 处理目标: ${goal.title} (ID: ${goal.id})`);

        const command = `自动生成 ${tomorrow}(${tomorrowLabel}) 的任务计划`;

        const result = await smartTaskGenerator.processCommand(command, {
          source: 'auto-scheduler',
          targetDate: tomorrow,
          dayOffset: null, // 由内部根据目标进度计算
          customSystemPrompt,
          forceRegenerate: true // 强制重新生成，覆盖已有计划
        });

        if (result.success) {
          console.log(`   ✅ [自动规划] 目标 "${goal.title}" 计划生成成功`);
        } else {
          console.log(`   ❌ [自动规划] 目标 "${goal.title}" 计划生成失败: ${result.replyToUser || '未知错误'}`);
        }
      } catch (goalError) {
        console.error(`   ❌ [自动规划] 目标 "${goal.title}" 处理异常:`, goalError.message);
      }
    }

    console.log(`\n✅ [自动规划] ===== 自动生成完成 =====`);
    console.log(`   📅 已为 ${goals.length} 个目标生成 ${tomorrow} 的计划\n`);

  } catch (error) {
    console.error(`❌ [自动规划] 自动执行失败:`, error.message);
  }
}

// ==================== HTTP 工具 ====================

function sendJSON(res, data, status = 200) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(data));
}

function sendError(res, message, status = 400) {
  sendJSON(res, { success: false, error: message }, status);
}

async function parseBody(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", chunk => body += chunk);
    req.on("end", () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch {
        resolve({});
      }
    });
    req.on("error", reject);
  });
}

// ==================== 辅助函数：时间格式规范化 ====================

function _normalizeTimeFormat(time, repeat) {
  if (!time) return '每天9点';  // 默认值
  
  // 如果已经是自然语言格式，直接返回
  if (/每天|工作日|周末|每小时|每\d+小时|早上|上午|下午|晚上|凌晨/.test(time)) {
    return time;
  }
  
  // 处理多个时间点（如 "09:00,12:00,15:00,18:00"）
  if (time.includes(',')) {
    const times = time.split(',').map(t => _convertTimeToPoint(t.trim())).filter(Boolean);
    return times.length > 0 ? `每天${times.join('、')}` : '每天9点';
  }
  
  // 处理单个时间点（如 "09:00" 或 "9:00"）
  return _convertTimeToPoint(time) || '每天9点';
}

function _convertTimeToPoint(timeStr) {
  const match = timeStr.match(/(\d{1,2})[:：]?(\d{0,2})/);
  if (match) {
    let hour = parseInt(match[1]);
    const min = parseInt(match[2] || 0);
    
    // 转换为中文描述
    let period = '';
    if (hour < 6) period = '凌晨';
    else if (hour < 9) period = '早上';
    else if (hour < 12) period = '上午';
    else if (hour < 14) period = '中午';
    else if (hour < 18) period = '下午';
    else if (hour < 22) period = '晚上';
    else period = '深夜';
    
    const hour12 = hour > 12 ? hour - 12 : hour;
    return `${period}${hour12}点${min > 0 ? min + '分' : ''}`;
  }
  return null;
}

function _inferCategory(description) {
  const desc = (description || '').toLowerCase();
  if (/起床|醒来|早安|早上好|wake|morning/.test(desc)) return 'wake-up';
  if (/吃饭|早餐|午餐|晚餐|加餐|meal|food/.test(desc)) return 'meal';
  if (/玩|游戏|活动|活动|play|activity/.test(desc)) return 'activity';
  if (/睡觉|晚安|睡前|sleep|bed/.test(desc)) return 'sleep';
  if (/喝水|水|提醒|reminder|drink/.test(desc)) return 'reminder';
  if (/问候|你好|hello|greeting/.test(desc)) return 'greeting';
  return 'reminder';  // 默认
}

// ==================== 备用直接创建任务函数 ====================

async function _directAddTask(userCommand) {
  try {
    console.log('🔧 [备用模式] 直接解析并创建任务...');
    
    // ✅ 【改进】智能提取时间和内容，生成更自然的任务文本
    let time = '每天9点';  // 默认时间
    
    // 提取时间信息
    const timePatterns = [
      /每(?:天|日)?(\d+)小时/,
      /每天.*?(\d{1,2})[:：时](\d{0,2})/,
      /工作日.*?(\d{1,2})[:：时]/,
      /周末.*?(\d{1,2})[:：时]/
    ];
    
    for (const pattern of timePatterns) {
      const match = userCommand.match(pattern);
      if (match) {
        if (pattern.toString().includes('小时')) {
          time = `每${match[1]}小时`;
        } else {
          const hour = parseInt(match[1]);
          const min = match[2] ? parseInt(match[2]) : 0;
          time = `每天${_convertTimeToPoint(`${hour}:${min}` || `${hour}:00`)}`;
        }
        break;
      }
    }
    
    // ✅ 【改进】根据用户意图生成温馨、自然的任务文本
    let taskText = _generateNaturalTaskText(userCommand);
    
    console.log(`📝 [备用模式] 生成的任务文本: "${taskText}"`);
    console.log(`📝 [备用模式] 任务时间: "${time}"`);
    
    // 构造标准参数
    const args = {
      description: userCommand,
      text: taskText,
      time: time,
      taskType: 'text',
      category: _inferCategory(userCommand),
    };
    
    console.log(`📝 [备用模式] 完整参数:`, JSON.stringify(args));
    
    // 查找 add_task 工具
    const addTaskTool = taskTools.find(t => t.name === 'add_task');
    if (!addTaskTool) {
      throw new Error('找不到 add_task 工具');
    }
    
    // 执行工具
    const result = await addTaskTool.function(args);
    
    console.log(`✅ [备用模式] 任务创建成功:`, result.task?.id);
    
    return {
      success: true,
      task: result.task,
      result: result,
    };
    
  } catch (error) {
    console.error('❌ [备用模式] 创建失败:', error.message);
    return {
      success: false,
      error: error.message,
    };
  }
}

// ==================== 生成自然任务文本函数 ====================

function _generateNaturalTaskText(userCommand) {
  const cmd = userCommand.toLowerCase();
  
  // 根据关键词匹配不同的模板
  if (/喝水|水|保持健康/.test(cmd)) {
    return '宝贝们，该喝水啦！保持健康很重要，记得多喝水哦～💧';
  }
  
  if (/起床|醒来|早安|早上好/.test(cmd)) {
    return '宝贝们，早上好！该起床啦，新的一天开始咯！☀️';
  }
  
  if (/吃饭|餐|早餐|午餐|晚餐/.test(cmd)) {
    if (/早餐/.test(cmd)) return '早餐时间到啦！宝贝们快来吃早餐，要好好吃饭才能长得高高哦！🥣';
    if (/午餐/.test(cmd)) return '午餐时间到！宝贝们洗手准备吃饭啦，今天有好吃的哦！🍚';
    if (/晚餐/.test(cmd)) return '晚餐时间到！宝贝们快来吃饭，吃完饭我们一起玩游戏！🍽️';
    return '吃饭时间到啦！宝贝们快来吃饭，要好好吃饭才能长得壮壮的！😋';
  }
  
  if (/玩|游戏|活动/.test(cmd)) {
    return '宝贝们，游戏时间到啦！快来和爸爸妈妈一起玩耍吧！🎮';
  }
  
  if (/睡觉|晚安|睡前/.test(cmd)) {
    return '宝贝们，睡觉时间到啦！要乖乖睡觉，做个甜甜的好梦哦！🌙';
  }
  
  if (/提醒|通知/.test(cmd)) {
    // 通用提醒 - 提取关键内容
    const cleanCmd = userCommand
      .replace(/提醒大家?/g, '')
      .replace(/提醒/g, '')
      .replace(/保持健康/g, '')
      .trim();
      
    if (cleanCmd.length > 5) {
      return `温馨提示：${cleanCmd}！记得要注意哦～💡`;
    } else if (cleanCmd.length > 0) {
      return `宝贝们，${cleanCmd}的时间到啦！不要忘记哦～⏰`;
    }
  }
  
  // 默认：使用原始命令但更友好
  return `温馨提示：${userCommand}！要注意哦～💡`;
}

// ==================== 清理 AI 响应用户显示函数 ====================

function _cleanupAIResponseForDisplay(rawResponse, toolResults) {
  let cleaned = rawResponse || '';
  
  // 移除技术性标记和内容
  const patternsToRemove = [
    /---\n\n\*\*📊 操作汇总[\s\S]*$/g,           // 移除操作汇总部分
    /✅\s*成功\s*\([^)]*\)[\s\S]*?(?=❌|$)/g,     // 移除成功列表
    /❌\s*失败\s*\([^)]*\)[\s\S]*$/g,             // 移除失败列表
    /\*\*工具执行结果[\s\S]*?FINISHED/g,         // 移除工具结果详情
    /FINISHED\s*$/g,                              // 移除 FINISHED 标记
    /```json[\s\S]*?```/g,                        // 移除 JSON 代码块
    /<function[^>]*>[\s\S]*?<\/function>/gi,      // 移除 function 标签
    /^\d+\.\s*\*\*[^*]+\*\*[\s\S]*?$/gm,         // 移除编号的技术性说明
    /无需说明失败原因[\s\S]*?$/gm,                // 移除无用说明
    /请根据以上结果[\s\S]*?$/gm,                  // 移除指令性文字
  ];
  
  for (const pattern of patternsToRemove) {
    cleaned = cleaned.replace(pattern, '').trim();
  }
  
  // 如果清理后内容太短或为空，生成友好的总结
  if (cleaned.length < 10 || /^[\s\n]*$/.test(cleaned)) {
    if (toolResults && toolResults.length > 0) {
      const successCount = toolResults.filter(r => r.success).length;
      const failedCount = toolResults.filter(r => !r.success).length;
      
      if (successCount > 0 && failedCount === 0) {
        cleaned = '✅ 已为您完成操作！定时任务已成功创建。';
      } else if (successCount > 0) {
        cleaned = `⚠️ 部分操作已完成（${successCount}个成功），请在定时任务页面查看详情。`;
      } else {
        cleaned = '❌ 操作未完成，请稍后重试。';
      }
    } else {
      cleaned = '好的，已收到您的指令。';
    }
  }
  
  // 最终清理：移除多余空行
  cleaned = cleaned.replace(/\n{3,}/g, '\n\n').trim();
  
  console.log(`🎨 [显示优化] 原始长度: ${rawResponse.length} → 清理后: ${cleaned.length}`);
  
  return cleaned;
}

// ==================== 辅助函数：从 AI 响应中提取并执行工具调用 ====================
async function extractAndExecuteToolCalls(response) {
  const toolCallResults = [];

  try {
    // 尝试从响应中提取 JSON 数组或对象
  const jsonPatterns = [
    /```json\s*([\s\S]*?)\s*```/g,           // 匹配代码块中的 JSON
    /\[[\s\S]*?\](?=\s*```|$)/g,              // 匹配 [...] 格式
    /\{[\s\S]*?"name"[\s\S]*?\}/g,            // 匹配包含 "name" 的对象
    /<function=(\w+)>\s*([\s\S]*?)\s*<\/function>/gi,  // 匹配 <function=name>{...}</function> 标签
  ];

  // 🔍 调试：打印 AI 原始响应
  console.log(`🔍 [回退模式] AI 原始响应 (前800字符):`);
  console.log(response.substring(0, 800));
  console.log(`🔍 [回退模式] 响应总长度: ${response.length} 字符`);

  let extractedJson = null;

  for (let i = 0; i < jsonPatterns.length; i++) {
    const pattern = jsonPatterns[i];
    const matches = response.match(pattern);
    
    // 🔍 调试：显示每个正则的匹配结果
    console.log(`🔍 [回退模式] 正则 #${i + 1} 匹配结果: ${matches ? `找到 ${matches.length} 个匹配` : '❌ 无匹配'}`);
    if (matches) {
      console.log(`   匹配内容预览: ${matches[0].substring(0, 100)}...`);
    }
    
    if (matches) {
        for (const match of matches) {
          try {
            // 清理 markdown 标记
            let cleaned = match.replace(/```json\s*/g, '').replace(/```\s*/g, '').trim();
            
            // 特殊处理 <function=name> 格式
            const functionTagMatch = cleaned.match(/<function=(\w+)>\s*([\s\S]*?)\s*<\/function>/i);
            if (functionTagMatch) {
              const toolName = functionTagMatch[1];
              const argsJson = functionTagMatch[2].trim();
              let parsedArgs;
              
              try {
                parsedArgs = JSON.parse(argsJson);
              } catch (e) {
                // 如果参数不是标准 JSON，尝试简单解析
                console.log(`⚠️ [回退模式] 参数解析失败，尝试简单处理: ${argsJson.substring(0, 50)}...`);
                parsedArgs = { raw: argsJson };
              }
              
              extractedJson = [{
                name: toolName,
                arguments: parsedArgs,
              }];
              break;
            }
            
            const parsed = JSON.parse(cleaned);
            
            if (Array.isArray(parsed)) {
              extractedJson = parsed;
              break;
            } else if (parsed.name && parsed.arguments) {
              extractedJson = [parsed];
              break;
            }
          } catch (e) {
            continue;
          }
        }
        if (extractedJson) break;
      }
    }

    if (!extractedJson || !Array.isArray(extractedJson)) {
      return { executed: false, results: [], cleanedResponse: response };
    }

    // 执行找到的工具调用
    for (const toolCall of extractedJson) {
      if (!toolCall.name || !taskTools.find(t => t.name === toolCall.name)) {
        continue;
      }

      const tool = taskTools.find(t => t.name === toolCall.name);
      
      console.log(`🔧 [回退模式] 执行工具: ${toolCall.name}`);
      
      try {
        let args = toolCall.arguments || {};
        
        // 参数映射和规范化（处理不同模型输出的不同格式）
        if (toolCall.name === 'add_task') {
          console.log(`📝 [回退模式] 原始参数:`, JSON.stringify(args));
          
          // 映射字段名
          args = {
            description: args.description || args.title || '定时提醒任务',
            text: args.text || args.title || args.content || args.description || '提醒任务',
            time: _normalizeTimeFormat(args.time, args.repeat),
            taskType: args.taskType || args.type || 'text',
            category: args.category || _inferCategory(args.description || args.title || ''),
          };
          
          console.log(`📝 [回退模式] 规范化后参数:`, JSON.stringify(args));
        }
        
        const result = await tool.function(args);
        
        console.log(`✅ [回退模式] 工具执行成功: ${toolCall.name}`);
        
        toolCallResults.push({
          name: toolCall.name,
          success: true,
          result: result,
          arguments: args,
        });
      } catch (error) {
        console.error(`❌ [回退模式] 工具执行失败 (${toolCall.name}):`, error.message);
        
        toolCallResults.push({
          name: toolCall.name,
          success: false,
          error: error.message,
          arguments: toolCall.arguments || {},
        });
      }
    }

    // 清理响应文本，移除 JSON 和 function 标签部分
    let cleanedResponse = response;
    for (const pattern of jsonPatterns) {
      cleanedResponse = cleanedResponse.replace(pattern, '').trim();
    }
    // 额外清理 <function> 标签（可能残留）
    cleanedResponse = cleanedResponse.replace(/<function=\w+>\s*[\s\S]*?<\/function>/gi, '').trim();
    // 清理 FINISHED 标记
    cleanedResponse = cleanedResponse.replace(/FINISHED\s*$/gi, '').trim();

    return {
      executed: toolCallResults.length > 0,
      results: toolCallResults,
      cleanedResponse: cleanedResponse || response,
    };

  } catch (error) {
    console.error('❌ 解析工具调用失败:', error.message);
    return { executed: false, results: [], cleanedResponse: response };
  }
}

// ==================== API 路由 ====================

const routes = {
  // 健康检查
  "GET /api/health": async (req, res) => {
    sendJSON(res, { success: true, status: "ok", device: device?.name || "未连接" });
  },

  // 获取天气和节日信息
  "GET /api/weather-info": async (req, res) => {
    try {
      const url = new URL(req.url, `http://${req.headers.host}`);
      const dateStr = url.searchParams.get("date");
      const city = url.searchParams.get("city") || "北京";
      
      const targetDate = dateStr ? new Date(dateStr) : new Date(Date.now() + 86400000);
      
      // 获取天气（传入城市参数）
      const weather = await _getWeather(targetDate, city);
      
      // 获取节日信息
      const specialEvents = _getSpecialEvents(targetDate);
      const isWeekend = targetDate.getDay() === 0 || targetDate.getDay() === 6;
      
      sendJSON(res, {
        success: true,
        data: {
          date: targetDate.toISOString().split("T")[0],
          weekday: ["星期日", "星期一", "星期二", "星期三", "星期四", "星期五", "星期六"][targetDate.getDay()],
          isWeekend,
          weather,
          specialEvents,
          city
        }
      });
    } catch (error) {
      console.error("获取天气信息失败:", error);
      sendError(res, error.message);
    }
  },

  // ==================== AI 每日规划 API ====================

  // 获取 AI 规划配置
  "GET /api/ai-planner/config": async (req, res) => {
    try {
      await init(); // 确保初始化
      if (!aiDailyPlanner) {
        return sendJSON(res, { success: true, data: { enabled: true, weather: true, holiday: true, routine: true } });
      }
      const config = await aiDailyPlanner.loadConfig();
      sendJSON(res, { success: true, data: config });
    } catch (error) {
      console.error("获取 AI 规划配置失败:", error);
      sendError(res, error.message);
    }
  },

  // 保存 AI 规划配置
  "POST /api/ai-planner/config": async (req, res) => {
    try {
      await init(); // 确保初始化
      if (!aiDailyPlanner) {
        return sendError(res, "AI 规划器未初始化");
      }
      const config = await parseBody(req);
      await aiDailyPlanner.saveConfig(config);

      // 重新启动自动调度器（时间可能已变更）
      await startAutoPlanner();

      sendJSON(res, { success: true });
    } catch (error) {
      console.error("保存 AI 规划配置失败:", error);
      sendError(res, error.message);
    }
  },

  // 生成明日计划
  "POST /api/ai-planner/generate": async (req, res) => {
    try {
      await init(); // 确保初始化
      if (!aiDailyPlanner || !openai) {
        return sendError(res, "AI 规划器未初始化，请先配置 OpenAI API");
      }
      
      const settings = await loadSettings();
      const aiPlannerConfig = await loadAIPlannerConfig();
      
      // 构建完整的用户上下文，包含地址、城市等信息
      const userContext = {
        city: aiPlannerConfig.city || settings.city || "北京",
        address: aiPlannerConfig.address || settings.address || "",
        customPrompt: aiPlannerConfig.customPrompt || ""
      };
      
      console.log(`🌍 [API] 生成每日规划 - 城市: ${userContext.city}, 地址: ${userContext.address || '未设置'}`);
      
      const result = await aiDailyPlanner.generateNextDayPlan(
        settings.modelName || "gpt-4o-mini",
        userContext  // ✅ 传递完整的用户上下文
      );
      
      // 格式化结果供前端显示
      const planResult = {
        targetDate: result.date,
        generatedAt: new Date().toISOString(),
        weather: result.weather,
        holiday: result.holiday,
        notifications: result.plan?.notifications || [],
        suggestions: result.plan?.suggestions || [],
        summary: result.plan?.summary || "计划生成成功"
      };
      
      sendJSON(res, { success: true, data: planResult });
    } catch (error) {
      console.error("生成明日计划失败:", error);
      sendError(res, error.message);
    }
  },

  // 应用计划到定时任务
  "POST /api/ai-planner/apply": async (req, res) => {
    try {
      await init(); // 确保初始化
      if (!aiDailyPlanner) {
        return sendError(res, "AI 规划器未初始化");
      }
      const { plan } = await parseBody(req);
      const schedules = aiDailyPlanner.convertPlanToSchedules(plan);
      
      // 添加到现有任务中
      const existingSchedules = await loadSchedules();
      const newSchedules = [...existingSchedules, ...schedules];
      await saveSchedules(newSchedules);
      
      // 刷新调度器
      await startSchedules();
      
      sendJSON(res, { success: true, data: { count: schedules.length } });
    } catch (error) {
      console.error("应用计划失败:", error);
      sendError(res, error.message);
    }
  },

  // 获取规划历史
  "GET /api/ai-planner/history": async (req, res) => {
    try {
      await init(); // 确保初始化
      if (!aiDailyPlanner) {
        return sendJSON(res, { success: true, data: [] });
      }
      const history = await aiDailyPlanner.loadHistory();
      sendJSON(res, { success: true, data: history.generations || [] });
    } catch (error) {
      console.error("获取规划历史失败:", error);
      sendError(res, error.message);
    }
  },

  // 获取自动规划状态
  "GET /api/ai-planner/auto-status": async (req, res) => {
    try {
      const config = await loadAIPlannerConfig();
      sendJSON(res, {
        success: true,
        data: {
          enabled: config.enabled,
          autoRunAt: config.autoRunAt || "23:00",
          isRunning: autoPlannerTimer !== null,
          city: config.city || "北京"
        }
      });
    } catch (error) {
      sendError(res, error.message);
    }
  },

  // 手动触发自动规划（立即生成明日计划）
  "POST /api/ai-planner/auto-trigger": async (req, res) => {
    try {
      await init();
      const config = await loadAIPlannerConfig();
      const autoRunAt = config.autoRunAt || "23:00";

      // 异步执行，不阻塞响应
      _executeAutoPlan(autoRunAt).then(() => {
        console.log("✅ [API] 手动触发自动规划完成");
      }).catch(err => {
        console.error("❌ [API] 手动触发自动规划失败:", err.message);
      });

      sendJSON(res, { success: true, message: "已触发自动生成，请查看终端日志" });
    } catch (error) {
      sendError(res, error.message);
    }
  },

  // ==================== 目标管理系统 API ====================

  // 创建目标
  "POST /api/goals/create": async (req, res) => {
    try {
      await init();

      if (!goalParser || !goalManager || !dynamicAdjuster) {
        return sendError(res, "目标系统未初始化，请检查 OpenAI 配置", 503);
      }

      const body = await parseBody(req);
      const { userRequest, preferences } = body;

      if (!userRequest || !userRequest.trim()) {
        return sendError(res, "请提供 userRequest 参数（您的目标描述）");
      }

      console.log(`\n🎯 [API] 创建目标: "${userRequest.substring(0, 50)}..."`);

      // 1. AI 解析用户输入
      let parsedGoal;
      try {
        parsedGoal = await goalParser.parse(userRequest);

        // 应用用户自定义偏好
        if (preferences) {
          if (preferences.tone) parsedGoal.config.tone = preferences.tone;
          if (preferences.audience) parsedGoal.config.audience = preferences.audience;
          if (preferences.duration) parsedGoal.config.duration = preferences.duration;
          if (preferences.targetTime) parsedGoal.config.targetTime = preferences.targetTime;
        }

        const validation = goalParser.validate(parsedGoal);
        if (!validation.valid) {
          return sendError(res, `目标验证失败: ${validation.errors.join('; ')}`, 400);
        }

      } catch (parseError) {
        console.error("❌ [API] 目标解析失败:", parseError.message);
        return sendError(res, `无法理解您的目标描述: ${parseError.message}`, 400);
      }

      // 2. 创建目标
      const goal = await goalManager.createGoal(parsedGoal);

      // 3. 生成第一天的计划
      let firstDayPlan = null;
      try {
        firstDayPlan = await dynamicAdjuster.dailyAdjustment(goal.id, true);
      } catch (adjustError) {
        console.warn("⚠️ [API] 首次调整失败，将在下次定时任务中重试:", adjustError.message);
      }

      // 4. 记录操作日志
      await addHistoryLog("goal_created", {
        goalId: goal.id,
        title: goal.title,
        type: goal.type,
        duration: goal.config.duration,
        success: true
      });

      sendJSON(res, {
        success: true,
        data: {
          goal,
          firstDayPlan: firstDayPlan ? {
            date: firstDayPlan.date,
            tasks: firstDayPlan.tasks
          } : null,
          message: `✅ 已创建"${goal.title}"目标！共${goal.config.duration}天，明天开始执行。`
        }
      }, 201);

    } catch (error) {
      console.error("❌ [API] 创建目标失败:", error);
      await addHistoryLog("goal_created", { success: false, error: error.message });
      sendError(res, error.message || "创建目标失败", 500);
    }
  },

  // 获取所有目标
  "GET /api/goals": async (req, res) => {
    try {
      await init();

      if (!goalManager) {
        return sendError(res, "目标系统未初始化", 503);
      }

      const url = new URL(req.url, `http://${req.headers.host}`);
      const filters = {
        status: url.searchParams.get("status") || "active",
        type: url.searchParams.get("type") || undefined,
        limit: parseInt(url.searchParams.get("limit")) || 20
      };

      const goals = await goalManager.getGoals(filters);
      const stats = await goalManager.getStatistics();

      sendJSON(res, {
        success: true,
        data: {
          total: stats.totalCreated,
          activeCount: stats.activeCount,
          goals: goals.map(g => ({
            id: g.id,
            title: g.title,
            type: g.type,
            status: g.status,
            progress: g.progress,
            config: g.config,
            createdAt: g.createdAt,
            nextReviewAt: g.nextReviewAt
          }))
        }
      });

    } catch (error) {
      console.error("❌ [API] 获取目标列表失败:", error);
      sendError(res, error.message);
    }
  },

  // 获取目标详情
  "GET /api/goals/:id": async (req, res, goalId) => {
    try {
      await init();

      if (!goalManager) {
        return sendError(res, "目标系统未初始化", 503);
      }

      const goal = await goalManager.getGoal(goalId);
      if (!goal) {
        return sendError(res, "目标不存在", 404);
      }

      const history = await goalManager.getGoalHistory(goalId, 7);

      sendJSON(res, {
        success: true,
        data: { goal, recentHistory: history }
      });

    } catch (error) {
      console.error("❌ [API] 获取目标详情失败:", error);
      sendError(res, error.message);
    }
  },

  // 手动触发调整
  "POST /api/goals/:id/adjust": async (req, res, goalId) => {
    try {
      await init();

      if (!dynamicAdjuster) {
        return sendError(res, "动态调整引擎未初始化", 503);
      }

      const body = await parseBody(req);
      const forceRegenerate = body.forceRegenerate === true;

      console.log(`🔄 [API] 手动调整目标: ${goalId} (force=${forceRegenerate})`);

      const plan = await dynamicAdjuster.dailyAdjustment(goalId, forceRegenerate);

      if (!plan) {
        return sendJSON(res, {
          success: true,
          data: {
            goalId,
            message: "无需调整（明日计划已存在或目标状态不允许）"
          }
        });
      }

      await addHistoryLog("goal_adjusted", {
        goalId,
        date: plan.date,
        tasksGenerated: plan.tasks?.length || 0,
        adjustmentsMade: plan.adjustmentSummary?.totalAdjustments || 0,
        success: true
      });

      sendJSON(res, {
        success: true,
        data: {
          goalId,
          tomorrowDate: plan.date,
          tasksGenerated: plan.tasks?.length || 0,
          adjustmentsMade: plan.adjustmentSummary?.totalAdjustments || 0,
          adjustments: plan.adjustmentSummary?.reasons || [],
          plan
        }
      });

    } catch (error) {
      console.error("❌ [API] 目标调整失败:", error);
      sendError(res, error.message || "调整失败", 500);
    }
  },

  // 更新目标配置
  "PATCH /api/goals/:id": async (req, res, goalId) => {
    try {
      await init();

      if (!goalManager) {
        return sendError(res, "目标系统未初始化", 503);
      }

      const body = await parseBody(req);
      const result = await goalManager.updateGoal(goalId, body);

      sendJSON(res, {
        success: true,
        data: result
      });

    } catch (error) {
      console.error("❌ [API] 更新目标失败:", error);
      sendError(res, error.message);
    }
  },

  // 暂停目标
  "POST /api/goals/:id/pause": async (req, res, goalId) => {
    try {
      await init();

      if (!goalManager) {
        return sendError(res, "目标系统未初始化", 503);
      }

      const result = await goalManager.pauseGoal(goalId);

      sendJSON(res, {
        success: true,
        data: {
          message: "目标已暂停",
          pausedAt: new Date().toISOString(),
          canResumeAfter: new Date().toISOString()
        }
      });

    } catch (error) {
      console.error("❌ [API] 暂停目标失败:", error);
      sendError(res, error.message);
    }
  },

  // 恢复目标
  "POST /api/goals/:id/resume": async (req, res, goalId) => {
    try {
      await init();

      if (!goalManager) {
        return sendError(res, "目标系统未初始化", 503);
      }

      const result = await goalManager.resumeGoal(goalId);

      sendJSON(res, {
        success: true,
        data: {
          message: "目标已恢复",
          resumedAt: new Date().toISOString(),
          nextAdjustmentAt: new Date(Date.now() + 12 * 60 * 60 * 1000).toISOString()
        }
      });

    } catch (error) {
      console.error("❌ [API] 恢复目标失败:", error);
      sendError(res, error.message);
    }
  },

  // 归档（删除）目标
  "DELETE /api/goals/:id": async (req, res, goalId) => {
    try {
      await init();

      if (!goalManager) {
        return sendError(res, "目标系统未初始化", 503);
      }

      const result = await goalManager.archiveGoal(goalId);

      await addHistoryLog("goal_archived", {
        goalId,
        title: result.goal?.title,
        finalStats: result.finalStatistics,
        success: true
      });

      sendJSON(res, {
        success: true,
        data: {
          message: "目标已归档",
          archivedAt: new Date().toISOString(),
          finalStatistics: result.finalStatistics
        }
      });

    } catch (error) {
      console.error("❌ [API] 归档目标失败:", error);
      sendError(res, error.message);
    }
  },

  // 批量调整所有活跃目标
  "POST /api/goals/batch-adjust": async (req, res) => {
    try {
      await init();

      if (!dynamicAdjuster) {
        return sendError(res, "动态调整引擎未初始化", 503);
      }

      const body = await parseBody(req);
      const dryRun = body.dryRun === true;

      console.log(`\n🔄 [API] ===== 批量调整所有活跃目标 ${dryRun ? '(模拟模式)' : ''} =====`);

      if (dryRun) {
        const activeGoals = await goalManager.getActiveGoals();
        return sendJSON(res, {
          success: true,
          data: {
            executedAt: new Date().toISOString(),
            dryRun: true,
            totalGoalsProcessed: activeGoals.length,
            goals: activeGoals.map(g => ({
              id: g.id,
              title: g.title,
              status: g.status,
              progress: g.progress
            }))
          }
        });
      }

      const result = await dynamicAdjuster.batchAdjustAllActiveGoals({
        forceRegenerate: body.forceRegenerate
      });

      sendJSON(res, {
        success: true,
        data: result
      });

    } catch (error) {
      console.error("❌ [API] 批量调整失败:", error);
      sendError(res, error.message || "批量调整失败", 500);
    }
  },

  // 获取目标历史
  "GET /api/goals/:id/history": async (req, res, goalId) => {
    try {
      await init();

      if (!goalManager) {
        return sendError(res, "目标系统未初始化", 503);
      }

      const url = new URL(req.url, `http://${req.headers.host}`);
      const limit = parseInt(url.searchParams.get("limit")) || 7;

      const history = await goalManager.getGoalHistory(goalId, limit);

      sendJSON(res, {
        success: true,
        data: {
          goalId,
          totalRecords: history.length,
          plans: history
        }
      });

    } catch (error) {
      console.error("❌ [API] 获取目标历史失败:", error);
      sendError(res, error.message);
    }
  },

  // ==================== 会话管理 API (Claude Code / Cursor 风格) ====================

  // 创建会话
  "POST /session": async (req, res) => {
    try {
      await init();

      if (!sessionManager) {
        return sendError(res, "会话管理器未初始化", 503);
      }

      const body = await parseBody(req);
      const { directory, systemPrompt, model } = body || {};

      const session = await sessionManager.createSession({
        directory,
        systemPrompt,
        model
      });

      sendJSON(res, {
        success: true,
        data: session
      }, 201);

    } catch (error) {
      console.error("❌ [API] 创建会话失败:", error);
      sendError(res, error.message);
    }
  },

  // 发送消息到会话
  "POST /session/:id/message": async (req, res, sessionId) => {
    try {
      await init();

      if (!sessionManager) {
        return sendError(res, "会话管理器未初始化", 503);
      }

      const body = await parseBody(req);
      let parts = body;
      console.log(`📦 [API] 原始请求体类型: ${typeof body}, 值:`, JSON.stringify(body).substring(0, 200));

      // 支持多种格式
      if (typeof body === 'string') {
        try {
          const parsed = JSON.parse(body);
          parts = parsed.parts || parsed.message || parsed.text || parsed.content || parsed;
        } catch (e) {
          parts = [{ type: "text", text: body }];
        }
      }

      // 如果是对象，提取 parts 或其他字段
      if (!Array.isArray(parts) && typeof parts === 'object') {
        if (parts.parts && Array.isArray(parts.parts)) {
          parts = parts.parts;
        } else if (parts.message || parts.text || parts.content) {
          parts = [{ type: "text", text: parts.message || parts.text || parts.content }];
        } else {
          // 最后尝试：将整个对象转为文本
          const textContent = Object.values(parts).find(v => typeof v === 'string' && v.length > 0);
          if (textContent) {
            parts = [{ type: "text", text: textContent }];
          } else {
            parts = [{ type: "text", text: JSON.stringify(body) }];
          }
        }
      }

      console.log(`📝 [API] 解析后的消息:`, JSON.stringify(parts).substring(0, 200));

      const response = await sessionManager.sendMessage(sessionId, parts, {
        model: body.model,
        temperature: body.temperature,
        maxTokens: body.maxTokens
      });

      sendJSON(res, {
        success: true,
        data: response
      });

    } catch (error) {
      console.error("❌ [API] 发送消息失败:", error);
      sendError(res, error.message);
    }
  },

  // 获取所有会话列表
  "GET /session": async (req, res) => {
    try {
      await init();

      if (!sessionManager) {
        return sendError(res, "会话管理器未初始化", 503);
      }

      const url = new URL(req.url, `http://${req.headers.host}`);
      const limit = parseInt(url.searchParams.get("limit")) || 20;

      const sessions = await sessionManager.getSessions(limit);

      sendJSON(res, {
        success: true,
        data: sessions
      });

    } catch (error) {
      console.error("❌ [API] 获取会话列表失败:", error);
      sendError(res, error.message);
    }
  },

  // 获取会话详情
  "GET /session/:id": async (req, res, sessionId) => {
    try {
      await init();

      if (!sessionManager) {
        return sendError(res, "会话管理器未初始化", 503);
      }

      const session = await sessionManager.getSession(sessionId);
      if (!session) {
        return sendError(res, "会话不存在", 404);
      }

      // 不返回完整消息历史（太长），只返回摘要
      sendJSON(res, {
        success: true,
        data: {
          id: session.id,
          createdAt: session.createdAt,
          updatedAt: session.updatedAt,
          directory: session.directory,
          model: session.model,
          systemPrompt: session.systemPrompt ? "[已设置]" : null,
          messageCount: session.messages?.length || 0,
          metadata: session.metadata
        }
      });

    } catch (error) {
      console.error("❌ [API] 获取会话详情失败:", error);
      sendError(res, error.message);
    }
  },

  // 获取会话消息历史
  "GET /session/:id/history": async (req, res, sessionId) => {
    try {
      await init();

      if (!sessionManager) {
        return sendError(res, "会话管理器未初始化", 503);
      }

      const url = new URL(req.url, `http://${req.headers.host}`);
      const limit = parseInt(url.searchParams.get("limit")) || 50;

      const history = await sessionManager.getSessionHistory(sessionId, limit);

      sendJSON(res, {
        success: true,
        data: history
      });

    } catch (error) {
      console.error("❌ [API] 获取会话历史失败:", error);
      sendError(res, error.message);
    }
  },

  // 删除会话
  "DELETE /session/:id": async (req, res, sessionId) => {
    try {
      await init();

      if (!sessionManager) {
        return sendError(res, "会话管理器未初始化", 503);
      }

      await sessionManager.deleteSession(sessionId);

      sendJSON(res, {
        success: true,
        data: { message: "会话已删除" }
      });

    } catch (error) {
      console.error("❌ [API] 删除会话失败:", error);
      sendError(res, error.message);
    }
  },

  // 获取设备信息
  "GET /api/device": async (req, res) => {
    try {
      const { miNA, device } = await init();
      const devices = await miNA.getDevices();
      sendJSON(res, { success: true, data: { current: device, all: devices } });
    } catch (error) {
      sendError(res, error.message);
    }
  },

  // 发送 TTS
  "POST /api/tts": async (req, res) => {
    try {
      const { text } = await parseBody(req);
      if (!text) return sendError(res, "请提供 text 参数");

      const { miNA, device } = await init();
      const result = await miNA.ubus("mibrain", "text_to_speech", { text }, device.deviceID);

      if (result?.code === 0) {
        await addHistoryLog("tts", { text, success: true });
        sendJSON(res, { success: true, data: result });
      } else {
        await addHistoryLog("tts", { text, success: false, error: result });
        sendJSON(res, { success: false, data: result });
      }
    } catch (error) {
      await addHistoryLog("tts", { text: "未知", success: false, error: error.message });
      sendError(res, error.message);
    }
  },

  // 播放音乐
  "POST /api/music/play": async (req, res) => {
    try {
      const { keyword } = await parseBody(req);
      const { miNA, device } = await init();

      let result;
      let musicCommand = keyword ? `播放 ${keyword}` : "播放音乐";
      
      console.log(`🎵 语音指令: ${musicCommand}`);
      result = await miNA.ubus(
        "mibrain",
        "text_to_speech",
        { text: musicCommand },
        device.deviceID
      );

      if (result?.code === 0) {
        await addHistoryLog("music_play", { keyword: keyword || "播放音乐", success: true });
        sendJSON(res, { success: true, data: result });
      } else {
        await addHistoryLog("music_play", { keyword: keyword || "播放音乐", success: false, error: result });
        sendJSON(res, { success: false, data: result });
      }
    } catch (error) {
      await addHistoryLog("music_play", { keyword: "播放", success: false, error: error.message });
      sendError(res, error.message);
    }
  },

  // 播放音频文件
  "POST /api/audio/play": async (req, res) => {
    try {
      const { url } = await parseBody(req);
      if (!url) return sendError(res, "请提供音频 URL");

      const { miNA, device } = await init();
      console.log(`🎵 播放音频: ${url}`);

      const result = await miNA.play({ url, deviceId: device.deviceID });

      if (result?.code === 0) {
        await addHistoryLog("audio_play", { url, success: true });
        sendJSON(res, { success: true, data: result });
      } else {
        await addHistoryLog("audio_play", { url, success: false, error: result });
        sendJSON(res, { success: false, data: result });
      }
    } catch (error) {
      await addHistoryLog("audio_play", { url: "未知", success: false, error: error.message });
      sendError(res, error.message);
    }
  },

  // 暂停音乐
  "POST /api/music/pause": async (req, res) => {
    try {
      const { miNA, device } = await init();
      const result = await miNA.ubus(
        "mediaplayer",
        "pause",
        {},
        device.deviceID
      );

      if (result?.code === 0) {
        await addHistoryLog("music_pause", { success: true });
        sendJSON(res, { success: true, data: result });
      } else {
        await addHistoryLog("music_pause", { success: false, error: result });
        sendJSON(res, { success: false, data: result });
      }
    } catch (error) {
      await addHistoryLog("music_pause", { success: false, error: error.message });
      sendError(res, error.message);
    }
  },

  // 上一首
  "POST /api/music/prev": async (req, res) => {
    try {
      const { miNA, device } = await init();
      const result = await miNA.ubus(
        "mediaplayer",
        "prev",
        {},
        device.deviceID
      );

      if (result?.code === 0) {
        await addHistoryLog("music_prev", { success: true });
        sendJSON(res, { success: true, data: result });
      } else {
        await addHistoryLog("music_prev", { success: false, error: result });
        sendJSON(res, { success: false, data: result });
      }
    } catch (error) {
      await addHistoryLog("music_prev", { success: false, error: error.message });
      sendError(res, error.message);
    }
  },

  // 下一首
  "POST /api/music/next": async (req, res) => {
    try {
      const { miNA, device } = await init();
      const result = await miNA.ubus(
        "mediaplayer",
        "next",
        {},
        device.deviceID
      );

      if (result?.code === 0) {
        await addHistoryLog("music_next", { success: true });
        sendJSON(res, { success: true, data: result });
      } else {
        await addHistoryLog("music_next", { success: false, error: result });
        sendJSON(res, { success: false, data: result });
      }
    } catch (error) {
      await addHistoryLog("music_next", { success: false, error: error.message });
      sendError(res, error.message);
    }
  },

  // 获取播放状态
  "GET /api/music/status": async (req, res) => {
    try {
      const { miNA, device } = await init();
      const result = await miNA.ubus(
        "mediaplayer",
        "get_player_status",
        {},
        device.deviceID
      );

      sendJSON(res, { success: true, data: result });
    } catch (error) {
      sendError(res, error.message);
    }
  },

  // 唤醒小爱
  "POST /api/wake": async (req, res) => {
    try {
      const { miIOT } = await init();
      
      if (!miIOT) {
        await addHistoryLog("wake", { success: false, error: "MiIOT 服务未初始化" });
        return sendError(res, "唤醒功能不可用：MiIOT 服务未初始化，请检查小米账号配置");
      }

      console.log("👋 唤醒小爱...");

      // 使用唤醒指令 [5, 3] (LX01 型号)
      const result = await miIOT.doAction(5, 3);

      if (result?.code === 0) {
        await addHistoryLog("wake", { success: true });
        sendJSON(res, { success: true, data: result });
      } else {
        await addHistoryLog("wake", { success: false, error: result });
        sendJSON(res, { success: false, data: result });
      }
    } catch (error) {
      await addHistoryLog("wake", { success: false, error: error.message });
      sendError(res, error.message);
    }
  },

  // AI 问答
  "POST /api/ai": async (req, res) => {
    try {
      await init();

      let body = {};
      let question = "";

      try {
        body = await parseBody(req);
        console.log(`📦 [/api/ai] 原始请求体:`, JSON.stringify(body).substring(0, 200));
      } catch (parseError) {
        console.warn(`⚠️ [/api/ai] 请求体解析失败:`, parseError.message);
      }

      // 检测是否为流式请求
      const isStream = body?.stream === true || 
                       req.headers.accept === 'text/event-stream' ||
                       req.headers['accept'] === 'text/event-stream';

      // 支持多种请求格式
      if (typeof body === "object" && body !== null) {
        question = body.question || body.text || body.message || body.content || body.prompt || "";
        
        // 支持 OpenCode parts 格式
        if (!question && body.parts && Array.isArray(body.parts)) {
          const textParts = body.parts.filter(p => p.type === "text" && p.text);
          question = textParts.map(p => p.text).join("\n");
        }

        // 如果还是空，尝试取第一个字符串字段
        if (!question) {
          const firstStringVal = Object.values(body).find(v => typeof v === "string" && v.trim());
          if (firstStringVal) question = firstStringVal;
        }
      } else if (typeof body === "string") {
        question = body;
      }

      if (!question || !question.trim()) {
        return sendError(res, "请提供问题内容（支持 question/text/message/parts 等格式）", 400);
      }

      question = question.trim();
      console.log(`\n💬 [/api/ai] 收到问题: "${question.substring(0, 100)}${question.length > 100 ? '...' : ''}"${isStream ? ' [流式模式]' : ''}`);

      if (!openai) {
        return sendError(res, "AI 服务未配置，请设置 OPENAI_API_KEY", 503);
      }

      const { miNA, device } = await init();
      const settings = await loadSettings();
      const systemPrompt = settings.systemPrompt || "你是小爱音箱的智能助手，回答简洁有趣，适合语音播放。";

      // ========== 流式模式 (SSE) ==========
      if (isStream && sessionManager) {
        console.log(`🔄 [/api/ai] 使用 OpenCode 流式模式 (SSE)...`);
        
        res.writeHead(200, {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          'Connection': 'keep-alive',
          'X-Accel-Buffering': 'no'
        });

        const sendSSE = (event, data) => {
          res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
        };

        try {
          sendSSE('status', { type: 'start', message: '正在连接 OpenCode...' });

          const result = await sessionManager.chatStream(
            { text: question, systemPrompt },
            {
              model: settings.modelName || "gpt-4o-mini",
              temperature: 0.7,
              maxTokens: 300,
              directory: "api-ai-stream",
              onChunk: (chunk) => {
                if (chunk.isPartial) {
                  sendSSE('chunk', { 
                    content: chunk.chunk, 
                    totalSize: chunk.totalSize,
                    chunkIndex: chunk.chunkIndex 
                  });
                }
                if (chunk.done) {
                  sendSSE('done', { content: chunk.content });
                }
              }
            }
          );

          const answer = result.content;
          
          // 保存历史 + TTS
          conversationHistory.push({ role: "user", content: question });
          conversationHistory.push({ role: "assistant", content: answer });
          if (conversationHistory.length > 20) {
            conversationHistory = conversationHistory.slice(-20);
          }
          await saveConversationHistory(conversationHistory);

          const ttsResult = await miNA.ubus("mibrain", "text_to_speech", { text: answer }, device.deviceID);
          const ttsSuccess = ttsResult?.code === 0;
          await addHistoryLog("ai", { question, answer, success: ttsSuccess });

          sendSSE('complete', { success: true, data: { question, answer }, ttsSuccess });
          res.end();
          console.log(`✅ [/api/ai] 流式响应完成`);

        } catch (streamError) {
          console.error(`❌ [/api/ai] 流式失败:`, streamError.message);
          sendSSE('error', { error: streamError.message });
          res.end();
        }
        return;
      }

      // ========== 非流式模式（原有逻辑）==========
      let answer = "";

      // 优先使用 SessionManager（OpenCode 模式）
      if (sessionManager) {
        try {
          console.log(`🔄 [/api/ai] 使用 OpenCode 会话模式...`);
          const result = await sessionManager.chat(
            {
              text: question,
              systemPrompt: systemPrompt
            },
            {
              model: settings.modelName || "gpt-4o-mini",
              temperature: 0.7,
              maxTokens: 300,
              directory: "api-ai"
            }
          );
          answer = result.content;
          console.log(`✅ [/api/ai] OpenCode 模式响应成功`);
        } catch (sessionError) {
          console.warn(`⚠️ [/api/ai] OpenCode 模式失败，回退到直接调用:`, sessionError.message);
          
          const messages = [
            { role: "system", content: systemPrompt },
            ...conversationHistory,
            { role: "user", content: question },
          ];

          const response = await openai.chat.completions.create({
            model: settings.modelName || "gpt-4o-mini",
            messages,
            max_tokens: 300,
            temperature: 0.7,
          });

          answer = response.choices[0]?.message?.content?.trim() || "";
        }
      } else {
        console.log(`🔄 [/api/ai] 使用直接调用模式...`);
        const messages = [
          { role: "system", content: systemPrompt },
          ...conversationHistory,
          { role: "user", content: question },
        ];

        const response = await openai.chat.completions.create({
          model: settings.modelName || "gpt-4o-mini",
          messages,
          max_tokens: 300,
          temperature: 0.7,
        });

        answer = response.choices[0]?.message?.content?.trim() || "";
      }

      if (answer) {
        conversationHistory.push({ role: "user", content: question });
        conversationHistory.push({ role: "assistant", content: answer });
        if (conversationHistory.length > 20) {
          conversationHistory = conversationHistory.slice(-20);
        }

        await saveConversationHistory(conversationHistory);

        // 通过小爱音箱播放回答
        const ttsResult = await miNA.ubus(
          "mibrain",
          "text_to_speech",
          { text: answer },
          device.deviceID
        );

        const ttsSuccess = ttsResult?.code === 0;
        await addHistoryLog("ai", { question, answer, success: ttsSuccess });

        if (!ttsSuccess) {
          console.warn("⚠️ TTS 播放失败:", ttsResult);
        }
      } else {
        console.warn(`⚠️ [/api/ai] AI 返回空响应`);
        await addHistoryLog("ai", { question, answer: "", error: "AI 返回空响应" });
      }

      sendJSON(res, { success: true, data: { question, answer } });
    } catch (error) {
      console.error(`❌ [/api/ai] 处理失败:`, error);
      await addHistoryLog("ai", { question: "未知", answer: "", error: error.message });
      sendError(res, error.message || "处理请求时发生错误");
    }
  },

  // 获取任务列表
  "GET /api/schedules": async (req, res) => {
    try {
      const schedules = await loadSchedules();
      sendJSON(res, { success: true, data: schedules });
    } catch (error) {
      sendError(res, error.message);
    }
  },

  // 添加任务
  "POST /api/schedules": async (req, res) => {
    try {
      const body = await parseBody(req);
      const { text, type, cron, interval, at, taskType, command } = body;

      // 验证taskType
      if (taskType && !["text", "command"].includes(taskType)) {
        return sendError(res, "taskType 必须是 text 或 command");
      }

      // 根据任务类型验证必填参数
      if (taskType === "command") {
        if (!command) return sendError(res, "命令任务请提供 command 参数");
      } else {
        if (!text) return sendError(res, "文本任务请提供 text 参数");
      }

      if (!type || !["cron", "interval", "once"].includes(type)) {
        return sendError(res, "type 必须是 cron、interval 或 once");
      }

      const schedule = {
        id: generateId(),
        text,
        taskType: taskType || "text",
        command,
        type,
        createdAt: new Date().toISOString(),
        lastRun: null,
        runCount: 0,
      };

      if (type === "cron") schedule.cron = cron;
      if (type === "interval") schedule.interval = parseInt(interval);
      if (type === "once") schedule.at = at;

      const schedules = await loadSchedules();
      schedules.push(schedule);
      await saveSchedules(schedules);

      // ✅ 注册定时器到内存（立即生效）
      createTimer(schedule);

      sendJSON(res, { success: true, data: schedule });
    } catch (error) {
      sendError(res, error.message);
    }
  },

  // 批量删除任务（必须在 :id 路由之前）
  "DELETE /api/schedules/batch": async (req, res) => {
    try {
      const body = await parseBody(req);
      const { ids } = body;

      if (!Array.isArray(ids) || ids.length === 0) {
        return sendError(res, "请提供要删除的任务ID列表");
      }

      const schedules = await loadSchedules();
      const removed = [];
      const remaining = schedules.filter(s => {
        if (ids.includes(s.id)) {
          removed.push(s);
          return false;
        }
        return true;
      });

      if (removed.length === 0) {
        return sendError(res, "没有找到匹配的任务", 404);
      }

      await saveSchedules(remaining);

      // ✅ 从内存中批量取消定时器
      for (const item of removed) {
        if (scheduleTimers.has(item.id)) {
          clearTimeout(scheduleTimers.get(item.id));
          scheduleTimers.delete(item.id);
        }

        await addHistoryLog("schedule_delete", {
          scheduleId: item.id,
          text: item.text,
          type: item.type
        });
      }

      console.log(`⏰ [Scheduler] 批量移除 ${removed.length} 个定时器`);

      sendJSON(res, { success: true, data: { deleted: removed.length, items: removed } });
    } catch (error) {
      sendError(res, error.message);
    }
  },

  // 删除单个任务
  "DELETE /api/schedules/:id": async (req, res, id) => {
    try {
      const schedules = await loadSchedules();
      const index = schedules.findIndex(s => s.id === id);
      if (index === -1) return sendError(res, "任务不存在", 404);

      const removed = schedules.splice(index, 1)[0];
      await saveSchedules(schedules);

      // ✅ 从内存中取消定时器（立即生效）
      if (scheduleTimers.has(id)) {
        clearTimeout(scheduleTimers.get(id));
        scheduleTimers.delete(id);
        console.log(`⏰ [Scheduler] 已从内存中移除定时器: ${id}`);
      }

      await addHistoryLog("schedule_delete", {
        scheduleId: removed.id,
        text: removed.text,
        type: removed.type
      });

      sendJSON(res, { success: true, data: removed });
    } catch (error) {
      sendError(res, error.message);
    }
  },

  // ==================== AI 统一控制接口 v2.0 ====================
  
  /**
   * POST /api/ai/control
   * 
   * 统一的AI任务处理入口
   * - 自动识别意图（创建目标/生成计划/查询状态/纯对话）
   * - 使用 OpenCode 文件生成模式
   * - 支持混合响应（文件+对话）
   */
  "POST /api/ai/control": async (req, res) => {
    try {
      if (!smartTaskGenerator) {
        return sendError(res, '智能任务生成器未初始化', 503);
      }

      const body = await parseBody(req);
      const { command, context } = body;

      if (!command || typeof command !== 'string' || command.trim().length === 0) {
        return sendError(res, '请提供 command 参数（用户命令/请求）');
      }

      if (command.length > 1000) {
        return sendError(res, '输入过长，请简化描述（最大1000字符）');
      }

      // ✅ 提取自定义提示词和目标日期
      const customSystemPrompt = context?.systemPrompt || null;
      const customUserPrompt = context?.userPrompt || null;
      const targetDate = context?.targetDate || null;  // ✅ 目标日期: 'today' | 'tomorrow' | 'YYYY-MM-DD'
      const dayOffset = context?.dayOffset || null;   // ✅ 第几天偏移量（多日生成时使用）

      console.log(`\n🤖 [API] /api/ai/control 收到请求:`);
      console.log(`   命令: ${command.substring(0, 80)}...`);
      console.log(`   来源: ${context?.source || 'unknown'}`);
      if (customSystemPrompt) {
        console.log(`   📝 自定义系统提示词: ${customSystemPrompt.substring(0, 50)}... (${customSystemPrompt.length}字符)`);
      }
      if (customUserPrompt) {
        console.log(`   💬 用户额外提示: ${customUserPrompt.substring(0, 50)}...`);
      }
      if (targetDate) {
        console.log(`   📅 目标日期: ${targetDate}`);
      }
      if (dayOffset) {
        console.log(`   📆 天数偏移: Day ${dayOffset}`);
      }

      const startTime = Date.now();

      // 调用智能任务生成器（传入自定义提示词和目标日期）
      const result = await smartTaskGenerator.processCommand(command, {
        customSystemPrompt,
        customUserPrompt,
        targetDate,
        dayOffset  // ✅ 传递天数偏移
      });

      const duration = Date.now() - startTime;

      console.log(`✅ [API] /api/ai/control 处理完成 (${duration}ms):`);
      console.log(`   成功: ${result.success}`);
      console.log(`   类型: ${result.responseType}`);

      // 构建标准响应
      const responseData = {
        success: result.success,
        data: {
          summary: result.replyToUser || '',
          responseType: result.responseType,
          processingTime: result.processingTime || duration,

          // 🔑 核心数据：如果有的话（目标/计划等完整数据对象）
          ...(result.data ? { data: result.data } : {}),

          // 如果有实体数据（目标/计划等摘要信息）
          ...(result.entity ? { entity: result.entity } : {}),

          // 生成的文件信息
          generatedFiles: (result.generatedFiles || []).map(f => ({
            path: f.path,
            filename: f.filename,
            type: f.contentType,
            valid: f.valid,
            size: f.size,
            generatedBy: f.generatedBy
          })),

          // 尝试次数（用于调试）
          attempts: result.attempts,

          // 是否使用了降级方案
          usedFallback: result.usedFallback || false,

          // 其他元信息
          ...(result.note ? { note: result.note } : {}),
          ...(result.filePath ? { filePath: result.filePath } : {})
        },

        timestamp: result.timestamp || new Date().toISOString()
      };

      if (result.error && !result.success) {
        responseData.error = result.error;
      }

      sendJSON(res, responseData);

    } catch (error) {
      console.error(`❌ [API] /api/ai/control 错误:`, error.message);
      sendError(res, `AI处理失败: ${error.message}`, 500);
    }
  },

  /**
   * GET /api/ai/status
   * 
   * 获取 AI 系统状态和统计信息
   */
  "GET /api/ai/status": async (req, res) => {
    try {
      const status = {
        initialized: !!smartTaskGenerator,
        sessionManagerReady: !!sessionManager,
        goalManagerReady: !!goalManager,
        components: {
          smartTaskGenerator: !!smartTaskGenerator,
          goalParser: !!goalParser,
          dynamicAdjuster: !!dynamicAdjuster,
          sessionManager: !!sessionManager
        },
        version: '2.0',
        mode: 'opencode-file-generation'
      };

      if (smartTaskGenerator) {
        status.stats = smartTaskGenerator.getStats();
      }

      sendJSON(res, { success: true, data: status });
    } catch (error) {
      sendError(res, error.message);
    }
  },

  // 获取操作历史记录
  "GET /api/history": async (req, res) => {
    try {
      const logs = await loadHistory();
      sendJSON(res, { success: true, data: logs });
    } catch (error) {
      sendError(res, error.message);
    }
  },

  // 清空操作历史记录
  "DELETE /api/history": async (req, res) => {
    try {
      await saveHistory([]);
      sendJSON(res, { success: true });
    } catch (error) {
      sendError(res, error.message);
    }
  },

  // 刷新定时任务（重新加载并启动）
  "POST /api/schedules/refresh": async (req, res) => {
    try {
      stopAllTimers();
      await startSchedules();
      sendJSON(res, { success: true });
    } catch (error) {
      sendError(res, error.message);
    }
  },

  // 获取设置
  "GET /api/settings": async (req, res) => {
    try {
      const settings = await loadSettings();
      sendJSON(res, { success: true, data: settings });
    } catch (error) {
      sendError(res, error.message);
    }
  },

  // 保存设置
  "POST /api/settings": async (req, res) => {
    try {
      const body = await parseBody(req);
      const { apiKey, modelName, apiBaseUrl, systemPrompt } = body;

      if (!apiKey) {
        return sendError(res, "请提供 API 密钥");
      }

      const settings = {
        apiKey,
        modelName: modelName || "gpt-4o-mini",
        apiBaseUrl: apiBaseUrl || "",
        systemPrompt: systemPrompt || "你是小爱音箱的智能助手，回答简洁有趣，适合语音播放，控制在100字以内。",
        updatedAt: new Date().toISOString(),
      };

      await saveSettings(settings);

      // 重新初始化 OpenAI
      openai = new OpenAI({
        apiKey: settings.apiKey,
        baseURL: settings.apiBaseUrl || undefined,
      });

      sendJSON(res, { success: true, data: settings });
    } catch (error) {
      sendError(res, error.message);
    }
  },

  // ==================== 任务规划接口（对话式任务管理 - 基于 OpenAI）====================

  // 获取任务规划服务状态
  "GET /api/task-planner/status": async (req, res) => {
    try {
      await init();
      
      if (!taskPlannerService) {
        return sendJSON(res, { 
          success: false, 
          message: "任务规划服务未初始化，请检查 OpenAI 配置",
          initialized: false 
        });
      }

      const sessions = taskPlannerService.listSessions();
      const tools = getAvailableTools();
      
      sendJSON(res, {
        success: true,
        data: {
          initialized: true,
          activeSessions: sessions.total,
          availableTools: tools.length,
          toolNames: tools.map(t => t.name),
          sessions: sessions.sessions.slice(0, 10),
        }
      });
    } catch (error) {
      sendError(res, error.message);
    }
  },

  // 创建新的会话
  "POST /api/task-planner/session": async (req, res) => {
    try {
      await init();
      
      if (!taskPlannerService) {
        taskPlannerService = await getTaskPlannerService();
      }

      const body = await parseBody(req);
      const sessionId = body.sessionId || null;
      
      const result = taskPlannerService.createSession(sessionId);
      sendJSON(res, result);
    } catch (error) {
      console.error("创建会话失败:", error);
      sendError(res, error.message);
    }
  },

  // 发送消息（SSE 流式响应）
  "POST /api/task-planner/chat": async (req, res) => {
    try {
      await init();
      
      if (!taskPlannerService) {
        return sendError(res, "任务规划服务未初始化");
      }

      const body = await parseBody(req);
      const { message, sessionId } = body;

      if (!message || !message.trim()) {
        return sendError(res, "消息不能为空");
      }

      let sid = sessionId;
      if (!sid || !taskPlannerService.getSessionStatus(sid).exists) {
        const sessionResult = taskPlannerService.createSession();
        sid = sessionResult.sessionId;
      }

      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        "Connection": "keep-alive",
        "X-Accel-Buffering": "no",
        "Access-Control-Allow-Origin": "*",
      });

      res.write(`data: ${JSON.stringify({ type: "connected", sessionId: sid })}\n\n`);

      await taskPlannerService.chat(sid, message.trim(), (chunk) => {
        const data = `data: ${JSON.stringify(chunk)}\n\n`;
        res.write(data);

        if (chunk.type === "done" || chunk.type === "error" || chunk.type === "timeout") {
          res.end();
        }
      });

    } catch (error) {
      console.error("聊天失败:", error);
      
      if (!res.headersSent) {
        sendError(res, error.message);
      } else {
        const errorData = `data: ${JSON.stringify({ type: "error", content: error.message })}\n\n`;
        res.write(errorData);
        res.end();
      }
    }
  },

  // 快速聊天（非流式）
  "POST /api/task-planner/chat/simple": async (req, res) => {
    try {
      await init();
      
      if (!taskPlannerService) {
        taskPlannerService = await getTaskPlannerService();
      }

      const body = await parseBody(req);
      const { message, sessionId } = body;

      if (!message || !message.trim()) {
        return sendError(res, "消息不能为空");
      }

      let sid = sessionId;
      if (!sid || !taskPlannerService.getSessionStatus(sid).exists) {
        const sessionResult = taskPlannerService.createSession();
        sid = sessionResult.sessionId;
      }

      const result = await taskPlannerService.chatSimple(sid, message.trim());
      sendJSON(res, result);

    } catch (error) {
      console.error("快速聊天失败:", error);
      sendError(res, error.message);
    }
  },

  // 获取会话状态
  "GET /api/task-planner/session/:sessionId": async (req, res, sessionId) => {
    try {
      await init();
      
      if (!taskPlannerService) {
        return sendError(res, "任务规划服务未初始化");
      }

      const status = taskPlannerService.getSessionStatus(sessionId);
      sendJSON(res, { success: true, data: status });

    } catch (error) {
      sendError(res, error.message);
    }
  },

  // 销毁会话
  "DELETE /api/task-planner/session/:sessionId": async (req, res, sessionId) => {
    try {
      await init();
      
      if (!taskPlannerService) {
        return sendError(res, "任务规划服务未初始化");
      }

      const result = taskPlannerService.destroySession(sessionId);
      sendJSON(res, result);

    } catch (error) {
      sendError(res, error.message);
    }
  },

  // 列出所有活跃会话
  "GET /api/task-planner/sessions": async (req, res) => {
    try {
      await init();
      
      if (!taskPlannerService) {
        return sendError(res, "任务规划服务未初始化");
      }

      const sessions = taskPlannerService.listSessions();
      sendJSON(res, { success: true, data: sessions });

    } catch (error) {
      sendError(res, error.message);
    }
  },

  // 清理过期会话
  "POST /api/task-planner/cleanup": async (req, res) => {
    try {
      await init();
      
      if (!taskPlannerService) {
        return sendError(res, "任务规划服务未初始化");
      }

      const body = await parseBody(req);
      const maxAge = body.maxAge || 3600000;
      
      const result = taskPlannerService.cleanupExpiredSessions(maxAge);
      sendJSON(res, { success: true, data: result });

    } catch (error) {
      sendError(res, error.message);
    }
  },

  // 获取可用工具列表
  "GET /api/task-planner/tools": async (req, res) => {
    try {
      const tools = getAvailableTools();
      sendJSON(res, { 
        success: true, 
        data: {
          count: tools.length,
          tools: tools
        }
      });
    } catch (error) {
      sendError(res, error.message);
    }
  },
};

// ==================== 静态文件服务 ====================

async function serveStatic(req, res) {
  let filePath = path.join(__dirname, "public", req.url === "/" ? "index.html" : req.url);

  // 防止目录遍历
  if (!filePath.startsWith(path.join(__dirname, "public"))) {
    return sendError(res, "Forbidden", 403);
  }

  try {
    const stat = await fs.stat(filePath);
    if (stat.isDirectory()) {
      filePath = path.join(filePath, "index.html");
    }

    const ext = path.extname(filePath).toLowerCase();
    const mimeTypes = {
      ".html": "text/html; charset=utf-8",
      ".js": "application/javascript; charset=utf-8",
      ".css": "text/css; charset=utf-8",
      ".json": "application/json",
      ".png": "image/png",
      ".jpg": "image/jpeg",
      ".gif": "image/gif",
      ".svg": "image/svg+xml",
    };

    const content = await fs.readFile(filePath);
    res.writeHead(200, { "Content-Type": mimeTypes[ext] || "application/octet-stream" });
    res.end(content);
  } catch {
    // 404 - 返回 index.html（支持前端路由）
    try {
      const indexPath = path.join(__dirname, "public", "index.html");
      const content = await fs.readFile(indexPath);
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(content);
    } catch {
      sendError(res, "Not Found", 404);
    }
  }
}

// ==================== 主服务器 ====================

const server = http.createServer(async (req, res) => {
  // CORS
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }

  const url = new URL(req.url, `http://${req.headers.host}`);
  const pathname = url.pathname;

  console.log(`${req.method} ${pathname}`);

  // API 路由
  const routeKey = `${req.method} ${pathname}`;
  const dynamicRoute = Object.keys(routes).find(r => {
    if (!r.includes(":")) return r === routeKey;
    const pattern = r.replace(/:\w+/g, "([^/]+)");
    const regex = new RegExp(`^${pattern}$`);
    return regex.test(routeKey);
  });

  if (dynamicRoute) {
    // 提取动态参数
    const paramMatch = dynamicRoute.match(/:(\w+)/g);
    let params = [];
    if (paramMatch) {
      const pattern = dynamicRoute.replace(/:\w+/g, "([^/]+)");
      const regex = new RegExp(`^${pattern}$`);
      const matches = routeKey.match(regex);
      params = matches ? matches.slice(1) : [];
    }
    await routes[dynamicRoute](req, res, ...params);
    return;
  }

  // 静态文件
  await serveStatic(req, res);
});

// 初始化并启动
async function start() {
  try {
    await init();
    console.log("✅ 小米服务已初始化");

    await startSchedules();

    // 启动 AI 每日规划自动调度器
    await startAutoPlanner();

    server.listen(PORT, () => {
      console.log(`\n🌐 服务器已启动: http://localhost:${PORT}`);
      console.log("📁 请在 public/ 目录放置前端文件\n");
    });
  } catch (error) {
    console.error("❌ 启动失败:", error.message);
    process.exit(1);
  }
}

start();
