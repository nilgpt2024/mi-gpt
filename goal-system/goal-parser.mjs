/**
 * AI 目标解析器 (GoalParser) v2.0
 * 
 * 重构说明:
 * - ❌ 旧版: OpenCode 返回 JSON → 手动解析 → 构建对象 → 保存
 * - ✅ 新版: 指定路径 + Prompt → OpenCode 直接生成文件 → 加载使用
 * 
 * 核心优势:
 * - 更可靠: 避免JSON解析错误
 * - 更简洁: 代码量减少50%+
 * - 更透明: 生成的文件可直接查看和编辑
 */

import path from 'path';
import { IterativeFileGenerator } from './iterative-generator.mjs';

export class GoalParser {
  constructor(sessionManager, options = {}) {
    this.sessionManager = sessionManager;
    
    // 初始化迭代生成器
    this.generator = new IterativeFileGenerator(sessionManager, options.generatorOptions || {});
    
    // 配置项
    this.outputDir = options.outputDir || 'data/goals';
    this.defaultModel = options.defaultModel || 'gpt-4o-mini';
  }

  /**
   * 解析用户输入并生成目标文件 (主方法)
   * 
   * @param {string} userRequest - 用户原始输入 (如 "帮我养成21天早起的习惯")
   * @returns {Promise<Object>} 包含 goal 数据和回复文本的结果对象
   */
  async parse(userRequest) {
    try {
      console.log(`\n🧠 [GoalParser v2.0] 开始解析: "${userRequest.substring(0, 50)}..."`);
      
      if (!this.sessionManager) {
        console.warn(`⚠️ [GoalParser] SessionManager 未初始化，使用降级方案`);
        return this._fallbackParse(userRequest);
      }

      // 定义输出文件路径
      const fileId = `goal-${Date.now()}`;
      const filePath = path.join(this.outputDir, `${fileId}.json`);

      console.log(`📄 [GoalParser] 目标文件路径: ${filePath}`);

      // 使用迭代修正引擎生成文件
      const result = await this.generator.generateWithValidation(
        {
          text: this._buildPrompt(userRequest, filePath),
          systemPrompt: this._buildSystemPrompt(),
          model: this.defaultModel,
          userRequest
        },
        'goal'  // Schema 类型
      );

      if (!result.success) {
        throw new Error(result.error || '目标文件生成失败');
      }

      console.log(`✅ [GoalParser] 目标创建成功:`);
      console.log(`   文件: ${result.filePath}`);
      console.log(`   尝试次数: ${result.attempts}`);
      if (result.usedFallback) {
        console.log(`   ⚠️  使用了降级方案`);
      }
      console.log(`   回复: ${result.replyToUser?.substring(0, 80)}...`);

      return {
        success: true,
        goal: result.data,
        filePath: result.filePath,
        replyToUser: result.replyToUser,
        generatedFiles: result.files,
        attempts: result.attempts,
        usedFallback: result.usedFallback || false
      };

    } catch (error) {
      console.error(`❌ [GoalParser] 解析失败:`, error.message);
      
      const fallbackResult = this._fallbackParse(userRequest);
      fallbackResult.error = error.message;
      return fallbackResult;
    }
  }

  /**
   * 快速解析模式 (不进行迭代验证)
   */
  async parseQuick(userRequest) {
    const fileId = `goal-quick-${Date.now()}`;
    const filePath = path.join(this.outputDir, `${fileId}.json`);

    const result = await this.generator.generateQuick({
      text: this._buildPrompt(userRequest, filePath),
      systemPrompt: this._buildSystemPrompt(),
      model: this.defaultModel,
      userRequest
    }, 'goal');

    return {
      ...result,
      goal: result.data || null
    };
  }

  // ==================== Prompt 构建 ====================

  _buildPrompt(userRequest, filePath) {
    return `
## 📋 任务：创建目标配置 JSON

**输出要求**: 请在回复中直接输出完整的 JSON 内容（用 \`\`\`json 代码块包裹），系统会自动保存到文件。

**目标文件路径**: ${filePath}

---

请分析用户需求并生成目标配置 JSON: **${filePath}**

## 用户输入
"${userRequest}"

## 📝 任务要求

请**直接在回复中输出以下 JSON**（用 \`\`\`json 代码块包裹）：

\`\`\`json
{
  "id": "goal-唯一标识",
  "type": "habit | task | health | custom",
  "title": "简短标题 (2-20字)",
  "description": "详细描述",

  "userRequest": "${userRequest}",

  "config": {
    "duration": 数字 (1-365天),
    "frequency": "daily | weekdays | weekends",
    "targetTime": "HH:MM (24小时制)",
    "difficulty": "easy | medium | hard",
    "tone": "gentle | energetic | funny | warm",
    "audience": "目标受众"
  },

  "status": "planning",

  "progress": {
    "currentDay": 0,
    "totalDays": 与config.duration一致,
    "percentage": 0,
    "streak": 0
  },

  "createdAt": "${new Date().toISOString()}",

  "metadata": {
    "generatedBy": "opencode",
    "generatedAt": "${new Date().toISOString()}"
  }
}
\`\`\`

## 🔍 智能推断规则

根据用户输入自动推断:
- **类型识别**:
  - 包含"习惯/养成/坚持/每天" → habit
  - 包含"考试/准备/学会/完成" → task
  - 包含"减肥/运动/健康" → health
  - 其他 → custom

- **周期提取**:
  - "21天" → duration=21
  - "一个月" → duration=30
  - 未明确 → 根据类型给默认值 (habit=21, task=7, health=30)

- **时间推断**:
  - "早起/起床" → targetTime="07:00"
  - "阅读/看书" → targetTime="19:00"
  - "运动" → targetTime="18:00"
  - "睡觉" → targetTime="21:00"

- **语气和受众**:
  - 包含"孩子/宝贝/小朋友" → tone="gentle", audience="宝贝们"
  - 包含"我/自己" → audience="你"

## ⚠️ 重要提示

1. **必须输出完整的 JSON 代码块**，不要省略任何字段
2. JSON 必须符合上面的 Schema 格式
3. id 字段使用唯一标识（如 goal-时间戳）
4. 在 JSON 代码块后可以添加简短的确认文字

## 💬 回复示例

\`\`\`json
{
  "id": "goal-1717200000",
  "type": "habit",
  "title": "21天早起挑战",
  "description": "连续21天早上7点起床的好习惯养成计划",
  "userRequest": "帮我创建一个21天的早起习惯",
  ...
}
\`\`\`

✅ 好的！已为您创建'21天早起挑战'目标！共21天，明天早上7点开始第一次提醒。加油！💪
`;
  }

  _buildSystemPrompt() {
    return `
你是一个智能生活管家的目标规划师。你的核心任务是理解用户的生活目标声明，
并通过**直接生成结构化文件**的方式来创建目标配置。

【工作方式】
1. 分析用户的自然语言描述
2. 在指定的 data/goals/ 目录下创建符合Schema的JSON文件
3. 用友好、鼓励性的语气回复用户确认

【设计原则】
- 针对儿童家庭的目标要温馨、童趣、有鼓励性
- 时间设置要合理（不要过早或过晚）
- 难度要适中（太容易没挑战性，太难容易放弃）
- 标题要简洁有力（2-20个字符）

【质量标准】
- JSON格式必须正确（这是最重要的！）
- 所有必填字段不能缺失
- 数值类型字段必须是有效数字
- 时间格式必须为 HH:MM (24小时制)
- content 字段长度适中 (10-50字适合小爱音箱播报)

【语气风格】
- 温馨友好，像一位贴心的生活助手
- 可以适当使用 emoji 增加亲和力 ☀️ ⭐ 🎉 📚
- 给予积极的鼓励和期待
`;
  }

  // ==================== 降级方案 ====================

  _fallbackParse(userRequest) {
    console.log(`⚠️ [GoalParser] 使用降级方案解析`);

    const now = new Date();
    const text = userRequest.toLowerCase();

    let type = 'custom';
    let duration = 21;
    let title = userRequest.length > 30 ? userRequest.substring(0, 30) : userRequest;
    let targetTime = '09:00';

    // 类型检测
    if (/习惯|养成|坚持|每天|连续/.test(text)) {
      type = 'habit';
      title = text.includes('早起') ? '早起习惯养成' :
              text.includes('阅读') ? '阅读习惯养成' :
              text.includes('喝水') ? '喝水习惯养成' : '习惯养成挑战';
      targetTime = text.includes('早起') ? '07:00' : 
                  text.includes('阅读') ? '19:00' : '09:00';
    } else if (/考试|准备|复习|学会|完成/.test(text)) {
      type = 'task';
      title = text.includes('考试') ? '考试准备' : '任务完成';
    } else if (/减肥|运动|健康|体重|睡眠/.test(text)) {
      type = 'health';
      title = '健康管理目标';
    }

    // 周期提取
    const dayMatch = text.match(/(\d+)\s*[天日]/);
    if (dayMatch) duration = Math.min(parseInt(dayMatch[1]), 365);

    const goalData = {
      id: `goal-fallback-${now.getTime()}`,
      type,
      title,
      description: `基于规则解析: ${userRequest}`,
      userRequest,

      config: {
        duration,
        frequency: 'daily',
        targetTime,
        difficulty: 'medium',
        tone: /孩子|宝贝|小朋友/.test(text) ? 'gentle' : 'encouraging',
        audience: /孩子们|宝贝们/.test(text) ? '宝贝们' : '你'
      },

      status: 'planning',

      progress: {
        currentDay: 0,
        totalDays: duration,
        percentage: 0,
        streak: 0
      },

      createdAt: now.toISOString(),

      metadata: {
        generatedBy: 'fallback-rules',
        confidence: 0.6
      }
    };

    return {
      success: true,
      goal: goalData,
      filePath: null,
      replyToUser: `已为您创建"${title}"目标（基于基础模板），您可以稍后编辑完善详细信息。`,
      generatedFiles: [],
      attempts: 1,
      usedFallback: true,
      note: '使用了规则匹配降级方案'
    };
  }
}

export default GoalParser;
