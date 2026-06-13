/**
 * 小爱音箱管理后台前端逻辑
 */

// ==================== 工具函数 ====================

async function api(url, options = {}) {
  const res = await fetch(url, {
    headers: { "Content-Type": "application/json" },
    ...options,
  });
  return res.json();
}

function showToast(message, type = "info") {
  const toast = document.getElementById("toast");
  toast.textContent = message;
  toast.className = `toast ${type} show`;
  setTimeout(() => toast.classList.remove("show"), 3000);
}

// ==================== 系统提示词编辑器 ====================

/**
 * localStorage 键名
 */
const STORAGE_KEYS = {
  SYSTEM_PROMPT: 'mi-gpt-custom-system-prompt',
  USER_PROMPT: 'mi-gpt-custom-user-prompt'
};

/**
 * 系统提示词由后端 dynamic-adjuster._buildSystemPrompt() 统一管理
 * 前端仅负责用户自定义覆盖，未自定义时传 null 由后端使用默认值
 */

/**
 * 切换系统提示词编辑器的显示/隐藏
 */
function toggleSystemPromptEditor() {
  const container = document.getElementById('systemPromptEditorContainer');
  const btn = document.getElementById('toggleSystemPromptBtn');
  if (!container || !btn) return;

  const isHidden = container.style.display === 'none' || container.style.display === '';

  if (isHidden) {
    // 显示前加载已保存的提示词（或默认值）
    loadSystemPrompt();

    container.style.display = 'block';
    btn.innerHTML = '📋 收起编辑器';
    container.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  } else {
    container.style.display = 'none';
    btn.innerHTML = '📋 编辑系统提示词';
  }
}

/**
 * 从 localStorage 加载系统提示词到编辑器
 */
function loadSystemPrompt() {
  const editor = document.getElementById('systemPromptEditor');
  if (!editor) return;

  // 尝试从 localStorage 读取自定义提示词
  const savedPrompt = localStorage.getItem(STORAGE_KEYS.SYSTEM_PROMPT);

  if (savedPrompt && savedPrompt.trim()) {
    editor.value = savedPrompt;
    console.log('✅ [SystemPrompt] 已加载自定义系统提示词');
  } else {
    // 未自定义时显示占位提示（实际使用后端 _buildSystemPrompt 默认值）
    editor.value = '';
    editor.placeholder = '未自定义，将使用后端默认系统提示词（含差异化规则等）';
    console.log('✅ [SystemPrompt] 未检测到自定义提示词，将使用后端默认值');
  }
}

/**
 * 保存系统提示词到 localStorage
 */
function saveSystemPrompt() {
  const editor = document.getElementById('systemPromptEditor');
  if (!editor) return;

  const promptValue = editor.value.trim();

  if (!promptValue) {
    showToast('⚠️ 系统提示词不能为空', 'warning');
    return;
  }

  try {
    localStorage.setItem(STORAGE_KEYS.SYSTEM_PROMPT, promptValue);
    showToast('✅ 系统提示词已保存！生成计划时将使用自定义版本', 'success');
    console.log('💾 [SystemPrompt] 自定义系统提示词已保存');

    // 🔗 同步到配置文件，供自动运行使用（异步，不阻塞）
    _syncSystemPromptToConfig(promptValue).catch(err => {
      console.warn('⚠️ [SystemPrompt] 同步到配置文件失败（不影响本地保存）:', err.message);
    });
  } catch (error) {
    console.error('❌ [SystemPrompt] 保存失败:', error);
    showToast('❌ 保存失败: ' + error.message, 'error');
  }
}

/**
 * 将系统提示词同步到 AI Planner 配置文件（供自动运行使用）
 */
async function _syncSystemPromptToConfig(promptValue) {
  try {
    const res = await api("/api/ai-planner/config");
    if (res.success && res.data) {
      const config = { ...res.data, systemPrompt: promptValue };
      await api("/api/ai-planner/config", { method: "POST", body: JSON.stringify(config) });
      console.log('🔗 [SystemPrompt] 已同步到配置文件（自动运行将生效）');
    }
  } catch (err) {
    // 静默失败，已在上层 catch 处理
    throw err;
  }
}

/**
 * 重置系统提示词为默认值
 */
function resetSystemPrompt() {
  const editor = document.getElementById('systemPromptEditor');
  if (!editor) return;

  if (confirm('确定要恢复为默认系统提示词吗？所有自定义修改将丢失。')) {
    editor.value = '';
    editor.placeholder = '未自定义，将使用后端默认系统提示词（含差异化规则等）';
    localStorage.removeItem(STORAGE_KEYS.SYSTEM_PROMPT);

    showToast('↩️ 已恢复为后端默认系统提示词', 'info');
    console.log('🔄 [SystemPrompt] 已重置为后端默认提示词');

    // 🔗 同步清空到配置文件
    _syncSystemPromptToConfig('').catch(() => {});
  }
}

/**
 * 获取当前系统提示词（供 generateAiPlan 使用）
 * @returns {string|null} 用户自定义提示词，未自定义时返回 null（后端使用 _buildSystemPrompt 默认值）
 */
function getSystemPrompt() {
  const savedPrompt = localStorage.getItem(STORAGE_KEYS.SYSTEM_PROMPT);

  if (savedPrompt && savedPrompt.trim()) {
    return savedPrompt.trim();
  }

  // 未自定义时返回 null，由后端 dynamic-adjuster._buildSystemPrompt() 提供默认值
  return null;
}

/**
 * 页面初始化时加载系统提示词状态
 */
function initSystemPromptEditor() {
  // 预加载到编辑器（但不显示）
  const editor = document.getElementById('systemPromptEditor');
  if (editor) {
    loadSystemPrompt();
  }
}

// ==================== 页面切换 ====================

function showPage(pageName) {
  // 更新导航
  document.querySelectorAll(".nav-item").forEach(item => {
    item.classList.toggle("active", item.dataset.page === pageName);
  });

  // 更新页面
  document.querySelectorAll(".page").forEach(page => {
    page.classList.toggle("active", page.id === `page-${pageName}`);
  });

  // 更新标题
  const titles = {
    dashboard: "总览",
    tts: "语音播报",
    ai: "AI 对话",
    aicontrol: "智能广播",
    music: "音乐播放",
    library: "音频库",
    schedules: "定时任务",
    history: "历史记录",
    settings: "系统设置",
    api: "API 文档",
  };
  document.getElementById("pageTitle").textContent = titles[pageName] || "";

  // 加载数据
  if (pageName === "dashboard") loadDashboard();
  if (pageName === "schedules") loadSchedules();
  if (pageName === "history") loadOperationHistory();
  if (pageName === "music") loadMusicStatus();
  if (pageName === "library") loadAudioLibrary();
  if (pageName === "aiplanner") loadAiPlanner();
}

// 导航点击事件
document.querySelectorAll(".nav-item").forEach(item => {
  item.addEventListener("click", (e) => {
    e.preventDefault();
    showPage(item.dataset.page);
  });
});

// ==================== 总览页面 ====================

async function loadDashboard() {
  try {
    // 设备信息
    const deviceRes = await api("/api/device");
    if (deviceRes.success) {
      document.getElementById("deviceCount").textContent = deviceRes.data.all.length;
      const current = deviceRes.data.current;
      document.getElementById("deviceName").textContent = current.name;
      document.getElementById("statusDot").classList.add("online");
    }

    // 任务数量
    const scheduleRes = await api("/api/schedules");
    if (scheduleRes.success) {
      document.getElementById("scheduleCount").textContent = scheduleRes.data.length;
    }

    // 对话记录
    const historyRes = await api("/api/history");
    if (historyRes.success) {
      document.getElementById("historyCount").textContent = historyRes.data.length;
    }
  } catch (error) {
    console.error("加载总览失败:", error);
  }
}

// ==================== TTS 页面 ====================

async function sendTTS() {
  const text = document.getElementById("ttsText").value.trim();
  if (!text) {
    showToast("请输入要播报的文字", "error");
    return;
  }

  try {
    const res = await api("/api/tts", {
      method: "POST",
      body: JSON.stringify({ text }),
    });

    if (res.success) {
      showToast("✅ 播报成功！");
      document.getElementById("ttsText").value = "";
    } else {
      showToast(res.error || "播报失败", "error");
    }
  } catch (error) {
    showToast("请求失败: " + error.message, "error");
  }
}

// ==================== 唤醒小爱音箱 ====================

async function wakeXiaoai() {
  try {
    showToast("👋 正在唤醒小爱...");
    const res = await api("/api/wake", { method: "POST" });
    
    if (res.success) {
      showToast("✅ 小爱已唤醒！");
    } else {
      showToast(res.error || "唤醒失败", "error");
    }
  } catch (error) {
    showToast("请求失败: " + error.message, "error");
  }
}

// ==================== 音乐播放页面 ====================

let isPlaying = false;

async function playMusic(keyword) {
  if (!keyword) {
    keyword = document.getElementById("musicSearch").value.trim();
  }

  if (!keyword) {
    showToast("请输入搜索关键词", "error");
    return;
  }

  showToast(`🔍 正在搜索: ${keyword}`);

  try {
    const res = await api("/api/music/play", {
      method: "POST",
      body: JSON.stringify({ keyword }),
    });

    if (res.success) {
      showToast(`🎵 正在播放: ${keyword}`);
      isPlaying = true;
      updatePlayPauseButton();
      document.getElementById("musicStatus").innerHTML = `<p class="success">🎵 正在播放: ${escapeHtml(keyword)}</p>`;
    } else {
      showToast(res.error || "播放失败", "error");
    }
  } catch (error) {
    showToast("请求失败: " + error.message, "error");
  }
}

async function togglePlay() {
  try {
    const endpoint = isPlaying ? "/api/music/pause" : "/api/music/play";
    const res = await api(endpoint, { method: "POST" });

    if (res.success) {
      isPlaying = !isPlaying;
      updatePlayPauseButton();
      showToast(isPlaying ? "▶️ 继续播放" : "⏸️ 已暂停");
    } else {
      showToast(res.error || "操作失败", "error");
    }
  } catch (error) {
    showToast("请求失败: " + error.message, "error");
  }
}

async function prevTrack() {
  try {
    const res = await api("/api/music/prev", { method: "POST" });

    if (res.success) {
      showToast("⏮️ 上一首");
    } else {
      showToast(res.error || "操作失败", "error");
    }
  } catch (error) {
    showToast("请求失败: " + error.message, "error");
  }
}

async function nextTrack() {
  try {
    const res = await api("/api/music/next", { method: "POST" });

    if (res.success) {
      showToast("⏭️ 下一首");
    } else {
      showToast(res.error || "操作失败", "error");
    }
  } catch (error) {
    showToast("请求失败: " + error.message, "error");
  }
}

function updatePlayPauseButton() {
  const btn = document.getElementById("playPauseBtn");
  if (btn) {
    btn.textContent = isPlaying ? "⏸️" : "▶️";
  }
}

async function loadMusicStatus() {
  try {
    const res = await api("/api/music/status");

    if (res.success && res.data) {
      const status = res.data;
      const statusText = status.is_playing ? "🎵 正在播放" : "⏸️ 已暂停";
      document.getElementById("musicStatus").innerHTML = `<p class="success">${statusText}</p>`;
      isPlaying = status.is_playing || false;
      updatePlayPauseButton();
    }
  } catch (error) {
    console.error("获取播放状态失败:", error);
  }
}

// ==================== 音频库管理 ====================

async function loadAudioLibrary() {
  try {
    const res = await api("/api/library");
    if (res.success && res.data.audios) {
      renderAudioList(res.data.audios);
    }
  } catch (error) {
    console.error("加载音频库失败:", error);
  }
}

function renderAudioList(audios) {
  const list = document.getElementById("audioList");

  if (!audios || audios.length === 0) {
    list.innerHTML = '<div class="empty-state">暂无音频，请添加音频文件</div>';
    return;
  }

  list.innerHTML = audios.map(audio => `
    <div class="audio-item">
      <div class="audio-info">
        <div class="audio-name">${escapeHtml(audio.name)}</div>
        <div class="audio-desc">${escapeHtml(audio.description || '无描述')}</div>
        <div class="audio-url">${escapeHtml(audio.url)}</div>
      </div>
      <div class="audio-actions">
        <button class="btn btn-primary btn-sm" onclick="playLibraryAudio('${audio.id}')">▶️ 播放</button>
        <button class="btn btn-danger btn-sm" onclick="deleteAudio('${audio.id}')">🗑️ 删除</button>
      </div>
    </div>
  `).join("");
}

async function addAudio() {
  const name = document.getElementById("audioName").value.trim();
  const url = document.getElementById("audioLibraryUrl").value.trim();
  const description = document.getElementById("audioDescription").value.trim();

  if (!name || !url) {
    showToast("请输入音频名称和 URL", "error");
    return;
  }

  try {
    const res = await api("/api/library", {
      method: "POST",
      body: JSON.stringify({ name, url, description })
    });

    if (res.success) {
      showToast("✅ 音频添加成功！");
      document.getElementById("audioName").value = "";
      document.getElementById("audioLibraryUrl").value = "";
      document.getElementById("audioDescription").value = "";
      loadAudioLibrary();
    } else {
      showToast(res.error || "添加失败", "error");
    }
  } catch (error) {
    showToast("请求失败: " + error.message, "error");
  }
}

async function playLibraryAudio(id) {
  try {
    showToast("🎵 正在播放...");
    const res = await api(`/api/library/${id}/play`, { method: "POST" });

    if (res.success) {
      showToast("✅ 播放成功！");
    } else {
      showToast(res.error || "播放失败", "error");
    }
  } catch (error) {
    showToast("请求失败: " + error.message, "error");
  }
}

async function deleteAudio(id) {
  if (!confirm("确定要删除这个音频吗？")) return;

  try {
    const res = await api(`/api/library/${id}`, { method: "DELETE" });

    if (res.success) {
      showToast("✅ 音频已删除");
      loadAudioLibrary();
    } else {
      showToast(res.error || "删除失败", "error");
    }
  } catch (error) {
    showToast("请求失败: " + error.message, "error");
  }
}

// ==================== 音频播放 ====================

async function playAudio() {
  const url = document.getElementById("audioUrl").value.trim();
  if (!url) {
    showToast("请输入音频 URL", "error");
    return;
  }

  if (!url.startsWith("http://") && !url.startsWith("https://")) {
    showToast("请输入有效的 URL", "error");
    return;
  }

  try {
    showToast("🎵 正在播放音频...");
    const res = await api("/api/audio/play", {
      method: "POST",
      body: JSON.stringify({ url }),
    });

    if (res.success) {
      showToast("✅ 音频播放成功！");
    } else {
      showToast(res.error || "播放失败", "error");
    }
  } catch (error) {
    showToast("请求失败: " + error.message, "error");
  }
}

// ==================== AI 智能控制 ====================

let isAIControlProcessing = false;

async function sendAIControl() {
  if (isAIControlProcessing) return;

  const input = document.getElementById("aiControlInput");
  const command = input.value.trim();
  if (!command) return;

  isAIControlProcessing = true;
  input.value = "";

  // 添加用户消息
  addAIControlMessage("user", command);

  // 添加加载状态
  const loadingId = addAIControlMessage("ai", "✨ 正在分析命令...", true);

  try {
    const res = await api("/api/ai/control", {
      method: "POST",
      body: JSON.stringify({ command }),
    });

    // 移除加载状态
    removeChatMessage(loadingId);

    if (res.success) {
      addAIControlMessage("ai", "✅ " + res.data.summary);
      
      // 如果创建了定时任务，提示查看
      if (res.data.action === "schedule") {
        addAIControlMessage("ai", "💡 定时任务已创建，可以在定时任务页面查看");
      }
    } else {
      addAIControlMessage("ai", "❌ " + (res.error || "处理失败"));
    }
  } catch (error) {
    removeChatMessage(loadingId);
    addAIControlMessage("ai", "❌ 请求失败: " + error.message);
  } finally {
    isAIControlProcessing = false;
  }
}

function addAIControlMessage(role, text, isLoading = false) {
  const container = document.getElementById("aiControlContainer");

  // 移除欢迎语
  const welcome = container.querySelector(".chat-welcome");
  if (welcome) welcome.remove();

  const id = Date.now().toString() + Math.random();
  const div = document.createElement("div");
  div.className = `chat-message ${role}`;
  div.id = id;
  div.innerHTML = `
    <div class="chat-avatar">${role === "user" ? "👤" : "✨"}</div>
    <div class="chat-bubble">${escapeHtml(text)}</div>
  `;

  container.appendChild(div);
  container.scrollTop = container.scrollHeight;

  return id;
}

// ==================== AI 对话页面 ====================

let isAIProcessing = false;

async function sendAI() {
  if (isAIProcessing) return;

  const input = document.getElementById("aiInput");
  const question = input.value.trim();
  if (!question) return;

  isAIProcessing = true;
  input.value = "";

  // 添加用户消息
  addChatMessage("user", question);

  // 添加加载状态
  const loadingId = addChatMessage("ai", "思考中...", true);

  try {
    const res = await api("/api/ai", {
      method: "POST",
      body: JSON.stringify({ question }),
    });

    // 移除加载状态
    removeChatMessage(loadingId);

    if (res.success) {
      addChatMessage("ai", res.data.answer);
    } else {
      addChatMessage("ai", "抱歉，" + (res.error || "处理失败"));
    }
  } catch (error) {
    removeChatMessage(loadingId);
    addChatMessage("ai", "抱歉，请求失败: " + error.message);
  } finally {
    isAIProcessing = false;
  }
}

function addChatMessage(role, text, isLoading = false) {
  const container = document.getElementById("chatContainer");

  // 移除欢迎语
  const welcome = container.querySelector(".chat-welcome");
  if (welcome) welcome.remove();

  const id = Date.now().toString();
  const div = document.createElement("div");
  div.className = `chat-message ${role}`;
  div.id = id;
  div.innerHTML = `
    <div class="chat-avatar">${role === "user" ? "👤" : "🤖"}</div>
    <div class="chat-bubble">${escapeHtml(text)}</div>
  `;

  container.appendChild(div);
  container.scrollTop = container.scrollHeight;

  return id;
}

function removeChatMessage(id) {
  const el = document.getElementById(id);
  if (el) el.remove();
}

async function loadHistory() {
  try {
    const res = await api("/api/history");
    if (res.success && res.data.length > 0) {
      const container = document.getElementById("chatContainer");
      container.innerHTML = "";

      res.data.forEach(msg => {
        addChatMessage(msg.role, msg.content);
      });
    }
  } catch (error) {
    console.error("加载历史失败:", error);
  }
}

function escapeHtml(text) {
  const div = document.createElement("div");
  div.textContent = text;
  return div.innerHTML;
}

// ==================== 定时任务页面 ====================

function onTaskTypeChange() {
  const taskType = document.getElementById("taskType").value;
  document.getElementById("textTaskField").classList.toggle("hidden", taskType !== "text");
  document.getElementById("commandTaskField").classList.toggle("hidden", taskType !== "command");
}

function onScheduleTypeChange() {
  const type = document.getElementById("scheduleType").value;
  document.getElementById("cronField").classList.toggle("hidden", type !== "cron");
  document.getElementById("intervalField").classList.toggle("hidden", type !== "interval");
  document.getElementById("atField").classList.toggle("hidden", type !== "once");
}

function showCronHelp() {
  alert(`Cron 表达式格式: 分 时 日 月 周

常用示例:
  0 8 * * *     = 每天早上8点
  0 9 * * 1-5   = 工作日早上9点
  0 */2 * * *   = 每2小时
  30 12 * * *   = 每天中午12:30
  0 22 * * *    = 每天晚上10点`);
}

async function addSchedule() {
  const taskType = document.getElementById("taskType").value;
  const type = document.getElementById("scheduleType").value;

  const body = { taskType, type };

  if (taskType === "command") {
    const command = document.getElementById("scheduleCommand").value.trim();
    if (!command) {
      showToast("请输入命令", "error");
      return;
    }
    body.command = command;
  } else {
    const text = document.getElementById("scheduleText").value.trim();
    if (!text) {
      showToast("请输入消息内容", "error");
      return;
    }
    body.text = text;
  }

  if (type === "cron") {
    body.cron = document.getElementById("scheduleCron").value;
  } else if (type === "interval") {
    body.interval = parseInt(document.getElementById("scheduleInterval").value);
  } else if (type === "once") {
    const at = document.getElementById("scheduleAt").value;
    if (!at) {
      showToast("请选择执行时间", "error");
      return;
    }
    body.at = at;
  }

  try {
    const res = await api("/api/schedules", {
      method: "POST",
      body: JSON.stringify(body),
    });

    if (res.success) {
      showToast("✅ 任务添加成功！");
      document.getElementById("scheduleText").value = "";
      loadSchedules();

      // 刷新服务器端调度器
      await api("/api/schedules/refresh", { method: "POST" });
    } else {
      showToast(res.error || "添加失败", "error");
    }
  } catch (error) {
    showToast("请求失败: " + error.message, "error");
  }
}

async function loadSchedules() {
  try {
    const res = await api("/api/schedules");
    const list = document.getElementById("scheduleList");

    if (!res.success || res.data.length === 0) {
      list.innerHTML = '<div class="empty-state">暂无任务</div>';
      return;
    }

    const scheduleItemsHTML = res.data.map(item => {
      let timeInfo = "";
      switch (item.type) {
        case "cron":
          timeInfo = `每天 ${item.cron}`;
          break;
        case "interval": {
          const hours = Math.floor(item.interval / 3600);
          const mins = Math.floor((item.interval % 3600) / 60);
          const parts = [];
          if (hours) parts.push(`${hours}小时`);
          if (mins) parts.push(`${mins}分钟`);
          timeInfo = `每 ${parts.join("") || item.interval + "秒"}`;
          break;
        }
        case "once":
          timeInfo = new Date(item.at).toLocaleString();
          break;
      }

      let displayContent = "";
      if (item.taskType === "command") {
        displayContent = `<span class="task-badge command">命令</span> ${escapeHtml(item.command)}`;
      } else {
        displayContent = `<span class="task-badge text">文本</span> ${escapeHtml(item.text)}`;
      }

      return `
          <div class="schedule-item" data-id="${item.id}">
            <input type="checkbox" class="schedule-checkbox" value="${item.id}" onchange="updateSelectedCount()">
            <div class="schedule-info">
              <div class="schedule-text">${displayContent}</div>
              <div class="schedule-meta">${timeInfo} · 执行 ${item.runCount || 0} 次</div>
            </div>
            <div class="schedule-actions">
              <button class="btn btn-danger btn-sm" onclick="deleteSchedule('${item.id}')">删除</button>
            </div>
          </div>
        `;
    }).join("");

    list.innerHTML = `
      <div class="batch-actions">
        <label class="select-all">
          <input type="checkbox" id="selectAllSchedules" onchange="toggleSelectAll()">
          <span>全选</span>
        </label>
        <button class="btn btn-danger btn-sm" id="batchDeleteBtn" onclick="batchDeleteSchedules()" style="display:none;">
          🗑️ 批量删除 (<span id="selectedCount">0</span>)
        </button>
      </div>
      ${scheduleItemsHTML}
    `;
  } catch (error) {
    console.error("加载任务失败:", error);
  }
}

function toggleSelectAll() {
  const selectAll = document.getElementById("selectAllSchedules");
  const checkboxes = document.querySelectorAll(".schedule-checkbox");
  checkboxes.forEach(cb => cb.checked = selectAll.checked);
  updateSelectedCount();
}

function updateSelectedCount() {
  const checkboxes = document.querySelectorAll(".schedule-checkbox:checked");
  const count = checkboxes.length;
  document.getElementById("selectedCount").textContent = count;

  const batchDeleteBtn = document.getElementById("batchDeleteBtn");
  if (batchDeleteBtn) {
    batchDeleteBtn.style.display = count > 0 ? "inline-flex" : "none";
  }

  const selectAll = document.getElementById("selectAllSchedules");
  const allCheckboxes = document.querySelectorAll(".schedule-checkbox");
  if (selectAll) {
    selectAll.checked = allCheckboxes.length > 0 && count === allCheckboxes.length;
  }
}

async function batchDeleteSchedules() {
  const checkboxes = document.querySelectorAll(".schedule-checkbox:checked");
  if (checkboxes.length === 0) {
    showToast("请先选择要删除的任务", "error");
    return;
  }

  const ids = Array.from(checkboxes).map(cb => cb.value);
  if (!confirm(`确定要删除选中的 ${ids.length} 个任务吗？`)) return;

  try {
    const res = await api("/api/schedules/batch", {
      method: "DELETE",
      body: JSON.stringify({ ids }),
    });

    if (res.success) {
      showToast(`✅ 已成功删除 ${res.data.deleted} 个任务`);
      loadSchedules();
    } else {
      showToast(res.error || "批量删除失败", "error");
    }
  } catch (error) {
    showToast("请求失败: " + error.message, "error");
  }
}

async function deleteSchedule(id) {
  if (!confirm("确定要删除这个任务吗？")) return;

  try {
    const res = await api(`/api/schedules/${id}`, {
      method: "DELETE",
    });

    if (res.success) {
      showToast("✅ 任务已删除");
      loadSchedules();
    } else {
      showToast(res.error || "删除失败", "error");
    }
  } catch (error) {
    showToast("请求失败: " + error.message, "error");
  }
}

// ==================== 设置页面 ====================

function saveSettings() {
  const settings = {
    apiKey: document.getElementById("apiKey").value,
    modelName: document.getElementById("modelName").value,
    apiBaseUrl: document.getElementById("apiBaseUrl").value,
    systemPrompt: document.getElementById("systemPrompt").value,
  };

  // 验证
  if (!settings.apiKey.trim()) {
    showToast("请输入 API 密钥", "error");
    return;
  }

  // 保存到本地存储
  localStorage.setItem("xiaoai-settings", JSON.stringify(settings));

  // 发送到服务器
  api("/api/settings", {
    method: "POST",
    body: JSON.stringify(settings),
  }).then(res => {
    if (res.success) {
      showToast("✅ 配置保存成功！", "success");
    } else {
      showToast(res.error || "保存失败", "error");
    }
  }).catch(() => {
    showToast("✅ 配置已保存到本地", "success");
  });
}

function loadSettings() {
  const saved = localStorage.getItem("xiaoai-settings");
  if (saved) {
    const settings = JSON.parse(saved);
    document.getElementById("apiKey").value = settings.apiKey || "";
    document.getElementById("modelName").value = settings.modelName || "gpt-4o-mini";
    document.getElementById("apiBaseUrl").value = settings.apiBaseUrl || "";
    document.getElementById("systemPrompt").value = settings.systemPrompt || "你是小爱音箱的智能助手，回答简洁有趣，适合语音播放，控制在100字以内。";
  }
}

// ==================== 全局功能 ====================

async function refreshData() {
  showToast("🔄 刷新中...");
  await loadDashboard();
  showToast("✅ 刷新完成", "success");
}

// ==================== 初始化 ====================

function init() {
  loadDashboard();
  loadSettings();

  // 初始化日期选择器（默认=明天）
  initPlanDatePicker();

  // 检查健康状态
  api("/api/health").then(res => {
    if (res.success) {
      document.getElementById("statusDot").classList.add("online");
      document.getElementById("deviceName").textContent = res.device;
    }
  });
}

init();

async function loadOperationHistory() {
  try {
    const res = await api("/api/history");
    const list = document.getElementById("historyList");

    if (!res.success || res.data.length === 0) {
      list.innerHTML = '<div class="empty-state">暂无历史记录</div>';
      return;
    }

    list.innerHTML = res.data.map(log => {
      const icon = getHistoryIcon(log.type);
      const typeName = getHistoryTypeName(log.type);
      const time = new Date(log.timestamp).toLocaleString();

      let content = "";
      if (log.type === "tts") {
        content = `<div class="history-text">${escapeHtml(log.text)}</div>`;
      } else if (log.type === "ai") {
        content = `
          <div class="history-text"><strong>问：</strong>${escapeHtml(log.question)}</div>
          <div class="history-text"><strong>答：</strong>${escapeHtml(log.answer)}</div>
        `;
      } else if (log.type === "schedule_run") {
        if (log.taskType === "command") {
          content = `
            <div class="history-text"><strong>命令：</strong>${escapeHtml(log.command)}</div>
            ${log.output ? `<div class="history-detail"><strong>输出：</strong>${escapeHtml(log.output.substring(0, 1000))}</div>` : ''}
            <div class="history-meta">
              <span>任务ID: ${log.scheduleId}</span>
            </div>
          `;
        } else {
          content = `
            <div class="history-text">${escapeHtml(log.text)}</div>
            <div class="history-meta">
              <span>类型: ${getScheduleTypeName(log.type)}</span>
              <span>${log.scheduleId}</span>
            </div>
          `;
        }
      } else if (log.type === "schedule_delete") {
        content = `
          <div class="history-text">${escapeHtml(log.text || log.command || '任务')}</div>
          <div class="history-meta">
            <span>已删除任务</span>
          </div>
        `;
      }

      return `
        <div class="history-item">
          <div class="history-icon ${log.type}">${icon}</div>
          <div class="history-content">
            <div class="history-type">${typeName}</div>
            ${content}
            <div class="history-meta">
              <span>${time}</span>
              <span class="history-status ${log.success === false ? 'failed' : 'success'}">
                ${log.success === false ? '❌ 失败' : '✅ 成功'}
              </span>
            </div>
          </div>
        </div>
      `;
    }).join("");
  } catch (error) {
    console.error("加载历史记录失败:", error);
  }
}

function getHistoryIcon(type) {
  const icons = {
    tts: "🎙️",
    ai: "🤖",
    schedule_run: "⏰",
    schedule_delete: "🗑️",
    wake: "👋"
  };
  return icons[type] || "📋";
}

function getHistoryTypeName(type) {
  const names = {
    tts: "语音播报",
    ai: "AI 对话",
    schedule_run: "定时任务执行",
    schedule_delete: "任务删除",
    wake: "唤醒小爱"
  };
  return names[type] || "其他操作";
}

function getScheduleTypeName(type) {
  if (type === "schedule_run") {
    return "定时任务";
  }
  return type;
}

async function clearHistory() {
  if (!confirm("确定要清空所有历史记录吗？")) return;

  try {
    const res = await api("/api/history", { method: "DELETE" });

    if (res.success) {
      showToast("✅ 历史记录已清空", "success");
      loadOperationHistory();
    } else {
      showToast(res.error || "清空失败", "error");
    }
  } catch (error) {
    showToast("请求失败: " + error.message, "error");
  }
}

// ==================== AI 每日规划 ====================

let currentGeneratedPlan = null;

async function loadAiPlanner() {
  await loadAiPlannerConfig();
  await loadPlannerHistory();
  await loadWeatherInfo(); // 新增：加载天气和节日信息
}

async function loadWeatherInfo() {
  try {
    // ✅ 从配置中读取城市，传递给天气 API
    const cityInput = document.getElementById("aiPlannerCity");
    const city = cityInput?.value?.trim() || "";
    const url = city ? `/api/weather-info?city=${encodeURIComponent(city)}` : "/api/weather-info";

    const res = await api(url);
    if (res.success && res.data) {
      displayWeatherInfo(res.data);
    }
  } catch (error) {
    console.error("加载天气信息失败:", error);
  }
}

function displayWeatherInfo(data) {
  // 找到配置区域添加显示信息
  const weatherCheckbox = document.getElementById("aiPlannerWeather");
  if (weatherCheckbox) {
    const formRow = weatherCheckbox.closest('.form-row');
    if (formRow && !formRow.querySelector('.weather-display')) {
      const displayDiv = document.createElement('div');
      displayDiv.className = 'weather-display';
      displayDiv.style.cssText = 'margin-top: 15px; padding: 15px; background: #f5f5f5; border-radius: 8px;';
      
      let eventsText = data.specialEvents.length > 0 ? data.specialEvents.join('、') : '无';
      
      displayDiv.innerHTML = `
        <h4 style="margin: 0 0 10px 0; color: #333;">📅 明日天气与节日</h4>
        <div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 10px;">
          <div>
            <strong>日期：</strong>${data.date} (${data.weekday})
          </div>
          <div>
            <strong>天气：</strong>${typeof data.weather === 'object' ? (data.weather?.weather || '') + ' ' + (data.weather?.temp || '') : data.weather}
          </div>
          <div>
            <strong>节日/事件：</strong>${eventsText}
          </div>
          <div>
            <strong>城市：</strong>${data.city}
          </div>
        </div>
        ${data.isWeekend ? '<div style="margin-top: 10px; padding: 8px; background: #e3f2fd; border-radius: 4px; color: #1976d2;">🎯 明天是周末！</div>' : ''}
      `;
      
      formRow.appendChild(displayDiv);
    }
  }
}

async function loadAiPlannerConfig() {
  try {
    const res = await api("/api/ai-planner/config");
    if (res.success) {
      const config = res.data;
      document.getElementById("aiPlannerEnabled").checked = config.enabled !== false;
      document.getElementById("aiPlannerCity").value = config.city || "";
      document.getElementById("aiPlannerTime").value = config.time || "22:00";
      document.getElementById("aiPlannerWeather").checked = config.weather !== false;
      document.getElementById("aiPlannerHoliday").checked = config.holiday !== false;
      document.getElementById("aiPlannerRoutine").checked = config.routine !== false;
      document.getElementById("aiPlannerPrompt").value = config.prompt || "";
    }
  } catch (error) {
    console.error("加载配置失败:", error);
  }
}

async function saveAiPlannerConfig() {
  // 读取当前系统提示词（来自编辑器或 localStorage），统一写入配置文件
  const currentSystemPrompt = getSystemPrompt();
  const config = {
    enabled: document.getElementById("aiPlannerEnabled").checked,
    city: document.getElementById("aiPlannerCity").value.trim(),
    time: document.getElementById("aiPlannerTime").value,
    weather: document.getElementById("aiPlannerWeather").checked,
    holiday: document.getElementById("aiPlannerHoliday").checked,
    routine: document.getElementById("aiPlannerRoutine").checked,
    prompt: document.getElementById("aiPlannerPrompt")?.value?.trim() || "",
    // 🔗 统一：将前端系统提示词也写入配置文件，供自动运行使用
    systemPrompt: currentSystemPrompt || ""
  };

  try {
    const res = await api("/api/ai-planner/config", {
      method: "POST",
      body: JSON.stringify(config),
    });

    if (res.success) {
      showToast("✅ 配置保存成功！", "success");
    } else {
      showToast(res.error || "保存失败", "error");
    }
  } catch (error) {
    showToast("请求失败: " + error.message, "error");
  }
}

// ==================== 日期范围选择 ====================

/**
 * 初始化日期范围选择器（默认：明天 ~ 明天）
 */
function initPlanDatePicker() {
  const startInput = document.getElementById("planDateStart");
  const endInput = document.getElementById("planDateEnd");
  if (!startInput || !endInput) return;

  // 默认都设为明天
  const tomorrow = new Date(Date.now() + 86400000);
  const tomorrowStr = tomorrow.toISOString().split("T")[0];
  startInput.value = tomorrowStr;
  endInput.value = tomorrowStr;

  // 结束日期不能早于开始日期
  startInput.addEventListener("change", () => {
    if (startInput.value && endInput.value && startInput.value > endInput.value) {
      endInput.value = startInput.value;
    }
    onPlanDateChange();
  });

  endInput.addEventListener("change", () => {
    if (startInput.value && endInput.value && endInput.value < startInput.value) {
      startInput.value = endInput.value;
    }
    onPlanDateChange();
  });

  onPlanDateChange();
}

/**
 * 获取选中的日期范围
 * @returns {{ start: string, end: string, days: number } | null}
 */
function getSelectedDateRange() {
  const start = document.getElementById("planDateStart")?.value;
  const end = document.getElementById("planDateEnd")?.value;
  if (!start || !end) return null;
  return { start, end, days: Math.ceil((new Date(end) - new Date(start)) / 86400000) + 1 };
}

/**
 * 日期范围变化时更新提示
 */
function onPlanDateChange() {
  const hint = document.getElementById("planDateHint");
  if (!hint) return;

  const range = getSelectedDateRange();
  if (!range) {
    hint.textContent = "";
    return;
  }

  const today = new Date().toISOString().split("T")[0];

  if (range.start === range.end) {
    // 单日
    if (range.start === today) {
      hint.textContent = "⚠️ 今天的计划仅包含当前时间之后的任务";
    } else {
      const weekday = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"][new Date(range.start).getDay()];
      hint.textContent = `📅 ${range.start} (${weekday}) 的计划`;
    }
  } else {
    // 多日
    hint.textContent = `📅 共 ${range.days} 天 (${range.start} ~ ${range.end})，将逐天生成计划`;
  }
}

/**
 * 从日期输入框读取范围并生成计划（支持多天）
 */
async function generateAiPlanFromInput() {
  const range = getSelectedDateRange();
  if (!range) {
    showToast("请先选择时间范围", "warning");
    return;
  }

  await generateAiPlan(range);
}

/**
 * 生成计划（支持单日/多日）
 * @param {{ start: string, end: string, days: number } | string} dateRange - 日期范围对象或单目标日期字符串
 */
async function generateAiPlan(dateRange = 'tomorrow') {
  const btn = document.getElementById("generatePlanBtn");
  btn.disabled = true;

  // 兼容旧格式：直接传字符串
  let targetDates;
  let dateLabel;
  if (typeof dateRange === 'string') {
    targetDates = [dateRange];
    dateLabel = dateRange === 'today' ? '今日' : '明日';
  } else {
    // 新格式：日期范围对象
    targetDates = [];
    const current = new Date(dateRange.start);
    const endDate = new Date(dateRange.end);
    while (current <= endDate) {
      const dStr = current.toISOString().split("T")[0];
      const today = new Date().toISOString().split("T")[0];
      targetDates.push(dStr === today ? 'today' : dStr);
      current.setDate(current.getDate() + 1);
    }
    dateLabel = `${dateRange.days}天`;
  }

  btn.textContent = `⏳ 正在生成${dateLabel}计划...`;

  try {
    // ✅ 获取当前系统提示词（可能是用户自定义的）
    const currentSystemPrompt = getSystemPrompt();
    const userPrompt = document.getElementById('aiPlannerPrompt')?.value?.trim() || '';

    console.log(`📝 [generateAiPlan] 系统提示词: ${currentSystemPrompt ? '自定义(' + currentSystemPrompt.length + '字)' : '后端默认值'}`);
    console.log(`📝 [generateAiPlan] 目标天数: ${targetDates.length}, 日期: ${targetDates.join(', ')}`);
    if (userPrompt) {
      console.log(`📝 [generateAiPlan] 用户额外提示: ${userPrompt.substring(0, 50)}...`);
    }

    // ✅ 逐天生成计划
    const allPlans = [];
    let totalTasks = 0;
    let totalProcessingTime = 0;
    let successCount = 0;

    for (let i = 0; i < targetDates.length; i++) {
      const td = targetDates[i];
      const dayLabel = td === 'today' ? '今日' : (td === 'tomorrow' ? '明日' : td);

      btn.textContent = `⏳ 正在生成${dateLabel}计划... (${i + 1}/${targetDates.length})`;

      // 根据目标日期动态构建命令文案
      let command;
      if (td === 'today') {
        command = "强制重新生成今天的任务计划（覆盖已有计划）";
      } else if (td === 'tomorrow') {
        command = "强制重新生成明天的任务计划（覆盖已有计划）";
      } else {
        command = `强制重新生成 ${dayLabel}(${td}) 的任务计划（覆盖已有计划）`;
      }

      try {
        const res = await api("/api/ai/control", {
          method: "POST",
          body: JSON.stringify({
            command: command,
            context: {
              source: "web",
              action: "force-regenerate-plan",
              systemPrompt: currentSystemPrompt,
              userPrompt: userPrompt,
              targetDate: td,
              dayOffset: i + 1  // ✅ 第几天（从1开始）
            }
          })
        });

        if (res.success) {
          const planData = res.data.data || res.data;
          planData._dayIndex = i + 1;
          planData._dayLabel = dayLabel;
          planData._dayDate = td;  // ✅ 强制使用请求日期，不依赖 AI 返回值
          allPlans.push(planData);
          totalTasks += (planData.tasks || []).length;
          totalProcessingTime += res.data.processingTime || 0;
          successCount++;
        } else {
          console.warn(`⚠️ 第${i + 1}天生成失败:`, res.error);
          allPlans.push({ _error: true, _errorMsg: res.error, _dayIndex: i + 1, _dayLabel: dayLabel, _dayDate: td, tasks: [] });
        }
      } catch (e) {
        console.error(`❌ 第${i + 1}天请求异常:`, e.message);
        allPlans.push({ _error: true, _errorMsg: e.message, _dayIndex: i + 1, _dayLabel: dayLabel, _dayDate: td, tasks: [] });
      }

      // 多天时稍作间隔，避免API限流
      if (i < targetDates.length - 1) {
        await new Promise(r => setTimeout(r, 500));
      }
    }

    // ✅ 保存生成的所有计划数据（供"应用到定时任务"使用）
    currentGeneratedPlan = { _multiDay: true, plans: allPlans };

    // 任务类型图标/标签映射
    const typeIcons = { routine: '🔄', goal_task: '🎯', reminder: '⏰', review: '📝' };
    const typeLabels = { routine: '日常', goal_task: '目标任务', reminder: '提醒', review: '复盘' };

    // 📋 构建多日预览HTML
    const daysPreviewHTML = allPlans.map((planData, idx) => {
      const tasks = planData.tasks || [];
      const taskCount = tasks.length;
      const hasError = planData._error;

      return `
        <div style="margin-bottom: 20px; ${idx < allPlans.length - 1 ? 'padding-bottom: 16px; border-bottom: 1px dashed #ddd;' : ''}">
          <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 10px;">
            <strong>📅 Day ${planData._dayIndex}: ${planData._dayLabel} (${planData._dayDate})</strong>
            <span style="font-size: 12px; color: ${hasError ? '#f59e0b' : '#22c55e'};">
              ${hasError ? `❌ ${planData._errorMsg || '生成失败'}` : `✅ ${taskCount} 个任务`}
            </span>
          </div>
          ${hasError ? '<p style="color: #999; font-size: 13px;">该日计划生成失败，已跳过</p>' :
            taskCount === 0 ? '<p style="color: #999; font-size: 13px;">暂无任务数据</p>' :
            `<div class="task-list" style="display: grid; grid-template-columns: repeat(auto-fill, minmax(240px, 1fr)); gap: 8px;">
              ${tasks.map(task => `
                <div class="task-card ${task.type || 'routine'}" style="margin: 0;">
                  <div class="task-card-header">
                    <div class="task-time">${task.time || '--:--'}</div>
                    <span class="task-type-badge ${task.type || 'routine'}">
                      ${typeIcons[task.type] || '📌'} ${typeLabels[task.type] || '其他'}
                    </span>
                  </div>
                  <div class="task-title">${escapeHtml(task.title || '未命名任务')}</div>
                  ${task.content ? `<p class="task-content">${escapeHtml(task.content)}</p>` : ''}
                </div>
              `).join('')}
            </div>`
          }
        </div>
      `;
    }).join('');

    // 显示完整的计划预览界面
    document.getElementById("planSummary").innerHTML = `
      <div class="plan-preview-container">
        <!-- 头部信息栏 -->
        <div class="plan-preview-header">
          <div>
            <div class="plan-preview-title">📋 ${dateLabel}计划预览</div>
          </div>
          <div style="display: flex; gap: 12px; align-items: center;">
            <div class="plan-preview-date">${allPlans[0]?._dayDate || '-'} ~ ${allPlans[allPlans.length - 1]?._dayDate || '-'}</div>
            <div class="plan-preview-stats">
              <span class="stat-item">📆 ${successCount}/${targetDates.length} 天成功</span>
              <span class="stat-item">📝 ${totalTasks} 个任务</span>
              <span class="stat-item">⏱️ ${(totalProcessingTime / 1000).toFixed(1)}s</span>
            </div>
          </div>
        </div>

        <!-- 多日任务列表 -->
        ${daysPreviewHTML}

        <!-- 底部信息 -->
        <div class="plan-footer">
          <div style="display: flex; gap: 16px;">
            <span>🤖 共 ${targetDates.length} 天</span>
            <span style="color: ${successCount === targetDates.length ? '#22c55e' : '#f59e0b'};">
              ${successCount === targetDates.length ? '✅ 全部生成成功' : `⚠️ ${targetDates.length - successCount} 天失败`}
            </span>
          </div>
          <div>生成时间: ${new Date().toLocaleTimeString()}</div>
        </div>
      </div>

      <!-- 操作提示 -->
      <p style="color: #4CAF50; margin-top: 16px; text-align: center; font-weight: 500;">
        ✅ 预览完成！共 ${totalTasks} 个任务 · 点击「应用到定时任务」添加到定时列表
      </p>
    `;

      // 显示结果区域
      document.getElementById("planResult").style.display = "block";

      if (targetDates.length === 1) {
        showToast(`✅ 计划生成成功！共 ${totalTasks} 个任务，点击「应用」添加定时任务`, "success");
      } else {
        showToast(`✅ ${dateLabel}计划生成完成！${successCount}/${targetDates.length} 天成功 · 共 ${totalTasks} 个任务`, "success");
      }
  } catch (error) {
    showToast("请求失败: " + error.message, "error");
  } finally {
    btn.disabled = false;
    btn.textContent = `✨ 生成${dateLabel}计划`;
  }
}

function renderPlanResult(data) {
  // 摘要
  document.getElementById("planSummary").innerHTML = `
    <p><strong>目标日期：</strong>${data.targetDate}</p>
    <p><strong>生成时间：</strong>${new Date(data.generatedAt).toLocaleString()}</p>
    ${data.weather ? `<p><strong>天气：</strong>${escapeHtml(data.weather)}</p>` : ''}
    ${data.holiday ? `<p><strong>节日：</strong>${escapeHtml(data.holiday)}</p>` : ''}
  `;

  // 通知列表
  const notifications = data.notifications || [];
  document.getElementById("planNotifications").innerHTML = notifications.length === 0 ? 
    '<p class="empty-state">暂无通知</p>' :
    notifications.map((n, i) => `
      <div class="schedule-item">
        <div class="schedule-info">
          <div class="schedule-text">${n.time} · ${escapeHtml(n.content)}</div>
        </div>
      </div>
    `).join('');

  // 建议
  const suggestions = data.suggestions || [];
  document.getElementById("planSuggestions").innerHTML = suggestions.length > 0 ? `
    <h4>💡 建议</h4>
    <ul>
      ${suggestions.map(s => `<li>${escapeHtml(s)}</li>`).join('')}
    </ul>
  ` : '';
}

async function applyAiPlan() {
  if (!currentGeneratedPlan) {
    showToast("请先生成计划", "error");
    return;
  }

  try {
    // ✅ 多日计划格式
    if (currentGeneratedPlan._multiDay && currentGeneratedPlan.plans) {
      const plans = currentGeneratedPlan.plans.filter(p => !p._error);
      let totalSuccess = 0;
      let totalTasks = 0;

      for (const planData of plans) {
        const tasks = planData.tasks || [];
        totalTasks += tasks.length;
        const planDate = planData.date || planData._dayDate || new Date().toISOString().split('T')[0];

        for (const task of tasks) {
          if (!task.time || !task.content) continue;
          try {
            const res = await api("/api/schedules", {
              method: "POST",
              body: JSON.stringify({
                text: task.content,
                type: "once",
                at: `${planDate}T${task.time}:00`,
                taskType: "text",
                enabled: true
              })
            });
            if (res.success) totalSuccess++;
          } catch (e) {
            console.error(`创建任务失败 (${planDate} ${task.time}):`, e.message);
          }
        }
      }

      if (totalSuccess > 0) {
        showToast(`✅ 已成功添加 ${totalSuccess}/${totalTasks} 个定时任务（${plans.length} 天）！`, "success");
        currentGeneratedPlan = null;
      } else {
        showToast("⚠️ 没有成功创建任何任务", "warning");
      }

    // ✅ 单日计划格式（兼容旧版）
    } else if (currentGeneratedPlan.tasks && Array.isArray(currentGeneratedPlan.tasks)) {
      // 直接从 DailyPlan 中提取任务并创建定时任务
      const tasks = currentGeneratedPlan.tasks;
      let successCount = 0;
      
      for (const task of tasks) {
        if (!task.time || !task.content) continue;

        try {
          const [hour, minute] = task.time.split(':');

          // ✅ 获取计划日期（优先使用计划数据中的日期）
          const planDate = currentGeneratedPlan.date ||
            new Date().toISOString().split('T')[0];  // ✅ 默认使用今天

          const scheduleData = {
            text: task.content,
            type: "once",             // ✅ 修复：只执行一次（不是每天重复）
            at: `${planDate}T${task.time}:00`,  // ✅ 具体时间：2026-06-01T09:00:00
            taskType: "text",
            enabled: true
          };
          
          const res = await api("/api/schedules", {
            method: "POST",
            body: JSON.stringify(scheduleData)
          });
          
          if (res.success) {
            successCount++;
          }
        } catch (e) {
          console.error(`创建任务失败 (${task.time}):`, e.message);
        }
      }
      
      if (successCount > 0) {
        showToast(`✅ 已成功添加 ${successCount}/${tasks.length} 个定时任务！`, "success");
        currentGeneratedPlan = null;  // 清空防止重复应用
      } else {
        showToast("⚠️ 没有成功创建任何任务", "warning");
      }
      
    } else {
      // 兼容旧版数据格式
      const res = await api("/api/ai-planner/apply", {
        method: "POST",
        body: JSON.stringify({ plan: currentGeneratedPlan }),
      });

      if (res.success) {
        showToast(`✅ 已添加 ${res.data.count} 个定时任务！`, "success");
        currentGeneratedPlan = null;  // 清空防止重复应用
      } else {
        showToast(res.error || "应用失败", "error");
      }
    }
  } catch (error) {
    showToast("请求失败: " + error.message, "error");
  }
}

async function loadPlannerHistory() {
  try {
    const res = await api("/api/ai-planner/history");
    if (res.success) {
      renderPlannerHistory(res.data);
    }
  } catch (error) {
    console.error("加载历史失败:", error);
  }
}

function renderPlannerHistory(history) {
  const container = document.getElementById("plannerHistory");

  if (!history || history.length === 0) {
    container.innerHTML = '<div class="empty-state">暂无记录</div>';
    return;
  }

  container.innerHTML = history.map((item, index) => `
    <div class="history-item" style="cursor: pointer;" onclick="applyHistoryPlan(${index})">
      <div class="history-icon">📅</div>
      <div class="history-content">
        <div class="history-type">AI 计划 · ${item.targetDate}</div>
        <div class="history-text">${(item.notifications || []).length} 个通知任务</div>
        <div class="history-meta">
          <span>${new Date(item.generatedAt).toLocaleString()}</span>
        </div>
      </div>
    </div>
  `).join('');

  // 保存到全局，方便点击应用
  window.plannerHistoryData = history;
}

function applyHistoryPlan(index) {
  if (window.plannerHistoryData && window.plannerHistoryData[index]) {
    currentGeneratedPlan = window.plannerHistoryData[index];
    renderPlanResult(currentGeneratedPlan);
    document.getElementById("planResult").style.display = "block";
    showToast("已加载历史计划，可点击「应用」按钮添加任务", "info");
  }
}
