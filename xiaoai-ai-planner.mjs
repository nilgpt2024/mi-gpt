/**
 * 小爱音箱 AI 每日规划器
 *
 * 功能：
 * - 每天定时由 AI 根据天气、日期和自定义提示词生成第二天的通知内容
 * - 生成第二天的推送列表内容
 * - 支持自动生成定时任务
 * - 集成 pi-mono 风格的 Agent 能力
 */

import OpenAI from "openai";
import fs from "fs-extra";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const AI_PLANNER_CONFIG = path.join(__dirname, ".ai-planner-config.json");
const AI_PLANNER_HISTORY = path.join(__dirname, ".ai-planner-history.json");

export class AiDailyPlanner {
  constructor(openaiClient, getWeatherFn, getTomorrowHolidayFn) {
    this.openai = openaiClient;
    this.getWeather = getWeatherFn; // 天气获取函数
    this.getTomorrowHoliday = getTomorrowHolidayFn; // 节日获取函数
  }

  async loadConfig() {
    try {
      if (await fs.pathExists(AI_PLANNER_CONFIG)) {
        const config = await fs.readJson(AI_PLANNER_CONFIG);
        
        // 兼容不同的配置字段名
        return {
          enabled: config.enabled !== false,
          autoRunAt: config.time || config.autoRunAt || "22:00",
          customPrompt: config.prompt || config.customPrompt || "",
          city: config.city || "北京",
          address: config.address || "",
          // 兼容旧配置格式
          generateWeatherTasks: config.weather !== false && config.generateWeatherTasks !== false,
          generateHolidayTasks: config.holiday !== false && config.generateHolidayTasks !== false,
          generateDailyRoutine: config.routine !== false && config.generateDailyRoutine !== false,
        };
      }
    } catch (e) {
      console.error("加载配置失败:", e.message);
    }
    return {
      enabled: true,
      autoRunAt: "22:00",
      customPrompt: "",
      city: "北京",
      address: "",
      generateWeatherTasks: true,
      generateHolidayTasks: true,
      generateDailyRoutine: true,
    };
  }

  async saveConfig(config) {
    await fs.writeJson(AI_PLANNER_CONFIG, config, { spaces: 2 });
  }

  async loadHistory() {
    try {
      if (await fs.pathExists(AI_PLANNER_HISTORY)) {
        return await fs.readJson(AI_PLANNER_HISTORY);
      }
    } catch (e) {
      console.error("加载历史失败:", e.message);
    }
    return { generations: [] };
  }

  async saveHistory(history) {
    await fs.writeJson(AI_PLANNER_HISTORY, history, { spaces: 2 });
  }

  async addToHistory(result) {
    const history = await this.loadHistory();
    history.generations.unshift({
      ...result,
      timestamp: new Date().toISOString(),
    });
    if (history.generations.length > 30) {
      history.generations = history.generations.slice(0, 30);
    }
    await this.saveHistory(history);
  }

  async generateNextDayPlan(modelName = "gpt-4o-mini", userContext = {}) {
    const config = await this.loadConfig();
    const tomorrow = new Date();
    tomorrow.setDate(tomorrow.getDate() + 1);

    let weatherInfo = null;
    let holidayInfo = null;

    // ========== 获取天气信息 ==========
    try {
      if (config.generateWeatherTasks && this.getWeather) {
        console.log("🌤️ [AI 规划] 正在获取天气信息...");
        const city = userContext.city || config.city || "北京";
        weatherInfo = await this.getWeather(city, {});
        
        if (weatherInfo) {
          console.log(`✅ [AI 规划] 天气信息获取成功: ${weatherInfo.weather || '未知'}, 城市: ${weatherInfo.city || city}`);
        }
      }
    } catch (e) {
      console.warn("⚠️ [AI 规划] 获取天气失败:", e.message);
    }

    // ========== 获取节日/特殊日期信息 ==========
    try {
      if (config.generateHolidayTasks && this.getTomorrowHoliday) {
        console.log("📅 [AI 规划] 正在检测特殊日期...");
        // 直接调用函数获取明天的节日信息（不依赖外部参数）
        holidayInfo = await this.getTomorrowHoliday(tomorrow);
        
        if (holidayInfo && holidayInfo.events && holidayInfo.events.length > 0) {
          console.log(`✅ [AI 规划] 检测到特殊事件: ${holidayInfo.events.join(', ')}`);
        } else {
          console.log(`📅 [AI 规划] 明天是${holidayInfo?.weekday || ''}，无特殊事件`);
        }
      }
    } catch (e) {
      console.warn("⚠️ [AI 规划] 获取节日信息失败:", e.message);
    }

    // ========== 构建上下文 ==========
    const context = this.buildContext(tomorrow, weatherInfo, holidayInfo, config.customPrompt, userContext);
    const systemPrompt = this.getSystemPrompt();

    // 打印详细的上下文用于调试
    console.log("\n" + "=".repeat(60));
    console.log("📝 [AI 规划] 发送给 AI 的完整上下文:");
    console.log("-".repeat(60));
    console.log(`📍 用户位置: 城市=${userContext.city || config.city || '北京'}, 地址=${userContext.address || '未设置'}`);
    console.log(`📅 目标日期: ${tomorrow.toISOString().split('T')[0]} (${['星期日','星期一','星期二','星期三','星期四','星期五','星期六'][tomorrow.getDay()]})`);
    console.log(`🌤️ 天气状态: ${weatherInfo ? `${weatherInfo.weather} (${weatherInfo.city})` : '未获取'}`);
    console.log(`📅 节日状态: ${holidayInfo && holidayInfo.events.length > 0 ? holidayInfo.events.join(', ') : '无特殊事件'}`);
    console.log("-".repeat(60));
    console.log(context.substring(0, 800) + (context.length > 800 ? "\n... (截断显示)" : ""));
    console.log("=".repeat(60) + "\n");

    // 尝试多次生成，借鉴 pi-mono 的重试机制
    let result = null;
    let lastError = null;
    
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        console.log(`🔄 [AI 规划] 第 ${attempt} 次尝试生成计划...`);
        
        const response = await this.openai.chat.completions.create({
          model: modelName,
          messages: [
            { role: "system", content: systemPrompt },
            { role: "user", content: context },
          ],
          max_tokens: 2000,
          temperature: 0.7,
          response_format: { type: "json_object" }, // 使用结构化输出
        });

        const aiResponse = response.choices[0]?.message?.content?.trim();
        if (!aiResponse) throw new Error("AI 返回空结果");

        console.log(`📝 [AI 规划] 原始响应长度: ${aiResponse.length} 字符`);
        
        // 📋 显示 AI 返回的完整原始数据（用于调试）
        console.log("\n" + "=".repeat(60));
        console.log("📤 [AI 原始响应] 完整内容:");
        console.log("=".repeat(60));
        console.log(aiResponse);
        console.log("=".repeat(60) + "\n");

        // 使用增强的解析（支持行格式和 JSON 格式）
        const plan = this._parseAIResponse(aiResponse);

        result = {
          date: tomorrow.toISOString(),
          weekday: ["星期日", "星期一", "星期二", "星期三", "星期四", "星期五", "星期六"][tomorrow.getDay()],
          isWeekend: tomorrow.getDay() === 0 || tomorrow.getDay() === 6,
          plan: plan,
          weather: weatherInfo,
          holiday: holidayInfo,
        };

        await this.addToHistory(result);
        console.log(`✅ [AI 规划] 计划生成成功！包含 ${plan.notifications?.length || 0} 个通知`);
        return result;
      } catch (e) {
        lastError = e;
        console.warn(`⚠️ [AI 规划] 第 ${attempt} 次尝试失败:`, e.message);
        
        if (attempt < 3) {
          // 等待一下再重试
          await new Promise(resolve => setTimeout(resolve, 1000));
        }
      }
    }

    // 所有尝试都失败了，使用备用方案
    console.error("❌ 所有尝试都失败，使用备用方案");
    throw lastError || new Error("生成计划失败");
  }

  /**
   * 解析 AI 响应（支持多种格式）
   * 优先级：行格式 → JSON → 自由文本提取
   */
  _parseAIResponse(text) {
    console.log(`🔍 [解析] 开始解析 AI 响应，长度: ${text.length} 字符`);
    
    // 方法1：尝试解析为简单行格式
    const lineFormatResult = this._tryParseLineFormat(text);
    if (lineFormatResult) {
      console.log(`✅ [解析] 成功使用行格式解析，获得 ${lineFormatResult.notifications.length} 个任务`);
      return lineFormatResult;
    }
    
    // 方法2：尝试解析为 JSON 格式
    const jsonFormatResult = this._tryParseJSON(text);
    if (jsonFormatResult) {
      console.log(`✅ [解析] 成功使用 JSON 格式解析，获得 ${jsonFormatResult.notifications.length} 个任务`);
      return jsonFormatResult;
    }
    
    // 方法3：智能自由文本提取（从任意格式中提取任务）
    const freeTextResult = this._extractTasksFromFreeText(text);
    if (freeTextResult && freeTextResult.notifications.length >= 3) {
      console.log(`✅ [解析] 成功使用自由文本提取，获得 ${freeTextResult.notifications.length} 个任务`);
      return freeTextResult;
    }
    
    // 方法4：使用默认方案
    console.warn("⚠️ [解析] 所有解析方式都失败，使用默认方案");
    return this._generateDefaultPlan();
  }

  /**
   * 从自由文本中智能提取任务（支持 Markdown、表格、列表等任意格式）
   */
  _extractTasksFromFreeText(text) {
    const notifications = [];
    
    // 正则表达式匹配时间模式：HH:MM 或 H:MM
    const timePatterns = [
      /(\d{1,2}:\d{2})/g,  // 07:30, 8:15 等
      /([一二三四五六七八九十]+[点时]\d{0,2}[分]?)/g,  // 七点三十, 8点 等
    ];
    
    // 找出所有时间点及其上下文
    const timeMatches = [];
    let match;
    
    while ((match = timePatterns[0].exec(text)) !== null) {
      const time = match[1];
      
      // 验证时间有效性
      const timeParts = time.split(':');
      const hour = parseInt(timeParts[0]);
      const minute = parseInt(timeParts[1] || '0');
      
      if (hour >= 0 && hour <= 23 && minute >= 0 && minute <= 59) {
        // 获取该时间前后的文本（上下文）
        const startPos = Math.max(0, text.indexOf(match[0]) - 100);
        const endPos = Math.min(text.length, text.indexOf(match[0]) + 300);
        const context = text.substring(startPos, endPos).replace(/\n/g, ' ').trim();
        
        timeMatches.push({
          time: `${hour.toString().padStart(2, '0')}:${minute.toString().padStart(2, '0')}`,
          context: context,
          position: text.indexOf(match[0])
        });
      }
    }
    
    console.log(`🔍 [自由文本] 找到 ${timeMatches.length} 个时间点`);
    
    // 为每个时间点提取任务内容
    for (const timeMatch of timeMatches) {
      const task = this._extractTaskFromContext(timeMatch.time, timeMatch.context);
      if (task) {
        notifications.push(task);
      }
    }
    
    if (notifications.length >= 3) {
      return {
        summary: this._generateSummary(notifications),
        notifications: notifications,
        suggestions: this._generateSuggestions(notifications)
      };
    }
    
    return null;
  }

  /**
   * 从上下文中提取单个任务
   */
  _extractTaskFromContext(time, context) {
    // 尝试提取引号内的内容（通常是播报文字）
    const quoteMatch = context.match(/["「](.+?)["」]/);
    let content = quoteMatch ? quoteMatch[1] : '';
    
    // 如果没有引号内容，尝试提取时间后的描述性文字
    if (!content || content.length < 10) {
      // 查找时间位置之后的内容
      const timeIndex = context.indexOf(time);
      if (timeIndex !== -1) {
        const afterTime = context.substring(timeIndex + time.length).trim();
        
        // 清理 HTML 标签和特殊字符
        content = afterTime
          .replace(/<[^>]+>/g, '')  // 移除 HTML 标签
          .replace(/[|*#>\-]/g, ' ')  // 移除 Markdown 符号
          .replace(/\s+/g, ' ')  // 合并空格
          .trim();
        
        // 截取合理长度（20-80字）
        if (content.length > 80) {
          content = content.substring(0, 80);
        }
      }
    }
    
    // 验证内容有效
    if (!content || content.length < 10) {
      return null;
    }
    
    // 推断任务类型
    let type = 'routine';  // 默认类型
    
    const lowerContext = context.toLowerCase();
    if (lowerContext.includes('雨') || lowerContext.includes('天气') || lowerContext.includes('温度')) {
      type = 'weather';
    } else if (lowerContext.includes('节日') || lowerContext.includes('生日') || lowerContext.includes('庆祝')) {
      type = 'holiday';
    } else if (lowerContext.includes('喝水') || lowerContext.includes('提醒')) {
      type = 'reminder';
    } else if (lowerContext.includes('活动') || lowerContext.includes('游戏') || lowerContext.includes('手工')) {
      type = 'custom';
    }
    
    // 生成标题（从内容中提取关键词）
    let title = this._extractTitle(context);
    
    return {
      time: time,
      type: type,
      title: title,
      content: content
    };
  }

  /**
   * 从上下文中提取简短标题
   */
  _extractTitle(context) {
    // 常见的关键词映射
    const titleKeywords = [
      { keywords: ['起床', '早安', '早上好', '唤醒'], title: '起床' },
      { keywords: ['早餐', '早饭'], title: '早餐' },
      { keywords: ['午餐', '午饭'], title: '午餐' },
      { keywords: ['晚餐', '晚饭'], title: '晚餐' },
      { keywords: ['睡觉', '晚安', '睡前'], title: '睡觉' },
      { keywords: ['喝水', '饮水'], title: '喝水' },
      { keywords: ['活动', '游戏', '手工', '画画', '积木'], title: '活动' },
      { keywords: ['午睡', '休息', '午休'], title: '午休' },
      { keywords: ['学习', '阅读', '故事', '绘本'], title: '学习' },
      { keywords: ['洗澡', '洗漱'], title: '洗澡' },
    ];
    
    const lowerContext = context.toLowerCase();
    
    for (const item of titleKeywords) {
      if (item.keywords.some(kw => lowerContext.includes(kw))) {
        return item.title;
      }
    }
    
    return '提醒';  // 默认标题
  }

  /**
   * 尝试解析行格式：时间 | 类型 | 标题 | 内容
   */
  _tryParseLineFormat(text) {
    const lines = text.split('\n').map(line => line.trim()).filter(line => line);
    const notifications = [];
    const validTypes = ['routine', 'weather', 'holiday', 'custom', 'reminder'];
    
    for (const line of lines) {
      // 跳过说明性文字
      if (line.startsWith('#') || line.startsWith('//') || line.startsWith('【') || 
          line.startsWith('-') || line.startsWith('*') || line.includes('示例') ||
          line.includes('格式') || line.includes('说明')) {
        continue;
      }
      
      // 尝试用 | 分割
      const parts = line.split('|').map(p => p.trim());
      
      if (parts.length >= 4) {
        const [time, type, title, content] = parts;
        
        // 验证时间格式 HH:MM
        const timeMatch = time.match(/^(\d{2}):(\d{2})$/);
        if (!timeMatch) continue;
        
        const hour = parseInt(timeMatch[1]);
        const minute = parseInt(timeMatch[2]);
        if (hour < 0 || hour > 23 || minute < 0 || minute > 59) continue;
        
        // 验证类型
        if (!validTypes.includes(type.toLowerCase())) continue;
        
        // 验证内容不为空
        if (!content || content.length < 5) continue;
        
        notifications.push({
          time: `${hour.toString().padStart(2, '0')}:${minute.toString().padStart(2, '0')}`,
          type: type.toLowerCase(),
          title: title,
          content: content
        });
      }
    }
    
    if (notifications.length >= 6) { // 至少要有6个任务才算有效（覆盖全天）
      return {
        summary: this._generateSummary(notifications),
        notifications: notifications,
        suggestions: this._generateSuggestions(notifications)
      };
    }
    
    return null;
  }

  /**
   * 尝试解析 JSON 格式
   */
  _tryParseJSON(text) {
    try {
      // 直接解析
      const parsed = JSON.parse(text);
      if (this._isValidPlan(parsed)) {
        return parsed;
      }
    } catch (e) {}
    
    // 提取 JSON 对象
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      try {
        const parsed = JSON.parse(jsonMatch[0]);
        if (this._isValidPlan(parsed)) {
          return parsed;
        }
      } catch (e) {}
    }
    
    return null;
  }

  /**
   * 根据任务生成摘要
   */
  _generateSummary(notifications) {
    if (!notifications || notifications.length === 0) return "每日规划";
    
    const firstContent = notifications[0]?.content || '';
    if (firstContent.includes('雨') || firstContent.includes('伞')) return '雨天温馨居家日';
    if (firstContent.includes('晴') || firstContent.includes('阳光')) return '晴朗愉快的一天';
    if (firstContent.includes('周末') || firstContent.includes('周六') || firstContent.includes('周日')) return '周末轻松时光';
    
    return '每日规划';
  }

  /**
   * 根据任务生成建议
   */
  _generateSuggestions(notifications) {
    const suggestions = [];
    
    if (notifications.some(n => n.content.includes('雨'))) {
      suggestions.push('准备雨具和室内玩具');
    }
    if (notifications.some(n => n.content.includes('户外') || n.content.includes('公园'))) {
      suggestions.push('注意防晒和补水');
    }
    if (notifications.some(n => n.type === 'custom')) {
      suggestions.push('提前准备活动材料');
    }
    
    if (suggestions.length === 0) {
      suggestions.push('保持规律作息', '多喝水保持健康');
    }
    
    return suggestions.slice(0, 3);
  }

  /**
   * 验证计划是否有效
   */
  _isValidPlan(plan) {
    if (!plan || typeof plan !== 'object') return false;
    if (!plan.notifications || !Array.isArray(plan.notifications)) return false;
    if (plan.notifications.length === 0) return false;
    
    for (const notification of plan.notifications) {
      if (!notification.time || !notification.content) return false;
    }
    
    return true;
  }

  /**
   * 清理 AI 响应中的非 JSON 内容
   */
  _cleanAIResponse(text) {
    let cleaned = text.trim();
    
    cleaned = cleaned.replace(/```json\s*/gi, '').replace(/```\s*/g, '');
    
    const firstBrace = cleaned.indexOf('{');
    const lastBrace = cleaned.lastIndexOf('}');
    
    if (firstBrace !== -1 && lastBrace !== -1 && lastBrace > firstBrace) {
      cleaned = cleaned.substring(firstBrace, lastBrace + 1);
    }
    
    return cleaned;
  }

  /**
   * 生成默认的智能计划（当 AI 解析失败时）
   */
  _generateDefaultPlan() {
    const now = new Date();
    const tomorrow = new Date(now.getTime() + 86400000);
    const isWeekend = tomorrow.getDay() === 0 || tomorrow.getDay() === 6;
    
    return {
      summary: isWeekend ? "周末轻松愉快的一天" : "充实有序的工作日",
      notifications: [
        {
          time: isWeekend ? "08:00" : "07:00",
          type: "routine",
          title: "起床提醒",
          content: isWeekend 
            ? "宝贝们，早上好！周末到啦，今天可以好好玩一天哦！"
            : "宝贝们，早上好！新的一天开始咯！"
        },
        {
          time: isWeekend ? "08:30" : "07:30",
          type: "routine",
          title: "早餐提醒",
          content: "早餐时间到啦！宝贝们快来吃早餐，吃饱饱才能长高高哦！"
        },
        {
          time: "12:00",
          type: "routine",
          title: "午餐提醒",
          content: "午餐时间到！宝贝们洗手准备吃饭啦！"
        },
        {
          time: "18:00",
          type: "routine",
          title: "晚餐提醒",
          content: "晚餐时间到！宝贝们快来吃饭！"
        },
        {
          time: isWeekend ? "21:00" : "20:30",
          type: "routine",
          title: "睡觉提醒",
          content: "睡觉时间到啦！宝贝们晚安，做个甜甜的好梦！"
        },
        {
          time: "10:00",
          type: "reminder",
          title: "喝水提醒",
          content: "宝贝们，该喝水啦！保持健康很重要！"
        }
      ],
      suggestions: [
        "记得多喝水保持健康",
        "适当休息，注意用眼卫生"
      ]
    };
  }

  buildContext(tomorrow, weather, holiday, customPrompt, userContext = {}) {
    const dateStr = `${tomorrow.getFullYear()}年${tomorrow.getMonth() + 1}月${tomorrow.getDate()}日`;
    const weekday = ["星期日", "星期一", "星期二", "星期三", "星期四", "星期五", "星期六"][tomorrow.getDay()];
    const isWeekend = tomorrow.getDay() === 0 || tomorrow.getDay() === 6;
    
    // 获取用户位置信息
    const city = userContext.city || weather?.city || "北京";
    const address = userContext.address || "";

    let context = `请为明天（${dateStr}，${weekday}${isWeekend ? '，周末' : '，工作日'}）生成小爱音箱的通知内容和推送列表。\n\n`;
    
    // 添加位置信息
    context += `【📍 位置信息】\n`;
    context += `- 所在城市: ${city}\n`;
    if (address) {
      context += `- 详细地址: ${address}\n`;
    }
    context += "\n";

    // 天气信息
    if (weather) {
      context += `【🌤️ 天气信息】\n`;
      context += `- 所在城市: ${weather.city || city}\n`;
      context += `- 天气状况: ${weather.weather || "未知"}\n`;
      if (weather.temp) context += `- 温度: ${weather.temp}\n`;
      if (weather.feelsLike) context += `- 体感温度: ${weather.feelsLike}\n`;
      if (weather.humidity) context += `- 湿度: ${weather.humidity}\n`;
      if (weather.uvIndex) context += `- 紫外线指数: ${weather.uvIndex}\n`;
      if (weather.windSpeed) context += `- 风速: ${weather.windSpeed}\n`;
      if (weather.visibility) context += `- 能见度: ${weather.visibility}\n`;
      if (weather.tips) context += `- 温馨提示: ${weather.tips}\n`;
      
      // 根据天气给出建议
      if (weather.weather?.includes('雨') || weather.weather?.includes('雪')) {
        context += `\n⚠️ 注意：${weather.weather}天气，建议增加室内活动提醒\n`;
      } else if (weather.weather === '晴') {
        context += `\n☀️ 天气不错，适合户外活动\n`;
      }
      context += "\n";
    } else {
      context += `【🌤️ 天气信息】暂未获取到${city}的天气数据\n\n`;
    }

    // 节日和特殊日期信息
    if (holiday) {
      context += `【📅 特殊日期信息】\n`;
      
      if (holiday.weekday) {
        context += `- 星期: ${holiday.weekday}\n`;
      }
      
      if (holiday.isWeekend !== undefined) {
        context += `${holiday.isWeekend ? '✨ 今天是周末' : '💼 今天是工作日'}\n`;
      }
      
      if (holiday.events && holiday.events.length > 0) {
        context += `- 🎉 特殊事件: ${holiday.events.join('、')}\n`;
        
        // 如果有节日，添加特别说明
        for (const event of holiday.events) {
          if (event.includes('生日')) {
            context += `- 🎂 今天有人过生日！要包含生日祝福\n`;
          } else if (event.includes('节')) {
            context += `- 🎊 今天是${event}！要包含节日祝福\n`;
          }
        }
      } else {
        context += `- 无特殊节日或事件\n`;
      }
      context += "\n";
    } else {
      context += `【📅 特殊日期信息】普通日期，无特殊节日\n\n`;
    }

    // 自定义要求
    if (customPrompt && customPrompt.trim()) {
      context += `【📝 用户自定义要求】\n${customPrompt}\n\n`;
    }

    // 添加明确的指令
    context += `【重要指令】
请根据以上信息（特别是天气和日期）生成合适的任务：
1. 如果是雨天，要包含室内活动建议
2. 如果是晴天，可以包含户外活动建议  
3. 如果是周末，时间可以稍微宽松一些
4. 如果是工作日，要保持规律作息
5. 如果有节日或特殊事件，一定要包含相关祝福语
6. 内容要温馨有趣，适合儿童听
`;

    return context;
  }

  getSystemPrompt() {
    return `你是定时任务生成系统。根据天气和日期信息生成明天的定时任务列表。

【输出格式（严格遵守，每行一个任务）】
格式：时间 | 类型 | 标题 | 播报内容

示例（必须生成 8-10 个任务，覆盖全天从早到晚）：
07:00 | routine | 起床 | 宝贝早上好！周六下雨啦，今天可以在家好好玩！
07:30 | routine | 洗漱 | 快去刷牙洗脸啦，做个香喷喷的小宝贝～
08:00 | routine | 早餐 | 早餐时间到！雨天喝热粥最舒服啦～
08:30 | custom | 晨间活动 | 来做几个拉伸运动吧，唤醒身体活力！
09:30 | custom | 室内活动 | 下雨天最适合画画啦！拿出画笔创作吧🎨
10:30 | reminder | 喝水/加餐 | 宝贝们该喝水吃水果啦！保持健康每一天～
12:00 | routine | 午餐 | 午餐时间到！帮爸爸妈妈摆碗筷做个能干小帮手！
13:00 | routine | 午休 | 吃完饭休息一会儿，养足精神下午继续玩～
15:00 | custom | 亲子游戏 | 下午和爸爸妈妈一起搭积木或玩桌游吧！
16:30 | snack | 下午茶 | 下午茶时间！来块小饼干配牛奶吧～
17:30 | custom | 户外/活动 | 雨停了的话出去散散步，没停就在家跳跳舞！
18:30 | routine | 晚餐 | 晚餐时间！喝热汤最暖胃啦～
19:30 | routine | 亲子阅读 | 睡前故事时间到！挑一本喜欢的绘本一起读吧📚
20:30 | routine | 洗澡/准备睡觉 | 去洗个热水澡，换上睡衣准备睡觉咯～
21:00 | routine | 晚安 | 晚安宝贝！听着雨声入睡，做个甜甜的好梦～

【字段说明】
- 时间：HH:MM 格式（24小时制）
- 类型：routine / weather / holiday / custom / reminder / meal / snack / activity（任选其一）
- 标题：2-6个字
- 内容：小爱音箱实际播报的文字（20-50字，温馨童趣）

【内容规则】根据天气/日期调整：
- 🌧️雨 → "记得带伞☂️"、"适合室内活动（画画/搭积木/听故事）"
- ☀️晴 → "适合户外活动"、"注意防晒"
- 📅周末 → 时间稍宽松、"周末愉快"
- 💼工作日 → 规律作息、"新的一天开始"
- 🎉节日 → 包含祝福语

【重要要求】
1. 必须生成 8-10 个任务，覆盖从起床（07:00左右）到睡觉（21:00左右）的全天时段
2. 任务之间间隔合理（1-2小时），不要扎堆也不要留大空白
3. 必须包含：起床、早餐、午餐、晚餐、晚安 这5个基础节点
4. 建议加入：喝水提醒、加餐/水果、午休、户外/室内活动、亲子阅读等丰富任务
5. 只输出任务列表，不要其他说明文字。直接开始第一行：`;
  }

  convertPlanToSchedules(plan, prefix = "ai-planner") {
    const schedules = [];
    if (!plan.notifications || !Array.isArray(plan.notifications)) {
      return schedules;
    }

    plan.notifications.forEach((notification, index) => {
      const [hour, minute] = notification.time.split(":").map(Number);
      
      if (isNaN(hour) || isNaN(minute) || hour < 0 || hour > 23 || minute < 0 || minute > 59) {
        console.warn(`⚠️ 无效的时间格式: ${notification.time}`);
        return;
      }
      
      const cron = `${minute} ${hour} * * *`;

      schedules.push({
        id: `${prefix}-${Date.now()}-${index}`,
        text: notification.content,
        taskType: "text",
        type: "cron",
        cron: cron,
        createdAt: new Date().toISOString(),
        lastRun: null,
        runCount: 0,
        aiPlanner: {
          originalType: notification.type,
          title: notification.title,
          time: notification.time,
          planDate: plan.date,
        },
      });
    });

    return schedules;
  }
}

export default AiDailyPlanner;
