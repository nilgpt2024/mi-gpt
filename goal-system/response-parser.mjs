/**
 * 智能响应解析器 (ResponseParser) v2.0
 * 
 * 职责: 统一解析 OpenCode 的混合响应
 * 
 * 支持三种响应类型:
 * 1. conversation (纯对话)
 * 2. file_generation (纯文件生成)
 * 3. mixed (混合: 文件 + 对话) ⭐ 最常见
 */

import fs from 'fs-extra';
import path from 'path';

export class ResponseParser {
  constructor(options = {}) {
    this.workingDirectory = options.workingDirectory || process.cwd();
    this.scanTimeout = options.scanTimeout || 5000;
    this.filePatterns = options.filePatterns || ['*.json', '*.txt', '*.md'];
    
    // 内部状态：保存最后一次的原始内容（用于辅助检测）
    this._lastRawContent = '';
  }

  /**
   * 解析 OpenCode 的完整响应 (主方法)
   */
  async parse(opencodeResponse, context = {}) {
    const startTime = Date.now();
    console.log(`\n🔍 [ResponseParser] 开始解析 OpenCode 响应...`);

    try {
      // Step 1: 提取原始数据
      const rawData = this._extractRawData(opencodeResponse);
      this._lastRawContent = rawData.content;

      // Step 2: 并行执行文本分析和文件检测
      const [textAnalysis, fileDetection] = await Promise.all([
        this._analyzeTextContent(rawData, context),
        this._detectGeneratedFiles(context)
      ]);

      // Step 3: 构建最终的解析结果
      const parsedResponse = this._buildParsedResponse(
        rawData,
        textAnalysis,
        fileDetection,
        context
      );

      const duration = Date.now() - startTime;
      console.log(`✅ [ResponseParser] 解析完成 (${duration}ms)`);
      console.log(`   类型: ${parsedResponse.responseType}`);
      console.log(`   文本: ${parsedResponse.text?.length || 0} 字符`);
      console.log(`   文件: ${parsedResponse.fileCount} 个`);

      return parsedResponse;

    } catch (error) {
      console.error(`❌ [ResponseParser] 解析失败:`, error.message);
      
      return {
        responseType: 'error',
        error: error.message,
        timestamp: new Date().toISOString(),
        isSuccess: () => false,
        toLogString: () => `[ERROR] ${error.message}`
      };
    }
  }

  /**
   * 创建目录快照 (在调用 OpenCode 前调用)
   */
  async createSnapshot(directory) {
    const dir = directory || this.workingDirectory;
    const cutoffTime = new Date(Date.now() - 1000); // 1秒前

    let files = [];
    try {
      files = await this._getRecentFiles(dir, cutoffTime);
    } catch (e) {
      console.warn(`⚠️ [ResponseParser] 快照创建失败:`, e.message);
    }

    const snapshot = {
      timestamp: new Date().toISOString(),
      directory: dir,
      files,
      count: files.length
    };

    console.log(`📸 [ResponseParser] 创建快照: ${dir} (${files.count} 个现有文件)`);

    return snapshot;
  }

  // ==================== 私有方法 ====================

  _extractRawData(response) {
    if (!response) {
      return { content: '', parts: [], metadata: {} };
    }

    let content = '';
    let parts = [];

    // 处理不同的响应格式
    if (response.content) {
      content = response.content;
      parts.push({ type: 'text', content });
    }

    if (response.parts && Array.isArray(response.parts)) {
      parts = response.parts.map(p => ({
        type: p.type || 'unknown',
        content: p.text || p.content || ''
      }));

      // 合并所有文本内容
      const textParts = parts.filter(p => p.type === 'text');
      content = textParts.map(p => p.content).join('\n');
    }

    if (!content && typeof response === 'string') {
      content = response;
      parts.push({ type: 'text', content });
    }

    // 从 rawResponse 补充内容（OpenCode 可能返回多 parts，content 只提取了 text 类型）
    if (response.rawResponse) {
      const raw = response.rawResponse;

      // rawResponse 是对象时，检查是否有更多 parts 或更完整的内容
      if (typeof raw === 'object' && raw !== null) {
        // 检查 raw 中的 parts（可能包含非 text 类型的数据）
        if (raw.parts && Array.isArray(raw.parts)) {
          const allTextFromRaw = raw.parts
            .filter(p => (p.type === 'text' || !p.type) && (p.text || p.content))
            .map(p => p.text || p.content)
            .join('\n');

          // 如果 raw 的文本比当前 content 更长/更完整，使用 raw 的
          if (allTextFromRaw.length > content.length) {
            console.log(`📎 [ResponseParser] 从 rawResponse 补充内容 (${content} → ${allTextFromRaw.length} 字符)`);
            content = allTextFromRaw;
            parts = raw.parts.map(p => ({
              type: p.type || 'unknown',
              content: p.text || p.content || ''
            }));
          }
        }

        // 如果 content 看起来不包含JSON（没有代码块标记），尝试从 raw 中提取
        if (content && !content.includes('```') && !content.includes('"tasks"')) {
          const rawStr = typeof raw.content === 'string' ? raw.content : JSON.stringify(raw);
          if (rawStr.length > content.length && (rawStr.includes('```') || rawStr.includes('"tasks"'))) {
            console.log(`📎 [ResponseParser] content 无JSON，从 rawResponse 使用更长内容 (${content.length} → ${rawStr.length} 字符)`);
            content = rawStr;
          }
        }
      }

      // 最终兜底：如果 content 仍然为空或很短，用 rawResponse 序列化
      if (!content || content.length < 50) {
        const fallbackContent = typeof raw === 'string' ? raw : JSON.stringify(raw);
        if (fallbackContent.length > content.length) {
          content = fallbackContent;
        }
      }
    }

    return {
      content: content.trim(),
      parts,
      metadata: {
        model: response.model,
        usage: response.usage,
        opencodeSessionId: response.opencodeSessionId,
        rawResponse: response.rawResponse
      }
    };
  }

  async _analyzeTextContent(rawData, context) {
    const content = rawData.content;

    if (!content) {
      return { hasText: false, text: null, intent: null, entities: [] };
    }

    // 使用规则提取意图和实体 (可扩展为AI分析)
    const analysis = this._extractIntentAndEntities(content);

    return {
      hasText: true,
      text: content,
      ...analysis
    };
  }

  _extractIntentAndEntities(content) {
    // 简单的规则-based 意图识别
    const intentPatterns = [
      { pattern: /创建|新建|添加|生成|建立|设定/, intent: 'create' },
      { pattern: /删除|移除|取消|去掉|清除/, intent: 'delete' },
      { pattern: /修改|更新|编辑|调整|改变|变更/, intent: 'update' },
      { pattern: /查询|查看|列出|显示|什么|怎么|如何/, intent: 'query' },
      { pattern: /确认|好的|完成|成功|已经|可以/, intent: 'confirm' },
      { pattern: /错误|失败|不行|无法|不能|有问题/, intent: 'error' }
    ];

    let matchedIntent = null;
    for (const { pattern, intent } of intentPatterns) {
      if (pattern.test(content)) {
        matchedIntent = intent;
        break;
      }
    }

    // 提取关键实体
    const entities = [];

    // 数字
    const numbers = content.match(/\d+/g);
    if (numbers) {
      entities.push({ type: 'number', values: numbers.slice(0, 5) });
    }

    // 时间
    const times = content.match(/\d{1,2}:\d{2}/g);
    if (times) {
      entities.push({ type: 'time', values: times.slice(0, 3) });
    }

    // 天数
    const days = content.match(/\d+\s*天/);
    if (days) {
      entities.push({ type: 'duration', values: days.slice(0, 2) });
    }

    return { intent: matchedIntent, entities };
  }

  async _detectGeneratedFiles(context) {
    const directory = context.directory || this.workingDirectory;

    console.log(`📁 [ResponseParser] 扫描目录: ${directory}`);

    try {
      // 方法0（优先）: 已知路径直接检查 — 从 prompt 内容中提取目标文件路径
      const knownPathResult = await this._checkKnownFilePath(this._lastRawContent || '', directory);

      // 方法1: 快照对比法
      const snapshotResult = await this._scanBySnapshot(directory, context.beforeSnapshot);

      // 方法2: 内容解析法 (辅助验证)
      const contentResult = this._parseFileMentionsInContent(
        this._lastRawContent || '',
        directory
      );

      // 合并所有方法的结果（已知路径优先）
      const allFiles = this._mergeFileDetections([knownPathResult, snapshotResult, contentResult]);

      // 验证每个文件是否存在且有效
      const validatedFiles = [];
      for (const file of allFiles) {
        const validated = await this._validateGeneratedFile(file);
        validatedFiles.push(validated);
      }

      return {
        files: validatedFiles.filter(f => f.exists),
        scanMethod: knownPathResult.files?.length > 0 ? 'known-path' :
                     snapshotResult.files?.length > 0 ? 'snapshot' : 'content-only',
        duration: snapshotResult.duration || 0
      };

    } catch (error) {
      console.error(`❌ [ResponseParser] 文件检测失败:`, error.message);
      return { files: [], error: error.message };
    }
  }

  /**
   * 从 prompt 内容中提取目标文件路径并直接检查
   * 这是最可靠的方法：我们知道告诉 OpenCode 要生成哪个文件
   */
  async _checkKnownFilePath(content, baseDir) {
    // 匹配 prompt 中的目标文件路径模式
    const patterns = [
      /\*{0,2}目标文件路径\*{0,2}:\s*([^\s\n]+\.json)/gi,
      /目标文件[路径:]*\s*([^\s\n]+\.json)/gi,
      /(?:保存到|写入|输出到|生成)\s*[:`]?\s*(data[\\/][^\s\n]+\.json)/gi,
      /(`?data[\\/][^\s\n`]+\.json`?)/gi,
    ];

    const foundPaths = [];
    for (const pattern of patterns) {
      const matches = [...content.matchAll(pattern)];
      for (const match of matches) {
        let filePath = match[1] || match[0];
        // 清理路径中的 markdown 标记
        filePath = filePath.replace(/`/g, '').trim();
        
        // 转为绝对路径
        const absolutePath = path.isAbsolute(filePath)
          ? filePath
          : path.join(process.cwd(), filePath);

        foundPaths.push(absolutePath);
      }
    }

    // 去重
    const uniquePaths = [...new Set(foundPaths)];

    if (uniquePaths.length === 0) {
      return { files: [], method: 'known-path', duration: 0 };
    }

    console.log(`🎯 [ResponseParser] 检测到已知目标路径: ${uniquePaths.join(', ')}`);

    // 直接检查每个路径是否存在
    const existingFiles = [];
    for (const filePath of uniquePaths) {
      try {
        if (await fs.pathExists(filePath)) {
          const stat = await fs.stat(filePath);
          existingFiles.push({
            path: filePath,
            filename: path.basename(filePath),
            size: stat.size,
            mtime: stat.mtime,
            detectedBy: 'known-path'
          });
          console.log(`✅ [ResponseParser] 目标文件已存在: ${filePath} (${stat.size} bytes, ${stat.mtime.toISOString()})`);
        } else {
          console.log(`⏳ [ResponseParser] 目标文件尚未生成: ${filePath}`);
        }
      } catch (e) {
        console.log(`⚠️ [ResponseParser] 检查文件失败: ${filePath} - ${e.message}`);
      }
    }

    return {
      files: existingFiles,
      method: 'known-path',
      duration: 0
    };
  }

  async _scanBySnapshot(directory, beforeSnapshot) {
    const startTime = Date.now();

    const cutoffTime = new Date(Date.now() - 60000); // 1分钟内修改

    let currentFiles = [];
    try {
      currentFiles = await this._getRecentFiles(directory, cutoffTime);
    } catch (e) {
      console.warn(`⚠️ [ResponseParser] 文件扫描异常:`, e.message);
    }

    // 如果有beforeSnapshot，计算差异
    if (beforeSnapshot?.files) {
      const beforePaths = new Set(beforeSnapshot.files.map(f => f.path));
      
      const newOrModified = currentFiles.filter(current => {
        const existedBefore = beforePaths.has(current.path);
        
        if (!existedBefore) return true; // 新文件
        
        // 已存在的文件检查是否被修改
        const beforeFile = beforeSnapshot.files.find(f => f.path === current.path);
        return beforeFile && beforeFile.mtime < current.mtime;
      });

      return {
        files: newOrModified.map(f => ({
          path: f.path,
          filename: path.basename(f.path),
          size: f.size,
          mtime: f.mtime,
          detectedBy: 'snapshot'
        })),
        method: 'snapshot-compare',
        duration: Date.now() - startTime
      };
    }

    // 无快照，返回所有最近修改的文件
    return {
      files: currentFiles.map(f => ({
        path: f.path,
        filename: path.basename(f.path),
        size: f.size,
        mtime: f.mtime,
        detectedBy: 'recent-files'
      })),
      method: 'recent-scan',
      duration: Date.now() - startTime
    };
  }

  async _getRecentFiles(directory, cutoffTime) {
    const files = [];

    const walkDir = async (dir) => {
      let entries;
      try {
        entries = await fs.readdir(dir, { withFileTypes: true });
      } catch (e) {
        return; // 无法访问的目录跳过
      }

      for (const entry of entries) {
        const fullPath = path.join(dir, entry.name);

        if (entry.isDirectory()) {
          // 排除系统目录和隐藏目录
          if (!['node_modules', '.git', '.cache', '__pycache__', '.next'].includes(entry.name) &&
              !entry.name.startsWith('.')) {
            await walkDir(fullPath);
          }
        } else if (entry.isFile()) {
          try {
            const stat = await fs.stat(fullPath);
            
            if (stat.mtime > cutoffTime) {
              files.push({
                path: fullPath,
                name: entry.name,
                size: stat.size,
                mtime: stat.mtime
              });
            }
          } catch (e) {
            // 忽略无法访问的文件
          }
        }
      }
    };

    await walkDir(directory);

    return files;
  }

  _parseFileMentionsInContent(content, baseDirectory) {
    if (!content) {
      return { files: [], method: 'content-parse' };
    }

    const filePaths = [];

    // 匹配常见的文件路径模式
    const patterns = [
      // 中文描述
      /(?:创建|生成|写入|保存|输出|在)[了到\s]*(["'`]?)([^\s"']+\.(?:json|txt|md|csv|yaml|yml))\1/gi,
      // 英文描述
      /(?:file|path|to)[:\s]+(["'])([^"']+\.\w+)\1/gi,
      // 箭头指向
      /(?:→|->)\s*(.*?\.(?:json|txt|md))/gi,
      // data/ 路径
      /(data\/[^\s,]+)/gi,
      // Windows 路径
      /[a-zA-Z]:\\[^\s,]+\.(?:json|txt|md)/gi
    ];

    for (const pattern of patterns) {
      let match;
      while ((match = pattern.exec(content)) !== null) {
        let filePath = match[2] || match[1];

        // 清理路径
        filePath = filePath.replace(/[`'"]/g, '').trim();

        // 转换为绝对路径
        if (!path.isAbsolute(filePath)) {
          filePath = path.join(baseDirectory, filePath);
        }

        // 标准化路径分隔符
        filePath = filePath.replace(/\\/g, '/');

        // 避免重复
        if (!filePaths.some(f => f.path.toLowerCase() === filePath.toLowerCase())) {
          filePaths.push({
            path: filePath,
            filename: path.basename(filePath),
            mentionedIn: content.substring(
              Math.max(0, match.index - 30),
              Math.min(content.length, match.index + match[0].length + 30)
            ),
            detectedBy: 'content-mention'
          });
        }
      }
    }

    return { files: filePaths, method: 'content-parse' };
  }

  _mergeFileDetections(resultsArray) {
    const mergedMap = new Map();

    for (const result of resultsArray) {
      if (!result?.files) continue;

      for (const file of result.files) {
        const key = file.path.toLowerCase();

        if (mergedMap.has(key)) {
          // 合并检测信息
          const existing = mergedMap.get(key);
          
          existing.detectionMethods = existing.detectionMethods || [];
          if (!existing.detectionMethods.includes(file.detectedBy)) {
            existing.detectionMethods.push(file.detectedBy);
          }

          // 保留更完整的信息
          if (file.size && !existing.size) existing.size = file.size;
          if (file.mtime && !existing.mtime) existing.mtime = file.mtime;
        } else {
          mergedMap.set(key, {
            ...file,
            detectionMethods: [file.detectedBy]
          });
        }
      }
    }

    return Array.from(mergedMap.values());
  }

  async _validateGeneratedFile(fileInfo) {
    try {
      const exists = fs.existsSync(fileInfo.path);

      if (!exists) {
        return {
          ...fileInfo,
          exists: false,
          valid: false,
          error: 'FILE_NOT_FOUND'
        };
      }

      const stat = fs.statSync(fileInfo.path);
      let content = '';
      let parsedContent = null;
      let parseError = null;
      let contentType = 'application/octet-stream';

      try {
        content = fs.readFileSync(fileInfo.path, 'utf-8');
        contentType = this._detectContentType(fileInfo.path, content);

        // 尝试JSON解析
        if (fileInfo.path.endsWith('.json') || content.trim().startsWith('{')) {
          try {
            parsedContent = JSON.parse(content);
          } catch (e) {
            parseError = e.message;
          }
        }
      } catch (readError) {
        return {
          ...fileInfo,
          exists: true,
          valid: false,
          error: `READ_ERROR: ${readError.message}`
        };
      }

      return {
        ...fileInfo,
        exists: true,
        size: stat.size,
        mtime: stat.mtime,
        contentType,
        contentPreview: content.substring(0, 200),
        parsedContent,
        parseError,
        valid: !parseError
      };

    } catch (error) {
      return {
        ...fileInfo,
        exists: false,
        valid: false,
        error: error.message
      };
    }
  }

  _detectContentType(filePath, content) {
    const ext = path.extname(filePath).toLowerCase();
    
    const mimeTypes = {
      '.json': 'application/json',
      '.txt': 'text/plain',
      '.md': 'text/markdown',
      '.yaml': 'application/yaml',
      '.yml': 'application/yml',
      '.xml': 'application/xml',
      '.csv': 'text/csv'
    };

    if (mimeTypes[ext]) return mimeTypes[ext];

    // 自动检测
    const trimmed = (content || '').trim();
    if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
      return 'application/json';
    }

    return 'text/plain';
  }

  _buildParsedResponse(rawData, textAnalysis, fileDetection, context) {
    const hasText = textAnalysis.hasText;
    const hasFiles = fileDetection.files?.length > 0;

    // 确定响应类型
    let responseType;
    if (hasText && hasFiles) {
      responseType = 'mixed';
    } else if (hasFiles) {
      responseType = 'file_generation';
    } else if (hasText) {
      responseType = 'conversation';
    } else {
      responseType = 'empty';
    }

    // 构建结果对象
    const result = {
      // 基本信息
      responseType,
      timestamp: new Date().toISOString(),

      // 文本部分
      text: textAnalysis.text,
      intent: textAnalysis.intent,
      entities: textAnalysis.entities,

      // 文件部分
      files: fileDetection.files,
      fileCount: fileDetection.files?.length || 0,

      // 元数据
      metadata: rawData.metadata,
      rawContent: rawData.content,
      rawParts: rawData.parts,

      // ==================== 便捷访问器 ====================
      
      get firstText() {
        return this.text;
      },

      get firstFile() {
        return this.files?.[0];
      },

      get jsonFiles() {
        return this.files?.filter(f => f.contentType === 'application/json') || [];
      },

      get goalFile() {
        return this.jsonFiles?.find(f => 
          f.path.toLowerCase().includes('goals') || 
          f.filename.startsWith('goal-')
        );
      },

      get dailyPlanFile() {
        return this.jsonFiles?.find(f => 
          f.path.toLowerCase().includes('daily-plans')
        );
      },

      // 工具方法
      getFileByPattern(pattern) {
        if (!this.files) return null;
        const regex = new RegExp(pattern, 'i');
        return this.files.find(f => 
          regex.test(f.filename) || regex.test(f.path)
        ) || null;
      },

      getTextSummary(maxLength = 100) {
        if (!this.text) return '';
        return this.text.length > maxLength
          ? this.text.substring(0, maxLength) + '...'
          : this.text;
      },

      isSuccess() {
        if (this.responseType === 'empty' || this.responseType === 'error') return false;
        if (this.responseType === 'file_generation') {
          return this.files?.some(f => f.valid) || false;
        }
        return true;
      },

      toLogString() {
        return `[${this.responseType?.toUpperCase() || 'UNKNOWN'}] ` +
               `Text: ${this.text?.length || 0}chars, ` +
               `Files: ${this.fileCount}, ` +
               `Intent: ${this.intent || 'none'}`;
      },

      toJSON() {
        return {
          responseType: this.responseType,
          text: this.getTextSummary(200),
          fileCount: this.fileCount,
          files: this.files?.map(f => ({
            path: f.path,
            filename: f.filename,
            valid: f.valid,
            size: f.size
          })) || [],
          intent: this.intent,
          isSuccess: this.isSuccess()
        };
      }
    };

    return result;
  }
}
