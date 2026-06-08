/**
 * Pi SDK 定时任务规划工具集
 *
 * 为 Pi 编程代理提供小爱音箱任务管理的工具：
 * - 读取/列出任务
 * - 添加新任务（支持自然语言时间描述）
 * - 更新/删除任务
 * - 生成温馨提示语
 * - 每日智能规划
 *
 * 使用方式：
 * 在 createAgentSession() 的 tools 参数中使用这些工具
 */

import fs from "fs-extra";
import path from "path";
import { fileURLToPath } from "url";
import https from "https";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const SCHEDULES_FILE = path.join(__dirname, ".schedules.json");

// ==================== 工具定义 ====================

export const taskTools = [
  {
    name: "list_tasks",
    description: "列出所有定时任务，可以按类型、时间过滤",
    parameters: {
      type: "object",
      properties: {
        filter: {
          type: "string",
          enum: ["all", "workday", "weekend", "holiday", "daily", "weather"],
          description: "任务类型过滤器",
        },
        timeRange: {
          type: "string",
          description: "时间范围，如 'morning', 'afternoon', 'evening'",
        },
      },
    },
    async function({ filter = "all", timeRange } = {}) {
      const tasks = await _loadSchedules();

      let filtered = tasks;

      if (filter !== "all") {
        filtered = tasks.filter(task => {
          const cron = task.cron || "";
          // 分割 cron 表达式后精确匹配第5位（星期），避免误匹配其他字段中的数字
          const cronParts = cron.split(/\s+/);
          if (cronParts.length >= 5) {
            const dayOfWeek = cronParts[4];
            if (filter === "workday") return /^[1-5]$/.test(dayOfWeek);
            if (filter === "weekend") return /^[067]$/.test(dayOfWeek);
          }
          if (filter === "holiday") return task.note?.includes("节日");
          if (filter === "daily") return /\* \* \*$/.test(cron);
          if (filter === "weather") return task.taskType === "weather";
          return true;
        });
      }

      if (timeRange) {
        const hourMap = {
          morning: [6, 12],
          afternoon: [12, 18],
          evening: [18, 24],
          night: [0, 6],
        };
        const [start, end] = hourMap[timeRange] || [0, 24];
        filtered = filtered.filter(task => {
          const hour = parseInt((task.cron || "").split(" ")[1]);
          return hour >= start && hour < end;
        });
      }

      return {
        success: true,
        count: filtered.length,
        tasks: filtered.map(t => ({
          id: t.id,
          text: t.text.substring(0, 50) + (t.text.length > 50 ? "..." : ""),
          cron: t.cron,
          type: t.taskType || "text",
          lastRun: t.lastRun,
          runCount: t.runCount || 0,
        })),
      };
    },
  },

  {
    name: "add_task",
    description:
      "添加新的定时任务。支持自然语言时间描述，如'每天早上7点'、'工作日8点半'、'周末上午10点'" +
      "自动将自然语言转换为 cron 表达式。可以指定任务类型（text/weather）。",
    parameters: {
      type: "object",
      properties: {
        description: {
          type: "string",
          description: "任务的详细描述，包括时间和内容。例如：'每天早上7:30提醒孩子们起床，语气要温柔'",
        },
        text: {
          type: "string",
          description: "小爱音箱要播报的具体文字内容",
        },
        time: {
          type: "string",
          description: "时间描述，如：'每天早上7点'、'工作日8:30'、'周末10点'、'每小时'、'每2小时'",
        },
        taskType: {
          type: "string",
          enum: ["text", "weather"],
          description: "任务类型：text=普通播报, weather=天气播报",
        },
        category: {
          type: "string",
          enum: ["wake-up", "meal", "activity", "sleep", "reminder", "greeting"],
          description: "任务分类",
        },
      },
      required: ["description", "text", "time"],
    },
    async function({ description, text, time, taskType = "text", category }) {
      try {
        // 解析时间为 cron 表达式
        const cron = _parseNaturalTime(time);

        if (!cron) {
          return {
            success: false,
            error: `无法解析时间表达式: "${time}"。请使用更明确的时间描述`,
            examples: [
              "每天早上7点",
              "工作日8:30",
              "周末上午10点",
              "每小时",
              "每天12点和18点",
            ],
          };
        }

        // 生成唯一 ID
        const id = _generateId(description);

        // 创建任务对象
        const task = {
          id,
          text,
          taskType,
          type: "cron",
          cron,
          category,
          description,
          createdAt: new Date().toISOString(),
          lastRun: null,
          runCount: 0,
        };

        // 保存到文件
        await _addTaskToFile(task);

        return {
          success: true,
          task: {
            id,
            text,
            cron,
            humanReadableTime: time,
            taskType,
          },
          message: `✅ 已添加任务: "${text}" (${time} → ${cron})`,
        };
      } catch (error) {
        return {
          success: false,
          error: error.message,
        };
      }
    },
  },

  {
    name: "update_task",
    description: "更新已有任务的内容、时间或状态",
    parameters: {
      type: "object",
      properties: {
        taskId: {
          type: "string",
          description: "要更新的任务 ID（可用 list_tasks 获取）",
        },
        newText: {
          type: "string",
          description: "新的播报文字内容",
        },
        newTime: {
          type: "string",
          description: "新的时间描述，如'改为早上8点'",
        },
        enabled: {
          type: "boolean",
          description: "是否启用该任务",
        },
      },
      required: ["taskId"],
    },
    async function({ taskId, newText, newTime, enabled }) {
      const tasks = await _loadSchedules();
      const taskIndex = tasks.findIndex(t => t.id === taskId);

      if (taskIndex === -1) {
        return {
          success: false,
          error: `未找到任务 ID: ${taskId}`,
          hint: "请先使用 list_tasks 查看所有任务",
        };
      }

      const task = tasks[taskIndex];
      const changes = [];

      if (newText) {
        task.text = newText;
        changes.push(`内容: "${newText}"`);
      }

      if (newTime) {
        const newCron = _parseNaturalTime(newTime);
        if (!newCron) {
          return {
            success: false,
            error: `无法解析时间: ${newTime}`,
          };
        }
        task.cron = newCron;
        changes.push(`时间: ${newTime} (${newCron})`);
      }

      if (enabled !== undefined) {
        task.enabled = enabled;
        changes.push(`状态: ${enabled ? "启用" : "禁用"}`);
      }

      await _saveSchedules(tasks);

      return {
        success: true,
        updatedTask: {
          id: task.id,
          text: task.text,
          cron: task.cron,
        },
        changes,
        message: `✅ 已更新任务 "${task.id}": ${changes.join(", ")}`,
      };
    },
  },

  {
    name: "delete_task",
    description: "删除指定的定时任务",
    parameters: {
      type: "object",
      properties: {
        taskId: {
          type: "string",
          description: "要删除的任务 ID",
        },
        reason: {
          type: "string",
          description: "删除原因（用于日志记录）",
        },
      },
      required: ["taskId"],
    },
    async function({ taskId, reason }) {
      const tasks = await _loadSchedules();
      const taskIndex = tasks.findIndex(t => t.id === taskId);

      if (taskIndex === -1) {
        return {
          success: false,
          error: `未找到任务 ID: ${taskId}`,
        };
      }

      const deleted = tasks.splice(taskIndex, 1)[0];
      await _saveSchedules(tasks);

      return {
        success: true,
        deletedTask: {
          id: deleted.id,
          text: deleted.text,
        },
        reason,
        message: `🗑️ 已删除任务: "${deleted.text}"${reason ? ` (${reason})` : ""}`,
      };
    },
  },

  {
    name: "generate_warm_text",
    description:
      "生成温馨、生动的小爱音箱提示语。" +
      "根据场景（起床、吃饭、睡觉等）、目标受众（孩子、家人）和情感基调生成合适的文字。" +
      "应该有温度、有趣、适合语音播放。",
    parameters: {
      type: "object",
      properties: {
        scene: {
          type: "string",
          enum: [
            "wake-up",
            "breakfast",
            "lunch",
            "dinner",
            "snack",
            "nap",
            "bedtime",
            "story",
            "bath",
            "activity",
            "greeting",
            "reminder",
            "celebration",
            "weather",
          ],
          description: "场景类型",
        },
        audience: {
          type: "string",
          description: "目标受众，如：孩子们、宝贝们、家人们",
        },
        tone: {
          type: "string",
          enum: ["gentle", "energetic", "funny", "warm", "encouraging"],
          description: "情感基调",
        },
        context: {
          type: "string",
          description: "额外上下文，如：今天周五了、明天是周末、外面下雪了",
        },
        maxLength: {
          type: "number",
          description: "最大字数（默认100字）",
        },
      },
      required: ["scene", "audience"],
    },
    async function({ scene, audience, tone = "warm", context, maxLength = 100 }) {
      // 这个工具返回场景信息，让 AI 根据这些信息生成文本
      // 实际的文本生成由 AI 完成，这里只提供结构化信息
      return {
        success: true,
        guidelines: {
          scene,
          audience,
          tone,
          context,
          maxLength,
          styleGuide: `
            - 语气要${tone === "gentle" ? "轻柔温和" : tone === "energetic" ? "充满活力" : tone === "funny" ? "幽默有趣" : "温暖亲切"}
            - 称呼使用"${audience}"
            - 适合语音播放，口语化表达
            - 可以加入互动元素（提问、邀请等）
            - 控制在 ${maxLength} 字以内
            ${context ? `- 结合当前情况: ${context}` : ""}
          `.trim(),
        },
        examples: _getTextExamples(scene, audience),
      };
    },
  },

  {
    name: "daily_planning",
    description:
      "智能每日规划！这是核心功能。" +
      "根据日期（工作日/周末/节假日）、天气、特殊事件等因素，" +
      "**自动创建**合适的定时任务！" +
      "例如：明天周六且天气预报有雨，会自动创建室内活动提醒任务。" +
      "调用此工具后，会直接创建任务，无需手动操作。",
    parameters: {
      type: "object",
      properties: {
        date: {
          type: "string",
          description: "要规划的日期（YYYY-MM-DD），默认为明天",
        },
        weather: {
          type: "string",
          description: "天气预报，如：晴、多云、雨、雪",
        },
        specialEvents: {
          type: "array",
          items: { type: "string" },
          description: "特殊事件，如：['生日', '考试', '出游']",
        },
        preferences: {
          type: "object",
          properties: {
            wakeUpEarly: { type: "boolean" },
            moreActivities: { type: "boolean" },
            quietEvening: { type: "boolean" },
          },
          description: "当日偏好设置",
        },
        autoCreateTasks: {
          type: "boolean",
          description: "是否自动创建任务，默认为 true",
          default: true,
        },
      },
    },
    async function({ date, weather, specialEvents = [], preferences = {}, autoCreateTasks = true }) {
      const targetDate = date ? new Date(date) : new Date(Date.now() + 86400000);
      const dayOfWeek = targetDate.getDay();
      const isWeekend = dayOfWeek === 0 || dayOfWeek === 6;

      // 自动获取天气信息（如果没有提供
      let finalWeather = weather;
      if (!finalWeather) {
        console.log("🌤️ 正在获取天气信息...");
        finalWeather = await _getWeather(targetDate);
        console.log("🌤️ 天气信息:", finalWeather);
      }

      // 自动获取节日和特殊事件（合并用户提供的
      const detectedEvents = _getSpecialEvents(targetDate);
      const finalEvents = [...new Set([...detectedEvents, ...specialEvents])];
      console.log("📅 检测到的特殊事件:", finalEvents);

      const existingTasks = await _loadSchedules();

      // 分析当天已有的任务
      const dayTasks = existingTasks.filter(t => {
        if (!t.cron) return false;
        const parts = t.cron.split(" ");
        const cronDay = parts[4]; // 星期几
        if (cronDay === "*") return true; // 每天都执行
        if (isWeekend && /[6-7]/.test(cronDay)) return true; // 周末任务
        if (!isWeekend && /1-5/.test(cronDay)) return true; // 工作日任务
        return false;
      });

      // 生成要创建的任务列表
      const tasksToCreate = _generateDailyTasks({
        isWeekend,
        weather: finalWeather,
        specialEvents: finalEvents,
        preferences,
        existingTaskCount: dayTasks.length,
      });

      const createdTasks = [];
      const skippedTasks = [];

      if (autoCreateTasks) {
        // 逐个创建任务
        for (const taskConfig of tasksToCreate) {
          try {
            // 检查是否已存在类似任务
            const exists = existingTasks.some(t => 
              t.text && t.text.includes(taskConfig.keywords[0])
            );
            
            if (!exists) {
              // 创建任务
              const cron = _parseNaturalTime(taskConfig.time);
              if (cron) {
                const task = {
                  id: _generateId(taskConfig.text),
                  text: taskConfig.text,
                  taskType: "text",
                  type: "cron",
                  cron,
                  category: taskConfig.category,
                  description: taskConfig.description,
                  createdAt: new Date().toISOString(),
                  lastRun: null,
                  runCount: 0,
                };
                
                await _addTaskToFile(task);
                createdTasks.push(task);
                console.log(`✅ 创建每日规划任务: ${task.text} (${cron})`);
              }
            } else {
              skippedTasks.push(taskConfig.text);
            }
          } catch (error) {
            console.error(`❌ 创建任务失败: ${taskConfig.text}`, error.message);
          }
        }
      }

      return {
        success: true,
        dateInfo: {
          date: targetDate.toISOString().split("T")[0],
          dayOfWeek: ["周日", "周一", "周二", "周三", "周四", "周五", "周六"][dayOfWeek],
          isWeekend,
          isHoliday: _isHoliday(targetDate),
        },
        weather: finalWeather,
        specialEvents: finalEvents,
        existingTasks: dayTasks.length,
        tasksCreated: createdTasks.length,
        tasksSkipped: skippedTasks.length,
        createdTasks: createdTasks.map(t => ({
          id: t.id,
          text: t.text,
          cron: t.cron,
          category: t.category,
        })),
        skippedTasks,
        summary: autoCreateTasks 
          ? `已为您智能创建 ${createdTasks.length} 个任务！${finalWeather !== "未知" ? `（天气：${finalWeather}）` : ""}${finalEvents.length > 0 ? `（特殊事件：${finalEvents.join("、")}）` : ""}${skippedTasks.length > 0 ? `跳过了 ${skippedTasks.length} 个已存在的任务。` : ""}`
          : `生成了 ${tasksToCreate.length} 个任务建议（未自动创建）`,
      };
    },
  },

  {
    name: "batch_update_tasks",
    description:
      "批量更新多个任务，适用于季节变更、作息调整等场景。" +
      "例如：夏天到了，把所有起床时间提前30分钟；冬天了，把户外活动改成室内活动。",
    parameters: {
      type: "object",
      properties: {
        operation: {
          type: "string",
          enum: ["shift_time", "update_text_pattern", "enable_by_category", "disable_by_category"],
          description: "批量操作类型",
        },
        category: {
          type: "string",
          description: "任务分类筛选",
        },
        timeShiftMinutes: {
          type: "number",
          description: "时间偏移量（分钟），正数=延后，负数=提前",
        },
        textPattern: {
          type: "object",
          properties: {
            find: { type: "string" },
            replace: { type: "string" },
          },
          description: "文本替换规则",
        },
        reason: {
          type: "string",
          description: "批量操作原因",
        },
      },
      required: ["operation", "reason"],
    },
    async function({ operation, category, timeShiftMinutes, textPattern, reason }) {
      const tasks = await _loadSchedules();
      let updated = [];
      let errors = [];

      for (const task of tasks) {
        try {
          let modified = false;

          switch (operation) {
            case "shift_time":
              if (!category || task.category === category) {
                const newCron = _shiftCronTime(task.cron, timeShiftMinutes);
                if (newCron) {
                  task.cron = newCron;
                  modified = true;
                }
              }
              break;

            case "update_text_pattern":
              if (textPattern && task.text.includes(textPattern.find)) {
                task.text = task.text.replace(textPattern.find, textPattern.replace);
                modified = true;
              }
              break;

            case "enable_by_category":
              if (!category || task.category === category) {
                task.enabled = true;
                modified = true;
              }
              break;

            case "disable_by_category":
              if (!category || task.category === category) {
                task.enabled = false;
                modified = true;
              }
              break;
          }

          if (modified) {
            updated.push(task.id);
          }
        } catch (e) {
          errors.push({ taskId: task.id, error: e.message });
        }
      }

      await _saveSchedules(tasks);

      return {
        success: true,
        operation,
        reason,
        updatedCount: updated.length,
        updatedTaskIds: updated,
        errors,
        message: `✅ 批量更新完成: ${updated.length} 个任务已更新${reason ? ` (${reason})` : ""}`,
      };
    },
  },
];

// ==================== 辅助函数 ====================

async function _loadSchedules() {
  try {
    if (await fs.pathExists(SCHEDULES_FILE)) {
      return await fs.readJson(SCHEDULES_FILE);
    }
  } catch (error) {
    console.error("加载任务失败:", error.message);
  }
  return [];
}

async function _saveSchedules(tasks) {
  await fs.writeJson(SCHEDULES_FILE, tasks, { spaces: 2 });
}

async function _addTaskToFile(newTask) {
  const tasks = await _loadSchedules();
  tasks.push(newTask);
  await fs.writeJson(SCHEDULES_FILE, tasks, { spaces: 2 });
}

function _generateId(description) {
  const timestamp = Date.now().toString(36);
  const hash = description
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .substring(0, 20);
  return `${hash}-${timestamp}`;
}

function _parseNaturalTime(timeStr) {
  const str = timeStr.toLowerCase().trim();

  // 每天具体时间
  let match = str.match(/每天.*?(\d{1,2})[:：]?(\d{0,2})/);
  if (match) {
    const hour = parseInt(match[1]);
    const min = match[2] ? parseInt(match[2]) : 0;
    return `${min} ${hour} * * *`;
  }

  // 工作日
  match = str.match(/工作日.*?(\d{1,2})[:：]?(\d{0,2})/);
  if (match) {
    const hour = parseInt(match[1]);
    const min = match[2] ? parseInt(match[2]) : 0;
    return `${min} ${hour} * * 1-5`;
  }

  // 周末
  match = str.match(/周末.*?(\d{1,2})[:：]?(\d{0,2})/);
  if (match) {
    const hour = parseInt(match[1]);
    const min = match[2] ? parseInt(match[2]) : 0;
    return `${min} ${hour} * * 6-7`;
  }

  // 上午/下午/晚上 + 时间
  match = str.match(/(上午|下午|晚上).*?(\d{1,2})[:：]?(\d{0,2})/);
  if (match) {
    let hour = parseInt(match[2]);
    const min = match[3] ? parseInt(match[3]) : 0;
    if (match[1] === "下午" && hour < 12) hour += 12;
    if (match[1] === "晚上" && hour < 12) hour += 12;
    return `${min} ${hour} * * *`;
  }

  // 每N小时
  match = str.match(/每(\d+)\s*小时/);
  if (match) {
    const interval = parseInt(match[1]);
    return `0 */${interval} * * *`; // 简化实现
  }

  // 每N分钟
  match = str.match(/每(\d+)\s*分钟/);
  if (match) {
    const interval = parseInt(match[1]);
    return `*/${interval} * * * *`;
  }

  // 直接的 cron 表达式（以数字开头，包含多个空格分隔的字段）
  if (/^\d+\s+\d+\s+[\*\d]+\s+[\*\d]+\s+[\*\d]+$/.test(str.replace(/\s+/g, " ").trim())) {
    return str.replace(/\s+/g, " ").trim();
  }

  return null;
}

function _shiftCronTime(cron, minutes) {
  if (!cron) return null;

  const parts = cron.split(" ");
  if (parts.length !== 5) return null;

  let totalMinutes = parseInt(parts[1]) * 60 + parseInt(parts[0]);
  totalMinutes += minutes;

  if (totalMinutes < 0) totalMinutes += 1440;
  if (totalMinutes >= 1440) totalMinutes -= 1440;

  const newHour = Math.floor(totalMinutes / 60);
  const newMin = totalMinutes % 60;

  parts[0] = newMin.toString();
  parts[1] = newHour.toString();

  return parts.join(" ");
}

// ========== 天气 API 集成 ==========

async function _getWeather(date, city = "beijing") {
  try {
    // 使用 wttr.in JSON 格式，获取完整天气数据（含湿度、UV、风速等）
    const cityEn = _convertCityToEnglish(city);
    const url = `https://wttr.in/${cityEn}?format=j1`;

    console.log(`🌤️ [天气API] 正在获取 ${city} 的天气信息...`);

    return new Promise((resolve, reject) => {

      const timeoutId = setTimeout(() => {
        console.warn(`⚠️ [天气API] 获取 ${city} 天气超时，使用默认值`);
        resolve(_getDefaultWeather(city));
      }, 5000); // 5秒超时

      https.get(url, (res) => {
        clearTimeout(timeoutId);
        let data = '';

        res.on('data', (chunk) => {
          data += chunk;
        });

        res.on('end', () => {
          try {
            // 解析 JSON 天气数据
            const weatherText = data.trim();
            console.log(`✅ [天气API] ${city} 天气数据已获取`);

            if (weatherText && weatherText.length > 0 && !weatherText.includes('<html')) {
              const parsedWeather = _parseWeatherJson(weatherText);
              resolve({
                ...parsedWeather,
                city: city,
                cityEn: cityEn
              });
            } else {
              console.warn(`⚠️ [天气API] ${city} 返回无效数据，使用默认天气`);
              resolve(_getDefaultWeather(city));
            }
          } catch (error) {
            console.warn("⚠️ [天气API] 解析失败:", error.message);
            resolve(_getDefaultWeather(city));
          }
        });
      }).on('error', (error) => {
        clearTimeout(timeoutId);
        console.warn(`⚠️ [天气API] ${city} 网络错误:`, error.message);
        resolve(_getDefaultWeather(city));
      });
    });
  } catch (error) {
    console.warn("⚠️ [天气API] 异常:", error.message);
    return _getDefaultWeather(city);
  }
}

/**
 * 将中文城市名转换为英文（用于天气 API）
 */
function _convertCityToEnglish(city) {
  const cityMap = {
    '北京': 'beijing',
    '上海': 'shanghai',
    '广州': 'guangzhou',
    '深圳': 'shenzhen',
    '合肥': 'hefei',
    '杭州': 'hangzhou',
    '成都': 'chengdu',
    '武汉': 'wuhan',
    '西安': "xian",
    '南京': 'nanjing',
    '重庆': 'chongqing',
    '天津': 'tianjin',
    '苏州': 'suzhou'
  };
  
  return cityMap[city] || city.toLowerCase().replace(/\s+/g, '');
}

/**
 * 获取默认天气数据（当 API 失败时使用）
 */
function _getDefaultWeather(city) {
  return {
    weather: '晴',
    temp: '20°C',
    feelsLike: '20°C',
    humidity: '未知',
    uvIndex: '未知',
    windSpeed: '未知',
    visibility: '未知',
    city: city || '北京',
    tips: '天气信息暂未获取，请关注当地天气预报'
  };
}

/**
 * 解析 wttr.in 返回的 JSON 格式天气数据
 * 提取：天气状况、温度、湿度、UV指数、风速、体感温度等
 */
function _parseWeatherJson(jsonText) {
  const weatherMap = {
    'Sunny': '晴', 'Clear': '晴',
    'Partly cloudy': '多云', 'Cloudy': '阴', 'Overcast': '阴',
    'Rain': '雨', 'Light rain': '小雨', 'Heavy rain': '大雨',
    'Snow': '雪', 'Light snow': '小雪', 'Drizzle': '小雨',
    'Thunderstorm': '雷阵雨', 'Fog': '雾', 'Mist': '薄雾'
  };

  try {
    const json = JSON.parse(jsonText);
    const current = json.current_condition?.[0];
    if (!current) return _parseWeatherFallback(jsonText);

    // 天气状况
    const weatherEn = current.weatherDesc?.[0]?.value || 'Sunny';
    let weather = weatherMap[weatherEn] || '晴';

    // 温度
    const temp = `${current.temp_C || '?'}°C`;
    const tempNum = parseInt(current.temp_C) || 20;
    const feelsLike = `${current.FeelsLikeC || current.temp_C || '?'}°C`;

    // 湿度
    const humidity = current.humidity ? `${current.humidity}%` : '未知';

    // UV 指数
    const uvIndex = current.uvIndex || '0';
    let uvLevel = '低';
    if (uvIndex >= 8) uvLevel = '很高';
    else if (uvIndex >= 6) uvLevel = '高';
    else if (uvIndex >= 3) uvLevel = '中等';

    // 风速
    const windSpeed = current.windspeedKmph ? `${current.windspeedKmph} km/h` : '未知';

    // 能见度
    const visibility = current.visibility ? `${current.visibility} km` : '未知';

    // 生成提示
    let tips = '';
    if (tempNum >= 35) tips = '天气炎热，注意防暑降温，多喝水';
    else if (tempNum >= 28) tips = '天气较热，适合室内活动，注意补水';
    else if (tempNum <= 5) tips = '天气寒冷，注意保暖，外出添加衣物';
    else if (tempNum <= 15) tips = '天气微凉，适当增添衣物';
    else tips = '温度适宜，适合户外活动';

    if (weather.includes('雨')) tips += '，记得带伞☂️';
    else if (weather.includes('雪')) tips += '，注意路滑';
    else if (weather === '晴' && parseInt(uvIndex) >= 3) tips += '，紫外线较强注意防晒🌞';

    console.log(`🌤️ [天气解析] ${weather} ${temp} | 湿度:${humidity} | UV:${uvIndex}(${uvLevel}) | 风速:${windSpeed}`);

    return {
      weather,
      temp,
      feelsLike,
      humidity,
      uvIndex: `${uvIndex} (${uvLevel})`,
      windSpeed,
      visibility,
      tips
    };
  } catch (e) {
    console.warn("⚠️ [天气解析] JSON 解析失败，回退到文本模式:", e.message);
    return _parseWeatherFallback(jsonText);
  }
}

/**
 * 回退：尝试从文本中提取基础天气信息（兼容旧格式）
 */
function _parseWeatherFallback(text) {
  // 兼容旧文本格式：尝试提取基础信息
  const weatherMap = {
    'Sunny': '晴', 'Clear': '晴', 'Partly cloudy': '多云',
    'Cloudy': '阴', 'Rain': '雨', 'Snow': '雪'
  };
  let weather = '晴';
  for (const [en, zh] of Object.entries(weatherMap)) {
    if (text.includes(en)) { weather = zh; break; }
  }
  const tempMatch = text.match(/[+-]?\d+/);
  const temp = tempMatch ? `${tempMatch[0]}°C` : '未知';
  return { weather, temp, tips: '温度适宜，适合户外活动' };
}

// ========== 完善的节假日检测 ==========

function _getSpecialEvents(date) {
  const month = date.getMonth() + 1;
  const day = date.getDate();
  const weekday = date.getDay(); // 0 = 周日
  
  const events = [];

  // 固定日期节日
  const fixedHolidays = {
    "1-1": "元旦",
    "2-14": "情人节",
    "3-8": "妇女节",
    "5-1": "劳动节",
    "6-1": "儿童节",
    "10-1": "国庆节",
    "12-25": "圣诞节"
  };

  const fixedHoliday = fixedHolidays[`${month}-${day}`];
  if (fixedHoliday) {
    events.push(fixedHoliday);
  }

  // 农历节日（简化版
  // 春节通常在 1-2 月
  if (month === 1 || month === 2) {
    if (day >= 20 && day <= 31 || day >= 1 && day <= 20) {
      events.push("春节期间");
    }
  }

  // 母亲节：5月第二个周日
  if (month === 5 && weekday === 0 && day >= 8 && day <= 14) {
    events.push("母亲节");
  }

  // 父亲节：6月第三个周日
  if (month === 6 && weekday === 0 && day >= 15 && day <= 21) {
    events.push("父亲节");
  }

  // 感恩节：11月第四个周四
  if (month === 11 && weekday === 4 && day >= 22 && day <= 28) {
    events.push("感恩节");
  }

  // 周末检测
  if (weekday === 0 || weekday === 6) {
    events.push("周末");
  }

  return events;
}

function _isHoliday(date) {
  const events = _getSpecialEvents(date);
  return events.length > 0 ? events[0] : null;
}

function _generateDailyTasks({ isWeekend, weather, specialEvents, preferences, existingTaskCount }) {
  const tasks = [];

  // ========== 基础任务（无论工作日/周末） ==========
  
  // 起床
  tasks.push({
    time: isWeekend ? "每天早上8点" : "每天早上7点",
    text: isWeekend ? "宝贝们，早上好！周末到啦，今天可以好好玩一天哦！" : "宝贝们，早上好！新的一天开始咯！",
    category: "wake-up",
    description: isWeekend ? "周末起床提醒" : "工作日起床提醒",
    keywords: ["早上好", "起床"],
  });

  // 早餐
  tasks.push({
    time: isWeekend ? "每天上午8点30分" : "每天上午7点30分",
    text: "早餐时间到啦！宝贝们快来吃早餐，吃饱饱才能长高高哦！",
    category: "meal",
    description: "早餐提醒",
    keywords: ["早餐"],
  });

  // 午餐
  tasks.push({
    time: "每天中午12点",
    text: "午餐时间到！宝贝们洗手准备吃饭啦！",
    category: "meal",
    description: "午餐提醒",
    keywords: ["午餐"],
  });

  // 晚餐
  tasks.push({
    time: "每天下午6点",
    text: "晚餐时间到！宝贝们快来吃饭，吃完饭我们一起玩游戏！",
    category: "meal",
    description: "晚餐提醒",
    keywords: ["晚餐"],
  });

  // 睡觉
  tasks.push({
    time: isWeekend ? "每天晚上9点" : "每天晚上8点30分",
    text: "睡觉时间到啦！宝贝们晚安，做个甜甜的好梦！",
    category: "sleep",
    description: "睡觉提醒",
    keywords: ["睡觉", "晚安"],
  });

  // ========== 基于天气的任务 ==========
  
  if (weather?.includes("雨") || weather?.includes("雪")) {
    // 雨天/雪天 - 室内活动
    tasks.push({
      time: isWeekend ? "每天上午10点" : "每天下午4点",
      text: "外面下雨啦！我们来玩室内游戏吧！拼图、积木或者画画都可以哦！",
      category: "activity",
      description: "雨天室内活动提醒",
      keywords: ["下雨", "室内"],
    });
    tasks.push({
      time: isWeekend ? "每天下午3点" : "每天晚上7点",
      text: "宝贝们，故事时间到啦！今天想听什么有趣的故事呢？",
      category: "story",
      description: "雨天故事时间",
      keywords: ["故事"],
    });
  } else if (weather === "晴") {
    // 晴天 - 户外活动
    tasks.push({
      time: isWeekend ? "每天上午10点" : "每天下午4点",
      text: "今天天气真好！宝贝们，我们去公园散步或者骑车吧！",
      category: "activity",
      description: "晴天户外活动提醒",
      keywords: ["天气", "公园"],
    });
  }

  // ========== 基于特殊事件的任务 ==========
  
  for (const event of specialEvents) {
    if (event.includes("生日")) {
      tasks.push({
        time: "每天上午9点",
        text: `生日快乐！宝贝，今天是你的生日！祝你天天开心，健康成长！🎂🎁`,
        category: "celebration",
        description: "生日祝福",
        keywords: ["生日"],
      });
      tasks.push({
        time: "每天下午2点",
        text: "宝贝们，今天是特别的日子！我们来玩生日派对游戏吧！",
        category: "activity",
        description: "生日活动",
        keywords: ["派对"],
      });
    } else if (event.includes("考试")) {
      tasks.push({
        time: "每天早上7点15分",
        text: "宝贝，今天要考试，别紧张！你一定可以的！加油！💪",
        category: "encouragement",
        description: "考试鼓励",
        keywords: ["考试"],
      });
    }
  }

  // ========== 额外的活动任务（周末更多） ==========
  
  if (isWeekend) {
    // 周末更多活动
    tasks.push({
      time: "每天上午11点",
      text: "宝贝们，活动时间到！今天想玩什么呢？画画、搭积木还是玩游戏？",
      category: "activity",
      description: "周末活动时间",
      keywords: ["活动"],
    });
    tasks.push({
      time: "每天下午3点",
      text: "下午啦！宝贝们来吃点点心和水果，补充一下能量吧！",
      category: "snack",
      description: "周末下午茶",
      keywords: ["点心", "水果"],
    });
  } else {
    // 工作日 - 简短活动
    tasks.push({
      time: "每天下午5点",
      text: "宝贝们，放学啦！今天在学校开心吗？",
      category: "greeting",
      description: "放学问候",
      keywords: ["放学"],
    });
  }

  // ========== 通用提醒 ==========
  
  // 喝水提醒
  tasks.push({
    time: "每天上午10点",
    text: "宝贝们，该喝水啦！保持健康很重要，记得多喝水哦！💧",
    category: "reminder",
    description: "喝水提醒",
    keywords: ["喝水"],
  });

  return tasks;
}

function _generatePlanningSuggestions({ isWeekend, weather, specialEvents, preferences, existingTaskCount }) {
  const suggestions = [];

  // 基于工作日/周末
  if (isWeekend) {
    suggestions.push({
      type: "adjustment",
      priority: "medium",
      message: "周末可以适当放松起床时间，增加亲子活动",
      action: "考虑推迟30分钟起床，增加户外/室内活动",
    });
  } else {
    suggestions.push({
      type: "reminder",
      priority: "high",
      message: "工作日保持规律作息很重要",
      action: "确保早起任务正常执行",
    });
  }

  // 基于天气
  if (weather?.includes("雨") || weather?.includes("雪")) {
    suggestions.push({
      type: "replacement",
      priority: "high",
      message: `${weather}天气不适合户外活动`,
      action: "建议将户外活动改为室内活动（阅读、手工、游戏）",
    });
  } else if (weather === "晴") {
    suggestions.push({
      type: "opportunity",
      priority: "medium",
      message: "天气不错，适合户外活动",
      action: "可以增加户外活动提醒（公园散步、骑车等）",
    });
  }

  // 基于特殊事件
  for (const event of specialEvents) {
    if (event.includes("生日")) {
      suggestions.push({
        type: "celebration",
        priority: "high",
        message: `今天是${event}！`,
        action: "添加生日祝福任务，可以准备特别的活动提醒",
      });
    } else if (event.includes("考试")) {
      suggestions.push({
        type: "support",
        priority: "high",
        message: "今天有重要考试",
        action: "添加鼓励性提醒，确保充足睡眠和营养",
      });
    }
  }

  // 基于偏好
  if (preferences?.moreActivities) {
    suggestions.push({
      type: "enhancement",
      priority: "low",
      message: "希望增加更多活动",
      action: "可以考虑添加创意类活动（绘画、音乐、科学实验）",
    });
  }

  return suggestions;
}

function _getTextExamples(scene, audience) {
  const examples = {
    "wake-up": [
      `${audience}，早上好！太阳晒屁股啦，新的一天开始咯！`,
      `早安呀${audience}！伸个懒腰，准备好迎接美好的一天了吗？`,
    ],
    "breakfast": [
      `早餐时间到啦！${audience}快来吃早餐，吃饱饱才能长高高哦！`,
      `香喷喷的早餐好啦！${audience}快过来，今天有你喜欢吃的！`,
    ],
    "bedtime": [
      `睡觉时间到啦！${audience}晚安，做个甜甜的好梦！`,
      `月亮都出来啦，${audience}该睡觉觉啦，明天见！`,
    ],
  };

  return examples[scene] || [`亲爱的${audience}，该${_sceneToAction(scene)}啦！`];
}

function _sceneToAction(scene) {
  const actions = {
    "wake-up": "起床",
    "breakfast": "吃早餐",
    "lunch": "吃午餐",
    "dinner": "吃晚餐",
    "nap": "午睡",
    "bedtime": "睡觉",
    "bath": "洗澡",
    "story": "听故事",
  };
  return actions[scene] || "注意";
}

export {
  _getWeather,
  _getSpecialEvents,
  _isHoliday
};
