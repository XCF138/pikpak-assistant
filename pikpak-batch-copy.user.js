// ==UserScript==
// @name         PikPak 批量复制助手
// @namespace    workbuddy.pikpak.batchcopy
// @version      1.8.2
// @description  PikPak 网页工作台（蓝白工作台风格）：① 批量复制/移动文件到多个文件夹（含全选/反选、按路径自动创建）；② 文件整理（移到回收站、批量解压、文件查重去重）；③ 导出文件夹目录树（TXT / PNG 图片）；④ 批量重命名（按括号 / 关键字 / 位置删除，可加序号，预览确认后执行）。悬浮窗可拖动、可缩放。直接使用网页登录状态，无需配置账号密码。
// @author       WorkBuddy
// @match        https://mypikpak.com/*
// @match        https://www.mypikpak.com/*
// @match        https://mypikpak.net/*
// @match        https://www.mypikpak.net/*
// @match        https://pikpak.me/*
// @match        https://www.pikpak.me/*
// @run-at       document-idle
// @grant        none
// @noframes
// @license      MIT
// ==/UserScript==

/*
 * 使用方法：
 * 1. 安装 Tampermonkey 浏览器扩展，新建脚本，粘贴本文件全部内容并保存
 * 2. 打开 https://mypikpak.com/ 并登录
 * 3. 页面右下角会出现「批量复制」悬浮球，点击打开助手面板
 *    - 面板顶部有三个标签：「📋 批量复制」「🌳 导出目录树」「✏️ 批量重命名」
 * 4. 批量复制模式下：
 *    - 第 1 步浏览并勾选要复制的文件（一般选 1 个）
 *    - 第 2 步勾选多个目标文件夹（支持「全选」「反选」），或切到「按路径输入」每行写一个路径（不存在会自动创建）
 *    - 第 3 步点击「开始复制」，逐个目标执行，实时显示结果
 * 5. 导出目录树模式下：
 *    - 先选择「扫描深度」（默认仅当前层，瞬间出结果）和「导出格式」（TXT / PNG 图片）
 *    - 浏览文件夹（点击进入子文件夹），找到要导出的大文件夹
 *    - 勾选文件夹后点底部「导出选中目录树」，或点击行内「导出」按钮单独导出
 *    - 扫描过程中可随时点「停止扫描」取消
 *    - 生成的内容只含文件夹名，不含文件名；PNG 用画布绘制，适合直接发图
 * 6. 批量重命名模式下：
 *    - 用「类型」下拉选择列表只显示文件夹、只显示文件或全部（勾选也只作用于对应类型）
 *    - 浏览并勾选要重命名的项目（支持全选/反选）
 *    - 规则类型三选一：
 *      a) 按括号处理：选处理哪种括号（圆/方/两者，含全角），仅删除括号内内容（保留括号）
 *         还是连括号一起删除
 *      b) 按关键字处理：输入要删除的文字（如 123，多个用 | 分隔），
 *         名字里所有出现的关键字都会被删除；「替换为」可填替代文字（留空即删除）
 *      c) 按位置处理：输入定位字，删除它「之前」或「之后」的部分，
 *         或删除两个字「之间」的部分（可选连同定位字一起删、匹配第一个/最后一个）
 *    - 「重命名后加序号」：按勾选顺序给名字加 1. 2. 3. 前缀，
 *      样式可选 1. / 01. / (1) / 【1】 / 1-，可设起始序号
 *    - 点「预览」查看每个项目重命名后的名字（无变化/为空的会标注并跳过）
 *    - 确认无误后点「确认执行重命名」，逐个执行并显示成功/失败
 * 7. 悬浮窗：按住面板顶部标题栏可拖动位置（双击复位），右下角 ↘ 手柄可缩放窗口，
 *    位置和大小会自动记住，下次打开保持不变
 *
 * 原理：复用网页登录态（localStorage 中的 access_token / captcha_token / deviceid），
 * 直接调用 PikPak 官方接口 POST /drive/v1/files:batchCopy 完成复制。
 */

(function () {
  'use strict';

  /* ================================================================
   * 常量
   * ================================================================ */
  const API_DRIVE = 'https://api-drive.mypikpak.com';
  const API_USER = 'https://user.mypikpak.com';

  // Web 客户端参数（用于 access_token 自动续期）
  const CLIENT_ID = 'YUMx5nI8ZU8Ap8pm';
  const CLIENT_SECRET = 'dbw2OtmVEeuUvIptb1Coyg';

  const COPY_INTERVAL_MS = 400; // 两次复制之间的间隔（毫秒），防止触发风控
  const MAX_LIST_ITEMS = 500;   // 文件列表最多渲染条数

  /* ================================================================
   * 小工具
   * ================================================================ */
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  function fmtSize(n) {
    n = Number(n) || 0;
    if (n < 1024) return n + ' B';
    const units = ['KB', 'MB', 'GB', 'TB'];
    let i = -1;
    do { n /= 1024; i++; } while (n >= 1024 && i < units.length - 1);
    return (n >= 100 ? Math.round(n) : n.toFixed(1)) + ' ' + units[i];
  }

  function fmtTime(t) {
    if (!t) return '';
    const d = new Date(t);
    if (isNaN(d.getTime())) return '';
    const p = (x) => String(x).padStart(2, '0');
    return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
  }

  /* ================================================================
   * 凭证读取与 API 请求
   * ================================================================ */
  let tokenOverride = null;    // 主动刷新后的登录凭证（localStorage 里的是旧的失效凭证时使用）
  let captchaOverride = '';    // 主动刷新后的验证令牌
  let pkCaptchaTemplate = null; // 从网页 fetch 中捕获的 captcha init 模板
  let pkCapturedCaptcha = null; // 从网页 drive API 请求头中捕获的 captcha token

  // Hook 网页的 fetch，捕获 PikPak 自己生成的 captcha init 请求模板和当前使用的 captcha token
  function installFetchHook() {
    try {
      const originalFetch = window.fetch;
      if (!originalFetch || originalFetch.__pp_hooked) return;
      window.fetch = async function(input, init) {
        let url = '';
        try { url = input instanceof Request ? input.url : String(input); } catch (e) { url = String(input); }

        // 1. 保存 /v1/shield/captcha/init 请求模板（含正确的 captcha_sign，由网页自己生成）
        if (url.includes('/v1/shield/captcha/init')) {
          try {
            const method = String((init && init.method) || (input instanceof Request && input.method) || 'GET').toUpperCase();
            if (method === 'POST') {
              let body = init && init.body;
              if (body == null && input instanceof Request) body = await input.clone().text();
              if (body && typeof body !== 'string') body = JSON.stringify(body);
              if (body) {
                const payload = JSON.parse(body);
                if (payload && payload.action && payload.meta && typeof payload.meta.captcha_sign === 'string') {
                  const templatePayload = JSON.parse(JSON.stringify(payload));
                  delete templatePayload.captcha_token;
                  const sourceHeaders = (init && init.headers) || (input instanceof Request && input.headers);
                  const headers = Object.fromEntries(new Headers(sourceHeaders).entries());
                  pkCaptchaTemplate = { url: url, headers: headers, payload: templatePayload, capturedAt: Date.now() };
                  try { localStorage.setItem('pp_batch_copy_captcha_template', JSON.stringify(pkCaptchaTemplate)); } catch (e) {}
                }
              }
            }
          } catch (e) {}
        }

        // 2. 捕获 drive API 请求头里正在使用的 x-captcha-token
        try {
          if (url.includes('api-drive.mypikpak.com') && url.includes('/drive/')) {
            const sourceHeaders = (init && init.headers) || (input instanceof Request && input.headers);
            const h = new Headers(sourceHeaders);
            const cap = h.get('x-captcha-token') || h.get('X-Captcha-Token');
            if (cap && cap.length > 20) {
              pkCapturedCaptcha = { token: cap, at: Date.now() };
              try { localStorage.setItem('pp_batch_copy_captcha_token', JSON.stringify(pkCapturedCaptcha)); } catch (e) {}
            }
          }
        } catch (e) {}

        return originalFetch.apply(this, arguments);
      };
      window.fetch.__pp_hooked = true;
    } catch (e) {}
  }

  function jwtSub(token) {
    try {
      const parts = String(token).split('.');
      if (parts.length !== 3) return '';
      let payload = parts[1].replace(/-/g, '+').replace(/_/g, '/');
      while (payload.length % 4) payload += '=';
      const json = JSON.parse(decodeURIComponent(escape(atob(payload))));
      return String(json.sub || json.user_id || '');
    } catch (e) {
      return '';
    }
  }

  function readDriveCaptchaToken() {
    // 优先使用我们刚刚从网页请求头捕获的 token（10 分钟内有效）
    try {
      const raw = localStorage.getItem('pp_batch_copy_captcha_token');
      if (raw) {
        const v = JSON.parse(raw);
        if (v && v.token && Date.now() - (v.at || 0) < 10 * 60 * 1000) return v.token;
      }
    } catch (e) {}
    // 兼容「PikPak 增强大师」脚本保存的 token
    try {
      const raw = localStorage.getItem('pk_captured_captcha');
      if (raw) {
        const v = JSON.parse(raw);
        if (v && v.captcha_token) return v.captcha_token;
      }
    } catch (e) {}
    return '';
  }

  function readCredentials() {
    try {
      const ls = window.localStorage;
      let cred = null;
      let captcha = null;
      let deviceId = '';
      for (let i = 0; i < ls.length; i++) {
        const key = ls.key(i);
        if (!key) continue;
        if (key.indexOf('credentials') === 0) {
          try {
            const v = JSON.parse(ls.getItem(key));
            if (v && v.access_token) cred = v;
          } catch (e) { /* 忽略损坏的项 */ }
        } else if (key.indexOf('captcha') === 0) {
          try {
            const v = JSON.parse(ls.getItem(key));
            if (v && typeof v.token === 'string') captcha = v;
          } catch (e) { /* 忽略 */ }
        } else if (key === 'deviceid') {
          const v = ls.getItem(key);
          if (typeof v === 'string' && v) deviceId = v;
        }
      }
      if (!cred) return null;
      const userId = cred.user_id || cred.userId || jwtSub(cred.access_token) || '';
      return {
        accessToken: (tokenOverride && tokenOverride.accessToken) || cred.access_token,
        refreshToken: (tokenOverride && tokenOverride.refreshToken) || cred.refresh_token || '',
        tokenType: (tokenOverride && tokenOverride.tokenType) || cred.token_type || 'Bearer',
        captchaToken: captchaOverride || readDriveCaptchaToken() || (captcha ? captcha.token : ''),
        deviceId: deviceId,
        userId: userId,
      };
    } catch (e) {
      return null;
    }
  }

  // 刷新登录凭证（access token 过期时）
  async function refreshAccessToken(refreshToken) {
    let resp;
    try {
      resp = await fetch(API_USER + '/v1/auth/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          client_id: CLIENT_ID,
          client_secret: CLIENT_SECRET,
          refresh_token: refreshToken,
          grant_type: 'refresh_token',
        }),
      });
    } catch (e) {
      throw new Error('刷新登录凭证的网络请求失败');
    }
    const data = await resp.json().catch(() => ({}));
    if (!data.access_token) {
      throw new Error('登录凭证已过期且自动刷新失败，请刷新网页后重试');
    }
    return {
      accessToken: data.access_token,
      refreshToken: data.refresh_token || refreshToken,
      tokenType: data.token_type || 'Bearer',
    };
  }

  // 用网页自己生成的 captcha init 模板重放请求，换取新的验证令牌
  async function refreshCaptchaToken(method, path, cred) {
    const action = method + ':' + String(path).split('?')[0];

    // 尝试从内存或 localStorage 读取模板
    let template = pkCaptchaTemplate;
    if (!template) {
      try {
        const raw = localStorage.getItem('pp_batch_copy_captcha_template');
        if (raw) template = JSON.parse(raw);
      } catch (e) {}
    }

    if (template && template.url && template.payload) {
      try {
        const payload = JSON.parse(JSON.stringify(template.payload));
        payload.action = action;
        delete payload.captcha_token;
        const headers = Object.assign({}, template.headers, {
          'Authorization': (cred.tokenType || 'Bearer') + ' ' + cred.accessToken,
          'x-device-id': cred.deviceId,
        });
        const resp = await fetch(template.url, {
          method: 'POST',
          headers: headers,
          body: JSON.stringify(payload),
          credentials: 'same-origin',
          cache: 'no-store',
        });
        const data = await resp.json().catch(() => ({}));
        const token = data.captcha_token || (data.data && data.data.captcha_token);
        if (token && String(token).length > 20) {
          pkCapturedCaptcha = { token: token, at: Date.now() };
          try { localStorage.setItem('pp_batch_copy_captcha_token', JSON.stringify(pkCapturedCaptcha)); } catch (e) {}
          return token;
        }
      } catch (e) {}
    }

    throw new Error('无法自动刷新验证令牌。请在 PikPak 网页里随便点一个文件夹浏览一下，让网页重新生成验证令牌，再打开本助手。');
  }

  /**
   * 统一 API 请求：自动携带凭证；验证令牌 / 登录凭证失效时自动续签并重试一次
   * @param {string} method
   * @param {string} path   形如 /drive/v1/files?xxx
   * @param {object|undefined} body
   * @param {object} opts   { _retriedCaptcha, _retriedToken, baseUrl }
   */
  async function apiRequest(method, path, body, opts) {
    opts = opts || {};
    const cred = readCredentials();
    if (!cred) {
      throw new Error('未检测到登录凭证：请先在网页上登录 PikPak，再打开本助手');
    }

    const headers = {
      'Content-Type': 'application/json',
      'Authorization': (cred.tokenType || 'Bearer') + ' ' + cred.accessToken,
      'x-device-id': cred.deviceId,
    };
    if (cred.captchaToken) headers['x-captcha-token'] = cred.captchaToken;

    const url = (opts.baseUrl || API_DRIVE) + path;
    let resp;
    try {
      resp = await fetch(url, {
        method: method,
        headers: headers,
        body: body !== undefined ? JSON.stringify(body) : undefined,
      });
    } catch (e) {
      throw new Error('网络请求失败（可能被浏览器或网络策略拦截），请检查网络后重试');
    }

    let data = {};
    try { data = await resp.json(); } catch (e) { /* 空响应体 */ }

    const errCode = data.error_code;
    const errMsg = String(data.error || '').toLowerCase();
    const ok = resp.ok && (errCode === 0 || errCode === undefined || errCode === null);
    if (ok) return data;

    // captcha 失效（error_code 9 或 error: captcha_invalid）→ 用网页模板重放刷新后重试一次
    if ((errCode === 9 || errMsg === 'captcha_invalid') && !opts._retriedCaptcha) {
      const newToken = await refreshCaptchaToken(method, path, cred);
      captchaOverride = newToken;
      return apiRequest(method, path, body, Object.assign({}, opts, { _retriedCaptcha: true }));
    }
    // 登录凭证失效 → 用 refresh_token 换新后重试一次
    if ((errCode === 16 || errCode === 4121 || errCode === 4122) && !opts._retriedToken) {
      if (cred.refreshToken) {
        tokenOverride = await refreshAccessToken(cred.refreshToken);
        return apiRequest(method, path, body, Object.assign({}, opts, { _retriedToken: true }));
      }
      throw new Error('登录凭证已过期，请刷新网页后重试');
    }
    if (errCode === 10) {
      throw new Error('操作过于频繁，请稍等片刻再继续');
    }
    throw new Error(data.error_description || data.error || ('请求失败（HTTP ' + resp.status + '）'));
  }

  /* ================================================================
   * PikPak 网盘操作封装
   * ================================================================ */

  // 列出某文件夹内容（自动翻页，拆分文件夹 / 文件并按名称排序）
  async function listFiles(parentId) {
    const all = [];
    let pageToken = '';
    let first = true;
    while (first || pageToken) {
      first = false;
      const params = new URLSearchParams({
        parent_id: parentId,
        with_audit: 'true',
        thumbnail_size: 'SIZE_LARGE',
        limit: '100',
        filters: '{"phase":{"eq":"PHASE_TYPE_COMPLETE"},"trashed":{"eq":false}}',
      });
      if (pageToken) params.set('page_token', pageToken);
      const resp = await apiRequest('GET', '/drive/v1/files?' + params.toString());
      const files = resp.files || [];
      all.push.apply(all, files);
      pageToken = resp.next_page_token || '';
      if (all.length > 5000) break; // 防御性上限
    }
    const folders = all.filter((f) => f.kind === 'drive#folder');
    const files = all.filter((f) => f.kind !== 'drive#folder');
    const byName = (a, b) => String(a.name || '').localeCompare(String(b.name || ''), 'zh-CN');
    folders.sort(byName);
    files.sort(byName);
    return { folders: folders, files: files, total: all.length };
  }

  // 获取文件/文件夹详情
  async function getFileInfo(id) {
    return apiRequest('GET', '/drive/v1/files/' + encodeURIComponent(id));
  }

  // 创建文件夹，返回 {id, name}
  async function createFolder(parentId, name) {
    const resp = await apiRequest('POST', '/drive/v1/files', {
      kind: 'drive#folder',
      name: name,
      parent_id: parentId,
    });
    const id = (resp.file && resp.file.id) || resp.id;
    if (!id) throw new Error('创建文件夹「' + name + '」失败');
    return { id: id, name: (resp.file && resp.file.name) || name };
  }

  // 批量复制文件到目标文件夹
  async function copyToFolder(fileIds, destFolderId) {
    return apiRequest('POST', '/drive/v1/files:batchCopy', {
      ids: fileIds,
      to: { parent_id: destFolderId },
    });
  }

  // 批量移动文件/文件夹到目标文件夹
  async function moveToFolder(ids, destFolderId) {
    return apiRequest('POST', '/drive/v1/files:batchMove', {
      ids: ids,
      to: { parent_id: destFolderId },
    });
  }

  // 批量移到回收站（安全，可恢复）
  async function trashItems(ids) {
    return apiRequest('POST', '/drive/v1/files:batchTrash', { ids: ids });
  }

  // 云端解压压缩包（zip/rar/7z 等），解压到压缩包所在目录
  async function decompressFile(file) {
    // 压缩包解压需要 gcid（或 hash/md5 兜底）
    const gcid = file.gcid || file.hash || file.md5_checksum || '';
    return apiRequest('POST', '/decompress/v1/decompress', {
      file_id: file.id,
      files: [],
      password: '',
      default_parent: true,
      gcid: gcid,
    });
  }

  // 重命名文件/文件夹：优先 POST /files/{id}/rename，失败则回退 PATCH /files/{id}
  async function renameItem(id, newName) {
    try {
      return await apiRequest('POST', '/drive/v1/files/' + encodeURIComponent(id) + '/rename', { name: newName });
    } catch (e) {
      return await apiRequest('PATCH', '/drive/v1/files/' + encodeURIComponent(id), { name: newName });
    }
  }

  // 逐级查找/创建路径（类似 mkdir -p），返回最深一级文件夹 id
  async function ensureFolderPath(parts, startId) {
    let parentId = startId;
    for (const part of parts) {
      const data = await listFiles(parentId);
      const found = data.folders.find((f) => f.name === part);
      if (found) {
        parentId = found.id;
      } else {
        const created = await createFolder(parentId, part);
        parentId = created.id;
      }
    }
    return parentId;
  }

  /* ================================================================
   * 文件夹目录树导出
   * ================================================================ */
  const TREE_MAX_DEPTH = 8;      // 递归最大深度
  const TREE_MAX_FOLDERS = 5000; // 最多收集的文件夹数（防止超大目录爆 API）

  // 递归收集子文件夹，构建树形文本行
  async function buildTreeLines(folderId, prefix, depth, maxDepth, count, statusFn) {
    if (state.treeExportStopping) return [];
    if (depth >= maxDepth || depth >= TREE_MAX_DEPTH) return [];
    if (count.total >= TREE_MAX_FOLDERS) return [];
    const data = await listFiles(folderId);
    const folders = data.folders;
    if (!folders || folders.length === 0) return [];

    const lines = [];
    for (let i = 0; i < folders.length; i++) {
      if (state.treeExportStopping) break;
      if (count.total >= TREE_MAX_FOLDERS) break;
      const f = folders[i];
      const isLast = i === folders.length - 1;
      const connector = isLast ? '└── ' : '├── ';
      lines.push(prefix + connector + f.name + '/');
      count.total++;
      if (statusFn) statusFn(count.total, depth);

      const childPrefix = prefix + (isLast ? '    ' : '│   ');
      const childLines = await buildTreeLines(f.id, childPrefix, depth + 1, maxDepth, count, statusFn);
      lines.push.apply(lines, childLines);
    }
    return lines;
  }

  // 导出某文件夹的子目录树为 TXT 文件
  async function exportFolderTree(folderId, folderName) {
    const overlay = ui.exportOverlay;
    const statusEl = ui.exportStatus;
    state.treeExportStopping = false;
    ui.stopScan.classList.remove('hidden');
    overlay.classList.remove('hidden');
    statusEl.textContent = '正在扫描文件夹…';

    const maxDepth = state.treeDepth;
    const count = { total: 0 };
    const statusFn = function(total, depth) {
      statusEl.textContent = '已扫描 ' + total + ' 个文件夹…（深度 ' + depth + ' 层 / 最大 ' + maxDepth + ' 层）';
    };

    try {
      const header = folderName + '/\n';
      const childLines = await buildTreeLines(folderId, '', 0, maxDepth, count, statusFn);
      if (state.treeExportStopping) {
        statusEl.textContent = '已停止扫描。';
        return;
      }
      const ts = new Date();
      const p = (x) => String(x).padStart(2, '0');
      const dateStr = ts.getFullYear() + p(ts.getMonth() + 1) + p(ts.getDate()) + '_' + p(ts.getHours()) + p(ts.getMinutes());
      const safeName = folderName.replace(/[\/\\:*?"<>|]/g, '_');
      const isPng = state.treeFormat === 'png';
      const filename = safeName + '_目录树_' + dateStr + (isPng ? '.png' : '.txt');

      if (isPng) {
        downloadPng(filename, [{ name: folderName + '/', lines: childLines }]);
      } else {
        downloadTxt(filename, header + childLines.join('\n') + '\n');
      }
      statusEl.textContent = '完成！共 ' + count.total + ' 个文件夹，已下载 ' + filename;
    } catch (e) {
      statusEl.textContent = '导出失败：' + (e.message || String(e));
    } finally {
      setTimeout(() => { overlay.classList.add('hidden'); ui.stopScan.classList.add('hidden'); }, state.treeExportStopping ? 600 : 1800);
    }
  }

  // 导出多个选中文件夹的目录树为 TXT（每个文件夹一个区块，用空行分隔）
  async function exportSelectedTrees() {
    if (state.treeFolders.length === 0) return;
    const overlay = ui.exportOverlay;
    const statusEl = ui.exportStatus;
    state.treeExportStopping = false;
    ui.stopScan.classList.remove('hidden');
    overlay.classList.remove('hidden');

    const maxDepth = state.treeDepth;
    const count = { total: 0 };
    const statusFn = function(total, depth) {
      statusEl.textContent = '已扫描 ' + total + ' 个文件夹…（深度 ' + depth + ' 层 / 最大 ' + maxDepth + ' 层）';
    };

    try {
      const sections = [];
      const pngSections = [];
      for (let i = 0; i < state.treeFolders.length; i++) {
        if (state.treeExportStopping) break;
        const f = state.treeFolders[i];
        statusEl.textContent = '正在扫描（' + (i + 1) + '/' + state.treeFolders.length + '）：' + f.name + ' …';
        const header = f.name + '/\n';
        const childLines = await buildTreeLines(f.id, '', 0, maxDepth, count, statusFn);
        sections.push(header + childLines.join('\n'));
        pngSections.push({ name: f.name + '/', lines: childLines });
      }
      if (state.treeExportStopping) {
        statusEl.textContent = '已停止扫描。';
        return;
      }
      const ts = new Date();
      const p = (x) => String(x).padStart(2, '0');
      const dateStr = ts.getFullYear() + p(ts.getMonth() + 1) + p(ts.getDate()) + '_' + p(ts.getHours()) + p(ts.getMinutes());
      const isPng = state.treeFormat === 'png';
      const filename = '目录树_' + state.treeFolders.length + '个文件夹_' + dateStr + (isPng ? '.png' : '.txt');

      if (isPng) {
        downloadPng(filename, pngSections);
      } else {
        downloadTxt(filename, sections.join('\n\n') + '\n');
      }
      statusEl.textContent = '完成！共 ' + state.treeFolders.length + ' 个文件夹、' + count.total + ' 个子文件夹，已下载 ' + filename;
    } catch (e) {
      statusEl.textContent = '导出失败：' + (e.message || String(e));
    } finally {
      setTimeout(() => { overlay.classList.add('hidden'); ui.stopScan.classList.add('hidden'); }, state.treeExportStopping ? 600 : 1800);
    }
  }

  // 触发 TXT 文件下载
  function downloadTxt(filename, content) {
    const blob = new Blob(['\ufeff' + content], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.style.display = 'none';
    document.body.appendChild(a);
    a.click();
    setTimeout(function() {
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    }, 1000);
  }

  // 把目录树画到 Canvas 上，导出 PNG 图片
  // sections: [{name: '文件夹名/', lines: ['├── 子文件夹/', ...]}]
  function downloadPng(filename, sections) {
    const fontSize = 15, lineHeight = 27, padX = 30, padY = 26, dpr = 2;
    const family = 'Consolas, "Courier New", "Microsoft YaHei", monospace';
    const fontNormal = fontSize + 'px ' + family;
    const fontBold = 'bold ' + fontSize + 'px ' + family;

    // 组装行
    const rows = [];
    for (const sec of sections) {
      rows.push({ text: sec.name, bold: true, color: '#2f54eb' });
      for (const l of sec.lines) rows.push({ text: l, color: '#1d2129' });
      rows.push({ text: '' }); // 区块之间空一行
    }
    if (rows.length > 0 && rows[rows.length - 1].text === '') rows.pop();

    // 先测量最大行宽
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d');
    let maxW = 0;
    for (const r of rows) {
      ctx.font = r.bold ? fontBold : fontNormal;
      const w = ctx.measureText(r.text).width;
      if (w > maxW) maxW = w;
    }

    const MAX_W = 3600; // 防止单行超长把画布撑爆
    const w = Math.max(320, Math.min(Math.ceil(maxW) + padX * 2, MAX_W));
    const h = rows.length * lineHeight + padY * 2;
    canvas.width = w * dpr;
    canvas.height = h * dpr;
    ctx.scale(dpr, dpr);

    // 白底 + 细边框
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, w, h);

    let y = padY;
    for (const r of rows) {
      if (r.text) {
        ctx.font = r.bold ? fontBold : fontNormal;
        ctx.fillStyle = r.color || '#1d2129';
        ctx.fillText(r.text, padX, y + fontSize);
      }
      y += lineHeight;
    }

    const a = document.createElement('a');
    a.href = canvas.toDataURL('image/png');
    a.download = filename;
    a.style.display = 'none';
    document.body.appendChild(a);
    a.click();
    setTimeout(function() { document.body.removeChild(a); }, 1000);
  }

  /* ================================================================
   * UI 构建（Shadow DOM，样式与页面互相隔离）
   * ================================================================ */
  const CSS = `
    :host { all: initial; }
    * { box-sizing: border-box; margin: 0; padding: 0;
        font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', 'PingFang SC', 'Microsoft YaHei', sans-serif; }
    .hidden { display: none !important; }
    button { cursor: pointer; font-family: inherit; }

    /* ---- 悬浮球 ---- */
    .pp-fab {
      position: fixed; right: 24px; bottom: 96px; z-index: 2147483646;
      display: flex; align-items: center; gap: 7px;
      background: linear-gradient(135deg, #3b6bff, #2f54eb);
      color: #fff; padding: 11px 18px; border-radius: 999px;
      font-size: 14px; font-weight: 600; user-select: none;
      box-shadow: 0 6px 20px rgba(47, 84, 235, .45);
      transition: transform .15s, box-shadow .15s;
    }
    .pp-fab:hover { transform: translateY(-2px); box-shadow: 0 10px 26px rgba(47, 84, 235, .55); }

    /* ---- 面板 ---- */
    .pp-panel {
      position: fixed; right: 24px; bottom: 96px; z-index: 2147483647;
      width: 480px;
      height: min(640px, calc(100vh - 130px));
      background: #edf2fb; border: 1px solid #d9e3f5; border-radius: 16px;
      box-shadow: 0 16px 56px rgba(15, 25, 60, .22);
      display: flex; flex-direction: column; overflow: hidden;
      color: #1f2329;
    }
    .pp-header {
      padding: 14px 16px 13px; cursor: move; user-select: none;
      background: linear-gradient(135deg, #2f6bff 0%, #2b5ae8 55%, #1e46c8 100%);
      color: #fff;
    }
    .pp-header button { cursor: pointer; }
    .pp-title-row { display: flex; align-items: center; justify-content: space-between; }
    .pp-title { font-size: 15px; font-weight: 700; color: #fff; letter-spacing: .4px; }
    .pp-header-btns { display: flex; gap: 6px; }
    .pp-mini-btn {
      border: 1px solid rgba(255,255,255,.42); background: rgba(255,255,255,.16);
      color: #fff; border-radius: 7px; padding: 2px 9px; font-size: 12px;
      transition: all .15s;
    }
    .pp-mini-btn:hover { background: #fff; color: #2f54eb; border-color: #fff; }
    .pp-sub { font-size: 12px; color: rgba(255,255,255,.78); margin-top: 4px; }

    /* ---- 功能导航（分段控件卡片）---- */
    .pp-panel-tabs {
      display: flex; gap: 4px; flex: none;
      background: #fff; border: 1px solid #e1e9f7; border-radius: 12px;
      margin: 10px 12px 0; padding: 4px;
      box-shadow: 0 2px 10px rgba(30, 64, 160, .07);
    }
    .pp-panel-tab { flex: 1; border: none; background: transparent; padding: 7px 4px; font-size: 12px;
                    color: #64748b; cursor: pointer; border-radius: 9px; transition: all .15s;
                    font-family: inherit; white-space: nowrap; }
    .pp-panel-tab:hover { color: #2f54eb; background: #eef3ff; }
    .pp-panel-tab.active { color: #fff; background: linear-gradient(135deg, #3b6bff, #2f54eb);
                           font-weight: 600; box-shadow: 0 2px 6px rgba(47, 84, 235, .35); }

    /* ---- 目录树深度选择器 ---- */
    .pp-depth-box { display: flex; align-items: center; gap: 5px; font-size: 12px; color: #4e5969; white-space: nowrap; }
    .pp-depth-box select { border: 1px solid #e5e8ef; border-radius: 6px; padding: 4px 7px; font-size: 12px; color: #1d2129; background: #fff; outline: none; cursor: pointer; }
    .pp-depth-box select:focus { border-color: #3b6bff; }

    /* ---- 批量重命名 ---- */
    .pp-rn-rules {
      border: 1px solid #e1e9f7; border-radius: 12px; background: #fff;
      box-shadow: 0 1px 5px rgba(30, 64, 160, .06);
      padding: 10px 12px; display: flex; flex-direction: column; gap: 8px; flex: none;
    }
    .pp-rn-rule-row { display: flex; align-items: center; gap: 8px; font-size: 12px; color: #4e5969; }
    .pp-rn-rule-row > label { width: 56px; flex: none; color: #86909c; }
    .pp-rn-rule-row > select, .pp-rn-rule-row > input {
      flex: 1; border: 1px solid #e5e8ef; border-radius: 6px; padding: 5px 8px;
      font-size: 12px; color: #1d2129; background: #fff; outline: none; min-width: 0;
    }
    .pp-rn-rule-row > select:focus, .pp-rn-rule-row > input:focus { border-color: #3b6bff; }
    .pp-rn-rule-box { display: flex; flex-direction: column; gap: 8px; }
    .pp-rn-preview {
      border: 1px solid #e1e9f7; border-radius: 12px; overflow: auto; flex: 1; min-height: 60px;
      background: #fff; box-shadow: 0 1px 5px rgba(30, 64, 160, .06);
    }
    .pp-rn-pv-row {
      display: flex; align-items: center; gap: 6px; padding: 6px 10px;
      border-bottom: 1px solid #f2f3f7; font-size: 12px;
    }
    .pp-rn-pv-row:last-child { border-bottom: none; }
    .pp-rn-pv-old { color: #86909c; text-decoration: line-through; word-break: break-all; flex: 1; }
    .pp-rn-pv-arrow { color: #c9cdd4; flex: none; }
    .pp-rn-pv-new { color: #1d2129; font-weight: 600; word-break: break-all; flex: 1; }
    .pp-rn-pv-row.skip .pp-rn-pv-new { color: #c9cdd4; font-weight: 400; }
    .pp-rn-pv-row.warn .pp-rn-pv-new { color: #ff7d00; font-weight: 400; }
    .pp-rn-pv-state { flex: none; width: 20px; text-align: center; }
    .pp-rn-pv-row .done-ok { color: #00b42a; }
    .pp-rn-pv-row .done-fail { color: #f53f3f; }
    .pp-depth-hint { font-size: 11px; color: #86909c; }
    .pp-steps { display: flex; align-items: center; gap: 6px; margin-top: 12px; }
    .pp-step { display: flex; align-items: center; gap: 5px; font-size: 12px; color: rgba(255,255,255,.62); white-space: nowrap; }
    .pp-step i {
      font-style: normal; width: 17px; height: 17px; border-radius: 50%;
      background: rgba(255,255,255,.18); color: #fff; font-size: 11px;
      display: inline-flex; align-items: center; justify-content: center;
    }
    .pp-step.active { color: #fff; font-weight: 600; }
    .pp-step.active i { background: #fff; color: #2f54eb; }
    .pp-step.done i { background: rgba(255,255,255,.92); color: #00b42a; }
    .pp-step-line { flex: 1; height: 1px; background: rgba(255,255,255,.28); }

    .pp-body { flex: 1; overflow: hidden; display: flex; flex-direction: column; }
    .pp-page { flex: 1; display: flex; flex-direction: column; overflow: hidden; padding: 10px 12px 12px; gap: 8px; }

    /* ---- 工具栏 / 面包屑 ---- */
    .pp-toolbar { display: flex; gap: 8px; align-items: center; }
    .pp-bc { flex: 1; display: flex; align-items: center; flex-wrap: wrap; gap: 2px;
             font-size: 12px; max-height: 34px; overflow-y: auto; }
    .pp-crumb { color: #3b6bff; cursor: pointer; padding: 2px 3px; border-radius: 4px; white-space: nowrap; }
    .pp-crumb:hover { background: #f0f4ff; }
    .pp-crumb.cur { color: #1d2129; font-weight: 600; cursor: default; }
    .pp-bc .sep { color: #c9cdd4; }
    .pp-search {
      width: 120px; border: 1px solid #e5e8ef; border-radius: 8px;
      padding: 5px 9px; font-size: 12px; outline: none; color: #1d2129;
    }
    .pp-search:focus { border-color: #3b6bff; }

    /* ---- 工具栏操作按钮 ---- */
    .pp-tbar-btns { display: flex; gap: 4px; flex: none; }
    .pp-tbar-btn {
      border: 1px solid #e5e8ef; background: #fff; color: #4e5969;
      border-radius: 6px; padding: 4px 8px; font-size: 11px; white-space: nowrap;
      transition: all .15s;
    }
    .pp-tbar-btn:hover { border-color: #3b6bff; color: #3b6bff; background: #f0f4ff; }
    .pp-tbar-btn.export { color: #00b42a; border-color: #cfe8d0; }
    .pp-tbar-btn.export:hover { background: #e8f7e8; border-color: #00b42a; }
    .pp-tbar-btn:disabled { opacity: .45; cursor: not-allowed; }

    /* ---- 行内导出按钮 ---- */
    .pp-row-export {
      flex: none; border: 1px solid #dcefe0; background: #f0faf2; color: #00b42a;
      border-radius: 5px; padding: 2px 7px; font-size: 11px; white-space: nowrap;
      transition: all .15s;
    }
    .pp-row-export:hover { background: #00b42a; color: #fff; border-color: #00b42a; }

    /* ---- 导出进度遮罩 ---- */
    .pp-export-overlay {
      position: absolute; inset: 0; background: rgba(255,255,255,.88);
      display: flex; flex-direction: column; align-items: center; justify-content: center;
      gap: 10px; z-index: 10; font-size: 13px; color: #4e5969;
    }
    .pp-export-overlay .spin {
      width: 28px; height: 28px; border: 3px solid #e5e8ef; border-top-color: #2f54eb;
      border-radius: 50%; animation: pp-spin .7s linear infinite;
    }
    .pp-export-overlay .pp-stop-scan {
      margin-top: 8px; border: 1px solid #f53f3f; background: #fff; color: #f53f3f;
      border-radius: 6px; padding: 5px 12px; font-size: 12px; cursor: pointer;
      transition: all .15s;
    }
    .pp-export-overlay .pp-stop-scan:hover { background: #f53f3f; color: #fff; }
    @keyframes pp-spin { to { transform: rotate(360deg); } }

    /* ---- 列表（白卡片）---- */
    .pp-list { flex: 1; overflow-y: auto; background: #fff; border: 1px solid #e1e9f7; border-radius: 12px;
               box-shadow: 0 1px 5px rgba(30, 64, 160, .06); }
    .pp-list::-webkit-scrollbar { width: 8px; }
    .pp-list::-webkit-scrollbar-thumb { background: #dfe3ec; border-radius: 4px; }
    .pp-row { display: flex; align-items: center; gap: 8px; padding: 8px 10px;
              border-bottom: 1px solid #f4f6fa; font-size: 13px; cursor: pointer; }
    .pp-row:last-child { border-bottom: none; }
    .pp-row:hover { background: #f7f9ff; }
    .pp-row .ico { flex: none; width: 18px; text-align: center; }
    .pp-row .name { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .pp-row .meta { flex: none; font-size: 11px; color: #a9aeb8; }
    .pp-row .arrow { flex: none; color: #c9cdd4; font-size: 15px; }
    .pp-row.folder { color: #1d2129; }
    .pp-row.file .badge {
      flex: none; width: 18px; height: 18px; border-radius: 50%;
      border: 1.5px solid #c9cdd4; color: transparent;
      display: inline-flex; align-items: center; justify-content: center;
      font-size: 11px; font-weight: 700;
    }
    .pp-row.file.checked { background: #eef3ff; }
    .pp-row.file.checked .badge { background: #2f54eb; border-color: #2f54eb; color: #fff; }
    .pp-row.disabled { opacity: .5; cursor: default; }
    .pp-pick {
      flex: none; width: 16px; height: 16px; border-radius: 4px;
      border: 1.5px solid #c9cdd4; background: #fff;
      display: inline-flex; align-items: center; justify-content: center;
      color: transparent; font-size: 11px; font-weight: 700;
    }
    .pp-pick:hover { border-color: #3b6bff; }
    .pp-row.picked .pp-pick { background: #2f54eb; border-color: #2f54eb; color: #fff; }
    .pp-row.picked { background: #eef3ff; }
    .pp-hint { padding: 24px 14px; text-align: center; font-size: 12px; color: #a9aeb8; }
    .pp-hint.error { color: #f53f3f; }
    .pp-hint.warn { color: #ff7d00; }

    /* ---- 高级折叠区 ---- */
    .pp-adv { font-size: 12px; color: #4e5969; }
    .pp-adv summary { cursor: pointer; color: #86909c; padding: 2px 0; user-select: none; }
    .pp-adv textarea {
      width: 100%; margin-top: 6px; border: 1px solid #e5e8ef; border-radius: 8px;
      padding: 7px 9px; font-size: 12px; resize: vertical; outline: none; color: #1d2129;
    }
    .pp-adv textarea:focus { border-color: #3b6bff; }

    /* ---- 按钮 / 底栏 ---- */
    .pp-footer { display: flex; align-items: center; gap: 8px; justify-content: flex-end; }
    .pp-note { flex: 1; font-size: 11px; color: #86909c; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .pp-btn {
      border: 1px solid #dcdfe8; background: #fff; color: #4e5969;
      border-radius: 8px; padding: 7px 14px; font-size: 13px;
      transition: all .15s;
    }
    .pp-btn:hover:not(:disabled) { border-color: #3b6bff; color: #3b6bff; }
    .pp-btn:disabled { opacity: .45; cursor: not-allowed; }
    .pp-btn-primary {
      background: linear-gradient(135deg, #3b6bff, #2f54eb); border: none; color: #fff; font-weight: 600;
    }
    .pp-btn-primary:hover:not(:disabled) { color: #fff; opacity: .92; }
    .pp-btn-danger { border-color: #ff7d00; color: #ff7d00; }
    .pp-btn-sm { padding: 4px 10px; font-size: 12px; margin-top: 6px; }

    /* ---- 模式切换 ---- */
    .pp-modes { display: flex; gap: 6px; }
    .pp-mode {
      flex: 1; border: 1px solid #e5e8ef; background: #fff; color: #4e5969;
      border-radius: 8px; padding: 6px 0; font-size: 12px;
    }
    .pp-mode.active { border-color: #2f54eb; color: #2f54eb; background: #eef3ff; font-weight: 600; }
    .pp-path-tip { font-size: 11px; color: #86909c; line-height: 1.6; background: #f7f8fb;
                   border-radius: 8px; padding: 7px 10px; }
    #pp-paths {
      width: 100%; border: 1px solid #e5e8ef; border-radius: 8px; padding: 8px 10px;
      font-size: 12px; resize: vertical; outline: none; color: #1d2129; line-height: 1.7;
    }
    #pp-paths:focus { border-color: #3b6bff; }

    /* ---- 已选标签 ---- */
    .pp-chips { display: flex; flex-wrap: wrap; gap: 5px; max-height: 62px; overflow-y: auto; }
    .pp-chip {
      display: inline-flex; align-items: center; gap: 4px;
      background: #eef3ff; color: #2f54eb; border-radius: 6px;
      padding: 3px 8px; font-size: 12px; max-width: 100%;
    }
    .pp-chip .t { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .pp-chip button { border: none; background: none; color: #86909c; font-size: 13px; line-height: 1; padding: 0; }
    .pp-chip button:hover { color: #f53f3f; }
    .pp-chip.path { background: #fff7e8; color: #b25e00; }

    /* ---- 摘要 / 进度 / 结果 ---- */
    .pp-summary { overflow-y: auto; flex: 1; font-size: 13px; }
    .pp-sum-line { font-size: 13px; color: #1d2129; background: #eef3ff; border-radius: 8px; padding: 9px 11px; margin-bottom: 9px; }
    .pp-sum-line b { color: #2f54eb; }
    .pp-sum-head { font-size: 12px; color: #86909c; margin: 8px 0 4px; }
    .pp-sum-item { padding: 3px 10px; font-size: 12.5px; color: #1d2129;
                   overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .pp-sum-item i { font-style: normal; color: #a9aeb8; }
    .pp-progress { margin-top: 6px; }
    .pp-progress-track { height: 8px; background: #e6edfb; border-radius: 4px; overflow: hidden; }
    .pp-progress-fill { height: 100%; width: 0; background: linear-gradient(90deg, #3b6bff, #2f54eb);
                        border-radius: 4px; transition: width .25s; }
    .pp-progress-text { font-size: 12px; color: #4e5969; margin-top: 5px; }
    .pp-results { overflow-y: auto; flex: 1; border: 1px solid #e1e9f7; border-radius: 12px; margin-top: 8px; background: #fff; box-shadow: 0 1px 5px rgba(30, 64, 160, .06); }
    .pp-result { display: flex; align-items: baseline; gap: 7px; padding: 7px 10px;
                 border-bottom: 1px solid #f4f6fa; font-size: 12.5px; }
    .pp-result:last-child { border-bottom: none; }
    .pp-result .pp-result-name { flex: none; max-width: 45%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-weight: 500; }
    .pp-result .pp-result-msg { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: #86909c; font-size: 12px; }
    .pp-result.fail .pp-result-msg { color: #f53f3f; }
    .pp-results::-webkit-scrollbar, .pp-chips::-webkit-scrollbar, .pp-summary::-webkit-scrollbar { width: 8px; }
    .pp-results::-webkit-scrollbar-thumb, .pp-chips::-webkit-scrollbar-thumb, .pp-summary::-webkit-scrollbar-thumb { background: #dfe3ec; border-radius: 4px; }

    /* ---- 窗口缩放手柄（右下角）---- */
    .pp-resize { position: absolute; right: 0; bottom: 0; width: 20px; height: 20px; cursor: nwse-resize; z-index: 30; }
    .pp-resize::after { content: ''; position: absolute; right: 5px; bottom: 5px; width: 9px; height: 9px;
      border-right: 2px solid #c9cdd4; border-bottom: 2px solid #c9cdd4; border-radius: 0 0 3px 0; }
    .pp-resize:hover::after { border-color: #3b6bff; }

    /* ---- 重命名：位置删除 / 序号 ---- */
    .pp-rn-check { display: inline-flex; align-items: center; gap: 6px; font-size: 12px; color: #4e5969; cursor: pointer; }
    .pp-rn-check input { accent-color: #2f54eb; }
    .pp-rn-seq-box { display: flex; flex-direction: column; gap: 7px; border-top: 1px dashed #e2e6ee; padding-top: 8px; }
    .pp-rn-seq-opts { display: flex; align-items: center; gap: 6px; font-size: 12px; color: #4e5969; flex-wrap: wrap; }
    .pp-rn-seq-opts select { border: 1px solid #e5e8ef; border-radius: 6px; padding: 4px 6px; font-size: 12px;
      color: #1d2129; background: #fff; outline: none; cursor: pointer; }
    .pp-rn-seq-opts input { width: 56px; border: 1px solid #e5e8ef; border-radius: 6px; padding: 4px 6px;
      font-size: 12px; color: #1d2129; outline: none; }
    .pp-rn-seq-opts select:focus, .pp-rn-seq-opts input:focus { border-color: #3b6bff; }
    .pp-rn-seq-opts .sep-text { color: #86909c; }
  `;

  const HTML = `
    <style>${CSS}</style>
    <div class="pp-fab" id="pp-fab" title="PikPak 工作台">
      <svg width="15" height="15" viewBox="0 0 16 16" fill="none">
        <path d="M2 4.5A1.5 1.5 0 0 1 3.5 3h2.6a1.5 1.5 0 0 1 1.1.5l.9 1h4.4A1.5 1.5 0 0 1 14 6v6a1.5 1.5 0 0 1-1.5 1.5h-9A1.5 1.5 0 0 1 2 12V4.5Z" fill="#fff" opacity=".4"/>
        <path d="M5.5 9h5M8.5 11.5v-5" stroke="#fff" stroke-width="1.7" stroke-linecap="round"/>
      </svg>
      <span>PikPak 助手</span>
    </div>

    <div class="pp-panel hidden" id="pp-panel">
      <div class="pp-header" id="pp-header" title="按住此处拖动窗口；双击复位位置">
        <div class="pp-title-row">
          <span class="pp-title">⠿ PikPak 工作台</span>
          <span class="pp-header-btns">
            <button class="pp-mini-btn" id="pp-reset" title="清空所有选择">重置</button>
            <button class="pp-mini-btn" id="pp-close" title="收起面板">×</button>
          </span>
        </div>
        <div class="pp-sub">批量复制 · 目录树导出 · 批量重命名，直接使用网页登录状态</div>
        <div class="pp-steps" id="pp-steps">
          <div class="pp-step active" data-n="1"><i>1</i>选文件</div>
          <div class="pp-step-line"></div>
          <div class="pp-step" data-n="2"><i>2</i>选目标文件夹</div>
          <div class="pp-step-line"></div>
          <div class="pp-step" data-n="3"><i>3</i>执行</div>
        </div>
      </div>

      <div class="pp-panel-tabs">
        <button class="pp-panel-tab active" data-panel="copy">📋 批量复制</button>
        <button class="pp-panel-tab" data-panel="manage">🗂 文件整理</button>
        <button class="pp-panel-tab" data-panel="tree">🌳 目录树</button>
        <button class="pp-panel-tab" data-panel="rename">✏️ 重命名</button>
      </div>

      <div class="pp-body" id="pp-copy-body">
        <div class="pp-modes" id="pp-copy-mode-row">
          <button class="pp-mode active" data-cm="copy">📋 复制文件</button>
          <button class="pp-mode" data-cm="move">📦 移动文件/文件夹</button>
        </div>
        <!-- 第 1 步：选文件 -->
        <div class="pp-page" id="pp-page1">
          <div class="pp-toolbar">
            <div class="pp-bc" id="pp-bc1"></div>
            <input class="pp-search" id="pp-search1" placeholder="筛选当前列表…">
          </div>
          <div class="pp-list" id="pp-list1"><div class="pp-hint">加载中…</div></div>
          <details class="pp-adv">
            <summary>高级：直接粘贴文件 ID</summary>
            <textarea id="pp-pasteids" rows="2" placeholder="每行一个文件 ID"></textarea>
            <button class="pp-btn pp-btn-sm" id="pp-addids">按 ID 添加</button>
          </details>
          <div class="pp-footer">
            <span class="pp-note" id="pp-note1">点击文件夹进入，点击文件选中</span>
            <button class="pp-btn pp-btn-primary" id="pp-next1" disabled>下一步 →</button>
          </div>
        </div>

        <!-- 第 2 步：选目标文件夹 -->
        <div class="pp-page hidden" id="pp-page2">
          <div class="pp-modes">
            <button class="pp-mode active" data-m="browse">浏览勾选文件夹</button>
            <button class="pp-mode" data-m="path">按路径输入（可自动创建）</button>
          </div>
          <div id="pp-mode-browse" style="display:flex;flex-direction:column;flex:1;gap:8px;overflow:hidden;">
            <div class="pp-toolbar">
              <div class="pp-bc" id="pp-bc2"></div>
              <div class="pp-tbar-btns">
                <button class="pp-tbar-btn" id="pp-selectall2" title="勾选当前列表所有文件夹">全选</button>
                <button class="pp-tbar-btn" id="pp-invert2" title="反选当前列表">反选</button>
              </div>
              <input class="pp-search" id="pp-search2" placeholder="筛选…">
            </div>
            <div class="pp-list" id="pp-list2"><div class="pp-hint">加载中…</div></div>
          </div>
          <div id="pp-mode-path" class="hidden" style="display:flex;flex-direction:column;flex:1;gap:8px;overflow:auto;">
            <div class="pp-path-tip" id="pp-path-tip"></div>
            <textarea id="pp-paths" rows="9" placeholder="每行一个目标文件夹路径，例如：&#10;电影/动作片&#10;电影/喜剧片&#10;/备份/2026-08&#10;&#10;以 / 开头 = 从根目录开始；否则相对当前浏览的文件夹。&#10;不存在的文件夹会在执行时自动逐级创建。"></textarea>
          </div>
          <div class="pp-chips" id="pp-chips"></div>
          <div class="pp-footer">
            <button class="pp-btn" id="pp-back2">← 上一步</button>
            <button class="pp-btn pp-btn-primary" id="pp-next2" disabled>下一步 →</button>
          </div>
        </div>

        <!-- 第 3 步：执行 -->
        <div class="pp-page hidden" id="pp-page3">
          <div class="pp-summary" id="pp-summary"></div>
          <div class="pp-progress hidden" id="pp-progress">
            <div class="pp-progress-track"><div class="pp-progress-fill" id="pp-progress-fill"></div></div>
            <div class="pp-progress-text" id="pp-progress-text"></div>
          </div>
          <div class="pp-results hidden" id="pp-results"></div>
          <div class="pp-footer">
            <button class="pp-btn" id="pp-back3">← 返回</button>
            <button class="pp-btn pp-btn-primary" id="pp-start">开始复制</button>
            <button class="pp-btn pp-btn-danger hidden" id="pp-stop">停止</button>
          </div>
        </div>
      </div><!-- /pp-copy-body -->

      <!-- 导出目录树模式 -->
      <div class="pp-body hidden" id="pp-tree-body">
        <div class="pp-toolbar">
          <div class="pp-bc" id="pp-bc-tree"></div>
          <div class="pp-depth-box">
            <label for="pp-tree-depth">深度</label>
            <select id="pp-tree-depth" title="扫描深度">
              <option value="1">仅当前层</option>
              <option value="2">2 层</option>
              <option value="3">3 层</option>
              <option value="8">全部（最多 8 层）</option>
            </select>
          </div>
          <div class="pp-depth-box">
            <label for="pp-tree-format">格式</label>
            <select id="pp-tree-format" title="导出格式">
              <option value="txt">TXT 文本</option>
              <option value="png">PNG 图片</option>
            </select>
          </div>
          <div class="pp-tbar-btns">
            <button class="pp-tbar-btn" id="pp-tree-selectall" title="勾选当前列表所有文件夹">全选</button>
            <button class="pp-tbar-btn" id="pp-tree-invert" title="反选当前列表">反选</button>
          </div>
          <input class="pp-search" id="pp-search-tree" placeholder="筛选…">
        </div>
        <div style="position:relative;flex:1;overflow:hidden;display:flex;flex-direction:column;">
          <div class="pp-list" id="pp-list-tree"><div class="pp-hint">加载中…</div></div>
          <div class="pp-export-overlay hidden" id="pp-export-overlay">
            <div class="spin"></div>
            <span id="pp-export-status">正在扫描文件夹…</span>
            <button class="pp-stop-scan" id="pp-stop-scan">停止扫描</button>
          </div>
        </div>
        <div class="pp-chips" id="pp-tree-chips"></div>
        <div class="pp-footer">
          <span class="pp-note" id="pp-tree-note">勾选要导出的文件夹；格式可选 TXT / PNG（默认仅扫描当前层）</span>
          <button class="pp-btn pp-btn-primary" id="pp-export-selected" disabled>🌳 导出选中目录树</button>
        </div>
      </div><!-- /pp-tree-body -->

      <!-- 批量重命名模式 -->
      <div class="pp-body hidden" id="pp-rename-body">
        <div class="pp-toolbar">
          <div class="pp-bc" id="pp-bc-rn"></div>
          <div class="pp-depth-box">
            <label for="pp-rn-type">类型</label>
            <select id="pp-rn-type" title="控制列表显示哪些内容，勾选时只勾到对应类型">
              <option value="all">全部</option>
              <option value="folder">仅文件夹</option>
              <option value="file">仅文件</option>
            </select>
          </div>
          <div class="pp-tbar-btns">
            <button class="pp-tbar-btn" id="pp-rn-selectall" title="勾选当前列表所有项目">全选</button>
            <button class="pp-tbar-btn" id="pp-rn-invert" title="反选当前列表">反选</button>
          </div>
          <input class="pp-search" id="pp-search-rn" placeholder="筛选…">
        </div>
        <div class="pp-list" id="pp-list-rn"><div class="pp-hint">加载中…</div></div>
        <div class="pp-chips" id="pp-rn-chips"></div>
        <div class="pp-rn-rules">
          <div class="pp-rn-rule-row">
            <label>规则类型</label>
            <select id="pp-rn-rule">
              <option value="bracket">按括号处理（删除括号内内容）</option>
              <option value="keyword">按关键字处理（删除/替换指定文字）</option>
              <option value="position">按位置处理（删除某字前/后/之间）</option>
            </select>
          </div>
          <div class="pp-rn-rule-box" id="pp-rn-bracket-box">
            <div class="pp-rn-rule-row">
              <label>处理括号</label>
              <select id="pp-rn-bracket">
                <option value="round">( ) 圆括号（含全角（））</option>
                <option value="square">[ ] 方括号（含全角【】）</option>
                <option value="both">以上两种都处理</option>
              </select>
            </div>
            <div class="pp-rn-rule-row">
              <label>处理方式</label>
              <select id="pp-rn-mode">
                <option value="inside">仅删除括号里面的内容（保留括号）</option>
                <option value="with">连括号带里面的内容一起删除</option>
              </select>
            </div>
          </div>
          <div class="pp-rn-rule-box hidden" id="pp-rn-keyword-box">
            <div class="pp-rn-rule-row">
              <label>关键字</label>
              <input type="text" id="pp-rn-keyword" placeholder="要删除的文字，多个用 | 分隔，如 123|预告">
            </div>
          </div>
          <div class="pp-rn-rule-box hidden" id="pp-rn-position-box">
            <div class="pp-rn-rule-row">
              <label>处理方式</label>
              <select id="pp-rn-posmode">
                <option value="before">删除某字「之前」的部分</option>
                <option value="after">删除某字「之后」的部分</option>
                <option value="between">删除两个字「之间」的部分</option>
              </select>
            </div>
            <div class="pp-rn-rule-row" id="pp-rn-posmark-row">
              <label>定位字</label>
              <input type="text" id="pp-rn-posmark" placeholder="要定位的文字，如：第">
            </div>
            <div class="pp-rn-rule-row hidden" id="pp-rn-posbetween-row">
              <label>起止字</label>
              <input type="text" id="pp-rn-posmarkA" placeholder="起始字，如 【" style="flex:1;">
              <input type="text" id="pp-rn-posmarkB" placeholder="结束字，如 】" style="flex:1;">
            </div>
            <div class="pp-rn-rule-row" id="pp-rn-poswhich-row">
              <label>出现位置</label>
              <select id="pp-rn-poswhich">
                <option value="first">匹配第一个出现的定位字</option>
                <option value="last">匹配最后一个出现的定位字</option>
              </select>
            </div>
            <div class="pp-rn-rule-row">
              <label>删除范围</label>
              <label class="pp-rn-check"><input type="checkbox" id="pp-rn-posinclude"> 连同定位字一起删除</label>
            </div>
          </div>
          <div class="pp-rn-rule-row">
            <label>替换为</label>
            <input type="text" id="pp-rn-replace" placeholder="留空 = 直接删除；填了则替换为该文字">
          </div>
          <div class="pp-rn-seq-box">
            <label class="pp-rn-check"><input type="checkbox" id="pp-rn-seq"> 重命名后加序号（1. 2. 3. …）</label>
            <div class="pp-rn-seq-opts hidden" id="pp-rn-seq-opts">
              <select id="pp-rn-seqfmt" title="序号样式">
                <option value="dot">1. 名称</option>
                <option value="pad">01. 名称</option>
                <option value="paren">(1) 名称</option>
                <option value="bracket">【1】名称</option>
                <option value="dash">1-名称</option>
              </select>
              <span class="sep-text">从</span>
              <input type="number" id="pp-rn-seqstart" value="1" min="0" step="1" title="起始序号">
              <span class="sep-text">开始</span>
            </div>
          </div>
        </div>
        <div class="pp-rn-preview hidden" id="pp-rn-preview"></div>
        <div class="pp-footer">
          <span class="pp-note" id="pp-rn-note">勾选项目并设置规则，先点「预览」看效果，确认后再执行</span>
          <button class="pp-btn" id="pp-rn-dopreview">🔍 预览</button>
          <button class="pp-btn pp-btn-primary" id="pp-rn-execute" disabled>✏️ 确认执行重命名</button>
        </div>
      </div><!-- /pp-rename-body -->

      <!-- 文件整理模式 -->
      <div class="pp-body hidden" id="pp-manage-body">
        <div class="pp-toolbar">
          <div class="pp-bc" id="pp-bc-manage"></div>
          <div class="pp-depth-box">
            <label for="pp-manage-type">类型</label>
            <select id="pp-manage-type" title="控制列表显示哪些内容，勾选时只勾到对应类型">
              <option value="all">全部</option>
              <option value="folder">仅文件夹</option>
              <option value="file">仅文件</option>
            </select>
          </div>
          <div class="pp-tbar-btns">
            <button class="pp-tbar-btn" id="pp-manage-selectall" title="勾选当前列表所有项目">全选</button>
            <button class="pp-tbar-btn" id="pp-manage-invert" title="反选当前列表">反选</button>
          </div>
          <input class="pp-search" id="pp-search-manage" placeholder="筛选…">
        </div>
        <div class="pp-list" id="pp-list-manage"><div class="pp-hint">加载中…</div></div>
        <div class="pp-chips" id="pp-manage-chips"></div>
        <div class="pp-rn-rules">
          <div class="pp-rn-rule-row">
            <label>操作</label>
            <select id="pp-manage-op">
              <option value="trash">移到回收站（可恢复）</option>
              <option value="unzip">批量解压（zip/rar/7z 到所在目录）</option>
              <option value="dup">文件查重（找出重复文件）</option>
            </select>
          </div>
        </div>
        <div class="pp-list hidden" id="pp-manage-dup-panel" style="flex:1;min-height:60px;"></div>
        <div class="pp-footer">
          <span class="pp-note" id="pp-manage-note">勾选项目后选择操作执行；查重会扫描当前文件夹</span>
          <button class="pp-btn pp-btn-primary" id="pp-manage-execute" disabled>执行</button>
        </div>
      </div><!-- /pp-manage-body -->

      <div class="pp-resize" id="pp-resize" title="拖动调整窗口大小"></div>
    </div>
  `;

  /* ================================================================
   * 状态
   * ================================================================ */
  const state = {
    inited: false,
    step: 1,
    files: [],      // 已选源文件 [{id, name}]
    folders: [],    // 已勾选的目标文件夹 [{id, name}]
    treeFolders: [], // 导出目录树模式：已勾选的文件夹 [{id, name}]
    browse1: { stack: [{ id: '', name: '根目录' }], data: null, loading: false, error: null, filter: '', loadToken: 0 },
    browse2: { stack: [{ id: '', name: '根目录' }], data: null, loading: false, error: null, filter: '', loadToken: 0 },
    treeBrowse: { stack: [{ id: '', name: '根目录' }], data: null, loading: false, error: null, filter: '', loadToken: 0, inited: false },
    renameBrowse: { stack: [{ id: '', name: '根目录' }], data: null, loading: false, error: null, filter: '', loadToken: 0, inited: false },
    renameTypeFilter: 'all',   // 重命名列表显示类型：all | folder | file
    renameItems: [],          // 重命名模式：已勾选的项目 [{id, name, isFolder}]
    renamePreview: null,       // 预览结果 null=未预览 [{id, oldName, newName, isFolder, changed, skip, reason, done}]
    renameRunning: false,
    renameStopRequested: false,
    mode: 'browse', // step2 的模式：browse | path
    copyMode: 'copy', // 批量操作模式：copy | move
    panelMode: 'copy', // 面板模式：copy | manage | tree | rename
    treeDepth: 1, // 目录树默认导出层数：1 层
    treeFormat: 'txt', // 目录树导出格式：txt | png
    treeExportStopping: false, // 是否正在请求停止目录树扫描
    // 文件整理模式
    manageBrowse: { stack: [{ id: '', name: '根目录' }], data: null, loading: false, error: null, filter: '', loadToken: 0, inited: false },
    manageTypeFilter: 'all',   // 整理列表显示类型：all | folder | file
    manageItems: [],           // 已勾选的项目 [{id, name, isFolder, size, hash}]
    manageOp: 'trash',         // 操作类型：trash | unzip | dup
    manageRunning: false,
    manageResults: null,       // 执行结果 [{label, ok, msg}]
    dupGroups: null,           // 查重结果：[[{id,name,size}, ...], ...] 每组为重复项
    dupScanning: false,
    running: false,
    stopRequested: false,
    results: [],
  };

  let ui = {}; // 元素引用缓存

  /* ================================================================
   * 渲染
   * ================================================================ */
  function $(id) { return ui.shadowRoot.getElementById(id); }

  function renderBreadcrumb(el, b) {
    el.innerHTML = b.stack.map((s, i) => {
      const cur = i === b.stack.length - 1;
      return '<span class="pp-crumb' + (cur ? ' cur" data-i="' + i : '" data-i="' + i) + '">' + esc(s.name) + '</span>';
    }).join('<span class="sep">/</span>');
  }

  function filterItems(b) {
    const kw = (b.filter || '').trim().toLowerCase();
    let folders = b.data ? b.data.folders : [];
    let files = b.data ? b.data.files : [];
    if (kw) {
      folders = folders.filter((f) => String(f.name || '').toLowerCase().includes(kw));
      files = files.filter((f) => String(f.name || '').toLowerCase().includes(kw));
    }
    return { folders: folders, files: files };
  }

  function renderStep1List() {
    const el = ui.list1;
    const b = state.browse1;
    renderBreadcrumb(ui.bc1, b);
    if (b.loading) { el.innerHTML = '<div class="pp-hint">加载中…</div>'; return; }
    if (b.error) { el.innerHTML = '<div class="pp-hint error">' + esc(b.error) + '</div>'; return; }
    if (!b.data) { el.innerHTML = '<div class="pp-hint">准备就绪</div>'; return; }

    const { folders, files } = filterItems(b);
    const total = folders.length + files.length;
    if (total === 0) { el.innerHTML = '<div class="pp-hint">此文件夹为空</div>'; return; }

    let html = '';
    const isMove = state.copyMode === 'move';
    for (const f of folders.slice(0, MAX_LIST_ITEMS)) {
      const checked = state.files.some((x) => x.id === f.id);
      html += '<div class="pp-row folder' + (checked ? ' picked' : '') + '" data-id="' + esc(f.id) + '" data-name="' + esc(f.name) + '" data-kind="folder">' +
        '<span class="pp-pick" data-pick="1">✓</span>' +
        '<span class="ico">📁</span>' +
        '<span class="name" data-enter="1" title="' + esc(f.name) + '">' + esc(f.name) + '</span>' +
        '<span class="arrow" data-enter="1">›</span></div>';
    }
    for (const f of files.slice(0, MAX_LIST_ITEMS)) {
      const checked = state.files.some((x) => x.id === f.id);
      html += '<div class="pp-row file' + (checked ? ' picked' : '') + '" data-id="' + esc(f.id) + '" data-name="' + esc(f.name) + '">' +
        '<span class="pp-pick" data-pick="1">✓</span>' +
        '<span class="ico">📄</span><span class="name" title="' + esc(f.name) + '">' + esc(f.name) + '</span>' +
        '<span class="meta">' + fmtTime(f.modified_time) + ' · ' + fmtSize(f.size) + '</span></div>';
    }
    if (total > MAX_LIST_ITEMS) {
      html += '<div class="pp-hint">仅显示前 ' + MAX_LIST_ITEMS + ' 项（共 ' + total + ' 项），可用上方筛选缩小范围</div>';
    }
    el.innerHTML = html;
    updateStep1Footer();
  }

  function renderStep2List() {
    const el = ui.list2;
    const b = state.browse2;
    renderBreadcrumb(ui.bc2, b);
    ui.pathTip.textContent = '当前浏览目录：' + b.stack.map((s) => s.name).join(' / ') +
      '。相对路径将以此为起点（每行一个路径，如：子文件夹/目标）';
    if (b.loading) { el.innerHTML = '<div class="pp-hint">加载中…</div>'; return; }
    if (b.error) { el.innerHTML = '<div class="pp-hint error">' + esc(b.error) + '</div>'; return; }
    if (!b.data) { el.innerHTML = '<div class="pp-hint">准备就绪</div>'; return; }

    const { folders } = filterItems(b);
    if (folders.length === 0) {
      el.innerHTML = '<div class="pp-hint">此位置没有子文件夹。可切到「按路径输入」直接创建。</div>';
      renderChips();
      return;
    }
    let html = '';
    for (const f of folders.slice(0, MAX_LIST_ITEMS)) {
      const picked = state.folders.some((x) => x.id === f.id);
      html += '<div class="pp-row folder' + (picked ? ' picked' : '') + '" data-id="' + esc(f.id) + '" data-name="' + esc(f.name) + '">' +
        '<span class="pp-pick" data-pick="1">✓</span>' +
        '<span class="ico">📁</span>' +
        '<span class="name" data-enter="1" title="' + esc(f.name) + '">' + esc(f.name) + '</span>' +
        '<span class="arrow" data-enter="1">›</span></div>';
    }
    if (folders.length > MAX_LIST_ITEMS) {
      html += '<div class="pp-hint">仅显示前 ' + MAX_LIST_ITEMS + ' 项（共 ' + folders.length + ' 个文件夹）</div>';
    }
    el.innerHTML = html;
    renderChips();
  }

  /* ---- 导出目录树模式：列表渲染 ---- */
  function renderTreeList() {
    const el = ui.listTree;
    const b = state.treeBrowse;
    renderBreadcrumb(ui.bcTree, b);
    if (b.loading) { el.innerHTML = '<div class="pp-hint">加载中…</div>'; return; }
    if (b.error) { el.innerHTML = '<div class="pp-hint error">' + esc(b.error) + '</div>'; return; }
    if (!b.data) { el.innerHTML = '<div class="pp-hint">准备就绪</div>'; return; }

    const { folders } = filterItems(b);
    if (folders.length === 0) {
      el.innerHTML = '<div class="pp-hint">此位置没有子文件夹。</div>';
      return;
    }
    let html = '';
    for (const f of folders.slice(0, MAX_LIST_ITEMS)) {
      const picked = state.treeFolders.some((x) => x.id === f.id);
      html += '<div class="pp-row folder' + (picked ? ' picked' : '') + '" data-id="' + esc(f.id) + '" data-name="' + esc(f.name) + '">' +
        '<span class="pp-pick" data-pick="1">✓</span>' +
        '<span class="ico">📁</span>' +
        '<span class="name" data-enter="1" title="' + esc(f.name) + '">' + esc(f.name) + '</span>' +
        '<button class="pp-row-export" data-export="1" title="单独导出此文件夹的目录树">导出</button>' +
        '<span class="arrow" data-enter="1">›</span></div>';
    }
    if (folders.length > MAX_LIST_ITEMS) {
      html += '<div class="pp-hint">仅显示前 ' + MAX_LIST_ITEMS + ' 项（共 ' + folders.length + ' 个文件夹）</div>';
    }
    el.innerHTML = html;
    renderTreeChips();
  }

  function renderTreeChips() {
    const chips = state.treeFolders.map((f, i) =>
      '<span class="pp-chip">📁 <span class="t" title="' + esc(f.name) + '">' + esc(f.name) +
      '</span><button data-rmtreefolder="' + i + '">×</button></span>'
    ).join('');
    ui.treeChips.innerHTML = chips || '<span style="font-size:11px;color:#a9aeb8;">尚未勾选文件夹</span>';
    ui.exportSelected.disabled = state.treeFolders.length === 0;
    ui.exportSelected.textContent = state.treeFolders.length > 0
      ? '🌳 导出选中目录树（' + state.treeFolders.length + '）'
      : '🌳 导出选中目录树';
  }

  /* ================================================================
   * 批量重命名
   * ================================================================ */

  // 根据下拉选择返回要处理的括号对（半角 + 全角）
  function getRnBracketPairs(kind) {
    const pairs = [];
    if (kind === 'round' || kind === 'both') {
      pairs.push(['(', ')']);
      pairs.push(['（', '）']);
    }
    if (kind === 'square' || kind === 'both') {
      pairs.push(['[', ']']);
      pairs.push(['【', '】']);
    }
    return pairs;
  }

  // 扫描字符串，处理一种括号的全部「顶层」配对（天然支持嵌套：内层随外层一起处理）
  // mode='inside'：保留括号本身，内容替换为 replacement；mode='with'：整对（含内容）替换为 replacement
  // 未闭合的括号片段原样保留，不动
  function replaceTopLevelBrackets(str, open, close, mode, replacement) {
    let out = '';
    let depth = 0;
    let topStart = -1;
    let count = 0;
    for (let i = 0; i < str.length; i++) {
      const ch = str[i];
      if (ch === open) {
        if (depth === 0) topStart = i;
        depth++;
      } else if (ch === close && depth > 0) {
        depth--;
        if (depth === 0) {
          out += (mode === 'inside') ? (open + replacement + close) : replacement;
          topStart = -1;
          count++;
        }
      } else if (depth === 0) {
        out += ch;
      }
    }
    if (depth > 0 && topStart >= 0) out += str.slice(topStart); // 尾部未闭合：原样保留
    return { str: out, count: count };
  }

  // 规则校验：返回错误文案或 null
  function rnRuleError() {
    if (!ui.rnRule) return null;
    const t = ui.rnRule.value;
    if (t === 'keyword') {
      const kws = String(ui.rnKeyword ? ui.rnKeyword.value : '')
        .split('|')
        .map(function(s) { return s.trim(); })
        .filter(function(s) { return s !== ''; });
      if (kws.length === 0) return '关键字模式：请先输入要删除/替换的文字';
    } else if (t === 'position') {
      const mode = ui.rnPosMode ? ui.rnPosMode.value : 'before';
      if (mode === 'between') {
        const a = String(ui.rnPosMarkA ? ui.rnPosMarkA.value : '').trim();
        const b = String(ui.rnPosMarkB ? ui.rnPosMarkB.value : '').trim();
        if (!a || !b) return '位置模式：请输入起始字和结束字';
        if (a === b) return '位置模式：起始字和结束字不能相同';
      } else {
        const mark = String(ui.rnPosMark ? ui.rnPosMark.value : '').trim();
        if (!mark) return '位置模式：请输入定位字';
      }
    }
    return null;
  }

  // 把关键字按 | 拆开，长关键字优先（避免 "12" 抢先吃掉 "123" 的一部分）
  function splitKeywords(raw) {
    return String(raw || '')
      .split('|')
      .map(function(s) { return s.trim(); })
      .filter(function(s) { return s !== ''; })
      .sort(function(a, b) { return b.length - a.length; });
  }

  // 位置删除：删除定位字「之前 / 之后」的部分，或两个字「之间」的部分
  // mode: 'before' | 'after' | 'between'；include=true 连定位字一起删；
  // which: 'first' | 'last'（before/after 模式用）；删除处填入 replacement
  function applyPositionRule(base, mode, mark, markA, markB, include, which, replacement) {
    if (mode === 'between') {
      if (!markA || !markB || markA === markB) return { str: base, count: 0 };
      let out = base;
      let count = 0;
      let searchFrom = 0; // 从上一对结束处继续找，避免重复匹配已处理的定界符
      let guard = 0;
      while (guard++ < 300) { // 防御性上限：处理所有成对的 A...B
        const a = out.indexOf(markA, searchFrom);
        if (a === -1) break;
        const b = out.indexOf(markB, a + markA.length);
        if (b === -1) break;
        if (include) {
          out = out.slice(0, a) + replacement + out.slice(b + markB.length);
          searchFrom = a + replacement.length;
        } else {
          out = out.slice(0, a + markA.length) + replacement + out.slice(b);
          searchFrom = a + markA.length + replacement.length;
        }
        count++;
      }
      return { str: out, count: count };
    }

    if (!mark) return { str: base, count: 0 };
    const idx = which === 'last' ? base.lastIndexOf(mark) : base.indexOf(mark);
    if (idx === -1) return { str: base, count: 0 };
    if (mode === 'before') {
      // 删除定位字之前的部分（include=true 时定位字也一起删）
      const keepFrom = include ? idx + mark.length : idx;
      return { str: (replacement || '') + base.slice(keepFrom), count: 1 };
    }
    // after：删除定位字之后的部分
    const keepTo = include ? idx : idx + mark.length;
    return { str: base.slice(0, keepTo) + (replacement || ''), count: 1 };
  }

  // 序号配置：读取 UI。total = 参与编号的项目总数（决定 01. 的补零宽度）
  function getSeqConfig(total) {
    if (!ui.rnSeq || !ui.rnSeq.checked) return null;
    const fmt = (ui.rnSeqFmt && ui.rnSeqFmt.value) || 'dot';
    let start = parseInt(ui.rnSeqStart ? ui.rnSeqStart.value : '1', 10);
    if (isNaN(start) || start < 0) start = 1;
    return { fmt: fmt, start: start, total: Math.max(1, total) };
  }

  // 生成序号前缀
  function seqLabel(n, cfg) {
    switch (cfg.fmt) {
      case 'pad': return String(n).padStart(String(cfg.total).length, '0') + '.';
      case 'paren': return '(' + n + ')';
      case 'bracket': return '【' + n + '】';
      case 'dash': return n + '-';
      case 'dot':
      default: return n + '.';
    }
  }

  // 对一个名字应用当前规则（括号 / 关键字 / 位置三选一），可选再加序号前缀。
  // 规则类型 keyword：把名字里出现的所有关键字删除（或替换为「替换为」文字），多个关键字用 | 分隔，长关键字优先匹配。
  // 规则类型 bracket：mode='inside' 仅替换括号内内容（保留括号）；mode='with' 连括号带内容一起替换。
  // 规则类型 position：按定位字删除之前/之后/之间的部分。
  // seqCfg = getSeqConfig() 的返回值（null = 不加序号），seqNum = 当前项目序号。
  // 文件自动保护扩展名；返回 {changed, newName, reason}
  function applyRenameRule(fullName, isFolder, seqCfg, seqNum) {
    const ruleType = ui.rnRule ? ui.rnRule.value : 'bracket';
    const replacement = ui.rnReplace ? (ui.rnReplace.value || '') : '';

    // 分离扩展名（仅文件；从最后一个 . 拆，主名不能为空）
    let base = fullName, ext = '';
    if (!isFolder) {
      const dot = fullName.lastIndexOf('.');
      if (dot > 0 && dot < fullName.length - 1) {
        base = fullName.slice(0, dot);
        ext = fullName.slice(dot);
      }
    }

    let matched = 0;

    if (ruleType === 'keyword') {
      // ---- 关键字模式：删除所有出现的关键字（或替换）----
      const kws = splitKeywords(ui.rnKeyword ? ui.rnKeyword.value : '');
      for (const kw of kws) {
        if (base.indexOf(kw) === -1) continue;
        matched++;
        base = base.split(kw).join(replacement);
      }
    } else if (ruleType === 'position') {
      // ---- 位置模式：按定位字删除 ----
      const mode = ui.rnPosMode ? ui.rnPosMode.value : 'before';
      const mark = String(ui.rnPosMark ? ui.rnPosMark.value : '').trim();
      const markA = String(ui.rnPosMarkA ? ui.rnPosMarkA.value : '').trim();
      const markB = String(ui.rnPosMarkB ? ui.rnPosMarkB.value : '').trim();
      const include = !!(ui.rnPosInclude && ui.rnPosInclude.checked);
      const which = (ui.rnPosWhich && ui.rnPosWhich.value) || 'first';
      const r = applyPositionRule(base, mode, mark, markA, markB, include, which, replacement);
      matched = r.count;
      base = r.str;
    } else {
      // ---- 括号模式 ----
      const kind = ui.rnBracket ? ui.rnBracket.value : 'both';
      const mode = ui.rnMode ? ui.rnMode.value : 'with';
      for (const pair of getRnBracketPairs(kind)) {
        const r = replaceTopLevelBrackets(base, pair[0], pair[1], mode, replacement);
        matched += r.count;
        base = r.str;
      }
    }

    // 规则没命中且不加序号 → 无变化
    if (matched === 0 && !seqCfg) return { changed: false, newName: fullName };

    if (matched > 0) base = base.replace(/ {2,}/g, ' ').trim(); // 连续空格合并、去首尾空格
    if (seqCfg) base = base.trim();
    if (!base) return { changed: true, newName: null, reason: '重命名后名称为空，已跳过' };

    // 加序号前缀（序号加在主名前、扩展名前）
    if (seqCfg) base = seqLabel(seqNum, seqCfg) + base;

    const newName = base + ext;
    return { changed: newName !== fullName, newName: newName };
  }

  // 列表渲染：文件夹 + 文件混合，按类型筛选显示
  function renderRenameList() {
    const el = ui.listRn;
    const b = state.renameBrowse;
    renderBreadcrumb(ui.bcRn, b);
    if (b.loading) { el.innerHTML = '<div class="pp-hint">加载中…</div>'; return; }
    if (b.error) { el.innerHTML = '<div class="pp-hint error">' + esc(b.error) + '</div>'; return; }
    if (!b.data) { el.innerHTML = '<div class="pp-hint">准备就绪</div>'; return; }

    const { folders, files } = filterItems(b);
    const items = [];
    if (state.renameTypeFilter !== 'file') {
      for (const f of folders) items.push({ id: f.id, name: f.name, isFolder: true });
    }
    if (state.renameTypeFilter !== 'folder') {
      for (const f of files) items.push({ id: f.id, name: f.name, isFolder: false, size: f.size, time: f.modified_time });
    }
    if (items.length === 0) {
      const what = state.renameTypeFilter === 'folder' ? '文件夹' : (state.renameTypeFilter === 'file' ? '文件' : '内容');
      el.innerHTML = '<div class="pp-hint">此位置没有' + what + '</div>';
      renderRenameChips();
      return;
    }
    let html = '';
    for (const f of items.slice(0, MAX_LIST_ITEMS)) {
      const picked = state.renameItems.some((x) => x.id === f.id);
      if (f.isFolder) {
        html += '<div class="pp-row folder' + (picked ? ' picked' : '') + '" data-id="' + esc(f.id) + '" data-name="' + esc(f.name) + '" data-kind="folder">' +
          '<span class="pp-pick" data-pick="1">✓</span>' +
          '<span class="ico">📁</span>' +
          '<span class="name" data-enter="1" title="' + esc(f.name) + '">' + esc(f.name) + '</span>' +
          '<span class="arrow" data-enter="1">›</span></div>';
      } else {
        html += '<div class="pp-row file' + (picked ? ' picked' : '') + '" data-id="' + esc(f.id) + '" data-name="' + esc(f.name) + '" data-kind="file">' +
          '<span class="pp-pick" data-pick="1">✓</span>' +
          '<span class="ico">📄</span>' +
          '<span class="name" title="' + esc(f.name) + '">' + esc(f.name) + '</span>' +
          '<span class="meta">' + fmtTime(f.time) + ' · ' + fmtSize(f.size) + '</span>' +
          '<span class="badge">✓</span></div>';
      }
    }
    if (items.length > MAX_LIST_ITEMS) {
      html += '<div class="pp-hint">仅显示前 ' + MAX_LIST_ITEMS + ' 项（共 ' + items.length + ' 项）</div>';
    }
    el.innerHTML = html;
    renderRenameChips();
  }

  function renderRenameChips() {
    const chips = state.renameItems.map((f, i) =>
      '<span class="pp-chip">' + (f.isFolder ? '📁' : '📄') + ' <span class="t" title="' + esc(f.name) + '">' + esc(f.name) +
      '</span><button data-rmrnitem="' + i + '">×</button></span>'
    ).join('');
    ui.rnChips.innerHTML = chips || '<span style="font-size:11px;color:#a9aeb8;">尚未勾选项目</span>';
    updateRenameFooter();
  }

  function updateRenameFooter() {
    const n = state.renameItems.length;
    const pv = state.renamePreview;
    if (state.renameRunning) {
      ui.rnNote.textContent = '正在执行重命名…';
      ui.rnExecute.disabled = true;
      return;
    }
    let canExec = false;
    let note = '';
    if (n === 0) {
      note = '勾选项目并设置规则，先点「预览」看效果，确认后再执行';
    } else if (rnRuleError()) {
      note = '⚠ ' + rnRuleError();
    } else if (!pv) {
      note = '已选 ' + n + ' 项，点击「预览」查看重命名后的名字';
    } else {
      const todo = pv.filter((x) => x.changed && x.newName).length;
      const unchanged = pv.filter((x) => !x.changed).length;
      const empty = pv.filter((x) => x.changed && !x.newName).length;
      note = '已选 ' + n + ' 项：' + todo + ' 项将重命名' +
        (unchanged ? '，' + unchanged + ' 项无变化' : '') +
        (empty ? '，' + empty + ' 项为空已跳过' : '');
      canExec = todo > 0;
    }
    ui.rnNote.textContent = note;
    ui.rnExecute.disabled = !canExec;
    if (canExec) {
      ui.rnExecute.textContent = '✏️ 确认执行重命名（' + pv.filter((x) => x.changed && x.newName).length + '）';
    } else {
      ui.rnExecute.textContent = '✏️ 确认执行重命名';
    }
  }

  // 勾选或规则变化后调用：作废预览
  function invalidateRenamePreview() {
    state.renamePreview = null;
    renderRenamePreview();
  }

  function buildRenamePreview() {
    if (state.renameItems.length === 0) {
      state.renamePreview = null;
      renderRenamePreview();
      return;
    }
    const ruleErr = rnRuleError();
    if (ruleErr) {
      window.alert(ruleErr);
      updateRenameFooter();
      return;
    }
    const seqCfg = getSeqConfig(state.renameItems.length);
    state.renamePreview = state.renameItems.map(function(item, i) {
      const r = applyRenameRule(item.name, item.isFolder, seqCfg, seqCfg ? seqCfg.start + i : 0);
      return {
        id: item.id,
        oldName: item.name,
        isFolder: item.isFolder,
        newName: r.newName,
        changed: r.changed,
        reason: r.reason || null,
        done: null, // null=未执行 | 'ok' | 'fail'
      };
    });
    renderRenamePreview();
  }

  function renderRenamePreview() {
    const el = ui.rnPreview;
    const pv = state.renamePreview;
    if (!pv || pv.length === 0) {
      el.classList.add('hidden');
      el.innerHTML = '';
      updateRenameFooter();
      return;
    }
    el.classList.remove('hidden');
    let html = '';
    for (const p of pv) {
      let cls = '';
      let stateIco = '';
      let newText = '';
      if (p.done === 'ok') { stateIco = '✅'; }
      else if (p.done === 'fail') { stateIco = '❌'; }
      if (!p.done) {
        if (!p.changed) { cls = 'skip'; newText = '无变化'; }
        else if (!p.newName) { cls = 'warn'; newText = '⚠ ' + (p.reason || '已跳过'); }
        else { newText = esc(p.newName); }
      } else {
        newText = p.done === 'ok' ? esc(p.newName) : esc(p.reason || '失败');
        if (p.done === 'fail') cls = 'warn';
      }
      html += '<div class="pp-rn-pv-row' + cls + '">' +
        '<span class="pp-rn-pv-state">' + stateIco + '</span>' +
        '<span class="pp-rn-pv-old" title="' + esc(p.oldName) + '">' + (p.isFolder ? '📁' : '📄') + ' ' + esc(p.oldName) + '</span>' +
        '<span class="pp-rn-pv-arrow">→</span>' +
        '<span class="pp-rn-pv-new" title="' + esc(newText) + '">' + newText + '</span>' +
        '</div>';
    }
    el.innerHTML = html;
    updateRenameFooter();
  }

  async function executeRename() {
    const pv = state.renamePreview;
    if (!pv || state.renameRunning) return;
    const todo = pv.filter((x) => x.changed && x.newName && !x.done);
    if (todo.length === 0) return;
    if (!window.confirm('确定要重命名 ' + todo.length + ' 个项目吗？\n\n此操作会直接修改网盘里的名称，不可撤销。请确认上方预览结果无误。')) return;

    state.renameRunning = true;
    state.renameStopRequested = false;
    ui.rnExecute.disabled = true;
    ui.rnDoPreview.disabled = true;

    let done = 0;
    for (const p of pv) {
      if (!p.changed || !p.newName || p.done) continue;
      if (state.renameStopRequested) break;
      try {
        await renameItem(p.id, p.newName);
        p.done = 'ok';
        p.reason = null;
      } catch (e) {
        p.done = 'fail';
        p.reason = e.message || String(e);
      }
      done++;
      renderRenamePreview();
      ui.rnNote.textContent = '正在重命名 ' + done + ' / ' + todo.length + ' …';
      ui.rnExecute.disabled = true;
      if (done < todo.length) await sleep(400);
    }

    state.renameRunning = false;
    ui.rnDoPreview.disabled = false;
    const okCount = pv.filter((x) => x.done === 'ok').length;
    const failCount = pv.filter((x) => x.done === 'fail').length;
    // 已成功重命名的项目从勾选中移除（名字已经变了）
    state.renameItems = state.renameItems.filter((x) => !pv.some((p) => p.id === x.id && p.done === 'ok'));
    renderRenameChips();
    ui.rnNote.textContent = (state.renameStopRequested ? '已停止：' : '完成：') +
      '成功 ' + okCount + ' 个，失败 ' + failCount + ' 个。列表正在刷新…';
    loadBrowse(state.renameBrowse, renderRenameList);
  }

  function switchPanelMode(mode) {
    state.panelMode = mode;
    // 切 tab 样式
    ui.shadowRoot.querySelectorAll('.pp-panel-tab').forEach(function(btn) {
      btn.classList.toggle('active', btn.dataset.panel === mode);
    });
    // 切内容区
    ui.copyBody.classList.toggle('hidden', mode !== 'copy');
    ui.manageBody.classList.toggle('hidden', mode !== 'manage');
    ui.treeBody.classList.toggle('hidden', mode !== 'tree');
    ui.renameBody.classList.toggle('hidden', mode !== 'rename');
    // 步骤指示器只在 copy 模式显示
    ui.stepsEl.classList.toggle('hidden', mode !== 'copy');
    // 首次进入 manage 模式时加载
    if (mode === 'manage' && !state.manageBrowse.inited) {
      state.manageBrowse.inited = true;
      if (state.browse2.inited && state.browse2.stack.length > 1) {
        state.manageBrowse.stack = state.browse2.stack.map(function(s) { return { id: s.id, name: s.name }; });
      }
      loadBrowse(state.manageBrowse, renderManageList);
    }
    // 首次进入 tree 模式时加载
    if (mode === 'tree' && !state.treeBrowse.inited) {
      state.treeBrowse.inited = true;
      // 复用 browse2 的初始路径
      if (state.browse2.inited && state.browse2.stack.length > 1) {
        state.treeBrowse.stack = state.browse2.stack.map(function(s) { return { id: s.id, name: s.name }; });
      }
      loadBrowse(state.treeBrowse, renderTreeList);
    }
    // 首次进入 rename 模式时加载
    if (mode === 'rename' && !state.renameBrowse.inited) {
      state.renameBrowse.inited = true;
      // 复用 browse2 的初始路径
      if (state.browse2.inited && state.browse2.stack.length > 1) {
        state.renameBrowse.stack = state.browse2.stack.map(function(s) { return { id: s.id, name: s.name }; });
      }
      loadBrowse(state.renameBrowse, renderRenameList);
    }
  }

  function getPaths() {
    return ui.paths.value.split('\n').map((s) => s.trim()).filter(Boolean);
  }

  /* ================================================================
   * 文件整理（移动 / 回收站 / 解压 / 查重）
   * ================================================================ */

  function manageVisibleItems() {
    const b = state.manageBrowse;
    const { folders, files } = filterItems(b);
    const items = [];
    if (state.manageTypeFilter !== 'file') {
      for (const f of folders) items.push({ id: f.id, name: f.name, isFolder: true });
    }
    if (state.manageTypeFilter !== 'folder') {
      for (const f of files) items.push({ id: f.id, name: f.name, isFolder: false, size: f.size, time: f.modified_time, hash: f.hash, gcid: f.gcid, md5: f.md5_checksum, mime: f.mime_type });
    }
    return items;
  }

  function renderManageList() {
    const el = ui.listManage;
    const b = state.manageBrowse;
    renderBreadcrumb(ui.bcManage, b);
    if (b.loading) { el.innerHTML = '<div class="pp-hint">加载中…</div>'; return; }
    if (b.error) { el.innerHTML = '<div class="pp-hint error">' + esc(b.error) + '</div>'; return; }
    if (!b.data) { el.innerHTML = '<div class="pp-hint">准备就绪</div>'; return; }

    const items = manageVisibleItems();
    if (items.length === 0) {
      const what = state.manageTypeFilter === 'folder' ? '文件夹' : (state.manageTypeFilter === 'file' ? '文件' : '内容');
      el.innerHTML = '<div class="pp-hint">此位置没有' + what + '</div>';
      renderManageChips();
      return;
    }
    let html = '';
    for (const f of items.slice(0, MAX_LIST_ITEMS)) {
      const picked = state.manageItems.some((x) => x.id === f.id);
      if (f.isFolder) {
        html += '<div class="pp-row folder' + (picked ? ' picked' : '') + '" data-id="' + esc(f.id) + '" data-name="' + esc(f.name) + '" data-kind="folder">' +
          '<span class="pp-pick" data-pick="1">✓</span>' +
          '<span class="ico">📁</span>' +
          '<span class="name" data-enter="1" title="' + esc(f.name) + '">' + esc(f.name) + '</span>' +
          '<span class="arrow" data-enter="1">›</span></div>';
      } else {
        html += '<div class="pp-row file' + (picked ? ' picked' : '') + '" data-id="' + esc(f.id) + '" data-name="' + esc(f.name) + '" data-kind="file">' +
          '<span class="pp-pick" data-pick="1">✓</span>' +
          '<span class="ico">📄</span>' +
          '<span class="name" title="' + esc(f.name) + '">' + esc(f.name) + '</span>' +
          '<span class="meta">' + fmtTime(f.time) + ' · ' + fmtSize(f.size) + '</span>' +
          '<span class="badge">✓</span></div>';
      }
    }
    if (items.length > MAX_LIST_ITEMS) {
      html += '<div class="pp-hint">仅显示前 ' + MAX_LIST_ITEMS + ' 项（共 ' + items.length + ' 项）</div>';
    }
    el.innerHTML = html;
    renderManageChips();
  }

  function renderManageChips() {
    const chips = state.manageItems.map((f, i) =>
      '<span class="pp-chip">' + (f.isFolder ? '📁' : '📄') + ' <span class="t" title="' + esc(f.name) + '">' + esc(f.name) +
      '</span><button data-rmmanageitem="' + i + '">×</button></span>'
    ).join('');
    ui.manageChips.innerHTML = chips || '<span style="font-size:11px;color:#a9aeb8;">尚未勾选项目</span>';
    updateManageFooter();
  }

  function updateManageFooter() {
    const n = state.manageItems.length;
    const op = state.manageOp;
    if (state.manageRunning) {
      ui.manageNote.textContent = '正在执行…';
      ui.manageExecute.disabled = true;
      return;
    }
    if (op === 'dup') {
      ui.manageNote.textContent = '查重会扫描当前文件夹下的所有文件，按「哈希+大小」分组找出重复项';
      ui.manageExecute.textContent = '🔍 扫描当前文件夹查重';
      ui.manageExecute.disabled = state.dupScanning;
      return;
    }
    let label = op === 'trash' ? '🗑 移到回收站' : '📦 批量解压';
    if (n === 0) {
      ui.manageNote.textContent = '勾选要操作的' + (op === 'unzip' ? '压缩包' : '项目') + '后点「执行」';
      ui.manageExecute.disabled = true;
      ui.manageExecute.textContent = label;
    } else {
      ui.manageNote.textContent = '已选 ' + n + ' 项，将执行：' + (op === 'trash' ? '移到回收站（可恢复）' : '云端解压到所在目录');
      ui.manageExecute.disabled = false;
      ui.manageExecute.textContent = label + '（' + n + '）';
    }
  }

  // 查重：按 哈希+大小 分组，找出组内 >1 的重复项
  function buildDupGroups() {
    const b = state.manageBrowse;
    if (!b.data) return [];
    const allFiles = b.data.files || [];
    const byKey = new Map();
    for (const f of allFiles) {
      const hash = f.gcid || f.md5_checksum || f.hash;
      const key = hash ? (String(hash) + '|' + String(f.size)) : null;
      if (!key) continue; // 无哈希信息的文件跳过（多为未完成/特殊文件）
      if (!byKey.has(key)) byKey.set(key, []);
      byKey.get(key).push(f);
    }
    const groups = [];
    byKey.forEach(function(list) {
      if (list.length > 1) {
        groups.push(list.map(function(f) {
          return { id: f.id, name: f.name, size: f.size, time: f.modified_time };
        }));
      }
    });
    // 组内按修改时间倒序（最新的排前面，作为「保留」候选）
    groups.forEach(function(g) {
      g.sort(function(a, b) { return (b.time || '').localeCompare(a.time || ''); });
    });
    return groups;
  }

  function renderDupGroups() {
    const panel = ui.manageDupPanel;
    const groups = state.dupGroups || [];
    if (groups.length === 0) {
      panel.classList.add('hidden');
      panel.innerHTML = '';
      return;
    }
    panel.classList.remove('hidden');
    let html = '<div class="pp-hint" style="padding:8px;">找到 <b>' + groups.length + '</b> 组重复文件（共 ' +
      groups.reduce(function(s, g) { return s + g.length; }, 0) + ' 个文件）。每组仅保留时间最新的一个，勾选其余重复项移到回收站。</div>';
    groups.forEach(function(g, gi) {
      const base = g[0];
      html += '<div class="pp-sum-head">重复组 ' + (gi + 1) + '：' + esc(base.name) + '（' + fmtSize(base.size) + '，共 ' + g.length + ' 个）</div>';
      g.forEach(function(f, fi) {
        const keep = fi === 0;
        html += '<div class="pp-rn-pv-row' + (keep ? ' skip' : '') + '">' +
          '<span class="pp-rn-pv-state">' + (keep ? '⭐' : '') + '</span>' +
          '<span class="pp-rn-pv-old" title="' + esc(f.name) + '">' + esc(f.name) + '</span>' +
          '<span class="pp-rn-pv-new">' + (keep ? '保留' : '→ 回收站') + '</span>' +
          '</div>';
      });
    });
    html += '<div class="pp-footer" style="margin-top:6px;">' +
      '<button class="pp-btn pp-btn-primary" id="pp-dup-clean">🗑 将重复项（保留组内第一个）移到回收站</button>' +
      '</div>';
    panel.innerHTML = html;
    const cleanBtn = ui.shadowRoot.getElementById('pp-dup-clean');
    if (cleanBtn) cleanBtn.addEventListener('click', executeDupClean);
  }

  async function executeDupClean() {
    const groups = state.dupGroups || [];
    const toDelete = [];
    groups.forEach(function(g) {
      for (let i = 1; i < g.length; i++) toDelete.push(g[i].id);
    });
    if (toDelete.length === 0) return;
    if (!window.confirm('确定要把 ' + toDelete.length + ' 个重复文件移到回收站吗？\n\n每组只保留时间最新的一个，其余全部移入回收站（可恢复）。')) return;

    state.manageRunning = true;
    updateManageFooter();
    // 分批，每批最多 100 个
    const results = [];
    for (let i = 0; i < toDelete.length; i += 100) {
      const chunk = toDelete.slice(i, i + 100);
      try {
        await trashItems(chunk);
        results.push({ label: '第 ' + (i / 100 + 1) + ' 批（' + chunk.length + ' 个）', ok: true, msg: '已移入回收站' });
      } catch (e) {
        results.push({ label: '第 ' + (i / 100 + 1) + ' 批（' + chunk.length + ' 个）', ok: false, msg: e.message || String(e) });
      }
    }
    state.manageRunning = false;
    state.dupGroups = null;
    renderDupGroups();
    updateManageFooter();
    ui.manageNote.textContent = '完成：成功 ' + results.filter((r) => r.ok).length + ' 批，失败 ' +
      results.filter((r) => !r.ok).length + ' 批。列表刷新中…';
    loadBrowse(state.manageBrowse, renderManageList);
  }

  async function executeManage() {
    if (state.manageRunning) return;
    const op = state.manageOp;

    if (op === 'dup') {
      state.dupScanning = true;
      updateManageFooter();
      ui.manageNote.textContent = '正在扫描当前文件夹查重…';
      await sleep(50); // 让 UI 先刷新
      try {
        state.dupGroups = buildDupGroups();
      } catch (e) {
        state.dupGroups = null;
        ui.manageNote.textContent = '查重失败：' + (e.message || String(e));
      }
      state.dupScanning = false;
      renderDupGroups();
      updateManageFooter();
      if (state.dupGroups && state.dupGroups.length === 0) {
        ui.manageNote.textContent = '未发现重复文件（当前文件夹内没有哈希+大小完全相同的文件）';
      }
      return;
    }

    if (state.manageItems.length === 0) return;
    const verb = op === 'trash' ? '移到回收站' : '解压';
    if (!window.confirm('确定要对 ' + state.manageItems.length + ' 个项目执行「' + verb + '」吗？\n\n' +
      (op === 'trash' ? '操作可恢复（回收站里能找到）。' : '解压结果会出现在各压缩包所在目录。'))) return;

    state.manageRunning = true;
    state.manageResults = [];
    updateManageFooter();

    let done = 0;
    for (const item of state.manageItems) {
      try {
        if (op === 'trash') {
          await trashItems([item.id]);
        } else {
          await decompressFile({ id: item.id, gcid: item.gcid, hash: item.hash, md5_checksum: item.md5 });
        }
        state.manageResults.push({ label: item.name, ok: true, msg: op === 'trash' ? '已移入回收站' : '已提交解压' });
      } catch (e) {
        state.manageResults.push({ label: item.name, ok: false, msg: e.message || String(e) });
      }
      done++;
      ui.manageNote.textContent = verb + ' ' + done + ' / ' + state.manageItems.length + ' …';
      if (done < state.manageItems.length) await sleep(400);
    }

    state.manageRunning = false;
    const ok = state.manageResults.filter((r) => r.ok).length;
    const fail = state.manageResults.filter((r) => !r.ok).length;
    // 成功后从勾选中移除
    state.manageItems = state.manageItems.filter((x) => !state.manageResults.some((r) => r.ok && r.label === x.name));
    renderManageChips();
    ui.manageNote.textContent = '完成：成功 ' + ok + ' 个，失败 ' + fail + ' 个。列表刷新中…';
    loadBrowse(state.manageBrowse, renderManageList);
  }

  function renderChips() {
    const chips = [];
    state.folders.forEach((f, i) => {
      chips.push('<span class="pp-chip">📁 <span class="t" title="' + esc(f.name) + '">' + esc(f.name) +
        '</span><button data-rmfolder="' + i + '">×</button></span>');
    });
    getPaths().forEach((p, i) => {
      chips.push('<span class="pp-chip path">🛤 <span class="t" title="' + esc(p) + '">' + esc(p) +
        '</span><button data-rmpath="' + i + '">×</button></span>');
    });
    ui.chips.innerHTML = chips.join('') || '<span style="font-size:11px;color:#a9aeb8;">尚未选择目标文件夹</span>';
    const targetCount = state.folders.length + getPaths().length;
    ui.next2.disabled = targetCount === 0 || state.running;
  }

  function updateStep1Footer() {
    const n = state.files.length;
    const isMove = state.copyMode === 'move';
    const what = isMove ? '项目' : '文件';
    ui.note1.textContent = n === 0
      ? (isMove ? '点击文件夹勾选或进入，点击文件选中' : '点击文件夹进入，点击文件选中')
      : '已选 ' + n + ' 个' + what + '：' + state.files.map((f) => f.name).join('、');
    ui.next1.disabled = n === 0;
  }

  function setStep(n) {
    state.step = n;
    for (const i of [1, 2, 3]) {
      $('pp-page' + i).classList.toggle('hidden', i !== n);
    }
    ui.shadowRoot.querySelectorAll('.pp-step').forEach((el) => {
      const s = Number(el.dataset.n);
      el.classList.toggle('active', s === n);
      el.classList.toggle('done', s < n);
    });
    if (n === 3) renderSummary();
  }

  function renderSummary() {
    const files = state.files;
    const paths = getPaths();
    const folders = state.folders;
    const targetCount = folders.length + paths.length;
    const ops = files.length * targetCount;
    const verb = state.copyMode === 'move' ? '移动' : '复制';
    const verbN = state.copyMode === 'move' ? '移动' : '复制';

    let html = '<div class="pp-sum-line">将把 <b>' + files.length + '</b> 个' + (state.copyMode === 'move' ? '项目' : '文件') + verb + '到 <b>' + targetCount +
      '</b> 个目标文件夹（共 <b>' + ops + '</b> 次' + verbN + '操作）</div>';

    html += '<div class="pp-sum-head">源' + (state.copyMode === 'move' ? '项目' : '文件') + '</div>';
    html += files.map((f) => '<div class="pp-sum-item">' + (f.isFolder ? '📁' : '📄') + ' ' + esc(f.name) + '</div>').join('') ||
      '<div class="pp-sum-item"><i>（无）</i></div>';

    html += '<div class="pp-sum-head">目标文件夹</div>';
    let targetHtml = folders.map((f) => '<div class="pp-sum-item">📁 ' + esc(f.name) + '</div>').join('');
    targetHtml += paths.map((p) => {
      const rel = p.startsWith('/') ? '' : ' <i>（相对当前浏览目录）</i>';
      return '<div class="pp-sum-item">🛤 ' + esc(p) + rel + '</div>';
    }).join('');
    html += targetHtml || '<div class="pp-sum-item" style="color:#f53f3f;">尚未选择任何目标文件夹</div>';

    if (files.length > 1) {
      html += '<div class="pp-sum-head" style="color:#ff7d00;">提示：源文件多于 1 个时，每个目标文件夹都会收到全部所选文件。</div>';
    }
    ui.summary.innerHTML = html;
  }

  function updateProgress(text, done, total) {
    ui.progress.classList.remove('hidden');
    ui.progressFill.style.width = (total > 0 ? Math.round((done / total) * 100) : 0) + '%';
    ui.progressText.textContent = text + (total > 0 ? '（' + done + ' / ' + total + '）' : '');
  }

  function renderResults() {
    const items = state.results.map((r) =>
      '<div class="pp-result ' + (r.ok ? 'ok' : 'fail') + '">' +
      '<span>' + (r.ok ? '✅' : '❌') + '</span>' +
      '<span class="pp-result-name" title="' + esc(r.label) + '">' + esc(r.label) + '</span>' +
      '<span class="pp-result-msg">' + esc(r.msg || '') + '</span></div>'
    ).join('');
    const okCount = state.results.filter((r) => r.ok).length;
    const failCount = state.results.length - okCount;
    let head = '';
    if (state.stopRequested) head += '<div class="pp-hint warn">已手动停止</div>';
    head += '<div class="pp-hint' + (failCount > 0 ? ' warn' : '') + '">完成：成功 ' + okCount + ' 个，失败 ' + failCount + ' 个。如网页未即时显示，请刷新页面。</div>';
    ui.results.innerHTML = head + items;
    ui.results.classList.remove('hidden');
  }

  /* ================================================================
   * 目录加载
   * ================================================================ */
  async function loadBrowse(b, renderFn) {
    const token = ++b.loadToken;
    b.loading = true;
    b.error = null;
    b.data = null;
    renderFn();
    try {
      const current = b.stack[b.stack.length - 1];
      const data = await listFiles(current.id);
      if (token !== b.loadToken) return;
      b.data = data;
    } catch (e) {
      if (token !== b.loadToken) return;
      b.error = e.message || String(e);
    }
    b.loading = false;
    renderFn();
  }

  function enterFolder(b, folder, renderFn) {
    b.stack.push({ id: folder.id, name: folder.name });
    loadBrowse(b, renderFn);
  }

  /* ================================================================
   * 从网页 URL 猜测当前文件夹（尽力而为，失败则从根目录开始）
   * ================================================================ */
  function guessInitialFolder() {
    try {
      const keys = ['fid', 'fileId', 'file_id', 'parentId', 'parent_id', 'folderId', 'folder_id', 'id'];
      const check = (params) => {
        for (const k of keys) {
          const v = params.get(k);
          if (v && /^[A-Za-z0-9_-]{8,}$/.test(v)) return v;
        }
        return '';
      };
      const u = new URL(location.href);
      let v = check(u.searchParams);
      if (v) return v;
      const hashQuery = (location.hash || '').split('?')[1] || '';
      if (hashQuery) {
        v = check(new URLSearchParams(hashQuery));
        if (v) return v;
      }
    } catch (e) { /* 忽略 */ }
    return '';
  }

  /* ================================================================
   * 执行复制
   * ================================================================ */
  async function startCopy() {
    if (state.running) return;
    const fileIds = state.files.map((f) => f.id);
    const paths = getPaths();
    const targets = state.folders.map((f) => ({ id: f.id, label: f.name }));
    if (fileIds.length === 0 || (targets.length === 0 && paths.length === 0)) return;

    state.running = true;
    state.stopRequested = false;
    state.results = [];
    ui.start.classList.add('hidden');
    ui.stop.classList.remove('hidden');
    ui.back3.disabled = true;
    ui.results.classList.add('hidden');
    ui.results.innerHTML = '';
    ui.progressFill.style.width = '0%';

    // 1) 解析路径输入：逐级查找/创建，得到目标文件夹
    for (const p of paths) {
      if (state.stopRequested) break;
      try {
        updateProgress('正在解析路径 ' + p, 0, 0);
        const isAbs = p.startsWith('/');
        const startId = isAbs ? '' : state.browse2.stack[state.browse2.stack.length - 1].id;
        const parts = p.split('/').map((s) => s.trim()).filter(Boolean);
        if (parts.length === 0) continue;
        const id = await ensureFolderPath(parts, startId);
        if (!targets.some((t) => t.id === id)) {
          targets.push({ id: id, label: parts.join('/') });
        }
      } catch (e) {
        state.results.push({ label: p, ok: false, msg: '路径创建失败：' + (e.message || e) });
      }
    }

    // 2) 逐个目标执行（串行 + 间隔，避免触发风控）
    const action = state.copyMode === 'move' ? moveToFolder : copyToFolder;
    const verb = state.copyMode === 'move' ? '移动成功' : '复制成功';
    const verbing = state.copyMode === 'move' ? '正在移动' : '正在复制';
    let done = 0;
    for (const t of targets) {
      if (state.stopRequested) break;
      try {
        await action(fileIds, t.id);
        state.results.push({ label: t.label, ok: true, msg: verb });
      } catch (e) {
        state.results.push({ label: t.label, ok: false, msg: e.message || String(e) });
      }
      done++;
      updateProgress(verbing, done, targets.length);
      if (done < targets.length && !state.stopRequested) {
        await sleep(COPY_INTERVAL_MS);
      }
    }

    state.running = false;
    ui.stop.classList.add('hidden');
    ui.start.classList.remove('hidden');
    ui.back3.disabled = false;
    ui.start.textContent = '再次' + (state.copyMode === 'move' ? '移动' : '复制');
    ui.progressText.textContent = state.stopRequested ? '已停止' : '全部完成';
    renderResults();
  }

  /* ================================================================
   * 事件绑定
   * ================================================================ */
  function bindEvents() {
    ui.fab.addEventListener('click', openPanel);
    ui.close.addEventListener('click', closePanel);

    ui.reset.addEventListener('click', () => {
      state.files = [];
      state.folders = [];
      state.results = [];
      state.running = false;
      state.stopRequested = false;
      ui.paths.value = '';
      ui.start.textContent = '开始复制';
      ui.progress.classList.add('hidden');
      ui.results.classList.add('hidden');
      updateStep1Footer();
      renderStep2List();
      setStep(1);
    });

    // 面包屑导航
    ui.bc1.addEventListener('click', (e) => {
      const el = e.target.closest('.pp-crumb');
      if (!el || el.classList.contains('cur')) return;
      state.browse1.stack = state.browse1.stack.slice(0, Number(el.dataset.i) + 1);
      loadBrowse(state.browse1, renderStep1List);
    });
    ui.bc2.addEventListener('click', (e) => {
      const el = e.target.closest('.pp-crumb');
      if (!el || el.classList.contains('cur')) return;
      state.browse2.stack = state.browse2.stack.slice(0, Number(el.dataset.i) + 1);
      loadBrowse(state.browse2, renderStep2List);
    });

    // 筛选
    ui.search1.addEventListener('input', () => {
      state.browse1.filter = ui.search1.value;
      renderStep1List();
    });
    ui.search2.addEventListener('input', () => {
      state.browse2.filter = ui.search2.value;
      renderStep2List();
    });

    // 第 1 步列表：文件夹进入 / 文件勾选；移动模式下文件夹也可勾选
    ui.list1.addEventListener('click', (e) => {
      const row = e.target.closest('.pp-row');
      if (!row) return;
      const isPick = e.target.closest('[data-pick]');
      const isEnter = e.target.closest('[data-enter]');
      const isFolder = row.classList.contains('folder');
      if (isPick) {
        // 点勾选块：勾选/取消（文件夹、文件都支持）
        const id = row.dataset.id;
        const idx = state.files.findIndex((x) => x.id === id);
        if (idx >= 0) {
          state.files.splice(idx, 1);
        } else {
          state.files.push({ id: id, name: row.dataset.name, isFolder: isFolder });
        }
        renderStep1List();
        return;
      }
      if (isFolder) {
        // 点文件夹名称/箭头 → 进入子文件夹（无论复制/移动模式）
        enterFolder(state.browse1, { id: row.dataset.id, name: row.dataset.name }, renderStep1List);
      } else {
        // 文件行非勾选区域 → 整行勾选切换
        const id = row.dataset.id;
        const idx = state.files.findIndex((x) => x.id === id);
        if (idx >= 0) state.files.splice(idx, 1);
        else state.files.push({ id: id, name: row.dataset.name, isFolder: false });
        renderStep1List();
      }
    });

    // 第 2 步列表：勾选 / 进入
    ui.list2.addEventListener('click', (e) => {
      const row = e.target.closest('.pp-row');
      if (!row) return;
      const isPick = e.target.closest('[data-pick]');
      if (isPick || !e.target.closest('[data-enter]')) {
        const id = row.dataset.id;
        const idx = state.folders.findIndex((x) => x.id === id);
        if (idx >= 0) {
          state.folders.splice(idx, 1);
        } else {
          state.folders.push({ id: id, name: row.dataset.name });
        }
        renderStep2List();
      } else {
        enterFolder(state.browse2, { id: row.dataset.id, name: row.dataset.name }, renderStep2List);
      }
    });

    // 全选当前列表中的文件夹
    ui.selectAll2.addEventListener('click', () => {
      if (!state.browse2.data) return;
      const { folders } = filterItems(state.browse2);
      for (const f of folders) {
        if (!state.folders.some((x) => x.id === f.id)) {
          state.folders.push({ id: f.id, name: f.name });
        }
      }
      renderStep2List();
    });

    // 反选当前列表中的文件夹
    ui.invert2.addEventListener('click', () => {
      if (!state.browse2.data) return;
      const { folders } = filterItems(state.browse2);
      for (const f of folders) {
        const idx = state.folders.findIndex((x) => x.id === f.id);
        if (idx >= 0) {
          state.folders.splice(idx, 1);
        } else {
          state.folders.push({ id: f.id, name: f.name });
        }
      }
      renderStep2List();
    });

    // ---- 面板模式切换 ----
    ui.shadowRoot.querySelectorAll('.pp-panel-tab').forEach((btn) => {
      btn.addEventListener('click', () => switchPanelMode(btn.dataset.panel));
    });

    /* ---- 文件整理模式 ---- */

    // 面包屑导航
    ui.bcManage.addEventListener('click', (e) => {
      const el = e.target.closest('.pp-crumb');
      if (!el || el.classList.contains('cur')) return;
      state.manageBrowse.stack = state.manageBrowse.stack.slice(0, Number(el.dataset.i) + 1);
      loadBrowse(state.manageBrowse, renderManageList);
    });

    // 筛选
    ui.searchManage.addEventListener('input', () => {
      state.manageBrowse.filter = ui.searchManage.value;
      renderManageList();
    });

    // 类型筛选
    ui.manageType.addEventListener('change', () => {
      state.manageTypeFilter = ui.manageType.value;
      renderManageList();
    });

    // 操作类型切换
    ui.manageOp.addEventListener('change', () => {
      state.manageOp = ui.manageOp.value;
      state.manageItems = [];
      state.dupGroups = null;
      renderDupGroups();
      renderManageChips();
    });

    // 列表点击：勾选 / 进入文件夹
    ui.listManage.addEventListener('click', (e) => {
      const row = e.target.closest('.pp-row');
      if (!row) return;
      const isPick = e.target.closest('[data-pick]');
      const isEnter = e.target.closest('[data-enter]');
      if (isPick || !isEnter) {
        const id = row.dataset.id;
        const idx = state.manageItems.findIndex((x) => x.id === id);
        if (idx >= 0) {
          state.manageItems.splice(idx, 1);
        } else {
          const isFolder = row.dataset.kind === 'folder';
          state.manageItems.push({ id: id, name: row.dataset.name, isFolder: isFolder });
        }
        renderManageList();
      } else if (row.dataset.kind === 'folder') {
        enterFolder(state.manageBrowse, { id: row.dataset.id, name: row.dataset.name }, renderManageList);
      }
    });

    // 全选 / 反选
    ui.manageSelectAll.addEventListener('click', () => {
      const items = manageVisibleItems();
      for (const it of items) {
        if (!state.manageItems.some((x) => x.id === it.id)) state.manageItems.push({ id: it.id, name: it.name, isFolder: it.isFolder, gcid: it.gcid, hash: it.hash, md5: it.md5 });
      }
      renderManageList();
    });
    ui.manageInvert.addEventListener('click', () => {
      const items = manageVisibleItems();
      for (const it of items) {
        const idx = state.manageItems.findIndex((x) => x.id === it.id);
        if (idx >= 0) state.manageItems.splice(idx, 1);
        else state.manageItems.push({ id: it.id, name: it.name, isFolder: it.isFolder, gcid: it.gcid, hash: it.hash, md5: it.md5 });
      }
      renderManageList();
    });

    // 已选标签删除
    ui.manageChips.addEventListener('click', (e) => {
      const rm = e.target.closest('[data-rmmanageitem]');
      if (rm) {
        state.manageItems.splice(Number(rm.dataset.rmmanageitem), 1);
        renderManageChips();
        renderManageList();
      }
    });

    // 执行
    ui.manageExecute.addEventListener('click', executeManage);

    // ---- 导出目录树模式：面包屑导航 ----
    ui.bcTree.addEventListener('click', (e) => {
      const el = e.target.closest('.pp-crumb');
      if (!el || el.classList.contains('cur')) return;
      state.treeBrowse.stack = state.treeBrowse.stack.slice(0, Number(el.dataset.i) + 1);
      loadBrowse(state.treeBrowse, renderTreeList);
    });

    // ---- 导出目录树模式：筛选 ----
    ui.searchTree.addEventListener('input', () => {
      state.treeBrowse.filter = ui.searchTree.value;
      renderTreeList();
    });

    // ---- 导出目录树模式：列表点击（勾选 / 进入 / 导出）----
    ui.listTree.addEventListener('click', (e) => {
      const row = e.target.closest('.pp-row');
      if (!row) return;

      // 行内「导出」按钮（单独导出此文件夹）
      const exportBtn = e.target.closest('[data-export]');
      if (exportBtn) {
        e.stopPropagation();
        exportFolderTree(row.dataset.id, row.dataset.name);
        return;
      }

      const isPick = e.target.closest('[data-pick]');
      if (isPick || !e.target.closest('[data-enter]')) {
        // 勾选 / 取消勾选
        const id = row.dataset.id;
        const idx = state.treeFolders.findIndex((x) => x.id === id);
        if (idx >= 0) {
          state.treeFolders.splice(idx, 1);
        } else {
          state.treeFolders.push({ id: id, name: row.dataset.name });
        }
        renderTreeList();
      } else {
        // 进入文件夹
        enterFolder(state.treeBrowse, { id: row.dataset.id, name: row.dataset.name }, renderTreeList);
      }
    });

    // 全选当前列表中的文件夹
    ui.treeSelectAll.addEventListener('click', () => {
      if (!state.treeBrowse.data) return;
      const { folders } = filterItems(state.treeBrowse);
      for (const f of folders) {
        if (!state.treeFolders.some((x) => x.id === f.id)) {
          state.treeFolders.push({ id: f.id, name: f.name });
        }
      }
      renderTreeList();
    });

    // 反选当前列表中的文件夹
    ui.treeInvert.addEventListener('click', () => {
      if (!state.treeBrowse.data) return;
      const { folders } = filterItems(state.treeBrowse);
      for (const f of folders) {
        const idx = state.treeFolders.findIndex((x) => x.id === f.id);
        if (idx >= 0) {
          state.treeFolders.splice(idx, 1);
        } else {
          state.treeFolders.push({ id: f.id, name: f.name });
        }
      }
      renderTreeList();
    });

    // 已选标签删除
    ui.treeChips.addEventListener('click', (e) => {
      const rm = e.target.closest('[data-rmtreefolder]');
      if (rm) {
        state.treeFolders.splice(Number(rm.dataset.rmtreefolder), 1);
        renderTreeList();
      }
    });

    // 导出选中目录树
    ui.exportSelected.addEventListener('click', exportSelectedTrees);

    // 扫描深度选择
    ui.treeDepth.addEventListener('change', () => {
      const v = parseInt(ui.treeDepth.value, 10);
      state.treeDepth = isNaN(v) || v < 1 ? 1 : v;
    });

    // 导出格式选择（TXT / PNG）
    ui.treeFormat.addEventListener('change', () => {
      state.treeFormat = ui.treeFormat.value === 'png' ? 'png' : 'txt';
    });

    // 停止扫描
    ui.stopScan.addEventListener('click', () => {
      state.treeExportStopping = true;
      ui.stopScan.classList.add('hidden');
      if (ui.exportStatus) ui.exportStatus.textContent = '正在停止…';
    });

    /* ---- 批量重命名模式 ---- */

    // 面包屑导航
    ui.bcRn.addEventListener('click', (e) => {
      const el = e.target.closest('.pp-crumb');
      if (!el || el.classList.contains('cur')) return;
      state.renameBrowse.stack = state.renameBrowse.stack.slice(0, Number(el.dataset.i) + 1);
      loadBrowse(state.renameBrowse, renderRenameList);
    });

    // 筛选
    ui.searchRn.addEventListener('input', () => {
      state.renameBrowse.filter = ui.searchRn.value;
      renderRenameList();
    });

    // 类型筛选（全部 / 仅文件夹 / 仅文件）
    ui.rnType.addEventListener('change', () => {
      state.renameTypeFilter = ui.rnType.value;
      renderRenameList();
    });

    // 列表点击：勾选 / 进入文件夹
    ui.listRn.addEventListener('click', (e) => {
      const row = e.target.closest('.pp-row');
      if (!row) return;
      const isPick = e.target.closest('[data-pick]');
      const isEnter = e.target.closest('[data-enter]');
      if (isPick || !isEnter) {
        const id = row.dataset.id;
        const idx = state.renameItems.findIndex((x) => x.id === id);
        if (idx >= 0) {
          state.renameItems.splice(idx, 1);
        } else {
          state.renameItems.push({ id: id, name: row.dataset.name, isFolder: row.dataset.kind === 'folder' });
        }
        invalidateRenamePreview();
        renderRenameList();
      } else if (row.dataset.kind === 'folder') {
        enterFolder(state.renameBrowse, { id: row.dataset.id, name: row.dataset.name }, renderRenameList);
      }
    });

    // 全选当前列表（按类型筛选后的可见项）
    ui.rnSelectAll.addEventListener('click', () => {
      if (!state.renameBrowse.data) return;
      const { folders, files } = filterItems(state.renameBrowse);
      const items = [];
      if (state.renameTypeFilter !== 'file') {
        for (const f of folders) items.push({ id: f.id, name: f.name, isFolder: true });
      }
      if (state.renameTypeFilter !== 'folder') {
        for (const f of files) items.push({ id: f.id, name: f.name, isFolder: false });
      }
      for (const it of items) {
        if (!state.renameItems.some((x) => x.id === it.id)) state.renameItems.push(it);
      }
      invalidateRenamePreview();
      renderRenameList();
    });

    // 反选当前列表
    ui.rnInvert.addEventListener('click', () => {
      if (!state.renameBrowse.data) return;
      const { folders, files } = filterItems(state.renameBrowse);
      const items = [];
      if (state.renameTypeFilter !== 'file') {
        for (const f of folders) items.push({ id: f.id, name: f.name, isFolder: true });
      }
      if (state.renameTypeFilter !== 'folder') {
        for (const f of files) items.push({ id: f.id, name: f.name, isFolder: false });
      }
      for (const it of items) {
        const idx = state.renameItems.findIndex((x) => x.id === it.id);
        if (idx >= 0) state.renameItems.splice(idx, 1);
        else state.renameItems.push(it);
      }
      invalidateRenamePreview();
      renderRenameList();
    });

    // 已选标签删除
    ui.rnChips.addEventListener('click', (e) => {
      const rm = e.target.closest('[data-rmrnitem]');
      if (rm) {
        state.renameItems.splice(Number(rm.dataset.rmrnitem), 1);
        invalidateRenamePreview();
        renderRenameList();
      }
    });

    // 规则变化 → 预览作废
    ui.rnBracket.addEventListener('change', invalidateRenamePreview);
    ui.rnMode.addEventListener('change', invalidateRenamePreview);
    ui.rnReplace.addEventListener('input', invalidateRenamePreview);
    // 规则类型切换：括号 / 关键字 / 位置，显示对应设置
    ui.rnRule.addEventListener('change', () => {
      const v = ui.rnRule.value;
      ui.rnBracketBox.classList.toggle('hidden', v !== 'bracket');
      ui.rnKeywordBox.classList.toggle('hidden', v !== 'keyword');
      ui.rnPositionBox.classList.toggle('hidden', v !== 'position');
      invalidateRenamePreview();
    });
    ui.rnKeyword.addEventListener('input', invalidateRenamePreview);

    // 位置删除模式：切换子选项显示
    function syncPosModeRows() {
      const between = ui.rnPosMode.value === 'between';
      ui.rnPosMarkRow.classList.toggle('hidden', between);
      ui.rnPosBetweenRow.classList.toggle('hidden', !between);
      ui.rnPosWhichRow.classList.toggle('hidden', between);
    }
    ui.rnPosMode.addEventListener('change', () => { syncPosModeRows(); invalidateRenamePreview(); });
    ui.rnPosMark.addEventListener('input', invalidateRenamePreview);
    ui.rnPosMarkA.addEventListener('input', invalidateRenamePreview);
    ui.rnPosMarkB.addEventListener('input', invalidateRenamePreview);
    ui.rnPosWhich.addEventListener('change', invalidateRenamePreview);
    ui.rnPosInclude.addEventListener('change', invalidateRenamePreview);

    // 序号开关 / 样式 / 起始值
    ui.rnSeq.addEventListener('change', () => {
      ui.rnSeqOpts.classList.toggle('hidden', !ui.rnSeq.checked);
      invalidateRenamePreview();
    });
    ui.rnSeqFmt.addEventListener('change', invalidateRenamePreview);
    ui.rnSeqStart.addEventListener('input', invalidateRenamePreview);

    // 预览 / 执行
    ui.rnDoPreview.addEventListener('click', buildRenamePreview);
    ui.rnExecute.addEventListener('click', executeRename);

    // 模式切换（复制 / 移动）
    ui.shadowRoot.querySelectorAll('.pp-mode').forEach((btn) => {
      btn.addEventListener('click', () => {
        const m = btn.dataset.m || btn.dataset.cm;
        if (!m) return;
        // 复制 tab 的「复制/移动」切换
        if (btn.dataset.cm) {
          state.copyMode = btn.dataset.cm;
          ui.shadowRoot.querySelectorAll('[data-cm]').forEach((b2) => {
            b2.classList.toggle('active', b2 === btn);
          });
          // 移动模式清空已选（避免文件里混入文件夹时状态混乱）
          state.files = [];
          updateStep1Footer();
          renderStep1List();
          if (state.step === 3) renderSummary();
          return;
        }
        // 复制第 2 步的「浏览/路径」切换
        state.mode = btn.dataset.m;
        ui.shadowRoot.querySelectorAll('.pp-mode[data-m]').forEach((b2) => {
          b2.classList.toggle('active', b2 === btn);
        });
        ui.modeBrowse.classList.toggle('hidden', state.mode !== 'browse');
        ui.modePath.classList.toggle('hidden', state.mode !== 'path');
        renderChips();
      });
    });

    // 路径输入
    ui.paths.addEventListener('input', renderChips);

    // 已选标签的删除
    ui.chips.addEventListener('click', (e) => {
      const rmFolder = e.target.closest('[data-rmfolder]');
      const rmPath = e.target.closest('[data-rmpath]');
      if (rmFolder) {
        state.folders.splice(Number(rmFolder.dataset.rmfolder), 1);
        renderStep2List();
      } else if (rmPath) {
        const paths = getPaths();
        paths.splice(Number(rmPath.dataset.rmpath), 1);
        ui.paths.value = paths.join('\n');
        renderChips();
      }
    });

    // 步骤跳转
    ui.next1.addEventListener('click', () => {
      if (!state.browse2.inited) {
        state.browse2.inited = true;
        loadBrowse(state.browse2, renderStep2List);
      }
      setStep(2);
    });
    ui.back2.addEventListener('click', () => setStep(1));
    ui.next2.addEventListener('click', () => setStep(3));
    ui.back3.addEventListener('click', () => setStep(2));

    // 高级：按 ID 添加文件
    ui.addIds.addEventListener('click', async () => {
      const ids = ui.pasteIds.value.split('\n').map((s) => s.trim()).filter(Boolean);
      if (ids.length === 0) return;
      let added = 0;
      for (const id of ids) {
        if (state.files.some((x) => x.id === id)) continue;
        try {
          const info = await getFileInfo(id);
          if (info && info.id) {
            state.files.push({ id: info.id, name: info.name || id });
            added++;
          }
        } catch (e) {
          // 校验失败则按原样添加（ID 保留，名称用 ID 显示）
          state.files.push({ id: id, name: 'ID: ' + id });
          added++;
        }
      }
      ui.pasteIds.value = '';
      updateStep1Footer();
      renderStep1List();
    });

    // 执行
    ui.start.addEventListener('click', startCopy);
    ui.stop.addEventListener('click', () => {
      state.stopRequested = true;
      ui.stop.disabled = true;
      ui.stop.textContent = '正在停止…';
      setTimeout(() => { ui.stop.disabled = false; ui.stop.textContent = '停止'; }, 1500);
    });
  }

  /* ================================================================
   * 悬浮窗位置 / 大小（拖动标题栏 + 右下角缩放，自动记忆）
   * ================================================================ */
  const GEOM_KEY = 'pp_panel_geom_v1';

  function savePanelGeom() {
    try {
      const r = ui.panel.getBoundingClientRect();
      localStorage.setItem(GEOM_KEY, JSON.stringify({
        left: Math.round(r.left), top: Math.round(r.top),
        width: Math.round(ui.panel.offsetWidth), height: Math.round(ui.panel.offsetHeight),
      }));
    } catch (e) {}
  }

  function applySavedGeom() {
    let g = null;
    try { g = JSON.parse(localStorage.getItem(GEOM_KEY) || 'null'); } catch (e) {}
    if (!g) return;
    const vw = window.innerWidth, vh = window.innerHeight;
    const w = Math.min(Math.max(g.width || 480, 380), vw - 16);
    const h = Math.min(Math.max(g.height || 640, 400), vh - 16);
    const l = Math.min(Math.max(g.left != null ? g.left : vw - w - 24, 0), vw - 80);
    const t = Math.min(Math.max(g.top != null ? g.top : 24, 0), vh - 40);
    ui.panel.style.left = l + 'px';
    ui.panel.style.top = t + 'px';
    ui.panel.style.width = w + 'px';
    ui.panel.style.height = h + 'px';
    ui.panel.style.right = 'auto';
    ui.panel.style.bottom = 'auto';
  }

  function resetPanelGeom() {
    try { localStorage.removeItem(GEOM_KEY); } catch (e) {}
    ui.panel.style.left = '';
    ui.panel.style.top = '';
    ui.panel.style.width = '';
    ui.panel.style.height = '';
    ui.panel.style.right = '';
    ui.panel.style.bottom = '';
  }

  function initPanelGestures() {
    const panel = ui.panel;
    const header = ui.header;

    // ---- 标题栏拖动 ----
    header.addEventListener('mousedown', (e) => {
      if (e.button !== 0) return;
      if (e.target.closest('button')) return; // 按钮不触发拖动
      const rect = panel.getBoundingClientRect();
      panel.style.left = rect.left + 'px';
      panel.style.top = rect.top + 'px';
      panel.style.right = 'auto';
      panel.style.bottom = 'auto';
      const sx = e.clientX, sy = e.clientY, ox = rect.left, oy = rect.top;
      e.preventDefault();
      const move = (ev) => {
        const nl = Math.max(-panel.offsetWidth + 90, Math.min(ox + ev.clientX - sx, window.innerWidth - 90));
        const nt = Math.max(0, Math.min(oy + ev.clientY - sy, window.innerHeight - 48));
        panel.style.left = nl + 'px';
        panel.style.top = nt + 'px';
      };
      const up = () => {
        document.removeEventListener('mousemove', move);
        document.removeEventListener('mouseup', up);
        savePanelGeom();
      };
      document.addEventListener('mousemove', move);
      document.addEventListener('mouseup', up);
    });

    // 双击标题栏复位位置
    header.addEventListener('dblclick', (e) => {
      if (e.target.closest('button')) return;
      resetPanelGeom();
    });

    // ---- 右下角缩放 ----
    ui.resize.addEventListener('mousedown', (e) => {
      if (e.button !== 0) return;
      const sx = e.clientX, sy = e.clientY;
      const sw = panel.offsetWidth, sh = panel.offsetHeight;
      e.preventDefault();
      const move = (ev) => {
        const w = Math.max(380, Math.min(sw + ev.clientX - sx, window.innerWidth - 16));
        const h = Math.max(400, Math.min(sh + ev.clientY - sy, window.innerHeight - 16));
        panel.style.width = w + 'px';
        panel.style.height = h + 'px';
      };
      const up = () => {
        document.removeEventListener('mousemove', move);
        document.removeEventListener('mouseup', up);
        savePanelGeom();
      };
      document.addEventListener('mousemove', move);
      document.addEventListener('mouseup', up);
    });
  }

  /* ================================================================
   * 面板开关
   * ================================================================ */
  async function openPanel() {
    ui.panel.classList.remove('hidden');
    ui.fab.classList.add('hidden');
    if (state.inited) return;
    state.inited = true;

    const cred = readCredentials();
    if (!cred) {
      ui.list1.innerHTML = '<div class="pp-hint error">未检测到登录凭证。<br>请先在网页上登录 PikPak，再打开本助手。</div>';
      ui.list2.innerHTML = '<div class="pp-hint error">未检测到登录凭证。</div>';
      ui.listTree.innerHTML = '<div class="pp-hint error">未检测到登录凭证。</div>';
      ui.listRn.innerHTML = '<div class="pp-hint error">未检测到登录凭证。</div>';
      return;
    }

    // 尝试从网页 URL 定位当前浏览的文件夹
    const initId = guessInitialFolder();
    if (initId) {
      try {
        const info = await getFileInfo(initId);
        if (info && info.kind === 'drive#folder' && info.id) {
          const entry = { id: info.id, name: info.name || '当前文件夹' };
          state.browse1.stack = [{ id: '', name: '根目录' }, entry];
          state.browse2.stack = [{ id: '', name: '根目录' }, entry];
          state.treeBrowse.stack = [{ id: '', name: '根目录' }, entry];
          state.renameBrowse.stack = [{ id: '', name: '根目录' }, entry];
        }
      } catch (e) { /* 回退到根目录 */ }
    }

    loadBrowse(state.browse1, renderStep1List);
    loadBrowse(state.browse2, renderStep2List);
    state.browse2.inited = true;
  }

  function closePanel() {
    ui.panel.classList.add('hidden');
    ui.fab.classList.remove('hidden');
  }

  /* ================================================================
   * 启动
   * ================================================================ */
  function init() {
    installFetchHook(); // 必须在发起任何 PikPak API 请求前安装

    const host = document.createElement('div');
    host.id = 'pp-batch-copy-host';
    document.documentElement.appendChild(host);
    const shadowRoot = host.attachShadow({ mode: 'open' });
    shadowRoot.innerHTML = HTML;

    ui = {
      shadowRoot: shadowRoot,
      fab: shadowRoot.getElementById('pp-fab'),
      panel: shadowRoot.getElementById('pp-panel'),
      close: shadowRoot.getElementById('pp-close'),
      reset: shadowRoot.getElementById('pp-reset'),
      bc1: shadowRoot.getElementById('pp-bc1'),
      bc2: shadowRoot.getElementById('pp-bc2'),
      search1: shadowRoot.getElementById('pp-search1'),
      search2: shadowRoot.getElementById('pp-search2'),
      list1: shadowRoot.getElementById('pp-list1'),
      list2: shadowRoot.getElementById('pp-list2'),
      pasteIds: shadowRoot.getElementById('pp-pasteids'),
      addIds: shadowRoot.getElementById('pp-addids'),
      note1: shadowRoot.getElementById('pp-note1'),
      next1: shadowRoot.getElementById('pp-next1'),
      back2: shadowRoot.getElementById('pp-back2'),
      next2: shadowRoot.getElementById('pp-next2'),
      selectAll2: shadowRoot.getElementById('pp-selectall2'),
      invert2: shadowRoot.getElementById('pp-invert2'),
      stepsEl: shadowRoot.getElementById('pp-steps'),
      copyBody: shadowRoot.getElementById('pp-copy-body'),
      treeBody: shadowRoot.getElementById('pp-tree-body'),
      bcTree: shadowRoot.getElementById('pp-bc-tree'),
      searchTree: shadowRoot.getElementById('pp-search-tree'),
      listTree: shadowRoot.getElementById('pp-list-tree'),
      treeDepth: shadowRoot.getElementById('pp-tree-depth'),
      treeSelectAll: shadowRoot.getElementById('pp-tree-selectall'),
      treeInvert: shadowRoot.getElementById('pp-tree-invert'),
      treeChips: shadowRoot.getElementById('pp-tree-chips'),
      exportSelected: shadowRoot.getElementById('pp-export-selected'),
      stopScan: shadowRoot.getElementById('pp-stop-scan'),
      exportOverlay: shadowRoot.getElementById('pp-export-overlay'),
      exportStatus: shadowRoot.getElementById('pp-export-status'),
      renameBody: shadowRoot.getElementById('pp-rename-body'),
      bcRn: shadowRoot.getElementById('pp-bc-rn'),
      searchRn: shadowRoot.getElementById('pp-search-rn'),
      listRn: shadowRoot.getElementById('pp-list-rn'),
      rnType: shadowRoot.getElementById('pp-rn-type'),
      rnSelectAll: shadowRoot.getElementById('pp-rn-selectall'),
      rnInvert: shadowRoot.getElementById('pp-rn-invert'),
      rnChips: shadowRoot.getElementById('pp-rn-chips'),
      rnRule: shadowRoot.getElementById('pp-rn-rule'),
      rnBracketBox: shadowRoot.getElementById('pp-rn-bracket-box'),
      rnKeywordBox: shadowRoot.getElementById('pp-rn-keyword-box'),
      rnKeyword: shadowRoot.getElementById('pp-rn-keyword'),
      rnBracket: shadowRoot.getElementById('pp-rn-bracket'),
      rnMode: shadowRoot.getElementById('pp-rn-mode'),
      rnReplace: shadowRoot.getElementById('pp-rn-replace'),
      rnPreview: shadowRoot.getElementById('pp-rn-preview'),
      rnNote: shadowRoot.getElementById('pp-rn-note'),
      rnDoPreview: shadowRoot.getElementById('pp-rn-dopreview'),
      rnExecute: shadowRoot.getElementById('pp-rn-execute'),
      modeBrowse: shadowRoot.getElementById('pp-mode-browse'),
      modePath: shadowRoot.getElementById('pp-mode-path'),
      pathTip: shadowRoot.getElementById('pp-path-tip'),
      paths: shadowRoot.getElementById('pp-paths'),
      chips: shadowRoot.getElementById('pp-chips'),
      summary: shadowRoot.getElementById('pp-summary'),
      progress: shadowRoot.getElementById('pp-progress'),
      progressFill: shadowRoot.getElementById('pp-progress-fill'),
      progressText: shadowRoot.getElementById('pp-progress-text'),
      results: shadowRoot.getElementById('pp-results'),
      back3: shadowRoot.getElementById('pp-back3'),
      start: shadowRoot.getElementById('pp-start'),
      stop: shadowRoot.getElementById('pp-stop'),
      header: shadowRoot.getElementById('pp-header'),
      resize: shadowRoot.getElementById('pp-resize'),
      treeFormat: shadowRoot.getElementById('pp-tree-format'),
      rnPositionBox: shadowRoot.getElementById('pp-rn-position-box'),
      rnPosMode: shadowRoot.getElementById('pp-rn-posmode'),
      rnPosMarkRow: shadowRoot.getElementById('pp-rn-posmark-row'),
      rnPosMark: shadowRoot.getElementById('pp-rn-posmark'),
      rnPosBetweenRow: shadowRoot.getElementById('pp-rn-posbetween-row'),
      rnPosMarkA: shadowRoot.getElementById('pp-rn-posmarkA'),
      rnPosMarkB: shadowRoot.getElementById('pp-rn-posmarkB'),
      rnPosWhichRow: shadowRoot.getElementById('pp-rn-poswhich-row'),
      rnPosWhich: shadowRoot.getElementById('pp-rn-poswhich'),
      rnPosInclude: shadowRoot.getElementById('pp-rn-posinclude'),
      rnSeq: shadowRoot.getElementById('pp-rn-seq'),
      rnSeqOpts: shadowRoot.getElementById('pp-rn-seq-opts'),
      rnSeqFmt: shadowRoot.getElementById('pp-rn-seqfmt'),
      rnSeqStart: shadowRoot.getElementById('pp-rn-seqstart'),
      manageBody: shadowRoot.getElementById('pp-manage-body'),
      bcManage: shadowRoot.getElementById('pp-bc-manage'),
      searchManage: shadowRoot.getElementById('pp-search-manage'),
      listManage: shadowRoot.getElementById('pp-list-manage'),
      manageType: shadowRoot.getElementById('pp-manage-type'),
      manageSelectAll: shadowRoot.getElementById('pp-manage-selectall'),
      manageInvert: shadowRoot.getElementById('pp-manage-invert'),
      manageChips: shadowRoot.getElementById('pp-manage-chips'),
      manageOp: shadowRoot.getElementById('pp-manage-op'),
      manageDupPanel: shadowRoot.getElementById('pp-manage-dup-panel'),
      manageNote: shadowRoot.getElementById('pp-manage-note'),
      manageExecute: shadowRoot.getElementById('pp-manage-execute'),
      copyModeRow: shadowRoot.getElementById('pp-copy-mode-row'),
    };

    bindEvents();
    applySavedGeom();
    initPanelGestures();
    renderChips();
  }

  init();
})();
