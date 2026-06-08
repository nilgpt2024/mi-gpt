/**
 * 文件验证器 (FileValidator) v2.0
 * 
 * 职责: 多级验证 OpenCode 生成的文件是否符合要求
 * 
 * 五级验证体系:
 * L1: 文件存在性检查 (Fatal)
 * L2: 格式解析检查 (Fatal)
 * L3: Schema 结构校验 (Fatal)
 * L4: 业务逻辑校验 (Warning)
 * L5: 质量优化建议 (Info)
 */

import fs from 'fs-extra';
import path from 'path';

export class FileValidator {
  constructor(options = {}) {
    this.strictMode = options.strictMode || false;
    this.maxContentLength = options.maxContentLength || 100000; // 100KB
  }

  /**
   * 验证生成的文件 (主方法)
   */
  async validate(filePath, schemaType) {
    const errors = [];
    const startTime = Date.now();

    console.log(`\n🔍 [FileValidator] 开始验证: ${path.basename(filePath)} (Schema: ${schemaType})`);

    // === L1: 文件存在性检查 ===
    if (!fs.existsSync(filePath)) {
      errors.push({
        code: 'FILE_NOT_GENERATED',
        severity: 'fatal',
        message: 'OpenCode 未成功生成文件',
        hint: '请检查 OpenCode 是否正常工作，或查看日志中的错误信息'
      });
      
      return this._buildResult(false, errors, null, startTime);
    }

    // === L2: 格式解析检查 ===
    let content;
    try {
      content = fs.readFileSync(filePath, 'utf-8');
      
      if (!content.trim()) {
        throw new Error('文件内容为空');
      }

      if (content.length > this.maxContentLength) {
        errors.push({
          code: 'FILE_TOO_LARGE',
          severity: 'warning',
          message: `文件过大 (${content.length} 字符)，超过限制 (${this.maxContentLength})`,
          suggestion: '请精简内容或拆分为多个文件'
        });
      }

      // JSON格式预检
      if (filePath.endsWith('.json')) {
        JSON.parse(content);  // 会抛出SyntaxError
      }
    } catch (parseError) {
      const errorDetail = parseError.message.includes('Unexpected')
        ? `${parseError.message}\n位置: 第${this._findErrorLine(content, parseError.message)}行`
        : parseError.message;

      errors.push({
        code: 'PARSE_ERROR',
        severity: 'fatal',
        message: `文件格式错误: ${errorDetail}`,
        rawContent: content.substring(0, 500),
        hint: this._getParseErrorHint(parseError, content)
      });

      return this._buildResult(false, errors, null, startTime);
    }

    const data = typeof content === 'string' && filePath.endsWith('.json') 
      ? JSON.parse(content) 
      : content;

    // === L3: Schema 结构校验 ===
    const schemaErrors = await this._validateSchema(data, schemaType, filePath);
    errors.push(...schemaErrors);

    // === L4: 业务逻辑校验 ===
    const businessErrors = await this._validateBusinessLogic(data, schemaType);
    errors.push(...businessErrors);

    // === L5: 质量优化建议 ===
    const suggestions = await this._checkQuality(data, schemaType);
    errors.push(...suggestions);

    const fatalErrors = errors.filter(e => e.severity === 'fatal');
    const isValid = fatalErrors.length === 0;

    // 输出验证结果
    console.log(`\n📊 [FileValidator] 验证完成:`);
    console.log(`   ✅ 有效: ${isValid}`);
    console.log(`   ❌ Fatal: ${errors.filter(e => e.severity === 'fatal').length}`);
    console.log(`   ⚠️  Warning: ${errors.filter(e => e.severity === 'warning').length}`);
    console.log(`   ℹ️  Info: ${errors.filter(e => e.severity === 'info').length}`);

    if (errors.length > 0) {
      console.log(`\n   详细错误:`);
      errors.slice(0, 10).forEach((err, i) => {
        const icon = err.severity === 'fatal' ? '❌' : 
                     err.severity === 'warning' ? '⚠️' : 'ℹ️';
        console.log(`   ${i+1}. ${icon} [${err.code}] ${err.message}`);
      });
      if (errors.length > 10) {
        console.log(`   ... 还有 ${errors.length - 10} 个错误`);
      }
    }

    return this._buildResult(isValid, errors, data, startTime);
  }

  /**
   * 快速验证 (仅L1+L2，用于性能敏感场景)
   */
  async quickValidate(filePath) {
    if (!fs.existsSync(filePath)) {
      return { valid: false, error: 'FILE_NOT_FOUND' };
    }

    try {
      const content = fs.readFileSync(filePath, 'utf-8');
      if (filePath.endsWith('.json')) {
        JSON.parse(content);
      }
      return { valid: true };
    } catch (e) {
      return { valid: false, error: e.message };
    }
  }

  // ==================== 私有方法 ====================

  _buildResult(isValid, errors, data, startTime) {
    return {
      valid: isValid,
      errors,
      data,
      duration: Date.now() - startTime,
      timestamp: new Date().toISOString(),
      summary: {
        totalErrors: errors.length,
        fatalCount: errors.filter(e => e.severity === 'fatal').length,
        warningCount: errors.filter(e => e.severity === 'warning').length,
        infoCount: errors.filter(e => e.severity === 'info').length
      }
    };
  }

  async _validateSchema(data, schemaType, filePath) {
    const errors = [];

    switch (schemaType) {
      case 'goal':
        errors.push(...this._validateGoalSchema(data));
        break;

      case 'dailyPlan':
        errors.push(...this._validateDailyPlanSchema(data));
        break;

      default:
        errors.push({
          code: 'UNKNOWN_SCHEMA_TYPE',
          severity: 'warning',
          message: `未知的 Schema 类型: ${schemaType}`,
          suggestion: '支持的类型: goal, dailyPlan'
        });
    }

    return errors;
  }

  _validateGoalSchema(data) {
    const errors = [];

    // 必填字段
    if (!data.id) {
      errors.push({
        code: 'MISSING_ID',
        severity: 'fatal',
        message: '缺少 id 字段 (目标唯一标识)',
        example: '"id": "goal-21day-wakeup-1717000000000"'
      });
    }

    if (!data.type) {
      errors.push({
        code: 'MISSING_TYPE',
        severity: 'fatal',
        message: '缺少 type 字段 (目标类型)',
        example: '"type": "habit" | "task" | "health" | "custom"'
      });
    } else if (!['habit', 'task', 'health', 'custom'].includes(data.type)) {
      errors.push({
        code: 'INVALID_TYPE',
        severity: 'fatal',
        message: `type 值无效: "${data.type}"`,
        example: '必须是 habit | task | health | custom 之一'
      });
    }

    if (!data.title || typeof data.title !== 'string' || data.title.trim().length < 2) {
      errors.push({
        code: 'INVALID_TITLE',
        severity: 'fatal',
        message: 'title 字段无效 (需要至少2个字符的字符串)',
        example: '"title": "21天早起挑战"'
      });
    }

    // config 对象检查
    if (!data.config || typeof data.config !== 'object') {
      errors.push({
        code: 'MISSING_CONFIG',
        severity: 'fatal',
        message: '缺少 config 对象 (目标配置)',
        example: '{ "config": { "duration": 21, ... } }'
      });
    } else {
      const { config } = data;

      if (!config.duration || typeof config.duration !== 'number' || config.duration < 1) {
        errors.push({
          code: 'INVALID_DURATION',
          severity: 'fatal',
          message: `config.duration 无效: ${config.duration} (必须 > 0 的数字)`,
          example: '"duration": 21'
        });
      } else if (config.duration > 365) {
        errors.push({
          code: 'DURATION_TOO_LONG',
          severity: 'warning',
          message: `持续时间过长: ${config.duration}天 (建议不超过365天)`,
          suggestion: '长期目标可能难以坚持，考虑分阶段设定'
        });
      }

      if (config.targetTime && !/^(0?[0-9]|1[0-9]|2[0-3]):[0-5][0-9]$/.test(config.targetTime)) {
        errors.push({
          code: 'INVALID_TARGET_TIME',
          severity: 'fatal',
          message: `config.targetTime 格式无效: "${config.targetTime}" (应为 HH:MM)`,
          example: '"targetTime": "07:00"'
        });
      }

      if (config.tone && !['gentle', 'energetic', 'funny', 'warm'].includes(config.tone)) {
        errors.push({
          code: 'INVALID_TONE',
          severity: 'warning',
          message: `config.tone 值不常见: "${config.tone}"`,
          suggestion: '推荐: gentle | energetic | funny | warm'
        });
      }
    }

    // status 检查
    if (data.status && !['planning', 'in_progress', 'near_complete', 'achieved', 'archived', 'paused'].includes(data.status)) {
      errors.push({
        code: 'INVALID_STATUS',
        severity: 'warning',
        message: `status 值异常: "${data.status}"`
      });
    }

    return errors;
  }

  _validateDailyPlanSchema(data) {
    const errors = [];

    // 顶层必填字段
    if (!data.goalId) {
      errors.push({
        code: 'MISSING_GOAL_ID',
        severity: 'fatal',
        message: '缺少 goalId 字段 (关联的目标ID)',
        example: '"goalId": "goal-xxx"'
      });
    }

    if (!data.date || !/^\d{4}-\d{2}-\d{2}$/.test(data.date)) {
      errors.push({
        code: 'INVALID_DATE',
        severity: 'fatal',
        message: `date 字段无效: "${data.date}" (应为 YYYY-MM-DD 格式)`,
        example: '"date": "2026-05-31"'
      });
    }

    if (typeof data.dayNumber !== 'number' || data.dayNumber < 1) {
      errors.push({
        code: 'INVALID_DAY_NUMBER',
        severity: 'fatal',
        message: `dayNumber 无效: ${data.dayNumber} (应为 >= 1 的整数)`
      });
    }

    // tasks 数组检查
    if (!Array.isArray(data.tasks)) {
      errors.push({
        code: 'TASKS_NOT_ARRAY',
        severity: 'fatal',
        message: 'tasks 字段必须是数组',
        example: '"tasks": [ { "time": "07:00", ... }, ... ]'
      });
    } else if (data.tasks.length === 0) {
      errors.push({
        code: 'EMPTY_TASKS',
        severity: 'fatal',
        message: 'tasks 数组为空 (至少需要1个任务)'
      });
    } else {
      // 验证每个任务
      data.tasks.forEach((task, index) => {
        errors.push(...this._validateTask(task, index));
      });
    }

    return errors;
  }

  _validateTask(task, index) {
    const errors = [];
    const prefix = `tasks[${index}]`;

    if (!task.time) {
      errors.push({
        code: `TASK_${index}_MISSING_TIME`,
        severity: 'fatal',
        message: `${prefix} 缺少 time 字段 (执行时间)`,
        example: `"time": "07:00"`
      });
    } else if (!/^(0?[0-9]|1[0-9]|2[0-3]):[0-5][0-9]$/.test(task.time)) {
      errors.push({
        code: `TASK_${index}_INVALID_TIME`,
        severity: 'fatal',
        message: `${prefix}.time 格式无效: "${task.time}" (应为 HH:MM)`
      });
    }

    if (!task.type) {
      errors.push({
        code: `TASK_${index}_MISSING_TYPE`,
        severity: 'warning',
        message: `${prefix} 缺少 type 字段`,
        example: `"type": "routine" | "activity" | "meal" | "reminder"`
      });
    } else if (!['routine', 'activity', 'meal', 'reminder', 'custom'].includes(task.type)) {
      errors.push({
        code: `TASK_${index}_INVALID_TYPE`,
        severity: 'warning',
        message: `${prefix}.type 值异常: "${task.type}"`
      });
    }

    if (!task.title) {
      errors.push({
        code: `TASK_${index}_MISSING_TITLE`,
        severity: 'warning',
        message: `${prefix} 缺少 title 字段`
      });
    }

    if (!task.content || typeof task.content !== 'string') {
      errors.push({
        code: `TASK_${index}_MISSING_CONTENT`,
        severity: 'fatal',
        message: `${prefix} 缺少 content 字段 (播报文本内容)`
      });
    } else {
      const len = task.content.length;
      if (len < 10) {
        errors.push({
          code: `TASK_${index}_CONTENT_TOO_SHORT`,
          severity: 'fatal',
          message: `${prefix}.content 太短 (${len}字)，小爱音箱播报建议 10-50 字`
        });
      } else if (len > 200) {
        errors.push({
          code: `TASK_${index}_CONTENT_TOO_LONG`,
          severity: 'warning',
          message: `${prefix}.content 过长 (${len}字)，可能导致播报时间过长`
        });
      }
    }

    return errors;
  }

  async _validateBusinessLogic(data, schemaType) {
    const warnings = [];

    if (schemaType === 'dailyPlan') {
      warnings.push(...this._checkDailyPlanLogic(data));
    } else if (schemaType === 'goal') {
      warnings.push(...this._checkGoalLogic(data));
    }

    return warnings;
  }

  _checkDailyPlanLogic(data) {
    const warnings = [];

    if (!data.tasks || data.tasks.length < 2) return warnings;

    // 时间顺序检查
    for (let i = 1; i < data.tasks.length; i++) {
      const prevTime = data.tasks[i - 1].time;
      const currTime = data.tasks[i].time;

      if (prevTime >= currTime) {
        warnings.push({
          code: 'TIME_ORDER_ERROR',
          severity: 'warning',
          message: `任务时间顺序错误: tasks[${i - 1}](${prevTime}) >= tasks[${i}](${currTime})`,
          suggestion: '请按时间从早到晚排序任务'
        });
      }
    }

    // 时间间隔检查（避免任务过于密集）
    for (let i = 1; i < data.tasks.length; i++) {
      const prevMinutes = this._timeToMinutes(data.tasks[i - 1].time);
      const currMinutes = this._timeToMinutes(data.tasks[i].time);
      const gap = currMinutes - prevMinutes;

      if (gap > 0 && gap < 15) {
        warnings.push({
          code: 'TASKS_TOO_CLOSE',
          severity: 'info',
          message: `tasks[${i - 1}] 和 tasks[${i}] 间隔仅 ${gap} 分钟，可能过于紧凑`
        });
      }
    }

    // 进度一致性检查
    if (data.context?.progress && data.dayNumber) {
      const expectedDay = data.context.progress.currentDay + 1;
      if (Math.abs(data.dayNumber - expectedDay) > 1) {
        warnings.push({
          code: 'PROGRESS_MISMATCH',
          severity: 'warning',
          message: `dayNumber(${data.dayNumber}) 与 progress.currentDay(${data.context.progress.currentDay}) 不一致`,
          suggestion: `dayNumber 应该是 ${expectedDay}`
        });
      }
    }

    // 天气适应性检查
    if (this._isBadWeather(data.context?.weather)) {
      const outdoorTasks = data.tasks?.filter(t =>
        this._isOutdoorActivity(t.content || '')
      );

      if (outdoorTasks?.length > 0) {
        warnings.push({
          code: 'WEATHER_CONFLICT',
          severity: 'warning',
          message: `天气恶劣但仍有 ${outdoorTasks.length} 个户外活动任务`,
          suggestion: '应将户外活动改为室内活动（阅读、手工、游戏等）'
        });
      }
    }

    return warnings;
  }

  _checkGoalLogic(data) {
    const warnings = [];

    if (data.config?.duration) {
      const { duration } = data.config;

      if (duration > 100) {
        warnings.push({
          code: 'VERY_LONG_DURATION',
          severity: 'warning',
          message: `目标持续 ${duration} 天，可能难以长期坚持`,
          suggestion: '考虑分解为多个短期目标'
        });
      }

      if (duration < 7) {
        warnings.push({
          code: 'VERY_SHORT_DURATION',
          severity: 'info',
          message: `目标仅 ${duration} 天，效果可能不明显`
        });
      }
    }

    return warnings;
  }

  async _checkQuality(data, schemaType) {
    const suggestions = [];

    if (schemaType === 'dailyPlan' && data.tasks) {
      data.tasks.forEach((task, index) => {
        if (task.content) {
          // 表情符号检查
          if (!/[^\u0000-\u007F]/.test(task.content)) {
            suggestions.push({
              code: `TASK_${index}_NO_EMOJI`,
              severity: 'info',
              message: `tasks[${index}] 缺少表情符号或特殊字符`,
              suggestion: '添加 emoji 可增加童趣感 (☀️ 🌙 ⭐ 🎉 📚)'
            });
          }

          // 敏感词检查（简单版）
          const sensitiveWords = ['死', '杀', '笨', '蠢'];
          for (const word of sensitiveWords) {
            if (task.content.includes(word)) {
              suggestions.push({
                code: `TASK_${index}_SENSITIVE_WORD`,
                severity: 'warning',
                message: `tasks[${index}] 包含敏感词: "${word}"`,
                suggestion: '请使用更温和的表达方式'
              });
            }
          }
        }
      });

      // 鼓励性话语检查
      const hasEncouragement = data.tasks.some(t =>
        t.content?.match(/加油|棒|继续|厉害|真棒|好样|坚持/)
      );

      if (data.context?.progress?.percentage > 50 && !hasEncouragement) {
        suggestions.push({
          code: 'MISSING_ENCOURAGEMENT',
          severity: 'info',
          message: '进度超过50%的任务建议包含鼓励性话语',
          suggestion: '可添加: "你们太棒了！" "继续加油！""坚持就是胜利！"'
        });
      }
    }

    return suggestions;
  }

  // ==================== 工具方法 ====================

  _findErrorLine(content, errorMessage) {
    const match = errorMessage.match(/position\s+(\d+)/);
    if (match) {
      const pos = parseInt(match[1]);
      return content.substring(0, pos).split('\n').length;
    }
    return '?';
  }

  _getParseErrorHint(error, content) {
    const msg = error.message;

    if (msg.includes('Unexpected token')) {
      return '常见原因: 缺少逗号、多余的逗号、未闭合的括号/引号';
    }

    if (msg.includes('Unexpected end')) {
      return 'JSON 未正确结束，可能缺少闭合的 } 或 ]';
    }

    if (msg.includes('Unexpected number')) {
      return '数值格式错误，检查是否有前导零或非法字符';
    }

    return '请仔细检查 JSON 语法';
  }

  _timeToMinutes(timeStr) {
    if (!timeStr || typeof timeStr !== 'string') return 0;
    const [hours, minutes] = timeStr.split(':').map(Number);
    return (hours || 0) * 60 + (minutes || 0);
  }

  _isBadWeather(weather) {
    if (!weather) return false;
    const badKeywords = ['雨', '雪', '雷', '暴', '雾霾', '沙尘'];
    const weatherStr = weather.weather + (weather.tips || '');
    return badKeywords.some(kw => weatherStr.includes(kw));
  }

  _isOutdoorActivity(content) {
    if (!content) return false;
    const outdoorKeywords = [
      '公园', '户外', '室外', '骑车', '踢球', '散步', '爬山',
      '游泳', '跑步', '打球', '露营', '野餐', '放风筝'
    ];
    return outdoorKeywords.some(kw => content.includes(kw));
  }
}
