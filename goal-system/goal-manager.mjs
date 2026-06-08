/**
 * 目标管理器 (GoalManager)
 *
 * 职责：目标的 CRUD 操作、状态管理、持久化存储
 * 实现完整的目标生命周期管理
 */

import fs from "fs-extra";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const GOALS_FILE = path.join(__dirname, "..", ".goals.json");
const DAILY_PLANS_FILE = path.join(__dirname, "..", ".daily-plans.json");

export class GoalManager {
  constructor(options = {}) {
    this.goalsFile = options.goalsFile || GOALS_FILE;
    this.dailyPlansFile = options.dailyPlansFile || DAILY_PLANS_FILE;
    this.maxHistoryPerGoal = options.maxHistoryPerGoal || 100;
    this.retentionDays = options.retentionDays || 90;
  }

  async init() {
    try {
      await this._ensureFilesExist();
      console.log("✅ [GoalManager] 初始化完成");
    } catch (error) {
      console.error("❌ [GoalManager] 初始化失败:", error.message);
      throw error;
    }
  }

  /**
   * 创建新目标
   */
  async createGoal(parsedGoal) {
    console.log(`🎯 [GoalManager] 创建目标: "${parsedGoal.title}"`);

    const validation = this.validate(parsedGoal);
    if (!validation.valid) {
      throw new Error(`目标验证失败: ${validation.errors.join(', ')}`);
    }

    const goal = {
      ...parsedGoal,
      id: this._generateId(parsedGoal.title),
      status: "planning",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };

    const goals = await this._loadGoals();
    goals.push(goal);
    await this._saveGoals(goals);

    console.log(`✅ [GoalManager] 目标已创建: ${goal.id}`);
    return goal;
  }

  /**
   * 获取目标详情
   */
  async getGoal(goalId) {
    const goals = await this._loadGoals();
    return goals.find(g => g.id === goalId) || null;
  }

  /**
   * 获取所有目标（支持过滤）
   */
  async getGoals(filters = {}) {
    let goals = await this._loadGoals();

    if (filters.status === "active") {
      goals = goals.filter(g => ["planning", "in_progress", "near_complete", "paused"].includes(g.status));
    } else if (filters.status === "completed") {
      goals = goals.filter(g => g.status === "achieved");
    } else if (filters.status === "archived") {
      goals = goals.filter(g => g.status === "archived");
    } else if (filters.status && filters.status !== "all") {
      goals = goals.filter(g => g.status === filters.status);
    }

    if (filters.type) {
      goals = goals.filter(g => g.type === filters.type);
    }

    if (filters.limit) {
      goals = goals.slice(0, filters.limit);
    }

    return goals;
  }

  /**
   * 获取活跃目标
   */
  async getActiveGoals() {
    return this.getGoals({ status: "active" });
  }

  /**
   * 更新目标进度（每日调用）
   */
  async updateProgress(goalId, dayResult = {}) {
    const goals = await this._loadGoals();
    const goalIndex = goals.findIndex(g => g.id === goalId);

    if (goalIndex === -1) {
      throw new Error(`目标不存在: ${goalId}`);
    }

    const goal = goals[goalIndex];
    goal.progress.currentDay++;
    goal.progress.percentage = parseFloat(
      ((goal.progress.currentDay / goal.progress.totalDays) * 100).toFixed(1)
    );

    if (dayResult.completed !== false) {
      goal.progress.streak = Math.max(0, goal.progress.streak) + 1;
    } else {
      goal.progress.streak = Math.min(0, goal.progress.streak) - 1;
    }

    goal.progress.lastActivityDate = new Date().toISOString().split('T')[0];
    goal.updatedAt = new Date().toISOString();

    this._transitionStatus(goal);

    goals[goalIndex] = goal;
    await this._saveGoals(goals);

    console.log(`📊 [GoalManager] 目标 ${goalId} 进度更新: Day ${goal.progress.currentDay}/${goal.progress.totalDays} (${goal.progress.percentage}%)`);

    return goal;
  }

  /**
   * 更新目标配置
   */
  async updateGoal(goalId, updates) {
    const goals = await this._loadGoals();
    const goalIndex = goals.findIndex(g => g.id === goalId);

    if (goalIndex === -1) {
      throw new Error(`目标不存在: ${goalId}`);
    }

    const goal = goals[goalIndex];
    const changes = [];

    if (updates.config) {
      Object.assign(goal.config, updates.config);
      changes.push("配置已更新");
    }

    if (updates.preferences) {
      Object.assign(goal.preferences, updates.preferences);
      changes.push("偏好已更新");
    }

    if (updates.status) {
      goal.status = updates.status;
      changes.push(`状态: ${updates.status}`);
    }

    if (updates.title) {
      goal.title = updates.title;
      changes.push(`标题: ${updates.title}`);
    }

    goal.updatedAt = new Date().toISOString();

    if (updates.config?.duration) {
      goal.progress.totalDays = updates.config.duration;
      goal.progress.percentage = parseFloat(
        ((goal.progress.currentDay / goal.progress.totalDays) * 100).toFixed(1)
      );
    }

    goals[goalIndex] = goal;
    await this._saveGoals(goals);

    return { goal, changes };
  }

  /**
   * 暂停目标
   */
  async pauseGoal(goalId) {
    return this.updateGoal(goalId, { status: "paused" });
  }

  /**
   * 恢复目标
   */
  async resumeGoal(goalId) {
    const goal = await this.getGoal(goalId);
    if (!goal) throw new Error(`目标不存在: ${goalId}`);

    if (goal.status === "paused") {
      return this.updateGoal(goalId, { status: "in_progress" });
    }

    return { goal, changes: [] };
  }

  /**
   * 归档目标（软删除）
   */
  async archiveGoal(goalId) {
    const goal = await this.getGoal(goalId);
    if (!goal) throw new Error(`目标不存在: ${goalId}`);

    const finalStats = {
      totalDays: goal.progress.totalDays,
      completedDays: goal.progress.currentDay,
      completionRate: parseFloat(goal.progress.percentage.toFixed(1)),
      archivedAt: new Date().toISOString()
    };

    await this.updateGoal(goalId, { status: "archived" });

    return { goal, finalStatistics: finalStats };
  }

  /**
   * 物理删除目标
   */
  async deleteGoal(goalId) {
    const goals = await this._loadGoals();
    const filtered = goals.filter(g => g.id !== goalId);

    if (filtered.length === goals.length) {
      throw new Error(`目标不存在: ${goalId}`);
    }

    await this._saveGoals(filtered);

    await this.deleteGoalHistory(goalId);

    console.log(`🗑️ [GoalManager] 目标已删除: ${goalId}`);
    return true;
  }

  /**
   * 获取目标历史 DailyPlan
   */
  async getGoalHistory(goalId, limit = 7) {
    const plans = await this._loadDailyPlans();
    let goalPlans = plans.filter(p => p.goalId === goalId);

    goalPlans.sort((a, b) => new Date(b.date) - new Date(a.date));

    if (limit > 0) {
      goalPlans = goalPlans.slice(0, limit);
    }

    return goalPlans.map(p => ({
      date: p.date,
      dayNumber: p.dayNumber,
      tasksCount: p.tasks?.length || 0,
      adjustmentsMade: p.adjustmentSummary?.totalAdjustments || 0,
      generatedAt: p.generatedAt
    }));
  }

  /**
   * 保存 DailyPlan
   */
  async saveDailyPlan(dailyPlan) {
    const plans = await this._loadDailyPlans();

    const existingIndex = plans.findIndex(
      p => p.goalId === dailyPlan.goalId && p.date === dailyPlan.date
    );

    if (existingIndex !== -1) {
      plans[existingIndex] = dailyPlan;
    } else {
      plans.push(dailyPlan);
    }

    await this._applyRetentionPolicy(plans);
    await this._saveDailyPlans(plans);

    console.log(`💾 [GoalManager] DailyPlan 已保存: ${dailyPlan.goalId} @ ${dailyPlan.date}`);
  }

  /**
   * 获取明日的 DailyPlan（如果已生成）
   */
  async getTomorrowPlan(goalId) {
    const tomorrow = new Date(Date.now() + 86400000).toISOString().split('T')[0];
    const plans = await this._loadDailyPlans();

    return plans.find(p => p.goalId === goalId && p.date === tomorrow) || null;
  }

  /**
   * 更新调整历史
   */
  async addAdjustment(goalId, adjustment) {
    const goals = await this._loadGoals();
    const goalIndex = goals.findIndex(g => g.id === goalId);

    if (goalIndex === -1) return;

    const goal = goals[goalIndex];
    if (!goal.adjustments) goal.adjustments = [];

    goal.adjustments.push({
      ...adjustment,
      date: new Date().toISOString().split('T')[0]
    });

    if (goal.adjustments.length > 50) {
      goal.adjustments = goal.adjustments.slice(-50);
    }

    goals[goalIndex] = goal;
    await this._saveGoals(goals);
  }

  /**
   * 更新关联的定时任务ID
   */
  async updateScheduleIds(goalId, scheduleIds) {
    const goals = await this._loadGoals();
    const goalIndex = goals.findIndex(g => g.id === goalId);

    if (goalIndex === -1) return;

    goals[goalIndex].scheduleIds = scheduleIds;
    await this._saveGoals(goals);
  }

  /**
   * 设置目标开始日期
   */
  async setStartDate(goalId) {
    const goals = await this._loadGoals();
    const goalIndex = goals.findIndex(g => g.id === goalId);

    if (goalIndex === -1) return;

    const goal = goals[goalIndex];

    if (!goal.startDate) {
      goal.startDate = new Date().toISOString();
      goal.endDate = this._calculateEndDate(goal.startDate, goal.config.duration);
      goal.nextReviewAt = this._calculateNextReviewTime();
      goal.status = "in_progress";

      console.log(`📅 [GoalManager] 目标 ${goalId} 已启动: ${goal.startDate} → ${goal.endDate}`);
    }

    goals[goalIndex] = goal;
    await this._saveGoals(goals);

    return goal;
  }

  /**
   * 获取统计信息
   */
  async getStatistics() {
    const goals = await this._loadGoals();

    return {
      totalCreated: goals.length,
      totalAchieved: goals.filter(g => g.status === "achieved").length,
      activeCount: goals.filter(g => ["planning", "in_progress", "near_complete", "paused"].includes(g.status)).length,
      archivedCount: goals.filter(g => g.status === "archived").length,
      lastUpdated: new Date().toISOString()
    };
  }

  validate(goal) {
    const errors = [];
    const warnings = [];

    if (!goal || typeof goal !== 'object') {
      return { valid: false, errors: ['无效的目标对象'], warnings: [], confidence: 0 };
    }

    if (!goal.type || !['habit', 'task', 'health', 'custom'].includes(goal.type)) {
      errors.push('无效的目标类型');
    }

    if (!goal.title || goal.title.length < 2) {
      errors.push('标题不能少于2个字符');
    }

    if (!goal.config || !goal.config.duration || goal.config.duration < 1) {
      errors.push('持续时间必须大于0');
    } else if (goal.config.duration > 365) {
      warnings.push('持续时间超过365天');
    }

    if (goal.config.targetTime && !/^([01]?[0-9]|2[0-3]):[0-5][0-9]$/.test(goal.config.targetTime)) {
      errors.push(`时间格式无效: ${goal.config.targetTime}`);
    }

    return {
      valid: errors.length === 0,
      errors,
      warnings,
      confidence: goal.aiConfidence || 0.8
    };
  }

  _transitionStatus(goal) {
    const currentStatus = goal.status;
    const percentage = goal.progress.percentage;

    switch (currentStatus) {
      case 'planning':
        break;

      case 'in_progress':
        if (percentage >= 80) {
          goal.status = 'near_complete';
          console.log(`🎯 [GoalManager] 目标 ${goal.id} 进入接近完成状态 (${percentage}%)`);
        }
        break;

      case 'near_complete':
        if (percentage >= 100) {
          goal.status = 'achieved';
          console.log(`🎉 [GoalManager] 目标 ${goal.id} 已达成！`);
        }
        break;

      case 'achieved':
        const achievedAt = new Date(goal.updatedAt || goal.createdAt);
        const daysSinceAchieved = Math.floor(
          (Date.now() - achievedAt.getTime()) / 86400000
        );
        if (daysSinceAchieved >= 7) {
          goal.status = 'archived';
          console.log(`📦 [GoalManager] 目标 ${goal.id} 已自动归档`);
        }
        break;

      case 'paused':
        break;

      case 'archived':
        break;
    }

    goal.updatedAt = new Date().toISOString();
  }

  _generateId(title) {
    const timestamp = Date.now().toString(36);
    const slug = (title || "goal")
      .toLowerCase()
      .replace(/[^a-z0-9\u4e00-\u9fa5]+/g, "-")
      .substring(0, 15);
    return `${slug}-${timestamp}`;
  }

  _calculateEndDate(startDate, duration) {
    const start = new Date(startDate);
    start.setDate(start.getDate() + duration);
    return start.toISOString();
  }

  _calculateNextReviewTime() {
    const tonight = new Date();
    tonight.setHours(22, 0, 0, 0);

    if (tonight <= new Date()) {
      tonight.setDate(tonight.getDate() + 1);
    }

    return tonight.toISOString();
  }

  async _loadGoals() {
    try {
      if (await fs.pathExists(this.goalsFile)) {
        const data = await fs.readJson(this.goalsFile);
        return data.goals || [];
      }
    } catch (error) {
      console.error("❌ [GoalManager] 加载目标失败:", error.message);
    }
    return [];
  }

  async _saveGoals(goals) {
    const data = {
      goals,
      lastUpdated: new Date().toISOString()
    };
    await fs.writeJson(this.goalsFile, data, { spaces: 2 });
  }

  async _loadDailyPlans() {
    try {
      if (await fs.pathExists(this.dailyPlansFile)) {
        const data = await fs.readJson(this.dailyPlansFile);
        return data.plans || [];
      }
    } catch (error) {
      console.error("❌ [GoalManager] 加载每日计划失败:", error.message);
    }
    return [];
  }

  async _saveDailyPlans(plans) {
    const data = {
      plans,
      retentionPolicy: {
        maxAgeDays: this.retentionDays,
        maxPlansPerGoal: this.maxHistoryPerGoal
      },
      lastUpdated: new Date().toISOString()
    };
    await fs.writeJson(this.dailyPlansFile, data, { spaces: 2 });
  }

  async _deleteGoalHistory(goalId) {
    const plans = await this._loadDailyPlans();
    const filtered = plans.filter(p => p.goalId !== goalId);
    await this._saveDailyPlans(filtered);
  }

  async _applyRetentionPolicy(plans) {
    const cutoffDate = new Date();
    cutoffDate.setDate(cutoffDate.getDate() - this.retentionDays);
    const cutoffStr = cutoffDate.toISOString().split('T')[0];

    let filtered = plans.filter(p => p.date >= cutoffStr);

    const goalCounts = {};
    filtered.forEach(p => {
      goalCounts[p.goalId] = (goalCounts[p.goalId] || 0) + 1;
    });

    filtered = filtered.filter(p => {
      return (goalCounts[p.goalId] || 0) <= this.maxHistoryPerGoal;
    });

    return filtered;
  }

  async _ensureFilesExist() {
    if (!(await fs.pathExists(this.goalsFile))) {
      await fs.writeJson(this.goalsFile, { goals: [], lastUpdated: new Date().toISOString() }, { spaces: 2 });
      console.log(`📄 [GoalManager] 创建目标文件: ${this.goalsFile}`);
    }

    if (!(await fs.pathExists(this.dailyPlansFile))) {
      await fs.writeJson(this.dailyPlansFile, {
        plans: [],
        retentionPolicy: { maxAgeDays: this.retentionDays, maxPlansPerGoal: this.maxHistoryPerGoal },
        lastUpdated: new Date().toISOString()
      }, { spaces: 2 });
      console.log(`📄 [GoalManager] 创建计划文件: ${this.dailyPlansFile}`);
    }
  }
}

export default GoalManager;
