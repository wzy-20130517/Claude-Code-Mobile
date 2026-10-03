#!/usr/bin/env node
/**
 * mcp-mail-qq.mjs - QQ邮箱 IMAP 只读 MCP server
 *
 * 工具:
 *  - list_messages: 列出最近邮件（主题/发件人/日期）
 *  - read_message:  读单封邮件正文（自动提取验证码）
 *  - search_code:   搜索最近 N 分钟内的验证码邮件
 *  - list_accounts: 列出已配账号（授权码打码）
 *  - send_mail:     发邮件（SMTP，走同一套账号凭据）
 *  - reply_mail:    回复某封邮件（自动带 In-Reply-To / Re: 前缀）
 *
 * IMAP 收 + SMTP 发共用一份凭据：QQ 邮箱的授权码两边通用，
 * SMTP 主机由 IMAP 主机推导（imap.qq.com → smtp.qq.com），也可在账号里显式写 smtpHost/smtpPort。
 *
 * 多账号支持（2026-09-13）：
 *   账号表存 ~/.claude-code-mobile/mail-accounts.json：
 *     { "default": "your-email@qq.com",
 *       "accounts": { "别名或邮箱": { user, pass, host, port } } }
 *   每个工具都接受 account 参数（别名或邮箱地址），不传用 default。
 *   环境变量 MAIL_USER/MAIL_PASS/... 仍然生效：作为「env」这个隐式账号，
 *   且在账号表为空时作为 default —— 保证旧配置零改动继续可用。
 *
 * 新增工具 list_accounts：列出已配账号（密码打码）。
 */
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

import Imap from 'node-imap';
import { simpleParser } from 'mailparser';
import libmime from 'libmime';
import nodemailer from 'nodemailer';

function decodeHeaderValue(v) {
  try { return v ? libmime.decodeWords(v) : v; } catch { return v; }
}

// ---- 多账号凭据 ----
const ACCOUNTS_FILE = join(homedir(), '.claude-code-mobile', 'mail-accounts.json');

/**
 * 读账号表。返回 { default, accounts }。
 * 环境变量里的凭据作为隐式账号 'env' 合并进去 —— 这样旧的 mcp.json
 * （只有 MAIL_USER/MAIL_PASS）不用改任何东西就继续能用。
 */
function loadAccounts() {
  let cfg = { default: null, accounts: {} };
  if (existsSync(ACCOUNTS_FILE)) {
    try {
      const raw = JSON.parse(readFileSync(ACCOUNTS_FILE, 'utf-8'));
      cfg.default = raw.default || null;
      cfg.accounts = raw.accounts || {};
    } catch (e) {
      console.error('[mail] 账号表解析失败:', e.message);
    }
  }
  // env 凭据作为隐式账号
  if (process.env.MAIL_USER && process.env.MAIL_PASS) {
    cfg.accounts.env = {
      user: process.env.MAIL_USER,
      pass: process.env.MAIL_PASS,
      host: process.env.MAIL_HOST || 'imap.qq.com',
      port: parseInt(process.env.MAIL_PORT || '993'),
    };
    // 账号表没指定 default 时用 env（旧行为）
    if (!cfg.default) cfg.default = 'env';
  }
  return cfg;
}

/**
 * 按名字取凭据。name 可以是别名、邮箱地址，或空（用 default）。
 * 找不到时抛错并列出可用账号 —— 静默回退到默认账号会让用户
 * 以为在查 A 邮箱其实查的是 B，比报错危险得多。
 */
function resolveAccount(name) {
  const cfg = loadAccounts();
  const keys = Object.keys(cfg.accounts);
  if (keys.length === 0) {
    throw new Error('没有配置任何邮箱账号：写 ~/.claude-code-mobile/mail-accounts.json，或设 MAIL_USER/MAIL_PASS 环境变量');
  }
  const want = String(name || '').trim() || cfg.default;
  if (!want) throw new Error(`未指定账号且没有默认账号。可用: ${keys.join(', ')}`);
  // 直接命中别名
  if (cfg.accounts[want]) return { name: want, ...cfg.accounts[want] };
  // 按邮箱地址匹配
  for (const [k, v] of Object.entries(cfg.accounts)) {
    if (String(v.user || '').toLowerCase() === want.toLowerCase()) return { name: k, ...v };
  }
  throw new Error(`没有账号 "${want}"。可用: ${keys.join(', ')}（邮箱地址也可以）`);
}

// ---- MCP stdio 协议 ----
const SERVER_INFO = { name: 'mail-qq', version: '1.0.0' };

const TOOLS = [
  {
    name: 'list_messages',
    description: '列出邮箱最近的邮件（可指定数量和文件夹）',
    inputSchema: {
      type: 'object',
      properties: {
        mailbox: { type: 'string', description: '文件夹名，默认 INBOX', default: 'INBOX' },
        count:   { type: 'number', description: '返回最近多少封，默认 10', default: 10 },
        account: { type: 'string', description: '账号别名或邮箱地址；省略用默认账号（list_accounts 看有哪些）' }
      }
    }
  },
  {
    name: 'read_message',
    description: '读取指定邮件的完整正文（含验证码自动提取）',
    inputSchema: {
      type: 'object',
      properties: {
        mailbox: { type: 'string', default: 'INBOX' },
        uid:     { type: 'number', description: '邮件 UID（从 list_messages 获取）' },
        account: { type: 'string', description: '账号别名或邮箱地址；省略用默认账号' }
      },
      required: ['uid']
    }
  },
  {
    name: 'search_code',
    description: '在最近 N 分钟内搜索包含验证码/确认链接的邮件并提取',
    inputSchema: {
      type: 'object',
      properties: {
        minutes:   { type: 'number', description: '回溯几分钟，默认 10', default: 10 },
        mailbox:   { type: 'string', default: 'INBOX' },
        fromMatch: { type: 'string', description: '可选：按发件人关键词过滤' },
        account:   { type: 'string', description: '账号别名或邮箱地址；省略用默认账号。填 "*" = 所有账号一起搜（接码时不确定发到哪个邮箱就用它）' }
      }
    }
  },
  {
    name: 'list_accounts',
    description: '列出已配置的邮箱账号（授权码打码）。不确定有哪些账号、或 account 参数报错时先调它',
    inputSchema: { type: 'object', properties: {} }
  },
  {
    name: 'send_mail',
    description: '发送邮件（SMTP）。用户明确要求发邮件时才用，不要自作主张给别人发信',
    inputSchema: {
      type: 'object',
      properties: {
        to:      { type: 'string', description: '收件人，多个用逗号分隔' },
        subject: { type: 'string', description: '主题' },
        text:    { type: 'string', description: '纯文本正文（与 html 至少给一个）' },
        html:    { type: 'string', description: 'HTML 正文（可选）' },
        cc:      { type: 'string', description: '抄送，多个用逗号分隔（可选）' },
        bcc:     { type: 'string', description: '密送（可选）' },
        attachments: {
          type: 'array',
          description: '附件本地路径数组（可选，单个文件建议 <20MB）',
          items: { type: 'string' }
        },
        account: { type: 'string', description: '用哪个账号发；省略用默认账号' }
      },
      required: ['to', 'subject']
    }
  },
  {
    name: 'reply_mail',
    description: '回复某封邮件（按 uid）。自动带 In-Reply-To/References 头和 Re: 主题前缀，收件人取原邮件发件人',
    inputSchema: {
      type: 'object',
      properties: {
        uid:     { type: 'number', description: '要回复的邮件 UID（从 list_messages 获取）' },
        text:    { type: 'string', description: '回复正文' },
        html:    { type: 'string', description: 'HTML 正文（可选）' },
        mailbox: { type: 'string', description: '原邮件所在文件夹，默认 INBOX', default: 'INBOX' },
        replyAll:{ type: 'boolean', description: 'true=同时回复原抄送人（默认 false 只回发件人）' },
        attachments: { type: 'array', description: '附件本地路径数组（可选）', items: { type: 'string' } },
        account: { type: 'string', description: '用哪个账号；省略用默认账号' }
      },
      required: ['uid', 'text']
    }
  }
];

function connectImap(acc) {
  // acc 由 resolveAccount() 给出：{ name, user, pass, host, port }
  // 不再直接读 process.env —— 多账号下那样只能连一个邮箱
  return new Promise((resolve, reject) => {
    const imap = new Imap({
      user: acc.user,
      password: acc.pass,
      host: acc.host || 'imap.qq.com',
      port: parseInt(acc.port || '993'),
      tls: true,
      tlsOptions: { rejectUnauthorized: true },
      connTimeout: 20000,
      authTimeout: 20000,
    });
    let settled = false;
    // 永久 error 监听：连接成功后的任何 imap 错误（断连/FETCH 失败）只记日志，
    // 不抛 unhandled error 导致整个 MCP 进程崩溃（这是“经常看不了”的根因）。
    imap.on('error', (err) => {
      console.error('[mail] imap error:', err && err.message ? err.message : String(err));
      if (!settled) { settled = true; reject(err); }
    });
    imap.once('ready', () => { settled = true; resolve(imap); });
    imap.on('end', () => console.error('[mail] imap connection ended'));
    imap.connect();
  });
}

function withTimeout(promise, ms, label) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`${label || '操作'}超时(${ms}ms)`));
    }, ms);
    promise.then(
      (v) => { clearTimeout(timer); resolve(v); },
      (e) => { clearTimeout(timer); reject(e); }
    );
  });
}

function openBox(imap, mailbox) {
  return new Promise((res, rej) => imap.openBox(mailbox, true, (err, box) => err ? rej(err) : res(box)));
}

function extractCode(text) {
  // 常见验证码：4~8 位数字，或字母数字混合码（如 8b5acb）
  // 中文不是 \w，所以 [^\w]{0,12} 能跨过“验证码为: ”这类前缀
  const m = text.match(/(?:验证码|verification|code|OTP|确认码|动态码)[^\w]{0,12}([A-Za-z0-9]{4,8})/i)
         || text.match(/\b(\d{6})\b/)  // 裸 6 位纯数字
         || text.match(/\b([A-Za-z0-9]{6})\b/)  // 裸 6 位字母数字
         || text.match(/\b(\d{4,8})\b/);
  return m ? m[1] : null;
}

function extractLinks(text) {
  return (text.match(/https?:\/\/[^\s"'<>\u4e00-\u9fa5]+/g) || [])
    .filter(u => /confirm|verify|activate|validate|token|code/i.test(u))
    .slice(0, 5);
}

async function fetchMessages(imap, mailbox, count) {
  const box = await openBox(imap, mailbox);
  const total = box.messages.total;
  if (total === 0) return [];
  const start = Math.max(1, total - count + 1);
  return withTimeout(new Promise((resolve, reject) => {
    const msgs = [];
    const f = imap.seq.fetch(`${start}:${total}`, {
      bodies: 'HEADER.FIELDS (FROM TO SUBJECT DATE)',
      struct: false
    });
    f.on('message', (msg) => {
      const item = {};
      msg.on('body', (stream) => {
        let buf = '';
        stream.on('data', c => buf += c);
        stream.on('end', () => {
          item._header = buf;
          const get = (k) => {
            const m = buf.match(new RegExp(`^${k}:\\s*(.+)$`, 'mi'));
            return m ? m[1].trim() : '';
          };
          item.from = decodeHeaderValue(get('From'));
          item.subject = decodeHeaderValue(get('Subject'));
          item.date = get('Date');
        });
      });
      msg.once('attributes', (a) => { item.uid = a.uid; item.seqno = a.seqno; });
      msg.once('end', () => msgs.push(item));
    });
    f.once('error', reject);
    f.once('end', () => resolve(msgs.reverse())); // 最新在前
  }), 20000, 'list_messages');
}

async function fetchFullMessage(imap, mailbox, uid) {
  await openBox(imap, mailbox);
  return withTimeout(new Promise((resolve, reject) => {
    let settled = false;
    const settle = (fn, v) => { if (!settled) { settled = true; fn(v); } };
    // 关键：list_messages 返回的是 UID，node-imap 的 imap.fetch() 默认按序列号取，
    // 邮箱封数少时 uid 数字碰巧能当序列号，一旦 uid 超过总封数就 not found。必须 byUid:true。
    const f = imap.fetch([uid], { bodies: '', struct: true, byUid: true });
    let got = null;
    let pending = 0, done = false;
    f.on('message', (msg) => {
      pending++;
      msg.on('body', (stream) => {
        // simpleParser 是异步的，fetch end 时可能还没回调完；
        // 必须用 pending 计数等它完成，否则误报 message not found。
        simpleParser(stream, (err, parsed) => {
          pending--;
          if (err) return settle(reject, err);
          got = parsed;
          if (done && pending === 0) finish();
        });
      });
    });
    const finish = () => {
      if (!got) return settle(reject, new Error('message not found'));
      const text = got.text || got.html?.replace(/<[^>]+>/g, ' ') || '';
      settle(resolve, {
        uid,
        from: got.from?.text,
        // reply_mail 要靠 messageId 挂 In-Reply-To/References 才能接上原线程；
        // cc 给 replyAll 用。少了这两个字段回复就变成一封孤立的新邮件。
        messageId: got.messageId,
        cc: got.cc?.text,
        to: got.to?.text,
        subject: got.subject,
        date: got.date,
        text: text.slice(0, 5000),
        code: extractCode(text),
        links: extractLinks(text)
      });
    };
    f.once('error', (e) => settle(reject, e));
    f.once('end', () => {
      done = true;
      if (pending === 0) finish();
    });
  }), 25000, 'read_message');
}

/** 单账号搜索（多账号由 searchCodeMulti 分发） */
async function searchCodeOne(acc, mailbox, minutes, fromMatch) {
  const imap = await connectImap(acc);
  try {
    const box = await openBox(imap, mailbox);
    const since = new Date(Date.now() - minutes * 60 * 1000);
    return await withTimeout(new Promise((resolve, reject) => {
      let settled = false;
      const settle = (fn, v) => { if (!settled) { settled = true; fn(v); } };
      imap.search([['SINCE', since]], (err, uids) => {
        if (err) return settle(reject, err);
        if (!uids || uids.length === 0) return settle(resolve, []);
        // search 返回的是 UID 数组，同样必须 byUid:true 按 UID 取，否则取错/取不到。
        const f = imap.fetch(uids.slice(-20), { bodies: '', struct: true, byUid: true });
        const results = [];
        let pending = 0, done = false;
        f.on('message', (msg) => {
          pending++;
          let msgUid = null;
          msg.once('attributes', (a) => { if (a && a.uid) msgUid = a.uid; });
          msg.on('body', (stream) => {
            simpleParser(stream, (err, parsed) => {
              pending--;
              if (!err && parsed) {
                const text = parsed.text || parsed.html?.replace(/<[^>]+>/g, ' ') || '';
                if (!fromMatch || (parsed.from?.text || '').toLowerCase().includes(fromMatch.toLowerCase())) {
                  const code = extractCode(text);
                  const links = extractLinks(text);
                  if (code || links.length) {
                    results.push({
                      account: acc.name,
                      accountEmail: acc.user,
                      uid: msgUid,
                      from: parsed.from?.text,
                      subject: parsed.subject,
                      date: parsed.date,
                      code,
                      links,
                      snippet: text.slice(0, 500)
                    });
                  }
                }
              }
              if (done && pending === 0) settle(resolve, results);
            });
          });
        });
        f.once('error', (e) => settle(reject, e));
        f.once('end', () => {
          done = true;
          if (pending === 0) settle(resolve, results);
        });
      });
    }), 30000, 'search_code');
  } finally {
    imap.end();
  }
}

/**
 * 多账号搜索分发。
 * account='*' 时并发搜所有账号 —— 接码场景常常不确定站点发到哪个邮箱，
 * 一个个试太慢，并发搜完合并按时间排序最实用。
 * 单个账号失败不影响其他账号（错误作为一条 error 记录返回，不整体抛）。
 */
async function searchCodeMulti(accountArg, mailbox, minutes, fromMatch) {
  const want = String(accountArg || '').trim();
  if (want !== '*') {
    const acc = resolveAccount(want);
    return await searchCodeOne(acc, mailbox, minutes, fromMatch);
  }
  const cfg = loadAccounts();
  const names = Object.keys(cfg.accounts);
  if (names.length === 0) throw new Error('没有配置任何邮箱账号');
  const settled = await Promise.allSettled(
    names.map((n) => searchCodeOne({ name: n, ...cfg.accounts[n] }, mailbox, minutes, fromMatch))
  );
  const out = [];
  settled.forEach((r, i) => {
    if (r.status === 'fulfilled') out.push(...r.value);
    else out.push({ account: names[i], error: String(r.reason?.message || r.reason) });
  });
  // 有验证码的排前面，再按时间倒序
  return out.sort((a, b) => {
    if (!!b.code !== !!a.code) return b.code ? 1 : -1;
    return new Date(b.date || 0) - new Date(a.date || 0);
  });
}

// ---- SMTP 发信 ----

/**
 * 由 IMAP 主机推导 SMTP 主机：imap.qq.com → smtp.qq.com。
 * 账号里显式写了 smtpHost 就用它（自建邮局/企业邮箱可能不遵守这个命名）。
 */
function smtpConfigOf(acc) {
  const host = acc.smtpHost || String(acc.host || 'imap.qq.com').replace(/^imap\./i, 'smtp.');
  const port = parseInt(acc.smtpPort || 465);
  return {
    host, port,
    secure: port === 465,          // 465=SSL 直连；587 走 STARTTLS
    auth: { user: acc.user, pass: acc.pass },
    tls: { rejectUnauthorized: false },
  };
}

/** 附件路径数组 → nodemailer attachments（不存在的路径直接报错，不静默丢） */
function buildAttachments(paths) {
  if (!Array.isArray(paths) || paths.length === 0) return undefined;
  return paths.map((p) => {
    const f = String(p);
    if (!existsSync(f)) throw new Error(`附件不存在: ${f}`);
    return { path: f, filename: f.split('/').pop() };
  });
}

async function sendMail(acc, opts) {
  if (!opts.text && !opts.html) throw new Error('text 和 html 至少给一个（邮件不能没有正文）');
  const transporter = nodemailer.createTransport(smtpConfigOf(acc));
  const mail = {
    from: acc.user,
    to: opts.to,
    subject: opts.subject,
    ...(opts.text ? { text: opts.text } : {}),
    ...(opts.html ? { html: opts.html } : {}),
    ...(opts.cc ? { cc: opts.cc } : {}),
    ...(opts.bcc ? { bcc: opts.bcc } : {}),
    ...(opts.inReplyTo ? { inReplyTo: opts.inReplyTo, references: opts.references || opts.inReplyTo } : {}),
  };
  const att = buildAttachments(opts.attachments);
  if (att) mail.attachments = att;
  const info = await transporter.sendMail(mail);
  transporter.close();
  return {
    ok: true,
    account: acc.name,
    from: acc.user,
    to: opts.to,
    subject: opts.subject,
    messageId: info.messageId,
    accepted: info.accepted,
    rejected: info.rejected,
    ...(att ? { attachments: att.length } : {}),
  };
}

/** 回复：先按 uid 读原邮件拿 Message-ID / 发件人 / 主题，再发 */
async function replyMail(acc, args) {
  const imap = await connectImap(acc);
  let orig;
  try {
    orig = await fetchFullMessage(imap, args.mailbox || 'INBOX', args.uid);
  } finally { imap.end(); }
  if (!orig) throw new Error(`找不到 uid=${args.uid} 的邮件`);

  // 收件人：原发件人地址（orig.from 可能是 "名字 <addr>" 形式，抽出 addr）
  const fromRaw = String(orig.from || '');
  const m = fromRaw.match(/<([^>]+)>/);
  const to = m ? m[1] : fromRaw.trim();
  if (!to) throw new Error('原邮件没有可用的发件人地址');

  const subj = String(orig.subject || '');
  return await sendMail(acc, {
    to,
    ...(args.replyAll && orig.cc ? { cc: orig.cc } : {}),
    subject: /^re:/i.test(subj) ? subj : `Re: ${subj}`,
    text: args.text,
    html: args.html,
    attachments: args.attachments,
    inReplyTo: orig.messageId,
    references: orig.messageId,
  });
}

async function callTool(name, args) {
  if (name === 'list_accounts') {
    const cfg = loadAccounts();
    const mask = (p) => {
      const v = String(p || '');
      return v.length > 6 ? v.slice(0, 3) + '***' + v.slice(-2) : '***';
    };
    return {
      default: cfg.default,
      accounts: Object.entries(cfg.accounts).map(([k, v]) => ({
        name: k, user: v.user, host: v.host || 'imap.qq.com',
        port: v.port || 993, pass: mask(v.pass),
        isDefault: k === cfg.default,
      })),
      configFile: ACCOUNTS_FILE,
      hint: '每个工具都可传 account（别名或邮箱）；search_code 传 "*" 搜所有账号',
    };
  }
  if (name === 'list_messages') {
    const acc = resolveAccount(args.account);
    const imap = await connectImap(acc);
    try {
      const msgs = await fetchMessages(imap, args.mailbox || 'INBOX', args.count || 10);
      // 带上账号名：多账号时不标的话，看到一堆邮件不知道是哪个邮箱的
      return { account: acc.name, email: acc.user, messages: msgs.map(m => ({ uid: m.uid, from: m.from, subject: m.subject, date: m.date })) };
    } finally { imap.end(); }
  }
  if (name === 'read_message') {
    const acc = resolveAccount(args.account);
    const imap = await connectImap(acc);
    try {
      const r = await fetchFullMessage(imap, args.mailbox || 'INBOX', args.uid);
      return { account: acc.name, email: acc.user, ...r };
    } finally { imap.end(); }
  }
  if (name === 'search_code') {
    return await searchCodeMulti(args.account, args.mailbox || 'INBOX', args.minutes || 10, args.fromMatch);
  }
  if (name === 'send_mail') {
    const acc = resolveAccount(args.account);
    return await sendMail(acc, args);
  }
  if (name === 'reply_mail') {
    const acc = resolveAccount(args.account);
    return await replyMail(acc, args);
  }
  throw new Error('unknown tool: ' + name);
}

// ---- MCP stdio loop ----
let buffer = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buffer += chunk;
  let idx;
  while ((idx = buffer.indexOf('\n')) >= 0) {
    const line = buffer.slice(0, idx).trim();
    buffer = buffer.slice(idx + 1);
    if (!line) continue;
    let msg;
    try { msg = JSON.parse(line); } catch { continue; }
    handleMessage(msg).catch(() => {});
  }
});

async function handleMessage(msg) {
  const { id, method, params } = msg;
  const respond = (result) =>
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\n');
  const respondErr = (message) =>
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, error: { code: -32000, message } }) + '\n');

  try {
    if (method === 'initialize') {
      return respond({
        protocolVersion: params?.protocolVersion || '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: SERVER_INFO
      });
    }
    if (method === 'notifications/initialized') return;
    if (method === 'tools/list') return respond({ tools: TOOLS });
    if (method === 'tools/call') {
      try {
        const result = await callTool(params.name, params.arguments || {});
        return respond({ content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] });
      } catch (e) {
        return respond({ content: [{ type: 'text', text: 'ERROR: ' + e.message }], isError: true });
      }
    }
    if (method === 'ping') return respond({});
    // 未知方法
    if (id !== undefined) return respondErr('method not found: ' + method);
  } catch (e) {
    if (id !== undefined) respondErr(e.message);
  }
}
