/**
 * 迭代文件生成器 (IterativeFileGenerator) v2.0
 * 
 * 职责: 实现 "生成-验证-反馈-重试" 闭环
 * 
 * 核心流程:
 * 1. 构建 Prompt (包含历史错误信息)
 * 2. 调用 OpenCode 生成文件
 * 3. FileValidator 多级验证
 * 4. ResponseParser 解析混合响应
 * 5. 有错? → 反馈给 OpenCode → 重试 (最多 N 次)
 * 6. 成功! 或 达到最大次数 → 触发降级方案
 */

import fs from 'fs-extra';
import path from 'path';
import { FileValidator } from './file-validator.mjs';
import { ResponseParser } from './response-parser.mjs';

export class IterativeFileGenerator {
  constructor(sessionManager, options = {}) {
    this.sessionManager = sessionManager;
    
    // 配置项
    this.maxRetries = options.maxRetries || 3;        // 最大重试次数
    this.retryDelay = options.retryDelay || 2000;       // 重试间隔(ms)
    this.fileWaitTimeout = options.fileWaitTimeout || 3000; // 等待文件生成的超时
    this.strictMode = options.strictMode ?? true;       // 严格模式：是否要求精确匹配文件类型
    
    // 初始化组件
    this.validator = new FileValidator(options.validatorOptions || {});
    this.parser = new ResponseParser(options.parserOptions || {});
    
    // 对话历史（用于上下文连续性）
    this.conversationHistory = [];
  }

  /**
   * 生成文件并自动迭代修正直到成功 (主方法)
   */
  async generateWithValidation(promptOptions, expectedFileType = 'goal') {
    let lastError = null;
    let attempt = 0;

    console.log(`\n${'='.repeat(60)}`);
    console.log(`🔄 [IterativeGenerator] 开始生成: type=${expectedFileType}`);
    console.log(`${'='.repeat(60)}\n`);

    while (attempt < this.maxRetries) {
      attempt++;
      console.log(`\n--- 第 ${attempt}/${this.maxRetries} 次尝试 ---\n`);

      try {
        // Step 1: 创建快照（用于检测新文件）
        const workingDir = this._getWorkingDirectory(expectedFileType);
        const beforeSnapshot = await this.parser.createSnapshot(workingDir);

        // Step 2: 构建增强Prompt（包含历史错误信息）
        const enhancedPrompt = this._buildEnhancedPrompt(promptOptions, lastError);

        // Step 3: 调用 OpenCode
        console.log(`📤 [IterativeGenerator] 发送请求到 OpenCode...`);
        const opencodeResponse = await this.sessionManager.chat(
          { text: enhancedPrompt },
          {
            model: promptOptions.model || 'gpt-4o-mini',
            temperature: this._getTemperature(attempt),
            directory: workingDir,
            systemPrompt: promptOptions.systemPrompt,
            maxTokens: promptOptions.maxTokens || 2000
          }
        );

        // Step 4: 解析混合响应
        console.log(`🔍 [IterativeGenerator] 解析 OpenCode 响应...`);
        console.log(`📝 [IterativeGenerator] AI 原始响应 (${typeof opencodeResponse === 'string' ? opencodeResponse.length : 'object'} 字符): ${typeof opencodeResponse === 'string' ? opencodeResponse.substring(0, 200) : JSON.stringify(opencodeResponse).substring(0, 200)}`);
        const parsedResponse = await this.parser.parse(opencodeResponse, {
          directory: workingDir,
          beforeSnapshot,
          expectedFileType
        });

        console.log(parsedResponse.toLogString());

        // Step 5: 验证生成的文件
        if (parsedResponse.files?.length > 0) {
          const targetFile = this._getTargetFile(parsedResponse, expectedFileType);
          
          if (targetFile) {
            console.log(`\n📋 [IterativeGenerator] 验证目标文件: ${targetFile.filename}\n`);
            
            const validation = await this.validator.validate(targetFile.path, expectedFileType);
            
            if (validation.valid) {
              // ✅ 成功！
              console.log(`\n${'='.repeat(60)}`);
              console.log(`🎉 [IterativeGenerator] 文件生成成功!`);
              console.log(`   尝试次数: ${attempt}`);
              console.log(`   文件路径: ${targetFile.path}`);
              console.log(`   文件大小: ${targetFile.size} bytes`);
              
              if (validation.summary.warningCount > 0) {
                console.log(`   ⚠️  警告数: ${validation.summary.warningCount}`);
              }
              console.log(`${'='.repeat(60)}\n`);

              return {
                success: true,
                data: validation.data,
                filePath: targetFile.path,
                replyToUser: parsedResponse.text || '任务已完成！',
                files: parsedResponse.files,
                attempts: attempt,
                validationWarnings: validation.errors.filter(e => e.severity !== 'fatal'),
                usedFallback: false,
                responseType: parsedResponse.responseType
              };
            } else {
              // ❌ 有致命错误，准备重试
              console.log(`\n⚠️ [IterativeGenerator] 验证失败，准备重试...`);
              console.log(`   Fatal errors: ${validation.summary.fatalCount}`);
              
              lastError = validation;
              
              // 记录到对话历史
              this.conversationHistory.push({
                role: 'validator',
                content: this._formatValidationFeedback(validation),
                timestamp: new Date().toISOString(),
                attempt
              });
            }
          } else {
            console.warn(`⚠️ [IterativeGenerator] 未找到匹配 ${expectedFileType} 类型的文件`);
            
            // 如果没有致命错误，可以接受其他文件
            const hasValidFiles = parsedResponse.files.some(f => f.valid);
            if (hasValidFiles && !this.strictMode) {
              return {
                success: true,
                data: parsedResponse.files.find(f => f.valid)?.parsedContent || null,
                filePath: parsedResponse.files.find(f => f.valid)?.path,
                replyToUser: parsedResponse.text || '文件已生成',
                files: parsedResponse.files,
                attempts: attempt,
                usedFallback: false,
                note: '未找到精确类型的目标文件，使用了第一个有效文件'
              };
            }

            lastError = {
              errors: [{
                code: 'NO_TARGET_FILE',
                severity: 'warning',
                message: `未找到 ${expectedFileType} 类型的文件`
              }]
            };
          }
        } else {
          // 没有检测到任何文件 - 尝试从文本中提取 JSON
          console.log(`⚠️ [IterativeGenerator] 未检测到文件生成，尝试从文本提取 JSON...`);

          if (parsedResponse.responseType === 'conversation' || parsedResponse.responseType === 'mixed') {
            // 尝试从文本中提取 JSON 并保存
            const extractResult = await this._extractAndSaveJsonFromText(
              parsedResponse.text || opencodeResponse,
              expectedFileType,
              promptOptions
            );

            if (extractResult && extractResult.success) {
              // ✅ 成功提取并保存了 JSON
              console.log(`\n${'='.repeat(60)}`);
              console.log(`🎉 [IterativeGenerator] 从文本中成功提取 JSON!`);
              console.log(`   尝试次数: ${attempt}`);
              console.log(`   文件路径: ${extractResult.filePath}`);
              console.log(`${'='.repeat(60)}\n`);

              return {
                success: true,
                data: extractResult.data,
                filePath: extractResult.filePath,
                replyToUser: parsedResponse.text || '任务已完成！',
                files: [{
                  path: extractResult.filePath,
                  filename: extractResult.filename,
                  valid: true,
                  size: extractResult.size,
                  generatedBy: 'text-extraction'
                }],
                attempts: attempt,
                usedFallback: false,
                responseType: 'mixed',  // 实际上是混合模式（文本+JSON）
                note: '从 OpenCode 文本响应中提取 JSON 代码块并保存'
              };
            }
          }

          // 提取失败，记录错误
          console.warn(`⚠️ [IterativeGenerator] 未检测到任何生成的文件，JSON提取也失败`);
          
          lastError = {
            errors: [{
              code: 'NO_FILES_GENERATED',
              severity: 'fatal',
              message: 'OpenCode 未生成文件且无法从文本中提取 JSON',
              hint: '请检查 Prompt 是否明确要求输出 JSON 代码块'
            }]
          };
        }

      } catch (error) {
        console.error(`❌ [IterativeGenerator] 第${attempt}次尝试失败:`, error.message);
        
        lastError = {
          errors: [{
            code: 'GENERATION_FAILED',
            severity: 'fatal',
            message: error.message,
            stack: error.stack
          }]
        };
      }

      // 重试前等待
      if (attempt < this.maxRetries) {
        console.log(`\n⏳ [IterativeGenerator] 等待 ${this.retryDelay/1000}s 后重试...\n`);
        await this._sleep(this.retryDelay);
      }
    }

    // 达到最大重试次数，触发降级方案
    console.warn(`\n❌ [IterativeGenerator] 达到最大重试次数(${this.maxRetries})，触发降级方案\n`);
    
    return await this._triggerFallback(promptOptions, expectedFileType, lastError);
  }

  /**
   * 快速生成模式 (不进行迭代验证)
   */
  async generateQuick(promptOptions, expectedFileType = 'goal') {
    try {
      const workingDir = this._getWorkingDirectory(expectedFileType);
      
      const response = await this.sessionManager.chat(
        { text: promptOptions.text },
        {
          model: promptOptions.model || 'gpt-4o-mini',
          temperature: 0.7,
          directory: workingDir,
          systemPrompt: promptOptions.systemPrompt
        }
      );

      const parsed = await this.parser.parse(response, {
        directory: workingDir,
        expectedFileType
      });

      if (parsed.files?.length > 0) {
        const targetFile = this._getTargetFile(parsed, expectedFileType) || parsed.firstFile;
        
        if (targetFile?.valid) {
          return {
            success: true,
            data: targetFile.parsedContent,
            filePath: targetFile.path,
            replyToUser: parsed.text,
            files: parsed.files,
            attempts: 1
          };
        }
      }

      return {
        success: parsed.isSuccess(),
        replyToUser: parsed.text,
        files: parsed.files,
        attempts: 1
      };

    } catch (error) {
      return {
        success: false,
        error: error.message,
        attempts: 1
      };
    }
  }

  // ==================== 私有方法 ====================

  _buildEnhancedPrompt(originalPrompt, lastError) {
    // 如果是第一次尝试或没有历史错误，使用原始prompt
    if (!lastError?.errors?.length) {
      return originalPrompt.text || originalPrompt;
    }

    // 构建包含错误反馈的增强prompt
    const errorFeedback = this._formatValidationFeedback(lastError);

    const baseText = typeof originalPrompt === 'string' 
      ? originalPrompt 
      : (originalPrompt.text || '');

    return `${baseText}

---

## ⚠️ 上一次生成结果验证失败 (第${lastError.attempt || '?'}次尝试)

### 错误列表 (${lastError.errors.length}个):
${errorFeedback}

### 请根据以上错误信息重新生成文件:

**修复要求:**
1. 📝 仔细检查每个字段的格式和类型
2. ✅ 确保所有必填字段都已填写
3. 🔢 数值字段必须是有效的数字
4. ⏰ 时间格式必须为 HH:MM (24小时制)
5. 📏 字符串长度要符合要求 (通常10-50字)
6. 🔤 JSON语法正确 (逗号、括号、引号配对)

**常见问题排查:**
${this._getCommonErrorsGuidance(lastError.errors)}

**操作:** 请直接覆盖原文件重新生成，不要创建新的文件名。
`;
  }

  _formatValidationFeedback(validationResult) {
    if (!validationResult?.errors) return '';

    const lines = validationResult.errors.map((err, idx) => {
      const icon = err.severity === 'fatal' ? '❌' : 
                   err.severity === 'warning' ? '⚠️' : 'ℹ️';
      
      let line = `${idx + 1}. ${icon} [${err.code}] ${err.message}`;
      
      if (err.suggestion) {
        line += `\n   💡 建议: ${err.suggestion}`;
      }
      
      if (err.rawContent) {
        line += `\n   📄 问题内容预览: ${err.rawContent.substring(0, 100)}...`;
      }

      return line;
    });

    return lines.join('\n');
  }

  _getCommonErrorsGuidance(errors) {
    const guidance = [];

    const hasParseError = errors.some(e => e.code === 'PARSE_ERROR');
    const hasMissingField = errors.some(e => e.code?.startsWith('MISSING'));
    const hasInvalidFormat = errors.some(e => e.code?.includes('INVALID'));

    if (hasParseError) {
      guidance.push('- **JSON语法错误**: 使用 JSON linter 检查括号、逗号、引号是否配对');
    }

    if (hasMissingField) {
      guidance.push('- **缺少必填字段**: 参照 Schema 确保所有 required 字段都存在');
    }

    if (hasInvalidFormat) {
      guidance.push('- **格式无效**: 检查时间是否为 HH:MM，数值是否为正整数等');
    }

    return guidance.length > 0 ? guidance.join('\n') : '- 请仔细检查所有字段是否符合 Schema 要求';
  }

  _getTemperature(attempt) {
    // 随着重试次数降低temperature，使输出更确定、更遵循规则
    // 第1次: 0.7 (有一定创意)
    // 第2次: 0.5 (更保守)
    // 第3次: 0.3 (严格遵循规则和Schema)
    return Math.max(0.3, 0.7 - (attempt - 1) * 0.2);
  }

  _getWorkingDirectory(fileType) {
    switch (fileType) {
      case 'goal':
        return path.join(process.cwd(), 'data', 'goals');
      case 'dailyPlan':
        return path.join(process.cwd(), 'data', 'daily-plans');
      default:
        return path.join(process.cwd(), 'data');
    }
  }

  _getTargetFile(parsedResponse, fileType) {
    switch (fileType) {
      case 'goal':
        return parsedResponse.goalFile;
      case 'dailyPlan':
        return parsedResponse.dailyPlanFile;
      default:
        return parsedResponse.firstFile;
    }
  }

  /**
   * 从文本响应中提取 JSON 并保存到文件
   * 当 OpenCode 返回纯对话但包含 JSON 代码块时使用
   */
  async _extractAndSaveJsonFromText(text, fileType, promptOptions) {
    console.log(`🔍 [IterativeGenerator] 尝试从文本中提取 JSON...`);

    try {
      // 提取 JSON 代码块 (支持 ```json ... ``` 或 ``` ... ```)
      const jsonPatterns = [
        /```json\s*([\s\S]*?)```/gi,
        /```\s*([\s\S]*?)```/gi,
        /(\{[\s\S]*"tasks"[\s\S]*\})/gi,  // 包含 tasks 的 JSON 对象
        /(\{[\s\S]*"goalId"[\s\S]*\})/gi     // 包含 goalId 的 JSON 对象
      ];

      let extractedJson = null;
      let matchedPattern = null;

      for (const pattern of jsonPatterns) {
        const matches = [...text.matchAll(pattern)];
        if (matches.length > 0) {
          // 使用最长的匹配（通常是最完整的JSON）
          const bestMatch = matches.reduce((longest, current) =>
            current[1].length > longest[1].length ? current : longest
          );

          extractedJson = bestMatch[1].trim();
          matchedPattern = pattern.toString();
          console.log(`   ✅ 找到 JSON 代码块 (${extractedJson.length} 字符)`);
          break;
        }
      }

      if (!extractedJson) {
        console.log(`   ❌ 未找到 JSON 代码块`);
        return null;
      }

      // 解析 JSON
      let jsonData;
      try {
        jsonData = JSON.parse(extractedJson);
        console.log(`   ✅ JSON 解析成功`);
      } catch (parseError) {
        console.error(`   ❌ JSON 解析失败:`, parseError.message);
        
        // 尝试修复常见的 JSON 错误
        jsonData = this._tryFixJson(extractedJson);
        if (!jsonData) {
          return null;
        }
      }

      // 验证基本结构
      if (!this._validateExtractedJson(jsonData, fileType)) {
        console.log(`   ❌ JSON 结构验证失败`);
        return null;
      }

      // 确定文件路径
      const workingDir = this._getWorkingDirectory(fileType);
      await fs.ensureDir(workingDir);

      let filename;
      if (fileType === 'dailyPlan' && jsonData.goalId && jsonData.date) {
        filename = `${jsonData.goalId}-${jsonData.date}.json`;
      } else if (fileType === 'goal' && jsonData.id) {
        filename = `${jsonData.id}.json`;
      } else {
        filename = `extracted-${Date.now()}.json`;
      }

      const filePath = path.join(workingDir, filename);

      // 补充元数据
      if (!jsonData.metadata) {
        jsonData.metadata = {};
      }
      jsonData.metadata.generatedAt = new Date().toISOString();
      jsonData.metadata.generatedBy = 'opencode-extracted';
      jsonData.metadata.extractedFrom = 'text-response';

      // 写入文件
      await fs.writeJson(filePath, jsonData, { spaces: 2 });
      
      const fileSize = (JSON.stringify(jsonData).length / 1024).toFixed(1);
      console.log(`✅ [IterativeGenerator] JSON 已提取并保存:`);
      console.log(`   文件: ${filePath}`);
      console.log(`   大小: ${fileSize}KB`);
      console.log(`   任务数: ${jsonData.tasks?.length || '-'}`);

      return {
        success: true,
        data: jsonData,
        filePath,
        filename,
        size: JSON.stringify(jsonData).length,
        extractedFrom: 'text-json'
      };

    } catch (error) {
      console.error(`❌ [IterativeGenerator] JSON 提取失败:`, error.message);
      return null;
    }
  }

  /**
   * 验证提取的 JSON 基本结构
   */
  _validateExtractedJson(jsonData, fileType) {
    if (typeof jsonData !== 'object' || Array.isArray(jsonData)) {
      return false;
    }

    if (fileType === 'dailyPlan') {
      return jsonData.tasks && Array.isArray(jsonData.tasks) && jsonData.tasks.length > 0;
    }

    if (fileType === 'goal') {
      return jsonData.id && jsonData.title;
    }

    return true;  // 其他类型宽松验证
  }

  /**
   * 尝试修复常见的 JSON 错误
   */
  _tryFixJson(jsonStr) {
    console.log(`🔧 [IterativeGenerator] 尝试修复 JSON...`);

    // 常见修复：移除尾部逗号、修复引号等
    let fixed = jsonStr
      .replace(/,\s*([}\]])/g, '$1')  // 移除尾部逗号
      .replace(/\n/g, '')               // 移除换行符以便调试
      .trim();

    try {
      const parsed = JSON.parse(fixed);
      console.log(`   ✅ JSON 修复成功`);
      return parsed;
    } catch (e) {
      console.log(`   ❌ 修复失败`);
      return null;
    }
  }

  async _triggerFallback(originalPrompt, fileType, lastError) {
    console.warn(`⚠️ [IterativeGenerator] 启用降级方案...`);

    try {
      // 降级方案: 使用模板生成简单版本
      const fallbackData = this._generateTemplateFallback(fileType, originalPrompt);

      if (!fallbackData) {
        throw new Error('无法生成降级数据');
      }

      // 写入文件
      const workingDir = this._getWorkingDirectory(fileType);
      await fs.ensureDir(workingDir);

      const filename = this._generateFallbackFilename(fileType);
      const filePath = path.join(workingDir, filename);

      await fs.writeJson(filePath, fallbackData, { spaces: 2 });

      console.log(`✅ [IterativeGenerator] 降级文件已生成: ${filePath}`);

      return {
        success: true,
        data: fallbackData,
        filePath,
        replyToUser: this._getFallbackReply(fileType),
        files: [{
          path: filePath,
          filename,
          valid: true,
          size: JSON.stringify(fallbackData).length,
          generatedBy: 'fallback-template'
        }],
        attempts: this.maxRetries + 1,
        usedFallback: true,
        fallbackReason: lastError?.errors?.map(e => e.message).join('; ') || '未知错误',
        warning: '此结果由模板生成，建议后续手动优化或重新生成'
      };

    } catch (fallbackError) {
      console.error(`❌ [IterativeGenerator] 降级方案也失败了:`, fallbackError.message);

      return {
        success: false,
        error: `生成失败且降级不可用: ${fallbackError.message}`,
        attempts: this.maxRetries + 1,
        usedFallback: true,
        originalErrors: lastError?.errors
      };
    }
  }

  _generateTemplateFallback(fileType, context) {
    const now = Date.now();
    const text = context?.text || context?.userRequest || '';
    const today = new Date().toISOString().split('T')[0];

    switch (fileType) {
      case 'goal':
        return {
          id: `goal-fallback-${now}`,
          type: 'custom',
          title: text.substring(0, 50) || '待完善的目标',
          description: text.substring(0, 200) || '目标描述',
          userRequest: text,
          config: {
            duration: 21,
            frequency: 'daily',
            targetTime: '09:00',
            tone: 'gentle',
            audience: '宝贝们'
          },
          status: 'planning',
          createdAt: new Date().toISOString(),
          progress: {
            currentDay: 0,
            totalDays: 21,
            percentage: 0,
            streak: 0
          },
          metadata: {
            generatedBy: 'fallback-template',
            note: '这是降级生成的默认目标，请手动编辑完善'
          }
        };

      case 'dailyPlan': {
        // 丰富的降级模板：6个任务，三阶段差异化，每天不同
        const dayNum = (context?.dayOffset || 1);
        const totalDays = context?.totalDays || 30;
        const pct = Math.round((dayNum / totalDays) * 100);
        const targetDate = context?.targetDate || today;
        const planDate = new Date(targetDate);
        const isWeekend = [0, 6].includes(planDate.getDay());
        const weekdayName = ['星期日','星期一','星期二','星期三','星期四','星期五','星期六'][planDate.getDay()];

        // 三阶段话术库（起步/坚持/冲刺）
        const phases = {
          start: {   // 第1-3天
            m: ['新挑战开始啦！🎉 今天开始我们的30天阅读+刷牙大冒险，宝贝准备好了吗？',
                '早安小探险家！🌟 第{d}天的习惯养成之旅正式启程，让我们一起加油！',
                '美好的一天从好习惯开始！☀️ 今天是第{d}天，你一定可以做到的！'],
            a: ['挑选今晚绘本📚 小探险家，快去挑一本最喜欢的绘本吧！今晚我们一起读～你选哪本呢？✨',
                '绘本时间到！📖 去书架选一本最爱的故事书，今天想听什么故事呢？期待哦！🌟',
                '选书大作战！🔍 宝贝今天想读什么类型的书？冒险？童话？还是科普？快去挑一本吧！'],
            r: ['阅读时间到！🎉 和爸爸妈妈一起读15分钟，看看故事里有什么有趣的事吧～记住，每天坚持就会越来越棒哦！📖⭐',
                '叮咚～阅读时间开始啦！📚 今天的故事一定会很精彩，坐好听故事吧！每读完一页都是进步哦！💪',
                '亲子共读时光！👨‍👩‍👧 和爸爸妈妈一起翻开书本，让想象力飞起来吧！今天的你会收获满满的快乐和知识！✨'],
            s: ['阅读完成，你太棒啦！⭐ 跟爸爸妈妈说说今天读了什么故事？有没有认识新的词语？每一天的坚持都让你变得更厉害哦！🎉',
                '哇塞，今天又读完了一本书！🏆 跟大家分享一下你觉得最好玩的情节吧！你的表达能力越来越强了！👏',
                '分享时刻！💬 把今天读到的好玩故事讲给家人听吧！你已经是个小小故事家了！🌈'],
            b: ['刷牙时间到咯～🦷 拿起小牙刷，上上下下左左右右，把蛀牙小怪兽全部赶跑！刷完记得让爸爸妈妈检查，白白的牙齿真好看！😁✨',
                '牙齿保卫战开始！🪥 认真刷满2分钟，每个角落都不要放过哦！坚持刷牙的你是最帅/最美的！😊',
                '小牙医上岗啦！🩺 拿起牙刷给每一颗牙齿做个SPA吧！刷得干干净净，笑容才会更灿烂哦！🌟'],
            n: ['第{d}天挑战圆满成功！🎉 今天你读了故事又刷了牙，已经迈出了成为习惯小超人的第一步！明天继续加油，晚安宝贝，做个甜甜的梦～🌙😴',
                '太棒了第{d}天！🌟 你完成了所有任务，离目标又近了一步！好好休息，明天继续加油哦！晚安～💤',
                '今日打卡完成✅ 第{d}天的努力值得点赞！贴上一颗小星星⭐，明天继续加油哦！晚安宝贝，做个美梦～🚀']
          },
          persist: { // 第4-10天
            m: ['坚持就是胜利！💪 第{d}天了，你已经比昨天更棒了！继续保持这个好势头！',
                '连续{d}天打卡！🔥 你的毅力让人佩服！今天也要元气满满地完成任务哦！',
                '第{d}天挑战继续！⚡ 你已经养成习惯了，今天轻松搞定它！'],
            a: ['今天换个口味？🍽️ 尝试读一本没看过的书吧！新故事带来新惊喜！🎁',
                '绘本探索家！🗺️ 今天试试读一本新主题的书？科学？自然？冒险等你来发现！',
                '换本书看看？📕 昨天读的那本好看吗？今天来点新鲜的，去书架上找找新朋友吧！'],
            r: ['第{d}天阅读打卡！📖 你已经坚持这么久了，真了不起！今天我们读一个更有趣的故事吧～',
                '阅读习惯正在形成中！🌱 第{d}天了，你的专注力越来越强了！享受这15分钟的亲子时光吧！',
                '坚持阅读的第{d}天！📚 每一次翻页都在为未来积累力量，你做得很棒！'],
            s: ['{d}天连续阅读！🏅 这个成就值得骄傲！今天学到了什么新知识？快分享一下吧！',
                '分享你的阅读心得！💭 第{d}天了，你对故事的理解越来越深了呢？说说看今天的故事讲了什么？',
                '阅读达人就是你！🎯 连续{d}天读书，你的词汇量一定增长了不少！用新学的词语造个句吧！'],
            b: ['第{d}天刷牙打卡！🦷 牙齿每天都在变白变健康哦！继续保持这个好习惯！✨',
                '牙齿越来越亮了！😁 坚持刷牙{d}天，蛀牙早就吓跑了！今天也认真刷一遍吧！',
                '刷牙小能手！🏆 已经连续{d}天认真刷牙了！这个好习惯会陪伴你一辈子哦！'],
            n: ['第{d}天圆满完成！🎯 你已经坚持一周多了，这种毅力太难得了！明天继续，你是最棒的！🌙',
                '连续{d}天打卡成功！🔥 离30天目标越来越近了！好好休息，明天又是充满活力的一天！💪',
                '今日任务全部搞定✅ {p}%的进度了！你真的很厉害！早点休息，养足精神迎接明天！⭐']
          },
         冲刺: {    // 第11天+
            m: ['冲刺阶段！🚀 第{d}天了，你已经是大孩子了！今天的任务对你来说已经是小菜一碟！',
                '接近终点线！🏁 第{d}天/共{T}天，你已经走了{p}%的路程！最后冲刺加油！',
                '习惯已成自然！🌟 第{d}天，阅读和刷牙已经是你生活的一部分了！今天也轻松完成吧！'],
            a: ['挑战高难度绘本！📚 试着读一本字多一点的书吧？我相信你可以的！💯',
                '阅读升级！⬆️ 第{d}天了，试试自己读一部分？然后让爸妈帮忙读剩下的？',
                '成为阅读小专家！🎓 选一本有深度的书，今天我们来讨论一下书中的道理吧！'],
            r: ['第{d}天！你已经是阅读高手了！📖 今天的15分钟对你来说一定是享受时光！',
                '阅读已经成为你的超能力了！⚡ 第{d}天，享受这段安静而美好的亲子时光吧～',
                '倒计时模式开启！⏳ 再坚持几天就达成目标了！今天的阅读格外有意义哦！'],
            s: ['阅读大师分享时间！🎤 第{d}天了，试着总结一下今天故事的主题思想吧！',
                '深度思考时间！🧠 读完了？来分析一下人物性格？你的理解力真的在飞速提升！',
                '{d}天的积累不是白费的！📝 试着写一句话读后感？或者画一幅画表达感受？'],
            b: ['牙齿健康守护者！🛡️ 第{d}天，你的牙齿感谢你的坚持！继续守护它们吧！',
                '刷牙大师！🥇 {d}天的坚持让你的笑容更加自信！今天也给牙齿做个完美护理！',
                '最后的冲刺！🏃‍♂️ 刷牙这件事对你来说已经是本能反应了！做得好，继续保持！'],
            n: ['第{d}天！只差一点点了！🎉 你已经完成了{p}%的目标！太不可思议了！',
                '即将达成30天成就！🏆 再坚持几天你就是真正的习惯超人！今晚好好休息！🌟',
                '里程碑式的一天！📍 第{d}天打卡完成！你已经证明了你可以做到任何事！为你骄傲！🌙']
          }
        };

        let phase = dayNum <= 3 ? phases.start : (dayNum <= 10 ? phases.persist : phases.冲刺);
        const pick = (arr) => arr[(dayNum - 1) % arr.length];
        const fmt = (s) => s.replace(/{d}/g, dayNum).replace(/{T}/g, totalDays).replace(/{p}/g, pct);

        // 时间根据周末微调
        const bt = parseInt((context?.targetTime || '08:00').split(':')[0]);
        return {
          goalId: context?.goalId || `goal-fallback-${now}`,
          date: targetDate,
          dayNumber: dayNum,
          context: {
            weather: { weather: '晴', temp: '25°C', city: '本地' },
            holiday: { weekday: weekdayName, isWeekend, events: [] },
            progress: { currentDay: dayNum - 1, totalDays, percentage: pct }
          },
          tasks: [
            { time: `${String(bt).padStart(2,'0')}:00`, type: 'reminder', title: '起床提醒',
              content: fmt(pick(phase.m)), scheduleId: `sched-fb-${now}-1` },
            { time: `${String(bt+8).padStart(2,'0')}:${isWeekend?'00':'30'}`, type: 'activity', title: '挑选绘本',
              content: fmt(pick(phase.a)), scheduleId: `sched-fb-${now}-2` },
            { time: `${String(bt+11).padStart(2,'0')}:00`, type: 'routine', title: '亲子阅读时间',
              content: fmt(pick(phase.r)), scheduleId: `sched-fb-${now}-3` },
            { time: `${String(bt+11).padStart(2,'0')}:${isWeekend?'25':'35'}`, type: 'routine', title: '阅读分享',
              content: fmt(pick(phase.s)), scheduleId: `sched-fb-${now}-4` },
            { time: `${String(bt+12).padStart(2,'0')}:${isWeekend?'10':'15'}`, type: 'routine', title: '刷牙小卫士',
              content: fmt(pick(phase.b)), scheduleId: `sched-fb-${now}-5` },
            { time: `${String(bt+12).padStart(2,'0')}:${isWeekend?'35':'40'}`, type: 'reminder', title: '睡前晚安 & 打卡完成',
              content: fmt(pick(phase.n)), scheduleId: `sched-fb-${now}-6` }
          ],
          adjustmentSummary: { totalAdjustments: 0, reasons: [] },
          metadata: {
            generatedBy: 'fallback-rich-template',
            note: `AI不可达，使用丰富降级模板 (Day ${dayNum}/${totalDays}, ${pct}%)`
          }
        };
      }

      default:
        return null;
    }
  }

  _generateFallbackFilename(fileType) {
    const timestamp = new Date().toISOString()
      .replace(/[-:T]/g, '')
      .replace(/\..+$/, '');

    switch (fileType) {
      case 'goal':
        return `goal-fallback-${timestamp}.json`;
      case 'dailyPlan':
        return `plan-fallback-${timestamp}.json`;
      default:
        return `fallback-${timestamp}.json`;
    }
  }

  _getFallbackReply(fileType) {
    const replies = {
      goal: '目标已创建（使用基础模板），您可以稍后编辑完善详细信息。',
      dailyPlan: '今日计划已生成（使用基础模板），可能不够个性化。',
      default: '内容已生成（使用备用方案）。'
    };

    return replies[fileType] || replies.default;
  }

  async _sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  /**
   * 清除对话历史
   */
  clearHistory() {
    this.conversationHistory = [];
    console.log('🧹 [IterativeGenerator] 对话历史已清除');
  }

  /**
   * 获取统计信息
   */
  getStats() {
    return {
      maxRetries: this.maxRetries,
      retryDelay: this.retryDelay,
      historyLength: this.conversationHistory.length
    };
  }
}
