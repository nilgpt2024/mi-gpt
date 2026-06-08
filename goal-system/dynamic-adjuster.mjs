/**
 * 动态调整引擎 (DynamicAdjuster) v2.0
 * 
 * 重构说明:
 * - ❌ 旧版: AI返回JSON → 手动解析 → 构建DailyPlan → 保存
 * - ✅ 新版: 指定路径+Prompt → OpenCode直接生成计划文件 → 加载使用
 * 
 * 核心优势:
 * - 更可靠: 迭代修正机制保证文件质量
 * - 更简洁: 减少复杂的数据组装逻辑
 * - 更透明: 生成的计划文件可直接查看和调试
 */

import fs from 'fs-extra';
import path from 'path';
import { IterativeFileGenerator } from './iterative-generator.mjs';

export class DynamicAdjuster {
  constructor(sessionManager, getWeatherFn, getHolidayFn, goalManager, options = {}) {
    this.sessionManager = sessionManager;
    this.getWeather = getWeatherFn || this._defaultGetWeather;
    this.getHoliday = getHolidayFn || this._defaultGetHoliday;
    this.goalManager = goalManager;

    // 初始化迭代生成器
    this.generator = new IterativeFileGenerator(sessionManager, options.generatorOptions || {});

    // 配置项
    this.modelName = options.modelName || 'gpt-4o-mini';
    this.outputDir = options.outputDir || 'data/daily-plans';
    this.minAdjustInterval = options.minAdjustInterval || 12 * 60 * 60 * 1000; // 12小时
    this.defaultCity = options.defaultCity || '北京';
  }

  /**
   * 执行每日调整（核心方法）
   * @param {string} goalId - 目标ID
   * @param {boolean} forceAdjustment - 是否强制重新生成
   * @param {Object} promptOptions - 提示词选项
   * @param {string} promptOptions.targetDate - 目标日期 'tomorrow'(默认) | 'today' | 具体日期字符串(YYYY-MM-DD)
   * @param {number} promptOptions.dayOffset - 天数偏移量（多日批量生成时，Day 2 传 2，Day 3 传 3...）
   */
  async dailyAdjustment(goalId, forceAdjustment = false, promptOptions = {}) {
    const { customSystemPrompt, customUserPrompt, targetDate: targetDateOption, dayOffset } = promptOptions || {};

    try {
      console.log(`\n${'='.repeat(60)}`);
      console.log(`🔄 [DynamicAdjuster v2.0] 开始调整目标: ${goalId}`);
      if (customSystemPrompt) {
        console.log(`📝 [DynamicAdjuster] 使用自定义系统提示词 (${customSystemPrompt.length}字符)`);
      }
      if (customUserPrompt) {
        console.log(`💬 [DynamicAdjuster] 用户额外提示: ${customUserPrompt.substring(0, 50)}...`);
      }
      console.log(`${'='.repeat(60)}\n`);

      const goal = await this.goalManager.getGoal(goalId);
      if (!goal) {
        throw new Error(`目标不存在: ${goalId}`);
      }

      if (!['planning', 'in_progress', 'near_complete', 'paused'].includes(goal.status)) {
        console.log(`⏭️ [DynamicAdjuster] 目标状态为 ${goal.status}，跳过调整`);
        return null;
      }

      // ✅ 支持自定义目标日期（默认=明天，兼容旧逻辑）
      let targetDate;
      if (targetDateOption === 'today' || targetDateOption === 'now') {
        targetDate = new Date();
        console.log(`📅 [DynamicAdjuster] 目标日期模式: 今天 (${targetDate.toISOString().split('T')[0]})`);
      } else if (targetDateOption && /^\d{4}-\d{2}-\d{2}$/.test(targetDateOption)) {
        targetDate = new Date(targetDateOption);
        console.log(`📅 [DynamicAdjuster] 目标日期模式: 指定日期 (${targetDateOption})`);
      } else {
        // 默认：明天
        targetDate = new Date(Date.now() + 86400000);
        console.log(`📅 [DynamicAdjuster] 目标日期模式: 明天 (${targetDate.toISOString().split('T')[0]})`);
      }
      const targetDateStr = targetDate.toISOString().split('T')[0];

      if (!forceAdjustment) {
        const existingPlan = await this.goalManager.getTomorrowPlan(goalId);
        if (existingPlan) {
          console.log(`✅ [DynamicAdjuster] 目标日期计划已存在 (${targetDateStr})，跳过重新生成`);
          return existingPlan;
        }

        const lastAdjustment = goal.updatedAt ? new Date(goal.updatedAt).getTime() : 0;
        const timeSinceLastAdjustment = Date.now() - lastAdjustment;
        if (timeSinceLastAdjustment < this.minAdjustInterval) {
          console.log(`⏳ [DynamicAdjuster] 距离上次调整不足12小时，跳过`);
          return null;
        }
      }

      console.log(`📅 [DynamicAdjuster] 生成 ${targetDateStr} 的计划...`);

      // 收集上下文信息
      const context = await this._gatherContext(targetDate, goal);

      // ✅ 多天批量生成时，用 dayOffset 调整当前天数（让 AI 知道这是第几天）
      if (dayOffset && dayOffset > 1) {
        const originalDay = context.progress.currentDay;
        context.progress.currentDay = originalDay + (dayOffset - 1);
        context.progress.percentage = parseFloat(
          ((context.progress.currentDay / context.progress.totalDays) * 100).toFixed(1)
        );
        console.log(`📆 [DynamicAdjuster] dayOffset=${dayOffset}, 进度调整为: Day ${context.progress.currentDay}/${context.progress.totalDays} (${context.progress.percentage}%)`);
      }

      this._logContext(context);

      // 规则引擎预判
      const ruleBasedAdjustments = this._shouldAdjustBasedOnRules(context);
      console.log(`📋 [DynamicAdjuster] 规则引擎检测到 ${ruleBasedAdjustments.length} 个调整建议`);

      // 定义输出文件路径
      const planPath = path.join(this.outputDir, `${goalId}-${targetDateStr}.json`);
      console.log(`📄 [DynamicAdjuster] 计划文件路径: ${planPath}`);

      // 使用迭代修正引擎生成计划文件
      // ✅ 优先使用自定义系统提示词，否则使用默认值
      const systemPrompt = customSystemPrompt || this._buildSystemPrompt();

      // ✅ 如果有用户额外提示，追加到用户提示词末尾
      const dateLabel = targetDateOption === 'today' || targetDateOption === 'now' ? '今日' : '明日';
      let userPrompt = this._buildAdjustmentPrompt(goal, context, ruleBasedAdjustments, dateLabel);
      if (customUserPrompt) {
        userPrompt += `\n\n## 👤 用户额外指令\n${customUserPrompt}`;
        console.log(`💬 [DynamicAdjuster] 已追加用户额外提示到 Prompt`);
      }

      const result = await this.generator.generateWithValidation(
        {
          text: userPrompt,
          systemPrompt: systemPrompt,
          model: this.modelName,
          goal,
          context,
          ruleBasedAdjustments,
          // 传递给降级模板的参数
          dayOffset: dayOffset || 1,
          targetDate: targetDateStr,
          totalDays: goal.progress?.totalDays || 30,
          targetTime: goal.config?.targetTime || '08:00'
        },
        'dailyPlan'
      );

      if (!result.success) {
        throw new Error(result.error || '每日计划生成失败');
      }

      console.log(`✅ [DynamicAdjuster] 每日计划生成成功:`);
      console.log(`   文件: ${result.filePath}`);
      console.log(`   任务数: ${result.data?.tasks?.length || 0}`);
      console.log(`   尝试次数: ${result.attempts}`);
      if (result.usedFallback) {
        console.log(`   ⚠️  使用了降级方案`);
      }
      console.log(`   回复: ${result.replyToUser?.substring(0, 80)}...`);

      // 保存到 GoalManager
      await this.goalManager.saveDailyPlan(result.data);

      // 记录调整历史
      for (const adj of ruleBasedAdjustments) {
        await this.goalManager.addAdjustment(goalId, adj);
      }

      // 更新目标状态
      if (goal.status === 'planning') {
        await this.goalManager.setStartDate(goalId);
      }

      console.log(`\n${'='.repeat(60)}`);
      console.log(`✅ [DynamicAdjuster] 调整完成!`);
      console.log(`${'='.repeat(60)}\n`);

      return result.data;

    } catch (error) {
      console.error(`❌ [DynamicAdjuster] 调整失败:`, error.message);
      return await this._fallbackAdjustment(goalId, targetDateOption, dayOffset);
    }
  }

  /**
   * 批量调整所有活跃目标
   */
  async batchAdjustAllActiveGoals(options = {}) {
    const startTime = Date.now();
    console.log(`\n🔄 [DynamicAdjuster] ===== 批量调整所有活跃目标 =====`);

    const activeGoals = await this.goalManager.getActiveGoals();
    console.log(`📊 [DynamicAdjuster] 发现 ${activeGoals.length} 个活跃目标`);

    if (activeGoals.length === 0) {
      return {
        executedAt: new Date().toISOString(),
        totalGoalsProcessed: 0,
        results: [],
        summary: { successful: 0, skipped: 0, failed: 0, totalAdjustments: 0 }
      };
    }

    const results = [];
    let successful = 0;
    let skipped = 0;
    let failed = 0;
    let totalAdjustments = 0;

    const batchSize = 3;
    for (let i = 0; i < activeGoals.length; i += batchSize) {
      const batch = activeGoals.slice(i, i + batchSize);
      console.log(`\n📦 [DynamicAdjuster] 处理批次 ${Math.floor(i / batchSize) + 1}/${Math.ceil(activeGoals.length / batchSize)}`);

      const batchResults = await Promise.allSettled(
        batch.map(async (goal) => {
          try {
            const plan = await this.dailyAdjustment(
              goal.id,
              options.forceRegenerate,
              {
                customSystemPrompt: options.customSystemPrompt,
                customUserPrompt: options.customUserPrompt,
                targetDate: options.targetDate,  // ✅ 透传目标日期
                dayOffset: options.dayOffset     // ✅ 透传天数偏移
              }
            );
            return {
              goalId: goal.id,
              goalTitle: goal.title,
              status: plan ? 'adjusted' : 'skipped',
              tasksGenerated: plan?.tasks?.length || 0,
              adjustmentsMade: plan?.adjustmentSummary?.totalAdjustments || 0,
              plan
            };
          } catch (error) {
            return {
              goalId: goal.id,
              goalTitle: goal.title,
              status: 'error',
              error: error.message
            };
          }
        })
      );

      for (const result of batchResults) {
        if (result.status === 'fulfilled') {
          results.push(result.value);
          if (result.value.status === 'adjusted') {
            successful++;
            totalAdjustments += result.value.adjustmentsMade;
          } else {
            skipped++;
          }
        } else {
          results.push({
            goalId: 'unknown',
            goalTitle: 'Unknown',
            status: 'error',
            error: result.reason?.message
          });
          failed++;
        }
      }

      if (i + batchSize < activeGoals.length) {
        console.log(`⏳ [DynamicAdjuster] 等待1秒后处理下一批...`);
        await new Promise(resolve => setTimeout(resolve, 1000));
      }
    }

    const duration = ((Date.now() - startTime) / 1000).toFixed(1);

    console.log(`\n${'='.repeat(60)}`);
    console.log(`✅ [DynamicAdjuster] 批量调整完成!`);
    console.log(`   总计: ${activeGoals.length} 个目标`);
    console.log(`   成功: ${successful}, 跳过: ${skipped}, 失败: ${failed}`);
    console.log(`   总调整次数: ${totalAdjustments}`);
    console.log(`   耗时: ${duration}s`);
    console.log(`${'='.repeat(60)}\n`);

    return {
      executedAt: new Date().toISOString(),
      totalGoalsProcessed: activeGoals.length,
      results,
      summary: { successful, skipped, failed, totalAdjustments }
    };
  }

  // ==================== Prompt 构建 ====================

  _buildAdjustmentPrompt(goal, context, ruleBasedAdjustments, dateLabel = '明日') {
    const targetDate = context.date;
    const planPath = `data/daily-plans/${goal.id}-${targetDate}.json`;

    let prompt = `
## 📋 任务：生成${dateLabel}计划 JSON

**输出要求**: 请在回复中直接输出完整的 JSON 内容（用 \`\`\`json 代码块包裹），系统会自动保存到文件。

**目标文件路径**: ${planPath}

---

## 📋 当前目标信息

- **标题**: ${goal.title}
- **类型**: ${goal.type}
- **第几天**: 第${context.progress.currentDay + 1}/${context.progress.totalDays}天
- **进度**: ${context.progress.percentage.toFixed(1)}%
- **连续天数**: ${context.progress.streak || 0}天
- **语气风格**: ${goal.config.tone}
- **目标受众**: ${goal.config.audience}

## 🌍 ${dateLabel}上下文

### 天气情况
- **天气**: ${context.weather.weather || '未知'}
- **温度**: ${context.weather.temp || '-'}
- **城市**: ${context.weather.city || '-'}
${context.weather.tips ? `- **提示**: ${context.weather.tips}` : ''}

### 日历信息
- **星期**: ${context.holiday.weekday}
- **是否周末**: ${context.holiday.isWeekend ? '是 ✅' : '否'}
- **特殊事件**: ${context.holiday.events?.length > 0 ? context.holiday.events.join(', ') : '无'}

## 🔧 规则引擎建议 (${ruleBasedAdjustments.length}条)
`;

    if (ruleBasedAdjustments.length > 0) {
      prompt += '\n';
      ruleBasedAdjustments.forEach((adj, idx) => {
        prompt += `${idx + 1}. **[${adj.type.toUpperCase()}]** ${adj.suggestion}`;
        if (adj.priority) prompt += ` (优先级: ${adj.priority})`;
        prompt += '\n';
      });
    } else {
      prompt += '\n暂无特别调整建议，按常规流程生成。\n';
    }

    prompt += `
## 📝 任务要求

**🔴 绝对禁止生成重复计划！** 你正在为第 ${context.progress.currentDay + 1} 天生成计划，必须与前后几天**完全不同**：

### 标题必须不同（示例）
- 第1天: "新挑战开始啦" → 第2天: "第二天继续加油" → 第3天: "已经坚持一半啦"
- 不要连续两天用相同标题，每次换一种说法

### 时间可以微调（示例）
- 早上任务可以在 07:30~08:30 之间浮动
- 晚间阅读可以在 18:30~19:30 之间浮动
- 避免每天完全相同的时间点

### 文案必须不同
- **第1-3天**: 用"开始啦""第一天""新旅程"等起步话术
- **第4-10天**: 用"坚持真棒""已经X天了""继续保持"
- **第11天以后**: 用"快达成了""最后冲刺""胜利在望"

### 内容差异化规则
- **日期差异**: 周末 vs 工作日应有不同安排（周末更宽松、增加娱乐）
- **进度变化**: 根据当前是第${context.progress.currentDay + 1}天调整话术
- **天气适配**: ${context.weather?.weather || '晴'}天安排户外，雨天改为室内
- **活动轮换**: 相同类型任务（刷牙/阅读）每天换一种具体活动或表达方式

请生成 4-5 个任务，每个任务包含:

\`\`\`json
{
  "time": "HH:MM",
  "type": "routine | activity | meal | reminder",
  "title": "简短标题",
  "content": "完整的播报文本 (20-50字，温馨童趣)",
  "scheduleId": "自动生成"
}
\`\`\`

### 时间安排参考 (基于目标类型)
`;

    // 根据目标类型给出时间安排建议
    switch (goal.type) {
      case 'habit':
        if (goal.title.includes('早起') || goal.title.includes('起床')) {
          prompt += `- 07:00 起床提醒\n`;
          prompt += `- 10:00 活动\n`;
          prompt += `- 12:00/18:00 吃饭提醒\n`;
          prompt += `- 21:00 睡觉提醒\n`;
        } else if (goal.title.includes('阅读')) {
          prompt += `- 19:00 开始阅读\n`;
          prompt += `- 19:35 阅读完成\n`;
        }
        break;

      default:
        prompt += `- 根据目标的 targetTime (${goal.config.targetTime}) 安排主要任务\n`;
        prompt += `- 在前后适当添加辅助任务\n`;
    }

    prompt += `
### 内容风格要求
- 温馨、鼓励、有童趣感
- 适合小爱音箱 TTS 播报
- 包含进度反馈 (如"第X天啦！""已经坚持X%了！")
- 可使用 emoji 增加亲和力 ☀️ ⭐ 🎉 📚 🚲 ⚽

## ✅ 输出格式（必须严格遵守）

请**直接在回复中输出以下 JSON**（用 \`\`\`json 代码块包裹）：

\`\`\`json
{
  "goalId": "${goal.id}",
  "date": "${context.date}",
  "dayNumber": ${context.progress.currentDay + 1},

  "context": {
    "weather": ${JSON.stringify(context.weather)},
    "holiday": ${JSON.stringify(context.holiday)},
    "progress": ${JSON.stringify(context.progress)}
  },

  "tasks": [
    // 4-5个任务对象
  ],

  "adjustmentSummary": {
    "totalAdjustments": ${ruleBasedAdjustments.length},
    "reasons": [${ruleBasedAdjustments.map(a => `"${a.reason}"`).join(', ')}]
  },

  "metadata": {
    "generatedAt": "${new Date().toISOString()}",
    "generatedBy": "opencode",
    "model": "${this.modelName}"
  }
}
\`\`\`

## ⚠️ 重要提示

1. **必须输出完整的 JSON 代码块**，不要省略任何字段
2. JSON 必须符合上面的 Schema 格式
3. tasks 数组包含 4-5 个任务，每个任务都要有 time, type, title, content
4. 在 JSON 代码块后可以添加简短的确认文字

## 💬 回复示例

\`\`\`json
{
  "goalId": "-21--mpgz6j6i",
  "date": "2026-06-01",
  "dayNumber": 1,
  "context": { ... },
  "tasks": [
    {
      "time": "09:00",
      "type": "routine",
      "title": "晨间唤醒",
      "content": "早上好宝贝！第1天挑战开始啦！记得喝杯温水哦～☀️",
      "scheduleId": "sched-001"
    }
  ],
  ...
}
\`\`\`

✅ 明天的计划已生成！共4个任务，明天见！
`;

    return prompt;
  }

  _buildSystemPrompt() {
    return `
你是一个智能生活管家的任务规划师。你的核心任务是**生成每日任务计划的 JSON 数据**。

【工作方式 — 严格遵守】
1. 分析用户提供的日期、天气、进度等上下文信息
2. **直接在回复中输出一个完整的 JSON 代码块**（用 \`\`\`json 包裹）
3. 不要输出其他内容，不要解释，不要创建文件，只输出 JSON

【最重要的规则】
- 你的回复必须且只能包含一个 \`\`\`json ... \`\`\` 代码块
- 代码块内必须是完整的 JSON 对象，包含 goalId, date, tasks 等字段
- tasks 数组中必须有 4-5 个任务对象，每个有 time, type, title, content
- 如果不知道某些字段的值，也不要省略，用合理默认值填充

【设计原则】
- **个性化**: 根据天气、节日、进度动态调整内容
- **合理性**: 任务时间要符合生活规律，不要过于密集或稀疏
- **激励性**: 进度关键节点要加入鼓励话语
- **安全性**: 下雨天不要安排户外活动

【内容质量标准】
- 每个任务的 content 字段必须是完整句子 (20-50字)
- 适合儿童的语言风格（温馨、有趣、易懂）
- 避免敏感词和负面表达
- 合理使用 emoji 但不过度

【时间安排原则】
- 早上任务: 简洁有力，快速唤醒
- 白天任务: 可以详细一些，引导活动
- 晚上任务: 温馨舒缓，准备休息
- 周末可以比工作日宽松15-30分钟

【每日差异化原则 — 必须遵守】
- **绝对不要**连续两天生成相同的任务列表
- 根据当前是第几天调整话术：第1天用"开始啦"，中期用"坚持真棒"，后期用"快达成了"
- 周末增加娱乐/户外时间，工作日侧重学习/习惯
- 相同类型的任务（如刷牙、阅读）每天换一种表达方式
`;
  }

  // ==================== 上下文收集 ====================

  async _gatherContext(date, goal) {
    let weather = null;
    let holiday = null;

    try {
      weather = await this.getWeather(date, this.defaultCity);
      console.log(`🌤️ [DynamicAdjuster] 天气: ${weather?.weather || '未知'} (${weather?.temp || '-'})`);
    } catch (e) {
      console.warn(`⚠️ [DynamicAdjuster] 天气获取失败:`, e.message);
      weather = { weather: '晴', temp: '20°C', city: this.defaultCity, tips: '' };
    }

    try {
      holiday = await this.getHoliday(date);
      console.log(`📅 [DynamicAdjuster] 日期: ${holiday?.weekday}, ${holiday?.isWeekend ? '周末' : '工作日'}, 事件: ${holiday?.events?.join(', ') || '无'}`);
    } catch (e) {
      console.warn(`⚠️ [DynamicAdjuster] 节日获取失败:`, e.message);
      holiday = { weekday: this._getWeekday(date), isWeekend: false, events: [], isWorkday: true };
    }

    return {
      date: date.toISOString().split('T')[0],
      weather: weather || {},
      holiday: holiday || {},
      progress: { ...goal.progress },
      history: (goal.adjustments || []).slice(-5),
      config: { ...goal.config },
      preferences: { ...goal.preferences }
    };
  }

  _logContext(context) {
    console.log(`\n📋 [DynamicAdjuster] 上下文信息:`);
    console.log(`   📅 日期: ${context.date} (${context.holiday.weekday})`);
    console.log(`   🌤️ 天气: ${context.weather.weather || '未知'} (${context.weather.temp || '-'})`);
    console.log(`   📊 进度: Day ${context.progress.currentDay + 1}/${context.progress.totalDays} (${context.progress.percentage}%)`);
    console.log(`   🔥 连续: ${Math.max(0, context.progress.streak)} 天`);
    if (context.holiday.events?.length > 0) {
      console.log(`   🎉 特殊事件: ${context.holiday.events.join(', ')}`);
    }
  }

  // ==================== 规则引擎 ====================

  _shouldAdjustBasedOnRules(context) {
    const adjustments = [];
    const { weather, holiday, progress } = context;

    if (['雨', '雪', '雷阵雨', '小雨', '大雨'].includes(weather.weather)) {
      adjustments.push({
        type: 'weather',
        reason: `weather_${weather.weather.replace(/\s+/g, '_').toLowerCase()}`,
        targetTaskTypes: ['activity', 'outdoor'],
        suggestion: '改为室内活动',
        priority: 'high'
      });
    }

    if (holiday.isWeekend) {
      adjustments.push({
        type: 'weekend',
        reason: 'weekend_relaxation',
        effect: 'time_flexible_30min',
        suggestion: '时间可适当宽松',
        priority: 'medium'
      });
    }

    if (holiday.events && holiday.events.length > 0) {
      for (const event of holiday.events) {
        if (!event.includes('周末')) {
          adjustments.push({
            type: 'holiday',
            reason: `holiday_${event}`,
            effect: 'add_greeting',
            suggestion: `添加${event}祝福`,
            priority: 'high'
          });
        }
      }
    }

    if (progress.percentage >= 80) {
      adjustments.push({
        type: 'progress',
        reason: 'progress_near_complete',
        effect: 'encouragement_mode',
        suggestion: '加入庆祝和总结性鼓励',
        priority: 'medium'
      });
    }

    if (progress.streak >= 7 && progress.streak % 7 === 0) {
      adjustments.push({
        type: 'streak',
        reason: `streak_milestone_${progress.streak}`,
        effect: 'celebration',
        suggestion: `庆祝连续${progress.streak}天成就`,
        priority: 'high'
      });
    }

    return adjustments;
  }

  // ==================== 降级方案 ====================

  async _fallbackAdjustment(goalId, targetDate, dayOffset) {
    console.warn(`⚠️ [DynamicAdjuster] 使用降级方案生成计划 (dayOffset=${dayOffset || '-'})`);

    try {
      const goal = await this.goalManager.getGoal(goalId);
      if (!goal) throw new Error('目标不存在');

      // ✅ 支持动态日期（默认=明天）
      let fallbackDate;
      if (targetDate === 'today' || targetDate === 'now') {
        fallbackDate = new Date();
      } else if (targetDate && /^\d{4}-\d{2}-\d{2}$/.test(targetDate)) {
        fallbackDate = new Date(targetDate);
      } else {
        fallbackDate = new Date(Date.now() + 86400000);
      }
      const dateStr = fallbackDate.toISOString().split('T')[0];
      const planPath = path.join(this.outputDir, `${goalId}-${dateStr}.json`);

        // 根据目标偏好生成差异化任务模板
        const dayNum = goal.progress.currentDay + (dayOffset || 1);
        const totalDays = goal.progress.totalDays || 30;
        const pct = Math.round((dayNum / totalDays) * 100);
        const isWeekend = [0, 6].includes(fallbackDate.getDay());
        const weekdayName = this._getWeekday(fallbackDate);

        // 阶段化话术库
        const phases = {
          start: {   // 第1-3天：起步阶段
            morning: [
              '新挑战开始啦！🎉 今天开始我们的30天阅读+刷牙大冒险，宝贝准备好了吗？',
              '早安小探险家！🌟 第{day}天的习惯养成之旅正式启程，让我们一起加油！',
              '美好的一天从好习惯开始！☀️ 今天是第{day}天，你一定可以做到的！'
            ],
            activity: [
              '挑选今晚绘本📚 小探险家，快去挑一本最喜欢的绘本吧！今晚我们一起读～你选哪本呢？✨',
              '绘本时间到！📖 去书架选一本最爱的故事书，今天想听什么故事呢？期待哦！🌟',
              '选书大作战！🔍 宝贝今天想读什么类型的书？冒险？童话？还是科普？快去挑一本吧！'
            ],
            reading: [
              '阅读时间到！🎉 和爸爸妈妈一起读15分钟，看看故事里有什么有趣的事吧～记住，每天坚持就会越来越棒哦！📖⭐',
              '叮咚～阅读时间开始啦！📚 今天的故事一定会很精彩，坐好听故事吧！每读完一页都是进步哦！💪',
              '亲子共读时光！👨‍👩‍👧 和爸爸妈妈一起翻开书本，让想象力飞起来吧！今天的你会收获满满的快乐和知识！✨'
            ],
            share: [
              '阅读完成，你太棒啦！⭐ 跟爸爸妈妈说说今天读了什么故事？有没有认识新的词语？每一天的坚持都让你变得更厉害哦！🎉',
              '哇塞，今天又读完了一本书！🏆 跟大家分享一下你觉得最好玩的情节吧！你的表达能力越来越强了！👏',
              '分享时刻！💬 把今天读到的好玩故事讲给家人听吧！你已经是个小小故事家了！🌈'
            ],
            brush: [
              '刷牙时间到咯～🦷 拿起小牙刷，上上下下左左右右，把蛀牙小怪兽全部赶跑！刷完记得让爸爸妈妈检查，白白的牙齿真好看！😁✨',
              '牙齿保卫战开始！🪥 认真刷满2分钟，每个角落都不要放过哦！坚持刷牙的你是最帅/最美的！😊',
              '小牙医上岗啦！🩺 拿起牙刷给每一颗牙齿做个SPA吧！刷得干干净净，笑容才会更灿烂哦！🌟'
            ],
            night: [
              '第{day}天挑战圆满成功！🎉 今天你读了故事又刷了牙，已经迈出了成为习惯小超人的第一步！明天继续加油，晚安宝贝，做个甜甜的梦～🌙😴',
              '太棒了第{day}天！🌟 你完成了所有任务，离目标又近了一步！好好休息，明天继续加油哦！晚安～💤',
              '今日打卡完成✅ 第{day}天的努力值得点赞！贴上一颗小星星⭐，明天继续加油哦！晚安宝贝，做个美梦～🚀'
            ]
          },
          persist: {  // 第4-10天：坚持阶段
            morning: [
              '坚持就是胜利！💪 第{day}天了，你已经比昨天更棒了！继续保持这个好势头！',
              '连续{day}天打卡！🔥 你的毅力让人佩服！今天也要元气满满地完成任务哦！',
              '第{day}天挑战继续！⚡ 你已经养成习惯了，今天轻松搞定它！'
            ],
            activity: [
              '今天换个口味？🍽️ 尝试读一本没看过的书吧！新故事带来新惊喜！🎁',
              '绘本探索家！🗺️ 今天试试读一本新主题的书？科学？自然？冒险等你来发现！',
              '换本书看看？📕 昨天读的那本好看吗？今天来点新鲜的，去书架上找找新朋友吧！'
            ],
            reading: [
              '第{day}天阅读打卡！📖 你已经坚持这么久了，真了不起！今天我们读一个更有趣的故事吧～',
              '阅读习惯正在形成中！🌱 第{day}天了，你的专注力越来越强了！享受这15分钟的亲子时光吧！',
              '坚持阅读的第{day}天！📚 每一次翻页都在为未来积累力量，你做得很棒！'
            ],
            share: [
              '{day}天连续阅读！🏅 这个成就值得骄傲！今天学到了什么新知识？快分享一下吧！',
              '分享你的阅读心得！💭 第{day}天了，你对故事的理解越来越深了呢！说说看今天的故事讲了什么？',
              '阅读达人就是你！🎯 连续{day}天读书，你的词汇量一定增长了不少！用新学的词语造个句吧！'
            ],
            brush: [
              '第{day}天刷牙打卡！🦷 牙齿每天都在变白变健康哦！继续保持这个好习惯！✨',
              '牙齿越来越亮了！😁 坚持刷牙{day}天，蛀牙早就吓跑了！今天也认真刷一遍吧！',
              '刷牙小能手！🏆 已经连续{day}天认真刷牙了！这个好习惯会陪伴你一辈子哦！'
            ],
            night: [
              '第{day}天圆满完成！🎯 你已经坚持了一周多了，这种毅力太难得了！明天继续，你是最棒的！🌙',
              '连续{day}天打卡成功！🔥 离30天目标越来越近了！好好休息，明天又是充满活力的一天！💪',
              '今日任务全部搞定✅ {pct}%的进度了！你真的很厉害！早点休息，养足精神迎接明天！⭐'
            ]
          },
         冲刺: {  // 第11天+：冲刺阶段
            morning: [
              '冲刺阶段！🚀 第{day}天了，你已经是大孩子了！今天的任务对你来说已经是小菜一碟！',
              '接近终点线！🏁 第{day}天/共{total}天，你已经走了{pct}%的路程！最后冲刺加油！',
              '习惯已成自然！🌟 第{day}天，阅读和刷牙已经是你生活的一部分了！今天也轻松完成吧！'
            ],
            activity: [
              '挑战高难度绘本！📚 试着读一本字多一点的书吧？我相信你可以的！💯',
              '阅读升级！⬆️ 第{day}天了，试试自己读一部分？然后让爸妈帮忙读剩下的？',
              '成为阅读小专家！🎓 选一本有深度的书，今天我们来讨论一下书中的道理吧！'
            ],
            reading: [
              '第{day}天！你已经是阅读高手了！📖 今天的15分钟对你来说一定是享受时光！',
              '阅读已经成为你的超能力了！⚡ 第{day}天，享受这段安静而美好的亲子时光吧～',
              '倒计时模式开启！⏳ 再坚持几天就达成目标了！今天的阅读格外有意义哦！'
            ],
            share: [
              '阅读大师分享时间！🎤 第{day}天了，试着总结一下今天故事的主题思想吧！',
              '深度思考时间！🧠 读完了？来分析一下人物性格？你的理解力真的在飞速提升！',
              '{day}天的积累不是白费的！📝 试着写一句话读后感？或者画一幅画表达感受？'
            ],
            brush: [
              '牙齿健康守护者！🛡️ 第{day}天，你的牙齿感谢你的坚持！继续守护它们吧！',
              '刷牙大师！🥇 {day}天的坚持让你的笑容更加自信！今天也给牙齿做个完美护理！',
              '最后的冲刺！🏃‍♂️ 刷牙这件事对你来说已经是本能反应了！做得好，继续保持！'
            ],
            night: [
              '第{day}天！只差一点点了！🎉 你已经完成了{pct}%的目标！太不可思议了！',
              '即将达成30天成就！🏆 再坚持几天你就是真正的习惯超人！今晚好好休息！🌟',
              '里程碑式的一天！📍 第{day}天打卡完成！你已经证明了你可以做到任何事！为你骄傲！🌙'
            ]
          }
        };

        // 选择阶段
        let phase;
        if (dayNum <= 3) phase = phases.start;
        else if (dayNum <= 10) phase = phases.persist;
        else phase = phases.冲刺;

        // 选择该阶段的文案（按天数轮换，确保每天不同）
        const pick = (arr) => arr[(dayNum - 1) % arr.length];
        const fmt = (s) => s.replace(/{day}/g, dayNum).replace(/{total}/g, totalDays).replace(/{pct}/g, pct);

        // 时间根据周末/工作日微调
        const baseTime = parseInt((goal.config.targetTime || '08:00').split(':')[0]);
        const morningTime = `${String(baseTime).padStart(2, '0')}:00`;
        const activityTime = `${String(baseTime + 8).padStart(2, '0')}:${isWeekend ? '00' : '30'}`;
        const readTime = `${String(baseTime + 11).padStart(2, '0')}:00`;
        const shareTime = `${String(baseTime + 11).padStart(2, '0')}:${isWeekend ? '25' : '35'}`;
        const brushTime = `${String(baseTime + 12).padStart(2, '0')}:${isWeekend ? '10' : '15'}`;
        const nightTime = `${String(baseTime + 12).padStart(2, '0')}:${isWeekend ? '35' : '40'}`;

        const now = Date.now();
        const fallbackPlan = {
          goalId,
          date: dateStr,
          dayNumber: dayNum,

          context: {
            weather: { weather: '晴', temp: '25°C', city: '本地' },
            holiday: {
              weekday: weekdayName,
              isWeekend,
              events: []
            },
            progress: { ...goal.progress, currentDay: dayNum - 1 }
          },

          tasks: [
            {
              time: morningTime,
              type: 'reminder',
              title: '起床提醒',
              content: fmt(pick(phase.morning)),
              scheduleId: `sched-fb-${now}-1`
            },
            {
              time: activityTime,
              type: 'activity',
              title: '挑选绘本',
              content: fmt(pick(phase.activity)),
              scheduleId: `sched-fb-${now}-2`
            },
            {
              time: readTime,
              type: 'routine',
              title: '亲子阅读时间',
              content: fmt(pick(phase.reading)),
              scheduleId: `sched-fb-${now}-3`
            },
            {
              time: shareTime,
              type: 'routine',
              title: '阅读分享',
              content: fmt(pick(phase.share)),
              scheduleId: `sched-fb-${now}-4`
            },
            {
              time: brushTime,
              type: 'routine',
              title: '刷牙小卫士',
              content: fmt(pick(phase.brush)),
              scheduleId: `sched-fb-${now}-5`
            },
            {
              time: nightTime,
              type: 'reminder',
              title: '睡前晚安 & 打卡完成',
              content: fmt(pick(phase.night)),
              scheduleId: `sched-fb-${now}-6`
            }
          ],

          adjustmentSummary: { totalAdjustments: 0, reasons: [] },

          metadata: {
            generatedAt: new Date().toISOString(),
            generatedBy: 'fallback-rich-template',
            note: `AI生成失败，使用丰富降级模板 (Day ${dayNum}/${totalDays}, ${pct}%)`
          }
        };

      await fs.ensureDir(this.outputDir);
      await fs.writeJson(planPath, fallbackPlan, { spaces: 2 });

      await this.goalManager.saveDailyPlan(fallbackPlan);

      console.log(`✅ [DynamicAdjuster] 降级计划已保存: ${planPath}`);

      return fallbackPlan;

    } catch (error) {
      console.error(`❌ [DynamicAdjuster] 降级方案也失败了:`, error.message);
      return null;
    }
  }

  // ==================== 工具方法 ====================

  _getWeekday(date) {
    const weekdays = ['星期日', '星期一', '星期二', '星期三', '星期四', '星期五', '星期六'];
    return weekdays[date.getDay()];
  }

  async _defaultGetWeather(date, city) {
    return { weather: '晴', temp: '25°C', city: city || '未知', tips: '天气不错' };
  }

  async _defaultGetHoliday(date) {
    return {
      weekday: this._getWeekday(date),
      isWeekend: [0, 6].includes(date.getDay()),
      events: [],
      isWorkday: ![0, 6].includes(date.getDay())
    };
  }
}

export default DynamicAdjuster;
