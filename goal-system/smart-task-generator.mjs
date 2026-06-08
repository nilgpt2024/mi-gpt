/**
 * 智能任务生成器 (SmartTaskGenerator) v2.0
 * 
 * 职责: 统一的 AI 任务处理入口
 * - 自动识别用户意图（创建目标/生成计划/纯对话）
 * - 协调 GoalParser、DynamicAdjuster 等组件
 * - 统一返回格式，简化调用方代码
 */

import { GoalParser } from './goal-parser.mjs';
import { DynamicAdjuster } from './dynamic-adjuster.mjs';
import { IterativeFileGenerator } from './iterative-generator.mjs';

export class SmartTaskGenerator {
  constructor(sessionManager, options = {}) {
    this.sessionManager = sessionManager;
    this.goalManager = options.goalManager;
    
    // 初始化子组件
    this.goalParser = new GoalParser(sessionManager, options.goalParserOptions || {});
    this.dynamicAdjuster = new DynamicAdjuster(
      sessionManager,
      options.getWeatherFn,
      options.getHolidayFn,
      options.goalManager,
      { ...options.dynamicAdjusterOptions, generatorOptions: options.generatorOptions }
    );
    
    // 配置
    this.defaultModel = options.defaultModel || 'gpt-4o-mini';
  }

  /**
   * 处理用户命令 (统一入口)
   * 
   * @param {string} command - 用户输入的命令/请求
   * @returns {Promise<Object>} 标准化的处理结果
   */
  async processCommand(command, options = {}) {
    const startTime = Date.now();
    const { customSystemPrompt, customUserPrompt, targetDate: externalTargetDate } = options || {};

    console.log(`\n${'='.repeat(60)}`);
    console.log(`🤖 [SmartTaskGenerator] 收到命令: "${command.substring(0, 60)}..."`);
    if (customSystemPrompt) {
      console.log(`📝 [SmartTaskGenerator] 使用自定义系统提示词 (${customSystemPrompt.length}字符)`);
    }
    if (customUserPrompt) {
      console.log(`💬 [SmartTaskGenerator] 用户额外提示: "${customUserPrompt.substring(0, 50)}..."`);
    }
    if (externalTargetDate) {
      console.log(`📅 [SmartTaskGenerator] 外部指定目标日期: ${externalTargetDate}`);
    }
    console.log(`${'='.repeat(60)}\n`);

    try {
      // Step 1: 意图识别
      const intent = await this._detectIntent(command);
      console.log(`🎯 [SmartTaskGenerator] 检测到意图: ${intent.type} (置信度: ${intent.confidence})`);

      // ✅ 将自定义提示词和目标日期附加到 intent 对象，供后续处理器使用
      // 目标日期优先级：外部传入 > 意图识别 > 默认值(tomorrow)
      intent.customSystemPrompt = customSystemPrompt;
      intent.customUserPrompt = customUserPrompt;
      if (externalTargetDate) {
        intent.targetDate = externalTargetDate;
        console.log(`📅 [SmartTaskGenerator] 使用外部指定目标日期: ${externalTargetDate}`);
      }
      if (options.dayOffset) {
        intent.dayOffset = options.dayOffset;
        console.log(`📆 [SmartTaskGenerator] 天数偏移: Day ${options.dayOffset}`);
      }

      let result;

      switch (intent.type) {
        case 'create_goal':
          result = await this._handleCreateGoal(command, { customSystemPrompt, customUserPrompt });
          break;

        case 'adjust_plan':
          result = await this._handleAdjustPlan(intent);
          break;

        case 'query_status':
          result = await this._handleQueryStatus();
          break;

        case 'conversation':
        default:
          result = await this._handleConversation(command);
          break;
      }

      const duration = Date.now() - startTime;
      
      console.log(`\n✅ [SmartTaskGenerator] 命令处理完成 (${duration}ms)`);
      console.log(`   类型: ${result.responseType}`);
      console.log(`   成功: ${result.success}`);

      return {
        ...result,
        processingTime: duration,
        timestamp: new Date().toISOString()
      };

    } catch (error) {
      console.error(`❌ [SmartTaskGenerator] 处理失败:`, error.message);

      return {
        success: false,
        error: error.message,
        responseType: 'error',
        replyToUser: `抱歉，处理您的请求时出错了: ${error.message}`,
        processingTime: Date.now() - startTime,
        timestamp: new Date().toISOString()
      };
    }
  }

  /**
   * 快速模式 (跳过意图识别，直接使用指定类型)
   */
  async createGoal(userRequest) {
    return this.goalParser.parse(userRequest);
  }

  async generateDailyPlan(goalId, forceRegenerate = false) {
    return this.dynamicAdjuster.dailyAdjustment(goalId, forceRegenerate);
  }

  async batchGeneratePlans(options = {}) {
    return this.dynamicAdjuster.batchAdjustAllActiveGoals(options);
  }

  // ==================== 意图识别 ====================

  async _detectIntent(command) {
    const text = command.toLowerCase();

    // 创建目标的关键词
    const createKeywords = [
      /帮我.*?(养成|建立|设定|创建|开始)/,
      /.*?(习惯|目标|计划|挑战|任务).*(?:21|30|7|14|100).*天/,
      /.*?目标.*?(?:是|为|叫|关于)/,
      /新建|添加|创建.*?(目标|习惯|计划)/
    ];

    for (const pattern of createKeywords) {
      if (pattern.test(text)) {
        return { type: 'create_goal', confidence: 0.9 };
      }
    }

    // 调整计划的关键词
    const adjustKeywords = [
      /调整|重新生成|更新|修改.*?计划/,
      /生成.*?(明天|今日|今天|现在).*?计划/,
      /刷新|重做.*?任务/
    ];

    for (const pattern of adjustKeywords) {
      if (pattern.test(text)) {
        // ✅ 提取目标日期
        let targetDate = 'tomorrow'; // 默认明天
        if (/今日|今天|现在/.test(text)) {
          targetDate = 'today';
        }
        return { type: 'adjust_plan', confidence: 0.85, targetDate };
      }
    }

    // 查询状态的关键词
    const queryKeywords = [
      /查询|查看|显示|列出|什么.*?进度|怎么样|如何/
    ];

    for (const pattern of queryKeywords) {
      if (pattern.test(text)) {
        return { type: 'query_status', confidence: 0.8 };
      }
    }

    // 默认为对话
    return { type: 'conversation', confidence: 0.5 };
  }

  // ==================== 处理器 ====================

  async _handleCreateGoal(command) {
    console.log(`📝 [SmartTaskGenerator] 处理: 创建新目标`);

    const result = await this.goalParser.parse(command);

    if (!result.success) {
      return {
        success: false,
        responseType: 'error',
        replyToUser: result.replyToUser || '创建目标失败，请稍后重试。',
        error: result.error
      };
    }

    return {
      success: true,
      responseType: result.usedFallback ? 'fallback' : 'mixed',
      replyToUser: result.replyToUser || `✅ 目标已创建: ${result.goal?.title}`,
      entity: {
        type: 'goal',
        id: result.goal?.id,
        title: result.goal?.title,
        status: result.goal?.status,
        duration: result.goal?.config?.duration
      },
      generatedFiles: result.generatedFiles || [],
      data: result.goal,
      filePath: result.filePath
    };
  }

  async _handleAdjustPlan(intent) {
    console.log(`🔄 [SmartTaskGenerator] 处理: 调整计划`);

    if (!this.goalManager) {
      return {
        success: false,
        responseType: 'error',
        replyToUser: '系统未正确初始化，无法调整计划。'
      };
    }

    // ✅ 提取自定义提示词和目标日期
    const customSystemPrompt = intent.customSystemPrompt || null;
    const customUserPrompt = intent.customUserPrompt || null;
    const forceRegenerate = true;
    const targetDate = intent.targetDate || 'tomorrow'; // ✅ 透传目标日期

    console.log(`🔄 [SmartTaskGenerator] 强制重新生成模式 (forceRegenerate=${forceRegenerate}, targetDate=${targetDate})`);
    if (customSystemPrompt) {
      console.log(`   📝 自定义系统提示词: ${customSystemPrompt.substring(0, 30)}...`);
    }
    if (customUserPrompt) {
      console.log(`   💬 用户额外提示: ${customUserPrompt.substring(0, 30)}...`);
    }

    if (intent.goalId) {
      console.log(`🔄 [SmartTaskGenerator] 强制重新生成模式 (forceRegenerate=${forceRegenerate}, targetDate=${targetDate}, dayOffset=${intent.dayOffset || '-'})`);
      const plan = await this.dynamicAdjuster.dailyAdjustment(intent.goalId, forceRegenerate, {
        customSystemPrompt,
        customUserPrompt,
        targetDate,   // ✅ 透传目标日期
        dayOffset: intent.dayOffset  // ✅ 透传天数偏移
      });

      return {
        success: !!plan,
        responseType: plan ? 'file_generation' : 'empty',
        replyToUser: plan ? `✅ 计划已生成！共 ${plan.tasks?.length || 0} 个任务。` : '没有需要调整的计划。',
        entity: plan ? {
          type: 'dailyPlan',
          date: plan.date,
          taskCount: plan.tasks?.length || 0
        } : null,
        data: plan
      };
    } else {
      console.log(`🔄 [SmartTaskGenerator] 批量强制重新生成模式 (forceRegenerate=${forceRegenerate}, targetDate=${targetDate}, dayOffset=${intent.dayOffset || '-'})`);
      const batchResult = await this.dynamicAdjuster.batchAdjustAllActiveGoals({
        forceRegenerate: forceRegenerate,
        customSystemPrompt,     // ✅ 传递自定义系统提示词
        customUserPrompt,       // ✅ 传递用户额外提示
        targetDate,             // ✅ 传递目标日期
        dayOffset: intent.dayOffset  // ✅ 传递天数偏移
      });

      const summary = batchResult.summary || {};
      const results = batchResult.results || [];

      // 从批量结果中提取第一个成功生成的计划数据
      const firstSuccessfulPlan = results.find(r => r.status === 'adjusted' && r.plan);
      const planData = firstSuccessfulPlan?.plan || null;

      console.log(`📊 [SmartTaskGenerator] 批量结果:`);
      console.log(`   成功: ${summary.successful}, 计划数据: ${planData ? '✅ 有' : '❌ 无'}`);
      if (planData) {
        console.log(`   任务数: ${planData.tasks?.length || 0}`);
      }

      return {
        success: summary.successful > 0,
        responseType: planData ? 'file_generation' : 'batch_operation',
        replyToUser: planData
          ? `✅ 计划已生成！共 ${planData.tasks?.length || 0} 个任务。`
          : `批量调整完成！成功: ${summary.successful}, 跳过: ${summary.skipped || 0}, 失败: ${summary.failed || 0}`,
        entity: planData ? {
          type: 'dailyPlan',
          date: planData.date,
          taskCount: planData.tasks?.length || 0
        } : {
          type: 'batchResult',
          totalProcessed: batchResult.totalGoalsProcessed,
          ...summary
        },
        data: planData || batchResult.results,  // 优先返回计划数据，否则返回批量结果
        generatedFiles: planData ? [{
          path: `data/daily-plans/${planData.goalId}-${planData.date}.json`,
          filename: `${planData.goalId}-${planData.date}.json`,
          generatedBy: planData.metadata?.generatedBy || 'unknown'
        }] : []
      };
    }
  }

  async _handleQueryStatus() {
    console.log(`📊 [SmartTaskGenerator] 处理: 查询状态`);

    if (!this.goalManager) {
      return {
        success: false,
        responseType: 'error',
        replyToUser: '无法获取状态信息。'
      };
    }

    try {
      const goals = await this.goalManager.getAllGoals();
      const activeCount = goals.filter(g => ['planning', 'in_progress', 'near_complete'].includes(g.status)).length;

      return {
        success: true,
        responseType: 'conversation',
        replyToUser: `当前共有 ${goals.length} 个目标，其中 ${activeCount} 个活跃中。`,
        entity: {
          type: 'statusOverview',
          totalGoals: goals.length,
          activeGoals: activeCount
        },
        data: goals
      };
    } catch (e) {
      return {
        success: false,
        responseType: 'error',
        replyToUser: '查询状态失败。',
        error: e.message
      };
    }
  }

  async _handleConversation(command) {
    console.log(`💬 [SmartTaskGenerator] 处理: 纯对话`);

    try {
      const response = await this.sessionManager.chat(
        { text: command },
        {
          model: this.defaultModel,
          temperature: 0.7,
          directory: 'conversations'
        }
      );

      const text = response.content || response.text || '';

      return {
        success: true,
        responseType: 'conversation',
        replyToUser: text || '收到您的消息，但我暂时无法回复。',
        data: { rawResponse: response }
      };
    } catch (e) {
      return {
        success: true,
        responseType: 'conversation',
        replyToUser: '我收到了您的消息，但AI服务暂时不可用。请稍后再试。',
        warning: 'AI service unavailable'
      };
    }
  }

  // ==================== 工具方法 ====================

  getStats() {
    return {
      goalParser: this.goalParser.generator?.getStats(),
      dynamicAdjuster: this.dynamicAdjuster.generator?.getStats()
    };
  }

  clearHistory() {
    if (this.goalParser.generator) {
      this.goalParser.generator.clearHistory();
    }
    if (this.dynamicAdjuster.generator) {
      this.dynamicAdjuster.generator.clearHistory();
    }
  }
}

export default SmartTaskGenerator;
